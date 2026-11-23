import test from 'node:test';
import assert from 'node:assert/strict';
import { financialSnapshot, financialAnswer, paymentAttemptLabel } from './financial-snapshot.js';
const from = Date.parse('2026-09-08T00:00:00+03:00');
const to = Date.parse('2026-09-09T23:59:59.999+03:00');
const date = '2026-09-09T10:00:00Z';
const snapshot = data => financialSnapshot({ tenantId: 'tenant', from, to, nowMs: Date.parse(date) + 60000, ...data });
const attempt = (id, amountMinor, status = 'paid', extra = {}) => ({ id, tenantId: 'tenant', receipt: id, amountMinor, status, requestedAt: date, completedAt: date, ...extra });

test('old unresolved prompts remain audit events and never become unpaid invoices', () => {
  const report = snapshot({ nowMs: Date.parse(date) + 86400000,
    attempts: ['ambiguous', 'verification_pending', 'pending'].map(status => attempt(status, 105000, status)) });
  assert.equal(report.unpaid, 0);
  assert.equal(report.collected, 0);
  assert.equal(report.unpaidOrders.length, 0);
  assert.equal(report.unconfirmedAttemptCount, 3);
  for (const row of report.transactions) assert.equal(paymentAttemptLabel(row), 'NO CONFIRMATION — PROMPT ONLY');
});

test('conflicting offline receipts are visible for review and never add another received payment', () => {
  const report = snapshot({ serverSales: [{ id: 'new-sale', tenantId: 'tenant', status: 'completed', invoiceNumber: 'INV-OFFLINE', soldAt: date, totalMinor: 105000 }],
    serverPayments: [{ id: 'old-payment', tenantId: 'tenant', method: 'mpesa', reference: 'SAMECODE', amountMinor: 105000, paidAt: date },
      { id: 'conflict', tenantId: 'tenant', saleId: 'new-sale', method: 'mpesa', reference: 'SAMECODE', amountMinor: 105000,
        paidAt: date, status: 'receipt_conflict', verified: false, receiptConflict: true }] });
  assert.equal(report.collected, 1050);
  assert.equal(report.paymentCount, 1);
  assert.equal(report.receiptReviewCount, 1);
  const row = report.transactions.find(row => row.id === 'conflict');
  assert.equal(row.invoice_no, 'INV-OFFLINE');
  assert.match(paymentAttemptLabel(row), /ALREADY RECORDED.*REVIEW/);
  assert.match(financialAnswer(report), /excluded from money received/);
});

test('server-allocated table rounds count one whole receipt; legacy reused codes still count once', () => {
  const serverSales = [1, 2].map(n => ({ id: `sale${n}`, tenantId: 'tenant', invoiceNumber: `INV${n}`, status: 'completed', soldAt: date }));
  const serverPayments = [50000, 20000].map((amountMinor,i) => ({ id: `pay${i}`, tenantId: 'tenant', saleId: `sale${i+1}`,
    method: 'mpesa', amountMinor, reference: 'TABLECODE', paidAt: date, receiptAllocationId: 'checkout:table', receiptLimitMinor: 70000 }));
  const report = snapshot({ serverSales, serverPayments });
  assert.equal(report.collected, 700);
  assert.equal(report.paymentCount, 1);
  assert.equal(report.transactions[0].invoice_no, 'INV1 / INV2');
  const legacy = snapshot({ serverSales, serverPayments: serverPayments.map(({ receiptAllocationId, receiptLimitMinor, ...row }) => row) });
  assert.equal(legacy.collected, 500);
});

test('a provider receipt binds to its saved invoice and upgrades a matching ledger receipt once', () => {
  const serverSales = [{ id: 'saved', tenantId: 'tenant', invoiceNumber: 'INV-537', status: 'completed',
    checkoutStkKey: 'new-prompt', totalMinor: 105000, soldAt: date }];
  const credit = { id: 'credit', tenantId: 'tenant', saleId: 'saved', method: 'credit', amountMinor: 105000, paidAt: date };
  const proof = attempt('original-receipt', 105000, 'paid', { idempotencyKey: 'new-prompt' });
  const pending = snapshot({ serverSales, serverPayments: [credit], attempts: [proof] });
  assert.equal(pending.transactions[0].invoice_no, 'INV-537');
  assert.equal(pending.transactions[0].unapplied, true);
  assert.equal(pending.transactions[0].unsynced, false);
  const reconciled = snapshot({ serverSales, attempts: [proof], serverPayments: [
    { ...credit, settledAt: date }, { id: 'receipt', tenantId: 'tenant', saleId: 'saved', method: 'mpesa',
      reference: 'original-receipt', amountMinor: 105000, paidAt: date, verified: false },
  ] });
  assert.equal(reconciled.collected, 1050);
  assert.equal(reconciled.paymentCount, 1);
  assert.equal(reconciled.transactions[0].verified, true);
  assert.equal(reconciled.transactions[0].unapplied, false);
});

test('separate allocations from the same receipt to the same bill count each payment once', () => {
  const serverSales = [{ id: 'sale1', tenantId: 'tenant', status: 'completed', soldAt: date }];
  const serverPayments = [40000, 60000].map((amountMinor, i) => ({ id: `portion${i}`, tenantId: 'tenant', saleId: 'sale1',
    method: 'mpesa', amountMinor, reference: 'RECEIPT123', paidAt: date, receiptAllocationId: 'receipt:one', receiptLimitMinor: 100000 }));
  const report = snapshot({ serverSales, serverPayments });
  assert.equal(report.collected, 1000);
  assert.equal(report.paymentCount, 1);
});

test('truncated references preserve first-prefix matching and exact references take priority', () => {
  const report = snapshot({
    serverSales: ['prefix-first', 'prefix-second', 'prefix'].map((key, i) => ({
      id: `s${i}`, tenantId: 'tenant', idempotencyKey: key, invoiceNumber: `INV${i}`,
      status: 'completed', soldAt: date, totalMinor: 100,
    })),
    attempts: [
      attempt('truncated', 100, 'paid', { orderReference: 'pref' }),
      attempt('exact', 100, 'paid', { orderReference: 'prefix' }),
      attempt('missing', 100, 'paid', { orderReference: 'absent' }),
    ],
  });
  const rows = new Map(report.transactions.map(row => [row.reference, row]));
  assert.equal(rows.get('truncated').invoice_no, 'INV0');
  assert.equal(rows.get('exact').invoice_no, 'INV2');
  assert.equal(rows.get('missing').linked, false);
});

test('successful provider payments appear without a sale; failed and pending attempts are not revenue', () => {
  const report = snapshot({ attempts: [attempt('receipt1', 88000), attempt('receipt2', 20000), attempt('failure', 88000, 'failed'), attempt('pending', 30000, 'pending')] });
  assert.equal(report.count, 0);
  assert.equal(report.net, 0);
  assert.equal(report.collected, 1080);
  assert.equal(report.mpesa, 1080);
  assert.equal(report.unmatched, 1080);
  assert.equal(report.paymentCount, 2);
  assert.equal(report.failed, 880);
  assert.equal(report.pending, 0);
  assert.equal(report.pendingCount, 0);
  assert.equal(report.pendingAttempts, 300);
  assert.equal(report.pendingAttemptCount, 1);
  assert.equal(report.unpaid, 0);
  assert.equal(report.transactions.length, 4);
  assert.equal(report.transactions.find(row => row.id === 'pending').status, 'PENDING');
  const answer = financialAnswer({ ...report, startStr: '2026-09-08', endStr: '2026-09-09' });
  assert.match(answer, /1,080\.00/);
  assert.match(answer, /0 completed sales/);
});

test('local checkout, server ledger and provider confirmation count once with split cash preserved', () => {
  const report = snapshot({
    serverSales: [{ id: 'server', tenantId: 'tenant', idempotencyKey: 'uuid', status: 'completed', soldAt: date, subtotalMinor: 120000, totalMinor: 120000 }],
    localSales: [{ id: 'local', tenant_id: 'tenant', sale_uuid: 'uuid', status: 'COMPLETED', sold_at: date, grand_total: 1200 }],
    localPayments: [{ id: 'local-payment', sale_id: 'local', amount: 880, method: 'MPESA', reference: 'receipt1' }],
    serverPayments: [{ id: 'remote-payment', tenantId: 'tenant', saleId: 'server', status: 'completed', amountMinor: 88000, method: 'mpesa', reference: 'receipt1', paidAt: date }, { id: 'cash', tenantId: 'tenant', saleId: 'server', method: 'cash', amountMinor: 32000, paidAt: date }],
    attempts: [attempt('receipt1', 88000), attempt('duplicate', 88000, 'paid', { receipt: 'RECEIPT1' })],
  });
  assert.equal(report.count, 1);
  assert.equal(report.paymentCount, 2);
  assert.equal(report.collected, 1200);
  assert.equal(report.cash, 320);
  assert.equal(report.mpesa, 880);
  assert.equal(report.unmatched, 0);
});

test('payments are dated by receipt, including collections for sales from an earlier period', () => {
  const report = snapshot({ serverSales: [{ id: 'old-sale', tenantId: 'tenant', status: 'completed', soldAt: '2026-09-01T10:00:00Z', totalMinor: 10000 }],
    serverPayments: [{ id: 'settlement', tenantId: 'tenant', saleId: 'old-sale', method: 'cash', amountMinor: 10000, paidAt: date }] });
  assert.equal(report.count, 0);
  assert.equal(report.collected, 100);
  assert.equal(report.unmatched, 0);
});

test('date boundaries include the final millisecond and exclude other tenants and unconfirmed states', () => {
  const report = snapshot({ attempts: [attempt('start', 10000, 'paid', { completedAt: new Date(from).toISOString() }), attempt('end', 20000, 'paid', { completedAt: { toMillis: () => to } }), attempt('outside', 30000, 'paid', { completedAt: new Date(to + 1).toISOString() }), attempt('foreign', 999900, 'paid', { tenantId: 'another' }), attempt('review', 9900, 'review')] });
  assert.equal(report.collected, 300);
  assert.equal(report.paymentCount, 2);
  assert.equal(report.pending, 0);
  assert.equal(report.pendingAttempts, 99);
});

test('menu-order payment and provider receipt reconcile without an invoice', () => {
  const report = snapshot({ serverPayments: [{ id: 'web-order', tenantId: 'tenant', customerOrderId: 'order', method: 'mpesa', amountMinor: 55000, reference: 'receipt', paidAt: date }], attempts: [attempt('receipt', 55000, 'paid', { customerOrderId: 'order' })] });
  assert.equal(report.collected, 550);
  assert.equal(report.unmatched, 0);
  assert.equal(report.paymentCount, 1);
});

test('money still on a till is reported as held, never counted as taken', () => {
  // Reversed deliberately. Local rows used to be merged into the totals, so a
  // cashier's screen and the owner's report disagreed about the same money and
  // neither said why. The books are now what the business holds; anything a
  // till is still carrying is disclosed beside them, not added to them.
  const report = snapshot({
    localSales: [{ id: 'local', tenant_id: 'tenant', sold_at: date, status: 'COMPLETED', grand_total: 400, invoice_no: 'INV-BH001-190132' }],
    localPayments: [
      { id: 'credit', sale_id: 'local', method: 'CREDIT', amount: 300 },
      { id: 'cash', sale_id: 'local', method: 'CASH', amount: 100, received_at: date },
    ],
  });

  assert.equal(report.collected, 0, 'nothing local is counted as taken');
  assert.equal(report.cash, 0);
  assert.equal(report.count, 0, 'a sale the server has never seen is not a completed sale');
  // Disclosed rather than hidden, and a receivable is not a settlement.
  assert.equal(report.heldCount, 1);
  assert.equal(report.heldTotal, 100);
  assert.equal(report.heldSaleCount, 1);
  assert.equal(report.heldPayments[0].invoice_no, 'INV-BH001-190132');

  const answer = financialAnswer({ ...report, startStr: '2026-09-08', endStr: '2026-09-09' });
  assert.match(answer, /NOT COUNTED BELOW: 1 settlement\(s\) worth KES 100\.00 are still held on a till/);
});

test('all real unpaid orders are added once without treating an STK attempt as another order', () => {
  const report = snapshot({
    localSales: [{ id: 'credit-sale', tenant_id: 'tenant', sold_at: date, status: 'COMPLETED', grand_total: 400 }],
    localPayments: [{ id: 'credit', sale_id: 'credit-sale', method: 'PROFORMA', amount: 400 }],
    attempts: [attempt('stk-pending', 25000, 'pending', { receipt: null, orderReference: 'ORDER-42' })],
    customerOrders: [
      { id: 'menu-unpaid', tenantId: 'tenant', branchId: 'branch-2', ref: 'WEB-42', customerName: 'Akinyi', totalMinor: 35000, paymentStatus: 'unpaid', status: 'received', createdAt: date },
      { id: 'menu-paid', tenantId: 'tenant', ref: 'WEB-PAID', totalMinor: 90000, paymentStatus: 'paid', status: 'preparing', createdAt: date },
      { id: 'menu-cancelled', tenantId: 'tenant', ref: 'WEB-CANCELLED', totalMinor: 70000, paymentStatus: 'unpaid', status: 'cancelled', createdAt: date },
    ],
  });

  // The proforma is on a till the server has never heard of, so it is not on
  // the books - as a receivable or as anything else. It is disclosed as held
  // instead, which is the same rule that keeps a local settlement out of
  // takings: one source of truth, not two.
  assert.equal(report.receivable, 0);
  assert.equal(report.heldSaleCount, 1);
  assert.equal(report.pending, 350);
  assert.equal(report.pendingCount, 1);
  assert.equal(report.pendingAttempts, 250);
  assert.equal(report.unpaid, 350);
  assert.equal(report.collected, 0);
  assert.equal(report.transactions[0].order_reference, 'ORDER-42');
  assert.equal(report.transactions[0].linked, false);
  assert.deepEqual(report.unpaidOrders.map(order => order.reference), ['WEB-42']);

  const answer = financialAnswer({ ...report, startStr: '2026-09-08', endStr: '2026-09-09' }, 'unpaid');
  assert.match(answer, /Total unpaid: KES 350\.00/);
  assert.match(answer, /1 order/);
});

test('counter settlements are attributed to whoever took the money and married to the order reference', () => {
  const report = snapshot({
    serverPayments: [
      // Every server writer stamps receivedByStaffId, not staffId.
      { id: 'web_order-1', tenantId: 'tenant', customerOrderId: 'order-1', method: 'bank_transfer', amountMinor: 45000, reference: 'FT2609ABC', status: 'completed', paidAt: date, receivedByStaffId: 'akashi', verified: false },
      { id: 'web_order-2', tenantId: 'tenant', customerOrderId: 'order-2', method: 'cash', amountMinor: 15000, status: 'completed', paidAt: date, receivedByStaffId: 'brenda' },
    ],
    customerOrders: [
      { id: 'order-1', tenantId: 'tenant', ref: 'WEB-7781', customerName: 'Otieno', totalMinor: 45000, paymentStatus: 'paid', status: 'completed', createdAt: date, settledByStaffId: 'akashi' },
      { id: 'order-2', tenantId: 'tenant', ref: 'WEB-7782', totalMinor: 15000, paymentStatus: 'paid', status: 'completed', createdAt: date, settledByStaffId: 'brenda' },
    ],
  });

  // A bank transfer is received money and belongs in the total balance.
  assert.equal(report.bank, 450);
  assert.equal(report.other, 0);
  assert.equal(report.cash, 150);
  assert.equal(report.collected, 600);
  assert.equal(report.unmatched, 0);

  const bank = report.transactions.find(row => row.id === 'web_order-1');
  assert.equal(bank.staff_id, 'akashi');
  assert.equal(bank.order_reference, 'WEB-7781');
  assert.equal(bank.customer_name, 'Otieno');
  assert.equal(bank.reference, 'FT2609ABC');
  assert.equal(bank.verified, false);

  const rundown = new Map(report.staffRundown.map(row => [row.staff_id, row]));
  assert.equal(rundown.get('akashi').received, 450);
  assert.equal(rundown.get('akashi').receivedCount, 1);
  assert.equal(rundown.get('brenda').received, 150);
  assert.equal(report.staffRundown[0].staff_id, 'akashi');

  const answer = financialAnswer({ ...report, startStr: '2026-09-08', endStr: '2026-09-09' }, 'staff');
  assert.match(answer, /akashi: received KES 450\.00/);
});

test('every Pay Now settlement path reaches the cards, married to its order', () => {
  // One document per settle path, exactly as each backend callable writes it.
  const report = snapshot({
    serverPayments: [
      // settleCustomerOrderByCode - customer read the code off their SMS
      { id: 'web_o1', tenantId: 'tenant', customerOrderId: 'o1', method: 'mpesa', amountMinor: 100000, reference: 'TGH7X2K9', status: 'completed', paidAt: date, receivedByStaffId: 'akashi', source: 'customer_menu_code' },
      // mpesaCallback after an STK push - no staff field at all on this one
      { id: 'web_o2', tenantId: 'tenant', customerOrderId: 'o2', method: 'mpesa', amountMinor: 200000, reference: 'SGK1122', status: 'completed', paidAt: date, source: 'customer_menu' },
      // settleCustomerOrderBank
      { id: 'web_o3', tenantId: 'tenant', customerOrderId: 'o3', method: 'bank_transfer', amountMinor: 500000, reference: 'FT26091234', status: 'completed', paidAt: date, receivedByStaffId: 'brenda', verified: false, source: 'customer_menu_bank' },
      // settleCustomerOrderCard
      { id: 'web_o4', tenantId: 'tenant', customerOrderId: 'o4', method: 'card', amountMinor: 150000, reference: 'TERM-88', status: 'completed', paidAt: date, receivedByStaffId: 'brenda', source: 'customer_menu' },
      // settleCustomerOrderCash
      { id: 'web_o5', tenantId: 'tenant', customerOrderId: 'o5', method: 'cash', amountMinor: 50000, status: 'completed', paidAt: date, receivedByStaffId: 'akashi', source: 'customer_menu' },
    ],
    customerOrders: [
      { id: 'o1', tenantId: 'tenant', ref: 'WEB-001', totalMinor: 100000, paymentStatus: 'paid', status: 'completed', createdAt: date, settledByStaffId: 'akashi' },
      { id: 'o2', tenantId: 'tenant', ref: 'WEB-002', totalMinor: 200000, paymentStatus: 'paid', status: 'completed', createdAt: date, settledByStaffId: 'akashi' },
      { id: 'o3', tenantId: 'tenant', ref: 'WEB-003', totalMinor: 500000, paymentStatus: 'paid', status: 'completed', createdAt: date, settledByStaffId: 'brenda' },
      { id: 'o4', tenantId: 'tenant', ref: 'WEB-004', totalMinor: 150000, paymentStatus: 'paid', status: 'completed', createdAt: date, settledByStaffId: 'brenda' },
      { id: 'o5', tenantId: 'tenant', ref: 'WEB-005', totalMinor: 50000, paymentStatus: 'paid', status: 'completed', createdAt: date, settledByStaffId: 'akashi' },
    ],
  });

  // The cards at the top of Financials.
  assert.equal(report.mpesa, 3000);
  assert.equal(report.bank, 5000);
  assert.equal(report.other, 1500);
  assert.equal(report.cash, 500);
  assert.equal(report.collected, 10000);
  assert.equal(report.paymentCount, 5);
  // Every one of them is attached to a sale or order, so none is "unmatched".
  assert.equal(report.unmatched, 0);

  // Each row carries the order reference the counter and customer both know.
  const byRef = new Map(report.transactions.map(row => [row.order_reference, row]));
  assert.deepEqual([...byRef.keys()].sort(), ['WEB-001', 'WEB-002', 'WEB-003', 'WEB-004', 'WEB-005']);
  assert.equal(byRef.get('WEB-003').method, 'BANK_TRANSFER');
  assert.equal(byRef.get('WEB-003').reference, 'FT26091234');
  assert.equal(byRef.get('WEB-003').verified, false);
  // The callback payment names no staff, so it inherits the order's settler.
  assert.equal(byRef.get('WEB-002').staff_id, 'akashi');

  const rundown = new Map(report.staffRundown.map(row => [row.staff_id, row]));
  assert.equal(rundown.get('akashi').received, 3500);
  assert.equal(rundown.get('brenda').received, 6500);
});

test('an M-Pesa payment finds its invoice through the sale uuid, and says so when the sale never arrived', () => {
  const report = snapshot({
    // The attempt carries the till's own sale key as its order reference; it
    // never knew the invoice number, which is minted server-side.
    serverSales: [{ id: 'srv-1', tenantId: 'tenant', idempotencyKey: 'mpesa_3dfa5203', status: 'completed', soldAt: date, totalMinor: 35000, invoiceNumber: 'INV-BH001-000042', staffId: 'hadrine' }],
    attempts: [
      attempt('UICDC6CJI8', 35000, 'paid', { orderReference: 'mpesa_3dfa5203', staffId: 'hadrine' }),
      // Money taken on a till whose sale is still queued: real, and orphaned.
      attempt('UICLV696Q7', 10000, 'paid', { orderReference: 'mpesa_065b2c68', staffId: 'hadrine' }),
    ],
  });

  const matched = report.transactions.find(row => row.reference === 'UICDC6CJI8');
  assert.equal(matched.invoice_no, 'INV-BH001-000042');
  assert.equal(matched.order_reference, 'INV-BH001-000042');
  assert.equal(matched.linked, true);
  assert.equal(matched.unsynced, false);

  const orphan = report.transactions.find(row => row.reference === 'UICLV696Q7');
  assert.equal(orphan.invoice_no, undefined);
  assert.equal(orphan.unsynced, false);
  // Still counted as money received - it arrived - but reported as unmatched
  // so it reads as a till holding an unsent sale, not as takings gone astray.
  assert.equal(report.collected, 450);
  assert.equal(report.unmatched, 100);
});

test('a session filter never hides money silently: what it excludes is counted and named', () => {
  // The real case: M-Pesa taken at 04:00 (night session) and a bank transfer
  // settled at 16:54 the same trading day. Asking for Night zeroed the bank
  // tile with nothing on screen saying a filter had done it.
  // Trading day 12 Sep runs 12 Sep 05:00 -> 13 Sep 05:00, so its small hours
  // fall on the 13th by the calendar. Getting this backwards is exactly the
  // confusion the trading day exists to remove.
  const day = (hour, minute = 0) => new Date(2026, 8, 12, hour, minute).toISOString();
  const smallHours = (hour, minute = 0) => new Date(2026, 8, 13, hour, minute).toISOString();
  const span = {
    from: new Date(2026, 8, 12, 5, 0, 0).getTime(),
    to: new Date(2026, 8, 13, 5, 0, 0).getTime() - 1,
  };
  const data = {
    serverPayments: [
      { id: 'bank', tenantId: 'tenant', method: 'bank_transfer', amountMinor: 10000, status: 'completed', paidAt: day(16, 54), reference: '00100', receivedByStaffId: 'clemente' },
    ],
    attempts: [attempt('NIGHTCODE', 60000, 'paid', { completedAt: smallHours(4, 3), staffId: 'wycliffe' })],
  };

  const full = financialSnapshot({ tenantId: 'tenant', ...span, ...data, session: 'full' });
  assert.equal(full.bank, 100);
  assert.equal(full.mpesa, 600);
  assert.equal(full.outsideCount, 0);

  const night = financialSnapshot({ tenantId: 'tenant', ...span, ...data, session: 'night' });
  // The afternoon bank transfer is genuinely outside a night session...
  assert.equal(night.bank, 0);
  assert.equal(night.mpesa, 600);
  // ...but it is reported as excluded rather than simply absent.
  assert.equal(night.outsideCount, 1);
  assert.equal(night.outsideTotal, 100);
  assert.equal(night.session, 'night');

  const answer = financialAnswer({ ...night, startStr: '2026-09-12', endStr: '2026-09-12' });
  assert.match(answer, /NIGHT session only/);
  assert.match(answer, /1 confirmed payment\(s\) worth KES 100\.00 fall outside this window/);

  const morning = financialSnapshot({ tenantId: 'tenant', ...span, ...data, session: 'morning' });
  assert.equal(morning.bank, 100);
  // The 04:00 M-Pesa belongs to the night half of the same trading day.
  assert.equal(morning.mpesa, 0);
  assert.equal(morning.outsideCount, 1);
});

test('a payment recorded only on the till is marked as such, not shown as banked', () => {
  // Clemente settles a bank transfer at the till. The sale is still queued, so
  // nothing about it has reached the server - yet his screen listed the
  // payment exactly like one the business actually holds, while the owner's
  // report showed nothing. The row has to say which it is.
  const report = snapshot({
    localSales: [{ id: 'local-1', tenant_id: 'tenant', sale_uuid: 'uuid-local', sold_at: date, status: 'COMPLETED', grand_total: 100, invoice_no: 'INV-BH001-190132' }],
    localPayments: [{ id: 'local-pay', sale_id: 'local-1', method: 'BANK', amount: 100, reference: '00100', received_at: date, staff_id: 'clemente' }],
  });

  // It is not in the ledger and not in the bank total: the business does not
  // have this money yet. It is listed as held, carrying its till invoice.
  assert.equal(report.transactions.find(entry => entry.id === 'local-pay'), undefined);
  assert.equal(report.bank, 0);
  assert.equal(report.collected, 0);
  assert.equal(report.heldCount, 1);
  assert.equal(report.heldTotal, 100);
  const row = report.heldPayments[0];
  assert.equal(row.localOnly, true);
  assert.equal(row.method, 'BANK');
  assert.equal(row.invoice_no, 'INV-BH001-190132');
  assert.equal(row.staff_id, 'clemente');

  // A payment the server already has is not marked: it is genuinely banked.
  const synced = snapshot({
    serverSales: [{ id: 'srv-1', tenantId: 'tenant', status: 'completed', soldAt: date, totalMinor: 10000, invoiceNumber: 'INV-BH001-000007' }],
    serverPayments: [{ id: 'srv-pay', tenantId: 'tenant', saleId: 'srv-1', method: 'bank_transfer', amountMinor: 10000, status: 'completed', paidAt: date, reference: '00100' }],
  });
  assert.equal(synced.transactions[0].localOnly, undefined);
});

test('a payment names its order even when the sale is still queued on another till', () => {
  // The till sends the attempt's order reference truncated to 40 characters
  // while the sale key it was cut from is 42, so an exact lookup never matched
  // and every M-Pesa till payment read as an internal "mpesa_<uuid>".
  const saleUuid = `mpesa_${'9ca3b261-70b9-4553-af99-6c25fe730abc'}`;
  assert.equal(saleUuid.length, 42, 'the key really is longer than the reference');
  const orderReference = saleUuid.slice(0, 40);

  const report = snapshot({
    attempts: [attempt('UICQ86BKY0', 140000, 'paid', { orderReference, staffId: 'hadrine' })],
    heldOrders: [{
      tenantId: 'tenant', deviceId: 'ipad-3', ref: 'ORD-11-389063',
      saleUuids: [saleUuid], kind: 'sale',
    }],
  });

  const row = report.transactions[0];
  assert.equal(row.order_reference, 'ORD-11-389063', 'the order number the till gave the customer');
  assert.equal(row.held_on_till, true);
  assert.equal(row.linked, true, 'it has an order, so it is not unmatched money');
  assert.equal(report.unmatched, 0);
  // Still real money that arrived, and still not a sale on the books.
  assert.equal(report.collected, 1400);
  assert.equal(report.count, 0);

  // With nothing published, it falls back to saying so rather than to the key.
  const blind = snapshot({ attempts: [attempt('UICQ86BKY0', 140000, 'paid', { orderReference })] });
  assert.equal(blind.transactions[0].held_on_till, false);
  assert.equal(blind.transactions[0].unsynced, false);
});

test("the owner sees a cashier's bank settlement that is still stuck on that cashier's till", () => {
  // Clemente settles KES 100 by bank on his iPad. The sale is queued, so the
  // server has nothing - and the owner's screen, reading only the server and
  // its own device, had nothing to show either. The till publishes the tender
  // with the order it is holding, so the business can at least see it exists.
  const report = snapshot({
    heldOrders: [{
      tenantId: 'tenant', deviceId: 'ipad-clemente', ref: 'INV-BH001-190132', kind: 'sale',
      staffId: 'clemente', openedAt: date, totalMinor: 10000, dueMinor: 0,
      payments: [{ id: 'local-pay', method: 'BANK_TRANSFER', amountMinor: 10000, reference: '00100', staffId: 'clemente', paidAt: date }],
    }],
  });

  assert.equal(report.heldCount, 1);
  assert.equal(report.heldTotal, 100);
  assert.equal(report.heldByMethod.bank, 100);
  const row = report.heldPayments[0];
  assert.equal(row.method, 'BANK_TRANSFER');
  assert.equal(row.reference, '00100');
  assert.equal(row.order_reference, 'INV-BH001-190132');
  assert.equal(row.staff_id, 'clemente');

  // Still not counted as money the business holds - that is the whole point.
  assert.equal(report.bank, 0);
  assert.equal(report.collected, 0);

  const answer = financialAnswer({ ...report, startStr: '2026-09-08', endStr: '2026-09-09' });
  assert.match(answer, /NOT COUNTED BELOW: 1 settlement\(s\) worth KES 100\.00 are still held on a till/);
});

test('an orphaned payment row is not money held on a till', () => {
  // Held means a settlement taken against a sale this till is still holding.
  // A payment whose sale no longer exists - a deleted round, a seeded demo
  // row - is not money on its way to the business, and counting it turned the
  // held figure into a number nobody could account for.
  const report = snapshot({
    localSales: [{ id: 'real', tenant_id: 'tenant', sale_uuid: 'u1', sold_at: date, status: 'COMPLETED', grand_total: 100, invoice_no: 'INV-1' }],
    localPayments: [
      { id: 'good', sale_id: 'real', method: 'BANK', amount: 100, received_at: date },
      { id: 'orphan', sale_id: 'sale-that-is-gone', method: 'CASH', amount: 9999, received_at: date },
    ],
  });
  assert.equal(report.heldCount, 1);
  assert.equal(report.heldTotal, 100);
  assert.equal(report.heldByMethod.cash, undefined, 'the orphan contributes nothing');
});

test('an unpaid tab is not money held on a till', () => {
  // Held is money in hand. An open tab nobody has paid is the opposite of
  // that, and belongs under unpaid orders instead.
  const report = snapshot({
    localSales: [{ id: 'open-round', tenant_id: 'tenant', sale_uuid: 'u2', sold_at: date, status: 'PENDING_PAYMENT', grand_total: 400, invoice_no: 'ORD-1' }],
    localPayments: [{ id: 'owing', sale_id: 'open-round', method: 'CREDIT', amount: 400, received_at: date }],
  });
  assert.equal(report.heldCount, 0);
  assert.equal(report.heldTotal, 0);
});

test('a till publishing the same settlement it already holds locally is counted once', () => {
  const report = snapshot({
    localSales: [{ id: 'local', tenant_id: 'tenant', sale_uuid: 'uuid-1', sold_at: date, status: 'COMPLETED', grand_total: 100, invoice_no: 'INV-BH001-190132' }],
    localPayments: [{ id: 'local-pay', sale_id: 'local', method: 'BANK', amount: 100, received_at: date }],
    // The same row, read back from what this device published moments ago.
    heldOrders: [{
      tenantId: 'tenant', deviceId: 'ipad-clemente', ref: 'INV-BH001-190132', kind: 'sale', openedAt: date,
      payments: [{ id: 'local-pay', method: 'BANK', amountMinor: 10000, reference: '', paidAt: date }],
    }],
  });
  assert.equal(report.heldCount, 1, 'deduped by payment id, not doubled');
  assert.equal(report.heldTotal, 100);
});

test('a payment with no usable date is surfaced rather than silently dropped from the books', () => {
  const report = snapshot({
    serverPayments: [
      { id: 'dated', tenantId: 'tenant', method: 'bank_transfer', amountMinor: 400000, status: 'completed', paidAt: date, reference: 'FT-1' },
      // No paidAt and no createdAt: this used to fail the range test and vanish
      // from every total and every table at once.
      { id: 'undated', tenantId: 'tenant', method: 'bank_transfer', amountMinor: 400000, status: 'completed', reference: 'FT-2' },
    ],
  });

  assert.equal(report.bank, 4000);
  assert.equal(report.undatedCount, 1);
  assert.equal(report.undatedTotal, 4000);
  // Visible in the ledger even though no period can legitimately claim it.
  assert.equal(report.transactions.length, 2);
  assert.equal(report.transactions[0].id, 'undated');
  assert.equal(report.transactions[0].undated, true);

  const answer = financialAnswer({ ...report, startStr: '2026-09-08', endStr: '2026-09-09' });
  assert.match(answer, /1 payment\(s\) worth KES 4,000\.00 carry no usable date/);
  assert.match(answer, /Showing the whole organization/);
});

test('a member of staff sees only their own money; the owner sees the whole organization', () => {
  const data = {
    serverSales: [
      { id: 'sale-a', tenantId: 'tenant', staffId: 'akashi', status: 'completed', soldAt: date, totalMinor: 20000 },
      { id: 'sale-b', tenantId: 'tenant', staffId: 'brenda', status: 'completed', soldAt: date, totalMinor: 30000 },
    ],
    serverPayments: [
      { id: 'pay-a', tenantId: 'tenant', saleId: 'sale-a', method: 'cash', amountMinor: 20000, status: 'completed', paidAt: date },
      { id: 'pay-b', tenantId: 'tenant', saleId: 'sale-b', method: 'cash', amountMinor: 30000, status: 'completed', paidAt: date },
    ],
    customerOrders: [
      { id: 'open', tenantId: 'tenant', ref: 'WEB-OPEN', totalMinor: 10000, paymentStatus: 'unpaid', status: 'preparing', createdAt: date, updatedByStaffId: 'akashi' },
    ],
  };

  const owner = snapshot(data);
  assert.equal(owner.collected, 500);
  assert.equal(owner.count, 2);
  assert.equal(owner.staffRundown.length, 2);
  assert.equal(owner.unpaid, 100);

  // A sale payment carries no staff of its own, so attribution has to reach
  // through to the sale - otherwise scoping would hide a cashier's own takings.
  const akashi = snapshot({ ...data, staffScope: 'akashi' });
  assert.equal(akashi.collected, 200);
  assert.equal(akashi.count, 1);
  assert.equal(akashi.paymentCount, 1);
  assert.equal(akashi.transactions.length, 1);
  assert.equal(akashi.unpaid, 100);
  assert.deepEqual(akashi.staffRundown.map(row => row.staff_id), ['akashi']);
  assert.equal(akashi.staffScope, 'akashi');
});
