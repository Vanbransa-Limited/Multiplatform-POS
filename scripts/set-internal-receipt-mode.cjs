'use strict';
// Explicit production policy transition, not a payment or provider configuration change.
const path = require('node:path');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const projectId = 'vanbransa-pos', tenantId = 'tenant-01', branchId = 'branch-nai-01';
const stable = value => value?.toMillis ? { timestampMs: value.toMillis() }
  : Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
function planControl(before, mode) {
  assert.ok(['internal', 'provider'].includes(mode), 'Choose --mode internal or --mode provider');
  const entryMode = mode === 'internal' ? 'recorded_only' : null;
  const fingerprint = createHash('sha256').update(JSON.stringify(stable({ projectId, tenantId, branchId, before, mode, entryMode, policyVersion: 1 }))).digest('hex');
  return { fingerprint, authorizationId: `receipt-policy-${fingerprint.slice(0, 32)}`, projectId, tenantId, branchId, mode,
    duration: mode === 'internal' ? 'ongoing' : null, entryMode, policyVersion: 1, until: null };
}
async function main() {
  const args = process.argv.slice(2);
  const value = name => args[args.indexOf(name) + 1];
  assert.ok(args.includes('--project') && value('--project') === projectId, 'Pass the explicit production project');
  assert.ok(args.includes('--mode'), 'Pass --mode internal or --mode provider');
  assert.ok(!process.env.FIRESTORE_EMULATOR_HOST, 'Production policy script cannot run against an emulator');
  const apply = args.includes('--apply'), mode = value('--mode'), expectedHash = value('--expected-hash');
  if (apply) assert.match(expectedHash || '', /^[a-f0-9]{64}$/, 'Applying requires the reviewed preview fingerprint');
  const backend = require('node:module').createRequire(path.resolve(__dirname, '../backend/functions/package.json'));
  const { initializeApp, applicationDefault } = backend('firebase-admin/app');
  const { getFirestore, Timestamp } = backend('firebase-admin/firestore');
  const app = initializeApp({ projectId, credential: applicationDefault() });
  try {
    const db = getFirestore(app);
    const result = await db.runTransaction(async tx => {
      const ref = db.doc(`mpesa_receipt_controls/${tenantId}`);
      const replayRef = apply ? db.doc(`audit_logs/receipt-policy-${expectedHash.slice(0, 32)}`) : null;
      const [control, branch, replay] = await tx.getAll(ref, db.doc(`branches/${branchId}`), ...(replayRef ? [replayRef] : []));
      assert.equal(branch.data()?.tenantId, tenantId);
      assert.notEqual(branch.data()?.status, 'inactive');
      if (replay?.exists) {
        assert.equal(control.data()?.authorizationId, replayRef.id, 'A newer policy replaced this activation');
        assert.equal(control.data()?.mode, mode);
        assert.equal(control.data()?.entryMode, mode === 'internal' ? 'recorded_only' : null);
        return { result: 'already applied', mode, duration: control.data()?.duration, until: null, authorizationId: replayRef.id };
      }
      const before = control.exists ? control.data() : null;
      const plan = planControl(before, mode);
      if (apply) {
        assert.equal(expectedHash, plan.fingerprint, 'Control changed since preview; review a fresh preview');
        const now = Timestamp.now();
        tx.set(ref, { tenantId, mode, branchIds: [branchId], duration: plan.duration, entryMode: plan.entryMode, policyVersion: 1, until: null,
          authorizationId: plan.authorizationId, enabledAt: now, enabledBy: 'user_authorized_maintenance' });
        tx.create(replayRef, { tenantId, branchId, action: 'mpesa.receipt_entry.policy_changed', entityType: 'mpesa_receipt_control',
          entityId: tenantId, actorType: 'user_authorized_maintenance', createdAt: now,
          metadata: { previousControl: before, mode, duration: plan.duration, entryMode: plan.entryMode, until: null, fingerprint: plan.fingerprint,
            reason: mode === 'internal' ? 'User requested code-only checkout using saved ledger amounts. Cashiers cannot create new receipt totals. Only unused balances may be spent; recorded payments remain unverified unless provider proof exists.'
              : 'Administrative switch back to provider confirmation for new receipts; existing receipt allocations remain intact.' } });
      }
      return { result: apply ? 'applied' : 'ready (dry run)', ...plan, previousMode: before?.mode || null,
        existingReceiptsPreserved: true, providerConfigurationChanged: false };
    });
    console.log(JSON.stringify(result, null, 2));
  } finally { await app.delete(); }
}
module.exports = { planControl };
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
