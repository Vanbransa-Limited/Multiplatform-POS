/**
 * Pulls the server catalogue into Dexie.
 *
 * The till reads products from Dexie, and until now Dexie was only ever filled
 * from the bundled seed file - nothing brought products back down from
 * Firestore. A product created anywhere else, including by a bulk import, was
 * invisible to every till.
 *
 * Sales still price from the server, so this is a read cache, not a second
 * source of truth.
 */

// Dexie and the Firebase client are both imported inside pullCatalogue: they
// need a browser, and importing them at module scope would stop the mapping
// below from being exercised in a plain node test.

/**
 * Orders products the way somebody scanning a list looks for one.
 *
 * Case-insensitive, because the catalogue mixes "WHITE CAP" with "White Cap"
 * and a plain sort files those pages apart. Numeric, so 500ML follows 330ML
 * instead of leading it, which is what a string sort does with "5" and "3".
 */
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

export function compareNames(a, b) {
  return collator.compare(String(a ?? ''), String(b ?? ''));
}

/**
 * The tenant these pulls belong to.
 *
 * The signed-in claim is authoritative: it is what the security rules match on
 * and what Financials already reads. NEXT_PUBLIC_TENANT_ID is only a fallback
 * for a till that has not signed in yet, because a build-time constant that
 * disagrees with the session makes every pull return nothing without error.
 */
export async function activeTenantId() {
  const { currentClaims, TENANT_ID } = await import('./firebase.js');
  try {
    const claims = await currentClaims();
    if (claims?.tenant_id) return String(claims.tenant_id);
  } catch {
    // Never fall back to a different business after a session-scope failure.
    return null;
  }
  return TENANT_ID || null;
}

/** Firestore's product document -> the row shape the till's screens read. */
export function toLocalProduct(doc) {
  return {
    id: doc.id,
    tenant_id: doc.tenantId,
    sku: doc.sku || doc.id,
    name: doc.name || doc.sku || doc.id,
    category_id: doc.categoryId || '',
    uom: doc.uom || 'EACH',
    is_batch_tracked: 0,
    is_service: doc.isService ? 1 : 0,
    tax_code: doc.taxCode || 'A',
    item_cls_cd: doc.itemClassCode || '',
    origin_country: 'KE',
    // The backend settles in integer minor units; the till's screens and its
    // cart maths are still in KES floats.
    sell_price: (Number(doc.sellPriceMinor) || 0) / 100,
    cost_price: (Number(doc.costPriceMinor) || 0) / 100,
    image_data: doc.imagePath || null,
    is_active: doc.isActive === false ? 0 : 1,
    retired_at: doc.retiredAt || null,
    // Whether the public menu holds this item to its House balance.
    track_stock: doc.trackStock === true ? 1 : 0,
    // Absent means shown; only an explicit false hides it from customers.
    show_on_menu: doc.showOnMenu === false ? 0 : 1,
    version: 1
  };
}

/**
 * Replaces the local product cache with the tenant's server catalogue.
 * Returns the number of products written, or null when there is no backend.
 */
export async function pullCatalogue() {
  const { getFirebase } = await import('./firebase.js');
  const fb = await getFirebase();
  if (!fb) return null;
  // The signed-in tenant, for the same reason pullSales uses it: a build-time
  // id that disagrees with the session pulls an empty catalogue in silence,
  // which leaves the seeded demo rows standing as if they were the menu.
  const TENANT_ID = await activeTenantId();
  if (!TENANT_ID) return null;

  const snapshot = await fb.firestore.getDocs(
    fb.firestore.query(
      fb.firestore.collection(fb.dbInstance, 'products'),
      fb.firestore.where('tenantId', '==', TENANT_ID)
    )
  );


  // Categories come down with the products. Without them the editor offered
  // the five seeded types while the menu grouped by the tenant's real ones, so
  // a product filed under "Beers & Ciders" landed in "General" for customers.
  try {
    const categories = await fb.firestore.getDocs(
      fb.firestore.query(
        fb.firestore.collection(fb.dbInstance, 'categories'),
        fb.firestore.where('tenantId', '==', TENANT_ID)
      )
    );
    if (!categories.empty) {
      const { db: local } = await import('../db/schema');
      await local.categories.clear();
      await local.categories.bulkPut(categories.docs.map((entry) => ({
        id: entry.id,
        name: entry.data().name || entry.id,
      })));
    }
  } catch {
    // A stale category list is survivable; a failed product pull is not.
  }

  const products = snapshot.docs.map((entry) => toLocalProduct({ id: entry.id, ...entry.data() }));
  // bulkPut so a re-pull updates prices in place rather than duplicating, and
  // so locally seeded rows are overwritten by the authoritative copy.
  const { db } = await import('../db/schema');
  await db.transaction('rw', db.products, async () => {
    const ids = new Set(products.map(product => product.id));
    // Keep cached names for historical local receipts, but remove deleted
    // server items from every selling/stock/editor list.
    await db.products.filter(product => !ids.has(product.id)).modify({ is_active: 0, show_on_menu: 0, retired_at: new Date().toISOString() });
    await db.products.bulkPut(products);
  });

  return products.length;
}

/**
 * Pulls this tenant's sales and their payments into Dexie.
 *
 * Sales are pushed to the server but were never pulled back, so every report
 * read only what this one device had rung up. A manager opening Financials on
 * a tablet saw that tablet's takings and called it the day's.
 *
 * Returns the number of sales cached, or null when there is no backend.
 */
export async function pullSales(sinceIso, saleUuids, tableSelection) {
  const { getFirebase } = await import('./firebase.js');
  const fb = await getFirebase();
  if (!fb) return null;
  // The signed-in tenant, not the build-time one. Keying this off an env var
  // meant a build pointed at a different tenant id than the session pulled
  // nothing at all - silently - and the board showed only this device while
  // looking perfectly healthy. Financials never had the bug because they read
  // the claim; this now agrees with them.
  const tenantId = await activeTenantId();
  if (!tenantId) throw new Error('Sign in to read the other tills’ sales.');

  const since = new Date(sinceIso || Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
  const { readSaleChildren, readSalesSince } = await import('./sale-history.js');
  let sales;
  if (tableSelection) {
    const snapshot = await fb.firestore.getDocsFromServer(fb.firestore.query(
      fb.firestore.collection(fb.dbInstance, 'sales'),
      fb.firestore.where('tenantId', '==', tenantId),
      fb.firestore.where('tableNumber', '==', tableSelection.tableNumber),
    ));
    sales = { docs: snapshot.docs.filter(entry => entry.data().branchId === tableSelection.branchId) };
  } else if (saleUuids) {
    const ids = [...new Set(saleUuids.filter(Boolean))];
    const docs = [];
    for (let start = 0; start < ids.length; start += 30) {
      const snapshot = await fb.firestore.getDocsFromServer(fb.firestore.query(
        fb.firestore.collection(fb.dbInstance, 'sales'),
        fb.firestore.where('tenantId', '==', tenantId),
        fb.firestore.where('idempotencyKey', 'in', ids.slice(start, start + 30)),
      ));
      docs.push(...snapshot.docs);
    }
    sales = { docs };
  } else sales = await readSalesSince(fb, tenantId, since);

  const asIso = (value) => {
    if (!value) return null;
    if (typeof value?.toDate === 'function') return value.toDate().toISOString();
    return new Date(value).toISOString();
  };

  const { db } = await import('../db/schema');
  const rows = sales.docs
    .map((entry) => {
      const doc = entry.data();
      return {
        id: entry.id,
        tenant_id: doc.tenantId,
        branch_id: doc.branchId,
        shift_id: doc.shiftId || null,
        // Who rang it up. Without this a sale from another till is traceable
        // to no one here, because this device has neither that shift nor the
        // staff row the old lookup went through.
        staff_id: doc.staffId || null,
        device_id: doc.deviceId || null,
        invoice_no: doc.invoiceNumber || entry.id,
        proforma_id: doc.proformaId || null,
        // The till's own id for this sale. The server mints its own document
        // id but stores the till's as the idempotency key, so this is the only
        // thread back to the row the selling device already holds.
        sale_uuid: doc.idempotencyKey || doc.saleUuid || entry.id,
        customer_id: doc.customerId || null,
        table_no: doc.tableNumber || null,
        tab_id: doc.tabId || null,
        order_reference: doc.orderReference || null,
        // Released: still owed, but no longer holding its table (releaseTable).
        table_release: doc.tableRelease ? {
          id: doc.tableRelease.releaseId || null,
          at: asIso(doc.tableRelease.releasedAt),
          by: doc.tableRelease.releasedByStaffId || null,
          reason: doc.tableRelease.reason || '',
        } : null,
        // The backend settles in integer minor units; every screen here is
        // still in KES floats.
        subtotal: (Number(doc.subtotalMinor) || 0) / 100,
        discount: (Number(doc.discountMinor) || 0) / 100,
        tax_total: (Number(doc.taxMinor) || 0) / 100,
        grand_total: (Number(doc.totalMinor) || 0) / 100,
        status: String(doc.status || 'completed').toUpperCase(),
        sold_at: asIso(doc.soldAt || doc.createdAt),
        synced_at: asIso(doc.soldAt || doc.createdAt),
        fiscal_status: doc.fiscalStatus || 'SENT',
      };
    })
    .filter((row) => row.sold_at && (saleUuids || tableSelection || row.sold_at >= since));

  const ids = rows.map(row => row.id);
  const [payments, lines] = await Promise.all([
    readSaleChildren(fb, tenantId, 'payments', ids),
    readSaleChildren(fb, tenantId, 'sale_lines', ids),
  ]);
  // The server books every sale "completed", unpaid receivables included.
  // Taken literally it overwrote a local PENDING_PAYMENT round, which dropped
  // uploaded tables off Tab Management and made them uneditable.
  const owing = new Set(payments.docs.flatMap((entry) => {
    const doc = entry.data();
    return doc.method === 'credit' && !doc.settledAt && doc.status !== 'voided' ? [doc.saleId] : [];
  }));
  for (const row of rows) if (row.status === 'COMPLETED' && owing.has(row.id)) row.status = 'PENDING_PAYMENT';

  // One local transaction avoids a disk commit per sale and publishes a
  // consistent snapshot to other readers. All network work finishes above.
  return db.transaction('rw', [db.sales, db.payments, db.sale_lines, db.tabs], async () => {

  /**
   * A sale this device sold, it already has - under its own id.
   *
   * The server mints a different document id, so pulling one back landed it as
   * a second row: every synced sale appeared twice on the orders board and was
   * counted twice in the takings. Rows the till already holds are updated in
   * place with what only the server knows; only other devices' sales are new.
   */
  const localSales = await db.sales.where('sale_uuid').anyOf(rows.map(row => row.sale_uuid)).toArray();
  const localIdByUuid = new Map(
    localSales.filter((row) => row.sale_uuid).map((row) => [String(row.sale_uuid), row.id]),
  );
  const localIdFor = new Map();
  const localById = new Map(localSales.map(row => [row.id, row]));

  const fresh = [];
  const movedTabs = new Map();
  for (const row of rows) {
    const localId = localIdByUuid.get(String(row.sale_uuid));
    if (!localId) {
      fresh.push(row);
      continue;
    }
    localIdFor.set(row.id, localId);
    const oldTabId = localById.get(localId)?.tab_id;
    if (oldTabId && row.tab_id && oldTabId !== row.tab_id) movedTabs.set(oldTabId, row.tab_id);
    // Never a wholesale overwrite: the local row carries things the server
    // does not, such as the kitchen status this device is driving.
    const updates = {
      invoice_no: row.invoice_no,
      proforma_id: row.proforma_id,
      fiscal_status: row.fiscal_status,
      synced_at: row.synced_at,
      staff_id: row.staff_id,
      status: row.status,
      tab_id: row.tab_id,
      order_reference: row.order_reference,
      table_no: row.table_no,
      table_release: row.table_release,
    };
    if (Object.entries(updates).some(([key, value]) => localById.get(localId)?.[key] !== value)) {
      await db.sales.update(localId, updates);
    }
  }

  const paymentRows = [];
  for (const entry of payments.docs) {
    const doc = entry.data();
    const saleId = doc.saleId || doc.customerOrderId || entry.id;
    const known = localIdFor.get(saleId);
    const settlement = doc.source === 'sale_settlement' || (doc.source === 'proforma' && Boolean(doc.saleId));
    // The device wrote its own row for a tender it took. Pulling the server's
    // copy of it would double the money; a settlement recorded elsewhere is
    // the one payment it cannot already have.
    if (known && known !== saleId && !settlement) continue;

    paymentRows.push({
      id: entry.id,
      sale_id: known || saleId,
      method: String(doc.method || '').toUpperCase(),
      amount: (Number(doc.amountMinor) || 0) / 100,
      reference: doc.reference || '',
      provider_txn_id: doc.providerTransactionId || doc.reference || '',
      verified: doc.verified === false ? 0 : 1,
      receipt_allocation_id: doc.receiptAllocationId || null, receipt_limit_minor: doc.receiptLimitMinor || null,
      // Set on a receivable once the money it stood for actually arrived.
      settled_at: asIso(doc.settledAt),
      received_at: asIso(doc.paidAt) || null,
    });
  }

  // bulkPut so a device's own unsynced sales are not wiped by the pull.
  if (fresh.length) await db.sales.bulkPut(fresh);
  // A server consolidation must also retire the old local header; otherwise
  // it remains an empty duplicate and can receive the next round again.
  for (const [oldTabId, canonicalTabId] of movedTabs) {
    const remaining = await db.sales.where('tab_id').equals(oldTabId).toArray();
    if (remaining.every(sale => sale.status === 'VOIDED')) {
      await db.tabs.update(oldTabId, { status: 'MERGED', merged_into: canonicalTabId });
    }
  }
  if (paymentRows.length) await db.payments.bulkPut(paymentRows);
  const selectedIds = new Set(rows.map(row => row.id));
  const lineRows = lines.docs.flatMap(entry => {
    const doc = entry.data();
    if (!selectedIds.has(doc.saleId)) return [];
    const localId = localIdFor.get(doc.saleId);
    if (localId && localId !== doc.saleId) return [];
    return [{ id: entry.id, sale_id: doc.saleId, product_id: doc.productId,
      product_name: doc.productName, qty: doc.qty, tax_code: doc.taxCode,
      unit_price: (Number(doc.unitPriceMinor) || 0) / 100,
      discount: (Number(doc.discountMinor) || 0) / 100,
      tax_amount: (Number(doc.taxMinor) || 0) / 100,
      line_total: (Number(doc.lineTotalMinor) || 0) / 100 }];
  });
  if (lineRows.length) await db.sale_lines.bulkPut(lineRows);

  // The selling device keeps its original tender IDs. Mirror the server's
  // remaining receivable as well as full settlement, including payments made
  // from another device while this one was offline.
  const creditBySale = new Map();
  for (const entry of payments.docs) {
    const doc = entry.data();
    if (String(doc.method).toLowerCase() !== 'credit') continue;
    const remaining = !doc.settledAt && doc.status !== 'voided' ? Number(doc.amountMinor || 0) : 0;
    creditBySale.set(doc.saleId, (creditBySale.get(doc.saleId) || 0) + remaining);
  }
  for (const [serverSaleId, localId] of localIdFor) {
    if (serverSaleId === localId || !creditBySale.has(serverSaleId)) continue;
    const rowsHere = (await db.payments.where('sale_id').equals(localId).toArray())
      .filter(row => ['CREDIT', 'PROFORMA'].includes(String(row.method).toUpperCase()));
    let remainingMinor = creditBySale.get(serverSaleId);
    for (const row of rowsHere) {
      if (remainingMinor > 0) {
        await db.payments.update(row.id, { amount: remainingMinor / 100, settled_at: null });
        remainingMinor = 0;
      } else if (!row.settled_at) {
        await db.payments.update(row.id, { settled_at: new Date().toISOString() });
      }
    }
  }

  return rows.length;
  });
}

/**
 * Refreshes who this business is, from the server.
 *
 * The tenant row is written once, when a device first seeds its database, and
 * never again. A till seeded under an older name kept printing that name on
 * every receipt long after the business had been renamed - which is how
 * "Vanbransa" ended up on Titanium's paper. The server is the authority.
 */
export async function pullIdentity() {
  const { getFirebase } = await import('./firebase.js');
  const fb = await getFirebase();
  if (!fb) return null;
  // Same reason as the other pulls: the session's tenant is the real one, so a
  // till never prints the name of a business it is not signed in to.
  const TENANT_ID = await activeTenantId();
  if (!TENANT_ID) return null;

  const { db } = await import('../db/schema');
  const { state } = await import('../context');

  const tenantDoc = await fb.firestore.getDoc(fb.firestore.doc(fb.dbInstance, 'tenants', TENANT_ID));
  if (!tenantDoc.exists()) return null;
  const doc = tenantDoc.data();

  const tenant = {
    id: TENANT_ID,
    legal_name: doc.legalName || doc.tradingName || '',
    trading_name: doc.tradingName || doc.legalName || '',
    kra_pin: doc.kraPin || '',
    etims_mode: doc.etimsMode || 'none',
    phone: doc.phone || '',
    status: doc.status || 'active',
    logo_url: doc.logoUrl || '',
  };
  await db.tenants.put(tenant);
  // The receipts read this, not the table, so it has to move too.
  if (state.currentTenant?.id === TENANT_ID || !state.currentTenant) {
    state.currentTenant = { ...(state.currentTenant || {}), ...tenant };
  }

  const branches = await fb.firestore.getDocs(fb.firestore.query(
    fb.firestore.collection(fb.dbInstance, 'branches'),
    fb.firestore.where('tenantId', '==', TENANT_ID),
  ));
  const rows = branches.docs.map((entry) => ({
    id: entry.id,
    tenant_id: TENANT_ID,
    name: entry.data().name || entry.id,
    code: entry.data().code || '',
    etims_bhf_id: entry.data().etimsBranchId || entry.data().etimsBhfId || '',
    is_active: entry.data().status === 'active' ? 1 : 0,
  }));
  if (rows.length) {
    await db.branches.bulkPut(rows);
    const current = rows.find((row) => row.id === state.currentBranch?.id);
    if (current) {
      state.currentBranch = { ...state.currentBranch, ...current };
    } else if (!state.currentBranch) {
      // A till that has never been seeded has no branch to match, and without
      // one it cannot open a shift, so nothing it sells reaches the server.
      state.currentBranch = rows.find((row) => row.is_active === 1) || rows[0];
    }
  }

  window.dispatchEvent(new Event('tenant-identity-changed'));
  return tenant.trading_name;
}
