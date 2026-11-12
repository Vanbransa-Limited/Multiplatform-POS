import test from 'node:test';
import assert from 'node:assert/strict';
import {
  VIP_CHARGE_ID,
  STAFF_DISCOUNT_ID,
  saleLineRate,
  recordedSaleTotals,
  catalogueCartLines
} from './service-charges.js';

test('a settlement push names the rounds it is charging for, once per product', () => {
  // Two rounds on one tab, the same beer on both, plus the pseudo-products the
  // server has no row for. An empty cart, a repeat, or a staff-discount line
  // each get the push refused and no prompt ever reaches the phone.
  const lines = [
    { sale_id: 'r1', product_id: 'p-beer', qty: 2 },
    { sale_id: 'r1', product_id: STAFF_DISCOUNT_ID, qty: 1 },
    { sale_id: 'r2', product_id: 'p-beer', qty: 3 },
    { sale_id: 'r2', product_id: 'p-nyama', qty: 1 },
    { sale_id: 'r2', product_id: VIP_CHARGE_ID, qty: 1 },
  ];

  assert.deepEqual(catalogueCartLines(lines), [
    { productId: 'p-beer', qty: 5 },
    { productId: 'p-nyama', qty: 1 },
  ]);

  // The server takes positive integers only.
  assert.deepEqual(catalogueCartLines([{ product_id: 'p-x', qty: 1.4 }]), [{ productId: 'p-x', qty: 1 }]);
  assert.deepEqual(catalogueCartLines([{ product_id: 'p-x', qty: 0 }]), []);
  assert.deepEqual(catalogueCartLines([]), []);
});

/** The till's own totals, for a cart of goods plus whichever charges are on. */
function tillTotals({ subtotal, discount = 0, vip = false, staff = false }) {
  const vipSurcharge = vip ? subtotal * 0.30 : 0;
  const staffDiscount = staff ? subtotal * 0.20 : 0;
  return {
    subtotal,
    discount,
    vipSurcharge,
    staffDiscount,
    total: Math.max(0, subtotal + vipSurcharge - staffDiscount - discount)
  };
}

/** What the sale_lines rows come to, priced the way finalizeInvoice prices them. */
function linesTotal(cart, totals) {
  return cart.reduce(
    (sum, item) => sum + saleLineRate(item.product, totals, 'RETAIL') * item.qty,
    0
  );
}

const beer = { id: 'prod-beer', sell_price: 500, cost_price: 300 };
const vipItem = { id: VIP_CHARGE_ID, sell_price: 100, cost_price: 0 };
const staffItem = { id: STAFF_DISCOUNT_ID, sell_price: 0, cost_price: 0 };

test('a plain sale reconciles', () => {
  const totals = tillTotals({ subtotal: 1000 });
  const header = recordedSaleTotals(totals);
  assert.equal(header.subtotal - header.discount, header.grandTotal);
  assert.equal(linesTotal([{ product: beer, qty: 2 }], totals), header.subtotal);
});

test('the VIP charge is booked at the surcharge, not its catalogue price', () => {
  const totals = tillTotals({ subtotal: 1000, vip: true });
  // The pseudo-product's own sell_price of 100 must not reach the sale.
  assert.equal(saleLineRate(vipItem, totals, 'RETAIL'), 300);

  const cart = [{ product: beer, qty: 2 }, { product: vipItem, qty: 1 }];
  const header = recordedSaleTotals(totals);
  assert.equal(header.grandTotal, 1300);
  assert.equal(linesTotal(cart, totals), header.subtotal);
  assert.equal(header.subtotal - header.discount, header.grandTotal);
});

test('the staff discount comes off the order rather than being sold', () => {
  const totals = tillTotals({ subtotal: 1000, staff: true });
  assert.equal(saleLineRate(staffItem, totals, 'RETAIL'), 0);

  const cart = [{ product: beer, qty: 2 }, { product: staffItem, qty: 1 }];
  const header = recordedSaleTotals(totals);
  assert.equal(header.grandTotal, 800);
  assert.equal(header.discount, 200);
  assert.equal(linesTotal(cart, totals), header.subtotal);
  assert.equal(header.subtotal - header.discount, header.grandTotal);
});

test('both charges together still reconcile, alongside a line discount', () => {
  const totals = tillTotals({ subtotal: 1000, discount: 50, vip: true, staff: true });
  const cart = [
    { product: beer, qty: 2 },
    { product: vipItem, qty: 1 },
    { product: staffItem, qty: 1 }
  ];
  const header = recordedSaleTotals(totals);
  assert.equal(header.grandTotal, 1000 + 300 - 200 - 50);
  assert.equal(linesTotal(cart, totals), header.subtotal);
  assert.equal(header.subtotal - header.discount, header.grandTotal);
});

test('a wholesale customer is still priced off cost, and charges ignore the tier', () => {
  const totals = tillTotals({ subtotal: 345, vip: true });
  assert.equal(saleLineRate(beer, totals, 'WHOLESALE'), 345);
  assert.equal(saleLineRate(vipItem, totals, 'WHOLESALE'), 103.5);
});
