'use strict';
const assert = require('node:assert/strict');
if (process.env.GCLOUD_PROJECT !== 'demo-tokgut-pos' || !/^127\.0\.0\.1:\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST || '')) {
  throw Error('Run only against the local demo-tokgut-pos Firestore emulator');
}
const { db } = require('../lib/lib/firebase');
const { Timestamp } = require('firebase-admin/firestore');
const { createSale } = require('../lib/modules/sales/create-sale');
const { consolidateTable, verifyTable, targets, tenantId, branchId, canonicalTabId, reference } = require('../../../scripts/consolidate-table50.cjs');
async function main() {
  const batch = db.batch();
  const soldAt = Timestamp.fromDate(new Date('2026-11-20T17:00:00Z'));
  for (const [index, [id, invoiceNumber, totalMinor]] of targets.entries()) {
    batch.set(db.doc(`sales/${id}`), { tenantId, branchId, tableNumber: '50', invoiceNumber, totalMinor,
      staffId: 'staff-6fc10bf06ad622e004f2056af83b1ef72fc1a1b4a0a9f983',
      shiftId: 'shift-5c0946e69016a44fea5ac2831bd69a5ada8fbebf6e4e42ab',
      tabId: index ? canonicalTabId : '26a2af83-e7a5-4053-ae0e-6d554026f41c',
      orderReference: index ? reference : 'ORD-50-069803', status: 'completed', soldAt });
    batch.set(db.doc(`payments/${id}-credit`), { tenantId, saleId: id, method: 'credit', amountMinor: totalMinor });
    batch.set(db.doc(`sale_lines/${id}-line`), { tenantId, saleId: id, qty: [7, 1, 2, 5][index] });
  }
  await batch.commit();
  const dry = await consolidateTable(db);
  await assert.rejects(consolidateTable(db, { apply: true, expectedHash: '0'.repeat(64) }), /changed after the dry run/);
  assert.equal((await consolidateTable(db, { apply: true, expectedHash: dry.sourceFingerprint })).result, 'consolidated');
  assert.equal((await verifyTable(db)).totalKES, 15600);
  assert.equal((await consolidateTable(db, { apply: true })).result, 'already consolidated');

  const seed = db.batch();
  const rows = {
    'tenants/race-tenant': { status: 'active', etimsMode: 'none' },
    'branches/race-branch': { tenantId: 'race-tenant', status: 'active', code: 'TEST' },
    'devices/race-device': { tenantId: 'race-tenant', branchId: 'race-branch', status: 'active' },
    'shifts/race-shift': { tenantId: 'race-tenant', branchId: 'race-branch', deviceId: 'race-device', staffId: 'race-staff', status: 'open', expectedCashMinor: 0 },
    'staff/race-staff': { tenantId: 'race-tenant', status: 'active', role: 'cashier' },
    'customers/race-customer': { tenantId: 'race-tenant', isActive: true },
    'tenant_settings/race-tenant': { tenantId: 'race-tenant', acceptedPaymentMethods: ['cash'] },
    'products/race-product': { tenantId: 'race-tenant', isActive: true, sellPriceMinor: 10000, taxCode: 'A', name: 'Test meal' },
    'stock_balances/race-branch_race-product_HOUSE': { tenantId: 'race-tenant', branchId: 'race-branch', productId: 'race-product', location: 'HOUSE', qty: 10 },
  };
  for (const [path, data] of Object.entries(rows)) seed.set(db.doc(path), data);
  await seed.commit();
  const auth = { uid: 'test', token: { tenant_id: 'race-tenant', staff_id: 'race-staff', staff_role: 'cashier' } };
  const request = index => ({ auth, data: { tenantId: 'race-tenant', branchId: 'race-branch', deviceId: 'race-device',
    shiftId: 'race-shift', staffId: 'race-staff', customerId: 'race-customer', idempotencyKey: `race-attempt-${index}`,
    tableNumber: index ? 'Table 50' : '50', tabId: `proposed-tab-${index}`, orderReference: `ORD-RACE-${index}`,
    lines: [{ productId: 'race-product', qty: 1 }], payments: [{ method: 'credit', amountMinor: 10000 }] } });
  const results = await Promise.all([createSale.run(request(0)), createSale.run(request(1))]);
  assert.equal(results[0].sale.tabId, results[1].sale.tabId);
  assert.equal(results[0].sale.orderReference, results[1].sale.orderReference);
  assert.notEqual(results[0].sale.id, results[1].sale.id);
  assert.equal((await createSale.run(request(0))).replayed, true);
  assert.equal((await db.doc('stock_balances/race-branch_race-product_HOUSE').get()).data().qty, 8);
  console.log(JSON.stringify({ repairVerified: true, totalKES: 15600, concurrentRoundsUseOneTab: true, retryDidNotDuplicateStock: true }));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
