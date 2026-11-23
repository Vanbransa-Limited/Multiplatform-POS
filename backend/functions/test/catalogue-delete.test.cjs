const test = require('node:test');
const assert = require('node:assert/strict');
const { deleteProduct } = require('../lib/modules/catalogue');
const { db } = require('../lib/lib/firebase');
const owner = { token: { tenant_id: 't1', staff_id: 'owner1', staff_role: 'owner' } };
const run = (auth = owner) => deleteProduct.run({ auth, data: { productId: 'p1', confirmProductId: 'p1' } });
function harness(docs) {
  const original = { collection: db.collection, runTransaction: db.runTransaction };
  const snapshot = ref => ({ ref, id: ref.id, exists: docs.has(ref.path), data: () => docs.get(ref.path) });
  db.collection = name => ({
    doc: (id = 'audit1') => ({ id, path: `${name}/${id}` }),
    where: (field, _op, value) => ({ name, field, value }),
  });
  db.runTransaction = async fn => {
    const writes = [];
    const result = await fn({
      get: async target => {
        if (target.path) return snapshot(target);
        const rows = [...docs].filter(([path, data]) => path.startsWith(target.name + '/') && data[target.field] === target.value)
          .map(([path]) => snapshot({ id: path.split('/')[1], path }));
        return { docs: rows, size: rows.length };
      },
      set: (ref, data) => writes.push(() => docs.set(ref.path, data)),
      create: (ref, data) => writes.push(() => docs.set(ref.path, data)),
      delete: ref => writes.push(() => docs.delete(ref.path)),
    });
    writes.forEach(write => write()); return result;
  };
  return () => Object.assign(db, original);
}
const base = () => new Map([
  ['products/p1', { tenantId: 't1', name: 'Rogue duplicate', sku: 'R1' }],
  ['stock_balances/b1', { tenantId: 't1', productId: 'p1', qty: 0 }],
  ['stock_movements/m1', { tenantId: 't1', productId: 'p1', qty: 7 }],
  ['sale_lines/s1', { tenantId: 't1', productId: 'other', productName: 'Original item' }],
  ['products/other', { tenantId: 't2', name: 'Other tenant' }],
]);
test('delete removes only catalogue/zero balance records and preserves history and the other tenant', async () => {
  const docs = base(); const before = new Map(docs); const restore = harness(docs);
  try {
    assert.deepEqual(await run(), { productId: 'p1', deleted: true });
    assert.equal(docs.has('products/p1'), false);
    assert.equal(docs.has('stock_balances/b1'), false);
    assert.equal(docs.get('deleted_products/p1').name, 'Rogue duplicate');
    for (const path of ['stock_movements/m1', 'sale_lines/s1', 'products/other']) assert.deepEqual(docs.get(path), before.get(path));
    assert.equal(docs.get('audit_logs/audit1').action, 'catalogue.product_deleted');
  } finally { restore(); }
});
test('role and tenant checks forbid deletion without mutation', async () => {
  const docs = base(); const restore = harness(docs);
  try {
    for (const role of ['store_keeper', 'store_manager', 'cashier', 'supervisor']) await assert.rejects(run({ token: { ...owner.token, staff_role: role } }), /owner or manager/);
    await assert.rejects(run({ token: { ...owner.token, tenant_id: 't2' } }), /not found/);
    assert.equal(docs.has('products/p1'), true);
  } finally { restore(); }
});
test('remaining stock, reservations and open orders prevent deletion', async () => {
  for (const extra of [
    ['stock_balances/b1', { tenantId: 't1', productId: 'p1', qty: 2 }],
    ['stock_balances/b1', { tenantId: 't1', productId: 'p1', qty: 0, reservedQty: 1 }],
    ['open_orders/tab1', { tenantId: 't1', rounds: [{ lines: [{ product_id: 'p1' }] }] }],
    ['customer_orders/order1', { tenantId: 't1', status: 'received', lines: [{ productId: 'p1' }] }],
  ]) {
    const docs = base(); docs.set(...extra); const restore = harness(docs);
    try { await assert.rejects(run(), /stock|orders/); assert.equal(docs.has('products/p1'), true); }
    finally { restore(); }
  }
});
