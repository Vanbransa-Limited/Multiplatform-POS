'use strict';
const assert = require('node:assert/strict');
if (process.env.GCLOUD_PROJECT !== 'demo-tokgut-pos' || !/^127\.0\.0\.1:\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST || '')) {
  throw Error('Run only against the local demo-tokgut-pos Firestore emulator');
}
const { db } = require('../lib/lib/firebase');
const { Timestamp } = require('firebase-admin/firestore');
const { deterministicId } = require('../lib/shared/identifiers');
const { reconcileReceipt, verifyReconciliation, rounds, tenantId, reference, archiveId } = require('../../../scripts/reconcile-esther-split-receipt.cjs');
const claimRef = db.doc(`payment_receipt_claims/${deterministicId('mpesa-receipt', `${tenantId}:${reference}`)}`);
const originalPaidAt = Timestamp.fromDate(new Date('2026-11-19T16:47:51.390Z'));

async function main() {
  const movementsBefore = (await db.collection('stock_movements').where('tenantId', '==', tenantId).get()).size;
  const batch = db.batch();
  batch.set(claimRef, { tenantId, reference, verified: false, allocatedMinor: 70000, limitMinor: 70000,
    allocationId: 'checkout:f6be1c26-1e0e-4dbb-af57-2362768eaff9', targets: rounds.slice(0, 2).map(([id]) => `sale:${id}`) });
  for (const [i, [id, invoice, total, order]] of rounds.entries()) {
    batch.set(db.doc(`sales/${id}`), { tenantId, branchId: 'branch-nai-01',
      staffId: 'staff-c4ee24d00e03e817fea33a2d0c4b94f53331443283997bee', invoiceNumber: invoice,
      orderReference: order, totalMinor: total, status: 'completed', idempotencyKey: `bill-${i}`, soldAt: originalPaidAt });
    batch.set(db.doc(`payments/credit-${i}`), { tenantId, saleId: id, method: 'credit', amountMinor: total,
      ...(i < 2 ? { settledAt: originalPaidAt, settledReference: reference } : {}) });
    if (i < 2) batch.set(db.doc(`payments/receipt-${i}`), { tenantId, saleId: id, method: 'mpesa',
      reference, amountMinor: total, status: 'completed', verified: false, paidAt: originalPaidAt,
      receivedByStaffId: 'original-recorder', receiptAllocationId: 'checkout:f6be1c26-1e0e-4dbb-af57-2362768eaff9' });
  }
  batch.set(db.doc('stock_balances/unchanged'), { qty: 7 });
  await batch.commit();
  const dryRun = await reconcileReceipt(db);
  assert.equal(dryRun.result, 'ready (dry run)');
  assert.equal((await db.doc(`reconciliation_archives/${archiveId}`).get()).exists, false);
  assert.equal((await db.doc('payments/credit-2').get()).data().settledAt, undefined);
  await assert.rejects(reconcileReceipt(db, { apply: true, expectedHash: '0'.repeat(64) }), /Records changed/);

  const target = db.doc(`sales/${rounds[2][0]}`);
  await target.update({ invoiceNumber: 'different-invoice' });
  await assert.rejects(reconcileReceipt(db), /different-invoice/);
  await target.update({ invoiceNumber: rounds[2][1], changedAfterReview: true });
  await assert.rejects(reconcileReceipt(db, { apply: true, expectedHash: dryRun.fingerprint }), /Records changed/);
  const event = db.doc(`mpesa_c2b_events/${deterministicId('c2b', `confirmation:${reference}`)}`);
  await event.set({ tenantId });
  await assert.rejects(reconcileReceipt(db), /Provider confirmation changed/);
  await event.delete();
  console.log('PASS: read-only dry run, wrong invoice, stale fingerprint, and changed-provider guards');

  const reviewed = await reconcileReceipt(db);
  const applied = await Promise.all([reconcileReceipt(db, { apply: true, expectedHash: reviewed.fingerprint }),
    reconcileReceipt(db, { apply: true, expectedHash: reviewed.fingerprint })]);
  assert.equal(applied.filter(x => x.result === 'reconciled').length, 1);
  assert.equal(applied.filter(x => x.result === 'already reconciled').length, 1);
  const payments = (await db.collection('payments').where('reference', '==', reference).get()).docs.map(d => d.data());
  assert.equal(payments.length, 3);
  assert.deepEqual(payments.map(p => p.amountMinor).sort((a,b) => a-b), [10000, 30000, 40000]);
  assert.equal(payments.reduce((sum,p) => sum + p.amountMinor, 0), 80000);
  assert.ok(payments.every(p => p.verified === false && p.paidAt.toMillis() === originalPaidAt.toMillis()));
  for (let i=0; i<3; i++) assert.ok((await db.doc(`payments/credit-${i}`).get()).data().settledAt);
  const claim = (await claimRef.get()).data();
  assert.equal(claim.allocatedMinor, 80000); assert.equal(claim.limitMinor, 80000);
  assert.equal(claim.targets.length, 3); assert.equal(claim.verified, false);
  assert.equal((await db.doc('stock_balances/unchanged').get()).data().qty, 7);
  assert.equal((await db.collection('stock_movements').where('tenantId', '==', tenantId).get()).size, movementsBefore);
  const archived = (await db.doc(`reconciliation_archives/${archiveId}`).get()).data();
  assert.ok(archived.records.length >= 9);
  assert.equal((await db.doc(`audit_logs/${archiveId}`).get()).data().metadata.additionalAmountMinor, 10000);
  assert.equal((await reconcileReceipt(db, { apply: true, expectedHash: reviewed.fingerprint })).result, 'already reconciled');
  const financials = await verifyReconciliation(db);
  assert.equal(financials.totalAllocatedKES, 800); assert.equal(financials.receiptCount, 1);
  assert.equal(financials.outstandingKES, 0); assert.equal(financials.newMoneyOnRepairDateKES, 0);
  console.log('PASS: atomic KES 800 allocation, all three debts cleared, original date retained, manual verification retained, concurrent replay, audit archive, stock untouched');
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => db.terminate());
