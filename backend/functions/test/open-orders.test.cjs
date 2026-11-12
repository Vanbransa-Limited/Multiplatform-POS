const test = require('node:test');
const assert = require('node:assert/strict');
const { publishOpenOrders } = require('../lib/modules/sales/open-orders');
const { db } = require('../lib/lib/firebase');

/** In-memory Firestore covering the chained where and the batch this uses. */
function harness(docs) {
  const original = { collection: db.collection, batch: db.batch };
  const query = (name, filters) => ({
    where: (field, _op, value) => query(name, [...filters, [field, value]]),
    get: async () => ({
      docs: [...docs]
        .filter(([path, data]) => path.startsWith(`${name}/`)
          && filters.every(([field, value]) => data[field] === value))
        .map(([path, data]) => ({ id: path.split('/')[1], ref: { path }, data: () => data })),
    }),
  });
  db.collection = (name) => ({
    doc: (id) => ({ id, path: `${name}/${id}` }),
    where: (field, op, value) => query(name, [[field, value]]).where(field, op, value),
  });
  db.batch = () => {
    const writes = [];
    return {
      set: (ref, data) => writes.push(['set', ref.path, data]),
      delete: (ref) => writes.push(['delete', ref.path]),
      commit: async () => {
        assert.ok(writes.length <= 450, 'archive/delete pairs must fit a bounded batch');
        writes.forEach(([op, path]) => {
          if (op === 'delete') assert.ok(writes.some(([operation, target]) => operation === 'set'
            && target.startsWith(`open_order_archive/${path.split('/')[1]}_`)), 'deletion must archive in the same commit');
        });
        writes.forEach(([op, path, data]) => {
        if (op === 'set') docs.set(path, data); else docs.delete(path);
      }); },
    };
  };
  return () => { db.collection = original.collection; db.batch = original.batch; };
}

const auth = { token: { tenant_id: 't1', staff_id: 'staff-a', staff_role: 'cashier' } };
const order = (key, extra = {}) => ({
  key, ref: `TAB-${key}`, tableNumber: '4', totalMinor: 250000, dueMinor: 250000,
  lines: [{ name: 'Tusker', qty: 2 }], ...extra,
});

test('published zero-value sales retain explicit payment state without marking open tabs paid', async () => {
  const docs = new Map();
  const restore = harness(docs);
  try {
    await publishOpenOrders.run({ auth, data: { branchId: 'b1', deviceId: 'd1', orders: [
      order('free-paid', { kind: 'sale', totalMinor: 0, dueMinor: 0, paymentStatus: 'paid' }),
      order('free-pending', { kind: 'sale', totalMinor: 0, dueMinor: 0, paymentStatus: 'unpaid' }),
      order('tab', { kind: 'tab', paymentStatus: 'paid' }),
    ] } });
    const rows = [...docs.values()];
    assert.equal(rows.find(row => row.tabId === 'free-paid').paymentStatus, 'paid');
    assert.equal(rows.find(row => row.tabId === 'free-pending').paymentStatus, 'unpaid');
    assert.equal(rows.find(row => row.tabId === 'tab').paymentStatus, 'unpaid');
  } finally { restore(); }
});

test('malformed or oversized snapshots cannot clear existing orders', async () => {
  const docs = new Map([['open_orders/held', { tenantId: 't1', deviceId: 'd1', tabId: 'table-4' }]]);
  const restore = harness(docs);
  try {
    for (const orders of [undefined, {}, Array.from({ length: 201 }, (_, i) => order(`tab${i}`))]) {
      await assert.rejects(publishOpenOrders.run({ auth, data: { branchId: 'b1', deviceId: 'd1', orders } }), /Existing orders were not changed/);
      assert.ok(docs.has('open_orders/held'));
      assert.equal(docs.size, 1);
    }
  } finally { restore(); }
});

test('replacing 200 orders archives every removed snapshot within bounded atomic pairs', async () => {
  const docs = new Map();
  const restore = harness(docs);
  try {
    await publishOpenOrders.run({ auth, data: { branchId: 'b1', deviceId: 'd1', orders: Array.from({ length: 200 }, (_, i) => order(`old${i}`)) } });
    await publishOpenOrders.run({ auth, data: { branchId: 'b1', deviceId: 'd1', orders: Array.from({ length: 200 }, (_, i) => order(`new${i}`)) } });
    assert.equal([...docs.keys()].filter(path => path.startsWith('open_orders/')).length, 200);
    assert.equal([...docs.keys()].filter(path => path.startsWith('open_order_archive/')).length, 200);
  } finally { restore(); }
});

test('only signed-in selling staff may publish open tabs', async () => {
  for (const token of [undefined, {}, { tenant_id: 't1', staff_id: 's1', staff_role: 'customer' }]) {
    await assert.rejects(
      () => publishOpenOrders.run({ auth: { token }, data: { branchId: 'b1', deviceId: 'd1', orders: [] } }),
      /Sign in to publish open tabs/,
    );
  }
});

test('a device replaces its own open tabs and never touches another device or tenant', async () => {
  const docs = new Map([
    // Another device's table, and another business entirely. Neither is this
    // device's to clear, and clearing them would empty the owner's board.
    ['open_orders/other-device', { tenantId: 't1', deviceId: 'd2', tabId: 'tab-9' }],
    ['open_orders/other-tenant', { tenantId: 't2', deviceId: 'd1', tabId: 'tab-9' }],
  ]);
  const restore = harness(docs);
  try {
    const first = await publishOpenOrders.run({
      auth, data: { branchId: 'b1', deviceId: 'd1', orders: [order('tab-1'), order('tab-2')] },
    });
    assert.equal(first.published, 2);

    const mine = [...docs].filter(([path, data]) => path.startsWith('open_orders/') && data.deviceId === 'd1' && data.tenantId === 't1');
    assert.equal(mine.length, 2);
    const [, row] = mine[0];
    assert.equal(row.branchId, 'b1');
    assert.equal(row.status, 'open');
    assert.equal(row.paymentStatus, 'unpaid');
    assert.equal(row.staffId, 'staff-a');
    assert.deepEqual(row.lines, [{ name: 'Tusker', qty: 2 }]);

    // tab-1 settled, so it must stop showing as open everywhere.
    const second = await publishOpenOrders.run({
      auth, data: { branchId: 'b1', deviceId: 'd1', orders: [order('tab-2')] },
    });
    assert.equal(second.published, 1);
    assert.equal(second.cleared, 1);
    assert.equal([...docs].filter(([path, d]) => path.startsWith('open_orders/') && d.deviceId === 'd1' && d.tenantId === 't1').length, 1);
    const archived = [...docs].filter(([path]) => path.startsWith('open_order_archive/'));
    assert.equal(archived.length, 1);
    assert.equal(archived[0][1].tabId, 'tab-1');
    assert.equal(archived[0][1].archiveReason, 'omitted_from_publisher_snapshot');

    // Untouched throughout.
    assert.ok(docs.has('open_orders/other-device'));
    assert.ok(docs.has('open_orders/other-tenant'));
  } finally {
    restore();
  }
});

test('an empty list closes every tab this device had open', async () => {
  const docs = new Map();
  const restore = harness(docs);
  try {
    await publishOpenOrders.run({ auth, data: { branchId: 'b1', deviceId: 'd1', orders: [order('tab-1')] } });
    assert.equal(docs.size, 1);
    // A till that closes its last table must not leave it running on the board.
    const result = await publishOpenOrders.run({ auth, data: { branchId: 'b1', deviceId: 'd1', orders: [] } });
    assert.equal(result.published, 0);
    assert.equal(result.cleared, 1);
    assert.equal([...docs.keys()].filter(path => path.startsWith('open_orders/')).length, 0);
    assert.equal([...docs.keys()].filter(path => path.startsWith('open_order_archive/')).length, 1);
  } finally {
    restore();
  }
});

test('a standalone unpaid order publishes as itself, not only tabs', async () => {
  const docs = new Map();
  const restore = harness(docs);
  try {
    // An order registered at Pay Now with no tab behind it is exactly as
    // invisible to the rest of the business as a tab round, so it publishes
    // under its own sale id.
    await publishOpenOrders.run({
      auth,
      data: { branchId: 'b1', deviceId: 'd1', orders: [order('sale-77', { kind: 'sale', ref: 'ORD-2-939125' })] },
    });
    const [, row] = [...docs][0];
    assert.equal(row.kind, 'sale');
    assert.equal(row.ref, 'ORD-2-939125');
    assert.equal(row.tabId, 'sale-77');
  } finally {
    restore();
  }
});

test('junk figures are recorded as zero rather than as money', async () => {
  const docs = new Map();
  const restore = harness(docs);
  try {
    await publishOpenOrders.run({
      auth,
      data: { branchId: 'b1', deviceId: 'd1', orders: [order('tab-1', { totalMinor: 'lots', dueMinor: -5, lines: [{ name: 'Ghost', qty: -3 }] })] },
    });
    const [, row] = [...docs][0];
    assert.equal(row.totalMinor, 0);
    assert.equal(row.dueMinor, 0);
    assert.equal(row.lines[0].qty, 0);
  } finally {
    restore();
  }
});
