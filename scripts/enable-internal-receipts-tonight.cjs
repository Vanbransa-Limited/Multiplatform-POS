'use strict';
// User-authorized temporary receipt entry. No provider configuration or money is changed.
const path = require('node:path');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const backend = require('node:module').createRequire(path.resolve(__dirname, '../backend/functions/package.json'));
const { initializeApp, applicationDefault } = backend('firebase-admin/app');
const { getFirestore, Timestamp } = backend('firebase-admin/firestore');
const tenantId = 'tenant-01', branchId = 'branch-nai-01', projectId = 'vanbransa-pos';
const archiveId = 'internal-receipts-tenant-01-20261121';
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
async function main() {
  const args = process.argv.slice(2);
  assert.ok(args.includes('--project'));
  assert.equal(args[args.indexOf('--project') + 1], projectId);
  assert.ok(!process.env.FIRESTORE_EMULATOR_HOST);
  const apply = args.includes('--apply');
  const expectedHash = args[args.indexOf('--expected-hash') + 1];
  if (apply) assert.match(expectedHash || '', /^[a-f0-9]{64}$/);
  const app = initializeApp({ projectId, credential: applicationDefault() });
  try {
    const db = getFirestore(app);
    const result = await db.runTransaction(async tx => {
      const controlRef = db.doc(`mpesa_receipt_controls/${tenantId}`);
      const auditRef = db.doc(`audit_logs/${archiveId}`);
      const [control, settings, branch, audit] = await tx.getAll(controlRef, db.doc(`tenant_settings/${tenantId}`), db.doc(`branches/${branchId}`), auditRef);
      assert.equal(branch.data()?.tenantId, tenantId);
      assert.notEqual(branch.data()?.status, 'inactive');
      const dayStart = Number.isInteger(settings.data()?.dayStartHour) ? settings.data().dayStartHour : 6;
      assert.ok(dayStart >= 0 && dayStart <= 23);
      // Explicit user trading night, in Nairobi (UTC+03), not the host timezone.
      const until = Timestamp.fromMillis(Date.UTC(2026, 10, 22, dayStart - 3));
      if (audit.exists) {
        assert.equal(control.data()?.mode, 'internal');
        assert.equal(control.data()?.until?.toMillis(), until.toMillis());
        return { result: 'already enabled', until: until.toDate().toISOString() };
      }
      assert.ok(until.toMillis() > Date.now(), 'This trading night has already ended');
      assert.ok(until.toMillis() - Date.now() < 24 * 3600000);
      const before = control.exists ? control.data() : null;
      const fingerprint = hash({ before, until: until.toMillis(), tenantId, branchId });
      if (apply) {
        assert.equal(expectedHash, fingerprint, 'Control changed since the reviewed preview');
        const now = Timestamp.now();
        tx.set(controlRef, { tenantId, mode: 'internal', branchIds: [branchId], until,
          enabledAt: now, authorizationId: archiveId, enabledBy: 'user_authorized_maintenance' });
        tx.create(auditRef, { tenantId, branchId, action: 'mpesa.receipt_entry.internal_enabled', createdAt: now,
          actorType: 'user_authorized_maintenance', entityType: 'mpesa_receipt_control', entityId: tenantId,
          metadata: { previousControl: before, until, fingerprint,
            reason: 'User requested internal-only receipt checking for tonight, using existing M-Pesa records to prevent reuse. Staff-recorded receipt amounts remain unverified by Safaricom.' } });
      }
      return { result: apply ? 'enabled' : 'ready (dry run)', tenantId, branchId, fingerprint,
        until: until.toDate().toISOString(), untilNairobi: new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Nairobi', dateStyle: 'medium', timeStyle: 'short' }).format(until.toDate()) };
    });
    const [payments, prompts] = await Promise.all([
      db.collection('payments').where('tenantId', '==', tenantId).get(),
      db.collection('mpesa_payments').where('tenantId', '==', tenantId).get(),
    ]);
    const references = new Set(payments.docs.filter(doc => String(doc.data().method).toLowerCase() === 'mpesa'
      && ['completed', 'paid', 'success'].includes(String(doc.data().status || 'completed').toLowerCase()))
      .flatMap(doc => [doc.data().reference, doc.data().providerTransactionId])
      .map(value => String(value || '').trim().toUpperCase()).filter(Boolean));
    for (const doc of prompts.docs) if (doc.data().status === 'paid' && doc.data().receipt) references.add(String(doc.data().receipt).trim().toUpperCase());
    const nonCanonical = payments.docs.flatMap(doc => [doc.data().reference, doc.data().providerTransactionId])
      .filter(value => typeof value === 'string' && /^[A-Z0-9]{10}$/.test(value.trim().toUpperCase()) && value !== value.trim().toUpperCase());
    console.log(JSON.stringify({ ...result, historicalReferencesCovered: references.size,
      historicalReferencesNeedingNormalization: nonCanonical.length, historyCopiedOrRewritten: false }, null, 2));
  } finally { await app.delete(); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
