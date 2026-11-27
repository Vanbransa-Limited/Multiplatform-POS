const test = require('node:test');
const assert = require('node:assert/strict');
const { db } = require('../lib/lib/firebase');
const { resolveSharedTab } = require('../lib/modules/sales/tab-identity');
const input = { tenantId: 'tenant', branchId: 'b1', tableNumber: '50', tabId: 'new-tab',
  orderReference: 'ORD-NEW', payments: [{ method: 'credit', amountMinor: 10000 }] };

function harness(sales = [], payments = []) {
  const original = db.collection;
  const locks = [];
  const query = (name, constraints = []) => ({ name, constraints,
    doc: id => ({ path: `${name}/${id}` }),
    where: (field, operator, value) => query(name, [...constraints, [field, value]]) });
  db.collection = name => query(name);
  const tx = { get: async target => {
    if (target.path) { locks.push(target.path); return { data: () => undefined }; }
    return { docs: (target.name === 'sales' ? sales : payments)
      .filter(row => target.constraints.every(([key, value]) => row[key] === value))
      .map(row => ({ id: row.id, data: () => row })) };
  } };
  return { tx, locks, restore: () => { db.collection = original; } };
}
const sale = (id, tabId = 'original') => ({ id, tabId, tenantId: 'tenant', branchId: 'b1', tableNumber: '50',
  orderReference: 'ORD-ORIGINAL', status: 'completed' });
const credit = id => ({ saleId: id, tenantId: 'tenant', method: 'credit', amountMinor: 10000 });

test('an uploaded unpaid round supplies the tab identity even when its snapshot is gone', async () => {
  const h = harness([sale('first')], [credit('first')]);
  try {
    const result = await resolveSharedTab(h.tx, input);
    assert.equal(result.data.tabId, 'original');
    assert.equal(result.data.orderReference, 'ORD-ORIGINAL');
    assert.equal(h.locks.length, 1, 'a table lock serializes concurrent first rounds');
  } finally { h.restore(); }
});

test('paid, voided and another branch sales do not revive a previous bill', async () => {
  const h = harness([sale('paid'), { ...sale('void'), status: 'VOIDED' }, { ...sale('other'), branchId: 'b2' }],
    [{ ...credit('paid'), settledAt: 'paid' }, credit('void'), credit('other')]);
  try { assert.equal((await resolveSharedTab(h.tx, input)).data.tabId, 'new-tab'); }
  finally { h.restore(); }
});

test('existing split bills refuse more rounds until reconciled', async () => {
  const h = harness([sale('first'), sale('second', 'split')], [credit('first'), credit('second')]);
  try { await assert.rejects(resolveSharedTab(h.tx, input), /multiple unpaid bills/); }
  finally { h.restore(); }
});

test('table spelling shares a lock while tenants and branches remain isolated', async () => {
  const h = harness();
  try {
    const resolve = value => resolveSharedTab(h.tx, { ...input, ...value });
    const a = await resolve({});
    const b = await resolve({ tableNumber: ' Table  50 ' });
    const c = await resolve({ branchId: 'b2' });
    const d = await resolve({ tenantId: 'other' });
    assert.equal(a.ref.path, b.ref.path);
    assert.notEqual(a.ref.path, c.ref.path);
    assert.notEqual(a.ref.path, d.ref.path);
  } finally { h.restore(); }
});

test('settled sales and takeaway orders never acquire an open-table lock', async () => {
  assert.equal(await resolveSharedTab({}, { ...input, payments: [{ method: 'cash', amountMinor: 10000 }] }), null);
  assert.equal(await resolveSharedTab({}, { ...input, tableNumber: null }), null);
});

test('a paid tab proposed again by a stale device gives the next customer a new tab', async () => {
  const h = harness([sale('paid', 'new-tab')], [{ ...credit('paid'), settledAt: 'paid' }]);
  try {
    const result = await resolveSharedTab(h.tx, { ...input, idempotencyKey: 'round-after-payment' });
    assert.notEqual(result.data.tabId, 'new-tab');
    assert.equal(result.data.orderReference, null, 'the old bill number is not reused');
  } finally { h.restore(); }
});

test('an existing table cannot acquire a round billed to another customer', async () => {
  const h = harness([{ ...sale('first'), customerId: 'nicole' }], [credit('first')]);
  try {
    await assert.rejects(resolveSharedTab(h.tx, { ...input, customerId: 'brian' }), /another customer account/);
    assert.equal((await resolveSharedTab(h.tx, { ...input, customerId: 'nicole' })).data.tabId, 'original');
  } finally { h.restore(); }
});

test('mixed customer accounts on an old tab need review before another round can join', async () => {
  const h = harness([{ ...sale('first'), customerId: 'nicole' }, { ...sale('second'), customerId: 'brian' }],
    [credit('first'), credit('second')]);
  try { await assert.rejects(resolveSharedTab(h.tx, { ...input, customerId: 'nicole' }), /another customer account/); }
  finally { h.restore(); }
});

test('a table session stays OPEN until every round is paid, including while one is being paid', async () => {
  const { refreshTableSession } = require('../lib/modules/sales/tab-identity');
  const sales = [sale('r1'), sale('r2')];
  const payments = [credit('r1'), credit('r2')];
  const original = { collection: db.collection, runTransaction: db.runTransaction };
  const query = (name, constraints = []) => ({ name, constraints, path: undefined,
    doc: id => ({ path: `${name}/${id}` }),
    where: (field, op, value) => query(name, [...constraints, [field, op, value]]) });
  const written = [];
  db.collection = name => query(name);
  db.runTransaction = async run => run({
    get: async target => target.path ? { data: () => undefined } : { docs: (target.name === 'sales' ? sales : payments)
      .filter(row => target.constraints.every(([key, op, value]) => op === 'in' ? value.includes(row[key]) : row[key] === value))
      .map(row => ({ id: row.id, data: () => row })) },
    set: (_ref, data) => written.push(data),
  });
  try {
    payments[0].settledAt = 'paid';
    let session = await refreshTableSession('tenant', 'b1', '50');
    assert.deepEqual([session.status, session.dueMinor], ['OPEN', 10000], 'part paid: still occupied');
    sales[1].checkoutExpiresAt = { toMillis: () => Date.now() + 60_000 };
    session = await refreshTableSession('tenant', 'b1', '50');
    assert.deepEqual([session.status, session.dueMinor], ['OPEN', 10000], 'a checkout in progress does not free it');
    payments[1].settledAt = 'paid';
    session = await refreshTableSession('tenant', 'b1', '50');
    assert.deepEqual([session.status, session.dueMinor], ['SETTLED', 0], 'fully paid: free');
    assert.equal(written.length, 3);
  } finally { Object.assign(db, original); }
});
