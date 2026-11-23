import { db } from '../db/schema.js';
import { currentClaims, getFirebase } from './firebase.js';
import { financialSnapshot } from './financial-snapshot.js';
import { tradingDayConfig } from './financial-period.js';

/** Use the signed-in tenant, exactly as the M-Pesa viewer does. Reads never create sale records. */
export async function loadFinancialSnapshot(from, to, session = 'full') {
  const [fb, claims] = await Promise.all([getFirebase(), currentClaims()]);
  if (!fb || !claims?.tenant_id) {
    const tenants = await db.tenants.toArray();
    const tenantId = tenants[0]?.id || 'tenant-01';
    const allLocalSales = await db.sales.toArray();
    const allLocalPayments = await db.payments.toArray();
    const serverSales = allLocalSales.map((s) => ({
      id: s.id,
      tenantId: s.tenant_id || tenantId,
      idempotencyKey: s.sale_uuid || s.id,
      saleUuid: s.sale_uuid || s.id,
      invoiceNumber: s.invoice_no || s.id,
      staffId: s.staff_id || s.created_by || '',
      shiftId: s.shift_id || '',
      tableNumber: s.table_no || '',
      tabId: s.tab_id || '',
      soldAt: s.sold_at,
      status: s.status === 'VOIDED' ? 'voided' : 'completed',
      subtotalMinor: Math.round((Number(s.subtotal ?? s.grand_total) || 0) * 100),
      discountMinor: Math.round((Number(s.discount) || 0) * 100),
      totalMinor: Math.round((Number(s.grand_total) || 0) * 100),
      taxMinor: Math.round((Number(s.tax_total) || 0) * 100),
    }));
    const serverPayments = allLocalPayments.map((p) => ({
      id: p.id,
      tenantId,
      saleId: p.sale_id,
      method: p.method,
      amountMinor: Math.round((Number(p.amount) || 0) * 100),
      reference: p.reference || p.provider_txn_id || '',
      paidAt: p.received_at,
      settledAt: p.settled_at || null,
      status: 'completed',
      verified: Boolean(p.verified),
    }));
    const { dayStartHour, nightStartHour } = tradingDayConfig(null);
    const report = financialSnapshot({
      tenantId, from, to, localSales: [], localPayments: [],
      serverSales, serverPayments, attempts: [], customerOrders: [], heldOrders: [], proformas: [],
      staffScope: null, session, dayStartHour, nightStartHour,
    });
    report.session = session;
    report.dayStartHour = dayStartHour;
    report.nightStartHour = nightStartHour;
    report.dataSource = 'Local device ledger (offline / standalone mode). Whole organization.';
    return report;
  }
  const tenantId = String(claims.tenant_id);
  // Owner and store manager see the whole organization; everyone else sees the
  // money that passed through their own hands. The rules already scope M-Pesa
  // attempts this way, but sales and the payment ledger are tenant-readable, so
  // the same boundary has to be drawn here or the payments viewer would widen
  // it for every member of staff who opens it.
  // ponytail: sales and payments are fetched tenant-wide and scoped in memory,
  // because a sale payment carries no staff field of its own - only the sale
  // does. The rules already allow any signed-in member of staff to read both,
  // so this widens no access, but it does put the whole tenant's ledger on a
  // cashier's device. Narrow it server-side (a staffId on every payment, or a
  // callable that returns the scoped rows) if that matters.
  const manages = ['owner', 'store_manager'].includes(String(claims.staff_role));
  const staffScope = manages ? null : String(claims.staff_id || '');
  // Financials and the Orders Viewer must agree on what an order is. Reading
  // customer_orders here brings table-menu orders from every branch into the
  // same organization-wide unpaid position as till proformas/credit sales.
  // open_orders is read too: it is what names the order behind a payment whose
  // sale is still queued on a till. Never counted as money - only read to
  // resolve a reference - so it cannot inflate a single figure.
  const names = ['sales', 'payments', 'mpesa_payments', 'customer_orders', 'open_orders', 'proformas'];
  const results = await Promise.allSettled(names.map(name => {
    const constraints = [fb.firestore.where('tenantId', '==', tenantId)];
    if (name === 'mpesa_payments' && !manages) {
      constraints.push(fb.firestore.where('staffId', '==', staffScope));
    }
    return fb.firestore.getDocsFromServer(fb.firestore.query(fb.firestore.collection(fb.dbInstance, name), ...constraints));
  }));
  const records = results.map(result => result.status === 'fulfilled'
    ? result.value.docs.map(doc => ({ ...doc.data(), id: doc.id })) : []);
  // Local records only describe work still held here; synced history comes
  // from the server above. Do not load years of device payments for this.
  const localSales = await db.sales.where('sync_pending').equals(1).toArray();
  const localPayments = localSales.length
    ? await db.payments.where('sale_id').anyOf(localSales.map(sale => sale.id)).toArray()
    : [];
  // When the trading hours cannot be read, the defaults apply rather than the
  // report silently falling back to calendar midnight and splitting a night.
  // Wrapped whole: a missing settings document, a refused read, or an older
  // client without getDoc must not take the entire financial report down.
  let settings = null;
  try {
    settings = (await fb.firestore.getDoc(
      fb.firestore.doc(fb.dbInstance, 'tenant_settings', tenantId),
    ))?.data() ?? null;
  } catch {
    settings = null;
  }
  const { dayStartHour, nightStartHour } = tradingDayConfig(settings);
  const report = financialSnapshot({ tenantId, from, to, localSales, localPayments,
    serverSales: records[0], serverPayments: records[1], attempts: records[2],
    customerOrders: records[3], heldOrders: records[4], proformas: records[5],
    staffScope, session, dayStartHour, nightStartHour });
  report.session = session;
  report.dayStartHour = dayStartHour;
  report.nightStartHour = nightStartHour;
  const failed = names.filter((_, i) => results[i].status === 'rejected');
  const labels = { sales: 'sales', payments: 'payment ledger', mpesa_payments: 'M-Pesa confirmations', customer_orders: 'customer orders', open_orders: 'orders held on tills', proformas: 'proforma invoices' };
  // Say which account the figures belong to, always. A report that is quietly
  // narrowed to one staff member looks exactly like a quiet night otherwise.
  const scope = manages
    ? ` Whole organization (${String(claims.staff_role).replace('_', ' ')}): every staff member's records included.`
    : ' Limited to payments and orders recorded against your staff account.';
  report.dataSource = failed.length
    ? 'Incomplete report: could not refresh ' + failed.map(name => labels[name]).join(', ') + '. ONLY this device\'s offline records are shown for those - server history is missing.' + scope
    : 'Sales, payment ledger, customer orders and M-Pesa confirmations refreshed from server.' + scope;
  return report;
}
