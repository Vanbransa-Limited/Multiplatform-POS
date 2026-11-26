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

const { duplicateNameRefusal } = require('../lib/modules/catalogue/write-rule');

// 16 Nov: Tusker could not be found on the Stock screen, so a second
// "TUSKER LAGER BOTTLE 500ML" was added unpriced and deliveries went onto it.
test('a new item that is an existing one under another spelling is refused, naming it', () => {
  const catalogue = [
    { id: 'tusker', name: 'TUSKER LAGER BOTTLE 500ML', isActive: true },
    { id: 'gordons-old', name: 'GORDONS LONDON DRY GIN 750ML (STOCK OF 22/05/26)', isActive: false, retiredAt: 1 },
  ];
  assert.match(duplicateNameRefusal(catalogue, 'Tusker Lager Bottle 500 ml', 'store_manager'), /TUSKER LAGER BOTTLE 500ML/);
  assert.match(duplicateNameRefusal(catalogue, 'tusker bottle 500ml', 'owner'), /already exists/);
  // A can is a different product from a bottle.
  assert.equal(duplicateNameRefusal(catalogue, 'Tusker Lager Can 500ml', 'store_manager'), null);
  // A removed twin: the store asks the owner; the owner may still create.
  assert.match(duplicateNameRefusal(catalogue, 'Gordons London Dry Gin 750ml', 'store_manager'), /restore/);
  assert.equal(duplicateNameRefusal(catalogue, 'Gordons London Dry Gin 750ml', 'owner'), null);
});
