'use strict';
// Applies only server-side receipt controls and audit records, never money or merchant credentials.
const assert = require('node:assert/strict');
const path = require('node:path');
const { createHash } = require('node:crypto');
const projectId = 'vanbransa-pos';
const stable = value => value?.toMillis ? { timestampMs: value.toMillis() }
  : Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
function planRollout(rows) {
  assert.ok(rows.length > 0 && rows.length <= 200, 'Expected 1–200 active businesses');
  const targets = rows.map(row => {
    assert.ok(row.tenantId && row.branchIds.length, 'Every target needs active branches');
    return { tenantId: row.tenantId, branchIds: [...new Set(row.branchIds)].sort(), before: row.before || null };
  }).sort((a, b) => a.tenantId.localeCompare(b.tenantId));
  assert.equal(new Set(targets.map(row => row.tenantId)).size, targets.length, 'Duplicate tenant target');
  const fingerprint = createHash('sha256').update(JSON.stringify(stable({ projectId, standardVersion: 3, targets }))).digest('hex');
  return { targets, fingerprint, batchId: `receipt-standard-${fingerprint.slice(0, 32)}` };
}
async function main() {
  const args = process.argv.slice(2), value = name => args[args.indexOf(name) + 1];
  assert.ok(args.includes('--project') && value('--project') === projectId, 'Pass --project vanbransa-pos');
  assert.ok(!process.env.FIRESTORE_EMULATOR_HOST);
  const apply = args.includes('--apply'), expectedHash = value('--expected-hash');
  if (apply) assert.match(expectedHash || '', /^[a-f0-9]{64}$/);
  const backend = require('node:module').createRequire(path.resolve(__dirname, '../backend/functions/package.json'));
  const { initializeApp, applicationDefault } = backend('firebase-admin/app');
  const { getFirestore, Timestamp } = backend('firebase-admin/firestore');
  const { standardReceiptPolicy } = require('../backend/functions/lib/shared/receipt-policy');
  const app = initializeApp({ projectId, credential: applicationDefault() });
  try {
    const db = getFirestore(app);
    const result = await db.runTransaction(async tx => {
      const [tenants, branches] = await Promise.all([
        tx.get(db.collection('tenants').where('status', '==', 'active')),
        tx.get(db.collection('branches').where('status', '==', 'active')),
      ]);
      assert.ok(tenants.size > 0);
      const refs = tenants.docs.map(doc => db.doc(`mpesa_receipt_controls/${doc.id}`));
      const replayRef = apply ? db.doc(`audit_logs/receipt-standard-${expectedHash.slice(0, 32)}`) : null;
      const snapshots = await tx.getAll(...refs, ...(replayRef ? [replayRef] : []));
      const rows = tenants.docs.map((doc, index) => ({ tenantId: doc.id,
        branchIds: branches.docs.filter(branch => branch.data().tenantId === doc.id).map(branch => branch.id),
        before: snapshots[index].data() || null }));
      if (apply && snapshots[snapshots.length - 1]?.exists) {
        const replay = snapshots[snapshots.length - 1].data();
        assert.equal(replay.action, 'platform.receipt_standard.applied'); assert.equal(replay.fingerprint, expectedHash);
        assert.deepEqual(rows.map(row => row.tenantId).sort(), replay.tenantIds);
        for (const row of rows) {
          const expected = standardReceiptPolicy(row.tenantId, row.before.branchIds, `${replayRef.id}-${row.tenantId}`);
          for (const [key, value] of Object.entries(expected)) assert.deepEqual(row.before[key], value, `Policy changed for ${row.tenantId}`);
        }
        return { result: 'already applied', fingerprint: expectedHash, tenants: rows.length, branches: rows.reduce((n, row) => n + row.branchIds.length, 0) };
      }
      const plan = planRollout(rows);
      if (apply) {
        assert.equal(expectedHash, plan.fingerprint, 'Tenant, branch or control changed since preview');
        const now = Timestamp.now();
        for (const row of plan.targets) {
          const authorizationId = `${plan.batchId}-${row.tenantId}`;
          tx.set(db.doc(`mpesa_receipt_controls/${row.tenantId}`), {
            ...standardReceiptPolicy(row.tenantId, row.branchIds, authorizationId),
            enabledAt: now, enabledBy: 'user_authorized_maintenance',
          });
          tx.create(db.doc(`audit_logs/${authorizationId}`), { tenantId: row.tenantId,
            action: 'mpesa.receipt_entry.standard_enabled', entityType: 'mpesa_receipt_control', entityId: row.tenantId,
            actorType: 'user_authorized_maintenance', createdAt: now,
            metadata: { previousControl: row.before, branchIds: row.branchIds, policyVersion: 3, entryMode: 'staff_entry',
              fingerprint: plan.fingerprint, reason: 'User restored direct M-Pesa code and receipt amount entry without a lookup requirement for all current and future businesses. Existing records and merchant routes remain tenant-specific.' } });
        }
        tx.create(replayRef, { action: 'platform.receipt_standard.applied', createdAt: now, fingerprint: plan.fingerprint,
          tenantIds: plan.targets.map(row => row.tenantId), policyVersion: 3 });
      }
      return { result: apply ? 'applied' : 'ready (dry run)', fingerprint: plan.fingerprint,
        targets: plan.targets.map(row => ({ tenantId: row.tenantId, branchIds: row.branchIds, previousMode: row.before?.mode || null })),
        policyVersion: 3, entryMode: 'staff_entry', duration: 'ongoing', until: null,
        futureBranchesInheritOwnTenantPolicy: true, historyRewritten: false, merchantConfigurationChanged: false };
    });
    console.log(JSON.stringify(result, null, 2));
  } finally { await app.delete(); }
}
module.exports = { planRollout };
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
