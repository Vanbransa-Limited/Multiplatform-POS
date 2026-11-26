const test = require('node:test');
const assert = require('node:assert/strict');
const { attemptBlocks, isVoidable, outstandingMinor, settleSale, settlingStaff, claimSalePayment } = require('../lib/modules/sales/settle');
const { db } = require('../lib/lib/firebase');
const { printedSnapshotData } = require('./fixtures/printed-bill.cjs');

test('only an order nobody has paid for can be voided', () => {
  assert.equal(isVoidable([{ method: 'credit' }]), true);
  assert.equal(isVoidable([{ method: 'credit' }, { method: 'credit' }]), true);
  // Money arrived against it: the correction is a refund, not a void.
  assert.equal(isVoidable([{ method: 'credit', settledAt: 'then' }]), false);
  assert.equal(isVoidable([{ method: 'cash' }]), false);
  assert.equal(isVoidable([{ method: 'credit' }, { method: 'mpesa' }]), false);
  // No rows at all is not a pending order, so it is refused rather than voided.
  assert.equal(isVoidable([]), false);
});

test('what is outstanding is the credit that has not been settled', () => {
  assert.equal(outstandingMinor([]), 0);
  assert.equal(outstandingMinor([{ method: 'cash', amountMinor: 5000 }]), 0);
  assert.equal(outstandingMinor([{ method: 'credit', amountMinor: 5000 }]), 5000);
  // Already settled, so it is history rather than a debt.
  assert.equal(outstandingMinor([{ method: 'credit', amountMinor: 5000, settledAt: 'then' }]), 0);
  assert.equal(outstandingMinor([{ method: 'credit', amountMinor: 5000 }, { method: 'credit', amountMinor: 2500 }]), 7500);
  // Junk is never treated as money owed.
  assert.equal(outstandingMinor([{ method: 'credit', amountMinor: -1 }, { method: 'credit' }]), 0);
});

test('only signed-in selling staff may settle', () => {
  assert.deepEqual(
    settlingStaff({ tenant_id: 't1', staff_id: 's1', staff_role: 'cashier' }),
    { tenantId: 't1', staffId: 's1' },
  );
  for (const token of [undefined, {}, { tenant_id: 't1', staff_id: 's1', staff_role: 'customer' }]) {
    assert.throws(() => settlingStaff(token), /Sign in to settle a sale/);
  }
});

/** In-memory Firestore, matching the substitute the stock tests use. */
function harness(docs) {
  const validWrite = value => {
    assert.notEqual(value, undefined, 'Firestore rejects undefined write fields');
    if (value && typeof value === 'object') for (const item of Object.values(value)) validWrite(item);
  };
  const snapshot = (ref) => ({ id: ref.id, ref, exists: docs.has(ref.path), data: () => printedSnapshotData(docs, ref.path) });
  const original = { collection: db.collection, runTransaction: db.runTransaction };
  db.collection = (name) => ({
    doc: (id = `auto-${docs.size}`) => ({ id, path: `${name}/${id}` }),
    where: (field, op, value) => ({ __where: [name, field, value] }),
  });
  db.runTransaction = async (fn) => {
    const writes = [];
    const result = await fn({
      getAll: async (...refs) => { assert.equal(writes.length, 0, 'Firestore reads must precede writes'); return refs.map(snapshot); },
      get: async (target) => { assert.equal(writes.length, 0, 'Firestore reads must precede writes'); return (target.__where
        ? {
          docs: [...docs]
            .filter(([path, data]) => path.startsWith(`${target.__where[0]}/`) && data[target.__where[1]] === target.__where[2])
            .map(([path]) => snapshot({ id: path.split('/')[1], path })),
        }
        : snapshot(target)); },
      create: (ref, data) => { validWrite(data); writes.push([ref.path, data]); },
      set: (ref, data) => { validWrite(data); writes.push([ref.path, data]); },
      update: (ref, data) => { validWrite(data); writes.push([ref.path, { ...docs.get(ref.path), ...data }]); },
    });
    writes.forEach(([path, data]) => docs.set(path, data));
    return result;
  };
  return () => { db.collection = original.collection; db.runTransaction = original.runTransaction; };
}

const auth = { token: { tenant_id: 't1', staff_id: 's1', staff_role: 'cashier' } };

// The till submits a sale under its own uuid; the server derives the document
// id from it, so settling never needs the till to know the server's id.
const { deterministicId } = require('../lib/shared/identifiers');
const SALE_ID = deterministicId('sale', 't1:uuid-1');

const base = () => new Map([
  [`sales/${SALE_ID}`, { tenantId: 't1', branchId: 'b1', invoiceNumber: 'INV-001', totalMinor: 50000 }],
  [`payments/${SALE_ID}_payment_01`, { tenantId: 't1', saleId: SALE_ID, method: 'credit', amountMinor: 50000 }],
  ['tenant_settings/t1', { acceptedPaymentMethods: ['cash', 'mpesa'] }],
]);

test('a second device cannot claim or settle a bill while another checkout owns it', async () => {
  const docs = base(); const restore = harness(docs);
  const other = { token: { ...auth.token, staff_id: 'other-cashier' } };
  try {
    const claim = { saleUuids: ['uuid-1'], checkoutId: 'checkout-one', expectedMinor: 50000 };
    assert.equal((await claimSalePayment.run({ auth, data: claim })).dueMinor, 50000);
    assert.equal((await claimSalePayment.run({ auth, data: claim })).dueMinor, 50000);
    await assert.rejects(claimSalePayment.run({ auth: other, data: { ...claim, checkoutId: 'checkout-two' } }), /Another device/);
    await assert.rejects(settleSale.run({ auth: other, data: { saleUuid: 'uuid-1', requestId: 'other-payment', method: 'cash' } }), /Another device/);
    const result = await settleSale.run({ auth, data: { saleUuid: 'uuid-1', requestId: 'first-payment', checkoutId: 'checkout-one', method: 'cash' } });
    assert.equal(result.settledMinor, 50000);
    await assert.rejects(claimSalePayment.run({ auth: other, data: { ...claim, checkoutId: 'checkout-two' } }), /already been paid/);
    assert.equal([...docs.values()].filter(row => row.source === 'sale_settlement').length, 1);
  } finally { restore(); }
});

test('changed totals and foreign or missing rounds cannot reserve a partial checkout', async () => {
  for (const patch of [ { expectedMinor: 49900 }, { saleUuids: ['uuid-1', 'missing'] } ]) {
    const docs = base(); const restore = harness(docs);
    try {
      await assert.rejects(claimSalePayment.run({ auth, data: { saleUuids: ['uuid-1'], checkoutId: 'checkout', ...patch } }));
      assert.equal(docs.get(`sales/${SALE_ID}`).checkoutId, undefined);
    } finally { restore(); }
  }
});

test('an unresolved STK blocks a new checkout even after the device reservation expires', async () => {
  const docs = base(); const restore = harness(docs);
  try {
    await claimSalePayment.run({ auth, data: { saleUuids: ['uuid-1'], checkoutId: 'first', stkKey: 'original-stk-key' } });
    docs.get(`sales/${SALE_ID}`).checkoutExpiresAt = { toMillis: () => 0 };
    docs.set(`mpesa_payments/${deterministicId('mpesa-attempt', 't1:original-stk-key')}`, { tenantId: 't1', status: 'ambiguous' });
    await assert.rejects(claimSalePayment.run({ auth, data: { saleUuids: ['uuid-1'], checkoutId: 'another', stkKey: 'second-stk-key' } }), /M-Pesa payment/);
    await assert.rejects(settleSale.run({ auth, data: { saleUuid: 'uuid-1', requestId: 'cash-after-timeout', method: 'cash' } }), /unconfirmed/);
    // The customer's typed code still closes it.
    await assert.doesNotReject(claimSalePayment.run({ auth, data: { saleUuids: ['uuid-1'], checkoutId: 'typed-code' } }));
  } finally { restore(); }
});

function confirmedAttempt(docs, amountMinor = 50000) {
  docs.set('mpesa_payments/stk1', { tenantId: 't1', branchId: 'b1', status: 'paid', receipt: 'TESTCODE01', amountMinor });
  docs.set(`payment_intents/${deterministicId('intent', 't1:TESTCODE01')}`, { tenantId: 't1', attemptId: 'stk1', status: 'verified', amountMinor });
}

test('a server-pending order settles by confirmed STK without recreating the sale or deducting stock again', async () => {
  const docs = base(); confirmedAttempt(docs);
  docs.set('stock_balances/balance1', { tenantId: 't1', qty: 9 });
  const restore = harness(docs);
  try {
    const input = { saleUuid: 'uuid-1', requestId: 'stk-settle-1', method: 'mpesa', attemptId: 'stk1' };
    const result = await settleSale.run({ auth, data: input });
    assert.equal(result.verified, true);
    assert.equal(docs.get(`payments/${result.paymentId}`).amountMinor, 50000);
    assert.equal(docs.get('stock_balances/balance1').qty, 9);
    assert.equal([...docs.keys()].filter(path => path.startsWith('sales/')).length, 1);
    const intent = docs.get(`payment_intents/${deterministicId('intent', 't1:TESTCODE01')}`);
    assert.equal(intent.status, 'consumed');
    assert.equal(intent.consumedSaleId, SALE_ID);
    assert.deepEqual(await settleSale.run({ auth, data: input }), result);
  } finally { restore(); }
});

test('an STK receipt consumed by a new sale cannot also clear Pending', async () => {
  const docs = base(); confirmedAttempt(docs);
  docs.get(`payment_intents/${deterministicId('intent', 't1:TESTCODE01')}`).consumedSaleId = 'another-sale';
  const restore = harness(docs);
  try {
    await assert.rejects(settleSale.run({ auth, data: { saleUuid: 'uuid-1', requestId: 'r1', method: 'mpesa', attemptId: 'stk1' } }), /already used/);
    assert.equal(docs.get(`payments/${SALE_ID}_payment_01`).settledAt, undefined);
  } finally { restore(); }
});

test('one confirmed STK can clear two rounds only within the received total', async () => {
  const docs = base(); confirmedAttempt(docs, 70000);
  const second = deterministicId('sale', 't1:uuid-2');
  docs.set(`sales/${second}`, { tenantId: 't1', branchId: 'b1', totalMinor: 20000 });
  docs.set(`payments/${second}_payment_01`, { tenantId: 't1', saleId: second, method: 'credit', amountMinor: 20000 });
  const restore = harness(docs);
  try {
    await settleSale.run({ auth, data: { saleUuid: 'uuid-1', requestId: 'r1', method: 'mpesa', attemptId: 'stk1' } });
    await settleSale.run({ auth, data: { saleUuid: 'uuid-2', requestId: 'r2', method: 'mpesa', attemptId: 'stk1' } });
    assert.equal(docs.get('mpesa_payments/stk1').settledMinor, 70000);
  } finally { restore(); }
});

test('late STK recovery from another device replays the same payment and never records a second one', async () => {
  const docs = base(); confirmedAttempt(docs);
  const restore = harness(docs);
  const manager = { token: { tenant_id: 't1', staff_id: 'manager', staff_role: 'manager' } };
  try {
    // The request id recovery derives from the attempt and the bill.
    const input = { saleUuid: 'uuid-1', requestId: 'stk1-uuid-1', method: 'mpesa', attemptId: 'stk1' };
    const first = await settleSale.run({ auth, data: input });
    assert.deepEqual(await settleSale.run({ auth: manager, data: input }), first);
    // An older till retrying under its own request id is refused, not paid twice.
    await assert.rejects(settleSale.run({ auth, data: { ...input, requestId: 'old-format-0' } }), /Nothing is outstanding/);
    assert.equal([...docs.values()].filter(row => row.source === 'sale_settlement').length, 1);
    assert.deepEqual(docs.get('mpesa_payments/stk1').settledSaleIds, [SALE_ID]);
  } finally { restore(); }
});

test('a prompt confirmed after the checkout reservation expired still settles against its own attempt', async () => {
  const docs = base();
  const attemptId = deterministicId('mpesa-attempt', 't1:late-key');
  docs.set(`mpesa_payments/${attemptId}`, { tenantId: 't1', branchId: 'b1', status: 'paid', receipt: 'LATECODE01', amountMinor: 50000, settlementSaleIds: [SALE_ID] });
  docs.set(`payment_intents/${deterministicId('intent', 't1:LATECODE01')}`, { tenantId: 't1', attemptId, status: 'verified', amountMinor: 50000 });
  Object.assign(docs.get(`sales/${SALE_ID}`), { checkoutId: 'closed-dialog', checkoutStaffId: 's1', checkoutStkKey: 'late-key', checkoutExpiresAt: { toMillis: () => 1 } });
  const restore = harness(docs);
  try {
    const result = await settleSale.run({ auth, data: { saleUuid: 'uuid-1', requestId: `${attemptId}-uuid-1`, checkoutId: 'closed-dialog', method: 'mpesa', attemptId } });
    assert.equal(result.settledMinor, 50000);
    assert.equal(result.reference, 'LATECODE01');
    assert.equal(result.verified, true);
  } finally { restore(); }
});

test('an attempt M-Pesa has not verified cannot settle a bill', async () => {
  for (const status of ['verification_pending', 'pending', 'ambiguous']) {
    const docs = base(); confirmedAttempt(docs);
    docs.get('mpesa_payments/stk1').status = status;
    const restore = harness(docs);
    try {
      await assert.rejects(settleSale.run({ auth, data: { saleUuid: 'uuid-1', requestId: 'stk1-uuid-1', method: 'mpesa', attemptId: 'stk1' } }), /has not confirmed/);
      assert.equal(docs.get(`payments/${SALE_ID}_payment_01`).settledAt, undefined);
      assert.equal([...docs.values()].filter(row => row.source === 'sale_settlement').length, 0);
    } finally { restore(); }
  }
});

test('a confirmed receipt pays different checkouts only up to its real balance', async () => {
  const docs = base(), second = deterministicId('sale', 't1:uuid-2');
  docs.set(`sales/${second}`, { tenantId: 't1', branchId: 'b1', totalMinor: 120000 });
  docs.set('payments/second-credit', { tenantId: 't1', saleId: second, method: 'credit', amountMinor: 120000 });
  docs.set(`mpesa_c2b_events/${deterministicId('c2b', 'confirmation:UKL6537WE3')}`, { tenantId: 't1', payload: { amountMinor: 170000 } });
  const restore = harness(docs);
  try {
    const first = await settleSale.run({ auth, data: { saleUuid: 'uuid-1', requestId: 'first', method: 'mpesa', reference: 'UKL6537WE3' } });
    assert.equal(first.availableMinor, 120000);
    const secondPayment = await settleSale.run({ auth, data: { saleUuid: 'uuid-2', requestId: 'second', method: 'mpesa', reference: 'UKL6537WE3' } });
    assert.equal(secondPayment.settledMinor, 120000);
    assert.equal(secondPayment.availableMinor, 0);
    assert.equal(outstandingMinor([docs.get('payments/second-credit')]), 0);
    assert.equal([...docs.values()].filter(row => row.source === 'sale_settlement').reduce((sum, row) => sum + row.amountMinor, 0), 170000);
  } finally { restore(); }
});

test('a proforma settles in cash, and the receivable stops being outstanding', async () => {
  const docs = base();
  const restore = harness(docs);
  try {
    const result = await settleSale.run({ auth, data: { saleUuid: 'uuid-1', requestId: 'r1', method: 'cash' } });
    assert.equal(result.settledMinor, 50000);
    // Cash is a member of staff saying money arrived, not the provider.
    assert.equal(result.verified, false);

    const credit = docs.get(`payments/${SALE_ID}_payment_01`);
    assert.ok(credit.settledAt, 'the credit row is stamped settled');
    assert.equal(credit.settledMethod, 'cash');
    // The sale still went out on credit; that fact is kept, not erased.
    assert.equal(credit.method, 'credit');
    assert.equal(outstandingMinor([credit]), 0);

    const settlement = [...docs].find(([path, row]) => path.startsWith('payments/') && row.source === 'sale_settlement')[1];
    assert.equal(settlement.amountMinor, 50000);
    assert.equal(settlement.method, 'cash');

    await assert.rejects(
      settleSale.run({ auth, data: { saleUuid: 'uuid-1', requestId: 'r2', method: 'cash' } }),
      /Nothing is outstanding/,
    );
  } finally { restore(); }
});

test('cash settlement is unavailable to a cashless organization', async () => {
  const docs = base();
  docs.set('tenant_settings/t1', { acceptedPaymentMethods: ['mpesa'] });
  const restore = harness(docs);
  try {
    await assert.rejects(
      settleSale.run({ auth, data: { saleUuid: 'uuid-1', requestId: 'r1', method: 'cash' } }),
      /does not accept cash/,
    );
  } finally { restore(); }
});

test('a bank reference is taken on trust as typed, and an unknown method is refused', async () => {
  const docs = base();
  const restore = harness(docs);
  try {
    await assert.rejects(settleSale.run({ auth, data: { saleUuid: 'uuid-1', requestId: 'r1', method: 'barter' } }), /how the money arrived/);
    // Nothing verifies a bank reference, so an odd one settles as typed.
    const odd = await settleSale.run({ auth, data: { saleUuid: 'uuid-1', requestId: 'r1', method: 'bank_transfer', reference: 'not a real ref' } });
    assert.equal(odd.reference, 'not a real ref');
    assert.equal(odd.verified, false);
  } finally { restore(); }

  // And a blank one settles too - the receivable is cleared either way.
  const fresh = base();
  const restoreFresh = harness(fresh);
  try {
    const blank = await settleSale.run({ auth, data: { saleUuid: 'uuid-1', requestId: 'r1', method: 'bank_transfer' } });
    assert.equal(blank.reference, null);
  } finally { restoreFresh(); }
});

test('unknown, quarantined and foreign codes cannot settle any of the debt', async () => {
  const code = 'QGH4T21XZ9';
  for (const event of [null, { tenantId: 'other', payload: { amountMinor: 50000 } },
    { tenantId: 't1', disposition: 'quarantined', payload: { amountMinor: 50000 } }]) {
    const docs = base();
    if (event) docs.set(`mpesa_c2b_events/${deterministicId('c2b', `confirmation:${code}`)}`, event);
    const restore = harness(docs);
    try {
      await assert.rejects(settleSale.run({ auth, data: { saleUuid: 'uuid-1', requestId: 'r1', method: 'mpesa', reference: code } }), /No confirmed M-Pesa/);
      assert.equal(outstandingMinor([docs.get(`payments/${SALE_ID}_payment_01`)]), 50000);
      assert.equal([...docs.values()].filter(row => row.source === 'sale_settlement').length, 0);
    } finally { restore(); }
  }
});

test('400 and 600 receipts clear a 1000 bill in parts; retries never apply twice', async () => {
  const docs = base();
  docs.get(`payments/${SALE_ID}_payment_01`).amountMinor = 100000;
  for (const [code, amountMinor] of [['CODE400ABC', 40000], ['CODE600ABC', 60000]]) {
    docs.set(`mpesa_c2b_events/${deterministicId('c2b', `confirmation:${code}`)}`, { tenantId: 't1', payload: { amountMinor } });
  }
  const restore = harness(docs);
  try {
    const input = { saleUuid: 'uuid-1', requestId: 'first', method: 'mpesa', reference: 'CODE400ABC' };
    const first = await settleSale.run({ auth, data: input });
    assert.equal(first.settledMinor, 40000);
    assert.equal(first.outstandingMinor, 60000);
    assert.equal(outstandingMinor([docs.get(`payments/${SALE_ID}_payment_01`)]), 60000);
    assert.equal(docs.get(`payments/${SALE_ID}_payment_01`).originalAmountMinor, 100000);
    assert.deepEqual(await settleSale.run({ auth, data: input }), first);
    const second = await settleSale.run({ auth, data: { ...input, requestId: 'second', reference: 'CODE600ABC' } });
    assert.equal(second.outstandingMinor, 0);
    assert.equal(outstandingMinor([docs.get(`payments/${SALE_ID}_payment_01`)]), 0);
    assert.equal([...docs.values()].filter(row => row.source === 'sale_settlement').length, 2);
  } finally { restore(); }
});

test('typing an STK receipt consumes its confirmed proof and keeps the original receipt date', async () => {
  const docs = base(); confirmedAttempt(docs);
  const paidAt = { toMillis: () => 1000 };
  docs.get('mpesa_payments/stk1').completedAt = paidAt;
  const restore = harness(docs);
  try {
    const result = await settleSale.run({ auth, data: { saleUuid: 'uuid-1', requestId: 'sms-stk', method: 'mpesa', reference: 'testcode01' } });
    assert.equal(result.verified, true);
    assert.equal(docs.get(`payment_intents/${deterministicId('intent', 't1:TESTCODE01')}`).status, 'consumed');
    assert.equal(docs.get('mpesa_payments/stk1').settledSaleId, SALE_ID);
    const payment = [...docs.values()].find(row => row.source === 'sale_settlement');
    assert.equal(payment.paidAt, paidAt);
  } finally { restore(); }
});

test('legacy unverified receipt rows cannot manufacture a reusable balance', async () => {
  const docs = base();
  docs.set('payments/legacy', { tenantId: 't1', saleId: 'other', method: 'mpesa', reference: 'LEGACYCODE', amountMinor: 50000, status: 'completed' });
  const restore = harness(docs);
  try {
    await assert.rejects(settleSale.run({ auth, data: { saleUuid: 'uuid-1', requestId: 'second', method: 'mpesa', reference: 'LEGACYCODE' } }), /No confirmed M-Pesa/);
  } finally { restore(); }
});

test('a confirmed failed STK can retry from the same staff/device, while a non-M-Pesa claim preserves an unresolved prompt', async () => {
  const docs = base();
  docs.set('devices/d1', { tenantId: 't1', branchId: 'b1', status: 'active' });
  const restore = harness(docs);
  try {
    await claimSalePayment.run({ auth, data: { saleUuids: ['uuid-1'], checkoutId: 'first', stkKey: 'old-key', deviceId: 'd1', method: 'stk' } });
    const attemptId = deterministicId('mpesa-attempt', 't1:old-key');
    docs.set(`mpesa_payments/${attemptId}`, { tenantId: 't1', status: 'ambiguous' });
    await assert.rejects(claimSalePayment.run({ auth, data: { saleUuids: ['uuid-1'], checkoutId: 'first', deviceId: 'd1', method: 'cash' } }), /unconfirmed/);
    await claimSalePayment.run({ auth, data: { saleUuids: ['uuid-1'], checkoutId: 'first', deviceId: 'd1', method: 'mpesa' } });
    assert.equal(docs.get(`sales/${SALE_ID}`).checkoutStkKey, 'old-key');
    docs.get(`mpesa_payments/${attemptId}`).status = 'failed';
    await claimSalePayment.run({ auth, data: { saleUuids: ['uuid-1'], checkoutId: 'reopened', stkKey: 'new-key', deviceId: 'd1', method: 'stk' } });
    assert.equal(docs.get(`sales/${SALE_ID}`).checkoutStkKey, 'new-key');
  } finally { restore(); }
});

test('a retry after a lost response returns the first settlement, not a second one', async () => {
  const docs = base();
  const restore = harness(docs);
  try {
    const first = await settleSale.run({ auth, data: { saleUuid: 'uuid-1', requestId: 'r1', method: 'cash' } });
    const retry = await settleSale.run({ auth, data: { saleUuid: 'uuid-1', requestId: 'r1', method: 'cash' } });
    assert.deepEqual(retry, first);
    const settlements = [...docs].filter(([, row]) => row.source === 'sale_settlement');
    assert.equal(settlements.length, 1);
  } finally { restore(); }
});

test('another tenant cannot settle this sale', async () => {
  const docs = base();
  const restore = harness(docs);
  try {
    await assert.rejects(
      settleSale.run({
        auth: { token: { tenant_id: 't2', staff_id: 's9', staff_role: 'owner' } },
        data: { saleUuid: 'uuid-1', requestId: 'r1', method: 'cash' },
      }),
      /Sale not found/,
    );
  } finally { restore(); }
});

test('a stuck M-Pesa attempt no longer locks the order', () => {
  const now = 10 * 60_000;
  const at = (ms) => ({ toMillis: () => ms });
  const unverified = { status: 'verification_pending', requestedAt: at(0) };
  // The customer's typed code always goes through; the receipt is consumed once.
  assert.equal(attemptBlocks(unverified, 'mpesa', now), null);
  assert.equal(attemptBlocks({ status: 'paid' }, 'mpesa', now), null);
  // A second prompt is refused while the first may have been paid.
  assert.match(attemptBlocks(unverified, 'stk', now), /unconfirmed/);
  assert.match(attemptBlocks(unverified, 'other', now), /unconfirmed/);
  assert.match(attemptBlocks({ status: 'ambiguous', requestedAt: at(0) }, 'stk', now), /unconfirmed/);
  assert.match(attemptBlocks({ status: 'paid' }, 'stk', now), /already confirmed/);
  assert.match(attemptBlocks({ status: 'paid' }, 'other', now), /already confirmed/);
  // A live prompt blocks a new one; an expired or failed one does not.
  assert.match(attemptBlocks({ status: 'pending', requestedAt: at(now - 60_000) }, 'stk', now), /still open/);
  assert.equal(attemptBlocks({ status: 'pending', requestedAt: at(0) }, 'stk', now), null);
  assert.equal(attemptBlocks({ status: 'failed' }, 'stk', now), null);
  assert.equal(attemptBlocks({ status: 'pending', requestedAt: at(0) }, 'other', now), null);
});

test('lookup shows provider amount less legacy use, and settlement rechecks changed headroom', async () => {
  const { lookupMpesaReceipt } = require('../lib/modules/sales/receipt-balance');
  const docs = base();
  const eventPath = `mpesa_c2b_events/${deterministicId('c2b', 'confirmation:UKL6537WE3')}`;
  docs.set(eventPath, { tenantId: 't1', branchIds: ['b1'], payload: { amountMinor: 170000 } });
  docs.set('payments/legacy', { tenantId: 't1', saleId: 'other', method: 'mpesa', reference: 'UKL6537WE3', amountMinor: 50000, status: 'completed' });
  const restore = harness(docs);
  try {
    assert.deepEqual(await lookupMpesaReceipt.run({ auth, data: { reference: 'ukl6537we3', branchId: 'b1' } }), {
      reference: 'UKL6537WE3', receivedMinor: 170000, allocatedMinor: 50000, availableMinor: 120000, verified: true });
    docs.get('payments/legacy').amountMinor = 160000;
    await assert.rejects(settleSale.run({ auth, data: { saleUuid: 'uuid-1', requestId: 'stale', method: 'mpesa', reference: 'UKL6537WE3', amountMinor: 50000 } }), /balance or bill amount changed/);
    assert.equal(docs.get(`payments/${SALE_ID}_payment_01`).settledAt, undefined);
    await assert.rejects(lookupMpesaReceipt.run({ auth, data: { reference: 'UKL6537WE3', branchId: 'other' } }), /another branch/);
    await assert.rejects(lookupMpesaReceipt.run({ data: { reference: 'UKL6537WE3', branchId: 'b1' } }), /Sign in/);
  } finally { restore(); }
});

test('receipt previews use a read-only snapshot so they cannot lock a payment allocation', async () => {
  const { lookupMpesaReceipt } = require('../lib/modules/sales/receipt-balance');
  const docs = base();
  docs.set(`mpesa_c2b_events/${deterministicId('c2b', 'confirmation:UKL6537WE3')}`, { tenantId: 't1', payload: { amountMinor: 170000 } });
  const restore = harness(docs), run = db.runTransaction;
  let captured;
  db.runTransaction = (fn, options) => { captured = options; return run(fn); };
  try {
    const result = await lookupMpesaReceipt.run({ auth, data: { reference: 'UKL6537WE3', branchId: 'b1' } });
    assert.equal(result.availableMinor, 170000);
    assert.deepEqual(captured, { readOnly: true });
    assert.equal([...docs.values()].filter(row => row.source === 'sale_settlement').length, 0);
  } finally { restore(); }
});

function enableInternalReceipts(docs) {
  docs.set('mpesa_receipt_controls/t1', { tenantId: 't1', mode: 'internal', branchIds: ['b1'],
    until: { toMillis: () => Date.now() + 60000 } });
}

test('temporary internal entry previews a new receipt without spending or registering it', async () => {
  const { lookupMpesaReceipt } = require('../lib/modules/sales/receipt-balance');
  const docs = base(); enableInternalReceipts(docs); const restore = harness(docs);
  try {
    await assert.rejects(lookupMpesaReceipt.run({ auth, data: { reference: 'UKL0B2RHOX', branchId: 'b1' } }), /Enter the amount on the M-Pesa receipt/);
    const result = await lookupMpesaReceipt.run({ auth, data: { reference: 'UKL0B2RHOX', branchId: 'b1', receiptAmountMinor: 95000 } });
    assert.deepEqual(result, { reference: 'UKL0B2RHOX', receivedMinor: 95000, allocatedMinor: 0, availableMinor: 95000,
      verified: false, internalOnly: true, registerOnPayment: true });
    assert.equal([...docs.keys()].filter(path => path.startsWith('payment_receipt_claims/')).length, 0);
    assert.equal(docs.get(`payments/${SALE_ID}_payment_01`).settledAt, undefined);
  } finally { restore(); }
});

test('internal receipt amount is fixed once, shared across bills and never over-allocated', async () => {
  const docs = base(); enableInternalReceipts(docs);
  const second = deterministicId('sale', 't1:uuid-2');
  docs.set(`sales/${second}`, { tenantId: 't1', branchId: 'b1', totalMinor: 45000 });
  docs.set('payments/second-credit', { tenantId: 't1', saleId: second, method: 'credit', amountMinor: 45000 });
  const restore = harness(docs);
  try {
    const input = { saleUuid: 'uuid-1', requestId: 'manual-first', method: 'mpesa', reference: 'UKL0B2RHOX', receiptAmountMinor: 95000 };
    const first = await settleSale.run({ auth, data: input });
    assert.equal(first.verified, false); assert.equal(first.availableMinor, 45000);
    await assert.rejects(settleSale.run({ auth, data: { ...input, saleUuid: 'uuid-2', requestId: 'inflate', receiptAmountMinor: 170000 } }), /cannot be changed/);
    const last = await settleSale.run({ auth, data: { ...input, saleUuid: 'uuid-2', requestId: 'manual-second' } });
    assert.equal(last.availableMinor, 0); assert.equal(last.verified, false);
    const claim = docs.get(`payment_receipt_claims/${deterministicId('mpesa-receipt', 't1:UKL0B2RHOX')}`);
    assert.equal(claim.allocatedMinor, 95000); assert.equal(claim.limitMinor, 95000);
    assert.equal(claim.amountSource, 'staff_recorded_receipt'); assert.equal(claim.recordedByStaffId, 's1');
    assert.deepEqual(await settleSale.run({ auth, data: input }), first);
    assert.equal([...docs.values()].filter(row => row.source === 'sale_settlement').length, 2);
  } finally { restore(); }
});

test('existing M-Pesa ledger codes without claims are used up, never treated as new money', async () => {
  const { lookupMpesaReceipt } = require('../lib/modules/sales/receipt-balance');
  const docs = base(); enableInternalReceipts(docs);
  docs.set('payments/old', { tenantId: 't1', saleId: 'old-sale', method: 'mpesa', reference: 'OLDRECEIPT', amountMinor: 50000, status: 'completed' });
  const restore = harness(docs);
  try {
    await assert.rejects(lookupMpesaReceipt.run({ auth, data: { reference: 'OLDRECEIPT', branchId: 'b1', receiptAmountMinor: 170000 } }), /original receipt amount/);
    const result = await lookupMpesaReceipt.run({ auth, data: { reference: 'OLDRECEIPT', branchId: 'b1' } });
    assert.equal(result.receivedMinor, 50000); assert.equal(result.allocatedMinor, 50000); assert.equal(result.availableMinor, 0);
    await assert.rejects(settleSale.run({ auth, data: { saleUuid: 'uuid-1', requestId: 'reuse', method: 'mpesa', reference: 'OLDRECEIPT', receiptAmountMinor: 50000 } }), /no unallocated money/);
    assert.equal(docs.get(`payments/${SALE_ID}_payment_01`).settledAt, undefined);
  } finally { restore(); }
});

test('paid prompts in the M-Pesa tab cannot be reintroduced as a new internal receipt', async () => {
  const docs = base(); enableInternalReceipts(docs);
  docs.set('mpesa_payments/legacy', { tenantId: 't1', status: 'paid', receipt: 'OLDRECEIPT', amountMinor: 50000 });
  const restore = harness(docs);
  try {
    await assert.rejects(settleSale.run({ auth, data: { saleUuid: 'uuid-1', requestId: 'reuse', method: 'mpesa', reference: 'OLDRECEIPT', receiptAmountMinor: 50000 } }), /already has a payment record/);
  } finally { restore(); }
});

test('expired or wrong-branch internal entry cannot register a new reference', async () => {
  const { lookupMpesaReceipt } = require('../lib/modules/sales/receipt-balance');
  for (const patch of [{ until: { toMillis: () => 1 } }, { branchIds: ['other'] }, { tenantId: 'other' }]) {
    const docs = base(); enableInternalReceipts(docs); Object.assign(docs.get('mpesa_receipt_controls/t1'), patch);
    const restore = harness(docs);
    try {
      await assert.rejects(lookupMpesaReceipt.run({ auth, data: { reference: 'UKL0B2RHOX', branchId: 'b1', receiptAmountMinor: 95000 } }), /No confirmed/);
      await assert.rejects(settleSale.run({ auth, data: { saleUuid: 'uuid-1', requestId: 'late', method: 'mpesa', reference: 'UKL0B2RHOX', receiptAmountMinor: 95000 } }), /No confirmed/);
      assert.equal(docs.get(`payments/${SALE_ID}_payment_01`).settledAt, undefined);
    } finally { restore(); }
  }
});

test('ongoing receipt entry is explicit, audited, branch-scoped and independent of the calendar', () => {
  const { internalReceiptEntryEnabled: enabled } = require('../lib/modules/sales/receipt-balance');
  const control = { tenantId: 't1', mode: 'internal', branchIds: ['b1'], duration: 'ongoing',
    policyVersion: 1, until: null, authorizationId: 'owner-authorized-policy' };
  assert.equal(enabled(control, 't1', 'b1', Date.UTC(2050, 0, 1)), true);
  for (const patch of [{ mode: 'provider' }, { tenantId: 'other' }, { branchIds: ['other'] },
    { policyVersion: 2 }, { duration: undefined }, { duration: 'unknown' }, { authorizationId: '' },
    { authorizationId: undefined }, { until: undefined }, { until: { toMillis: () => Date.now() + 60000 } }]) {
    assert.equal(enabled({ ...control, ...patch }, 't1', 'b1'), false);
  }
  assert.equal(enabled(undefined, 't1', 'b1'), false);
});

test('switching to provider-only stops new references while preserving registered balances and provenance', async () => {
  const { lookupMpesaReceipt } = require('../lib/modules/sales/receipt-balance');
  const docs = base();
  docs.set('mpesa_receipt_controls/t1', { tenantId: 't1', mode: 'internal', branchIds: ['b1'],
    duration: 'ongoing', policyVersion: 1, until: null, authorizationId: 'durable-policy' });
  const restore = harness(docs);
  try {
    const input = { saleUuid: 'uuid-1', requestId: 'part-one', method: 'mpesa', reference: 'ONGOING001',
      receiptAmountMinor: 95000, amountMinor: 20000 };
    await settleSale.run({ auth, data: input });
    docs.get('mpesa_receipt_controls/t1').mode = 'provider';
    await assert.rejects(lookupMpesaReceipt.run({ auth, data: { reference: 'NEWCODE001', branchId: 'b1', receiptAmountMinor: 10000 } }), /No confirmed/);
    const remaining = await lookupMpesaReceipt.run({ auth, data: { reference: input.reference, branchId: 'b1' } });
    assert.equal(remaining.availableMinor, 75000); assert.equal(remaining.verified, false);
    await settleSale.run({ auth, data: { ...input, requestId: 'part-two', amountMinor: 30000 } });
    const claim = docs.get(`payment_receipt_claims/${deterministicId('mpesa-receipt', 't1:ONGOING001')}`);
    assert.equal(claim.entryAuthorizationId, 'durable-policy'); assert.equal(claim.entryPolicyUntil, null);
    assert.equal(claim.allocatedMinor, 50000); assert.equal(claim.limitMinor, 95000);
    assert.equal(claim.recordedByStaffId, 's1');
    const audit = [...docs.values()].find(row => row.action === 'sale.settled');
    assert.equal(audit.metadata.verified, false); assert.ok(audit.metadata.paymentId);
  } finally { restore(); }
});

test('new internal receipt amounts reject zero, negatives, fractions, strings and unsafe totals without writes', async () => {
  const docs = base(); enableInternalReceipts(docs); const restore = harness(docs);
  try {
    for (const receiptAmountMinor of [0, -1, 1.5, '95000', null, NaN, Infinity, 1000000000001, Number.MAX_SAFE_INTEGER]) {
      await assert.rejects(settleSale.run({ auth, data: { saleUuid: 'uuid-1', requestId: 'invalid', method: 'mpesa',
        reference: 'NEWCODE001', receiptAmountMinor } }), /positive safe integer/);
    }
    assert.equal([...docs.keys()].filter(path => path.startsWith('payment_receipt_claims/')).length, 0);
    assert.equal(docs.get(`payments/${SALE_ID}_payment_01`).settledAt, undefined);
  } finally { restore(); }
});

test('late provider proof respects previous internal allocations and refuses an inconsistent received total', async () => {
  const { lookupMpesaReceipt } = require('../lib/modules/sales/receipt-balance');
  const docs = base(); enableInternalReceipts(docs); const restore = harness(docs);
  try {
    await settleSale.run({ auth, data: { saleUuid: 'uuid-1', requestId: 'first-internal', method: 'mpesa',
      reference: 'LATECODE01', receiptAmountMinor: 95000 } });
    const event = { tenantId: 't1', branchIds: ['b1'], payload: { amountMinor: 95000 } };
    docs.set(`mpesa_c2b_events/${deterministicId('c2b', 'confirmation:LATECODE01')}`, event);
    const receipt = await lookupMpesaReceipt.run({ auth, data: { reference: 'LATECODE01', branchId: 'b1' } });
    assert.equal(receipt.availableMinor, 45000); assert.equal(receipt.verified, true);
    event.payload.amountMinor = 49000;
    await assert.rejects(lookupMpesaReceipt.run({ auth, data: { reference: 'LATECODE01', branchId: 'b1' } }), /inconsistent allocations/);
    assert.equal([...docs.values()].filter(row => row.source === 'sale_settlement').length, 1);
  } finally { restore(); }
});

test('recorded-only checkout rejects unknown codes even when a cashier supplies a receipt amount', async () => {
  const { lookupMpesaReceipt } = require('../lib/modules/sales/receipt-balance');
  const docs = base(); enableInternalReceipts(docs);
  docs.get('mpesa_receipt_controls/t1').entryMode = 'recorded_only';
  const restore = harness(docs);
  try {
    for (const receiptAmountMinor of [undefined, 95000, 170000]) {
      await assert.rejects(lookupMpesaReceipt.run({ auth, data: { reference: 'NEWCODE001', branchId: 'b1', receiptAmountMinor } }), /No saved M-Pesa payment/);
      await assert.rejects(settleSale.run({ auth, data: { saleUuid: 'uuid-1', requestId: 'no-creation', method: 'mpesa',
        reference: 'NEWCODE001', receiptAmountMinor } }), /No saved M-Pesa payment/);
    }
    assert.equal([...docs.keys()].filter(path => path.startsWith('payment_receipt_claims/')).length, 0);
    assert.equal(docs.get(`payments/${SALE_ID}_payment_01`).settledAt, undefined);
    assert.equal([...docs.values()].filter(row => row.source === 'sale_settlement').length, 0);
  } finally { restore(); }
});

test('recorded-only checkout loads saved amounts, allows only remaining money and permanently rejects exhausted receipts', async () => {
  const { lookupMpesaReceipt } = require('../lib/modules/sales/receipt-balance');
  const docs = base(); enableInternalReceipts(docs);
  const restore = harness(docs);
  try {
    // Existing entry recorded before code-only policy; no migration rewrites it.
    await settleSale.run({ auth, data: { saleUuid: 'uuid-1', requestId: 'old-recording', method: 'mpesa', reference: 'SAVED00001', receiptAmountMinor: 95000 } });
    docs.get('mpesa_receipt_controls/t1').entryMode = 'recorded_only';
    const second = deterministicId('sale', 't1:uuid-2');
    docs.set(`sales/${second}`, { tenantId: 't1', branchId: 'b1', totalMinor: 45000 });
    docs.set('payments/second-credit', { tenantId: 't1', saleId: second, method: 'credit', amountMinor: 45000 });
    const preview = () => lookupMpesaReceipt.run({ auth, data: { reference: 'SAVED00001', branchId: 'b1' } });
    assert.equal((await preview()).receivedMinor, 95000); assert.equal((await preview()).availableMinor, 45000);
    await assert.rejects(settleSale.run({ auth, data: { saleUuid: 'uuid-2', requestId: 'overspend', method: 'mpesa',
      reference: 'SAVED00001', amountMinor: 45001 } }), /balance or bill amount changed/);
    const result = await settleSale.run({ auth, data: { saleUuid: 'uuid-2', requestId: 'saved-balance', method: 'mpesa', reference: 'SAVED00001' } });
    assert.equal(result.settledMinor, 45000); assert.equal(result.availableMinor, 0);
    assert.equal((await preview()).availableMinor, 0);
    docs.get('mpesa_receipt_controls/t1').until = { toMillis: () => 1 };
    docs.get(`payments/${SALE_ID}_payment_01`).settledAt = undefined;
    await assert.rejects(settleSale.run({ auth, data: { saleUuid: 'uuid-1', requestId: 'reuse-later', method: 'mpesa', reference: 'SAVED00001' } }), /no unallocated money/);
  } finally { restore(); }
});

test('the shared receipt standard automatically covers active own branches but excludes missing, inactive and foreign branches', () => {
  const { standardReceiptPolicy } = require('../lib/shared/receipt-policy');
  const { internalReceiptEntryEnabled: enabled } = require('../lib/modules/sales/receipt-balance');
  const control = standardReceiptPolicy('t1', ['b1'], 'onboarding-audit');
  assert.equal(enabled(control, 't1', 'future-branch', Date.UTC(2050, 0, 1), { tenantId: 't1', status: 'active' }), true);
  for (const branch of [undefined, { tenantId: 't2', status: 'active' }, { tenantId: 't1', status: 'inactive' }]) {
    assert.equal(enabled(control, 't1', 'b1', Date.now(), branch), false);
  }
  for (const patch of [{ entryMode: 'staff_recorded' }, { branchScope: 'all' }, { until: 1 }, { authorizationId: '' }]) {
    assert.equal(enabled({ ...control, ...patch }, 't1', 'b1', Date.now(), { tenantId: 't1', status: 'active' }), false);
  }
});

test('shared-standard lookup cannot use another business ledger or branch, and never creates an amount', async () => {
  const { standardReceiptPolicy } = require('../lib/shared/receipt-policy');
  const { lookupMpesaReceipt } = require('../lib/modules/sales/receipt-balance');
  const docs = base();
  docs.set('mpesa_receipt_controls/t1', standardReceiptPolicy('t1', ['b1'], 'policy-audit'));
  docs.set('branches/b1', { tenantId: 't1', status: 'active' });
  docs.set('branches/new-own-branch', { tenantId: 't1', status: 'active' });
  docs.set('branches/foreign-branch', { tenantId: 't2', status: 'active' });
  docs.set('payments/foreign-payment', { tenantId: 't2', method: 'mpesa', reference: 'FOREIGN001', amountMinor: 170000, status: 'completed' });
  docs.set('payments/old-own-payment', { tenantId: 't1', method: 'mpesa', reference: 'OWNPAID001', amountMinor: 40000, status: 'completed' });
  const restore = harness(docs);
  try {
    await assert.rejects(lookupMpesaReceipt.run({ auth, data: { branchId: 'b1', reference: 'FOREIGN001', receiptAmountMinor: 170000 } }), /another business/);
    await assert.rejects(lookupMpesaReceipt.run({ auth, data: { branchId: 'foreign-branch', reference: 'OWNPAID001' } }), /branch is unavailable/);
    const result = await lookupMpesaReceipt.run({ auth, data: { branchId: 'new-own-branch', reference: 'OWNPAID001' } });
    assert.equal(result.receivedMinor, 40000); assert.equal(result.availableMinor, 0);
    assert.equal([...docs.keys()].filter(path => path.startsWith('payment_receipt_claims/')).length, 0);
    assert.equal(docs.get('payments/foreign-payment').amountMinor, 170000);
  } finally { restore(); }
});

function usedReceipt(docs, code, { amountMinor = 40000, allocatedMinor = amountMinor, targets }) {
  docs.set(`mpesa_c2b_events/${deterministicId('c2b', `confirmation:${code}`)}`, { tenantId: 't1', payload: { amountMinor }, settledMinor: allocatedMinor });
  docs.set(`payment_receipt_claims/${deterministicId('mpesa-receipt', `t1:${code}`)}`, { tenantId: 't1', allocationId: `receipt:t1:${code}`, targets, allocatedMinor, limitMinor: amountMinor });
}

test('an exhausted receipt explains received, used, where and what remains, and changes nothing', async () => {
  const docs = base(), other = deterministicId('sale', 't1:other');
  docs.set(`sales/${other}`, { tenantId: 't1', branchId: 'b1', invoiceNumber: 'INV-B1-000123', totalMinor: 40000 });
  usedReceipt(docs, 'USEDCODE01', { targets: [`sale:${other}`] });
  const restore = harness(docs);
  try {
    const before = JSON.stringify([...docs]);
    await assert.rejects(settleSale.run({ auth, data: { saleUuid: 'uuid-1', requestId: 'r', method: 'mpesa', reference: 'USEDCODE01' } }), error => {
      assert.equal(error.message, 'That M-Pesa receipt has no unallocated money left: received KES 400.00, already used KES 400.00 on INV-B1-000123, remaining KES 0.00.');
      return true;
    });
    assert.equal(JSON.stringify([...docs]), before, 'a refusal writes nothing');
  } finally { restore(); }
});

test('the exhausted-receipt message never names a bill it cannot safely identify', async () => {
  const docs = base(), foreign = deterministicId('sale', 't2:foreign'), extra = ['a', 'b', 'c'].map(id => deterministicId('sale', `t1:${id}`));
  docs.set(`sales/${foreign}`, { tenantId: 't2', invoiceNumber: 'INV-OTHER-BUSINESS', customerName: 'Somebody Else' });
  docs.set(`customer_orders/web-9`, { tenantId: 't1', ref: 'WEB-9', customerName: 'Nicole', phone: '0712345678' });
  usedReceipt(docs, 'USEDCODE02', { targets: [`sale:${foreign}`, 'sale:missing-sale', 'customer_order:web-9', ...extra.map(id => `sale:${id}`)] });
  const restore = harness(docs);
  try {
    await assert.rejects(settleSale.run({ auth, data: { saleUuid: 'uuid-1', requestId: 'r', method: 'mpesa', reference: 'USEDCODE02' } }), error => {
      assert.equal(error.message, 'That M-Pesa receipt has no unallocated money left: received KES 400.00, already used KES 400.00 on another bill, WEB-9 and 3 other bills, remaining KES 0.00.');
      assert.doesNotMatch(error.message, /INV-OTHER-BUSINESS|Somebody|Nicole|0712345678/);
      return true;
    });
  } finally { restore(); }
});

test('a staff-recorded total is "recorded", not "received", and an earlier part on this bill is named as such', async () => {
  const docs = base(); enableInternalReceipts(docs);
  docs.set('payments/old', { tenantId: 't1', saleId: SALE_ID, method: 'mpesa', reference: 'OLDCODE001', amountMinor: 20000, status: 'completed' });
  const restore = harness(docs);
  try {
    await assert.rejects(settleSale.run({ auth, data: { saleUuid: 'uuid-1', requestId: 'r', method: 'mpesa', reference: 'OLDCODE001' } }),
      /^Error: That M-Pesa receipt has no unallocated money left: recorded KES 200\.00, already used KES 200\.00 on this bill, remaining KES 0\.00\.$/);
  } finally { restore(); }
});

test('a partly used receipt still pays what it has left, exactly as before', async () => {
  const docs = base(), other = deterministicId('sale', 't1:other');
  docs.set(`sales/${other}`, { tenantId: 't1', branchId: 'b1', invoiceNumber: 'INV-B1-000124', totalMinor: 10000 });
  usedReceipt(docs, 'PARTCODE01', { amountMinor: 40000, allocatedMinor: 10000, targets: [`sale:${other}`] });
  const restore = harness(docs);
  try {
    const result = await settleSale.run({ auth, data: { saleUuid: 'uuid-1', requestId: 'r', method: 'mpesa', reference: 'PARTCODE01' } });
    assert.equal(result.settledMinor, 30000);
    assert.equal(result.outstandingMinor, 20000);
    assert.equal(result.availableMinor, 0);
    assert.equal(docs.get(`payment_receipt_claims/${deterministicId('mpesa-receipt', 't1:PARTCODE01')}`).allocatedMinor, 40000);
  } finally { restore(); }
});
