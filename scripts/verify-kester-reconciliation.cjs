'use strict';
// Read-only verification of the exact user-confirmed duplicate purchase.
const path = require('node:path');
const backend = require('node:module').createRequire(path.resolve(__dirname, '../backend/functions/package.json'));
const { initializeApp, applicationDefault } = backend('firebase-admin/app');
const { getFirestore } = backend('firebase-admin/firestore');
const { deterministicId } = require('../backend/functions/lib/shared/identifiers');
const assert = require('node:assert/strict');
async function main() {
  const app = initializeApp({ projectId: 'vanbransa-pos', credential: applicationDefault() });
  const db = getFirestore(app), tenantId = 'tenant-01', receipt = 'UIPMJ8EEBT';
  try {
    const archive = (await db.collection('reconciliation_archives').doc('titanium-kester-UIPMJ8EEBT-20261118').get()).data();
    assert.ok(archive, 'Reconciliation has not been applied');
    const ids = [archive.canonicalSaleId, ...archive.duplicateSaleIds];
    const sales = [], payments = [];
    for (const id of ids) {
      const sale = await db.collection('sales').doc(id).get();
      sales.push({ id, ...sale.data() });
      const ledger = await db.collection('payments').where('saleId', '==', id).get();
      payments.push(...ledger.docs.map(doc => ({ id: doc.id, ...doc.data() })));
      const movements = await db.collection('stock_movements').where('referenceId', '==', id).get();
      assert.equal(movements.empty, true, 'Unexpected tracked stock movement');
    }
    assert.equal(String(sales[0].status).toUpperCase(), 'COMPLETED');
    for (const sale of sales.slice(1)) {
      assert.equal(sale.status, 'VOIDED'); assert.equal(sale.duplicateOfSaleId, archive.canonicalSaleId);
      assert.ok(payments.filter(payment => payment.saleId === sale.id).every(payment => payment.status === 'voided'));
    }
    const valid = payments.filter(payment => payment.method === 'mpesa' && payment.status === 'completed');
    assert.equal(valid.length, 1); assert.equal(valid[0].verified, true); assert.equal(valid[0].amountMinor, 105000);
    assert.equal(valid[0].reference, receipt); assert.equal(valid[0].paidAt.toDate().toISOString(), '2026-09-25T15:27:58.337Z');
    const intent = (await db.collection('payment_intents').doc(deterministicId('intent', `${tenantId}:${receipt}`)).get()).data();
    assert.equal(intent.status, 'consumed'); assert.equal(intent.consumedSaleId, archive.canonicalSaleId);
    const attempt = (await db.collection('mpesa_payments').doc(intent.attemptId).get()).data();
    assert.deepEqual(attempt.settledSaleIds, [archive.canonicalSaleId]); assert.equal(attempt.settledMinor, 105000);
    const claim = (await db.collection('payment_receipt_claims').doc(deterministicId('mpesa-receipt', `${tenantId}:${receipt}`)).get()).data();
    assert.equal(claim.allocatedMinor, 105000); assert.deepEqual(claim.targets, [`sale:${archive.canonicalSaleId}`]);
    const { financialSnapshot } = await import('../frontend/src/services/financial-snapshot.js');
    const report = (from, to) => financialSnapshot({ tenantId, from: Date.parse(from), to: Date.parse(to),
      serverSales: sales, serverPayments: payments, attempts: [{ ...attempt, id: intent.attemptId }] });
    const september = report('2026-09-25T00:00:00+03:00', '2026-09-25T23:59:59.999+03:00');
    const today = report('2026-11-18T00:00:00+03:00', '2026-11-18T23:59:59.999+03:00');
    assert.equal(september.count, 1); assert.equal(september.collected, 1050); assert.equal(september.paymentCount, 1);
    assert.equal(september.unpaid, 0); assert.equal(today.collected, 0); assert.equal(today.unpaid, 0);
    assert.equal(september.transactions[0].invoice_no, sales[0].invoiceNumber);
    console.log(JSON.stringify({ verified: true, retainedInvoice: sales[0].invoiceNumber, cancelledDuplicates: sales.slice(1).map(sale => sale.invoiceNumber),
      originalReceivedDate: '2026-09-25', receivedKES: september.collected, paymentCount: september.paymentCount,
      november18ReceivedKESForThisPurchase: today.collected, unpaidKES: september.unpaid, stockMovements: 0,
      auditArchive: 'titanium-kester-UIPMJ8EEBT-20261118' }, null, 2));
  } finally { await app.delete(); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
