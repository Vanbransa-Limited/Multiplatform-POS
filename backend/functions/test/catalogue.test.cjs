const test = require('node:test');
const assert = require('node:assert/strict');
const { importProducts, priceCell, matchKey } = require('../lib/modules/catalogue');
const { db } = require('../lib/lib/firebase');

/** Minimal in-memory Firestore covering the batch and query this module uses. */
function harness(docs) {
  const original = { collection: db.collection, batch: db.batch };
  db.collection = (name) => ({
    doc: (id = `auto-${docs.size}`) => ({ id, path: `${name}/${id}` }),
    add: async (data) => { docs.set(`${name}/auto-${docs.size}`, data); },
    where: (field, _op, value) => ({
      get: async () => ({
        docs: [...docs]
          .filter(([path, data]) => path.startsWith(`${name}/`) && data[field] === value)
          .map(([path, data]) => ({ id: path.split('/')[1], data: () => data })),
      }),
    }),
  });
  db.batch = () => {
    const writes = [];
    return {
      set: (ref, data, options) => {
        assert.ok(!writes.some(([path]) => path === ref.path), `same document written twice: ${ref.path}`);
        writes.push([ref.path, options?.merge ? { ...docs.get(ref.path), ...data } : data]);
      },
      commit: async () => writes.forEach(([path, data]) => docs.set(path, data)),
    };
  };
  return () => { db.collection = original.collection; db.batch = original.batch; };
}

const owner = { token: { tenant_id: 't1', staff_id: 's1', staff_role: 'owner' } };
const run = (rows) => importProducts.run({ auth: owner, data: { rows } });
const products = (docs) => [...docs]
  .filter(([path]) => path.startsWith('products/'))
  .map(([, data]) => data);
const find = (docs, name) => products(docs).find((p) => p.name === name);

test('a blank cell is not a price of zero', () => {
  assert.equal(priceCell(''), undefined);
  assert.equal(priceCell('   '), undefined);
  assert.equal(priceCell(null), undefined);
  assert.equal(priceCell(0), 0);
  assert.equal(priceCell('0'), 0);
  assert.equal(priceCell('KES 1,250.50'), 125050);
  assert.equal(priceCell('abc'), 0); // no digits at all reads as zero, not invalid
  assert.equal(priceCell('-5'), null);
});

test('spacing and case do not fork one product into two', () => {
  assert.equal(matchKey(' Tusker   Lager '), 'TUSKER LAGER');
  assert.equal(matchKey('tusker lager'), 'TUSKER LAGER');
});

test('a second sheet reprices the products already there instead of duplicating them', async () => {
  const docs = new Map();
  const restore = harness(docs);
  try {
    const first = await run([{ sku: 'BEER-1', name: 'Tusker Lager', sellPrice: '300', costPrice: '200' }]);
    assert.equal(first.created, 1);
    assert.equal(first.updated, 0);

    const second = await run([{ sku: 'BEER-1', name: 'Tusker Lager', sellPrice: '350' }]);
    assert.equal(second.created, 0, 'the second sheet must not stand up a new product');
    assert.equal(second.updated, 1);
    assert.equal(products(docs).length, 1);
    assert.equal(find(docs, 'Tusker Lager').sellPriceMinor, 35000);

    // And it says what moved, so a manager can see the change took.
    assert.deepEqual(second.repriced, [
      { sku: 'BEER-1', name: 'Tusker Lager', fromMinor: 30000, toMinor: 35000 },
    ]);
  } finally {
    restore();
  }
});

test('a sheet with no product codes still matches on the name', async () => {
  const docs = new Map();
  const restore = harness(docs);
  try {
    await run([{ name: 'Nyama Choma', sellPrice: '800' }]);
    // Same item, typed with different spacing and case the second time.
    const second = await run([{ name: 'nyama  choma', sellPrice: '950' }]);
    assert.equal(second.updated, 1);
    assert.equal(products(docs).length, 1);
    assert.equal(products(docs)[0].sellPriceMinor, 95000);
  } finally {
    restore();
  }
});

test('a blank price leaves the product priced as it was', async () => {
  const docs = new Map();
  const restore = harness(docs);
  try {
    await run([{ sku: 'S-1', name: 'Soda', sellPrice: '150', costPrice: '90' }]);
    const second = await run([{ sku: 'S-1', name: 'Soda', sellPrice: '' }]);

    const soda = find(docs, 'Soda');
    assert.equal(soda.sellPriceMinor, 15000, 'a blank cell must not wipe the price');
    assert.equal(soda.costPriceMinor, 9000);
    assert.equal(soda.isActive, true, 'and must not take the product off sale');
    assert.deepEqual(second.repriced, []);
    assert.deepEqual(second.unpriced, []);
  } finally {
    restore();
  }
});

test('an explicit zero still means unpriced and off sale', async () => {
  const docs = new Map();
  const restore = harness(docs);
  try {
    await run([{ sku: 'S-2', name: 'Water', sellPrice: '100' }]);
    const second = await run([{ sku: 'S-2', name: 'Water', sellPrice: '0' }]);

    assert.equal(find(docs, 'Water').sellPriceMinor, 0);
    assert.equal(find(docs, 'Water').isActive, false);
    assert.equal(second.unpriced.length, 1);
  } finally {
    restore();
  }
});

test('a price-only sheet keeps the category, unit and tax code it does not carry', async () => {
  const docs = new Map();
  const restore = harness(docs);
  try {
    await run([{
      sku: 'F-1', name: 'Ugali', sellPrice: '100',
      categoryId: 'cat-food', uom: 'PLATE', taxCode: 'B',
    }]);
    await run([{ sku: 'F-1', name: 'Ugali', sellPrice: '120' }]);

    const ugali = find(docs, 'Ugali');
    assert.equal(ugali.sellPriceMinor, 12000);
    assert.equal(ugali.categoryId, 'cat-food', 'a missing column must not clear the category');
    assert.equal(ugali.uom, 'PLATE');
    assert.equal(ugali.taxCode, 'B', 'a missing tax column must not move the item to 16%');
  } finally {
    restore();
  }
});

test('two rows pointing at the same existing product are reported, not collided', async () => {
  const docs = new Map();
  const restore = harness(docs);
  try {
    await run([{ sku: 'B-9', name: 'Whitecap', sellPrice: '300' }]);
    // A second code for a product already filed under this name.
    const second = await run([
      { sku: 'B-9', name: 'Whitecap', sellPrice: '320' },
      { sku: 'B-9-ALT', name: 'whitecap', sellPrice: '340' },
    ]);

    assert.equal(second.imported, 1);
    assert.equal(second.rejected.length, 1);
    assert.match(second.rejected[0].message, /already updates/);
    assert.equal(find(docs, 'Whitecap').sellPriceMinor, 32000);
  } finally {
    restore();
  }
});

test('a new product on a re-import is created alongside the ones being repriced', async () => {
  const docs = new Map();
  const restore = harness(docs);
  try {
    await run([{ sku: 'A-1', name: 'Chips', sellPrice: '200' }]);
    const second = await run([
      { sku: 'A-1', name: 'Chips', sellPrice: '250' },
      { sku: 'A-2', name: 'Samosa', sellPrice: '120' },
    ]);

    assert.equal(second.created, 1);
    assert.equal(second.updated, 1);
    assert.equal(products(docs).length, 2);
  } finally {
    restore();
  }
});
