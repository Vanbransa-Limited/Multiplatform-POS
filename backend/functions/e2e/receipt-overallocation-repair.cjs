'use strict';
const assert = require('node:assert/strict');
if (Number(process.versions.node.split('.')[0]) !== 22 || process.env.GCLOUD_PROJECT !== 'demo-tokgut-pos'
  || !/^127\.0\.0\.1:\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST || '')) throw Error('Local Node 22 demo emulator required');
const { db } = require('../lib/lib/firebase');
const { Timestamp } = require('firebase-admin/firestore');
const { deterministicId } = require('../lib/shared/identifiers');
const { readReceiptBalance } = require('../lib/modules/sales/receipt-balance');
const { refreshTableSession } = require('../lib/modules/sales/tab-identity');
const { repairReceipt } = require('../../../scripts/lib/receipt-overallocation-repair.cjs');
async function main() {
  const T = 'overallocated-demo', B = 'overallocated-branch', C = 'DEMO900000', S = 'big-sale';
  const plan = { tenantId: T, branchId: B, reference: C, saleId: S, invoiceNumber: 'DEMO-BIG', sellerStaffId: 'demo-judith',
    paymentId: 'big-paid', paymentFromMinor: 942500, fromMinor: 1127500, totalMinor: 900000, reopenMinor: 227500,
    archiveId: 'demo-overallocated-repair', reason: 'Owner confirmed KES 2,275 remains owed.' };
  const rows = {
    [`branches/${B}`]: { tenantId: T, status: 'active' },
    [`sales/${S}`]: { tenantId: T, branchId: B, invoiceNumber: 'DEMO-BIG', staffId: 'demo-judith', status: 'completed',
      tableNumber: 'VIP', tabId: 'vip-tab', totalMinor: 942500 },
    [`payments/big-paid`]: { tenantId: T, branchId: B, saleId: S, method: 'mpesa', amountMinor: 942500, reference: C,
      verified: false, status: 'completed', result: { settledMinor: 942500, outstandingMinor: 0, receivedMinor: 1127500 } },
    [`payments/big-credit`]: { tenantId: T, saleId: S, method: 'credit', amountMinor: 942500, settledAt: Timestamp.now(), settledReference: C },
    [`sales/tin`]: { tenantId: T, branchId: B, status: 'completed', tableNumber: 'VIP', tabId: 'vip-tab', totalMinor: 5000 },
    [`payments/tin-credit`]: { tenantId: T, saleId: 'tin', method: 'credit', amountMinor: 5000 },
    [`payment_receipt_claims/${deterministicId('mpesa-receipt', `${T}:${C}`)}`]: { tenantId: T, branchId: B,
      reference: C, limitMinor: 1127500, allocatedMinor: 1127500, amountSource: 'staff_recorded_receipt', verified: false },
  };
  [10000, 30000, 45000, 80000, 20000].forEach((amountMinor, i) => {
    rows[`payments/other-${i}`] = { tenantId: T, branchId: B, saleId: `other-sale-${i}`, method: 'mpesa',
      amountMinor, reference: C, status: 'completed', verified: false };
  });
  const batch = db.batch(); for (const [p, v] of Object.entries(rows)) batch.set(db.doc(p), v); await batch.commit();
  const preview = await repairReceipt(db, plan);
  assert.equal((await db.doc('payments/big-paid').get()).data().amountMinor, 942500);
  await assert.rejects(repairReceipt(db, plan, { apply: true, expectedHash: 'wrong' }), /Records changed/);
  const results = await Promise.all([1, 2].map(() => repairReceipt(db, plan, { apply: true, expectedHash: preview.hash })));
  assert.ok(results.some(r => r.resumed));
  const claim = (await db.doc(`payment_receipt_claims/${deterministicId('mpesa-receipt', `${T}:${C}`)}`).get()).data();
  assert.equal(claim.limitMinor, 900000); assert.equal(claim.allocatedMinor, 900000); assert.equal(claim.verified, false);
  assert.equal((await db.doc('payments/big-paid').get()).data().amountMinor, 715000);
  const credit = (await db.doc('payments/big-credit').get()).data();
  assert.equal(credit.amountMinor, 227500); assert.equal(credit.settledAt, undefined);
  assert.equal((await db.doc('payments/tin-credit').get()).data().amountMinor, 5000);
  for (let i = 0; i < 5; i++) assert.equal((await db.doc(`payments/other-${i}`).get()).data().amountMinor, rows[`payments/other-${i}`].amountMinor);
  const balance = await db.runTransaction(tx => readReceiptBalance(tx, T, C, B));
  assert.equal(balance.availableMinor, 0, 'corrected exhausted receipt cannot pay another bill');
  assert.equal((await refreshTableSession(T, B, 'VIP')).dueMinor, 232500);
  assert.equal((await db.doc(`sales/${S}`).get()).data().totalMinor, 942500);
  console.log('Receipt correction passed: KES 9,000 allocated, KES 2,275 reopened plus KES 50, other five amounts preserved, concurrent retry safe, no receipt reuse.');
}
main().catch(e => { console.error(e); process.exitCode = 1; });
