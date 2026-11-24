const test = require('node:test');
const assert = require('node:assert/strict');
const { catalogueWriteRefusal } = require('../lib/modules/catalogue/write-rule');

// Judith (store manager), 24 Nov 9 PM: "Can't add gas 45kgs" - refused three times.
test('a store manager can add a new stock item, unpriced', () => {
  assert.equal(catalogueWriteRefusal('store_manager', { exists: false, sellPriceMinor: 0 }), null);
});

test('a store manager cannot price an item or change an existing one', () => {
  assert.match(catalogueWriteRefusal('store_manager', { exists: false, sellPriceMinor: 50000 }), /owner or manager sets its price/);
  assert.match(catalogueWriteRefusal('store_manager', { exists: true, sellPriceMinor: 0 }), /already exists/);
});

test('owners and managers keep full catalogue access; other roles none', () => {
  assert.equal(catalogueWriteRefusal('owner', { exists: true, sellPriceMinor: 50000 }), null);
  assert.equal(catalogueWriteRefusal('manager', { exists: false, sellPriceMinor: 50000 }), null);
  for (const role of ['supervisor', 'cashier', 'bar_staff', 'store_keeper', '']) {
    assert.match(catalogueWriteRefusal(role, { exists: false, sellPriceMinor: 0 }), /Only an owner or manager/);
  }
});
