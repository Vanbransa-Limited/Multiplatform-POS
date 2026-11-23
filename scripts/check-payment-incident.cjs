'use strict';
// Incident inspection only: never settles bills or creates/edits receipt records.
process.env.GCLOUD_PROJECT = 'vanbransa-pos';
const assert = require('node:assert/strict');
const { db } = require('../backend/functions/lib/lib/firebase');
const { deterministicId } = require('../backend/functions/lib/shared/identifiers');
const { readReceiptBalance } = require('../backend/functions/lib/modules/sales/receipt-balance');
const { outstandingMinor } = require('../backend/functions/lib/modules/sales/settle');
async function main() {
  const args = process.argv.slice(2);
  const value = key => args.includes(key) ? args[args.indexOf(key) + 1] : undefined;
  assert.equal(value('--project'), 'vanbransa-pos');
  assert.ok(!process.env.FIRESTORE_EMULATOR_HOST);
  const tenantId = value('--tenant'), branchId = value('--branch'), invoice = value('--invoice'), reference = value('--code');
  assert.match(tenantId || '', /^[A-Za-z0-9_-]{1,128}$/); assert.match(branchId || '', /^[A-Za-z0-9_-]{1,128}$/);
  assert.match(reference || '', /^[A-Z0-9]{10}$/); assert.match(invoice || '', /^INV-[A-Za-z0-9-]{1,70}$/);
  const result = await db.runTransaction(async tx => {
    const [branch, invoices, ledger, providerLedger, prompts, claim, event, intent, control, config] = await Promise.all([
      tx.get(db.doc(`branches/${branchId}`)),
      tx.get(db.collection('sales').where('invoiceNumber', '==', invoice)),
      tx.get(db.collection('payments').where('reference', '==', reference)),
      tx.get(db.collection('payments').where('providerTransactionId', '==', reference)),
      tx.get(db.collection('mpesa_payments').where('receipt', '==', reference)),
      tx.get(db.doc(`payment_receipt_claims/${deterministicId('mpesa-receipt', `${tenantId}:${reference}`)}`)),
      tx.get(db.doc(`mpesa_c2b_events/${deterministicId('c2b', `confirmation:${reference}`)}`)),
      tx.get(db.doc(`payment_intents/${deterministicId('intent', `${tenantId}:${reference}`)}`)),
      tx.get(db.doc(`mpesa_receipt_controls/${tenantId}`)), tx.get(db.doc(`mpesa_configs/${tenantId}`)),
    ]);
    assert.equal(branch.data()?.tenantId, tenantId);
    const own = snapshot => snapshot.exists && snapshot.data()?.tenantId === tenantId;
    const paymentRows = [...new Map([...ledger.docs, ...providerLedger.docs].map(doc => [doc.id, doc])).values()]
      .filter(doc => doc.data().tenantId === tenantId);
    const bills = [];
    for (const doc of invoices.docs.filter(doc => doc.data().tenantId === tenantId && doc.data().branchId === branchId)) {
      const payments = await tx.get(db.collection('payments').where('saleId', '==', doc.id));
      const rows = payments.docs.map(row => row.data()).filter(row => row.tenantId === tenantId);
      bills.push({ saleId: doc.id, invoiceNumber: doc.data().invoiceNumber, branchId: doc.data().branchId,
        totalKES: Number(doc.data().totalMinor) / 100, outstandingKES: outstandingMinor(rows) / 100,
        status: doc.data().status, payments: rows.map(row => ({ method: row.method, amountKES: Number(row.amountMinor) / 100,
          status: row.status || null, settled: Boolean(row.settledAt), matchesCode: row.reference === reference || row.providerTransactionId === reference })) });
    }
    let check;
    try {
      const balance = await readReceiptBalance(tx, tenantId, reference, branchId, bills[0]?.saleId);
      check = { matched: true, amountKES: balance.amountMinor / 100, usedKES: balance.allocatedMinor / 100,
        availableKES: balance.availableMinor / 100, verified: balance.verified };
    } catch (error) { check = { matched: false, reason: error.code, message: error.message }; }
    return { tenantId, branchId, invoice, reference, readOnly: true, writes: 0, bills,
      matchingRecords: { payments: paymentRows.length, receiptClaim: own(claim), providerConfirmation: own(event),
        paymentIntent: own(intent), prompts: prompts.docs.filter(doc => doc.data().tenantId === tenantId).length },
      checkoutPolicy: { version: control.data()?.policyVersion, entryMode: control.data()?.entryMode, duration: control.data()?.duration },
      merchantFeed: { stkLifecycle: config.data()?.lifecycle || null, directPaymentLifecycle: config.data()?.c2bLifecycle || null }, check };
  }, { readOnly: true });
  console.log(JSON.stringify(result, null, 2));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(() => db.terminate());
