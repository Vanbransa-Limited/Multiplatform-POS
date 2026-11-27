'use strict';
// Releasing a physical table while its customer's bill stays owed, end to end
// through the real callables (agreed 27 Nov 2026): the bill keeps every amount
// and payment, the next customer gets a fresh tab, a round naming the released
// tab is never joined to anyone's bill, and the released bill stays payable.
const assert = require('node:assert/strict');
if (process.env.GCLOUD_PROJECT !== 'demo-tokgut-pos' || !/^127\.0\.0\.1:\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST || '')) {
  throw Error('Run only against the local demo-tokgut-pos Firestore emulator');
}
const { db } = require('../lib/lib/firebase');
const { createSale } = require('../lib/modules/sales/create-sale');
const { settleSale } = require('../lib/modules/sales/settle');
const { releaseTable } = require('../lib/modules/sales/release-table');
const { deterministicId } = require('../lib/shared/identifiers');

const T = 'rel-tenant', B = 'rel-branch', OTHER = 'rel-other-tenant';
const devices = ['rel-tablet-a', 'rel-tablet-b', 'rel-till-c'];
const staff = { 'rel-tablet-a': 'rel-waiter-ann', 'rel-tablet-b': 'rel-waiter-ben', 'rel-till-c': 'rel-cashier' };
const auth = (device, extra = {}) => ({ uid: device, token: { tenant_id: T, staff_id: staff[device], staff_role: 'cashier', ...extra } });
let n = 0;

async function seed() {
  const rows = {
    [`tenants/${T}`]: { status: 'active', etimsMode: 'none' },
    [`branches/${B}`]: { tenantId: T, status: 'active', code: 'REL' },
    [`customers/rel-walkin`]: { tenantId: T, isActive: true },
    [`tenant_settings/${T}`]: { tenantId: T, acceptedPaymentMethods: ['cash', 'mpesa', 'credit'] },
    [`products/rel-beef`]: { tenantId: T, isActive: true, sellPriceMinor: 50000, taxCode: 'A', name: 'Ugali Beef' },
    [`stock_balances/${B}_rel-beef_HOUSE`]: { tenantId: T, branchId: B, productId: 'rel-beef', location: 'HOUSE', qty: 1000 },
    [`staff/rel-waiter-gone`]: { tenantId: T, status: 'inactive', role: 'cashier' },
    [`staff/rel-intruder`]: { tenantId: OTHER, status: 'active', role: 'cashier' },
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

/** An unpaid round, the way every till saves a table bill first. */
async function ring(device, { table, tabId, qty = 1, join } = {}) {
  const key = `rel-round-${++n}`;
  const { sale } = await createSale.run({ auth: auth(device), data: { tenantId: T, branchId: B, deviceId: device,
    shiftId: `shift-${device}`, staffId: staff[device], customerId: 'rel-walkin', idempotencyKey: key,
    ...(table ? { tableNumber: table, tabId: tabId || `proposed-${key}`, orderReference: `ORD-${key}` } : {}),
    ...(join ? { joinSaleUuid: join } : {}),
    lines: [{ productId: 'rel-beef', qty }], payments: [{ method: 'credit', amountMinor: 50000 * qty }] } });
  return { ...sale, uuid: key };
}
const release = (device, data, extra) => releaseTable.run({ auth: auth(device, extra), data: { tenantId: T, branchId: B, ...data } });
const session = async table => (await db.doc(`table_sessions/${deterministicId('table', `${T}:${B}:${table}`)}`).get()).data();
/** Everything financial about a bill: its sale fields (minus the release stamp) and its payment rows. */
async function money(saleIds) {
  const out = {};
  for (const id of saleIds) {
    const { tableRelease: _stamp, updatedAt: _u, ...sale } = (await db.doc(`sales/${id}`).get()).data();
    const payments = (await db.collection('payments').where('saleId', '==', id).get()).docs
      .map(doc => ({ id: doc.id, ...doc.data() })).sort((a, b) => a.id.localeCompare(b.id));
    out[id] = JSON.stringify({ sale, payments });
  }
  return out;
}

async function main() {
  await seed();

  // Table 9: a small unpaid bill over two rounds from two tablets.
  const first = await ring('rel-tablet-a', { table: '9' });
  const second = await ring('rel-tablet-b', { table: '9' });
  assert.equal(second.tabId, first.tabId);

  // Refusals: no reason, too long, an inactive waiter, another business, a wrong tab.
  const target = { tableNumber: '9', tabId: first.tabId };
  await assert.rejects(release('rel-tablet-a', { ...target, reason: 'ok' }), /3 to 200/);
  await assert.rejects(release('rel-tablet-a', { ...target, reason: 'x'.repeat(201) }), /3 to 200/);
  await assert.rejects(release('rel-tablet-a', { ...target, reason: 'Left' }, { staff_id: 'rel-waiter-gone' }), /active staff/);
  await assert.rejects(release('rel-tablet-a', { ...target, reason: 'Left' }, { staff_id: 'rel-intruder' }), /active staff/);
  await assert.rejects(releaseTable.run({ auth: { uid: 'x', token: { tenant_id: OTHER, staff_id: 'rel-intruder', staff_role: 'cashier' } },
    data: { tenantId: T, branchId: B, ...target, reason: 'Left' } }), /staff of this business/);
  await assert.rejects(release('rel-tablet-a', { tableNumber: '9', tabId: 'not-this-tab', reason: 'Left' }), /not open at this table/);
  // A closed branch takes no table actions.
  await db.doc(`branches/${B}`).update({ status: 'inactive' });
  await assert.rejects(release('rel-tablet-a', { ...target, reason: 'Left' }), /branch is not active/);
  await db.doc(`branches/${B}`).update({ status: 'active' });

  // Checkout in progress keeps the table.
  await db.doc(`sales/${second.id}`).update({ checkoutExpiresAt: new Date(Date.now() + 60_000) });
  await assert.rejects(release('rel-tablet-a', { ...target, reason: 'Customer stepped out' }), /being paid/);
  await db.doc(`sales/${second.id}`).update({ checkoutExpiresAt: null });
  const before = await money([first.id, second.id]);

  // The release: recorded, table free, not one financial value changed.
  const done = await release('rel-tablet-a', { ...target, reason: '  Customer moved   to the bar  ' });
  assert.equal(done.outstandingMinor, 100000); assert.equal(done.replayed, false);
  assert.deepEqual(await money([first.id, second.id]), before, 'totals, status and payments untouched');
  assert.equal((await session('9')).status, 'SETTLED', 'the physical table is free');
  const audit = (await db.doc(`audit_logs/${done.releaseId}`).get()).data();
  assert.equal(audit.action, 'table.released'); assert.equal(audit.actorStaffId, 'rel-waiter-ann');
  assert.equal(audit.tenantId, T); assert.equal(audit.entityId, first.tabId);
  assert.deepEqual([audit.metadata.tableNumber, audit.metadata.outstandingMinor, audit.metadata.reason],
    ['9', 100000, 'Customer moved to the bar']);
  assert.deepEqual([...audit.metadata.saleIds].sort(), [first.id, second.id].sort());
  assert.ok(audit.createdAt && audit.metadata.tableSessionId);
  const stamp = (await db.doc(`sales/${first.id}`).get()).data().tableRelease;
  assert.equal(stamp.releasedByStaffId, 'rel-waiter-ann'); assert.equal(stamp.releaseId, done.releaseId);
  // A retried request replays; no second audit row.
  assert.equal((await release('rel-tablet-a', { ...target, reason: 'Retried' })).replayed, true);
  assert.equal((await db.collection('audit_logs').where('entityId', '==', first.tabId).get()).size, 1);

  // The next customer at table 9 gets a fresh tab, never the released one.
  const nextCustomer = await ring('rel-tablet-b', { table: '9' });
  assert.notEqual(nextCustomer.tabId, first.tabId);
  let open = await session('9');
  assert.deepEqual([open.status, open.tabId, open.dueMinor], ['OPEN', nextCustomer.tabId, 50000]);
  assert.deepEqual(open.roundSaleIds, [nextCustomer.id], 'the released rounds are not on the new tab');

  // A late or stale round naming the released tab is refused: on no bill, with what review needs.
  let held;
  await assert.rejects(ring('rel-tablet-a', { table: '9', tabId: first.tabId }), error => { held = error; return true; });
  assert.equal(held.details.reason, 'table-released'); assert.equal(held.details.tabId, first.tabId);
  assert.equal(held.details.releaseId, done.releaseId); assert.equal(held.details.tableNumber, '9');
  // Naming the released tab without its table is held all the same: never filed under that tab.
  // (A round paid on the spot cannot reach this: every new round is saved unpaid first.)
  await assert.rejects(createSale.run({ auth: auth('rel-tablet-a'), data: { tenantId: T, branchId: B, deviceId: 'rel-tablet-a',
    shiftId: 'shift-rel-tablet-a', staffId: 'rel-waiter-ann', customerId: 'rel-walkin', idempotencyKey: 'rel-late-no-table',
    tabId: first.tabId, orderReference: 'ORD-late', lines: [{ productId: 'rel-beef', qty: 1 }],
    payments: [{ method: 'credit', amountMinor: 50000 }] } }), error => error.details?.reason === 'table-released');
  assert.equal((await db.collection('sales').where('idempotencyKey', '==', 'rel-late-no-table').get()).size, 0);
  open = await session('9');
  assert.deepEqual([open.dueMinor, open.roundSaleIds], [50000, [nextCustomer.id]], 'the new customer\'s bill is unchanged');
  assert.deepEqual(await money([first.id, second.id]), before, 'nor the released bill');

  // Add items to the released bill from Orders: it stays on that bill and off the table.
  const extra = await ring('rel-tablet-a', { join: first.uuid });
  assert.equal(extra.tabId, first.tabId);
  const extraDoc = (await db.doc(`sales/${extra.id}`).get()).data();
  assert.equal(extraDoc.tableRelease.releaseId, done.releaseId);
  open = await session('9');
  assert.deepEqual([open.tabId, open.dueMinor], [nextCustomer.tabId, 50000]);

  // The released bill stays payable, round by round, and paying it leaves table 9 alone.
  for (const round of [first, second, extra]) {
    await settleSale.run({ auth: auth('rel-till-c'), data: { saleUuid: round.uuid, requestId: `pay-${round.uuid}`, method: 'cash' } });
  }
  open = await session('9');
  assert.deepEqual([open.status, open.tabId, open.dueMinor], ['OPEN', nextCustomer.tabId, 50000]);
  // Nothing owed now, so a second release is refused rather than recorded.
  await settleSale.run({ auth: auth('rel-till-c'), data: { saleUuid: nextCustomer.uuid, requestId: `pay-${nextCustomer.uuid}`, method: 'cash' } });
  await assert.rejects(release('rel-tablet-b', { tableNumber: '9', tabId: nextCustomer.tabId, reason: 'Paid already' }), /Nothing is owed/);
  assert.equal((await session('9')).status, 'SETTLED');

  // A substantial bill (KES 50,000 over one round) releases the same way.
  const big = await ring('rel-tablet-b', { table: 'VIP 2', qty: 100 });
  const bigBefore = await money([big.id]);
  const bigDone = await release('rel-tablet-b', { tableNumber: 'VIP 2', tabId: big.tabId, reason: 'Corporate account, invoiced later' });
  assert.equal(bigDone.outstandingMinor, 5_000_000);
  assert.deepEqual(await money([big.id]), bigBefore);
  assert.equal((await session('vip 2')).status, 'SETTLED');

  console.log(JSON.stringify({ tableRelease: 'passed', reasonRequired: true, activeStaffOnly: true, activeBranchOnly: true, tenantIsolated: true,
    checkoutProtected: true, financialRecordsUnchanged: true, audited: true, idempotent: true, tableFreed: true,
    freshTabForNextCustomer: true, staleRoundHeldNotJoined: true, addItemsStayOnReleasedBill: true,
    releasedBillPayable: true, substantialBalance: true }));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
