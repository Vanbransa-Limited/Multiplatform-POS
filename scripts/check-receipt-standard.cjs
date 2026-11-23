'use strict';
// Real production reads only. No test tenant, branch, claim or payment is created.
process.env.GCLOUD_PROJECT = 'vanbransa-pos';
const assert = require('node:assert/strict');
const { db } = require('../backend/functions/lib/lib/firebase');
const { readReceiptBalance, internalReceiptEntryEnabled } = require('../backend/functions/lib/modules/sales/receipt-balance');
const { deterministicId } = require('../backend/functions/lib/shared/identifiers');
async function main() {
  const [tenants, branches] = await Promise.all([
    db.collection('tenants').where('status', '==', 'active').get(),
    db.collection('branches').where('status', '==', 'active').get(),
  ]);
  const results = [];
  for (const tenant of tenants.docs) {
    const control = (await db.doc(`mpesa_receipt_controls/${tenant.id}`).get()).data();
    assert.equal(control?.policyVersion, 3); assert.equal(control?.entryMode, 'staff_entry');
    assert.equal(control.until, null); assert.equal(control.duration, 'ongoing');
    assert.ok((await db.doc(`audit_logs/${control.authorizationId}`).get()).exists);
    const own = branches.docs.filter(branch => branch.data().tenantId === tenant.id);
    assert.ok(own.length);
    for (const branch of own) {
      assert.equal(internalReceiptEntryEnabled(control, tenant.id, branch.id, Date.UTC(2050, 0, 1), branch.data()), true);
      const reference = 'ZZZTEST001';
      const claim = db.doc(`payment_receipt_claims/${deterministicId('mpesa-receipt', `${tenant.id}:${reference}`)}`);
      assert.equal((await claim.get()).exists, false);
      await assert.rejects(db.runTransaction(tx => readReceiptBalance(tx, tenant.id, reference, branch.id), { readOnly: true }), /Enter the amount/);
      const preview = await db.runTransaction(tx => readReceiptBalance(tx, tenant.id, reference, branch.id, undefined, 100), { readOnly: true });
      assert.equal(preview.manualEntry, true); assert.equal(preview.verified, false); assert.equal(preview.availableMinor, 100);
      assert.equal((await claim.get()).exists, false);
    }
    const foreign = branches.docs.find(branch => branch.data().tenantId !== tenant.id);
    if (foreign) {
      assert.equal(internalReceiptEntryEnabled(control, tenant.id, foreign.id, Date.now(), foreign.data()), false);
      await assert.rejects(db.runTransaction(tx => readReceiptBalance(tx, tenant.id, 'ZZZTEST001', foreign.id), { readOnly: true }), /branch is unavailable/);
    }
    results.push({ tenantId: tenant.id, activeBranches: own.length, manualCodeAndAmount: true, noExpiry: true, receiptSavedOnlyOnPayment: true, otherBusinessBranchesRejected: true });
  }
  console.log(JSON.stringify({ readOnly: true, writes: 0, tenants: results }, null, 2));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(() => db.terminate());
