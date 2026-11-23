'use strict';

// Exact, user-reported split payment. Default is a read-only dry run.
const assert = require('node:assert/strict');
const path = require('node:path');
const { createHash } = require('node:crypto');
const backend = require('node:module').createRequire(path.resolve(__dirname, '../backend/functions/package.json'));
const { Timestamp } = backend('firebase-admin/firestore');
const { deterministicId } = require('../backend/functions/lib/shared/identifiers');

const tenantId = 'tenant-01', reference = 'UKL6537WE3', amountMinor = 170000;
const originalStaffId = 'staff-8735cb9d772eecaadcc5744fcb933a0558e9d3ea3b2f1875';
const billingStaffId = 'staff-de4eb312ca4ef474516705b1d9592ec10dd3d1765c6f5b8a';
const archiveId = 'linda-UKL6537WE3-20261121';
const rounds = [
  ['sale-9d0c3a317faa058eb23a8741944b777f8e85c04eadde6aa2', 'INV-BH001-003029', 35000, 'ORD-5-628411'],
  ['sale-d601f7b23f33a1bee7db9eabfb5f0f415ce2abbacc1a3f68', 'INV-BH001-003017', 15000, 'ORD-5-628411'],
  ['sale-f57c29231ee4fc4838d437feb2ebc0092147bafacfbb5a3d', 'INV-BH001-003042', 120000, 'ORD-55-861692'],
];
const stable = value => value?.toMillis ? { timestampMs: value.toMillis() }
  : Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
const fingerprint = value => createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');

async function reconcileReceipt(db, { apply = false, expectedHash } = {}) {
  assert.equal(rounds.reduce((sum, row) => sum + row[2], 0), amountMinor);
  const claimRef = db.doc(`payment_receipt_claims/${deterministicId('mpesa-receipt', `${tenantId}:${reference}`)}`);
  const archiveRef = db.doc(`reconciliation_archives/${archiveId}`);
  const auditRef = db.doc(`audit_logs/${archiveId}`);
  const targetId = rounds[2][0];
  const settlementRef = db.doc(`payments/${deterministicId('sale-settlement', `${tenantId}:${targetId}:${archiveId}`)}`);
  return db.runTransaction(async tx => {
    const [archive, claimDoc, newPayment, audit, event, intent] = await tx.getAll(archiveRef, claimRef, settlementRef, auditRef,
      db.doc(`mpesa_c2b_events/${deterministicId('c2b', `confirmation:${reference}`)}`),
      db.doc(`payment_intents/${deterministicId('intent', `${tenantId}:${reference}`)}`));
    if (archive.exists) {
      assert.equal(newPayment.data()?.amountMinor, 120000);
      assert.equal(newPayment.data()?.reference, reference);
      assert.equal(claimDoc.data()?.allocatedMinor, amountMinor);
      assert.deepEqual(new Set(claimDoc.data()?.targets), new Set(rounds.map(([id]) => `sale:${id}`)));
      assert.equal(audit.exists, true);
      return { result: 'already reconciled', archiveId, reference, allocatedKES: 1700 };
    }
    assert.equal(newPayment.exists, false); assert.equal(audit.exists, false);
    // A new provider confirmation requires re-review rather than overwriting it.
    assert.equal(event.exists, false, 'Provider confirmation changed; review the receipt again');
    assert.equal(intent.exists, false, 'Provider intent changed; review the receipt again');
    const claim = claimDoc.data();
    assert.equal(claim?.tenantId, tenantId); assert.equal(claim.reference, reference);
    assert.equal(claim.verified, false); assert.equal(claim.allocatedMinor, 50000); assert.equal(claim.limitMinor, 50000);
    assert.equal(claim.allocationId, 'checkout:6535de21-0dcc-40d9-90ee-f6d2775320d1');
    assert.deepEqual(new Set(claim.targets), new Set(rounds.slice(0, 2).map(([id]) => `sale:${id}`)));
    const [byReference, byProvider] = await Promise.all([
      tx.get(db.collection('payments').where('reference', '==', reference)),
      tx.get(db.collection('payments').where('providerTransactionId', '==', reference)),
    ]);
    const receiptDocs = [...new Map([...byReference.docs, ...byProvider.docs].map(doc => [doc.id, doc])).values()]
      .filter(doc => doc.data().tenantId === tenantId);
    assert.equal(receiptDocs.length, 2, 'Unexpected receipt allocation');
    const originals = [claimDoc, ...receiptDocs], sales = [], ledgers = [];
    for (const [id, invoice, total, order] of rounds) {
      const sale = await tx.get(db.doc(`sales/${id}`));
      const data = sale.data();
      assert.equal(data?.tenantId, tenantId); assert.equal(data.branchId, 'branch-nai-01');
      assert.equal(data.staffId, id === targetId ? billingStaffId : originalStaffId); assert.equal(data.invoiceNumber, invoice);
      assert.equal(data.orderReference, order); assert.equal(data.totalMinor, total);
      assert.notEqual(String(data.status).toUpperCase(), 'VOIDED');
      assert.ok(!data.proformaId && !data.etr && !data.etrReceiptId);
      assert.ok(Number(data.checkoutExpiresAt?.toMillis?.() || 0) < Date.now(), 'Checkout is in progress');
      const ledger = await tx.get(db.collection('payments').where('saleId', '==', id));
      const credit = ledger.docs.filter(doc => doc.data().method === 'credit');
      assert.equal(credit.length, 1); assert.equal(credit[0].data().amountMinor, total);
      assert.equal(ledger.size, id === targetId ? 1 : 2);
      if (id === targetId) assert.ok(!credit[0].data().settledAt, 'Linda bill is already paid');
      else {
        assert.ok(credit[0].data().settledAt); assert.equal(credit[0].data().settledReference, reference);
        const paid = receiptDocs.find(doc => doc.data().saleId === id);
        assert.ok(paid); assert.equal(paid.data().amountMinor, total);
        assert.equal(paid.data().method, 'mpesa'); assert.equal(paid.data().status, 'completed');
        assert.equal(paid.data().verified, false); assert.equal(paid.data().receiptAllocationId, claim.allocationId);
        assert.equal(paid.data().paidAt.toDate().toISOString().slice(0, 10), '2026-11-20');
      }
      originals.push(sale, ...ledger.docs); sales.push(sale); ledgers.push(credit[0]);
    }
    const records = [...new Map(originals.map(doc => [doc.ref.path, { path: doc.ref.path, data: doc.data() }])).values()]
      .sort((a, b) => a.path.localeCompare(b.path));
    const hash = fingerprint(records);
    const allocationId = `reconciliation:${archiveId}`;
    const originalPayment = receiptDocs.find(doc => doc.data().saleId === rounds[0][0]).data();
    const paidAt = originalPayment.paidAt;
    if (apply) {
      assert.equal(hash, expectedHash, 'Records changed since the reviewed dry run');
      const now = Timestamp.now();
      const reason = 'User supplied UKL6537WE3 SMS for KES 1700 paid to SAVAHOPE LIMITED 1 on 21 November 2026 at 00:47 EAT and requested the remaining KES 1200 clear Linda bill after KES 500 was used. Manual reconciliation; provider verification is absent.';
      tx.create(archiveRef, { tenantId, reference, records, sourceFingerprint: hash, createdAt: now,
        reason, authorization: 'User incident report and receipt screenshot, 2026-11-21', amountMinor,
        additionalAmountMinor: 120000, saleIds: rounds.map(([id]) => id) });
      // Preserve the historical KES 500; only its allocation metadata changes.
      for (const doc of receiptDocs) tx.update(doc.ref, { receiptAllocationId: allocationId,
        receiptLimitMinor: amountMinor, reconciliationId: archiveId, reconciledAt: now });
      tx.update(claimRef, { allocationId, allocatedMinor: amountMinor, limitMinor: amountMinor,
        targets: rounds.map(([id]) => `sale:${id}`), verified: false, updatedAt: now, reconciliationId: archiveId,
        amountSource: 'reviewed_receipt', branchId: 'branch-nai-01', paidAt });
      tx.update(ledgers[2].ref, { settledAt: now, settledMethod: 'mpesa', settledReference: reference,
        reconciliationId: archiveId, settlementSource: 'user_authorized_reconciliation' });
      const result = { paymentId: settlementRef.id, saleId: targetId, saleUuid: sales[2].data().idempotencyKey,
        method: 'mpesa', reference, settledMinor: 120000, receivedMinor: amountMinor, verified: false };
      tx.create(settlementRef, { tenantId, branchId: 'branch-nai-01', saleId: targetId, method: 'mpesa',
        amountMinor: 120000, reference, status: 'completed', source: 'sale_settlement', verified: false,
        receiptAllocationId: allocationId, receiptLimitMinor: amountMinor, paidAt, createdAt: now,
        receivedByStaffId: originalPayment.receivedByStaffId, reconciliationId: archiveId,
        reconciledBy: 'user_authorized_maintenance', receivedTimeSource: 'original_receipt_allocation', result });
      tx.create(auditRef, { tenantId, branchId: 'branch-nai-01', action: 'payment.split_receipt_reconciled',
        actorType: 'user_authorized_maintenance', entityId: targetId, createdAt: now,
        metadata: { reference, amountMinor, previouslyAllocatedMinor: 50000, additionalAmountMinor: 120000,
          saleIds: rounds.map(([id]) => id), archiveId, reason, verified: false } });
    }
    return { result: apply ? 'reconciled' : 'ready (dry run)', fingerprint: hash, reference,
      previouslyAllocatedKES: 500, additionalAllocationKES: 1200, totalAllocatedKES: 1700,
      invoices: rounds.map(([, invoice]) => invoice), verified: false, paidAt: paidAt.toDate().toISOString(), archiveId };
  });
}

async function verifyReconciliation(db) {
  const archive = (await db.doc(`reconciliation_archives/${archiveId}`).get()).data();
  assert.ok(archive, 'Reconciliation has not been applied');
  const sales = [], payments = [];
  for (const [id] of rounds) {
    const saleDoc = await db.doc(`sales/${id}`).get();
    sales.push({ id, ...saleDoc.data() });
    const original = archive.records.find(row => row.path === saleDoc.ref.path);
    assert.equal(fingerprint(saleDoc.data()), fingerprint(original.data), 'Sale changed during reconciliation');
    const ledger = await db.collection('payments').where('saleId', '==', id).get();
    payments.push(...ledger.docs.map(doc => ({ id: doc.id, ...doc.data() })));
    assert.ok(ledger.docs.filter(doc => doc.data().method === 'credit').every(doc => doc.data().settledAt));
  }
  const receipt = payments.filter(p => p.method === 'mpesa' && p.status === 'completed');
  assert.equal(receipt.length, 3);
  assert.deepEqual(receipt.map(p => p.amountMinor).sort((a,b) => a-b), [15000, 35000, 120000]);
  assert.ok(receipt.every(p => p.reference === reference && p.verified === false));
  for (const original of archive.records.filter(row => row.path.startsWith('payments/') && row.data.method === 'mpesa')) {
    const actual = receipt.find(p => `payments/${p.id}` === original.path);
    assert.equal(actual.amountMinor, original.data.amountMinor);
    assert.equal(actual.paidAt.toMillis(), original.data.paidAt.toMillis());
  }
  const claim = (await db.doc(`payment_receipt_claims/${deterministicId('mpesa-receipt', `${tenantId}:${reference}`)}`).get()).data();
  assert.equal(claim.allocatedMinor, amountMinor); assert.equal(claim.limitMinor, amountMinor);
  assert.equal(claim.verified, false); assert.equal(claim.targets.length, 3);
  const { financialSnapshot } = await import('../frontend/src/services/financial-snapshot.js');
  const report = (from, to) => financialSnapshot({ tenantId, from: Date.parse(from), to: Date.parse(to), serverSales: sales, serverPayments: payments });
  const originalDay = report('2026-11-20T06:00:00+03:00', '2026-11-21T05:59:59.999+03:00');
  const repairDay = report('2026-11-21T06:00:00+03:00', '2026-11-22T05:59:59.999+03:00');
  assert.equal(originalDay.collected, 1700); assert.equal(originalDay.paymentCount, 1);
  assert.equal(originalDay.unpaid, 0); assert.equal(repairDay.collected, 0);
  return { verified: true, reference, totalAllocatedKES: originalDay.collected,
    receiptCount: originalDay.paymentCount, outstandingKES: originalDay.unpaid,
    newMoneyOnRepairDateKES: repairDay.collected, providerVerified: false,
    invoices: sales.map(s => s.invoiceNumber), archiveId };
}

async function main() {
  const args = process.argv.slice(2);
  assert.equal(args[args.indexOf('--project') + 1], 'vanbransa-pos', 'Pass --project vanbransa-pos');
  assert.ok(args.includes('--project'));
  assert.ok(!process.env.FIRESTORE_EMULATOR_HOST, 'Production script cannot run with an emulator override');
  const apply = args.includes('--apply');
  const expectedHash = args.includes('--expected-hash') ? args[args.indexOf('--expected-hash') + 1] : undefined;
  if (apply) assert.match(expectedHash || '', /^[a-f0-9]{64}$/, 'Apply requires the reviewed dry-run fingerprint');
  const { initializeApp, applicationDefault } = backend('firebase-admin/app');
  const { getFirestore } = backend('firebase-admin/firestore');
  const app = initializeApp({ projectId: 'vanbransa-pos', credential: applicationDefault() });
  try {
    const db = getFirestore(app);
    console.log(JSON.stringify(args.includes('--verify') ? await verifyReconciliation(db)
      : await reconcileReceipt(db, { apply, expectedHash }), null, 2));
  }
  finally { await app.delete(); }
}

module.exports = { reconcileReceipt, verifyReconciliation, rounds, tenantId, reference, archiveId };
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
