const test = require('node:test');
const assert = require('node:assert/strict');
const { lookAlikeCodes } = require('../lib/modules/sales/receipt-balance');

// 25 Nov 2026: UKPH53LY0K was typed for UKPH53LYOK and one KES 260 cleared two bills.
test('a zero typed for a letter O is a look-alike of the recorded receipt', () => {
  assert.ok(lookAlikeCodes('UKPH53LY0K').includes('UKPH53LYOK'));
  assert.ok(lookAlikeCodes('UKPH53LYOK').includes('UKPH53LY0K'));
});

test('covers I/1/L, S/5, B/8, Z/2 one character at a time', () => {
  const codes = lookAlikeCodes('AI5B2');
  for (const code of ['A15B2', 'AL5B2', 'AIS B2'.replace(' ', ''), 'AI582', 'AI5BZ']) assert.ok(codes.includes(code), code);
  assert.ok(!codes.includes('AI5B2'));
  assert.ok(codes.every(code => [...code].filter((c, i) => c !== 'AI5B2'[i]).length === 1));
});

test('a code with no confusable characters has no look-alikes', () => {
  assert.deepEqual(lookAlikeCodes('ACDEFGHJKM'), []);
});
