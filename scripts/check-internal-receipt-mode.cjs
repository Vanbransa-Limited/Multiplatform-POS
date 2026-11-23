'use strict';
// Read-only verification: previews never reserve a code or record money.
process.env.GCLOUD_PROJECT = 'vanbransa-pos';
const assert = require('node:assert/strict');
const { db } = require('../backend/functions/lib/lib/firebase');
const { readReceiptBalance, internalReceiptEntryEnabled } = require('../backend/functions/lib/modules/sales/receipt-balance');
const { deterministicId } = require('../backend/functions/lib/shared/identifiers');
async function main() {
  const control = (await db.collection('mpesa_receipt_controls').doc('tenant-01').get()).data();
  assert.equal(control?.mode, 'internal');
  const ongoing = process.argv.includes('--ongoing');
  const recordedOnly = process.argv.includes('--recorded-only');
  if (recordedOnly) assert.equal(control.entryMode, 'recorded_only');
  if (ongoing) {
    assert.equal(control.duration, 'ongoing'); assert.equal(control.until, null);
    const branch = (await db.doc('branches/branch-nai-01').get()).data();
    assert.equal(internalReceiptEntryEnabled(control, 'tenant-01', 'branch-nai-01', Date.UTC(2050, 0, 1), branch), true);
    assert.ok((await db.doc(`audit_logs/${control.authorizationId}`).get()).exists);
  } else assert.equal(control.until.toMillis(), Date.parse('2026-11-22T06:00:00+03:00'));
  const preview = code => db.runTransaction(tx => readReceiptBalance(tx, 'tenant-01', code, 'branch-nai-01'), { readOnly: true });
  for (const code of ['UKL6537WE3', 'UKLDQ29EAJ']) assert.equal((await preview(code)).availableMinor, 0);
  const ledger = await db.collection('payments').where('tenantId', '==', 'tenant-01').get();
  const legacy = ledger.docs.find(doc => {
    const row = doc.data();
    return row.method === 'mpesa' && row.verified === false && /^[A-Z0-9]{10}$/.test(row.reference || '')
      && (row.createdAt?.toMillis?.() || 0) < control.enabledAt.toMillis()
      && ['completed', 'paid', 'success'].includes(String(row.status || 'completed').toLowerCase());
  });
  assert.ok(legacy);
  assert.equal((await preview(legacy.data().reference)).availableMinor, 0, 'An existing ledger reference became fresh money');
  const reference = 'ZZZTEST001';
  const ref = db.collection('payment_receipt_claims').doc(deterministicId('mpesa-receipt', `tenant-01:${reference}`));
  assert.equal((await ref.get()).exists, false);
  if (recordedOnly) {
    await assert.rejects(preview(reference), /No saved M-Pesa payment/);
    await assert.rejects(db.runTransaction(tx => readReceiptBalance(tx, 'tenant-01', reference, 'branch-nai-01', undefined, 100), { readOnly: true }), /No saved M-Pesa payment/);
  } else {
    await assert.rejects(preview(reference), /Enter the amount on the receipt/);
    const fresh = await db.runTransaction(tx => readReceiptBalance(tx, 'tenant-01', reference, 'branch-nai-01', undefined, 100), { readOnly: true });
    assert.equal(fresh.availableMinor, 100); assert.equal(fresh.verified, false); assert.equal(fresh.manualEntry, true);
  }
  assert.equal((await ref.get()).exists, false, 'A read-only preview wrote to the register');
  console.log(JSON.stringify({ internalModeEnabled: true, duration: ongoing ? 'ongoing' : 'temporary',
    untilNairobi: ongoing ? null : '22 November 2026, 06:00 EAT',
    reconciledReferencesStillExhausted: true, historicalLedgerReferenceStillExhausted: true,
    ...(recordedOnly ? { recordedAmountsOnly: true, unknownCodesRejected: true, suppliedAmountCannotCreateReceipt: true }
      : { newReferenceRequiresAmount: true, newReferencePreviewUnverified: true }), previewWrites: 0 }));
  await db.terminate();
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
