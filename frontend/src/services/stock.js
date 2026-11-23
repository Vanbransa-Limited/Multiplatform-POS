import { tenantStorage } from './tenant-cache.js';
import { getFirebase, currentClaims, callFunction } from './firebase';
import { db } from '../db/schema';

/**
 * Every business has a House; the Store is optional and sits in front of it.
 * Cached locally so navigation can hide the Store screen before the network
 * answers, and refreshed by pullStock.
 */
export const storeIsEnabled = () => tenantStorage.getItem('pos_store_enabled') !== 'false';
export const stockLocations = () => storeIsEnabled() ? ['STORE', 'HOUSE'] : ['HOUSE'];

/** Where a delivery may be booked. With a Store, that is the only door. */
export const receivingLocation = () => storeIsEnabled() ? 'STORE' : 'HOUSE';

export async function pullStock() {
  const fb = await getFirebase(); const claims = await currentClaims();
  if (!fb || !claims?.tenant_id) {
    if (typeof window !== 'undefined') window.dispatchEvent(new Event('stock-policy-changed'));
    return;
  }
  const [settings, balances] = await Promise.all([
    fb.firestore.getDoc(fb.firestore.doc(fb.dbInstance, 'tenant_settings', claims.tenant_id)),
    fb.firestore.getDocs(fb.firestore.query(fb.firestore.collection(fb.dbInstance, 'stock_balances'), fb.firestore.where('tenantId', '==', claims.tenant_id))),
  ]);
  const data = settings.data() || {};
  // Mirrors the server's fallback: a tenant never migrated off the old
  // three-way mode keeps whatever Store it already had.
  const enabled = typeof data.storeEnabled === 'boolean' ? data.storeEnabled : data.stockMode !== 'house_only';
  tenantStorage.setItem('pos_store_enabled', String(enabled));
  // Rides along on the same settings read: the owner's per-role module switches.
  tenantStorage.setItem('pos_module_access', JSON.stringify(data.moduleAccess || {}));
  await db.transaction('rw', db.stock_balances, async () => {
    await db.stock_balances.clear();
    await db.stock_balances.bulkPut(balances.docs.map((doc) => ({ ...doc.data(), id: doc.id })));
  });
  window.dispatchEvent(new Event('stock-policy-changed'));
}

/**
 * The stock audit trail.
 *
 * These rows are written only by the callables and `audit_logs` denies every
 * client write, so what comes back cannot have been edited by the person whose
 * correction it records.
 */
export async function pullStockAudits(max = 100) {
  const fb = await getFirebase(); const claims = await currentClaims();
  if (!fb || !claims?.tenant_id) {
    const logs = await db.audit_log?.toArray?.() || [];
    return logs.slice(-max).reverse();
  }
  const snapshot = await fb.firestore.getDocs(fb.firestore.query(
    fb.firestore.collection(fb.dbInstance, 'audit_logs'),
    fb.firestore.where('tenantId', '==', claims.tenant_id),
    fb.firestore.orderBy('createdAt', 'desc'),
    fb.firestore.limit(400),
  ));
  return snapshot.docs
    .map((doc) => ({ id: doc.id, ...doc.data() }))
    .filter((row) => String(row.action || '').startsWith('stock.'))
    .slice(0, max);
}

/**
 * This branch's movement trail, newest first.
 *
 * Both rooms come back in one read so the two screens reconcile against each
 * other: the House can see what the Store issued, and the Store can see what
 * the House took.
 */
export async function pullStockMovements(branchId, max = 60) {
  const fb = await getFirebase(); const claims = await currentClaims();
  if (!fb || !claims?.tenant_id || !branchId) return [];
  const snapshot = await fb.firestore.getDocs(fb.firestore.query(
    fb.firestore.collection(fb.dbInstance, 'stock_movements'),
    fb.firestore.where('tenantId', '==', claims.tenant_id),
    fb.firestore.where('branchId', '==', branchId),
    fb.firestore.orderBy('createdAt', 'desc'),
    fb.firestore.limit(max),
  ));
  return snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
}

/**
 * House requests still waiting on the store manager, oldest first.
 * Equality filters only, so no composite index is needed.
 */
export async function pullStockRequests(branchId) {
  const fb = await getFirebase(); const claims = await currentClaims();
  if (!fb || !claims?.tenant_id || !branchId) return [];
  const snapshot = await fb.firestore.getDocs(fb.firestore.query(
    fb.firestore.collection(fb.dbInstance, 'stock_requests'),
    fb.firestore.where('tenantId', '==', claims.tenant_id),
    fb.firestore.where('branchId', '==', branchId),
    fb.firestore.where('status', '==', 'pending'),
  ));
  return snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }))
    .sort((a, b) => (a.createdAt?.toMillis?.() || 0) - (b.createdAt?.toMillis?.() || 0));
}

export async function decideStockRequest(requestId, decision, reason) {
  const result = await callFunction('decideStockRequest', { requestId, decision, reason });
  return refreshAfterStockCommit(result);
}

async function refreshAfterStockCommit(result) {
  try { await pullStock(); return result; }
  catch (error) { return { ...result, refreshWarning: `Saved on the server. Stock could not refresh: ${error.message}` }; }
}

/** Books a whole delivery note or stock take from a spreadsheet. */
export async function importStock(payload) {
  const fb = await getFirebase(); const claims = await currentClaims();
  if (!fb || !claims?.tenant_id) {
    const products = await db.products.toArray();
    const movements = await db.stock_movements.toArray();
    const branchId = payload.branchId || 'default-branch';
    const location = payload.location || receivingLocation();
    const now = new Date().toISOString();
    let imported = 0;
    const rejected = [];
    const toAdd = [];

    for (const row of payload.rows || []) {
      const product = products.find((p) =>
        (row.productId && String(p.id) === String(row.productId))
        || (row.sku && String(p.sku || '').toLowerCase() === String(row.sku).trim().toLowerCase())
        || (row.name && String(p.name || '').toLowerCase() === String(row.name).trim().toLowerCase())
      );
      if (!product) {
        rejected.push({ sku: row.sku || row.name || 'Item', message: 'Not found in catalogue' });
        continue;
      }
      const current = movements
        .filter((m) => (!m.branch_id || String(m.branch_id) === String(branchId)) && String(m.product_id) === String(product.id) && m.location === location)
        .reduce((sum, m) => sum + Number(m.qty || 0), 0);
      const delta = payload.mode === 'count' ? Number(row.qty || 0) - current : Number(row.qty || 0);
      toAdd.push({
        id: crypto.randomUUID(),
        branch_id: branchId,
        product_id: product.id,
        location,
        type: payload.mode === 'count' ? 'adjust' : 'receive',
        qty: delta,
        reference_id: payload.reason || payload.batchId || 'IMPORT',
        created_at: now,
      });
      imported++;
    }
    if (toAdd.length) await db.stock_movements.bulkAdd(toAdd);
    return { imported, created: 0, rejected };
  }
  const result = await callFunction('importStock', payload);
  return refreshAfterStockCommit(result);
}

export async function changeStock(input) {
  const fb = await getFirebase(); const claims = await currentClaims();
  if (!fb || !claims?.tenant_id) {
    const branchId = input.branchId || 'default-branch';
    const productId = input.productId;
    const movements = (await db.stock_movements.toArray()).filter(
      (m) => (!m.branch_id || String(m.branch_id) === String(branchId)) && String(m.product_id) === String(productId)
    );
    const houseQty = movements.filter((m) => m.location === 'HOUSE').reduce((s, m) => s + Number(m.qty || 0), 0);
    const storeQty = movements.filter((m) => m.location === 'STORE').reduce((s, m) => s + Number(m.qty || 0), 0);
    const now = new Date().toISOString();
    const qty = Number(input.qty || 0);

    if (input.action === 'request') {
      await db.stock_movements.bulkAdd([
        { id: crypto.randomUUID(), branch_id: branchId, product_id: productId, location: 'STORE', type: 'request', qty: -qty, reference_id: input.reason || 'REQUEST', created_at: now },
        { id: crypto.randomUUID(), branch_id: branchId, product_id: productId, location: 'HOUSE', type: 'request', qty, reference_id: input.reason || 'REQUEST', created_at: now },
      ]);
      return { status: 'approved', qty: houseQty + qty, storeQty: storeQty - qty };
    }

    const location = input.location || receivingLocation();
    const locQty = location === 'STORE' ? storeQty : houseQty;
    const delta = input.action === 'adjust' ? qty - locQty : qty;
    await db.stock_movements.add({
      id: crypto.randomUUID(),
      branch_id: branchId,
      product_id: productId,
      location,
      type: input.action === 'adjust' ? 'adjust' : 'receive',
      qty: delta,
      reference_id: input.reason || input.action.toUpperCase(),
      created_at: now,
    });
    const nextLocQty = locQty + delta;
    return {
      status: 'approved',
      qty: nextLocQty,
      storeQty: location === 'STORE' ? nextLocQty : storeQty,
    };
  }
  return refreshAfterStockCommit(await callFunction('changeStock', input));
}

export async function configureStock(storeEnabled) {
  const fb = await getFirebase(); const claims = await currentClaims();
  if (!fb || !claims?.tenant_id) {
    tenantStorage.setItem('pos_store_enabled', String(Boolean(storeEnabled)));
    if (typeof window !== 'undefined') window.dispatchEvent(new Event('stock-policy-changed'));
    return { storeEnabled: Boolean(storeEnabled) };
  }
  return refreshAfterStockCommit(await callFunction('configureStock', { storeEnabled }));
}

