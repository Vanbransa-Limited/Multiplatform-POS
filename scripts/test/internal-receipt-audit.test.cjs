'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { auditReceipts } = require('../audit-internal-receipts.cjs');
test('ledger audit deduplicates matching reference fields, ignores failed payments, and flags over-allocation', () => {
  const claim = { reference: 'RECEIPT001', limitMinor: 95000, allocatedMinor: 50000,
    amountSource: 'staff_recorded_receipt', verified: false, recordedByStaffId: 'cashier', branchId: 'branch' };
  const payments = [{ method: 'mpesa', reference: 'RECEIPT001', providerTransactionId: 'RECEIPT001', amountMinor: 50000 },
    { method: 'mpesa', reference: 'RECEIPT001', amountMinor: 10000, status: 'failed' },
    { method: 'mpesa', reference: 'LEGACY0001', amountMinor: 10000 }];
  const result = auditReceipts([claim], payments);
  assert.deepEqual(result.issues, []); assert.equal(result.remainingInternalMinor, 45000);
  assert.equal(result.historicalReferencesWithoutClaim, 1);
  assert.equal(auditReceipts([{ ...claim, allocatedMinor: 96000 }], payments).issues[0].problem, 'invalid receipt limit/allocation');
  assert.equal(auditReceipts([claim], [...payments, { method: 'mpesa', reference: 'RECEIPT001', amountMinor: 1 }]).issues[0].problem, 'claim and ledger differ');
  assert.deepEqual(auditReceipts([{ ...claim, verified: true }], payments).issues, []);
  assert.equal(auditReceipts([{ ...claim, recordedByStaffId: undefined }], payments).issues[0].problem, 'missing internal receipt provenance');
});
