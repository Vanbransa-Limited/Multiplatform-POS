'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const backend = require('node:module').createRequire(path.resolve(__dirname, '../../backend/functions/package.json'));
const { Timestamp } = backend('firebase-admin/firestore');
const { deterministicId } = require('../../backend/functions/lib/shared/identifiers');
const { reconcileReceipt, verifyReconciliation, isReviewedHistoricalPrompt, plan } = require('../reconcile-ukldq29eaj-split-receipt.cjs');

function fixture() {
  const docs = new Map(), at = Timestamp.fromDate(new Date('2026-11-20T22:25:21Z'));
  const claimPath = `payment_receipt_claims/${deterministicId('mpesa-receipt', `${plan.tenantId}:${plan.reference}`)}`;
  docs.set(claimPath, { tenantId: plan.tenantId, reference: plan.reference, verified: false,
    allocationId: plan.originalAllocationId, allocatedMinor: plan.previouslyAllocatedMinor,
    limitMinor: plan.previouslyAllocatedMinor, targets: plan.sales.filter(s => s.alreadyPaid).map(s => `sale:${s.id}`) });
  for (const expected of plan.sales) {
    const { alreadyPaid, id, ...sale } = expected;
    docs.set(`sales/${id}`, { ...sale, tenantId: plan.tenantId, branchId: plan.branchId,
      status: 'completed', soldAt: at, checkoutExpiresAt: Timestamp.fromMillis(1) });
    docs.set(`payments/${id}_credit`, { tenantId: plan.tenantId, saleId: id, method: 'credit',
      amountMinor: expected.totalMinor, status: 'completed', paidAt: at,
      ...(alreadyPaid ? { settledAt: at, settledReference: plan.reference } : {}) });
    if (alreadyPaid) docs.set(`payments/${id}_original`, { tenantId: plan.tenantId, branchId: plan.branchId,
      saleId: id, method: 'mpesa', amountMinor: expected.totalMinor, reference: plan.reference,
      status: 'completed', verified: false, paidAt: at, createdAt: at, receivedByStaffId: 'original-cashier',
      receiptAllocationId: plan.originalAllocationId, receiptLimitMinor: plan.previouslyAllocatedMinor });
  }
  docs.set('stock_movements/original-stock', { referenceId: plan.sales[0].id, qty: -2, createdAt: at });
  docs.set('sales/voided-round', { tenantId: plan.tenantId, branchId: plan.branchId,
    orderReference: 'ORD-2-694504', totalMinor: 298000, status: 'VOIDED' });
  docs.set('payments/voided-credit', { tenantId: plan.tenantId, saleId: 'voided-round', method: 'credit', amountMinor: 298000, status: 'voided' });
  const ref = pathname => ({ id: pathname.split('/')[1], path: pathname, get: async () => snap(ref(pathname)) });
  const snap = reference => ({ id: reference.id, ref: reference, exists: docs.has(reference.path), data: () => docs.get(reference.path) });
  const query = (name, field, value) => ({ query: true, name, field, value,
    get: async () => querySnapshot(name, field, value) });
  const querySnapshot = (name, field, value) => {
    const found = [...docs].filter(([key, row]) => key.startsWith(`${name}/`) && row[field] === value)
      .map(([key]) => snap(ref(key)));
    return { docs: found, size: found.length, empty: !found.length };
  };
  const validWrite = value => {
    assert.notEqual(value, undefined, 'Firestore rejects undefined fields');
    if (value && typeof value === 'object') Object.values(value).forEach(validWrite);
  };
  const db = { doc: ref, collection: name => ({ where: (field, op, value) => {
    assert.equal(op, '=='); return query(name, field, value);
  } }), runTransaction: async run => {
    const writes = [];
    const result = await run({
      get: async target => { assert.equal(writes.length, 0, 'All reads must precede writes');
        return target.query ? querySnapshot(target.name, target.field, target.value) : snap(target); },
      getAll: async (...refs) => { assert.equal(writes.length, 0, 'All reads must precede writes'); return refs.map(snap); },
      create: (target, data) => { assert.ok(!docs.has(target.path)); validWrite(data); writes.push([target.path, data]); },
      update: (target, data) => { assert.ok(docs.has(target.path)); validWrite(data); writes.push([target.path, { ...docs.get(target.path), ...data }]); },
    });
    writes.forEach(([key, value]) => docs.set(key, value));
    return result;
  } };
  return { db, docs, claimPath };
}

test('seven-bill correction preserves original 34430, applies 28220 once, leaves stock and voids untouched', async () => {
  const { db, docs } = fixture(), originalCount = docs.size;
  const dryRun = await reconcileReceipt(db);
  assert.equal(dryRun.totalAllocatedKES, 62650);
  assert.equal(dryRun.additionalAllocationKES, 28220);
  assert.equal(dryRun.newAllocations, 11);
  assert.equal(docs.size, originalCount, 'Dry run never writes');
  await reconcileReceipt(db, { apply: true, expectedHash: dryRun.fingerprint });
  const verified = await verifyReconciliation(db);
  assert.equal(verified.outstandingKES, 0);
  assert.equal(verified.receiptCount, 1);
  assert.equal(verified.totalAllocatedKES, 62650);
  assert.equal(verified.stockUnchanged, true);
  const after = docs.size;
  assert.equal((await reconcileReceipt(db, { apply: true, expectedHash: dryRun.fingerprint })).result, 'already reconciled');
  assert.equal(docs.size, after, 'Replay never adds another receipt');
});

test('wrong fingerprints and changed bill totals refuse the entire correction', async () => {
  for (const drift of ['fingerprint', 'bill']) {
    const { db, docs } = fixture(), dryRun = await reconcileReceipt(db), count = docs.size;
    if (drift === 'bill') docs.get(`sales/${plan.sales.find(s => !s.alreadyPaid).id}`).totalMinor += 100;
    await assert.rejects(reconcileReceipt(db, { apply: true,
      expectedHash: drift === 'fingerprint' ? '0'.repeat(64) : dryRun.fingerprint }));
    assert.equal(docs.size, count);
    assert.ok(!docs.has(`reconciliation_archives/${plan.archiveId}`));
  }
});

test('new provider evidence, another receipt use, paid targets and active checkout require fresh review', async () => {
  for (const drift of ['provider', 'extra-use', 'paid', 'checkout', 'extra-round']) {
    const { db, docs } = fixture();
    const target = plan.sales.find(s => !s.alreadyPaid);
    if (drift === 'provider') docs.set(`mpesa_c2b_events/${deterministicId('c2b', `confirmation:${plan.reference}`)}`, { tenantId: plan.tenantId });
    if (drift === 'extra-use') docs.set('payments/unexpected', { tenantId: plan.tenantId, saleId: 'other', reference: plan.reference, amountMinor: 100 });
    if (drift === 'paid') docs.get(`payments/${target.id}_credit`).settledAt = Timestamp.now();
    if (drift === 'checkout') docs.get(`sales/${target.id}`).checkoutExpiresAt = Timestamp.fromMillis(Date.now() + 60000);
    if (drift === 'extra-round') docs.set('sales/unexpected', { tenantId: plan.tenantId, branchId: plan.branchId,
      orderReference: target.orderReference, status: 'completed', totalMinor: 100 });
    const count = docs.size;
    await assert.rejects(reconcileReceipt(db));
    assert.equal(docs.size, count);
    assert.ok(!docs.has(`reconciliation_archives/${plan.archiveId}`));
  }
});

test('only the reviewed old unconfirmed prompt is preserved; paid, changed or unrelated attempts are refused', () => {
  const expected = plan.preservedHistoricalPrompt;
  const row = { tenantId: plan.tenantId, status: 'ambiguous', amountMinor: expected.amountMinor,
    requestedAt: Timestamp.fromMillis(expected.requestedAtMillis), receipt: null, completedAt: null };
  const snapshot = (data, id = expected.id) => ({ id, data: () => data });
  assert.equal(isReviewedHistoricalPrompt(snapshot(row), expected.invoiceNumber), true);
  for (const patch of [{ status: 'paid' }, { receipt: 'OTHERPROOF' }, { amountMinor: 1 }, { settledSaleId: 'other' }]) {
    assert.equal(isReviewedHistoricalPrompt(snapshot({ ...row, ...patch }), expected.invoiceNumber), false);
  }
  assert.equal(isReviewedHistoricalPrompt(snapshot(row, 'different'), expected.invoiceNumber), false);
  assert.equal(isReviewedHistoricalPrompt(snapshot(row), 'different-invoice'), false);
});
