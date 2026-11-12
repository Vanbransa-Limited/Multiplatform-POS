import { db } from '../db/schema';
import { callFunction, getFirebase, currentClaims } from './firebase';
import { activeTenantId } from './catalogue';
import { openOrderPublisherId, createSnapshotPublisher } from './open-order-publisher';
import { saleAsOrder } from './customer-orders';

const publishSnapshot = createSnapshotPublisher(payload => callFunction('publishOpenOrders', payload));

/**
 * Open tabs, shared between tills for watching only.
 *
 * A round on an open tab never becomes a sale until the tab settles, so until
 * now every running table was visible on exactly one device. This publishes
 * what each till has open and reads back what the others do, which is the only
 * way an owner can see the floor without the tabs themselves moving anywhere.
 *
 * Nothing here is money. Financials counts `sales` and `payments`; these rows
 * are a live picture and are deliberately never totalled into takings.
 */

/**
 * Everything this device is holding that the server does not have.
 *
 * Not just open tabs. A standalone order registered at Pay Now is exactly as
 * invisible to the rest of the business as a tab round is, and matters as
 * much - it is a table waiting to pay. Anything still unsynced is published;
 * the moment a sale reaches the server it stops being reported here and the
 * real `sales` record takes over, so nothing is ever shown twice.
 */
export async function localHeldOrders({ branchId, tenantId } = {}) {
  return db.transaction('r', [db.sales, db.tabs, db.sale_lines, db.products, db.customers, db.payments],
    () => heldOrdersSnapshot({ branchId, tenantId }));
}

async function heldOrdersSnapshot({ branchId, tenantId }) {
  // Held means: this till has it, the server does not, and it still stands.
  const held = await db.sales.where('sync_pending').equals(1)
    .filter(sale => sale.status !== 'VOIDED' && !sale.synced_at
      && (!branchId || sale.branch_id === branchId)
      && (!tenantId || sale.tenant_id === tenantId)).toArray();
  if (!held.length) return [];

  const ids = held.map(sale => sale.id);
  const [tabs, lines, products, customers, payments] = await Promise.all([
    db.tabs.where('status').equals('OPEN').toArray(),
    db.sale_lines.where('sale_id').anyOf(ids).toArray(),
    db.products.toArray(),
    db.customers.bulkGet([...new Set(held.map(sale => sale.customer_id).filter(Boolean))]),
    db.payments.where('sale_id').anyOf(ids).toArray(),
  ]);

  const productName = new Map(products.map((row) => [row.id, row.name]));
  const customerName = new Map(customers.filter(Boolean).map((row) => [row.id, row.name]));
  const openTabs = new Map(tabs.filter((tab) => tab.status === 'OPEN').map((tab) => [tab.id, tab]));
  const linesBySale = new Map();
  for (const line of lines) {
    linesBySale.set(line.sale_id, [...(linesBySale.get(line.sale_id) || []), line]);
  }
  const itemsOf = (sale) => (linesBySale.get(sale.id) || []).map((line) => ({
    name: line.product_name || productName.get(line.product_id) || 'Item',
    qty: Number(line.qty) || 0,
  }));
  const minor = (sale) => Math.round((Number(sale.grand_total) || 0) * 100);

  // Tenders taken against a held sale. A receivable is not a settlement, so
  // credit and proforma rows are left out: they are what is still owed.
  const receivable = (method) => ['CREDIT', 'PROFORMA'].includes(String(method || '').toUpperCase());
  const paymentsBySale = new Map();
  const ledgerBySale = new Map();
  for (const payment of payments) {
    ledgerBySale.set(payment.sale_id, [...(ledgerBySale.get(payment.sale_id) || []), payment]);
    if (receivable(payment.method)) continue;
    paymentsBySale.set(payment.sale_id, [...(paymentsBySale.get(payment.sale_id) || []), payment]);
  }
  const dueOf = sale => saleAsOrder(sale, { payments: ledgerBySale.get(sale.id) || [] }).dueMinor;
  const tendersOf = (sale) => (paymentsBySale.get(sale.id) || []).map((payment) => ({
    id: payment.id,
    method: String(payment.method || '').toUpperCase(),
    amountMinor: Math.round((Number(payment.amount) || 0) * 100),
    reference: payment.reference || payment.provider_txn_id || '',
    staffId: payment.staff_id || sale.staff_id || sale.created_by || '',
    paidAt: payment.received_at || payment.created_at || sale.sold_at || null,
  }));

  // Rounds on one table are one bill; everything else stands on its own.
  const byTab = new Map();
  const standalone = [];
  for (const sale of held) {
    const tab = sale.tab_id ? openTabs.get(sale.tab_id) : null;
    if (!tab) standalone.push(sale);
    else byTab.set(tab.id, [...(byTab.get(tab.id) || []), sale]);
  }

  const fromTab = [...byTab].map(([tabId, rounds]) => {
    const tab = openTabs.get(tabId);
    const totalMinor = rounds.reduce((sum, sale) => sum + minor(sale), 0);
    return {
      key: tabId, kind: 'tab',
      ref: tab.order_no || tabId,
      tableNumber: tab.table_no ? String(tab.table_no) : '',
      customerName: customerName.get(rounds[0]?.customer_id) || '',
      staffId: rounds[0]?.staff_id || rounds[0]?.created_by || '',
      totalMinor,
      // Nothing on an open tab has been paid, so the whole of it is owed.
      dueMinor: rounds.reduce((sum, sale) => sum + dueOf(sale), 0),
      lines: rounds.flatMap(itemsOf),
      payments: rounds.flatMap(tendersOf),
      saleUuids: rounds.map((sale) => sale.sale_uuid).filter(Boolean),
      openedAt: tab.opened_at || null,
    };
  });

  const fromSales = standalone.map((sale) => ({
    key: sale.id, kind: 'sale',
    ref: sale.invoice_no || sale.id,
    tableNumber: sale.table_no ? String(sale.table_no) : '',
    customerName: customerName.get(sale.customer_id) || '',
    staffId: sale.staff_id || sale.created_by || '',
    totalMinor: minor(sale),
    // A completed-but-unsynced sale is paid; only a pending one is still owed.
    dueMinor: dueOf(sale),
    paymentStatus: saleAsOrder(sale, { payments: ledgerBySale.get(sale.id) || [] }).paymentStatus,
    lines: itemsOf(sale),
    payments: tendersOf(sale),
    saleUuids: sale.sale_uuid ? [sale.sale_uuid] : [],
    openedAt: sale.sold_at || null,
  }));

  return [...fromTab, ...fromSales];
}

/**
 * Publishes this device's open tabs.
 *
 * Sent whole, including an empty list: that is what closes a tab on every other
 * screen once it settles here.
 */
export async function publishOpenOrders({ branchId, deviceId }) {
  if (!branchId || !deviceId) return null;
  const claims = await currentClaims();
  if (!claims?.tenant_id) throw new Error('Sign in to publish open tables.');
  const orders = await localHeldOrders({ branchId, tenantId: claims.tenant_id });
  return publishSnapshot(`${claims.tenant_id}:${claims.staff_id}:${branchId}:${deviceId}`, {
    branchId,
    // A build-time device id can be shared by several physical browsers. The
    // publisher id is stable on this browser and prevents its whole-snapshot
    // replacement from deleting a different browser's open tabs.
    deviceId: openOrderPublisherId(deviceId),
    orders,
  });
}

/**
 * Every other till's open tabs.
 *
 * This device's own rows are dropped: it already holds those locally, with the
 * lines and controls needed to actually work them.
 */
/** Every till's held orders, raw, for anything that needs to resolve one. */
export async function readOpenOrders() {
  const fb = await getFirebase();
  if (!fb) return [];
  const tenantId = await activeTenantId();
  if (!tenantId) return [];
  const snapshot = await fb.firestore.getDocsFromServer(fb.firestore.query(
    fb.firestore.collection(fb.dbInstance, 'open_orders'),
    fb.firestore.where('tenantId', '==', tenantId),
  ));
  return snapshot.docs.map((entry) => ({ ...entry.data(), id: entry.id }));
}

export async function pullOpenOrders(deviceId) {
  const publisherId = openOrderPublisherId(deviceId);
  return (await readOpenOrders())
    .filter((row) => row.deviceId !== publisherId)
    .map((row) => ({
      id: row.id,
      source: 'pos',
      // Item editing needs the source ledger; payment resolves canonical sales.
      readOnly: true,
      branchId: row.branchId,
      staffId: row.staffId || null,
      ref: row.ref,
      customerName: row.customerName || 'Guest',
      orderType: row.tableNumber ? 'dine_in' : 'takeaway',
      tableNumber: row.tableNumber || '',
      // Payment and upload are different states. Keep paid held sales in
      // history without presenting them as a running bill to collect again.
      status: heldSaleIsPaid(row) ? 'completed' : 'received',
      paymentStatus: heldSaleIsPaid(row) ? 'paid' : 'unpaid',
      kind: row.kind || 'tab',
      saleUuids: Array.isArray(row.saleUuids) ? row.saleUuids : [],
      roundCount: Number(row.roundCount) || row.saleUuids?.length || 0,
      totalMinor: Number(row.totalMinor) || 0,
      dueMinor: Number(row.dueMinor) || 0,
      lines: Array.isArray(row.lines) ? row.lines : [],
      createdAt: row.openedAt || null,
    }));
}

// Explicit state distinguishes a paid zero-value sale from a zero-value
// pending round. Older snapshots only carried the outstanding amount.
function heldSaleIsPaid(row) {
  return row.kind === 'sale' && (row.paymentStatus === 'paid'
    || (!row.paymentStatus || row.paymentStatus === 'unpaid')
      && Number(row.totalMinor) > 0 && Number(row.dueMinor) === 0);
}
