'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { planControl } = require('../set-internal-receipt-mode.cjs');
test('ongoing policy preview has no expiry, is reproducible and binds approval to the current control', () => {
  const before = { mode: 'internal', until: { toMillis: () => 12345 }, branchIds: ['branch-nai-01'] };
  const plan = planControl(before, 'internal');
  assert.equal(plan.duration, 'ongoing'); assert.equal(plan.until, null); assert.equal(plan.policyVersion, 1);
  assert.equal(plan.entryMode, 'recorded_only');
  assert.equal(plan.tenantId, 'tenant-01'); assert.equal(plan.branchId, 'branch-nai-01');
  assert.deepEqual(planControl(before, 'internal'), plan);
  assert.notEqual(planControl({ ...before, mode: 'provider' }, 'internal').fingerprint, plan.fingerprint);
  assert.notEqual(planControl(before, 'provider').fingerprint, plan.fingerprint);
  assert.throws(() => planControl(before, 'anything'), /Choose/);
});
