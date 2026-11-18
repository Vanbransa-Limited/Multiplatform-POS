'use strict';
// One explicitly confirmed purchase, three historical invoice attempts.
// Default is read-only. Apply requires the reviewed dry-run fingerprint.
const path = require('node:path');
const { createHash } = require('node:crypto');
const backend = require('node:module').createRequire(path.resolve(__dirname, '../backend/functions/package.json'));
const { initializeApp, applicationDefault } = backend('firebase-admin/app');
const { getFirestore, Timestamp } = backend('firebase-admin/firestore');
const { deterministicId } = require('../backend/functions/lib/shared/identifiers');
const assert = require('node:assert/strict');
const tenantId = 'tenant-01', reference = 'UIPMJ8EEBT', amountMinor = 105000;
const staffId = 'staff-8735cb9d772eecaadcc5744fcb933a0558e9d3ea3b2f1875';
const attemptId = 'mpesa-attempt-2cf887e3b4a5a26dff7ec77444092a01d0d3720c45a9b3c3';
const rows = [
  ['INV-BH001-000537', 'sale-8c8135ab8dd377ec9866f410680e1c69033aa34b869c33ae', 'sale-settlement-d12349417d61e4999c5004f5d93077fe97c50bf1a7b3ddfc'],
  ['INV-BH001-000538', 'sale-cc3ecd760488cec57c42a70d392045bacc9489374ca1b024', 'sale-settlement-909da8a3ed81a2fd8785eef5451839f58a78e3f7c9654355'],
  ['INV-BH001-000540', 'sale-0eaead2446cd9f33bc40bff6e559d3b96525f7d405bd7761', 'sale-settlement-ca786c7e0ad1a5fe91a8cef5fd4a1bc1452c246a85246c67'],
];
const sorted = value => value?.toMillis ? { timestampMs: value.toMillis() }
  : Array.isArray(value) ? value.map(sorted) : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])])) : value;
const fingerprint = records => createHash('sha256').update(JSON.stringify(sorted(records))).digest('hex');
const lineSignature = docs => docs.map(doc => { const d = doc.data(); return [d.productId, d.qty, d.unitPriceMinor]; })
  .sort((a, b) => a[0].localeCompare(b[0]));
async function main() {
  const args = process.argv.slice(2), apply = args.includes('--apply');
  if (!args.includes('--project') || args[args.indexOf('--project') + 1] !== 'vanbransa-pos') throw new Error('Explicit --project vanbransa-pos required.');
  const expectedHash = args.includes('--expected-hash') ? args[args.indexOf('--expected-hash') + 1] : null;
  if (apply && (!args.includes('--confirmed-duplicates-one-purchase') || !expectedHash)) throw new Error('Apply requires confirmed duplicate purchase and reviewed --expected-hash.');
  const app = initializeApp({ projectId: 'vanbransa-pos', credential: applicationDefault() });
  const db = getFirestore(app), canonicalId = rows[0][1];
  const archiveRef = db.collection('reconciliation_archives').doc('titanium-kester-UIPMJ8EEBT-20261118');
  const intentRef = db.collection('payment_intents').doc(deterministicId('intent', `${tenantId}:${reference}`));
  const claimRef = db.collection('payment_receipt_claims').doc(deterministicId('mpesa-receipt', `${tenantId}:${reference}`));
  try {
    const result = await db.runTransaction(async tx => {
      const archive = await tx.get(archiveRef);
      if (archive.exists) return { result: 'already reconciled', canonicalInvoice: rows[0][0], archiveId: archive.id };
      const [attemptDoc, intentDoc, claimDoc] = await tx.getAll(db.collection('mpesa_payments').doc(attemptId), intentRef, claimRef);
      const attempt = attemptDoc.data(), intent = intentDoc.data();
      assert.equal(attempt?.tenantId, tenantId); assert.equal(attempt.status, 'paid'); assert.equal(attempt.receipt, reference);
      assert.equal(attempt.amountMinor, amountMinor); assert.equal(attempt.staffId, staffId);
      assert.equal(attempt.branchId, 'branch-nai-01'); assert.equal(attempt.deviceId, 'device-till-01');
      assert.equal(intent?.status, 'verified'); assert.equal(intent.consumedSaleId, null);
      assert.equal(intent.tenantId, tenantId); assert.equal(intent.attemptId, attemptId); assert.equal(intent.amountMinor, amountMinor);
      assert.equal(claimDoc.exists, false); assert.equal(Number(attempt.settledMinor || 0), 0);
      const [receiptPayments, providerPayments] = await Promise.all([
        tx.get(db.collection('payments').where('reference', '==', reference)),
        tx.get(db.collection('payments').where('providerTransactionId', '==', reference)),
      ]);
      const receiptDocs = [...new Map([...receiptPayments.docs, ...providerPayments.docs].map(doc => [doc.id, doc])).values()];
      const active = receiptDocs.filter(doc => doc.data().tenantId === tenantId && doc.data().status === 'completed');
      assert.deepEqual(active.map(doc => doc.id).sort(), rows.map(row => row[2]).sort());
      const originals = [attemptDoc, intentDoc, ...receiptDocs];
      const groups = [];
      for (const [invoice, saleId, paymentId] of rows) {
        const saleDoc = await tx.get(db.collection('sales').doc(saleId));
        const sale = saleDoc.data();
        assert.equal(sale?.tenantId, tenantId); assert.equal(sale.invoiceNumber, invoice);
        assert.equal(sale.totalMinor, amountMinor); assert.equal(sale.staffId, staffId);
        assert.equal(sale.branchId, 'branch-nai-01'); assert.equal(sale.deviceId, 'device-till-01');
        assert.notEqual(String(sale.status).toUpperCase(), 'VOIDED'); assert.equal(Boolean(sale.proformaId), false);
        assert.ok(!sale.etr && !sale.etrReceiptId && !['fiscalized', 'signed'].includes(String(sale.fiscalStatus).toLowerCase()), 'Fiscal receipt needs separate reviewed correction');
        assert.equal(sale.soldAt.toDate().toISOString().slice(0, 10), '2026-09-25');
        assert.ok(Number(sale.checkoutExpiresAt?.toMillis?.() || 0) < Date.now(), 'Payment in progress');
        assert.deepEqual(sale.stockBalanceIds || [], []);
        const [ledger, lines, movements] = await Promise.all([
          tx.get(db.collection('payments').where('saleId', '==', saleId)),
          tx.get(db.collection('sale_lines').where('saleId', '==', saleId)),
          tx.get(db.collection('stock_movements').where('referenceId', '==', saleId)),
        ]);
        assert.equal(movements.empty, true, 'Tracked stock needs a separate reviewed restoration');
        assert.equal(ledger.size, 2);
        const creditDoc = ledger.docs.find(doc => doc.data().method === 'credit');
        const paymentDoc = ledger.docs.find(doc => doc.id === paymentId);
        assert.ok(creditDoc && paymentDoc); assert.equal(creditDoc.data().amountMinor, amountMinor);
        assert.ok(creditDoc.data().settledAt);
        const payment = paymentDoc.data();
        assert.equal(payment.method, 'mpesa'); assert.equal(payment.reference, reference);
        assert.equal(payment.amountMinor, amountMinor); assert.equal(payment.verified, false);
        assert.equal(payment.source, 'sale_settlement'); assert.equal(payment.status, 'completed');
        assert.equal(payment.paidAt.toDate().toISOString().slice(0, 10), '2026-11-18');
        originals.push(saleDoc, ...ledger.docs, ...lines.docs);
        groups.push({ saleDoc, creditDoc, paymentDoc, lines });
      }
      const expectedLines = [
        ['product-7270719db8abe9c2e921df1c9cb2f4cfdfb39fa1cee19fed', 1, 25000],
        ['product-8edaea64e5d6a65b58a7bc8bd51065ccd0f82a0af4fdb329', 2, 20000],
        ['product-ac341d6afca1af1cf77ab1e576e40eec9c18c68f7fb0a221', 1, 40000],
      ];
      for (const group of groups) assert.deepEqual(lineSignature(group.lines.docs), expectedLines);
      assert.deepEqual(intent.lines.map(line => [line.productId, line.qty]).sort((a,b) => a[0].localeCompare(b[0])), expectedLines.map(line => line.slice(0,2)));
      const paidAt = attempt.completedAt;
      assert.ok(paidAt?.toMillis()); assert.equal(paidAt.toDate().toISOString().slice(0,10), '2026-09-25');
      const records = [...new Map(originals.map(doc => [doc.ref.path, { path: doc.ref.path, data: doc.data() }])).values()].sort((a,b) => a.path.localeCompare(b.path));
      const hash = fingerprint(records);
      if (apply) {
        assert.equal(hash, expectedHash, 'Production records changed after review; dry-run again');
        const now = Timestamp.now(), reason = 'User confirmed duplicate attempts for one purchase; original provider receipt retained once. No refund or new money received.';
        tx.create(archiveRef, { tenantId, reference, reason, sourceFingerprint: hash, records, createdAt: now,
          canonicalSaleId: canonicalId, duplicateSaleIds: rows.slice(1).map(row => row[1]), authorization: 'User confirmation in conversation, 2026-11-18' });
        groups.forEach((group, index) => {
          const marker = { reconciliationId: archiveRef.id, reconciledAt: now };
          if (index === 0) {
            tx.update(group.paymentDoc.ref, { ...marker, paidAt, verified: true, providerTransactionId: reference,
              attemptId, result: { ...group.paymentDoc.data().result, verified: true, receivedMinor: amountMinor } });
            tx.update(group.saleDoc.ref, { ...marker, checkoutId: null, checkoutStaffId: null, checkoutDeviceId: null, checkoutStkKey: null, checkoutExpiresAt: null });
          } else {
            tx.update(group.saleDoc.ref, { ...marker, status: 'VOIDED', duplicateOfSaleId: canonicalId, voidedAt: now, voidReason: reason,
              checkoutId: null, checkoutStaffId: null, checkoutDeviceId: null, checkoutStkKey: null, checkoutExpiresAt: null });
            for (const doc of [group.paymentDoc, group.creditDoc]) tx.update(doc.ref, { ...marker, status: 'voided', voidedAt: now, duplicateOfSaleId: canonicalId });
          }
        });
        tx.update(intentRef, { status: 'consumed', consumedSaleId: canonicalId, settlementAttemptId: attemptId, consumedAt: now, reconciliationId: archiveRef.id });
        tx.update(attemptDoc.ref, { settledSaleId: canonicalId, settledSaleIds: [canonicalId], settledMinor: amountMinor,
          settlementStatus: 'settled_sale', reconciledAt: now, reconciliationId: archiveRef.id });
        tx.create(claimRef, { tenantId, provider: 'mpesa', reference, allocationId: `attempt:${attemptId}`,
          targets: [`sale:${canonicalId}`], allocatedMinor: amountMinor, limitMinor: amountMinor, verified: true, updatedAt: now });
        tx.create(db.collection('audit_logs').doc(archiveRef.id), { tenantId, branchId: 'branch-nai-01', action: 'sale.duplicate_reconciled',
          entityType: 'sale', entityId: canonicalId, metadata: { reference, amountMinor, duplicateSaleIds: rows.slice(1).map(row => row[1]), archiveId: archiveRef.id, reason }, createdAt: now });
      }
      return { result: apply ? 'reconciled' : 'ready (dry run)', fingerprint: hash, canonicalInvoice: rows[0][0],
        cancelledDuplicateInvoices: rows.slice(1).map(row => row[0]), receipt: reference, receivedKES: amountMinor / 100,
        receivedAt: paidAt.toDate().toISOString(), stockMovements: 0, archiveId: archiveRef.id };
    });
    console.log(JSON.stringify(result, null, 2));
  } finally { await app.delete(); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
