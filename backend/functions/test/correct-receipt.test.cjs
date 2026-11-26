const test = require('node:test');
const assert = require('node:assert/strict');
const { correctionRefusal } = require('../lib/modules/sales/correct-receipt');

const typed = { amountSource: 'staff_recorded_receipt', limitMinor: 50000, allocatedMinor: 50000 };

test('the owner can raise a typed total that was entered too low (500 for 850)', () => {
  assert.equal(correctionRefusal(typed, 85000, false), null);
  assert.equal(correctionRefusal({ ...typed, amountSource: 'reviewed_receipt' }, 90000, false), null);
});

test('a correction never goes below what bills already use, nor touches provider proof', () => {
  assert.match(correctionRefusal(typed, 40000, false), /already used/);
  assert.match(correctionRefusal(typed, 85000, true), /confirmed this payment/);
  assert.match(correctionRefusal(undefined, 85000, false), /not been recorded/);
  assert.match(correctionRefusal({ ...typed, amountSource: 'provider' }, 85000, false), /typed in by staff/);
  assert.match(correctionRefusal(typed, 50000, false), /already the recorded amount/);
  for (const bad of [0, -1, 1.5, 50_000_001, NaN]) assert.match(correctionRefusal(typed, bad, false), /Enter the amount/);
});
