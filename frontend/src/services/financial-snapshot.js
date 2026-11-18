/** Reconcile receipts independently of whether checkout created a sale. All sums use minor units. */
export function timestamp(value) {
  if (typeof value?.toMillis === 'function') return value.toMillis();
  if (typeof value?.toDate === 'function') return value.toDate().getTime();
  if (value && typeof value.seconds === 'number') return value.seconds * 1000;
  return value ? new Date(value).getTime() : NaN;
}
const minor = value => Math.round((Number(value) || 0) * 100);
const methodOf = value => String(value || '').toUpperCase();
const isMpesa = value => methodOf(value).replace(/[^A-Z]/g, '').includes('MPESA');
// A transfer settles against a statement line, not a provider callback, so it
// is counted separately from card takings even though both are "not cash".
const isBank = value => methodOf(value).includes('BANK');
const credit = value => ['CREDIT', 'PROFORMA'].includes(methodOf(value));
const refKey = value => String(value || '').trim().toUpperCase();

export function financialSnapshot({ tenantId, from, to, localSales = [], localPayments = [], serverSales = [], serverPayments = [], attempts = [], customerOrders = [], heldOrders = [], proformas = [], staffScope = null, session = 'full', dayStartHour = 6, nightStartHour = 17, nowMs = Date.now() }) {
  if (!tenantId) throw new Error('Sign in to load financial records.');
  if (!Number.isFinite(from) || !Number.isFinite(to) || from > to) throw new Error('Choose a valid period.');
  // The outer window spans whole trading days; this picks one session out of
  // each day inside it, so "every night this week" is one report rather than
  // seven. Night wraps midnight, which is why it is an OR and not a range.
  const inSession = time => {
    if (session !== 'morning' && session !== 'night') return true;
    const hour = new Date(time).getHours();
    return session === 'morning'
      ? hour >= dayStartHour && hour < nightStartHour
      : hour >= nightStartHour || hour < dayStartHour;
  };
  const inRange = value => {
    const time = timestamp(value);
    return time >= from && time <= to && inSession(time);
  };
  // A member of staff sees their own takings; an owner passes no scope and sees
  // the whole organization. Scoping here rather than in each caller keeps the
  // payments viewer, the financial report and the AI answering from one set of
  // rows, so they cannot disagree about what a staff member collected.
  const scope = staffScope ? String(staffScope) : '';
  const mine = row => !scope || String(row.staff_id || '') === scope;
  // The customer menu writes the order; the counter settles it. Every payment
  // that names an order is married back to the reference the customer was
  // given and the kitchen ticket carries, rather than showing a document id.
  const orders = new Map(customerOrders.filter(o => o.tenantId === tenantId).map(o => [o.id, o]));
  const invoices = new Map(proformas.filter(p => p.tenantId === tenantId).map(p => [p.id, p]));
  const representedSales = new Set([...invoices.values()].map(invoice => invoice.linkedSaleId).filter(Boolean));
  const orderStaff = order => String(order?.settledByStaffId || order?.updatedByStaffId || '');
  const remote = serverSales.filter(s => s.tenantId === tenantId).map(s => ({
    id: s.id, tenant_id: s.tenantId, sale_uuid: s.idempotencyKey || s.saleUuid,
    invoice_no: s.invoiceNumber || s.id, staff_id: s.staffId, shift_id: s.shiftId,
    checkout_stk_key: s.checkoutStkKey,
    sold_at: s.soldAt || s.createdAt, status: methodOf(s.status),
    subtotal: (s.subtotalMinor || 0) / 100, discount: (s.discountMinor || 0) / 100,
    grand_total: (s.totalMinor || 0) / 100, tax_total: (s.taxMinor || 0) / 100,
  }));
  const remoteIds = new Set(remote.map(s => s.id));
  const byUuid = new Map(remote.filter(s => s.sale_uuid).map(s => [s.sale_uuid, s.id]));
  const aliases = new Map();
  const local = localSales.filter(s => s.tenant_id === tenantId);
  for (const sale of local) aliases.set(sale.id, byUuid.get(sale.sale_uuid) || sale.id);
  /**
   * The books are what the business holds, not what one device believes.
   *
   * Local rows used to be merged in and counted. That made every figure here a
   * claim about a single iPad: a cashier settled a bank transfer, saw it in
   * their own totals, and the owner's report - reading the server - disagreed.
   * Two screens, two truths, and no way to tell which was real.
   *
   * So nothing local is counted. A sale or payment that has not reached the
   * server is reported separately as still being held, never added to takings.
   * It is not hidden; it is simply not money the business has yet.
   */
  const heldSales = local.filter(s => !remoteIds.has(aliases.get(s.id)));
  const allSales = remote;
  const saleMap = new Map(allSales.map(s => [s.id, s]));
  // An STK attempt carries the till's own sale uuid as its order reference, so
  // a payment can be married to its invoice through that even though the
  // attempt never knew the invoice number. Without this the viewer showed the
  // raw "mpesa_<uuid>" as the order, which names nothing anybody can act on.
  const saleByUuid = new Map(allSales.filter(s => s.sale_uuid).map(s => [String(s.sale_uuid), s]));
  const saleByAttemptKey = new Map(allSales.filter(s => s.checkout_stk_key).map(s => [s.checkout_stk_key, s]));
  // Orders other tills are still holding, published for observation. They are
  // the only way to name the order behind a payment whose sale has not reached
  // the server yet - which is most of them while a device is queued.
  const heldByUuid = new Map();
  for (const order of heldOrders) {
    for (const uuid of (Array.isArray(order.saleUuids) ? order.saleUuids : [])) {
      heldByUuid.set(String(uuid), order);
    }
  }
  /**
   * The order a payment names.
   *
   * The till sends the attempt's order reference truncated to 40 characters
   * while the sale key it was cut from is 42 ("mpesa_" + a 36-char uuid), so an
   * exact lookup never matches an M-Pesa till sale. Prefix matching is what
   * makes the two ends meet.
   */
  const prefixIndexes = new WeakMap();
  const byKey = (map, value) => {
    const key = String(value || '');
    if (!key) return undefined;
    if (map.has(key)) return map.get(key);
    // STK references are truncated. Build one prefix index per key length,
    // rather than rescanning every historical sale for every payment attempt.
    let lengths = prefixIndexes.get(map);
    if (!lengths) prefixIndexes.set(map, lengths = new Map());
    let index = lengths.get(key.length);
    if (!index) {
      index = new Map();
      for (const [uuid, entry] of map) {
        const prefix = uuid.slice(0, key.length);
        if (!index.has(prefix)) index.set(prefix, entry);
      }
      lengths.set(key.length, index);
    }
    return index.get(key);
  };
  const sales = allSales.filter(s => methodOf(s.status) === 'COMPLETED' && inRange(s.sold_at || s.created_at)).filter(mine);
  const selectedSales = new Set(sales.map(s => s.id));
  const ledger = serverPayments.filter(p => p.tenantId === tenantId).map(p => ({
    id: p.id, sale_id: p.saleId, customer_order_id: p.customerOrderId, proforma_id: p.proformaId,
    method: methodOf(p.method), amount: (p.amountMinor || 0) / 100,
    reference: p.providerTransactionId || p.reference || '',
    receipt_allocation_id: p.receiptAllocationId,
    receipt_limit_minor: p.receiptLimitMinor,
    received_at: p.paidAt || p.createdAt, settled_at: p.settledAt,
    status: methodOf(p.status || 'completed'), source: p.source || 'payments',
    // Every server writer stamps whoever took the money as receivedByStaffId;
    // only the STK attempt calls it staffId. Reading one name left every
    // counter-settled payment unattributed, which is what emptied the owner's
    // staff rundown. A sale payment carries no staff of its own - the sale it
    // belongs to does - and a menu order is answerable to whoever settled it.
    staff_id: p.staffId || p.receivedByStaffId
      || saleMap.get(p.saleId)?.staff_id || orderStaff(orders.get(p.customerOrderId)) || '',
    order_reference: invoices.get(p.proformaId)?.invoice?.number || orders.get(p.customerOrderId)?.ref || '',
    customer_name: invoices.get(p.proformaId)?.invoice?.client?.name || orders.get(p.customerOrderId)?.customerName || '',
    // Only a provider confirmation proves money arrived. A typed bank or card
    // reference is a member of staff asserting it did, and says so.
    verified: p.verified !== false,
  }));
  const serverPaymentIds = new Set(ledger.map(p => p.id));
  // Settlements this till holds and the business does not. Gathered, reported,
  // and never added to a total: a settlement nobody else can see is a promise,
  // not a payment. Counting these is what made two screens tell two stories.
  const heldSaleById = new Map(heldSales.map(s => [s.id, s]));
  const heldPayments = [];
  for (const payment of localPayments) {
    const saleId = aliases.get(payment.sale_id) || payment.sale_id;
    if (remoteIds.has(saleId) || serverPaymentIds.has(payment.id)) continue;
    // A settlement is money taken against a sale this till is still holding.
    // A payment row whose sale is gone - an orphan, a deleted round, a demo
    // row seeded long ago - is not money waiting to reach the business, and
    // counting it inflated "held on a till" into a number nobody could place.
    const sale = heldSaleById.get(saleId);
    if (!sale) continue;
    if (credit(payment.method) || !['COMPLETED', 'PAID', 'SUCCESS'].includes(methodOf(payment.status || 'completed'))) continue;
    heldPayments.push({
      ...payment,
      sale_id: saleId,
      method: methodOf(payment.method),
      status: 'SUCCESS',
      invoice_no: sale?.invoice_no,
      staff_id: payment.staff_id || sale?.staff_id || sale?.created_by || '',
      source: 'device',
      localOnly: true,
    });
  }
  // Every other till's settlements, as they published them. Without these the
  // held figure only ever described the device you happened to be holding: a
  // cashier settled a bank transfer and the owner's screen had nothing to
  // report, because that money lived in that iPad's database and nowhere else.
  const heldIds = new Set(heldPayments.map(p => String(p.id)));
  for (const order of heldOrders) {
    if (order.tenantId && order.tenantId !== tenantId) continue;
    for (const tender of (Array.isArray(order.payments) ? order.payments : [])) {
      const id = String(tender.id || `${order.id}:${tender.method}:${tender.amountMinor}`);
      if (heldIds.has(id)) continue;
      heldIds.add(id);
      const row = {
        id,
        method: methodOf(tender.method),
        amount: (Number(tender.amountMinor) || 0) / 100,
        reference: tender.reference || '',
        received_at: tender.paidAt || order.openedAt || null,
        staff_id: tender.staffId || order.staffId || '',
        invoice_no: order.ref,
        order_reference: order.ref,
        status: 'SUCCESS',
        source: 'till',
        localOnly: true,
        held_on_till: true,
      };
      if (mine(row)) heldPayments.push(row);
    }
  }
  const heldMinor = heldPayments.reduce((sum, p) => sum + minor(p.amount), 0);
  // Broken down, so a zero on a method card can be read against what is held.
  const heldByMethod = {};
  for (const p of heldPayments) {
    const bucket = isMpesa(p.method) ? 'mpesa' : isBank(p.method) ? 'bank' : methodOf(p.method) === 'CASH' ? 'cash' : 'other';
    heldByMethod[bucket] = (heldByMethod[bucket] || 0) + minor(p.amount);
  }
  for (const bucket of Object.keys(heldByMethod)) heldByMethod[bucket] /= 100;
  const receipts = [];
  const seen = new Map();
  let receivableMinor = 0;
  const receivableBySale = new Map();
  for (const payment of ledger) {
    if (!['COMPLETED', 'PAID', 'SUCCESS'].includes(payment.status)) continue;
    if (credit(payment.method)) {
      if (!payment.settled_at && selectedSales.has(payment.sale_id)) {
        const amountMinor = minor(payment.amount);
        receivableMinor += amountMinor;
        receivableBySale.set(payment.sale_id, (receivableBySale.get(payment.sale_id) || 0) + amountMinor);
      }
      continue;
    }
    const reference = refKey(payment.reference || payment.provider_txn_id);
    const key = isMpesa(payment.method) && reference ? `mpesa:${reference}` : `payment:${payment.id}`;
    if (seen.has(key)) {
      const previous = seen.get(key);
      // Only the server's shared allocation proves several ledger rows are
      // portions of one receipt. Legacy repeated codes stay deduplicated.
      if (payment.receipt_allocation_id && previous.receipt_allocation_id === payment.receipt_allocation_id
        && !previous.allocated_sale_ids?.includes(payment.sale_id) && mine(payment)) {
        previous.amount = Math.min(previous.amount + payment.amount, Number(payment.receipt_limit_minor) / 100);
        previous.allocated_sale_ids.push(payment.sale_id);
        previous.invoice_no = [...new Set([...String(previous.invoice_no || '').split(' / '), saleMap.get(payment.sale_id)?.invoice_no].filter(Boolean))].join(' / ');
        previous.verified = previous.verified && payment.verified;
      }
      continue;
    }
    const sale = saleMap.get(payment.sale_id);
    const order = orders.get(payment.customer_order_id);
    const row = { ...payment, allocated_sale_ids: [payment.sale_id], received_at: payment.received_at || payment.created_at || sale?.sold_at,
      staff_id: payment.staff_id || sale?.staff_id || orderStaff(order), invoice_no: sale?.invoice_no,
      // What this money actually paid for: the invoice the till printed, or the
      // reference the customer was handed at the table.
      order_reference: payment.order_reference || order?.ref || '',
      customer_name: payment.customer_name || order?.customerName || '',
      linked: Boolean(sale || payment.customer_order_id || invoices.has(payment.proforma_id)), status: 'SUCCESS' };
    if (!mine(row)) continue;
    receipts.push(row);
    seen.set(key, row);
  }
  const otherAttempts = ledger.filter(payment => payment.status === 'RECEIPT_CONFLICT' && inRange(payment.received_at) && mine(payment))
    .map(payment => ({ ...payment, invoice_no: saleMap.get(payment.sale_id)?.invoice_no,
      linked: Boolean(saleMap.has(payment.sale_id)), status: 'REVIEW', receiptConflict: true, verified: false }));
  const outstandingSaleIds = new Set(ledger.filter(row => credit(row.method) && !row.settled_at && row.amount > 0).map(row => row.sale_id));
  for (const attempt of attempts.filter(a => a.tenantId === tenantId)) {
    const status = methodOf(attempt.status);
    const date = attempt.completedAt || attempt.requestedAt || attempt.createdAt;
    const bills = [...new Map([
      ...(attempt.settlementSaleIds || []), ...(attempt.settledSaleIds || []), attempt.settledSaleId,
    ].filter(Boolean).map(id => saleMap.get(id)).concat([
      saleByAttemptKey.get(attempt.idempotencyKey), byKey(saleByUuid, attempt.orderReference),
    ]).filter(Boolean).map(sale => [sale.id, sale])).values()];
    const hasHeldOrder = Boolean(byKey(heldByUuid, attempt.orderReference));
    const unconfirmed = ['AMBIGUOUS', 'VERIFICATION_PENDING'].includes(status)
      || (['PENDING', 'INITIATING'].includes(status) && nowMs - timestamp(attempt.requestedAt || attempt.createdAt) > 3 * 60_000);
    const row = { id: attempt.id, method: 'MPESA', amount: (attempt.amountMinor || 0) / 100,
      reference: attempt.receipt || attempt.orderReference || attempt.id, received_at: date,
      staff_id: attempt.staffId, phone: attempt.phone, source: 'M-Pesa confirmation',
      // The attempt stays visible in the payment audit, but it does not become
      // an unpaid order merely because a prompt was sent. Pending totals below
      // come only from records the organization's order viewers also show.
      linked: Boolean(attempt.customerOrderId) || bills.length > 0 || hasHeldOrder,
      customer_order_id: attempt.customerOrderId,
      // The invoice first, then the table-menu reference, then the order number
      // the till that is holding it gave the customer. The internal key is a
      // last resort, and names nothing anybody can act on.
      invoice_no: bills.map(sale => sale.invoice_no).join(' / ') || undefined,
      order_reference: orders.get(attempt.customerOrderId)?.ref
        || bills.map(sale => sale.invoice_no).join(' / ')
        || byKey(heldByUuid, attempt.orderReference)?.ref
        || attempt.orderReference,
      // Said plainly: the money is here and the sale it paid for is not. That
      // is a till holding an unsent order, not a payment without a cause.
      unsynced: !attempt.customerOrderId && !bills.length && hasHeldOrder,
      unapplied: status === 'PAID' && (bills.some(sale => outstandingSaleIds.has(sale.id))
        || (Boolean(attempt.customerOrderId) && methodOf(orders.get(attempt.customerOrderId)?.paymentStatus) !== 'PAID')),
      held_on_till: hasHeldOrder,
      customer_name: orders.get(attempt.customerOrderId)?.customerName || '',
      verified: true,
      status: status === 'PAID' ? 'SUCCESS' : ['FAILED', 'CANCELLED', 'EXPIRED'].includes(status) ? 'FAILED' : unconfirmed ? 'UNCONFIRMED' : 'PENDING' };
    if (status === 'PAID') {
      const key = attempt.receipt ? `mpesa:${refKey(attempt.receipt)}` : `attempt:${attempt.id}`;
      const existing = seen.get(key);
      if (existing) {
        // Provider confirmation supplies payment time and attribution even when the invoice is older.
        existing.received_at = date || existing.received_at;
        existing.amount = row.amount;
        existing.staff_id ||= row.staff_id;
        existing.phone = row.phone;
        existing.verified = true;
        existing.unapplied = (existing.allocated_sale_ids || [existing.sale_id]).some(id => outstandingSaleIds.has(id));
        continue;
      }
      if (!mine(row)) continue;
      seen.set(key, row);
      receipts.push(row);
    } else if (inRange(date) && mine(row)) otherAttempts.push(row);
  }
  // Money with no usable timestamp used to fail the range test and disappear
  // from every total and every table at once - the books were short and nothing
  // said why. It cannot be counted into a period it has no date for, so it is
  // carried out separately and shown, rather than silently dropped.
  const undated = receipts.filter(p => !Number.isFinite(timestamp(p.received_at)))
    .map(p => ({ ...p, undated: true }));
  const payments = receipts.filter(p => inRange(p.received_at));
  // Real money that the chosen period or session leaves out.
  //
  // A session filter is a silent subtraction: pick Night and an afternoon bank
  // transfer vanishes, the tile reads KES 0.00, and nothing on the screen says
  // a filter did that. Counting what was excluded turns "the money is missing"
  // into "the money is outside the window you are looking through".
  const outsideWindow = receipts.filter(p => Number.isFinite(timestamp(p.received_at))
    && !inRange(p.received_at));
  const outsideMinor = outsideWindow.reduce((sum, p) => sum + minor(p.amount), 0);
  const totalsMinor = { cash: 0, mpesa: 0, bank: 0, other: 0 };
  for (const p of payments) {
    const bucket = isMpesa(p.method) ? 'mpesa' : isBank(p.method) ? 'bank' : methodOf(p.method) === 'CASH' ? 'cash' : 'other';
    totalsMinor[bucket] += minor(p.amount);
  }
  const gross = sales.reduce((sum, s) => sum + minor(s.subtotal ?? s.grand_total), 0) / 100;
  const discounts = sales.reduce((sum, s) => sum + minor(s.discount), 0) / 100;
  // These rows are the same unpaid orders an owner can see and act on in the
  // organization-wide Orders Viewer. An STK request on its own is an attempt,
  // not another order, so it stays in the attempt audit without inflating the
  // unreceived-cash position.
  const unpaidOrders = [];
  for (const [saleId, amountMinor] of receivableBySale) {
    if (representedSales.has(saleId)) continue;
    const sale = saleMap.get(saleId);
    if (!sale || amountMinor <= 0) continue;
    unpaidOrders.push({
      id: sale.id,
      sale_uuid: sale.sale_uuid,
      source: 'pos',
      branch_id: sale.branch_id,
      reference: sale.invoice_no || sale.id,
      amount: amountMinor / 100,
      placed_at: sale.sold_at || sale.created_at,
      staff_id: sale.staff_id || '',
      status: 'UNPAID',
    });
  }
  for (const order of customerOrders) {
    if (order.tenantId !== tenantId || methodOf(order.paymentStatus) === 'PAID' || methodOf(order.status) === 'CANCELLED') continue;
    const placed = order.createdAt || order.updatedAt;
    if (!inRange(placed)) continue;
    const amountMinor = Number(order.dueMinor ?? order.totalMinor) || 0;
    if (amountMinor <= 0) continue;
    const row = {
      id: order.id,
      source: 'customer_order',
      branch_id: order.branchId,
      reference: order.ref || order.id,
      customer_name: order.customerName || '',
      amount: amountMinor / 100,
      placed_at: placed,
      // The customer places a menu order themselves, so until a member of staff
      // advances or settles it there is genuinely nobody to attribute it to.
      staff_id: orderStaff(order),
      order_status: String(order.status || 'received'),
      status: 'UNPAID',
    };
    if (mine(row)) unpaidOrders.push(row);
  }
  // The standalone register carries every unpaid invoice, including older prepared
  // documents. It is an outstanding balance, never a sale or a received payment.
  for (const invoice of invoices.values()) {
    if (methodOf(invoice.paymentStatus) === 'PAID') continue;
    const amount = Number(invoice.invoice?.dueMinor || 0) / 100;
    const row = { id: invoice.id, source: 'proforma', branch_id: invoice.branchId,
      reference: invoice.invoice?.number || invoice.id, customer_name: invoice.invoice?.client?.name || '',
      amount, placed_at: invoice.createdAt, invoice_date: invoice.invoice?.date || '', staff_id: invoice.createdByStaffId || '', status: 'UNPAID' };
    if (amount > 0 && mine(row)) unpaidOrders.push(row);
  }
  unpaidOrders.sort((a, b) => timestamp(b.invoice_date || b.placed_at) - timestamp(a.invoice_date || a.placed_at));
  const unpaidMinor = unpaidOrders.reduce((sum, order) => sum + minor(order.amount), 0);
  const pendingAttempts = otherAttempts.filter(p => p.status === 'PENDING');

  // What each member of staff actually did in the period. An owner needs one
  // row per person covering both sides of the night - money taken in, and work
  // still open against their name - rather than a takings total that says
  // nothing about what is left outstanding.
  const byStaff = new Map();
  const track = (staffId, field, amount) => {
    const key = String(staffId || '');
    const row = byStaff.get(key) || { staff_id: key, receivedMinor: 0, receivedCount: 0,
      salesMinor: 0, salesCount: 0, unpaidMinor: 0, unpaidCount: 0 };
    row[`${field}Minor`] += minor(amount);
    row[`${field}Count`] += 1;
    byStaff.set(key, row);
  };
  for (const payment of payments) track(payment.staff_id, 'received', payment.amount);
  for (const sale of sales) track(sale.staff_id, 'sales', sale.grand_total);
  for (const order of unpaidOrders) track(order.staff_id, 'unpaid', order.amount);
  const staffRundown = [...byStaff.values()].map(row => ({
    staff_id: row.staff_id,
    received: row.receivedMinor / 100, receivedCount: row.receivedCount,
    sales: row.salesMinor / 100, salesCount: row.salesCount,
    unpaid: row.unpaidMinor / 100, unpaidCount: row.unpaidCount,
  })).sort((a, b) => b.received - a.received);
  return { sales, payments, attempts: otherAttempts,
    // Undated rows sort to the top rather than the bottom: they are the ones
    // somebody has to go and date before the period's books are trustworthy.
    transactions: [...undated, ...[...payments, ...otherAttempts].sort((a, b) => timestamp(b.received_at) - timestamp(a.received_at))],
    undated,
    undatedCount: undated.length,
    undatedTotal: undated.reduce((sum, p) => sum + minor(p.amount), 0) / 100,
    outsideWindow,
    outsideCount: outsideWindow.length,
    outsideTotal: outsideMinor / 100,
    // Settled on a till and not yet reached the business. Listed so nothing is
    // hidden, deliberately absent from every total above.
    heldPayments,
    heldCount: heldPayments.length,
    heldTotal: heldMinor / 100,
    heldByMethod,
    heldSaleCount: heldSales.length,
    // What the period was actually narrowed to, so a filtered figure can never
    // be read as the whole day's takings.
    session,
    gross, discounts, net: sales.reduce((sum, s) => sum + minor(s.grand_total), 0) / 100,
    cash: totalsMinor.cash / 100, mpesa: totalsMinor.mpesa / 100,
    bank: totalsMinor.bank / 100, other: totalsMinor.other / 100,
    collected: (totalsMinor.cash + totalsMinor.mpesa + totalsMinor.bank + totalsMinor.other) / 100,
    staffRundown,
    staffScope: scope || null,
    // Filled in by the loader with what it managed to refresh. Declared here so
    // every consumer sees it on the report rather than bolted on afterwards.
    dataSource: '',
    receivable: receivableMinor / 100,
    proformaOutstanding: unpaidOrders.filter(row => row.source === 'proforma').reduce((sum, row) => sum + minor(row.amount), 0) / 100,
    proformaReceived: payments.filter(row => row.proforma_id).reduce((sum, row) => sum + minor(row.amount), 0) / 100,
    // Unpaid means an actual order exists in one of the business's order
    // viewers and no received payment has been married to it yet.
    unpaid: unpaidMinor / 100,
    unpaidOrders,
    count: sales.length, paymentCount: payments.length,
    pendingCount: unpaidOrders.length,
    pendingAttemptCount: pendingAttempts.length,
    unconfirmedAttemptCount: otherAttempts.filter(row => row.status === 'UNCONFIRMED').length,
    receiptReviewCount: otherAttempts.filter(row => row.receiptConflict).length,
    unmatched: payments.filter(p => !p.linked).reduce((sum, p) => sum + minor(p.amount), 0) / 100,
    failed: otherAttempts.filter(p => p.status === 'FAILED').reduce((sum, p) => sum + minor(p.amount), 0) / 100,
    pending: unpaidMinor / 100,
    pendingAttempts: pendingAttempts.reduce((sum, p) => sum + minor(p.amount), 0) / 100,
  };
}

export function paymentAttemptLabel(row) {
  if (row.receiptConflict) return 'RECEIPT ALREADY RECORDED — REVIEW';
  if (row.status === 'UNCONFIRMED') return 'NO CONFIRMATION — PROMPT ONLY';
  if (row.status === 'PENDING') return 'PROMPT PENDING';
  return row.status || 'SUCCESS';
}

export function financialAnswer(m, question = 'summary') {
  const fmt = value => 'KES ' + value.toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  // Whose money this covers is part of the answer. Without it a scoped report
  // reads like the whole business being quiet rather than one person's till.
  const who = m.staffScope ? ' Showing one staff account only, not the organization.' : ' Showing the whole organization.';
  const stray = m.undatedCount ? ` ${m.undatedCount} payment(s) worth ${fmt(m.undatedTotal)} carry no usable date and are listed but not counted in any period.` : '';
  // Named every time, because a session is a silent subtraction otherwise.
  const when = m.session === 'morning' ? ' MORNING session only (money taken this evening is excluded).'
    : m.session === 'night' ? ' NIGHT session only (money taken this morning and afternoon is excluded).'
      : ' Full trading day.';
  const missed = m.outsideCount
    ? ` ${m.outsideCount} confirmed payment(s) worth ${fmt(m.outsideTotal)} fall outside this window — widen the dates or choose Full day to see them.`
    : '';
  // Stated before the figures, not after: it changes how they should be read.
  const held = m.heldCount
    ? ` NOT COUNTED BELOW: ${m.heldCount} settlement(s) worth ${fmt(m.heldTotal)} are still held on a till and have not reached the business. Every figure here is what the server holds.`
    : '';
  const review = m.receiptReviewCount ? ` ${m.receiptReviewCount} receipt conflict(s) require review and are excluded from money received.` : '';
  const coverage = `${m.dataSource || ''} Period: ${m.startStr} to ${m.endStr}.${when}${who}${held}${stray}${missed}${review}`;
  const summary = `${m.paymentCount} confirmed payments received: ${fmt(m.collected)}. Cash: ${fmt(m.cash)}; M-Pesa: ${fmt(m.mpesa)}; bank transfer: ${fmt(m.bank ?? 0)}; card/other: ${fmt(m.other)}. ${m.count} completed sales: ${fmt(m.net)}. Payments received and sales booked are different totals.`;
  if (/proforma|profoma/i.test(question)) return `${coverage}\nProforma invoices are kept in their standalone register and locked on issue. Outstanding across all invoice dates: ${fmt(m.proformaOutstanding || 0)}. Proforma payments received in this period: ${fmt(m.proformaReceived || 0)}, already included in total received and the relevant payment method. Issuing an invoice does not add to sales or money received.\n${summary}`;
  const reconciliation = `${fmt(m.unmatched)} received without a matching sale/order record. Failed/cancelled attempts: ${fmt(m.failed)}; ${m.pendingCount || 0} unpaid order(s): ${fmt(m.pending)} unreceived. Neither failed attempts nor unpaid orders are counted as collected money.`;
  if (/discount/i.test(question)) return `${coverage}\nRecorded sales discounts: ${fmt(m.discounts)} on gross sales of ${fmt(m.gross)}.`;
  if (/staff|who|team|cashier|waiter|server/i.test(question)) {
    const rows = m.staffRundown || [];
    if (!rows.length) return `${coverage}\nNo staff activity recorded in this period.`;
    return `${coverage}\n` + rows.map(row => `${row.name || row.staff_id || 'Unattributed'}: received ${fmt(row.received)} on ${row.receivedCount} payment(s); ${row.salesCount} completed sale(s) worth ${fmt(row.sales)}; ${row.unpaidCount} still unpaid at ${fmt(row.unpaid)}.`).join('\n');
  }
  if (/bank|transfer|reference/i.test(question)) return `${coverage}\nBank transfers received: ${fmt(m.bank ?? 0)}, counted in the ${fmt(m.collected)} total. No bank feed verifies these, so each one is a statement reference a member of staff recorded against an order.\n${summary}`;
  if (/unpaid|pending|credit|proforma|debt/i.test(question)) return `${coverage}\nTotal unpaid: ${fmt(m.unpaid ?? m.pending)} across ${m.pendingCount || 0} order(s) in the organization. This is unreceived cash until each order is reconciled to an M-Pesa code, bank reference, card reference, or accepted cash payment.\n${summary}`;
  return `${coverage}\n${summary}\n${reconciliation}`;
}
