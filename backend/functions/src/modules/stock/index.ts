import { Timestamp } from 'firebase-admin/firestore';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import { FUNCTION_REGION } from '../../config/runtime';
import { db } from '../../lib/firebase';
import { asRecord, documentId, optionalText } from '../../shared/validation';
import { deterministicId } from '../../shared/identifiers';

/**
 * Stock locations.
 *
 * Every business has a House: it is where service draws from, so it always
 * exists and is always what a sale decrements. A Store is the optional
 * back room in front of it. When a Store is enabled, deliveries land there and
 * only there, and the House fills itself by requesting - one entry point per
 * item means the movement trail accounts for everything that arrived.
 *
 * `storeEnabled` replaced an older three-way `stockMode`. The fallback below
 * keeps tenants that were never migrated working: anything that used to have a
 * Store still has one.
 */
export const storeEnabled = (settings: Record<string, unknown>): boolean =>
  typeof settings.storeEnabled === 'boolean' ? settings.storeEnabled : String(settings.stockMode) !== 'house_only';

/** Service always sells out of the House. */
export const sellingLocation = (): 'HOUSE' => 'HOUSE';
export const locationsFor = (settings: Record<string, unknown>) => storeEnabled(settings) ? ['STORE', 'HOUSE'] : ['HOUSE'];

/** Where a delivery is allowed to land. With a Store, it is the only door. */
export const receivingLocation = (settings: Record<string, unknown>): 'STORE' | 'HOUSE' => storeEnabled(settings) ? 'STORE' : 'HOUSE';

/**
 * Who may do which stock job.
 *
 * Pulling stock from the Store into the House happens mid-service, so bar staff
 * can do it without hunting for a keeper. Booking a delivery in is a goods-received
 * decision and stays with stock staff. Correcting a count rewrites history, so
 * it stays with the two roles that answer for both rooms.
 */
const STOCK_ROLES = {
  receive: ['owner', 'store_manager', 'store_keeper'],
  request: ['owner', 'store_manager', 'store_keeper', 'bar_staff'],
  adjust: ['owner', 'store_manager'],
  // Switching the Store off folds the whole room into the House. That is a
  // decision about the shape of the business rather than a stock operation,
  // and it is the one thing here the owner keeps to themselves.
  configure: ['owner'],
} as const;

export function stockActor(
  auth: { token: Record<string, unknown> } | undefined,
  job: keyof typeof STOCK_ROLES | 'any' = 'any',
) {
  const token = auth?.token;
  const allowed: readonly string[] = job === 'any' ? STOCK_ROLES.receive : STOCK_ROLES[job];
  if (!token?.tenant_id || !token.staff_id || !allowed.includes(String(token.staff_role))) {
    throw new HttpsError(
      'permission-denied',
      job === 'configure' ? 'Only the owner can change the stock locations.'
        : job === 'adjust' ? 'Sign in as the owner or a store manager to correct a count.'
          : job === 'request' ? 'Sign in as service or stock staff.'
            : 'Sign in as stock management staff.',
    );
  }
  return { tenantId: String(token.tenant_id), staffId: String(token.staff_id) };
}

export function quantity(value: unknown, allowZero = false): number {
  if (!Number.isSafeInteger(value) || Number(value) < (allowZero ? 0 : 1) || Number(value) > 100000000) throw new HttpsError('invalid-argument', 'Enter a valid whole-number quantity.');
  return Number(value);
}

const ACTIONS = ['receive', 'request', 'adjust'];

export const changeStock = onCall({ region: FUNCTION_REGION }, async (request) => {
  const input = asRecord(request.data);
  const action = String(input.action);
  if (!ACTIONS.includes(action)) throw new HttpsError('invalid-argument', 'Invalid stock action.');
  // Each job carries its own roles: a barman may pull from the Store, only the
  // owner may correct a count, and neither is a goods-received decision.
  const actor = stockActor(request.auth, action as keyof typeof STOCK_ROLES);
  const branchId = documentId(input.branchId, 'branchId');
  const productId = documentId(input.productId, 'productId');
  const requestId = documentId(input.requestId, 'requestId');
  const qty = quantity(input.qty, action === 'adjust');
  const reason = optionalText(input.reason, 'reason', 300);
  if (action === 'adjust' && !reason) throw new HttpsError('invalid-argument', 'Give the reason for this correction.');

  const id = deterministicId('stock-change', `${actor.tenantId}:${requestId}`);
  const auditRef = db.collection('audit_logs').doc(id);
  const fingerprint = JSON.stringify({ branchId, productId, action, qty, reason });

  return db.runTransaction(async (tx) => {
    const [audit, settingsDoc, branch, product] = await tx.getAll(auditRef, db.collection('tenant_settings').doc(actor.tenantId), db.collection('branches').doc(branchId), db.collection('products').doc(productId));
    if (audit.exists) {
      if (audit.data()?.fingerprint !== fingerprint) throw new HttpsError('already-exists', 'Request already used.');
      return audit.data()?.result;
    }
    if (branch.data()?.tenantId !== actor.tenantId || branch.data()?.status !== 'active' || product.data()?.tenantId !== actor.tenantId || product.data()?.isService) throw new HttpsError('failed-precondition', 'Choose a stock item in an active branch.');
    const settings = settingsDoc.data() || {};

    // Each action names its own location, so the client cannot post a delivery
    // straight into the House while a Store is enabled.
    const location = action === 'receive' ? receivingLocation(settings) : action === 'request' ? 'HOUSE' : String(input.location);
    if (!locationsFor(settings).includes(location)) throw new HttpsError('failed-precondition', 'This location is disabled by the stock policy.');
    if (action === 'request' && !storeEnabled(settings)) throw new HttpsError('failed-precondition', 'There is no Store to request from.');

    const balanceRef = db.collection('stock_balances').doc(`${branchId}_${productId}_${location}`);
    const sourceRef = db.collection('stock_balances').doc(`${branchId}_${productId}_STORE`);
    const [balance, source] = await tx.getAll(balanceRef, sourceRef);
    const before = quantity(balance.data()?.qty || 0, true);
    if (action === 'adjust' && input.expectedQty !== before) throw new HttpsError('aborted', 'Stock changed. Refresh before correcting.');

    const after = action === 'adjust' ? qty : before + qty;
    if (after < Number(balance.data()?.reservedQty || 0)) throw new HttpsError('failed-precondition', 'Insufficient available stock.');
    quantity(after, true);

    const now = Timestamp.now();
    const write = (ref: FirebaseFirestore.DocumentReference, loc: string, amount: number, delta: number) => {
      tx.set(ref, { id: ref.id, tenantId: actor.tenantId, branchId, productId, location: loc, qty: amount, updatedAt: now }, { merge: true });
      tx.create(db.collection('stock_movements').doc(`${id}_${loc}`), { tenantId: actor.tenantId, branchId, productId, location: loc, qty: delta, type: action, referenceId: id, createdByStaffId: actor.staffId, createdAt: now });
    };

    let movedFrom: number | null = null;
    if (action === 'request') {
      // The request is fulfilled in the same step: the Store is debited here,
      // so there is no pending state for stock to sit in.
      const available = quantity(source.data()?.qty || 0, true);
      if (available < qty) throw new HttpsError('failed-precondition', `The Store holds only ${available}.`);
      movedFrom = available - qty;
      write(sourceRef, 'STORE', movedFrom, -qty);
    }
    write(balanceRef, location, after, after - before);

    const result = { qty: after, location, storeQty: movedFrom };
    tx.create(auditRef, { tenantId: actor.tenantId, actorStaffId: actor.staffId, action: `stock.${action}`, entityId: productId, fingerprint, metadata: { reason: reason || action, before, after, branchId, location, productName: product.data()?.name || productId }, result, createdAt: now });
    return result;
  });
});

/**
 * Flips the two per-product switches the shop floor changes most.
 *
 * `trackStock` holds a product to its House balance: the public menu greys it
 * out at zero and an order for it is refused. Everything else - cocktails,
 * plates made to order, services - always shows, because a count nobody keeps
 * would otherwise empty the menu.
 *
 * `showOnMenu` is the store-only switch: off keeps the item sellable at the
 * till while never advertising it to customers.
 *
 * Named for tracking because that is what it shipped as; it grew the second
 * flag rather than being renamed, which would have meant tearing down a live
 * callable mid-service.
 */
export const setProductTracking = onCall({ region: FUNCTION_REGION }, async (request) => {
  const actor = stockActor(request.auth);
  const input = asRecord(request.data);
  const productId = documentId(input.productId, 'productId');
  const wantsTracking = typeof input.trackStock === 'boolean';
  const wantsMenu = typeof input.showOnMenu === 'boolean';
  if (!wantsTracking && !wantsMenu) throw new HttpsError('invalid-argument', 'Choose what to change on this item.');
  const ref = db.collection('products').doc(productId);
  return db.runTransaction(async (tx) => {
    const product = await tx.get(ref);
    if (product.data()?.tenantId !== actor.tenantId) throw new HttpsError('not-found', 'Product not found.');
    if (wantsTracking && product.data()?.isService) throw new HttpsError('failed-precondition', 'A service has nothing to count.');
    const now = Timestamp.now();
    const change: Record<string, unknown> = { updatedAt: now };
    if (wantsTracking) change.trackStock = input.trackStock;
    if (wantsMenu) change.showOnMenu = input.showOnMenu;
    tx.update(ref, change);
    tx.create(db.collection('audit_logs').doc(), {
      tenantId: actor.tenantId, actorStaffId: actor.staffId,
      action: wantsMenu && !wantsTracking ? 'catalogue.menu_visibility_changed' : 'stock.tracking_changed',
      entityId: productId,
      metadata: { ...change, updatedAt: undefined, productName: product.data()?.name || productId }, createdAt: now,
    });
    return { productId, trackStock: input.trackStock, showOnMenu: input.showOnMenu };
  });
});

/**
 * Turns the Store on or off.
 *
 * Turning it off folds everything it holds into the House rather than stranding
 * it, because the House is the only place service can reach.
 */
export const configureStock = onCall({ region: FUNCTION_REGION }, async (request) => {
  const actor = stockActor(request.auth, 'configure');
  const input = asRecord(request.data);
  if (typeof input.storeEnabled !== 'boolean') throw new HttpsError('invalid-argument', 'Choose whether this business has a Store.');
  const wanted = input.storeEnabled;
  return db.runTransaction(async (tx) => {
    const settingsRef = db.collection('tenant_settings').doc(actor.tenantId);
    const settings = await tx.get(settingsRef);
    if (!settings.exists) throw new HttpsError('not-found', 'Business settings are missing.');
    const balances = await tx.get(db.collection('stock_balances').where('tenantId', '==', actor.tenantId));
    if (balances.docs.some((doc) => Number(doc.data().reservedQty || 0) > 0)) throw new HttpsError('failed-precondition', 'Confirm or cancel pending kitchen prints before changing stock locations.');
    const sources = wanted ? [] : balances.docs.filter((doc) => doc.data().location === 'STORE' && doc.data().qty > 0);
    if (sources.length > 240) throw new HttpsError('failed-precondition', 'Move the Store into the House before switching off this large catalogue.');
    const targets = sources.length ? await tx.getAll(...sources.map((doc) => db.collection('stock_balances').doc(`${doc.data().branchId}_${doc.data().productId}_HOUSE`))) : [];
    const now = Timestamp.now();
    sources.forEach((source, index) => {
      const data = source.data();
      tx.update(source.ref, { qty: 0, updatedAt: now });
      tx.set(targets[index].ref, { ...data, id: targets[index].id, location: 'HOUSE', qty: quantity(data.qty + (targets[index].data()?.qty || 0), true), updatedAt: now });
    });
    tx.update(settingsRef, { storeEnabled: wanted, stockMode: wanted ? 'both' : 'house_only', updatedAt: now, updatedByStaffId: actor.staffId });
    tx.create(db.collection('audit_logs').doc(), { tenantId: actor.tenantId, actorStaffId: actor.staffId, action: 'stock.locations_changed', metadata: { storeEnabled: wanted, moved: sources.map((doc) => ({ id: doc.id, qty: doc.data().qty })) }, createdAt: now });
    return { storeEnabled: wanted, moved: sources.length };
  });
});

/**
 * Books a whole delivery note or stock take in one go.
 *
 * Keying two hundred lines one at a time is how opening stock never gets
 * entered, so the same spreadsheet the business already keeps is accepted here.
 * Rows are matched on SKU, and a row naming something this tenant does not sell
 * is reported back rather than silently skipped.
 *
 * `receive` adds to what is there. `count` sets the absolute figure, which is a
 * rewrite of history, so it carries the same rules as a single correction: the
 * owner or a store manager, and never without a reason.
 */
export const importStock = onCall({ region: FUNCTION_REGION, timeoutSeconds: 300 }, async (request) => {
  const input = asRecord(request.data);
  const mode = String(input.mode);
  if (!['receive', 'count'].includes(mode)) throw new HttpsError('invalid-argument', 'Choose whether this sheet is a delivery or a count.');
  const actor = stockActor(request.auth, mode === 'count' ? 'adjust' : 'receive');
  const branchId = documentId(input.branchId, 'branchId');
  const batchId = documentId(input.batchId, 'batchId');
  const reason = optionalText(input.reason, 'reason', 300);
  if (mode === 'count' && !reason) throw new HttpsError('invalid-argument', 'Give the reason for this count.');
  // At most 3 writes per item (new record, balance, movement), plus the audit.
  if (!Array.isArray(input.rows) || input.rows.length === 0 || input.rows.length > 150) {
    throw new HttpsError('invalid-argument', 'Send between 1 and 150 rows.');
  }
  const rows = input.rows.map((raw) => asRecord(raw, 'row'));
  // Catalogue creation belongs exclusively to Menu Admin, including requests
  // from older clients that still send createMissing=true.
  const createMissing = false;
  const auditRef = db.collection('audit_logs').doc(deterministicId('stock-import-audit', `${actor.tenantId}:${batchId}`));
  const fingerprint = JSON.stringify({ mode, branchId, location: input.location || null, reason, createMissing, rows });
  const key = (value: unknown) => String(value ?? '').trim().toLowerCase().replace(/\s+/g, ' ');

  return db.runTransaction(async (tx) => {
    const [audit, settingsDoc, branch] = await tx.getAll(auditRef,
      db.collection('tenant_settings').doc(actor.tenantId), db.collection('branches').doc(branchId));
    if (audit.exists) {
      if (audit.data()?.fingerprint !== fingerprint) throw new HttpsError('already-exists', 'This import reference has already been used.');
      return audit.data()?.result;
    }
    if (branch.data()?.tenantId !== actor.tenantId || branch.data()?.status !== 'active') {
      throw new HttpsError('failed-precondition', 'Choose an active branch.');
    }
    const settings = settingsDoc.data() || {};
    const location = mode === 'receive' ? receivingLocation(settings) : String(input.location || sellingLocation());
    if (!locationsFor(settings).includes(location)) throw new HttpsError('failed-precondition', 'This location is disabled by the stock policy.');
    const catalogue = await tx.get(db.collection('products').where('tenantId', '==', actor.tenantId));
    type Item = { id: string; data: FirebaseFirestore.DocumentData };
    const bySku = new Map<string, Item[]>();
    const byName = new Map<string, Item[]>();
    const byId = new Map<string, Item>();
    const add = (map: Map<string, Item[]>, value: unknown, item: Item) => {
      const normalized = key(value);
      if (normalized) map.set(normalized, [...(map.get(normalized) || []), item]);
    };
    catalogue.docs.forEach((doc) => {
      const item = { id: doc.id, data: doc.data() };
      byId.set(item.id, item);
      add(bySku, item.data.sku, item);
      add(byName, item.data.name, item);
    });
    const rejected: { sku: string; message: string }[] = [];
    const wanted = new Map<string, { item: Item; sku: string; qty: number }>();
    rows.forEach((row, index) => {
      const sku = String(row.sku ?? '').trim();
      const name = String(row.name ?? '').trim();
      const label = sku || name || `row ${index + 2}`;
      const qty = Number(row.qty);
      if ((!sku && !name) || sku.length > 200 || name.length > 300) {
        rejected.push({ sku: label, message: 'Enter an item name or SKU (up to 300 / 200 characters).' }); return;
      }
      if (!Number.isSafeInteger(qty) || qty < (mode === 'count' ? 0 : 1) || qty > 100000000) {
        rejected.push({ sku: label, message: `"${row.qty}" is not a whole quantity.` }); return;
      }
      // Older clients sent the name through the SKU field; support both forms.
      const matches = bySku.get(key(sku)) || byName.get(key(name || sku)) || [];
      if (matches.length > 1 && typeof row.productId !== 'string') {
        rejected.push({ sku: label, message: 'More than one item matches. Use a unique SKU.' }); return;
      }
      const item = typeof row.productId === 'string' ? byId.get(row.productId)
        : matches[0] || byId.get(deterministicId('product', `${actor.tenantId}:${sku || name}`));
      if (!item) {
        rejected.push({ sku: label, message: 'Create this item in Menu Admin first, then receive its stock.' }); return;
      }
      if (item.data.retiredAt) { rejected.push({ sku: label, message: 'This item has been removed. Restore it in Menu Admin first.' }); return; }
      if (item.data.isService) { rejected.push({ sku: label, message: 'A service holds no stock.' }); return; }
      const previous = wanted.get(item.id);
      if (previous && mode === 'count') { rejected.push({ sku: label, message: 'Counted twice in this sheet.' }); return; }
      const total = (previous?.qty || 0) + qty;
      if (!Number.isSafeInteger(total) || total > 100000000) { rejected.push({ sku: label, message: 'Combined quantity is too large.' }); return; }
      wanted.set(item.id, { item, sku: label, qty: total });
    });
    const entries = [...wanted.values()];
    const refs = entries.map(({ item }) => db.collection('stock_balances').doc(`${branchId}_${item.id}_${location}`));
    const balances = refs.length ? await tx.getAll(...refs) : [];
    const now = Timestamp.now();
    let imported = 0;
    const created = 0;
    entries.forEach(({ item, sku, qty }, index) => {
      const before = Number(balances[index].data()?.qty || 0);
      const after = mode === 'count' ? qty : before + qty;
      if (!Number.isSafeInteger(after) || after > 100000000 || after < Number(balances[index].data()?.reservedQty || 0)) {
        rejected.push({ sku, message: 'Quantity exceeds the limit or is below stock already reserved.' }); return;
      }
      tx.set(refs[index], { id: refs[index].id, tenantId: actor.tenantId, branchId, productId: item.id, location, qty: after, updatedAt: now }, { merge: true });
      tx.create(db.collection('stock_movements').doc(deterministicId('stock-import', `${actor.tenantId}:${batchId}:${item.id}`)), {
        tenantId: actor.tenantId, branchId, productId: item.id, location,
        qty: after - before, type: mode === 'count' ? 'adjust' : 'receive',
        referenceId: batchId, createdByStaffId: actor.staffId, createdAt: now,
      });
      imported += 1;
    });
    const result = { imported, created, rejected, location };
    tx.create(auditRef, {
      tenantId: actor.tenantId, actorStaffId: actor.staffId,
      action: mode === 'count' ? 'stock.imported_count' : 'stock.imported_delivery', entityId: batchId,
      fingerprint, result, metadata: { branchId, location, rows: imported, created, rejected: rejected.length, reason: reason || mode }, createdAt: now,
    });
    return result;
  });
});
