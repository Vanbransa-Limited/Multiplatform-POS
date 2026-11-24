const assert = require('node:assert/strict');
const test = require('node:test');

const {
  isWeakCode, assertCodeShape, generateCode, hashCode, codeMatches,
  afterFailure, pausedForMs, approvalUsable, MAX_FAILURES, PAUSE_MS,
} = require('../lib/modules/approval-codes/domain.js');
const { assertDiscountPermission, prepareSaleLines } = require('../lib/modules/sales/domain.js');

test('codes are six digits and easy guesses are refused', () => {
  for (const weak of ['000000', '111111', '123456', '234567', '987654', '654321']) assert.equal(isWeakCode(weak), true, weak);
  for (const fine of ['246810', '502913', '090807']) assert.equal(isWeakCode(fine), false, fine);
  assert.equal(assertCodeShape('502913'), '502913');
  for (const bad of ['12345', '1234567', '12a456', 502913, '', null]) {
    assert.throws(() => assertCodeShape(bad), (error) => error.code === 'invalid-argument', String(bad));
  }
  assert.throws(() => assertCodeShape('123456'), (error) => error.code === 'invalid-argument');
  for (let i = 0; i < 200; i += 1) {
    const code = generateCode();
    assert.match(code, /^\d{6}$/);
    assert.equal(isWeakCode(code), false);
  }
});

test('a stored code matches only itself and never stores the digits', async () => {
  const record = await hashCode('502913');
  assert.equal(JSON.stringify(record).includes('502913'), false);
  assert.equal(await codeMatches('502913', record), true);
  assert.equal(await codeMatches('502914', record), false);
  assert.equal(await codeMatches('502913', {}), false);
  const again = await hashCode('502913');
  assert.notEqual(again.hash, record.hash, 'each code gets its own salt');
});

test('five wrong codes pause entry for fifteen minutes', () => {
  const now = 1_000_000;
  let state = {};
  for (let i = 1; i < MAX_FAILURES; i += 1) {
    state = afterFailure(state, now);
    assert.equal(state.failures, i);
    assert.equal(pausedForMs(state, now), 0);
  }
  state = afterFailure(state, now);
  assert.equal(state.failures, 0);
  assert.equal(pausedForMs(state, now), PAUSE_MS);
  assert.equal(pausedForMs(state, now + PAUSE_MS), 0);
});

test('an approval is single use, for its own waiter, and expires', () => {
  const now = 5_000;
  const approval = { tenantId: 't', requestedByStaffId: 'kester', expiresAtMs: now + 10, consumedSaleId: null };
  assert.equal(approvalUsable(approval, { tenantId: 't', staffId: 'kester' }, now), true);
  assert.equal(approvalUsable(approval, { tenantId: 't', staffId: 'linda' }, now), false);
  assert.equal(approvalUsable(approval, { tenantId: 'other', staffId: 'kester' }, now), false);
  assert.equal(approvalUsable(approval, { tenantId: 't', staffId: 'kester' }, now + 11), false);
  assert.equal(approvalUsable({ ...approval, consumedSaleId: 'sale-1' }, { tenantId: 't', staffId: 'kester' }, now), false);
  assert.equal(approvalUsable(undefined, { tenantId: 't', staffId: 'kester' }, now), false);
});

test('an approved cashier may give exactly the 20 percent staff discount and nothing more', () => {
  const product = { exists: true, id: 'p1', data: () => ({ tenantId: 't', name: 'Tusker', sku: 'T', sellPriceMinor: 35000, taxCode: 'A', isActive: true, isService: false }) };
  const lines = prepareSaleLines([{ productId: 'p1', qty: 2, discountMinor: 14000 }], [product], 't');
  assert.throws(() => assertDiscountPermission(lines, 'cashier'), (error) => error.code === 'permission-denied');
  assert.doesNotThrow(() => assertDiscountPermission(lines, 'cashier', false, true));
  const larger = prepareSaleLines([{ productId: 'p1', qty: 2, discountMinor: 20000 }], [product], 't');
  assert.throws(() => assertDiscountPermission(larger, 'cashier', false, true), (error) => error.code === 'permission-denied');
});
