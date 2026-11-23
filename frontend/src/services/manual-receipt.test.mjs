import test from 'node:test';
import assert from 'node:assert/strict';
import { manualReceipt } from './manual-receipt.js';

test('manual receipt preserves the exact amount from the message in integer cents', () => {
  assert.deepEqual(manualReceipt(' ukl0b2rhox ', '19.99'), { reference: 'UKL0B2RHOX', receiptAmountMinor: 1999 });
  assert.equal(manualReceipt('UKL0B2RHOX', '1700').receiptAmountMinor, 170000);
});
test('manual receipt refuses missing, rounded, negative, exponent and unsafe amounts', () => {
  for (const amount of ['', '0', '-10', '1.001', '1e3', 'Infinity', '9007199254740992']) {
    assert.throws(() => manualReceipt('UKL0B2RHOX', amount));
  }
  assert.throws(() => manualReceipt('short', '100'));
});
