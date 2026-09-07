const test = require('node:test');
const assert = require('node:assert/strict');
const { importProducts, retireMissingProducts, dedupeProducts, priceCell, matchKey } = require('../lib/modules/catalogue');
const { productKey } = require('../lib/modules/catalogue/product-key');
const { retireSeedProducts } = require('../lib/modules/catalogue');
const { isSeedProduct } = require('../lib/modules/catalogue/seed-products');
const { db } = require('../lib/lib/firebase');

/** Minimal in-memory Firestore covering the batch and query this module uses. */
function harness(docs) {
  const original = { collection: db.collection, batch: db.batch, getAll: db.getAll };
  db.getAll = async (...refs) => refs.map((ref) => ({
    id: ref.id,
    ref,
    exists: docs.has(ref.path),
    data: () => docs.get(ref.path),
  }));
  db.collection = (name) => ({
    doc: (id = `auto-${docs.size}`) => ({ id, path: `${name}/${id}` }),
    add: async (data) => { docs.set(`${name}/auto-${docs.size}`, data); },
    where: (field, _op, value) => ({
      get: async () => ({
        docs: [...docs]
          .filter(([path, data]) => path.startsWith(`${name}/`) && data[field] === value)
          .map(([path, data]) => ({ id: path.split('/')[1], ref: { id: path.split('/')[1], path }, data: () => data })),
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
  return () => {
    db.collection = original.collection;
    db.batch = original.batch;
    db.getAll = original.getAll;
  };
}

const owner = { token: { tenant_id: 't1', staff_id: 's1', staff_role: 'owner' } };
const run = (rows) => importProducts.run({ auth: owner, data: { rows } });
const run2 = (rows, batchId) => importProducts.run({ auth: owner, data: { rows, batchId } });
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

const retire = (data) => retireMissingProducts.run({ auth: owner, data });

test('a fresh import retires everything the sheet did not mention', async () => {
  const docs = new Map();
  const restore = harness(docs);
  try {
    // What is already there: an older import and a provisioned demo product.
    await run([{ sku: 'OLD-1', name: 'WHITE CAP CAN (22/05/26)', sellPrice: '400' }]);
    docs.set('products/seeded', {
      id: 'seeded', tenantId: 't1', sku: 'BAR-BEE-03',
      name: 'White Cap Lager 500ml', sellPriceMinor: 25000, isActive: true,
    });

    // The clean sheet, stamped.
    await run2([{ sku: 'NEW-1', name: 'WHITECAP LAGER 500ML CAN', sellPrice: '400' }], 'batch-9');

    const preview = await retire({ batchId: 'batch-9', dryRun: true });
    assert.equal(preview.candidates, 2, 'the old row and the demo product should both be listed');
    assert.equal(preview.retired, 0, 'a dry run must not write');
    assert.equal(find(docs, 'White Cap Lager 500ml').isActive, true);

    const done = await retire({ batchId: 'batch-9' });
    assert.equal(done.retired, 2);
    assert.equal(find(docs, 'White Cap Lager 500ml').isActive, false);
    assert.equal(find(docs, 'White Cap Lager 500ml').showOnMenu, false);
    assert.equal(find(docs, 'WHITE CAP CAN (22/05/26)').isActive, false);
    // The sheet's own product is untouched and still sellable.
    assert.equal(find(docs, 'WHITECAP LAGER 500ML CAN').isActive, true);
    // Nothing is deleted: the history that points at these still resolves.
    assert.equal(products(docs).length, 3);
  } finally {
    restore();
  }
});

test('retiring twice does not keep counting the same products', async () => {
  const docs = new Map();
  const restore = harness(docs);
  try {
    await run([{ sku: 'OLD-2', name: 'Stale', sellPrice: '100' }]);
    await run2([{ sku: 'NEW-2', name: 'Fresh', sellPrice: '100' }], 'batch-x');
    assert.equal((await retire({ batchId: 'batch-x' })).retired, 1);
    assert.equal((await retire({ batchId: 'batch-x' })).retired, 0);
  } finally {
    restore();
  }
});

test('a batch id is required, so a slip cannot retire the whole menu', async () => {
  const docs = new Map();
  const restore = harness(docs);
  try {
    await run([{ sku: 'A', name: 'Anything', sellPrice: '100' }]);
    await assert.rejects(() => retire({}), /batch id is required/);
    assert.equal(find(docs, 'Anything').isActive, true);
  } finally {
    restore();
  }
});

test('only an owner or store manager may retire', async () => {
  const docs = new Map();
  const restore = harness(docs);
  try {
    const keeper = { token: { tenant_id: 't1', staff_id: 's2', staff_role: 'store_keeper' } };
    await assert.rejects(
      () => retireMissingProducts.run({ auth: keeper, data: { batchId: 'b' } }),
      /owner or store manager/
    );
  } finally {
    restore();
  }
});

test('a menu tidy-up does not sweep away the service charges', async () => {
  const docs = new Map();
  const restore = harness(docs);
  try {
    // What provisioning left behind: demo drinks, and the charges the till
    // toggles by id. A price sheet contains neither.
    docs.set('products/prod-coca-cola', {
      id: 'prod-coca-cola', tenantId: 't1', name: 'Coca-Cola 300ml',
      sellPriceMinor: 10000, isActive: true, isService: false,
    });
    docs.set('products/prod-table-service', {
      id: 'prod-table-service', tenantId: 't1', name: 'VIP Service Charge',
      sellPriceMinor: 10000, isActive: true, isService: true,
    });
    docs.set('products/prod-corkage', {
      id: 'prod-corkage', tenantId: 't1', name: 'Corkage Fee',
      sellPriceMinor: 300000, isActive: true, isService: true,
    });

    await run2([{ sku: 'W-1', name: 'WHITECAP LAGER 500ML CAN', sellPrice: '400' }], 'batch-7');
    const done = await retire({ batchId: 'batch-7' });

    assert.equal(done.retired, 1, 'only the demo drink should go');
    assert.equal(find(docs, 'Coca-Cola 300ml').isActive, false);
    assert.equal(find(docs, 'VIP Service Charge').isActive, true, 'the VIP charge must survive a menu import');
    assert.equal(find(docs, 'Corkage Fee').isActive, true);
  } finally {
    restore();
  }
});

const dedupe = (data = {}) => dedupeProducts.run({ auth: owner, data });
const put = (docs, id, name, price, extra = {}) =>
  docs.set(`products/${id}`, { id, tenantId: 't1', name, sellPriceMinor: price, isActive: true, ...extra });

test('one product written many ways lands on one key', () => {
  const same = [
    'WHITE CAP CAN 500ML',
    'WHITE CAP CAN 500ML (STOCK OF 2/06/2026)',
    'WHITECAP LAGER 500ML CAN',
    'WHITE CAP CAN (22/05/26) 500ML',
  ].map(productKey);
  assert.equal(new Set(same).size, 1, `expected one key, got ${[...new Set(same)].join(', ')}`);

  // Size and container are what actually separate two orderable things.
  assert.notEqual(productKey('WHITECAP LAGER 500ML CAN'), productKey('WHITECAP LAGER BOTTLE 500ML'));
  assert.notEqual(productKey('TUSKER LAGER CAN 500ML'), productKey('TUSKER LAGER CAN 330ML'));
  assert.notEqual(productKey('TUSKER'), productKey('TUSKER LITE'));
  // A litre is a litre however it was typed.
  assert.equal(productKey('KERINGET 1L'), productKey('KERINGET 1000ML'));
});

test('the dearer copy survives and the stale cheap one is retired', async () => {
  const docs = new Map();
  const restore = harness(docs);
  try {
    // Exactly what the live menu was showing.
    put(docs, 'demo', 'White Cap Lager 500ml', 25000, { isService: false });
    put(docs, 'imported', 'WHITECAP LAGER 500ML CAN', 40000);
    put(docs, 'dated', 'WHITE CAP CAN 500ML (STOCK OF 2/06/2026)', 40000);
    // A genuinely different product at a lower price: must not be touched.
    put(docs, 'bottle', 'WHITECAP LAGER BOTTLE 500ML', 35000);

    const preview = await dedupe({ dryRun: true });
    assert.equal(preview.candidates, 2);
    assert.equal(preview.retired, 0, 'a dry run must not write');
    assert.equal(find(docs, 'White Cap Lager 500ml').isActive, true);

    const done = await dedupe();
    assert.equal(done.retired, 2);
    assert.equal(find(docs, 'White Cap Lager 500ml').isActive, false, 'the 250 demo copy should go');
    assert.equal(find(docs, 'WHITE CAP CAN 500ML (STOCK OF 2/06/2026)').isActive, false);
    // The dearest of the group, and the bottle, both stand.
    assert.equal(find(docs, 'WHITECAP LAGER 500ML CAN').isActive, true);
    assert.equal(find(docs, 'WHITECAP LAGER BOTTLE 500ML').isActive, true);
  } finally {
    restore();
  }
});

test('on a tie the fuller name wins', async () => {
  const docs = new Map();
  const restore = harness(docs);
  try {
    put(docs, 'short', 'WHITE CAP', 40000);
    put(docs, 'full', 'WHITECAP LAGER CAN', 40000);
    await dedupe();
    assert.equal(find(docs, 'WHITECAP LAGER CAN').isActive, true);
    assert.equal(find(docs, 'WHITE CAP').isActive, false);
  } finally {
    restore();
  }
});

test('service charges are never merged away', async () => {
  const docs = new Map();
  const restore = harness(docs);
  try {
    put(docs, 'vip', 'VIP Service Charge', 10000, { isService: true });
    put(docs, 'vip2', 'VIP SERVICE CHARGE', 0, { isService: true });
    assert.equal((await dedupe()).retired, 0);
    assert.equal(find(docs, 'VIP SERVICE CHARGE').isActive, true);
  } finally {
    restore();
  }
});

test('a catalogue with nothing repeated is left completely alone', async () => {
  const docs = new Map();
  const restore = harness(docs);
  try {
    put(docs, 'a', 'TUSKER LAGER CAN 500ML', 40000);
    put(docs, 'b', 'TUSKER LAGER CAN 330ML', 35000);
    put(docs, 'c', 'TUSKER LITE CAN 500ML', 40000);
    assert.equal((await dedupe()).retired, 0);
    assert.equal(products(docs).filter((p) => p.isActive).length, 3);
  } finally {
    restore();
  }
});

test('an already retired copy is not counted again', async () => {
  const docs = new Map();
  const restore = harness(docs);
  try {
    put(docs, 'keep', 'SNAPP CAN 330ML', 35000);
    put(docs, 'gone', 'SNAPP DRY CIDER CAN 330ML', 30000, { isActive: false, showOnMenu: false });
    assert.equal((await dedupe()).retired, 0);
  } finally {
    restore();
  }
});

const sweep = (data = {}) => retireSeedProducts.run({ auth: owner, data });

test('a demo record is recognised by its id and sku together', () => {
  assert.equal(isSeedProduct('prod-whitecap', { sku: 'BAR-BEE-03' }), true);
  // Same id, but the tenant reused it for something of their own.
  assert.equal(isSeedProduct('prod-whitecap', { sku: 'WC-500-CAN' }), false);
  // An import covered it, so it is part of the real menu now.
  assert.equal(isSeedProduct('prod-whitecap', { sku: 'BAR-BEE-03', lastImportBatch: 'b1' }), false);
  // Service charges are never demo ghosts, whatever their id.
  assert.equal(isSeedProduct('prod-table-service', { sku: 'SRV-TBL-01' }), false);
  assert.equal(isSeedProduct('some-real-product', { sku: 'BAR-BEE-03' }), false);
});

test('the demo bar is swept off a live catalogue, service charges left standing', async () => {
  const docs = new Map();
  const restore = harness(docs);
  try {
    // The ghost from the customer menu, with no duplicate to match it.
    docs.set('products/prod-whitecap', {
      id: 'prod-whitecap', tenantId: 't1', sku: 'BAR-BEE-03',
      name: 'White Cap Lager 500ml', sellPriceMinor: 25000, isActive: true, isService: false,
    });
    docs.set('products/prod-coca-cola', {
      id: 'prod-coca-cola', tenantId: 't1', sku: 'BAR-SFT-01',
      name: 'Coca-Cola 300ml', sellPriceMinor: 10000, isActive: true, isService: false,
    });
    docs.set('products/prod-table-service', {
      id: 'prod-table-service', tenantId: 't1', sku: 'SRV-TBL-01',
      name: 'VIP Service Charge', sellPriceMinor: 10000, isActive: true, isService: true,
    });
    // A real product of theirs that happens to sit on a seed id.
    docs.set('products/prod-water', {
      id: 'prod-water', tenantId: 't1', sku: 'THEIR-OWN-SKU',
      name: 'KERINGET 1L', sellPriceMinor: 25000, isActive: true, isService: false,
    });

    const preview = await sweep({ dryRun: true });
    assert.equal(preview.candidates, 2);
    assert.deepEqual(preview.names.sort(), ['Coca-Cola 300ml', 'White Cap Lager 500ml']);
    assert.equal(find(docs, 'White Cap Lager 500ml').isActive, true, 'a dry run must not write');

    const done = await sweep();
    assert.equal(done.retired, 2);
    assert.equal(find(docs, 'White Cap Lager 500ml').isActive, false);
    assert.equal(find(docs, 'White Cap Lager 500ml').showOnMenu, false);
    assert.equal(find(docs, 'Coca-Cola 300ml').isActive, false);
    assert.equal(find(docs, 'VIP Service Charge').isActive, true, 'the till toggles this by id');
    assert.equal(find(docs, 'KERINGET 1L').isActive, true, 'their own product on a seed id must survive');
  } finally {
    restore();
  }
});

test('sweeping twice retires nothing the second time', async () => {
  const docs = new Map();
  const restore = harness(docs);
  try {
    docs.set('products/prod-fanta', {
      id: 'prod-fanta', tenantId: 't1', sku: 'BAR-SFT-02',
      name: 'Fanta Orange 300ml', sellPriceMinor: 10000, isActive: true, isService: false,
    });
    assert.equal((await sweep()).retired, 1);
    assert.equal((await sweep()).retired, 0);
  } finally {
    restore();
  }
});

test('another tenant demo record is never touched', async () => {
  const docs = new Map();
  const restore = harness(docs);
  try {
    docs.set('products/prod-guinness', {
      id: 'prod-guinness', tenantId: 'someone-else', sku: 'BAR-BEE-02',
      name: 'Guinness Foreign Extra 500ml', sellPriceMinor: 28000, isActive: true, isService: false,
    });
    assert.equal((await sweep()).retired, 0);
    assert.equal(find(docs, 'Guinness Foreign Extra 500ml').isActive, true);
  } finally {
    restore();
  }
});
