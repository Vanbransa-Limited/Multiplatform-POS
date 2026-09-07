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
  const { getFirebase, TENANT_ID } = await import('./firebase.js');
  const fb = await getFirebase();
  if (!fb) return null;
  if (!TENANT_ID) return null;

  const snapshot = await fb.firestore.getDocs(
    fb.firestore.query(
      fb.firestore.collection(fb.dbInstance, 'products'),
      fb.firestore.where('tenantId', '==', TENANT_ID)
    )
  );

  if (snapshot.empty) return 0;

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
  await db.products.bulkPut(products);

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
export async function pullSales(sinceIso) {
  const { getFirebase, TENANT_ID } = await import('./firebase.js');
  const fb = await getFirebase();
  if (!fb || !TENANT_ID) return null;

  const since = sinceIso || new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
  const [sales, payments] = await Promise.all([
    fb.firestore.getDocs(fb.firestore.query(
      fb.firestore.collection(fb.dbInstance, 'sales'),
      fb.firestore.where('tenantId', '==', TENANT_ID),
    )),
    fb.firestore.getDocs(fb.firestore.query(
      fb.firestore.collection(fb.dbInstance, 'payments'),
      fb.firestore.where('tenantId', '==', TENANT_ID),
    )),
  ]);

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
        invoice_no: doc.invoiceNumber || entry.id,
        sale_uuid: doc.saleUuid || entry.id,
        customer_id: doc.customerId || null,
        table_no: doc.tableNumber || null,
        // The backend settles in integer minor units; every screen here is
        // still in KES floats.
        subtotal: (Number(doc.subtotalMinor) || 0) / 100,
        discount: (Number(doc.discountMinor) || 0) / 100,
        tax_total: (Number(doc.taxMinor) || 0) / 100,
        grand_total: (Number(doc.totalMinor) || 0) / 100,
        status: 'COMPLETED',
        sold_at: asIso(doc.soldAt) || new Date().toISOString(),
        synced_at: asIso(doc.soldAt),
        fiscal_status: doc.fiscalStatus || 'SENT',
      };
    })
    .filter((row) => row.sold_at >= since);

  const paymentRows = payments.docs.map((entry) => {
    const doc = entry.data();
    return {
      id: entry.id,
      sale_id: doc.saleId || doc.customerOrderId || entry.id,
      method: String(doc.method || '').toUpperCase(),
      amount: (Number(doc.amountMinor) || 0) / 100,
      reference: doc.reference || '',
      provider_txn_id: doc.providerTransactionId || doc.reference || '',
      verified: 1,
      received_at: asIso(doc.paidAt) || null,
    };
  });

  // bulkPut so a device's own unsynced sales are not wiped by the pull.
  if (rows.length) await db.sales.bulkPut(rows);
  if (paymentRows.length) await db.payments.bulkPut(paymentRows);
  return rows.length;
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
  const { getFirebase, TENANT_ID } = await import('./firebase.js');
  const fb = await getFirebase();
  if (!fb || !TENANT_ID) return null;

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

  return tenant.trading_name;
}
