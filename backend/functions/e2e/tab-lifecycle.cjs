'use strict';
// One table across three devices, end to end through the real callables:
// open on A, add on B, settle from C, then the table is free for the next
// customer everywhere. Field reports of 25-26 Nov 2026 broke each step.
const assert = require('node:assert/strict');
if (process.env.GCLOUD_PROJECT !== 'demo-tokgut-pos' || !/^127\.0\.0\.1:\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST || '')) {
  throw Error('Run only against the local demo-tokgut-pos Firestore emulator');
}
const { db } = require('../lib/lib/firebase');
const { createSale } = require('../lib/modules/sales/create-sale');
const { settleSale, voidSale } = require('../lib/modules/sales/settle');
const { deterministicId } = require('../lib/shared/identifiers');

const T = 'life-tenant', B = 'life-branch';
const devices = ['life-tablet-a', 'life-tablet-b', 'life-till-c'];
const staff = { 'life-tablet-a': 'life-nicole', 'life-tablet-b': 'life-hadrine', 'life-till-c': 'life-cashier' };
const auth = device => ({ uid: device, token: { tenant_id: T, staff_id: staff[device], staff_role: 'cashier' } });
let n = 0;

async function seed() {
  const rows = {
    [`tenants/${T}`]: { status: 'active', etimsMode: 'none' },
    [`branches/${B}`]: { tenantId: T, status: 'active', code: 'LIFE' },
    [`customers/life-walkin`]: { tenantId: T, isActive: true },
    [`customers/life-other-customer`]: { tenantId: T, isActive: true },
    [`tenant_settings/${T}`]: { tenantId: T, acceptedPaymentMethods: ['cash', 'mpesa', 'credit'] },
    [`products/life-beef`]: { tenantId: T, isActive: true, sellPriceMinor: 50000, taxCode: 'A', name: 'Ugali Beef' },
    [`products/life-punch`]: { tenantId: T, isActive: true, sellPriceMinor: 35000, taxCode: 'A', name: 'Pineapple Punch' },
    [`stock_balances/${B}_life-beef_HOUSE`]: { tenantId: T, branchId: B, productId: 'life-beef', location: 'HOUSE', qty: 100 },
    [`stock_balances/${B}_life-punch_HOUSE`]: { tenantId: T, branchId: B, productId: 'life-punch', location: 'HOUSE', qty: 100 },
  };
  for (const device of devices) {
    rows[`devices/${device}`] = { tenantId: T, branchId: B, status: 'active' };
    rows[`staff/${staff[device]}`] = { tenantId: T, status: 'active', role: 'cashier' };
    rows[`shifts/shift-${device}`] = { tenantId: T, branchId: B, deviceId: device, staffId: staff[device], status: 'open', expectedCashMinor: 0 };
  }
  const batch = db.batch();
  for (const [path, data] of Object.entries(rows)) batch.set(db.doc(path), data);
  await batch.commit();
}

/** A round rung on `device`, saved unpaid, the way every till saves a bill first. */
async function ring(device, { table, tabId, product = 'life-beef', join, customer = 'life-walkin' } = {}) {
  const key = `life-round-${++n}`;
  const price = product === 'life-beef' ? 50000 : 35000;
  const { sale } = await createSale.run({ auth: auth(device), data: { tenantId: T, branchId: B, deviceId: device,
    shiftId: `shift-${device}`, staffId: staff[device], customerId: customer, idempotencyKey: key,
    ...(table ? { tableNumber: table, tabId: tabId || `proposed-${key}`, orderReference: `ORD-${key}` } : {}),
    ...(join ? { joinSaleUuid: join } : {}),
    lines: [{ productId: product, qty: 1 }], payments: [{ method: 'credit', amountMinor: price }] } });
  return { ...sale, uuid: key };
}
const settle = (device, round) => settleSale.run({ auth: auth(device), data: {
  saleUuid: round.uuid, requestId: `pay-${round.uuid}`, method: 'cash' } });
const session = async table => {
  const key = table.trim().toLowerCase().replace(/\s+/g, ' ').replace(/^table\s*/, '');
  return (await db.doc(`table_sessions/${deterministicId('table', `${T}:${B}:${key}`)}`).get()).data();
};

async function main() {
  await seed();

  // Open on tablet A, add on tablet B (a different spelling of the same table).
  const first = await ring('life-tablet-a', { table: '6' });
  const second = await ring('life-tablet-b', { table: 'Table 6', product: 'life-punch' });
  assert.equal(second.tabId, first.tabId, 'B joined A\'s tab');
  assert.equal(second.staffId, 'life-hadrine', 'Hadrine remains the seller of her own round');
  assert.equal((await db.doc(`sales/${first.id}`).get()).data().staffId, 'life-nicole', 'the original seller is unchanged');
  const stockBeforeWrongAccount = (await db.doc(`stock_balances/${B}_life-beef_HOUSE`).get()).data().qty;
  const saleCountBeforeWrongAccount = (await db.collection('sales').where('tenantId', '==', T).get()).size;
  await assert.rejects(ring('life-tablet-b', { table: '6', customer: 'life-other-customer' }), /another customer account/);
  await assert.rejects(ring('life-tablet-b', { join: first.uuid, customer: 'life-other-customer' }), /another customer/);
  assert.equal((await db.doc(`stock_balances/${B}_life-beef_HOUSE`).get()).data().qty, stockBeforeWrongAccount);
  assert.equal((await db.collection('sales').where('tenantId', '==', T).get()).size, saleCountBeforeWrongAccount);
  let open = await session('6');
  assert.equal(open.status, 'OPEN'); assert.equal(open.tabId, first.tabId); assert.equal(open.dueMinor, 85000);
  assert.deepEqual([...open.roundSaleIds].sort(), [first.id, second.id].sort());

  // Settled from the counter till C: the table is free.
  await settle('life-till-c', first);
  open = await session('6');
  assert.equal(open.status, 'OPEN'); assert.equal(open.dueMinor, 35000, 'one round still owed');
  await settle('life-till-c', second);
  open = await session('6');
  assert.equal(open.status, 'SETTLED'); assert.equal(open.dueMinor, 0);

  // A stale device still proposes the paid tab: the next customer gets a new one.
  const next = await ring('life-tablet-a', { table: '6', tabId: first.tabId });
  assert.notEqual(next.tabId, first.tabId, 'a paid table starts a fresh tab');
  open = await session('6');
  assert.equal(open.status, 'OPEN'); assert.equal(open.tabId, next.tabId); assert.equal(open.dueMinor, 50000);

  // Every round voided (Edit items, a re-ring taken back): nothing owed, table free.
  const voided = await ring('life-tablet-b', { table: '3' });
  await voidSale.run({ auth: auth('life-tablet-b'), data: { saleUuid: voided.uuid, reason: 'Rung on the wrong table' } });
  open = await session('3');
  assert.equal(open.status, 'SETTLED'); assert.equal(open.dueMinor, 0);

  // Add items to an unpaid walk-in bill (no table) from another tablet: one bill, one payment.
  const beef = await ring('life-tablet-a');
  const punch = await ring('life-tablet-b', { product: 'life-punch', join: beef.uuid });
  const joined = (await db.doc(`sales/${beef.id}`).get()).data();
  assert.ok(joined.tabId, 'the bill became a tab'); assert.equal(punch.tabId, joined.tabId);
  assert.equal(punch.orderReference, joined.orderReference);
  // At a table, joining a bill lands on that table's tab.
  const atTable = await ring('life-tablet-b', { table: '6', product: 'life-punch', join: next.uuid });
  assert.equal(atTable.tabId, next.tabId); assert.equal(atTable.tableNumber, '6');
  assert.equal((await session('6')).dueMinor, 85000);
  await settle('life-till-c', beef); await settle('life-till-c', punch);
  await assert.rejects(ring('life-tablet-a', { join: beef.uuid }), /already paid/);

  // A typed M-Pesa code with no misreadable character (no O/0, I/1/L, S/5, B/8, Z/2) settles.
  // Every such payment failed with 'internal' on 26 Nov 2026 (look-alike check read nothing).
  await db.doc(`mpesa_receipt_controls/${T}`).set({ tenantId: T, mode: 'internal', policyVersion: 3, entryMode: 'staff_entry',
    branchScope: 'tenant', duration: 'ongoing', until: null, authorizationId: 'life-test' });
  const typed = await ring('life-tablet-a', { table: '9' });
  const paid = await settleSale.run({ auth: auth('life-till-c'), data: { saleUuid: typed.uuid, requestId: 'pay-typed',
    method: 'mpesa', reference: 'UKACDEFGHJ', receiptAmountMinor: 50000 } });
  assert.equal(paid.outstandingMinor, 0);

  console.log(JSON.stringify({ tabLifecycle: 'passed', addItemsToBill: true, typedCodeWithoutLookAlikes: true, sharedAcrossDevices: true, freedAfterPayment: true, freshTabAfterPayment: true, voidedOnlyTabFree: true }));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
