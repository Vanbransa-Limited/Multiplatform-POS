import assert from 'node:assert/strict';
import test from 'node:test';

import { staffDiscountAsLineDiscounts } from './tender.js';

const sum = (rows) => rows.reduce((total, row) => total + row.discountMinor, 0);

test('the staff discount leaves as a line discount, not as a product', () => {
  const lines = [
    { product_id: 'p1', qty: 2, unit_price: 150, discount: 0 },
    { product_id: 'p2', qty: 1, unit_price: 200, discount: 0 },
    // Booked at zero: it is a percentage off, not something sold.
    { product_id: 'prod-staff-discount', qty: 1, unit_price: 0, discount: 0 },
  ];
  // 20% of 500.
  const rows = staffDiscountAsLineDiscounts(lines, { discount: 100 });

  assert.equal(rows.length, 2, 'the pseudo-product never reaches the server');
  assert.ok(!rows.some((row) => row.productId === 'prod-staff-discount'));
  assert.equal(sum(rows), 10000, 'the whole discount still comes off');
  // Spread by what each line is worth: 300 and 200 of a 500 cart.
  assert.deepEqual(rows.map((row) => row.discountMinor), [6000, 4000]);
});

test('a line that already carried a discount keeps it, and gets its share on top', () => {
  const lines = [
    { product_id: 'p1', qty: 1, unit_price: 100, discount: 10 },
    { product_id: 'p2', qty: 1, unit_price: 100, discount: 0 },
    { product_id: 'prod-staff-discount', qty: 1, unit_price: 0, discount: 0 },
  ];
  // Header carries the line's own 10 plus 40 of staff discount.
  const rows = staffDiscountAsLineDiscounts(lines, { discount: 50 });
  assert.equal(sum(rows), 5000);
  assert.equal(rows[0].discountMinor >= 1000, true, 'its own discount survives');
});

test('an ordinary sale is passed through untouched', () => {
  const lines = [{ product_id: 'p1', qty: 3, unit_price: 100, discount: 25 }];
  assert.deepEqual(
    staffDiscountAsLineDiscounts(lines, { discount: 25 }),
    [{ productId: 'p1', qty: 3, discountMinor: 2500 }],
  );
});

test('a discount can never exceed what the line is worth', () => {
  const lines = [
    { product_id: 'p1', qty: 1, unit_price: 100, discount: 0 },
    { product_id: 'prod-staff-discount', qty: 1, unit_price: 0, discount: 0 },
  ];
  // A header claiming more than the cart holds cannot push a line negative.
  const rows = staffDiscountAsLineDiscounts(lines, { discount: 500 });
  assert.equal(rows[0].discountMinor, 10000);
});

test('a cart of nothing but the discount is not a sale', () => {
  assert.deepEqual(
    staffDiscountAsLineDiscounts([{ product_id: 'prod-staff-discount', qty: 1, unit_price: 0, discount: 0 }], { discount: 0 }),
    [],
  );
});
