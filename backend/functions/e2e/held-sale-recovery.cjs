'use strict';
const assert = require('node:assert/strict');
if (Number(process.versions.node.split('.')[0]) !== 22 || process.env.GCLOUD_PROJECT !== 'demo-tokgut-pos'
  || !/^127\.0\.0\.1:\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST || '')) throw Error('Local Node 22 demo emulator required');
const { db } = require('../lib/lib/firebase');
const { Timestamp } = require('firebase-admin/firestore');
const { recoverHeldSale } = require('../../../scripts/lib/recover-held-sale.cjs');
async function main() {
  const T = 'held-recovery-demo', B = 'held-recovery-branch', S = 'demo-seller', D = 'demo-device', P = 'demo-tusker';
  const openedAt = '2026-11-27T18:36:11.146Z';
  const plan = { archiveId: 'demo-held-repair', heldId: 'demo-held', openedAt, reason: 'Owner confirmed one Tusker from the original order.',
    input: { tenantId: T, branchId: B, deviceId: D, shiftId: 'demo-shift', staffId: S, customerId: 'demo-walkin',
      idempotencyKey: 'demo-original-missing-lines', tableNumber: 'China', tabId: 'demo-china-tab', orderReference: 'ORD-DEMO-CHINA',
      lines: [{ productId: P, qty: 1 }], payments: [{ method: 'credit', amountMinor: 35000 }] } };
  const rows = {
    [`tenants/${T}`]: { status: 'active', etimsMode: 'none' },
    [`branches/${B}`]: { tenantId: T, status: 'active', code: 'HELD' },
    [`devices/${D}`]: { tenantId: T, branchId: B, status: 'active' },
    [`staff/${S}`]: { tenantId: T, status: 'active', role: 'cashier' },
    ['shifts/demo-shift']: { tenantId: T, branchId: B, deviceId: D, staffId: S, status: 'open', expectedCashMinor: 0 },
    ['customers/demo-walkin']: { tenantId: T, isActive: true },
    ['sales/old-voided-header']: { tenantId: T, branchId: B, tableNumber: 'China', tabId: 'demo-china-tab', status: 'VOIDED', totalMinor: 0 },
    [`tenant_settings/${T}`]: { tenantId: T, acceptedPaymentMethods: ['credit', 'cash'] },
    [`products/${P}`]: { tenantId: T, name: 'TUSKER LAGER BOTTLE 500ML', isActive: true, sellPriceMinor: 35000, taxCode: 'A' },
    [`stock_balances/${B}_${P}_HOUSE`]: { tenantId: T, branchId: B, productId: P, location: 'HOUSE', qty: 100 },
    ['open_orders/demo-held']: { tenantId: T, branchId: B, staffId: S, deviceId: `${D}--publisher`, tabId: 'demo-china-tab',
      tableNumber: 'China', ref: 'ORD-DEMO-CHINA', saleUuids: ['demo-original-missing-lines'], openedAt, publishedAt: Timestamp.now(),
      customerName: 'Walk-In Guest', totalMinor: 35000, dueMinor: 35000, lines: [], payments: [] },
  };
  const batch = db.batch(); for (const [p, v] of Object.entries(rows)) batch.set(db.doc(p), v); await batch.commit();
  const preview = await recoverHeldSale(db, plan);
  assert.equal((await db.doc(`sales/${preview.saleId}`).get()).exists, false);
  await assert.rejects(recoverHeldSale(db, plan, { apply: true, expectedHash: 'wrong' }), /Held order changed/);
  // A new publication time is not a changed bill.
  await db.doc('open_orders/demo-held').update({ publishedAt: Timestamp.now() });
  const results = await Promise.all([1, 2].map(() => recoverHeldSale(db, plan, { apply: true, expectedHash: preview.hash })));
  assert.equal(results[0].saleId, results[1].saleId);
  assert.equal((await db.collection('sales').where('tenantId', '==', T).get()).docs.filter(d => d.data().status !== 'VOIDED').length, 1);
  const sale = (await db.doc(`sales/${preview.saleId}`).get()).data();
  assert.equal(sale.idempotencyKey, plan.input.idempotencyKey); assert.equal(sale.staffId, S);
  assert.notEqual(sale.tabId, plan.input.tabId, 'a voided tab is retired, while the bill reference survives');
  assert.equal(sale.orderReference, plan.input.orderReference); assert.equal(sale.soldAt.toDate().toISOString(), openedAt);
  const lines = (await db.collection('sale_lines').where('saleId', '==', preview.saleId).get()).docs;
  assert.equal(lines.length, 1); assert.equal(lines[0].data().qty, 1);
  assert.equal((await db.doc(`stock_balances/${B}_${P}_HOUSE`).get()).data().qty, 99);
  const payments = (await db.collection('payments').where('saleId', '==', preview.saleId).get()).docs;
  assert.equal(payments.length, 1); assert.equal(payments[0].data().method, 'credit'); assert.equal(payments[0].data().amountMinor, 35000);
  assert.equal((await db.doc('open_orders/demo-held').get()).exists, false);
  assert.equal((await db.doc('reconciliation_archives/demo-held-repair').get()).data().status, 'complete');
  console.log('Held sale recovered once: original UUID, author and table, one Tusker, one stock deduction, unpaid KES 350, concurrent retries safe.');
}
main().catch(e => { console.error(e); process.exitCode = 1; });
