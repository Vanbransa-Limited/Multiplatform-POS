'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { planHistory } = require('../import-mpesa-history.cjs');
const row = { id: 'paid-1', tenantId: 't1', method: 'mpesa', status: 'completed', reference: 'HISTORY001',
  providerTransactionId: 'HISTORY001', amountMinor: 25000, branchId: 'b1', saleId: 'sale1', paidAt: { toMillis: () => 1234 } };
test('history backfill counts each payment once and imports previous allocations without creating unused money', () => {
  const plan = planHistory('t1', [row, row, { ...row, id: 'paid-2', amountMinor: 10000 }], []);
  assert.equal(plan.successfulMpesaRows, 2); assert.equal(plan.imports.length, 1);
  assert.equal(plan.imports[0].amountMinor, 35000); assert.equal(plan.imports[0].paidAtMs, 1234);
  assert.deepEqual(plan.imports[0].sourcePaymentIds, ['paid-1', 'paid-2']);
  assert.deepEqual(plan.imports[0].targets, ['sale:sale1']);
  assert.equal(planHistory('t1', [row], [{ tenantId: 't1', reference: 'HISTORY001', limitMinor: 99999 }]).imports.length, 0);
  assert.notEqual(planHistory('t1', [row], []).fingerprint, planHistory('t1', [{ ...row, amountMinor: 1 }], []).fingerprint);
});
test('history import excludes other businesses and failed/non-M-Pesa rows and flags ambiguous source amounts', () => {
  const plan = planHistory('t1', [{ ...row, tenantId: 't2' }, { ...row, id: 'failed', status: 'failed' },
    { ...row, id: 'cash', method: 'cash' }, { ...row, id: 'conflicting', providerTransactionId: 'OTHERREF01' },
    { ...row, id: 'invalid', amountMinor: -1 }], []);
  assert.equal(plan.imports.length, 0); assert.equal(plan.skipped.length, 2);
});
