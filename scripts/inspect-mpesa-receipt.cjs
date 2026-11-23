'use strict';
// Read-only incident inspection. Never prints credentials or payer phone numbers.
const backend = require('node:module').createRequire(require('node:path').resolve(__dirname, '../backend/functions/package.json'));
const { initializeApp, applicationDefault } = backend('firebase-admin/app');
const { getFirestore } = backend('firebase-admin/firestore');
const { deterministicId } = require('../backend/functions/lib/shared/identifiers');
async function main() {
  const reference = process.argv[2], orders = process.argv.slice(3);
  if (!/^[A-Z0-9]{10}$/.test(reference || '')) throw new Error('Pass a ten-character receipt and optional order reference');
  const app = initializeApp({ projectId: 'vanbransa-pos', credential: applicationDefault() });
  try {
    const db = getFirestore(app), tenantId = 'tenant-01';
    const [ledger, claim, event, intent, targets, config] = await Promise.all([
      db.collection('payments').where('reference', '==', reference).get(),
      db.doc(`payment_receipt_claims/${deterministicId('mpesa-receipt', `${tenantId}:${reference}`)}`).get(),
      db.doc(`mpesa_c2b_events/${deterministicId('c2b', `confirmation:${reference}`)}`).get(),
      db.doc(`payment_intents/${deterministicId('intent', `${tenantId}:${reference}`)}`).get(),
      Promise.all(orders.map(order => db.collection('sales').where('orderReference', '==', order).get()))
        .then(results => ({ docs: results.flatMap(result => result.docs) })),
      db.doc(`mpesa_configs/${tenantId}`).get(),
    ]);
    const pick = (doc, fields) => ({ id: doc.id, exists: doc.exists, ...Object.fromEntries(fields.filter(f => doc.data()?.[f] !== undefined).map(f => [f, doc.data()[f]])) });
    const ids = [...new Set([...ledger.docs.map(d => d.data().saleId), ...targets.docs.map(d => d.id)].filter(Boolean))];
    const sales = [];
    for (const id of ids) {
      const sale = await db.doc(`sales/${id}`).get();
      const payments = await db.collection('payments').where('saleId', '==', id).get();
      const stk = sale.data()?.checkoutStkKey ? await db.doc(`mpesa_payments/${deterministicId('mpesa-attempt', `${tenantId}:${sale.data().checkoutStkKey}`)}`).get() : null;
      sales.push({ ...pick(sale, ['tenantId', 'branchId', 'invoiceNumber', 'orderReference', 'totalMinor', 'staffId', 'status', 'idempotencyKey', 'checkoutId', 'checkoutExpiresAt']),
        ...(stk ? { stk: pick(stk, ['status', 'amountMinor', 'receipt', 'requestedAt', 'completedAt', 'settlementStatus', 'settledSaleIds', 'settledMinor']) } : {}),
        payments: payments.docs.map(d => pick(d, ['method', 'amountMinor', 'reference', 'status', 'verified', 'settledAt', 'paidAt', 'receiptAllocationId'])) });
    }
    console.log(JSON.stringify({ reference,
      feed: pick(config, ['lifecycle', 'c2bLifecycle', 'branchIds', 'c2bRegisteredAt']),
      claim: pick(claim, ['tenantId', 'reference', 'allocatedMinor', 'limitMinor', 'allocationId', 'targets', 'verified']),
      event: pick(event, ['tenantId', 'disposition', 'settledMinor', 'settledSaleId', 'settledProformaId', 'settledCustomerOrderId']),
      providerAmountMinor: event.data()?.payload?.amountMinor ?? null,
      intent: pick(intent, ['tenantId', 'amountMinor', 'attemptId', 'status', 'consumedSaleId']), sales }, null, 2));
  } finally { await app.delete(); }
}
main().catch(e => { console.error(e.message); process.exitCode = 1; });
