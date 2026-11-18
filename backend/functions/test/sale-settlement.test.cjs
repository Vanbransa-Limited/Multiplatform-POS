const test = require('node:test');
const assert = require('node:assert/strict');
const { attemptBlocks, isVoidable, outstandingMinor, settleSale, settlingStaff, claimSalePayment } = require('../lib/modules/sales/settle');
const { db } = require('../lib/lib/firebase');

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
  const snapshot = (ref) => ({ id: ref.id, ref, exists: docs.has(ref.path), data: () => docs.get(ref.path) });
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
  docs.set('mpesa_payments/stk1', { tenantId: 't1', branchId: 'b1', status: 'paid', receipt: 'TESTRECEIPT', amountMinor });
  docs.set(`payment_intents/${deterministicId('intent', 't1:TESTRECEIPT')}`, { tenantId: 't1', attemptId: 'stk1', status: 'verified', amountMinor });
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
    const intent = docs.get(`payment_intents/${deterministicId('intent', 't1:TESTRECEIPT')}`);
    assert.equal(intent.status, 'consumed');
    assert.equal(intent.consumedSaleId, SALE_ID);
    assert.deepEqual(await settleSale.run({ auth, data: input }), result);
  } finally { restore(); }
});

test('an STK receipt consumed by a new sale cannot also clear Pending', async () => {
  const docs = base(); confirmedAttempt(docs);
  docs.get(`payment_intents/${deterministicId('intent', 't1:TESTRECEIPT')}`).consumedSaleId = 'another-sale';
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

test('one typed receipt can clear reserved table rounds, but cannot pay another checkout', async () => {
  for (const confirmed of [false, true]) {
    const docs = base(), second = deterministicId('sale', 't1:uuid-2'), third = deterministicId('sale', 't1:uuid-3');
    for (const id of [second, third]) {
      docs.set(`sales/${id}`, { tenantId: 't1', branchId: 'b1', totalMinor: 20000 });
      docs.set(`payments/${id}_payment_01`, { tenantId: 't1', saleId: id, method: 'credit', amountMinor: 20000 });
    }
    if (confirmed) docs.set(`mpesa_c2b_events/${deterministicId('c2b', 'confirmation:TABLECODE')}`, { tenantId: 't1', payload: { amountMinor: 70000 } });
    const restore = harness(docs);
    try {
      await claimSalePayment.run({ auth, data: { saleUuids: ['uuid-1', 'uuid-2'], checkoutId: 'one-table', method: 'mpesa' } });
      for (const uuid of ['uuid-1', 'uuid-2']) {
        const result = await settleSale.run({ auth, data: { saleUuid: uuid, checkoutId: 'one-table', requestId: uuid, method: 'mpesa', reference: 'TABLECODE' } });
        assert.equal(result.verified, confirmed);
      }
      assert.equal([...docs.values()].filter(row => row.source === 'sale_settlement').reduce((sum,row) => sum + row.amountMinor,0), 70000);
      await claimSalePayment.run({ auth, data: { saleUuids: ['uuid-3'], checkoutId: 'other-table', method: 'mpesa' } });
      await assert.rejects(settleSale.run({ auth, data: { saleUuid: 'uuid-3', checkoutId: 'other-table', requestId: 'third', method: 'mpesa', reference: 'TABLECODE' } }));
    } finally { restore(); }
  }
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

test('an unused M-Pesa code can be recorded, while a consumed confirmation is refused', async () => {
  const code = 'QGH4T21XZ9';
  const eventPath = `mpesa_c2b_events/${deterministicId('c2b', `confirmation:${code}`)}`;
  const settleWith = async (event) => {
    const docs = base();
    if (event) docs.set(eventPath, event);
    const restore = harness(docs);
    try {
      const result = await settleSale.run({ auth, data: { saleUuid: 'uuid-1', requestId: 'r1', method: 'mpesa', reference: code.toLowerCase() } });
      return { result, docs };
    } finally { restore(); }
  };

  // Nothing from the provider, a short payment, or a used code: recorded on
  // the cashier's word, and never consuming the confirmation.
  for (const event of [null, { tenantId: 't1', payload: { amountMinor: 40000 } }]) {
    const { result, docs } = await settleWith(event);
    assert.equal(result.verified, false);
    assert.equal(result.reference, code);
    assert.equal(docs.get(eventPath)?.settledSaleId ?? null, event?.settledSaleId ?? null);
  }
  await assert.rejects(settleWith({ tenantId: 't1', settledSaleId: 'other', payload: { amountMinor: 50000 } }), /already settled/);

  const { result, docs } = await settleWith({ tenantId: 't1', payload: { amountMinor: 50000 } });
  assert.equal(result.verified, true);
  // Consumed, so the same confirmation cannot verify a second invoice.
  assert.equal(docs.get(eventPath).settledSaleId, SALE_ID);
});

test('typing an STK receipt consumes its confirmed proof and keeps the original receipt date', async () => {
  const docs = base(); confirmedAttempt(docs);
  const paidAt = { toMillis: () => 1000 };
  docs.get('mpesa_payments/stk1').completedAt = paidAt;
  const restore = harness(docs);
  try {
    const result = await settleSale.run({ auth, data: { saleUuid: 'uuid-1', requestId: 'sms-stk', method: 'mpesa', reference: 'testreceipt' } });
    assert.equal(result.verified, true);
    assert.equal(docs.get(`payment_intents/${deterministicId('intent', 't1:TESTRECEIPT')}`).status, 'consumed');
    assert.equal(docs.get('mpesa_payments/stk1').settledSaleId, SALE_ID);
    const payment = [...docs.values()].find(row => row.source === 'sale_settlement');
    assert.equal(payment.paidAt, paidAt);
  } finally { restore(); }
});

test('a manually recorded receipt cannot clear a second bill, including legacy rows without a receipt claim', async () => {
  for (const legacy of [false, true]) {
    const docs = base();
    if (legacy) docs.set('payments/legacy', { tenantId: 't1', saleId: 'another-sale', method: 'mpesa', reference: 'SAMECODE', amountMinor: 50000, status: 'completed' });
    const restore = harness(docs);
    try {
      if (!legacy) {
        await settleSale.run({ auth, data: { saleUuid: 'uuid-1', requestId: 'first', method: 'mpesa', reference: 'SAMECODE' } });
        docs.set(`sales/${deterministicId('sale', 't1:uuid-2')}`, { tenantId: 't1', branchId: 'b1' });
        docs.set('payments/credit2', { tenantId: 't1', saleId: deterministicId('sale', 't1:uuid-2'), method: 'credit', amountMinor: 50000 });
      }
      await assert.rejects(settleSale.run({ auth, data: { saleUuid: legacy ? 'uuid-1' : 'uuid-2', requestId: 'second', method: 'mpesa', reference: 'SAMECODE' } }), /already recorded/);
    } finally { restore(); }
  }
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
