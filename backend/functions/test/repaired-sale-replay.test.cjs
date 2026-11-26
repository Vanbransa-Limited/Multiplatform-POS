const test = require('node:test');
const assert = require('node:assert/strict');
const { replaySale } = require('../lib/modules/sales/replay');

const tx = (rows) => ({ getAll: async (...refs) => refs.map((ref) => ({ exists: rows.has(ref.path), data: () => rows.get(ref.path) })) });
const rows = new Map([['sale_lines/s_line_01', { productId: 'p', qty: 1, discountMinor: 0 }], ['payments/s_payment_01', { method: 'mpesa', amountMinor: 8000, reference: 'UIO9X817AI' }]]);
const stored = { tenantId: 't', staffId: 'kester', branchId: 'b', deviceId: 'd', shiftId: 'x', customerId: 'c', idempotencyKey: 'k',
  lineIds: ['s_line_01'], paymentIds: ['s_payment_01'], stockBalanceIds: [], requestFingerprint: 'stored-fp', invoiceNumber: 'INV-BH001-462054' };
const input = { tenantId: 't', staffId: 'kester' };

// Kester's 24 Sep Samosa: the tablet retries with details the repair could not know.
test('a repaired sale answers its tablet\'s retry instead of refusing it', async () => {
  const result = await replaySale(tx(rows), { ...stored, repairedFromDevice: true }, input, 'tablet-fp');
  assert.equal(result.replayed, true);
  assert.equal(result.sale.invoiceNumber, 'INV-BH001-462054');
});

test('any other sale still refuses a key reused with different details', async () => {
  await assert.rejects(replaySale(tx(rows), stored, input, 'tablet-fp'), /different sale details/);
  await assert.rejects(replaySale(tx(rows), { ...stored, repairedFromDevice: true }, { tenantId: 't', staffId: 'someone-else' }, 'fp'), /different sale request/);
});
