'use strict';
// Audited maintenance helper. No callable or cashier path changes receipt totals.
const assert = require('node:assert/strict');
const path = require('node:path');
const { createHash } = require('node:crypto');
const backend = require('node:module').createRequire(path.resolve(__dirname, '../../backend/functions/package.json'));
const { Timestamp, FieldValue } = backend('firebase-admin/firestore');
const id = (p, value) => `${p}-${createHash('sha256').update(value).digest('hex').slice(0, 48)}`;
const stable = v => v?.toMillis ? { timestampMs: v.toMillis() } : Array.isArray(v) ? v.map(stable)
  : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, stable(v[k])])) : v;
const fingerprint = v => createHash('sha256').update(JSON.stringify(stable(v))).digest('hex');

async function repairReceipt(db, plan, { apply = false, expectedHash } = {}) {
  const { tenantId, branchId, reference, saleId, paymentId, fromMinor, totalMinor, reopenMinor, archiveId, reason } = plan;
  assert.ok(reason && archiveId && tenantId && branchId);
  assert.equal(fromMinor - totalMinor, reopenMinor);
  assert.ok(Number.isSafeInteger(totalMinor) && totalMinor > 0 && reopenMinor > 0);
  const archiveRef = db.doc(`reconciliation_archives/${archiveId}`);
  const claimRef = db.doc(`payment_receipt_claims/${id('mpesa-receipt', `${tenantId}:${reference}`)}`);
  return db.runTransaction(async tx => {
    const [archive, claimDoc, saleDoc, ...proofs] = await tx.getAll(archiveRef, claimRef, db.doc(`sales/${saleId}`),
      db.doc(`mpesa_c2b_events/${id('c2b', `confirmation:${reference}`)}`),
      db.doc(`payment_intents/${id('intent', `${tenantId}:${reference}`)}`),
      db.doc(`mpesa_receipts/${id('mpesa-receipt', reference)}`));
    if (archive.exists) {
      assert.equal(archive.data().tenantId, tenantId);
      assert.equal(archive.data().reference, reference);
      assert.equal(archive.data().totalMinor, totalMinor);
      assert.equal(archive.data().saleId, saleId);
      return { ...archive.data().result, resumed: true };
    }
    const claim = claimDoc.data(), sale = saleDoc.data();
    assert.equal(claim?.tenantId, tenantId); assert.equal(claim.branchId, branchId);
    assert.equal(claim.verified, false); assert.equal(claim.amountSource, 'staff_recorded_receipt');
    assert.equal(claim.limitMinor, fromMinor); assert.equal(claim.allocatedMinor, fromMinor);
    assert.ok(proofs.every(d => !d.exists), 'Provider records appeared; review before correcting a manual receipt');
    assert.equal(sale?.tenantId, tenantId); assert.equal(sale.branchId, branchId);
    assert.equal(sale.invoiceNumber, plan.invoiceNumber); assert.equal(sale.staffId, plan.sellerStaffId);
    assert.notEqual(String(sale.status).toUpperCase(), 'VOIDED');
    const [used, ledger] = await Promise.all([
      tx.get(db.collection('payments').where('tenantId', '==', tenantId).where('reference', '==', reference)),
      tx.get(db.collection('payments').where('tenantId', '==', tenantId).where('saleId', '==', saleId)),
    ]);
    assert.equal(used.docs.reduce((sum, d) => sum + d.data().amountMinor, 0), fromMinor);
    assert.ok(used.docs.every(d => d.data().method === 'mpesa' && d.data().status === 'completed' && d.data().verified === false));
    const payment = used.docs.find(d => d.id === paymentId); assert.ok(payment);
    assert.equal(payment.data().saleId, saleId); assert.equal(payment.data().amountMinor, plan.paymentFromMinor);
    assert.ok(plan.paymentFromMinor > reopenMinor);
    const credits = ledger.docs.filter(d => d.data().method === 'credit');
    assert.equal(credits.length, 1);
    const credit = credits[0]; assert.ok(credit.data().settledAt);
    assert.equal(credit.data().settledReference, reference);
    assert.equal(credit.data().amountMinor, plan.paymentFromMinor);
    const records = { claim: claim, sale, payments: used.docs.map(d => ({ id: d.id, data: d.data() })),
      ledger: ledger.docs.map(d => ({ id: d.id, data: d.data() })) };
    const hash = fingerprint({ plan, records });
    const result = { reference, invoiceNumber: sale.invoiceNumber, saleId, totalMinor, allocatedMinor: totalMinor,
      reopenedMinor: reopenMinor, correctedPaymentMinor: plan.paymentFromMinor - reopenMinor, verified: false, hash };
    if (!apply) return { ...result, dryRun: true };
    assert.equal(expectedHash, hash, 'Records changed since the reviewed preview');
    const now = Timestamp.now();
    tx.create(archiveRef, { tenantId, branchId, reference, saleId, totalMinor, records, plan,
      sourceFingerprint: hash, createdAt: now, status: 'complete', result });
    tx.update(claimRef, { limitMinor: totalMinor, allocatedMinor: totalMinor, amountSource: 'reviewed_receipt',
      verified: false, reconciliationId: archiveId, correctedFromMinor: fromMinor, correctedByStaffId: 'user-owner',
      correctedAt: now, correctionReason: reason, updatedAt: now });
    for (const d of used.docs) {
      const row = d.data();
      const corrected = d.id === paymentId;
      tx.update(d.ref, { receiptLimitMinor: totalMinor, reconciliationId: archiveId, updatedAt: now,
        ...(corrected ? { amountMinor: result.correctedPaymentMinor, correctedFromMinor: row.amountMinor } : {}),
        ...(row.result ? { result: { ...row.result, receivedMinor: totalMinor, receiptLimitMinor: totalMinor,
          availableMinor: 0, ...(corrected ? { settledMinor: result.correctedPaymentMinor, outstandingMinor: reopenMinor } : {}),
          reconciliationId: archiveId } } : {}) });
    }
    tx.update(credit.ref, { amountMinor: reopenMinor, originalAmountMinor: credit.data().originalAmountMinor || credit.data().amountMinor,
      settledAt: FieldValue.delete(), settledByStaffId: FieldValue.delete(), settledMethod: FieldValue.delete(),
      settledReference: FieldValue.delete(), reopenedAt: now, reconciliationId: archiveId, updatedAt: now });
    tx.update(saleDoc.ref, { updatedAt: now, reconciliationId: archiveId });
    tx.create(db.doc(`audit_logs/${archiveId}`), { tenantId, branchId, actorStaffId: 'user-owner',
      action: 'receipt.overallocation_corrected', entityType: 'payment_receipt_claim', entityId: claimRef.id,
      metadata: { reference, fromMinor, toMinor: totalMinor, paymentId, saleId, reopenedMinor: reopenMinor, reason, archiveId }, createdAt: now });
    return result;
  });
}
module.exports = { repairReceipt };
