import { getFirebase, currentClaims, callFunction } from './firebase.js';
import { escapeHtml } from './print-receipt.js';
import { isReceivable } from './takings.js';
import { state } from '../context.js';
import { createReceiptLookup } from './receipt-lookup.js';

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
 * A till sale's own status, in the board's vocabulary.
 *
 * An order is registered the moment Pay Now is tapped, so it reaches the board
 * before any money has moved, and a mis-tap that was taken back has to stay
 * visible rather than disappear. Anything else is a finished sale.
 */
/**
 * A till sale in the shape the board renders.
 *
 * A sale is never given kitchen-ticket controls: reprinting one would send
 * food to the pass for a table that has already left.
 */
export function saleAsOrder(sale, { payment, payments, cashierName, customerName, lines } = {}) {
  const majorUnits = Number(payment?.amount ?? sale.grand_total ?? 0);
  // A proforma leaves the counter unpaid. Calling every till sale paid is how
  // one disappeared into a board of settled history the moment it printed.
  const ledger = payments || (payment ? [payment] : []);
  const receivableOwed = ledger
    .filter((row) => isReceivable(row?.method) && !row?.settled_at)
    .reduce((total, row) => total + (Number(row?.amount) || 0), 0);
  const settlement = ledger.find((row) => !isReceivable(row?.method));
  // A pending round need not have a receivable row yet. Its header still
  // represents an unpaid bill; absence of a payment is not proof of payment.
  // A voided sale was taken back. Its receivable row may still read unsettled
  // (pulled rows carry no void stamp), but nothing on it is owed.
  const owed = sale.status === 'VOIDED' ? 0
    : sale.status === 'PENDING_PAYMENT' && !ledger.some(row => isReceivable(row?.method))
    ? Math.max(receivableOwed, (Number(sale.grand_total) || 0) - ledger
      .filter((row) => !isReceivable(row?.method))
      .reduce((sum, row) => sum + (Number(row.amount) || 0), 0))
    : receivableOwed;
  const awaitingPayment = owed > 0 || (sale.status === 'PENDING_PAYMENT'
    && !settlement && !ledger.some(row => isReceivable(row?.method) && row.settled_at));
  return {
    id: sale.id,
    source: 'pos',
    branchId: sale.branch_id,
    // Who rang it up, carried on the order itself so a sale pulled from the
    // server is traceable without this device having that shift on file.
    staffId: sale.staff_id || sale.created_by || null,
    // Whose tab an unpaid one sits on, so settling it can clear the debt.
    customerId: sale.customer_id || null,
    ref: sale.invoice_no || String(sale.sale_uuid || sale.id).slice(0, 8).toUpperCase(),
    // The key the sale was submitted under. The server derives its own id from
    // it, so this is what settlement is addressed by.
    saleUuid: sale.sale_uuid || null,
    tabId: sale.tab_id || null,
    tabReference: sale.order_reference || null,
    customerName: customerName || 'Guest',
    cashierName: cashierName || '',
    orderType: sale.table_no ? 'dine_in' : 'takeaway',
    tableNumber: sale.table_no ? String(sale.table_no) : '',
    // Booking an unpaid receivable on the server uses status "completed".
    // It still belongs on the floor's Pending board until money settles it.
    status: sale.status === 'VOIDED' ? 'cancelled'
      : awaitingPayment ? 'awaiting_payment' : 'completed',
    // Three states, not two. A voided order owes nothing, but calling it paid
    // put "PAID · Settled at the till" on a cancelled order, which reads as
    // money taken for something that was taken back.
    paymentStatus: sale.status === 'VOIDED' ? 'void' : (awaitingPayment ? 'unpaid' : 'paid'),
    // What is still owed, so the board can say how much to collect rather than
    // only that something is outstanding.
    dueMinor: Math.round(owed * 100),
    // Once settled, the tender that actually paid is the one worth showing -
    // it carries the M-Pesa code or bank reference to reconcile against.
    paymentMethod: (owed > 0 ? payment?.method : settlement?.method || payment?.method) || '',
    paymentReference: (owed > 0 ? payment?.reference : settlement?.reference || payment?.reference) || '',
    totalMinor: Math.round((Number.isFinite(majorUnits) ? majorUnits : 0) * 100),
    lines: lines || [],
    createdAt: new Date(sale.sold_at),
  };
}

/**
 * One card per table, not one per trip to it.
 *
 * Every round is its own sale with its own fiscal invoice number, which is
 * what KRA needs, but the floor and the customer know a table by one bill.
 * Rounds on an open tab are merged into a single order carrying the tab's
 * order number, every item across every round, and one total to collect.
 *
 * Rounds on no tab, and rounds on a tab that has already been closed, are
 * left exactly as they are: history, each under its own invoice.
 */
export function mergeTabRounds(orders, tabs) {
  const open = new Map((tabs || [])
    .filter((tab) => tab.status === 'OPEN')
    .map((tab) => [tab.id, tab]));
  const headers = new Set((tabs || []).map(tab => tab.id));
  for (const order of orders || []) {
    if (order.tabId && order.tabReference && order.paymentStatus === 'unpaid' && !headers.has(order.tabId)) {
      open.set(order.tabId, { id: order.tabId, order_no: order.tabReference, table_no: order.tableNumber });
    }
  }

  const merged = [];
  const groups = new Map();

  for (const order of orders || []) {
    // Edit items voids a round and re-sends what is left as a new one, so a
    // voided round is history, never part of the bill: merging it put every
    // removed item, and its price, back on the table.
    const tab = order.tabId && order.paymentStatus !== 'void' ? open.get(order.tabId) : null;
    if (!tab) {
      merged.push(order);
      continue;
    }

    const group = groups.get(tab.id);
    if (!group) {
      const seed = {
        ...order,
        id: tab.id,
        ref: tab.order_no || order.ref,
        tableNumber: tab.table_no,
        orderType: 'dine_in',
        // The rounds behind the card, so settling can clear all of them.
        roundIds: [order.id],
        roundUuids: order.saleUuid ? [order.saleUuid] : [],
        // Each round's own invoice, so a link or search by any of them finds the card.
        roundRefs: [order.ref],
        lines: [...(order.lines || [])],
      };
      groups.set(tab.id, seed);
      merged.push(seed);
      continue;
    }

    group.roundIds.push(order.id);
    if (order.saleUuid) group.roundUuids.push(order.saleUuid);
    group.roundRefs.push(order.ref);
    group.lines.push(...(order.lines || []));
    group.totalMinor += order.totalMinor;
    group.dueMinor += order.dueMinor;
    // The tab opened when its first round did.
    if (placedAt(order) && placedAt(group) && placedAt(order) < placedAt(group)) {
      group.createdAt = order.createdAt;
    }
    // Anything still owed keeps the whole tab unpaid and on the Pending board.
    if (order.paymentStatus === 'unpaid') {
      group.paymentStatus = 'unpaid';
      group.status = 'awaiting_payment';
    }
  }

  return merged;
}

/**
 * Who is answerable for an order.
 *
 * A till sale names the staff member who rang it up. A menu order is placed by
 * the customer, so the trail is whoever acted on it since: took the money,
 * sent it to the kitchen, or last moved its status. The most recent of those
 * is the person to ask about it, so that is the one shown.
 *
 * `names` maps a staff id to a name. An id with no name is shown as the id
 * rather than dropped: an untraceable order is exactly what this is for.
 */
export function handledBy(order, names) {
  const id = order?.source === 'pos'
    ? order.staffId
    : (order?.settledByStaffId || order?.lastPrintedByStaffId || order?.updatedByStaffId);
  if (!id) return '';
  return names?.get(id) || String(id);
}

/** What that person did, so the card says why their name is on it. */
export const handledLabel = (order) => (order?.source === 'pos' ? 'Billed by' : 'Handled by');

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
  { id: 'running', label: 'Running', statuses: null },
  { id: 'pending', label: 'Pending', statuses: ['received', 'awaiting_print', 'awaiting_payment'] },
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

/**
 * Whether an order belongs to the view.
 *
 * The board is a branch's work, so it shows a branch. An owner answering for
 * the whole business is the exception: their question is "what happened
 * tonight", not "what happened in this room", and a branch filter they cannot
 * see is how orders looked missing rather than filtered.
 */
const inScope = (order, branchId, allBranches) => allBranches || order.branchId === branchId;
export const isRunningOrder = (order) => order.paymentStatus === 'unpaid' && order.status !== 'cancelled';

export function sortOrders(orders, sort = 'newest') {
  const text = (a, b) => String(a || '').localeCompare(String(b || ''), undefined, { numeric: true, sensitivity: 'base' });
  const newest = (a, b) => (placedAt(b)?.getTime() || 0) - (placedAt(a)?.getTime() || 0);
  return [...orders].sort((a, b) => {
    if (sort === 'table') return text(a.tableNumber || '\uffff', b.tableNumber || '\uffff') || newest(a, b);
    if (sort === 'staff') return text(a.cashierName || a.staffId, b.cashierName || b.staffId) || text(a.tableNumber, b.tableNumber) || newest(a, b);
    if (sort === 'oldest') return -newest(a, b);
    if (sort === 'amount') return Number(b.dueMinor || 0) - Number(a.dueMinor || 0) || newest(a, b);
    return newest(a, b);
  });
}

/** Counts for the tiles: one per tab, over the orders in view. */
export function orderStats(orders, branchId, allBranches = false) {
  const current = orders.filter((order) => inScope(order, branchId, allBranches));
  return ORDER_TABS.map((tab) => ({
    id: tab.id,
    label: tab.id === 'all' ? 'Total Orders' : `${tab.label} Orders`,
    count: tab.id === 'running' ? current.filter(isRunningOrder).length
      : tab.statuses ? current.filter((order) => tab.statuses.includes(String(order.status))).length : current.length,
  }));
}

/** The orders a tab and search box leave on screen, newest first. */
export function visibleOrders(orders, branchId, { tab = 'all', search = '', allBranches = false } = {}) {
  const wanted = ORDER_TABS.find((entry) => entry.id === tab)?.statuses;
  const needle = search.trim().toLowerCase();
  return orders.filter((order) => {
    if (!inScope(order, branchId, allBranches)) return false;
    if (tab === 'running' && !isRunningOrder(order)) return false;
    if (wanted && !wanted.includes(String(order.status))) return false;
    if (!needle) return true;
    const haystack = [
      order.ref, ...(order.roundRefs || []), order.customerName, order.tableNumber, servingLabel(order),
      // Both the name and the raw staff id: an owner tracing an order may have
      // either, and statusLabel puts the state itself within reach too.
      order.cashierName, order.staffId, order.settledByStaffId, statusLabel(order),
      order.paymentMethod, order.paymentReference,
      ...(order.lines || []).map((line) => line.name),
    ].filter(Boolean).join(' ').toLowerCase();
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

/**
 * A shared order whose original local item records are on another device.
 * Payment resolves its existing server rounds; item editing stays separate.
 */
function renderSharedCard(order, images, tab, placed) {
  const due = Number(order.dueMinor ?? order.totalMinor) || 0;
  return `<article class="co-card">
    ${thumbFor(order, images)}
    <div class="co-body">
      <div class="co-row">
        <span class="co-ref">Order #${escapeHtml(order.ref)}</span>
        <span class="co-pill ${order.paymentStatus === 'paid' ? 'completed' : 'pending'}">${order.paymentStatus === 'paid' ? 'PAID' : 'RUNNING'}</span>
      </div>
      <div class="co-meta">${escapeHtml(servingLabel(order))} · ${escapeHtml(order.customerName)}<br>
        ${order.cashierName
          ? `Staff: <b>${escapeHtml(order.cashierName)}</b><br>`
          : '<span style="opacity:0.7">Nobody has handled this yet</span><br>'}
        Date: ${escapeHtml(placed?.toLocaleDateString() || '—')} &nbsp; Time: ${escapeHtml(placed?.toLocaleTimeString() || '—')}</div>
      <div class="co-items">${(order.lines || []).map((line) => `${line.qty} × ${escapeHtml(line.name)}`).join(' · ')}</div>
      <div class="co-row">
        <span class="co-total">KES ${(Number(order.totalMinor || 0) / 100).toFixed(2)}</span>
        <span class="${order.paymentStatus === 'paid' ? 'co-paid' : 'co-unpaid'}">${order.paymentStatus === 'paid' ? 'PAID' : `UNPAID · KES ${(due / 100).toFixed(2)} due`}</span>
      </div>
      <div class="co-actions">
        <span class="co-meta" style="margin:0">${order.paymentStatus === 'paid'
          ? 'Payment recorded.'
          : 'Payment can be taken from this device.'}</span>
        ${order.paymentStatus === 'paid' ? '' : `<button type="button" class="co-pay" data-settle-sale="${escapeHtml(order.id)}">Pay now</button>`}
      </div>
    </div>
  </article>`;
}

export function renderOrderCard(order, images) {
  const fromTill = order.source === 'pos';
  const closed = ['completed', 'cancelled'].includes(String(order.status));
  const paid = order.paymentStatus === 'paid';
  // Taken back before anyone paid: nothing to collect and nothing to reprint.
  const voided = order.paymentStatus === 'void';
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

  // A shared snapshot offers payment against the original server sale IDs.
  // It is never imported as a new local sale or given local item controls.
  if (order.readOnly) {
    return renderSharedCard(order, images, tab, placed);
  }

  const actions = fromTill
    ? `<button type="button" class="co-print" data-invoice-sale="${escapeHtml(order.id)}">View invoice</button>
       ${paid || voided ? '' : `<button type="button" class="co-pay" data-settle-sale="${escapeHtml(order.id)}">Pay now</button>`}
       ${!paid && !voided && order.tabId !== undefined && order.roundIds
         ? `<button type="button" class="sec-btn" data-edit-tab="${escapeHtml(order.id)}" style="padding:6px 12px;font-size:12px;">Edit items</button>
            <a class="sec-btn" href="/tabs" style="padding:6px 12px;font-size:12px;text-decoration:none;">Tab management</a>`
         : ''}
       <span class="co-meta" style="margin:0">${voided
         ? `Voided${order.voidReason ? ` · ${escapeHtml(order.voidReason)}` : ''}`
         : paid ? escapeHtml(order.paymentMethod || 'Payment recorded') : 'Awaiting payment'}</span>`
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
      <div class="co-meta">${escapeHtml(servingLabel(order))} · ${escapeHtml(order.customerName)}<br>
        ${order.cashierName
          ? `${escapeHtml(handledLabel(order))} <b>${escapeHtml(order.cashierName)}</b><br>`
          : '<span style="opacity:0.7">Nobody has handled this yet</span><br>'}
        Date: ${escapeHtml(placed?.toLocaleDateString() || '—')} &nbsp; Time: ${escapeHtml(placed?.toLocaleTimeString() || '—')}</div>
      <div class="co-items">${(order.lines || []).map((line) => `${line.qty} × ${escapeHtml(line.name)}`).join(' · ')}</div>
      ${order.note ? `<div class="co-meta">Instructions: ${escapeHtml(order.note)}</div>` : ''}
      <div class="co-row">
        <span class="co-total">KES ${(order.totalMinor / 100).toFixed(2)}</span>
        <span class="${voided ? 'co-meta' : paid ? 'co-paid' : 'co-unpaid'}">${voided
          ? 'VOIDED · nothing owed'
          : paid
            ? `PAID${order.paymentMethod ? ` · ${escapeHtml(String(order.paymentMethod).toUpperCase())}` : ''}${order.paymentReference ? ` · ${escapeHtml(order.paymentReference)}` : ''}`
            : `UNPAID${order.dueMinor ? ` · KES ${(order.dueMinor / 100).toFixed(2)} due` : ''}`}</span>
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
export const settleCustomerOrderByCode = (orderId, code, receiptAmountMinor) => callFunction('settleCustomerOrderByCode', { orderId, code,
  ...(receiptAmountMinor !== undefined ? { receiptAmountMinor } : {}) });
/** Records a bank transfer against an order, with the statement reference. */
export const settleCustomerOrderBank = (orderId, reference) => callFunction('settleCustomerOrderBank', { orderId, reference });
/** Records money the card terminal took; there is no card integration. */
export const settleCustomerOrderCard = (orderId, reference) => callFunction('settleCustomerOrderCard', { orderId, reference });

/**
 * Settles a till sale that went out unpaid - a proforma, or anything on
 * account. An M-Pesa code is checked against the confirmations the provider
 * sent this business, so settling on one means the money actually arrived.
 */
export const settleSale = (input) => callFunction('settleSale', input);
export const lookupMpesaReceipt = createReceiptLookup(
  input => callFunction('lookupMpesaReceipt', input, { timeout: 10000 }),
  () => JSON.stringify([state.currentTenant?.id, state.currentUser?.id]),
);
export const claimSalePayment = (input) => callFunction('claimSalePayment', input);
export const voidSale = (input) => callFunction('voidSale', input);
