'use strict';
// Read-only: the 26 Nov 2026 field reports (Stacy, Ann, and the KES 2,000 + 400
// "my unpaid" request). Prints receipts, claims, C2B proof and the bills involved.
// Never prints payer phone numbers.
const backend = require('node:module').createRequire(require('node:path').resolve(__dirname, '../backend/functions/package.json'));
const { initializeApp, applicationDefault } = backend('firebase-admin/app');
const { getFirestore } = backend('firebase-admin/firestore');
const { deterministicId } = require('../backend/functions/lib/shared/identifiers');
const tenantId = 'tenant-01';
const CODES = ['UKQNK3M4G7', 'UKQQQ3EYRU', 'UK3130EM1G', 'UKQ133CHUZ'];
const BILLS = ['ORD-6-347332', 'INV-BH001-003480', 'INV-BH001-003485'];
const pick = (doc, fields) => ({ id: doc.id, exists: doc.exists, ...Object.fromEntries(fields.filter(f => doc.data()?.[f] !== undefined).map(f => [f, doc.data()[f]?.toDate ? doc.data()[f].toDate().toISOString() : doc.data()[f]])) });
async function main() {
  const app = initializeApp({ projectId: 'vanbransa-pos', credential: applicationDefault() });
  const db = getFirestore(app);
  try {
    const saleIds = new Set();
    const receipts = [];
    for (const code of CODES) {
      const [ledger, claim, event, intent] = await Promise.all([
        db.collection('payments').where('reference', '==', code).get(),
        db.doc(`payment_receipt_claims/${deterministicId('mpesa-receipt', `${tenantId}:${code}`)}`).get(),
        db.doc(`mpesa_c2b_events/${deterministicId('c2b', `confirmation:${code}`)}`).get(),
        db.doc(`payment_intents/${deterministicId('intent', `${tenantId}:${code}`)}`).get(),
      ]);
      ledger.docs.forEach(d => d.data().saleId && saleIds.add(d.data().saleId));
      receipts.push({ code,
        payments: ledger.docs.map(d => pick(d, ['tenantId', 'saleId', 'method', 'amountMinor', 'status', 'verified', 'settledAt'])),
        claim: pick(claim, ['tenantId', 'allocatedMinor', 'limitMinor', 'targets', 'verified', 'amountSource']),
        c2b: { ...pick(event, ['tenantId', 'disposition', 'settledMinor', 'settledSaleId']), providerAmountMinor: event.data()?.payload?.amountMinor ?? null, transTime: event.data()?.payload?.transTime ?? null },
        intent: pick(intent, ['amountMinor', 'status', 'consumedSaleId']) });
    }
    for (const bill of BILLS) {
      for (const field of ['invoiceNumber', 'orderReference']) {
        (await db.collection('sales').where('tenantId', '==', tenantId).where(field, '==', bill).get()).docs.forEach(d => saleIds.add(d.id));
      }
    }
    const sales = [];
    for (const id of saleIds) {
      const sale = await db.doc(`sales/${id}`).get();
      const [lines, pays] = await Promise.all([
        db.collection('sale_lines').where('saleId', '==', id).get(),
        db.collection('payments').where('saleId', '==', id).get(),
      ]);
      const staff = sale.data()?.staffId ? await db.doc(`staff/${sale.data().staffId}`).get() : null;
      sales.push({ ...pick(sale, ['invoiceNumber', 'orderReference', 'totalMinor', 'status', 'staffId', 'createdAt', 'tableId', 'tabId', 'voidedAt', 'idempotencyKey']),
        staff: staff?.data()?.displayName || staff?.data()?.name || null,
        lines: lines.docs.map(d => `${d.data().qty} x ${d.data().productName || d.data().name || d.data().productId} @ ${d.data().unitPriceMinor}`),
        payments: pays.docs.map(d => pick(d, ['method', 'amountMinor', 'reference', 'status', 'settledAt'])) });
    }
    console.log(JSON.stringify({ receipts, sales }, null, 2));
  } finally { await app.delete(); }
}
main().catch(e => { console.error(e.message); process.exitCode = 1; });
