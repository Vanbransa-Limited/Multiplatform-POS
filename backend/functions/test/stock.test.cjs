const test = require('node:test');
const assert = require('node:assert/strict');
const { storeEnabled, sellingLocation, locationsFor, receivingLocation } = require('../lib/modules/stock');
const { changeStock, configureStock } = require('../lib/modules/stock');
const { db } = require('../lib/lib/firebase');

test('every business has a House; the Store is the optional room in front of it', () => {
  assert.equal(sellingLocation(), 'HOUSE');
  assert.deepEqual(locationsFor({ storeEnabled: false }), ['HOUSE']);
  assert.deepEqual(locationsFor({ storeEnabled: true }), ['STORE', 'HOUSE']);
  // With a Store there is one door for deliveries, and it is the Store.
  assert.equal(receivingLocation({ storeEnabled: true }), 'STORE');
  assert.equal(receivingLocation({ storeEnabled: false }), 'HOUSE');
});

test('tenants never migrated off the old three-way mode keep the Store they had', () => {
  assert.equal(storeEnabled({ stockMode: 'both' }), true);
  assert.equal(storeEnabled({ stockMode: 'store_only' }), true);
  assert.equal(storeEnabled({ stockMode: 'house_only' }), false);
  // An explicit setting always wins over the legacy field.
  assert.equal(storeEnabled({ stockMode: 'both', storeEnabled: false }), false);
});

/** Minimal in-memory Firestore, matching the substitute the order tests use. */
function harness(docs) {
  const snapshot = (ref) => ({ id: ref.id, ref, exists: docs.has(ref.path), data: () => docs.get(ref.path) });
  const original = { collection: db.collection, runTransaction: db.runTransaction };
  db.collection = (name) => ({
    // `get` matters for reads made outside a transaction, as importStock does.
    doc: (id = `auto-${docs.size}`) => {
      const ref = { id, path: `${name}/${id}` };
      ref.get = async () => snapshot(ref);
      return ref;
    },
    where: (field, op, value) => ({ __where: [name, field, value] }),
  });
  db.runTransaction = async (fn) => {
    const writes = [];
    const result = await fn({
      getAll: async (...refs) => refs.map(snapshot),
      get: async (target) => (target.__where
        ? { docs: [...docs].filter(([path, data]) => path.startsWith(`${target.__where[0]}/`) && data[target.__where[1]] === target.__where[2]).map(([path]) => snapshot({ id: path.split('/')[1], path })) }
        : snapshot(target)),
      create: (ref, data) => { assert.equal(docs.has(ref.path), false, `already exists: ${ref.path}`); writes.push([ref.path, data]); },
      set: (ref, data, options) => writes.push([ref.path, options?.merge ? { ...docs.get(ref.path), ...data } : data]),
      update: (ref, data) => writes.push([ref.path, { ...docs.get(ref.path), ...data }]),
    });
    writes.forEach(([path, data]) => docs.set(path, data));
    return result;
  };
  return () => { db.collection = original.collection; db.runTransaction = original.runTransaction; };
}

const base = () => new Map([
  ['tenant_settings/t1', { storeEnabled: true }],
  ['branches/b1', { tenantId: 't1', status: 'active' }],
  ['products/p1', { tenantId: 't1', name: 'Tusker' }],
]);
const keeper = { token: { tenant_id: 't1', staff_id: 's1', staff_role: 'store_keeper' } };
const owner = { token: { tenant_id: 't1', staff_id: 's9', staff_role: 'owner' } };
const call = (auth, data) => changeStock.run({ auth, data: { branchId: 'b1', productId: 'p1', ...data } });

test('with a Store enabled a delivery can only land in the Store', async () => {
  const docs = base();
  const restore = harness(docs);
  try {
    // The client asks for HOUSE; the server puts it in the Store regardless.
    const result = await call(keeper, { action: 'receive', qty: 40, location: 'HOUSE', requestId: 'r1' });
    assert.equal(result.location, 'STORE');
    assert.equal(docs.get('stock_balances/b1_p1_STORE').qty, 40);
    assert.equal(docs.has('stock_balances/b1_p1_HOUSE'), false);
  } finally { restore(); }
});

test('a House request is fulfilled in the same step and cannot overdraw the Store', async () => {
  const docs = base();
  docs.set('stock_balances/b1_p1_STORE', { qty: 40 });
  const restore = harness(docs);
  try {
    await assert.rejects(call(keeper, { action: 'request', qty: 41, requestId: 'r2' }), /holds only 40/);
    const result = await call(keeper, { action: 'request', qty: 15, requestId: 'r3' });
    assert.equal(result.location, 'HOUSE');
    // Both sides move together: no pending state for stock to sit in.
    assert.equal(docs.get('stock_balances/b1_p1_HOUSE').qty, 15);
    assert.equal(docs.get('stock_balances/b1_p1_STORE').qty, 25);
    // One movement per side, so the trail explains where the 15 came from.
    const moves = [...docs].filter(([path]) => path.startsWith('stock_movements/')).map(([, data]) => data);
    assert.deepEqual(moves.map((m) => [m.location, m.qty]).sort(), [['HOUSE', 15], ['STORE', -15]]);
  } finally { restore(); }
});

test('without a Store, deliveries land in the House and there is nothing to request from', async () => {
  const docs = base();
  docs.set('tenant_settings/t1', { storeEnabled: false });
  const restore = harness(docs);
  try {
    const result = await call(keeper, { action: 'receive', qty: 12, requestId: 'r4' });
    assert.equal(result.location, 'HOUSE');
    await assert.rejects(call(keeper, { action: 'request', qty: 1, requestId: 'r5' }), /no Store/);
  } finally { restore(); }
});

test('correcting a count is the owner\'s alone and never happens without a reason', async () => {
  const docs = base();
  docs.set('stock_balances/b1_p1_HOUSE', { qty: 10 });
  const restore = harness(docs);
  try {
    await assert.rejects(call(keeper, { action: 'adjust', qty: 8, location: 'HOUSE', expectedQty: 10, reason: 'Breakage', requestId: 'r6' }), /Only the owner/);
    await assert.rejects(call(owner, { action: 'adjust', qty: 8, location: 'HOUSE', expectedQty: 10, requestId: 'r7' }), /reason/);
    // A stale count is refused rather than silently overwriting someone else.
    await assert.rejects(call(owner, { action: 'adjust', qty: 8, location: 'HOUSE', expectedQty: 9, reason: 'Breakage', requestId: 'r8' }), /Refresh/);
    const result = await call(owner, { action: 'adjust', qty: 8, location: 'HOUSE', expectedQty: 10, reason: 'Two bottles broken', requestId: 'r9' });
    assert.equal(result.qty, 8);
    const audit = [...docs].find(([path]) => path.startsWith('audit_logs/'))[1];
    assert.equal(audit.action, 'stock.adjust');
    assert.equal(audit.metadata.reason, 'Two bottles broken');
    assert.equal(audit.metadata.before, 10);
    assert.equal(audit.metadata.after, 8);
    assert.equal(audit.actorStaffId, 's9');
  } finally { restore(); }
});

test('switching the Store off folds what it holds into the House', async () => {
  const docs = base();
  docs.set('stock_balances/b1_p1_STORE', { tenantId: 't1', branchId: 'b1', productId: 'p1', location: 'STORE', qty: 25 });
  docs.set('stock_balances/b1_p1_HOUSE', { tenantId: 't1', branchId: 'b1', productId: 'p1', location: 'HOUSE', qty: 15 });
  const restore = harness(docs);
  try {
    await assert.rejects(configureStock.run({ auth: keeper, data: { storeEnabled: false } }), /Only the owner/);
    const result = await configureStock.run({ auth: owner, data: { storeEnabled: false } });
    assert.equal(result.moved, 1);
    // Nothing is stranded where service cannot reach it.
    assert.equal(docs.get('stock_balances/b1_p1_STORE').qty, 0);
    assert.equal(docs.get('stock_balances/b1_p1_HOUSE').qty, 40);
    assert.equal(docs.get('tenant_settings/t1').storeEnabled, false);
  } finally { restore(); }
});

const { SELLING_ROLES, DISCOUNT_ROLES } = require('../lib/modules/sales/constants');

test('a supervisor sells at the till but still cannot hand out discounts', () => {
  assert.equal(SELLING_ROLES.has('supervisor'), true);
  // Selling is floor work; discounting is a money decision and stays above it.
  assert.equal(DISCOUNT_ROLES.has('supervisor'), false);
  // A store keeper handles stock, not the till.
  assert.equal(SELLING_ROLES.has('store_keeper'), false);
});

const { publicProduct } = require('../lib/modules/customer-orders/domain');

test('store-only items are sellable at the till but never advertised', () => {
  const base = { tenantId: 't1', name: 'Cooking gas', isActive: true, sellPriceMinor: 5000 };
  // Absent means shown: every product predates the flag.
  assert.ok(publicProduct('p1', base));
  assert.equal(publicProduct('p1', { ...base, showOnMenu: true }) === null, false);
  assert.equal(publicProduct('p1', { ...base, showOnMenu: false }), null);
});

const { importStock } = require('../lib/modules/stock');

test('a delivery sheet books in, and a bad row is named rather than skipped silently', async () => {
  const docs = base();
  const { deterministicId } = require('../lib/shared/identifiers');
  const goodId = deterministicId('product', 't1:SKU-1');
  docs.set(`products/${goodId}`, { tenantId: 't1', name: 'Tusker' });
  const restore = harness(docs);
  const originalGetAll = db.getAll;
  const originalBatch = db.batch;
  db.getAll = async (...refs) => refs.map((ref) => ({ id: ref.id, ref, exists: docs.has(ref.path), data: () => docs.get(ref.path) }));
  db.batch = () => ({
    set: (ref, data, options) => docs.set(ref.path, options?.merge ? { ...docs.get(ref.path), ...data } : data),
    commit: async () => {},
  });
  try {
    const result = await importStock.run({
      auth: keeper,
      data: { mode: 'receive', branchId: 'b1', batchId: 'batch1', rows: [
        { sku: 'SKU-1', qty: 24 },
        { sku: 'SKU-1', qty: 6 },
        { sku: 'NOPE', qty: 5 },
        { sku: 'SKU-1', qty: 'many' },
      ] },
    });
    assert.equal(result.location, 'STORE');
    assert.equal(result.imported, 1);
    // The same item twice in one delivery is one arrival of the sum.
    assert.equal(docs.get(`stock_balances/b1_${goodId}_STORE`).qty, 30);
    const reasons = result.rejected.map((r) => r.message).join(' ');
    assert.match(reasons, /not a whole quantity/);
    assert.match(reasons, /No such item/);
  } finally { restore(); db.getAll = originalGetAll; db.batch = originalBatch; }
});

test('a counted sheet is the owner\'s alone and needs a reason', async () => {
  const docs = base();
  const restore = harness(docs);
  try {
    await assert.rejects(importStock.run({ auth: keeper, data: { mode: 'count', branchId: 'b1', batchId: 'b2', reason: 'x', rows: [{ sku: 'S', qty: 1 }] } }), /Only the owner/);
    await assert.rejects(importStock.run({ auth: owner, data: { mode: 'count', branchId: 'b1', batchId: 'b3', rows: [{ sku: 'S', qty: 1 }] } }), /reason/);
  } finally { restore(); }
});

test('bar staff may pull stock into the House but never book a delivery', async () => {
  const docs = base();
  docs.set('stock_balances/b1_p1_STORE', { qty: 10 });
  const bar = { token: { tenant_id: 't1', staff_id: 's4', staff_role: 'bar_staff' } };
  const restore = harness(docs);
  try {
    const moved = await call(bar, { action: 'request', qty: 4, requestId: 'bar1' });
    assert.equal(moved.qty, 4);
    await assert.rejects(call(bar, { action: 'receive', qty: 4, requestId: 'bar2' }), /stock management staff/);
    await assert.rejects(call(bar, { action: 'adjust', qty: 1, location: 'HOUSE', expectedQty: 4, reason: 'x', requestId: 'bar3' }), /Only the owner/);
  } finally { restore(); }
});

const { upsertCategory } = require('../lib/modules/catalogue');

test('a product type can be created, and renaming keeps everything filed under it', async () => {
  const docs = new Map([['tenants/t1', { status: 'active' }]]);
  const restore = harness(docs);
  const manager = { token: { tenant_id: 't1', staff_id: 's2', staff_role: 'store_manager' } };
  try {
    await assert.rejects(upsertCategory.run({ auth: keeper, data: { name: 'Pastries' } }), /owner or store manager/);
    await assert.rejects(upsertCategory.run({ auth: manager, data: { name: '' } }), /name/);

    const made = await upsertCategory.run({ auth: manager, data: { name: 'Pastries' } });
    assert.equal(made.created, true);
    assert.equal(made.name, 'Pastries');
    assert.equal(docs.get(`categories/${made.id}`).tenantId, 't1');

    // The same name resolves to the same id, so it is not duplicated.
    const again = await upsertCategory.run({ auth: manager, data: { name: 'Pastries' } });
    assert.equal(again.id, made.id);
    assert.equal(again.created, false);

    // Renaming keeps the id, so products already filed under it follow.
    const renamed = await upsertCategory.run({ auth: manager, data: { id: made.id, name: 'Bakery' } });
    assert.equal(renamed.id, made.id);
    assert.equal(docs.get(`categories/${made.id}`).name, 'Bakery');
  } finally { restore(); }
});

const { retireProduct } = require('../lib/modules/catalogue');

test('removing a product retires it rather than deleting what history points at', async () => {
  const docs = new Map([['products/p9', { tenantId: 't1', sku: 'SKU-9', name: 'Old Lager', isActive: true, showOnMenu: true }]]);
  const restore = harness(docs);
  const manager = { token: { tenant_id: 't1', staff_id: 's2', staff_role: 'store_manager' } };
  try {
    await assert.rejects(retireProduct.run({ auth: keeper, data: { productId: 'p9' } }), /owner or store manager/);
    await assert.rejects(retireProduct.run({ auth: manager, data: { productId: 'nope' } }), /not found/);

    const gone = await retireProduct.run({ auth: manager, data: { productId: 'p9' } });
    assert.equal(gone.name, 'Old Lager');
    const after = docs.get('products/p9');
    // The row survives: sale lines and stock movements still point at it.
    assert.equal(after.name, 'Old Lager');
    assert.equal(after.isActive, false);
    assert.equal(after.showOnMenu, false);
    // Off the menu for the same reason it is off the till.
    assert.equal(publicProduct('p9', after), null);
  } finally { restore(); }
});
