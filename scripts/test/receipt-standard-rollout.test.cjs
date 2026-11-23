'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { planRollout } = require('../rollout-receipt-standard.cjs');
test('shared standard plan binds approval to each business, branch and previous control', () => {
  const titanium = { tenantId: 'tenant-01', branchIds: ['b2', 'b1'], before: { mode: 'internal' } };
  const artesano = { tenantId: 'tenant-artesano', branchIds: ['a1'], before: null };
  const plan = planRollout([artesano, titanium]);
  assert.deepEqual(planRollout([titanium, artesano]), plan);
  assert.deepEqual(plan.targets[0].branchIds, ['b1', 'b2']);
  assert.notEqual(planRollout([{ ...titanium, before: { mode: 'provider' } }, artesano]).fingerprint, plan.fingerprint);
  assert.notEqual(planRollout([titanium, { ...artesano, branchIds: ['a1', 'a2'] }]).fingerprint, plan.fingerprint);
  assert.throws(() => planRollout([titanium, titanium]), /Duplicate/);
  assert.throws(() => planRollout([{ ...artesano, branchIds: [] }]), /active branches/);
});
