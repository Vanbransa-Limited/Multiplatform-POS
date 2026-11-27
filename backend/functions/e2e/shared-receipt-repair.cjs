'use strict';
const assert = require('node:assert/strict');
if (Number(process.versions.node.split('.')[0]) !== 22 || process.env.GCLOUD_PROJECT !== 'demo-tokgut-pos'
  || !/^127\.0\.0\.1:\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST || '')) {
  throw Error('Run only with Node 22 against the local demo Firestore emulator.');
}
const { db } = require('../lib/lib/firebase');
const { correctReceiptTotal } = require('../lib/modules/sales/correct-receipt');
const { settleSale, outstandingMinor } = require('../lib/modules/sales/settle');
const { deterministicId } = require('../lib/shared/identifiers');
const { Timestamp } = require('firebase-admin/firestore');
const T = 'shared-repair-demo', B = 'shared-repair-branch';
const auth = { uid: 'reviewed-repair', token: { tenant_id: T, staff_id: 'reviewed-owner', staff_role: 'owner' } };
async function main() {
  const id = key => deterministicId('sale', `${T}:${key}`);
  const receipt = 'DEMOREF450';
  const claimId = deterministicId('mpesa-receipt', `${T}:${receipt}`);
  const rows = {
    [`tenants/${T}`]: { status: 'active' },
    [`branches/${B}`]: { tenantId: T, status: 'active' },
    [`tenant_settings/${T}`]: { tenantId: T, acceptedPaymentMethods: ['mpesa'] },
    [`mpesa_receipt_controls/${T}`]: { tenantId: T, mode: 'internal', policyVersion: 3, entryMode: 'staff_entry', branchScope: 'tenant', duration: 'ongoing', until: null, authorizationId: 'demo-repair' },
    [`sales/${id('original')}`]: { tenantId: T, branchId: B, status: 'completed', totalMinor: 60000, staffId: 'demo-nicole', invoiceNumber: 'DEMO-600' },
    [`payments/${id('original')}-paid`]: { tenantId: T, saleId: id('original'), method: 'mpesa', amountMinor: 60000, reference: receipt, verified: false, status: 'completed', receiptAllocationId: `receipt:${T}:${receipt}` },
    [`payment_receipt_claims/${claimId}`]: { tenantId: T, branchId: B, reference: receipt, amountSource: 'staff_recorded_receipt',
      allocationId: `receipt:${T}:${receipt}`, limitMinor: 60000, allocatedMinor: 60000, targets: [`sale:${id('original')}`], verified: false, paidAt: Timestamp.now() },
  };
  for (const [key, amount, staff] of [['remaining', 45000, 'demo-nicole'], ['resurfaced', 35000, 'demo-hadrine']]) {
    rows[`sales/${id(key)}`] = { tenantId: T, branchId: B, status: 'completed', totalMinor: amount, invoiceNumber: `DEMO-${key}`, staffId: staff };
    rows[`payments/${id(key)}-credit`] = { tenantId: T, saleId: id(key), method: 'credit', amountMinor: amount, status: 'completed' };
  }
  const batch = db.batch();
  for (const [path, data] of Object.entries(rows)) batch.set(db.doc(path), data);
  await batch.commit();
  const original = (await db.doc(`payments/${id('original')}-paid`).get()).data();
  const correction = await correctReceiptTotal.run({ auth, data: { reference: receipt, totalMinor: 105000, reason: 'Owner reviewed the supplied receipt total.' } });
  assert.equal(correction.availableMinor, 45000);
  const pay = key => settleSale.run({ auth, data: { saleUuid: key, requestId: `review-${key}`, method: 'mpesa',
    reference: key === 'remaining' ? receipt : 'DEMOREF350', ...(key === 'resurfaced' ? { receiptAmountMinor: 35000 } : {}), amountMinor: key === 'remaining' ? 45000 : 35000 } });
  await Promise.all([pay('remaining'), pay('remaining')]);
  await pay('resurfaced'); await pay('resurfaced');
  for (const key of ['remaining', 'resurfaced']) {
    const ledger = (await db.collection('payments').where('saleId', '==', id(key)).get()).docs.map(doc => doc.data());
    assert.equal(outstandingMinor(ledger), 0);
    assert.equal(ledger.filter(row => row.method === 'mpesa').length, 1);
    assert.equal(ledger.find(row => row.method === 'mpesa').verified, false);
  }
  assert.deepEqual((await db.doc(`payments/${id('original')}-paid`).get()).data(), original);
  assert.equal((await db.doc(`sales/${id('resurfaced')}`).get()).data().staffId, 'demo-hadrine');
  const claim = (await db.doc(`payment_receipt_claims/${claimId}`).get()).data();
  assert.equal(claim.limitMinor, 105000); assert.equal(claim.allocatedMinor, 105000);
  console.log(JSON.stringify({ sharedReceiptRepair: 'passed', originalPaymentUnchanged: true, concurrentRetrySafe: true,
    remaining450Settled: true, resurfaced350Settled: true, manualPaymentsRemainUnverified: true }));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
