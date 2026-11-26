'use strict';
// The owner corrects a staff-typed M-Pesa total in the app (500 typed for 850,
// 25 Nov 2026); the rest of the money then settles the bill it was meant for.
const assert = require('node:assert/strict');
if (process.env.GCLOUD_PROJECT !== 'demo-tokgut-pos' || !/^127\.0\.0\.1:\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST || '')) {
  throw Error('Run only against the local demo-tokgut-pos Firestore emulator');
}
const { db } = require('../lib/lib/firebase');
const { Timestamp } = require('firebase-admin/firestore');
const { correctReceiptTotal } = require('../lib/modules/sales/correct-receipt');
const { settleSale } = require('../lib/modules/sales/settle');
const { deterministicId } = require('../lib/shared/identifiers');

const T = 'fix-tenant', B = 'fix-branch', CODE = 'UKF0X49DGE';
const as = role => ({ uid: role, token: { tenant_id: T, staff_id: `fix-${role}`, staff_role: role } });

async function main() {
  const saleId = uuid => deterministicId('sale', `${T}:${uuid}`);
  const claimId = deterministicId('mpesa-receipt', `${T}:${CODE}`);
  const now = Timestamp.now();
  const batch = db.batch();
  const rows = {
    [`tenants/${T}`]: { status: 'active' },
    [`branches/${B}`]: { tenantId: T, status: 'active' },
    [`tenant_settings/${T}`]: { tenantId: T, acceptedPaymentMethods: ['mpesa'] },
    [`sales/${saleId('fix-beef')}`]: { tenantId: T, branchId: B, status: 'completed', totalMinor: 50000, invoiceNumber: 'FIX-1' },
    [`payments/${saleId('fix-beef')}-mpesa`]: { tenantId: T, saleId: saleId('fix-beef'), method: 'mpesa', amountMinor: 50000,
      reference: CODE, status: 'completed', receiptAllocationId: `receipt:${T}:${CODE}` },
    [`sales/${saleId('fix-punch')}`]: { tenantId: T, branchId: B, status: 'completed', totalMinor: 35000, invoiceNumber: 'FIX-2' },
    [`payments/${saleId('fix-punch')}-credit`]: { tenantId: T, saleId: saleId('fix-punch'), method: 'credit', amountMinor: 35000 },
    [`payment_receipt_claims/${claimId}`]: { tenantId: T, provider: 'mpesa', reference: CODE, amountSource: 'staff_recorded_receipt',
      branchId: B, allocationId: `receipt:${T}:${CODE}`, targets: [`sale:${saleId('fix-beef')}`], allocatedMinor: 50000,
      limitMinor: 50000, verified: false, paidAt: now, createdAt: now },
  };
  for (const [path, data] of Object.entries(rows)) batch.set(db.doc(path), data);
  await batch.commit();

  const settlePunch = role => settleSale.run({ auth: as(role), data: { saleUuid: 'fix-punch', requestId: `fix-${role}-settle`,
    method: 'mpesa', reference: CODE, amountMinor: 35000 } });
  await assert.rejects(settlePunch('cashier'), /no unallocated|used|already|left/i, 'before correction the code is used up');
  await assert.rejects(correctReceiptTotal.run({ auth: as('cashier'), data: { reference: CODE, totalMinor: 85000, reason: 'typo' } }), /Only the owner/);
  await assert.rejects(correctReceiptTotal.run({ auth: as('owner'), data: { reference: CODE, totalMinor: 40000, reason: 'typo' } }), /already used/);

  const fixed = await correctReceiptTotal.run({ auth: as('owner'), data: { reference: CODE, totalMinor: 85000,
    reason: 'Hadrine typed 500; the M-Pesa message says 850' } });
  assert.deepEqual(fixed, { reference: CODE, fromMinor: 50000, totalMinor: 85000, availableMinor: 35000 });
  const settled = await settlePunch('cashier');
  assert.equal(settled.settledMinor, 35000); assert.equal(settled.outstandingMinor, 0); assert.equal(settled.verified, false);
  const claim = (await db.doc(`payment_receipt_claims/${claimId}`).get()).data();
  assert.equal(claim.allocatedMinor, 85000); assert.equal(claim.correctedFromMinor, 50000);
  const audit = (await db.collection('audit_logs').where('entityId', '==', claimId).get()).docs.map(d => d.data());
  assert.equal(audit.length, 1); assert.equal(audit[0].action, 'receipt.total_corrected');
  console.log(JSON.stringify({ receiptCorrection: 'passed', ownerOnly: true, neverBelowAllocated: true, remainderSettles: true, audited: true }));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
