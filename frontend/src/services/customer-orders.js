import { getFirebase, currentClaims, callFunction } from './firebase';
import { escapeHtml } from './print-receipt';

export async function watchCustomerOrders(onOrders, onError) {
  const fb = await getFirebase();
  const claims = await currentClaims();
  if (!fb || !claims?.tenant_id) throw new Error('Sign in to receive customer orders.');
  return fb.firestore.onSnapshot(fb.firestore.query(
    fb.firestore.collection(fb.dbInstance, 'customer_orders'),
    fb.firestore.where('tenantId', '==', claims.tenant_id),
  ), (snapshot) => onOrders(snapshot.docs.map((doc) => ({ ...doc.data(), id: doc.id })).sort((a, b) => (b.createdAt?.toMillis() || 0) - (a.createdAt?.toMillis() || 0))), onError);
}

/** The serving instruction the customer chose at the table. */
export const servingLabel = (order) => order.orderType === 'takeaway'
  ? 'TAKEAWAY'
  : `TABLE ${order.tableNumber || '—'}`;

/**
 * When the order was placed.
 *
 * The board carries two kinds of order: live menu orders, whose `createdAt` is
 * a Firestore Timestamp, and till sales, whose time is an ordinary Date. Both
 * are read through here so nothing downstream has to know which it holds.
 */
export function placedAt(order) {
  const value = order?.createdAt;
  if (!value) return null;
  const date = typeof value.toDate === 'function' ? value.toDate() : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * A completed till sale in the shape the board renders.
 *
 * A sale is already cooked, served and settled, so it enters the board as a
 * completed, paid order. It is never given kitchen-ticket controls: reprinting
 * one would send food to the pass for a table that has already left.
 */
export function saleAsOrder(sale, { payment, cashierName, customerName, lines } = {}) {
  const majorUnits = Number(payment?.amount ?? sale.grand_total ?? 0);
  return {
    id: sale.id,
    source: 'pos',
    branchId: sale.branch_id,
    ref: sale.invoice_no || String(sale.sale_uuid || sale.id).slice(0, 8).toUpperCase(),
    customerName: customerName || 'Guest',
    cashierName: cashierName || '',
    orderType: sale.table_no ? 'dine_in' : 'takeaway',
    tableNumber: sale.table_no ? String(sale.table_no) : '',
    status: 'completed',
    paymentStatus: 'paid',
    paymentMethod: payment?.method || '',
    paymentReference: payment?.reference || '',
    totalMinor: Math.round((Number.isFinite(majorUnits) ? majorUnits : 0) * 100),
    lines: lines || [],
    createdAt: new Date(sale.sold_at),
  };
}

/** The print job the counter sends to the kitchen. Prices stay off the pass. */
export const kitchenTicket = (order, copy) => ({
  kind: 'kitchen',
  ref: order.ref,
  orderType: order.orderType || 'dine_in',
  tableNumber: order.tableNumber || '',
  customerName: order.customerName,
  placedAt: (placedAt(order) || new Date()).toLocaleString(),
  paid: order.paymentStatus === 'paid',
  paymentMethod: order.paymentMethod || '',
  note: order.note || '',
  lines: (order.lines || []).map((line) => ({ name: line.name, qty: line.qty })),
  copy,
});

/**
 * The board's tabs, and the stored statuses each one covers.
 *
 * `received` and `awaiting_print` are both shown as Pending because they mean
 * the same thing to a server: the kitchen does not have it yet. What separates
 * them is only whether the customer has already paid, which the card says
 * separately.
 */
export const ORDER_TABS = [
  { id: 'all', label: 'All', statuses: null },
  { id: 'pending', label: 'Pending', statuses: ['received', 'awaiting_print'] },
  { id: 'preparing', label: 'Preparing', statuses: ['preparing'] },
  { id: 'served', label: 'Served', statuses: ['ready'] },
  { id: 'completed', label: 'Completed', statuses: ['completed'] },
  { id: 'cancelled', label: 'Cancelled', statuses: ['cancelled'] },
];

const TAB_FOR_STATUS = new Map(
  ORDER_TABS.flatMap((tab) => (tab.statuses || []).map((status) => [status, tab])),
);

/** An unknown status is shown as itself rather than silently filed as Pending. */
export const statusTab = (order) => TAB_FOR_STATUS.get(String(order.status)) || null;
export const statusLabel = (order) => statusTab(order)?.label || String(order.status || 'Unknown');

/** Counts for the tiles: one per tab, over this branch's orders. */
export function orderStats(orders, branchId) {
  const current = orders.filter((order) => order.branchId === branchId);
  return ORDER_TABS.map((tab) => ({
    id: tab.id,
    label: tab.id === 'all' ? 'Total Orders' : `${tab.label} Orders`,
    count: tab.statuses ? current.filter((order) => tab.statuses.includes(String(order.status))).length : current.length,
  }));
}

/** The orders a tab and search box leave on screen, newest first. */
export function visibleOrders(orders, branchId, { tab = 'all', search = '' } = {}) {
  const wanted = ORDER_TABS.find((entry) => entry.id === tab)?.statuses;
  const needle = search.trim().toLowerCase();
  return orders.filter((order) => {
    if (order.branchId !== branchId) return false;
    if (wanted && !wanted.includes(String(order.status))) return false;
    if (!needle) return true;
    const haystack = [
      order.ref, order.customerName, order.tableNumber, servingLabel(order),
      order.cashierName, order.paymentMethod, order.paymentReference,
      ...(order.lines || []).map((line) => line.name),
    ].join(' ').toLowerCase();
    return haystack.includes(needle);
  });
}

/**
 * Only a real image URL reaches an src. The plate glyph sits behind the photo
 * rather than instead of it, so a catalogue picture that 404s shows the glyph
 * instead of an empty slot.
 */
const thumbFor = (order, images) => {
  const url = images?.get((order.lines || [])[0]?.productId);
  const photo = typeof url === 'string' && /^(https:\/\/|\/(?!\/))/.test(url)
    ? `<img src="${escapeHtml(url)}" alt="">`
    : '';
  return `<div class="co-thumb" aria-hidden="true">🍽️${photo}</div>`;
};

export function renderOrderCard(order, images) {
  const fromTill = order.source === 'pos';
  const closed = ['completed', 'cancelled'].includes(String(order.status));
  const paid = order.paymentStatus === 'paid';
  const prints = Number(order.printCount || 0);
  const placed = placedAt(order);
  const tab = statusTab(order);

  // A till sale is history: its only action is reprinting the tax invoice.
  // A menu order is live work, so it carries the kitchen and status controls.
  // Nothing reaches the kitchen unpaid, so an unpaid order offers payment
  // instead of a ticket and says why the ticket is not available yet.
  const liveActions = paid
    ? `<button type="button" class="co-print" data-print-order="${escapeHtml(order.id)}">${prints ? 'Reprint kitchen ticket' : 'Print kitchen ticket'}</button>`
    : `<button type="button" class="co-pay" data-pay-order="${escapeHtml(order.id)}">Pay now</button>
       <button type="button" class="co-print" data-print-order="${escapeHtml(order.id)}" disabled title="Take payment before the kitchen can start this order.">Print kitchen ticket</button>`;

  const actions = fromTill
    ? `<button type="button" class="co-print" data-invoice-sale="${escapeHtml(order.id)}">View invoice</button>
       <span class="co-meta" style="margin:0">${escapeHtml(order.paymentMethod || 'Settled at the till')}</span>`
    : `${closed ? '' : `${liveActions}
       <select class="co-status-select" aria-label="Order status" data-customer-order="${escapeHtml(order.id)}"><option value="">Update status…</option><option value="preparing">Preparing</option><option value="ready">Ready</option><option value="completed">Completed</option><option value="cancelled">Cancelled</option></select>`}
       <span class="co-meta" style="margin:0">${prints ? `Printed ${prints}×` : 'Not printed'}</span>`;

  return `<article class="co-card">
    ${thumbFor(order, images)}
    <div class="co-body">
      <div class="co-row">
        <span class="co-ref">Order #${escapeHtml(order.ref)}</span>
        <span class="co-pill ${tab ? tab.id : 'pending'}">${escapeHtml(statusLabel(order))}</span>
      </div>
      <div class="co-meta">${escapeHtml(servingLabel(order))} · ${escapeHtml(order.customerName)}${order.cashierName ? ` · ${escapeHtml(order.cashierName)}` : ''}<br>
        Date: ${escapeHtml(placed?.toLocaleDateString() || '—')} &nbsp; Time: ${escapeHtml(placed?.toLocaleTimeString() || '—')}</div>
      <div class="co-items">${(order.lines || []).map((line) => `${line.qty} × ${escapeHtml(line.name)}`).join(' · ')}</div>
      ${order.note ? `<div class="co-meta">Instructions: ${escapeHtml(order.note)}</div>` : ''}
      <div class="co-row">
        <span class="co-total">KES ${(order.totalMinor / 100).toFixed(2)}</span>
        <span class="${paid ? 'co-paid' : 'co-unpaid'}">${paid ? `PAID${order.paymentReference ? ` · ${escapeHtml(order.paymentReference)}` : ''}` : 'UNPAID'}</span>
      </div>
      <div class="co-actions">${actions}</div>
    </div>
  </article>`;
}

/** The card grid. Rows are already filtered and paged by the caller. */
export function renderOrderGrid(rows, images) {
  if (!rows.length) return '<p class="co-empty">No orders match this view.</p>';
  return `<div class="co-grid">${rows.map((order) => renderOrderCard(order, images)).join('')}</div>`;
}

export const updateCustomerOrder = (orderId, status) => callFunction('updateCustomerOrder', { orderId, status });
export const printCustomerOrder = (orderId) => callFunction('printCustomerOrder', { orderId });

/** Counter-side settlement. The customer's browser can do none of this. */
export const chargeCustomerOrder = (orderId, phone, paymentRequestId) => callFunction('chargeCustomerOrder', { orderId, phone, paymentRequestId });
export const checkCustomerOrderPayment = (orderId) => callFunction('checkCustomerOrderPayment', { orderId });
export const settleCustomerOrderCash = (orderId) => callFunction('settleCustomerOrderCash', { orderId });
/** Settles against a payment M-Pesa has already confirmed to this business. */
export const settleCustomerOrderByCode = (orderId, code) => callFunction('settleCustomerOrderByCode', { orderId, code });
/** Records money the card terminal took; there is no card integration. */
export const settleCustomerOrderCard = (orderId, reference) => callFunction('settleCustomerOrderCard', { orderId, reference });
