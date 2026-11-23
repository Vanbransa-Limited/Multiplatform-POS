'use strict';
// Read-only receipt and routing investigation; excludes payer and credential data.
const path = require('node:path');
const backend = require('node:module').createRequire(path.resolve(__dirname, '../backend/functions/package.json'));
const { initializeApp, applicationDefault } = backend('firebase-admin/app');
const { getFirestore } = backend('firebase-admin/firestore');
async function main() {
  const app = initializeApp({ projectId: 'vanbransa-pos', credential: applicationDefault() });
  try {
    const db = getFirestore(app), code = 'UKL0B2RHOX';
    const [configs, sales, held, attempts, providerPayments, events] = await Promise.all([
      db.collection('mpesa_configs').get(),
      db.collection('sales').where('tableNumber', '==', '6').get(),
      db.collection('open_orders').where('tenantId', '==', 'tenant-01').get(),
      db.collection('mpesa_payments').where('receipt', '==', code).get(),
      db.collection('payments').where('providerTransactionId', '==', code).get(),
      db.collection('mpesa_c2b_events').where('providerTransactionId', '==', code).get(),
    ]);
    const pick = (doc, fields) => ({ id: doc.id, ...Object.fromEntries(fields.filter(f => doc.data()?.[f] !== undefined).map(f => [f, doc.data()[f]])) });
    console.log(JSON.stringify({
      configs: configs.docs.map(doc => pick(doc, ['tenantId', 'businessShortCode', 'partyB', 'accountReference', 'transactionType', 'environment', 'lifecycle', 'c2bLifecycle', 'branchIds', 'c2bRegisteredAt', 'c2bValidationUrl', 'c2bConfirmationUrl'])),
      tableSix: sales.docs.filter(doc => doc.data().tenantId === 'tenant-01').map(doc => pick(doc, ['invoiceNumber', 'orderReference', 'totalMinor', 'staffId', 'status', 'idempotencyKey', 'soldAt', 'checkoutId', 'checkoutExpiresAt'])),
      relevantHeld: held.docs.filter(doc => String(doc.data().tableNumber) === '6' || String(doc.data().ref).startsWith('ORD-6-') || doc.data().dueMinor === 95000)
        .map(doc => pick(doc, ['ref', 'tableNumber', 'staffId', 'dueMinor', 'totalMinor', 'saleUuids', 'publishedAt', 'kind'])),
      matchingAttempts: attempts.docs.map(doc => pick(doc, ['tenantId', 'status', 'receipt', 'amountMinor', 'settledMinor'])),
      matchingProviderPayments: providerPayments.docs.map(doc => pick(doc, ['tenantId', 'saleId', 'amountMinor', 'status'])),
      matchingEvents: events.docs.map(doc => pick(doc, ['tenantId', 'disposition', 'receivedAt'])),
    }, null, 2));
  } finally { await app.delete(); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
