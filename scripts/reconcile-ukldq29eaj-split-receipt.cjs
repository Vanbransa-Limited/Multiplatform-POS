'use strict';

// Exact seven-bill receipt supplied by the user. Default is read-only.
const assert = require('node:assert/strict');
const path = require('node:path');
const { createHash } = require('node:crypto');
const backend = require('node:module').createRequire(path.resolve(__dirname, '../backend/functions/package.json'));
const { Timestamp } = backend('firebase-admin/firestore');
const { deterministicId } = require('../backend/functions/lib/shared/identifiers');
const plan = require('./incidents/ukldq29eaj-plan.json');
const { tenantId, branchId, reference, amountMinor, previouslyAllocatedMinor, archiveId } = plan;
const allocationId = `reconciliation:${archiveId}`;
const stable = value => value?.toMillis ? { timestampMs: value.toMillis() }
  : Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
const fingerprint = value => createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
const successful = row => ['completed', 'paid', 'success'].includes(String(row.status || 'completed').toLowerCase());
const setEqual = (actual, expected, message) => assert.deepEqual(new Set(actual), new Set(expected), message);
const paymentId = saleId => deterministicId('sale-settlement', `${tenantId}:${saleId}:${archiveId}`);
const claimId = deterministicId('mpesa-receipt', `${tenantId}:${reference}`);
const originalSales = plan.sales.filter(s => s.alreadyPaid);
const additionalSales = plan.sales.filter(s => !s.alreadyPaid);

function isReviewedHistoricalPrompt(attempt, invoiceNumber) {
  const expected = plan.preservedHistoricalPrompt;
  const row = attempt.data();
  return attempt.id === expected.id && invoiceNumber === expected.invoiceNumber
    && row?.tenantId === tenantId && row.status === expected.status && row.amountMinor === expected.amountMinor
    && row.requestedAt?.toMillis() === expected.requestedAtMillis && !row.receipt && !row.completedAt
    && !row.settledSaleId && !row.settledMinor;
}

function validatePlan() {
  assert.equal(reference, 'UKLDQ29EAJ');
  assert.equal(amountMinor, 6265000);
  assert.equal(previouslyAllocatedMinor, 3443000);
  assert.equal(plan.sales.length, 21);
  assert.equal(new Set(plan.sales.map(s => s.id)).size, plan.sales.length);
  assert.equal(originalSales.length, 10);
  assert.equal(additionalSales.reduce((sum, s) => sum + s.totalMinor, 0), 2822000);
  assert.equal(originalSales.reduce((sum, s) => sum + s.totalMinor, 0), previouslyAllocatedMinor);
  for (const [order, total] of Object.entries(plan.orderTotals)) {
    assert.equal(plan.sales.filter(s => s.orderReference === order).reduce((sum, s) => sum + s.totalMinor, 0), total);
  }
  assert.equal(Object.values(plan.orderTotals).reduce((sum, total) => sum + total, 0), amountMinor);
}

async function reconcileReceipt(db, { apply = false, expectedHash } = {}) {
  validatePlan();
  const claimRef = db.doc(`payment_receipt_claims/${claimId}`);
  const archiveRef = db.doc(`reconciliation_archives/${archiveId}`);
  const auditRef = db.doc(`audit_logs/${archiveId}`);
  return db.runTransaction(async tx => {
    const [archive, claimDoc, auditDoc, eventDoc, intentDoc] = await tx.getAll(archiveRef, claimRef, auditRef,
      db.doc(`mpesa_c2b_events/${deterministicId('c2b', `confirmation:${reference}`)}`),
      db.doc(`payment_intents/${deterministicId('intent', `${tenantId}:${reference}`)}`));
    if (archive.exists) {
      assert.equal(archive.data().sourceFingerprint, expectedHash || archive.data().sourceFingerprint);
      assert.equal(claimDoc.data()?.allocatedMinor, amountMinor);
      assert.equal(auditDoc.exists, true);
      const recorded = await tx.getAll(...additionalSales.map(s => db.doc(`payments/${paymentId(s.id)}`)));
      recorded.forEach((doc, i) => {
        assert.equal(doc.data()?.amountMinor, additionalSales[i].totalMinor);
        assert.equal(doc.data()?.reference, reference);
      });
      return { result: 'already reconciled', reference, archiveId, allocatedKES: amountMinor / 100 };
    }
    assert.equal(auditDoc.exists, false);
    assert.equal(eventDoc.exists, false, 'Provider confirmation changed; review again');
    assert.equal(intentDoc.exists, false, 'Provider intent changed; review again');
    const claim = claimDoc.data();
    assert.equal(claim?.tenantId, tenantId);
    assert.equal(claim.reference, reference);
    assert.equal(claim.verified, false);
    assert.equal(claim.allocatedMinor, previouslyAllocatedMinor);
    assert.equal(claim.limitMinor, previouslyAllocatedMinor);
    assert.equal(claim.allocationId, plan.originalAllocationId);
    setEqual(claim.targets, originalSales.map(s => `sale:${s.id}`), 'Original receipt targets changed');

    const byCode = await tx.get(db.collection('payments').where('reference', '==', reference));
    const byProvider = await tx.get(db.collection('payments').where('providerTransactionId', '==', reference));
    const receiptDocs = [...new Map([...byCode.docs, ...byProvider.docs].map(doc => [doc.id, doc])).values()]
      .filter(doc => doc.data().tenantId === tenantId);
    assert.equal(receiptDocs.length, originalSales.length, 'Unexpected receipt use');
    assert.equal(receiptDocs.reduce((sum, doc) => sum + doc.data().amountMinor, 0), previouslyAllocatedMinor);
    setEqual(receiptDocs.map(doc => doc.data().saleId), originalSales.map(s => s.id));
    const originals = [claimDoc, ...receiptDocs];
    // Recheck complete table membership, not just matching amounts.
    const excludedVoids = [];
    for (const order of Object.keys(plan.orderTotals)) {
      const table = await tx.get(db.collection('sales').where('orderReference', '==', order));
      const mine = table.docs.filter(doc => doc.data().tenantId === tenantId && doc.data().branchId === branchId);
      setEqual(mine.filter(doc => String(doc.data().status).toUpperCase() !== 'VOIDED').map(doc => doc.id),
        plan.sales.filter(s => s.orderReference === order).map(s => s.id), `Bill ${order} changed`);
      for (const doc of mine.filter(doc => String(doc.data().status).toUpperCase() === 'VOIDED')) {
        excludedVoids.push(doc.id);
        originals.push(doc);
        const ledger = await tx.get(db.collection('payments').where('saleId', '==', doc.id));
        originals.push(...ledger.docs);
      }
    }
    const newAllocations = [];
    for (const expected of plan.sales) {
      const saleDoc = await tx.get(db.doc(`sales/${expected.id}`));
      const sale = saleDoc.data();
      assert.ok(saleDoc.exists);
      assert.equal(sale.tenantId, tenantId); assert.equal(sale.branchId, branchId);
      for (const field of ['invoiceNumber', 'orderReference', 'totalMinor', 'staffId', 'idempotencyKey']) {
        assert.equal(sale[field], expected[field], `Invoice ${expected.invoiceNumber} changed ${field}`);
      }
      assert.notEqual(String(sale.status).toUpperCase(), 'VOIDED');
      assert.ok(!sale.proformaId && !sale.etr && !sale.etrReceiptId);
      assert.ok(Number(sale.checkoutExpiresAt?.toMillis?.() || 0) < Date.now(), 'Checkout in progress');
      if (sale.checkoutStkKey) {
        const attempt = await tx.get(db.doc(`mpesa_payments/${deterministicId('mpesa-attempt', `${tenantId}:${sale.checkoutStkKey}`)}`));
        // The exact reviewed 14 November prompt is still unconfirmed. A typed
        // receipt may settle this bill without pretending that prompt failed
        // or succeeded. Preserve the prompt and its audit unchanged.
        assert.ok(!attempt.exists || ['failed', 'cancelled', 'expired'].includes(attempt.data().status)
          || isReviewedHistoricalPrompt(attempt, expected.invoiceNumber), `Reconcile the outstanding payment attempt on ${expected.invoiceNumber} first`);
        if (attempt.exists) originals.push(attempt);
      }
      const ledger = await tx.get(db.collection('payments').where('saleId', '==', expected.id));
      const credits = ledger.docs.filter(doc => doc.data().method === 'credit');
      assert.equal(credits.length, 1);
      assert.equal(credits[0].data().tenantId, tenantId);
      assert.equal(credits[0].data().amountMinor, expected.totalMinor);
      assert.ok(successful(credits[0].data()));
      if (expected.alreadyPaid) {
        assert.equal(ledger.size, 2);
        assert.ok(credits[0].data().settledAt);
        assert.equal(credits[0].data().settledReference, reference);
        const paid = receiptDocs.find(doc => doc.data().saleId === expected.id);
        assert.ok(paid); assert.equal(paid.data().method, 'mpesa');
        assert.equal(paid.data().amountMinor, expected.totalMinor);
        assert.equal(paid.data().reference, reference);
        assert.equal(paid.data().verified, false); assert.ok(successful(paid.data()));
        assert.equal(paid.data().receiptAllocationId, plan.originalAllocationId);
        assert.equal(paid.data().paidAt.toDate().toISOString().slice(0, 10), '2026-11-20');
      } else {
        assert.equal(ledger.size, 1, `Invoice ${expected.invoiceNumber} has another payment`);
        assert.ok(!credits[0].data().settledAt, `Invoice ${expected.invoiceNumber} is already paid`);
        const newRef = db.doc(`payments/${paymentId(expected.id)}`);
        assert.equal((await tx.get(newRef)).exists, false);
        newAllocations.push({ expected, creditRef: credits[0].ref, newRef });
      }
      const stock = await tx.get(db.collection('stock_movements').where('referenceId', '==', expected.id));
      originals.push(saleDoc, ...ledger.docs, ...stock.docs);
    }
    const records = [...new Map(originals.map(doc => [doc.ref.path, { path: doc.ref.path, data: doc.data() }])).values()]
      .sort((a, b) => a.path.localeCompare(b.path));
    const hash = fingerprint(records);
    const firstPayment = receiptDocs.reduce((first, doc) => doc.data().paidAt.toMillis() < first.paidAt.toMillis() ? doc.data() : first, receiptDocs[0].data());
    const paidAt = firstPayment.paidAt;
    assert.ok(firstPayment.receivedByStaffId);
    if (apply) {
      assert.equal(expectedHash, hash, 'Records changed since the reviewed dry run');
      const now = Timestamp.now();
      const reason = 'User supplied UKLDQ29EAJ SMS showing KES 62,650 paid to SAVAHOPE LIMITED 1 on 21 November 2026 at 01:20 EAT and calculator/table screenshots allocating it to seven bills. KES 34,430 was already applied to Table 50. Allocate the remaining KES 28,220 to the six identified bills. Manual reconciliation; provider verification is absent.';
      tx.create(archiveRef, { tenantId, branchId, reference, amountMinor, previouslyAllocatedMinor,
        additionalAmountMinor: amountMinor - previouslyAllocatedMinor, sourceFingerprint: hash, records,
        saleIds: plan.sales.map(s => s.id), excludedVoids, reason,
        authorization: 'User receipt, calculator and table screenshots, 2026-11-21',
        preservedHistoricalPrompt: plan.preservedHistoricalPrompt, createdAt: now });
      for (const doc of receiptDocs) tx.update(doc.ref, { receiptAllocationId: allocationId,
        receiptLimitMinor: amountMinor, reconciliationId: archiveId, reconciledAt: now });
      tx.update(claimRef, { allocationId, allocatedMinor: amountMinor, limitMinor: amountMinor,
        targets: plan.sales.map(s => `sale:${s.id}`), verified: false, amountSource: 'reviewed_receipt',
        branchId, paidAt, updatedAt: now, reconciliationId: archiveId });
      let allocatedMinor = previouslyAllocatedMinor;
      for (const { expected, creditRef, newRef } of newAllocations) {
        allocatedMinor += expected.totalMinor;
        const result = { paymentId: newRef.id, saleId: expected.id, saleUuid: expected.idempotencyKey,
          method: 'mpesa', reference, settledMinor: expected.totalMinor, receivedMinor: amountMinor,
          outstandingMinor: 0, availableMinor: amountMinor - allocatedMinor, verified: false,
          receiptAllocationId: allocationId, receiptLimitMinor: amountMinor };
        tx.update(creditRef, { settledAt: now, settledMethod: 'mpesa', settledReference: reference,
          reconciliationId: archiveId, settlementSource: 'user_authorized_reconciliation' });
        tx.create(newRef, { tenantId, branchId, saleId: expected.id, method: 'mpesa', reference,
          amountMinor: expected.totalMinor, status: 'completed', verified: false, source: 'sale_settlement',
          paidAt, createdAt: now, receivedByStaffId: firstPayment.receivedByStaffId,
          receiptAllocationId: allocationId, receiptLimitMinor: amountMinor, reconciliationId: archiveId,
          receivedTimeSource: 'original_receipt_allocation', reconciledBy: 'user_authorized_maintenance', result });
      }
      assert.equal(allocatedMinor, amountMinor);
      tx.create(auditRef, { tenantId, branchId, action: 'payment.split_receipt_reconciled',
        actorType: 'user_authorized_maintenance', entityId: claimRef.id, createdAt: now,
        metadata: { reference, amountMinor, previouslyAllocatedMinor,
          additionalAmountMinor: amountMinor - previouslyAllocatedMinor, archiveId, reason, verified: false,
          orderTotals: plan.orderTotals, saleIds: plan.sales.map(s => s.id) } });
    }
    return { result: apply ? 'reconciled' : 'ready (dry run)', reference, fingerprint: hash, archiveId,
      previouslyAllocatedKES: previouslyAllocatedMinor / 100, additionalAllocationKES: (amountMinor - previouslyAllocatedMinor) / 100,
      totalAllocatedKES: amountMinor / 100, roundCount: plan.sales.length, newAllocations: newAllocations.length,
      orderTotalsKES: Object.fromEntries(Object.entries(plan.orderTotals).map(([order, minor]) => [order, minor / 100])),
      excludedVoids, providerVerified: false, paidAt: paidAt.toDate().toISOString() };
  });
}

async function verifyReconciliation(db) {
  validatePlan();
  const archive = (await db.doc(`reconciliation_archives/${archiveId}`).get()).data();
  assert.ok(archive, 'Reconciliation has not been applied');
  const originals = new Map(archive.records.map(record => [record.path, record.data]));
  const sales = [], payments = [];
  for (const expected of plan.sales) {
    const sale = await db.doc(`sales/${expected.id}`).get();
    assert.equal(fingerprint(sale.data()), fingerprint(originals.get(sale.ref.path)), 'Sale changed');
    sales.push({ id: sale.id, ...sale.data() });
    const ledger = await db.collection('payments').where('saleId', '==', expected.id).get();
    const credits = ledger.docs.filter(doc => doc.data().method === 'credit');
    assert.equal(credits.length, 1); assert.ok(credits[0].data().settledAt);
    assert.equal(credits[0].data().settledReference, reference);
    if (expected.alreadyPaid) assert.equal(fingerprint(credits[0].data()), fingerprint(originals.get(credits[0].ref.path)));
    else {
      const { settledAt, settledMethod, settledReference, reconciliationId, settlementSource, ...remaining } = credits[0].data();
      assert.equal(fingerprint(remaining), fingerprint(originals.get(credits[0].ref.path)), 'Credit changed beyond its settlement');
    }
    payments.push(...ledger.docs.map(doc => ({ id: doc.id, ...doc.data() })));
    const stock = await db.collection('stock_movements').where('referenceId', '==', expected.id).get();
    const originalStock = archive.records.filter(r => r.path.startsWith('stock_movements/') && r.data.referenceId === expected.id);
    setEqual(stock.docs.map(doc => doc.ref.path), originalStock.map(r => r.path), 'Stock movements changed');
    for (const movement of stock.docs) assert.equal(fingerprint(movement.data()), fingerprint(originals.get(movement.ref.path)));
  }
  for (const row of archive.records.filter(r => r.path.startsWith('sales/') && archive.excludedVoids.includes(r.path.split('/')[1])
    || r.path.startsWith('payments/') && archive.excludedVoids.includes(r.data.saleId))) {
    assert.equal(fingerprint((await db.doc(row.path).get()).data()), fingerprint(row.data), 'Excluded void changed');
  }
  for (const row of archive.records.filter(r => r.path.startsWith('mpesa_payments/'))) {
    assert.equal(fingerprint((await db.doc(row.path).get()).data()), fingerprint(row.data), 'Historical prompt changed');
  }
  const receipt = payments.filter(p => p.method === 'mpesa' && successful(p));
  assert.equal(receipt.length, 21);
  assert.equal(receipt.reduce((sum, p) => sum + p.amountMinor, 0), amountMinor);
  assert.ok(receipt.every(p => p.reference === reference && p.verified === false && p.receiptAllocationId === allocationId && p.receiptLimitMinor === amountMinor));
  for (const row of archive.records.filter(r => r.path.startsWith('payments/') && r.data.method === 'mpesa')) {
    const actual = receipt.find(p => `payments/${p.id}` === row.path);
    const { receiptAllocationId, receiptLimitMinor, reconciliationId, reconciledAt, ...untouched } = actual;
    const { receiptAllocationId: oldAllocation, receiptLimitMinor: oldLimit, ...before } = row.data;
    delete untouched.id;
    assert.equal(fingerprint(untouched), fingerprint(before), 'Original receipt money or attribution changed');
  }
  const claim = (await db.doc(`payment_receipt_claims/${claimId}`).get()).data();
  assert.equal(claim.allocatedMinor, amountMinor); assert.equal(claim.limitMinor, amountMinor);
  assert.equal(claim.verified, false); setEqual(claim.targets, plan.sales.map(s => `sale:${s.id}`));
  const code = await db.collection('payments').where('reference', '==', reference).get();
  assert.equal(code.docs.filter(doc => doc.data().tenantId === tenantId).length, 21);
  const { financialSnapshot } = await import('../frontend/src/services/financial-snapshot.js');
  const report = (from, to) => financialSnapshot({ tenantId, from: Date.parse(from), to: Date.parse(to), serverSales: sales, serverPayments: payments });
  const originalDay = report('2026-11-20T06:00:00+03:00', '2026-11-21T05:59:59.999+03:00');
  const correctionDay = report('2026-11-21T06:00:00+03:00', '2026-11-22T05:59:59.999+03:00');
  assert.equal(originalDay.collected, 62650); assert.equal(originalDay.paymentCount, 1);
  assert.equal(originalDay.unpaid, 0); assert.equal(correctionDay.collected, 0);
  assert.equal((await db.doc(`audit_logs/${archiveId}`).get()).exists, true);
  return { verified: true, reference, receiptCount: 1, totalAllocatedKES: 62650, outstandingKES: 0,
    newMoneyOnCorrectionDayKES: 0, providerVerified: false, stockUnchanged: true,
    excludedVoidsUnchanged: archive.excludedVoids, bills: Object.keys(plan.orderTotals).length,
    saleRounds: receipt.length, preservedUnconfirmedPrompt: plan.preservedHistoricalPrompt.id, archiveId };
}

async function main() {
  const args = process.argv.slice(2);
  assert.ok(args.includes('--project'));
  assert.equal(args[args.indexOf('--project') + 1], 'vanbransa-pos', 'Pass --project vanbransa-pos');
  assert.ok(!process.env.FIRESTORE_EMULATOR_HOST, 'Cannot run this production correction on an emulator');
  const apply = args.includes('--apply');
  const expectedHash = args.includes('--expected-hash') ? args[args.indexOf('--expected-hash') + 1] : undefined;
  if (apply) assert.match(expectedHash || '', /^[a-f0-9]{64}$/, 'Apply requires the reviewed source fingerprint');
  const { initializeApp, applicationDefault } = backend('firebase-admin/app');
  const { getFirestore } = backend('firebase-admin/firestore');
  const app = initializeApp({ projectId: 'vanbransa-pos', credential: applicationDefault() });
  try {
    const db = getFirestore(app);
    console.log(JSON.stringify(args.includes('--verify') ? await verifyReconciliation(db)
      : await reconcileReceipt(db, { apply, expectedHash }), null, 2));
  } finally { await app.delete(); }
}
module.exports = { reconcileReceipt, verifyReconciliation, validatePlan, isReviewedHistoricalPrompt, plan };
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
