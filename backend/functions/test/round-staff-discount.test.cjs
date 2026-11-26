const test = require('node:test');
const assert = require('node:assert/strict');
const { roundStaffDiscount, roundDiscountRefusal } = require('../lib/modules/sales/round-discount');

const line = (productId, qty, unitPriceMinor, extra = {}) => ({ productId, qty, unitPriceMinor, discountMinor: 0, taxCode: 'A', ...extra });

// Table 001, 23 Nov: Mbuzi 500 went out in its own round without the staff 20%.
test('adds 20% of the round to its lines and re-taxes them', () => {
  const result = roundStaffDiscount([line('mbuzi', 1, 50000)]);
  assert.equal(result.discountMinor, 10000);
  assert.equal(result.totalMinor, 40000);
  assert.deepEqual(result.lines.map(l => [l.discountMinor, l.lineTotalMinor]), [[10000, 40000]]);
  assert.equal(result.lines[0].taxMinor, Math.round(40000 * 1600 / 11600));
  assert.equal(result.taxMinor, result.lines[0].taxMinor);
});

test('splits the 20% across lines so the line discounts sum exactly', () => {
  const result = roundStaffDiscount([line('rice', 1, 10000), line('tea', 3, 3333), line('chips', 1, 7000)]);
  const gross = 10000 + 9999 + 7000;
  assert.equal(result.discountMinor, Math.round(gross * 0.2));
  assert.equal(result.lines.reduce((s, l) => s + l.discountMinor, 0), result.discountMinor);
  assert.equal(result.totalMinor, gross - result.discountMinor);
  assert.ok(result.lines.every(l => l.discountMinor >= 0 && l.lineTotalMinor >= 0));
});

test('the table service charge is not discounted', () => {
  const result = roundStaffDiscount([line('beer', 1, 30000), line('prod-table-service', 1, 3000)]);
  assert.equal(result.discountMinor, 6000);
  assert.equal(result.lines.find(l => l.productId === 'prod-table-service').discountMinor, 0);
});

test('only an unpaid, undiscounted, unlocked round can take it', () => {
  const sale = { tenantId: 't', status: 'completed', discountMinor: 0, fiscalStatus: 'NOT_APPLICABLE' };
  const credit = [{ method: 'credit', amountMinor: 50000 }];
  assert.equal(roundDiscountRefusal(sale, credit, 't', 0), null);
  assert.match(roundDiscountRefusal({ ...sale, tenantId: 'x' }, credit, 't', 0), /not found/);
  assert.match(roundDiscountRefusal({ ...sale, status: 'VOIDED' }, credit, 't', 0), /voided/);
  assert.match(roundDiscountRefusal({ ...sale, discountMinor: 100 }, credit, 't', 0), /already has a discount/);
  assert.match(roundDiscountRefusal({ ...sale, fiscalStatus: 'SIGNED' }, credit, 't', 0), /KRA/);
  assert.match(roundDiscountRefusal(sale, [{ method: 'credit', amountMinor: 50000, settledAt: 1 }], 't', 0), /paid/);
  assert.match(roundDiscountRefusal(sale, [...credit, { method: 'mpesa', amountMinor: 100, status: 'completed' }], 't', 0), /paid/);
  assert.match(roundDiscountRefusal({ ...sale, checkoutExpiresAt: { toMillis: () => 5000 } }, credit, 't', 1000), /Payment is in progress/);
});
