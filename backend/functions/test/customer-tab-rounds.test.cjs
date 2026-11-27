const test = require('node:test');
const assert = require('node:assert/strict');
const { createSale } = require('../lib/modules/sales/create-sale');
const { settleSale, outstandingMinor } = require('../lib/modules/sales/settle');
const { db } = require('../lib/lib/firebase');
const { deterministicId } = require('../lib/shared/identifiers');
const { printedSnapshotData } = require('./fixtures/printed-bill.cjs');

const auth = { uid: 'cashier-login', token: { tenant_id: 'tenant', staff_id: 'cashier', staff_role: 'cashier' } };
const round = (key, tabId, qty) => ({
  tenantId: 'tenant', branchId: 'branch', deviceId: 'device', shiftId: 'shift', staffId: 'cashier',
  customerId: 'nicole', idempotencyKey: key, tableNumber: 'Nicole', tabId, orderReference: 'ORD-NICOLE',
  lines: [{ productId: 'tea', qty }], payments: [{ method: 'credit', amountMinor: 26000 * qty }],
});

/** In-memory Firestore with chained equality filters, as the shared-tab lookup uses. */
function harness() {
  const docs = new Map([
    ['tenants/tenant', { status: 'active', etimsMode: 'none' }],
    ['branches/branch', { tenantId: 'tenant', status: 'active', code: 'BH001' }],
    ['devices/device', { tenantId: 'tenant', branchId: 'branch', status: 'active' }],
    ['shifts/shift', { tenantId: 'tenant', branchId: 'branch', deviceId: 'device', staffId: 'cashier', status: 'open', expectedCashMinor: 0 }],
    ['staff/cashier', { tenantId: 'tenant', status: 'active', role: 'cashier' }],
    ['customers/nicole', { tenantId: 'tenant', isActive: true, name: 'Nicole' }],
    ['customers/brian', { tenantId: 'tenant', isActive: true, name: 'Brian' }],
    ['tenant_settings/tenant', { tenantId: 'tenant', acceptedPaymentMethods: ['cash', 'mpesa'] }],
    ['products/tea', { tenantId: 'tenant', isActive: true, sellPriceMinor: 26000, taxCode: 'A', name: 'Tea' }],
    ['stock_balances/branch_tea_HOUSE', { tenantId: 'tenant', branchId: 'branch', productId: 'tea', location: 'HOUSE', qty: 10 }],
  ]);
  const original = { collection: db.collection, runTransaction: db.runTransaction };
  const snapshot = ref => ({ id: ref.id, ref, exists: docs.has(ref.path), data: () => printedSnapshotData(docs, ref.path) });
  let sequence = 0;
  const query = (collection, filters) => ({ collection, filters, where: (field, _op, value) => query(collection, [...filters, [field, value]]) });
  db.collection = name => ({
    doc: (id = `auto-${++sequence}`) => ({ id, path: `${name}/${id}` }),
    where: (field, _op, value) => query(name, [[field, value]]),
  });
  db.runTransaction = async run => {
    const writes = [];
    const result = await run({
      getAll: async (...refs) => refs.map(snapshot),
      get: async target => target.collection ? {
        docs: [...docs].filter(([path, row]) => path.startsWith(`${target.collection}/`) && target.filters.every(([field, value]) => row[field] === value))
          .map(([path]) => snapshot({ id: path.split('/')[1], path })),
      } : snapshot(target),
      set: (ref, data) => writes.push([ref.path, data]),
      create: (ref, data) => { assert.equal(docs.has(ref.path), false); writes.push([ref.path, data]); },
      update: (ref, changes) => writes.push([ref.path, { ...docs.get(ref.path), ...changes }]),
    });
    for (const [path, row] of writes) docs.set(path, row);
    return result;
  };
  return { docs, restore: () => { Object.assign(db, original); } };
}

test('a round added to a part-paid customer tab joins it, keeps every earlier item and payment, and moves stock once', async () => {
  const { docs, restore } = harness();
  const payments = saleId => [...docs].filter(([path, row]) => path.startsWith('payments/') && row.saleId === saleId).map(([, row]) => row);
  const stock = () => docs.get('stock_balances/branch_tea_HOUSE').qty;
  try {
    // KES 520 on the tab, then KES 200 paid against it with a typed code.
    const first = await createSale.run({ auth, data: round('nicole-round-1', 'tab-on-till-a', 2) });
    docs.set(`mpesa_c2b_events/${deterministicId('c2b', 'confirmation:PARTPAY001')}`, { tenantId: 'tenant', payload: { amountMinor: 20000 } });
    const part = await settleSale.run({ auth, data: { saleUuid: 'nicole-round-1', requestId: 'part', method: 'mpesa', reference: 'PARTPAY001' } });
    assert.equal(part.settledMinor, 20000);
    const firstLines = JSON.stringify([...docs.values()].filter(row => row.saleId === first.sale.id && row.productId));
    const firstPayments = JSON.stringify(payments(first.sale.id));
    assert.equal(stock(), 8);
    const beforeWrongCustomer = docs.size;
    await assert.rejects(createSale.run({ auth, data: { ...round('wrong-customer', 'new-local-tab', 1), customerId: 'brian' } }), /another customer account/);
    assert.equal(docs.size, beforeWrongCustomer, 'a refused account mismatch writes no sale or payment');
    assert.equal(stock(), 8, 'a refused account mismatch moves no stock');

    // The customer comes back. Another till, with its own local tab id, adds one more tea.
    const added = await createSale.run({ auth, data: round('nicole-round-2', 'tab-on-till-b', 1) });
    assert.equal(added.sale.tabId, 'tab-on-till-a', 'the round joins the existing tab, not a second one');
    assert.equal(added.sale.orderReference, 'ORD-NICOLE');
    assert.equal(added.sale.customerId, 'nicole');
    assert.equal(added.sale.staffId, 'cashier');
    assert.equal(added.sale.totalMinor, 26000);
    assert.equal(stock(), 7, 'only the new tea leaves stock');

    // Earlier items and payment history are untouched; nothing reads as paid.
    assert.equal(JSON.stringify([...docs.values()].filter(row => row.saleId === first.sale.id && row.productId)), firstLines);
    assert.equal(JSON.stringify(payments(first.sale.id)), firstPayments);
    assert.equal(outstandingMinor(payments(first.sale.id)), 32000);
    assert.equal(outstandingMinor(payments(added.sale.id)), 26000);
    assert.equal(payments(added.sale.id).filter(row => row.method !== 'credit').length, 0, 'adding items records no payment');

    // A retried upload replays the same round: no second sale, payment or stock movement.
    const before = docs.size;
    assert.equal((await createSale.run({ auth, data: round('nicole-round-2', 'tab-on-till-b', 1) })).replayed, true);
    assert.equal(docs.size, before);
    assert.equal(stock(), 7);

    // Another business cannot add to it.
    const other = { ...auth, token: { ...auth.token, tenant_id: 'other-business' } };
    await assert.rejects(createSale.run({ auth: other, data: round('nicole-round-3', 'tab-on-till-a', 1) }));
    assert.equal(stock(), 7);
  } finally { restore(); }
});
