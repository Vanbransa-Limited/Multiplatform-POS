'use strict';
// Backfill previously applied references only. Never creates payments, settles bills,
// upgrades verification or invents unused money from a historical allocation.
const assert = require('node:assert/strict');
const path = require('node:path');
const { createHash } = require('node:crypto');
const sha = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const codeOf = value => {
  const code = String(value || '').trim().toUpperCase();
  return /^[A-Z0-9]{10}$/.test(code) && /[A-Z]/.test(code) ? code : null;
};
function planHistory(tenantId, payments, claims) {
  const existing = new Set(claims.filter(row => row.tenantId === tenantId).map(row => codeOf(row.reference)).filter(Boolean));
  const groups = new Map(), skipped = [];
  let successfulMpesaRows = 0;
  const seenIds = new Set();
  for (const row of payments) {
    if (row.tenantId !== tenantId || String(row.method).toLowerCase() !== 'mpesa'
      || !['completed', 'paid', 'success'].includes(String(row.status || 'completed').toLowerCase())) continue;
    assert.ok(row.id, 'Source payment IDs are required');
    if (seenIds.has(row.id)) continue;
    seenIds.add(row.id); successfulMpesaRows++;
    const codes = [...new Set([row.reference, row.providerTransactionId].map(codeOf).filter(Boolean))];
    if (codes.length !== 1 || !Number.isSafeInteger(row.amountMinor) || row.amountMinor <= 0) {
      skipped.push({ paymentId: row.id, reason: codes.length !== 1 ? 'missing or conflicting receipt reference' : 'invalid payment amount' });
      continue;
    }
    const reference = codes[0];
    const group = groups.get(reference) || { reference, amountMinor: 0, sourcePaymentIds: [], branchIds: [], targets: [], paidAtMs: null };
    group.amountMinor += row.amountMinor;
    assert.ok(Number.isSafeInteger(group.amountMinor), 'Historical amount exceeds safe integer range');
    group.sourcePaymentIds.push(row.id);
    if (row.branchId) group.branchIds.push(row.branchId);
    const target = row.proformaId ? `proforma:${row.proformaId}` : row.customerOrderId ? `customer_order:${row.customerOrderId}` : row.saleId ? `sale:${row.saleId}` : null;
    if (target) group.targets.push(target);
    const time = row.paidAt?.toMillis?.() ?? row.createdAt?.toMillis?.();
    if (Number.isFinite(time)) group.paidAtMs = group.paidAtMs === null ? time : Math.min(group.paidAtMs, time);
    groups.set(reference, group);
  }
  const history = [...groups.values()].map(row => ({ ...row,
    sourcePaymentIds: row.sourcePaymentIds.sort(), branchIds: [...new Set(row.branchIds)].sort(), targets: [...new Set(row.targets)].sort() }))
    .sort((a, b) => a.reference.localeCompare(b.reference));
  const imports = history.filter(row => !existing.has(row.reference));
  const fingerprint = sha({ tenantId, imports });
  return { tenantId, fingerprint, successfulMpesaRows, distinctReferences: history.length,
    existingReferences: history.length - imports.length, imports, skipped };
}
async function importHistory(db, tenantId, { apply = false, expectedHash } = {}) {
  const backend = require('node:module').createRequire(path.resolve(__dirname, '../backend/functions/package.json'));
  const { Timestamp } = backend('firebase-admin/firestore');
  const { deterministicId } = require('../backend/functions/lib/shared/identifiers');
  assert.match(tenantId || '', /^[A-Za-z0-9_-]{1,128}$/);
  if (apply) assert.match(expectedHash || '', /^[a-f0-9]{64}$/);
  return db.runTransaction(async tx => {
    const archiveId = apply ? `mpesa-history-${tenantId}-${expectedHash.slice(0, 24)}` : null;
    const [tenant, payments, claims, replay] = await Promise.all([
      tx.get(db.doc(`tenants/${tenantId}`)),
      tx.get(db.collection('payments').where('tenantId', '==', tenantId)),
      tx.get(db.collection('payment_receipt_claims').where('tenantId', '==', tenantId)),
      archiveId ? tx.get(db.doc(`audit_logs/${archiveId}`)) : Promise.resolve(null),
    ]);
    assert.ok(tenant.exists, 'Business not found');
    if (replay?.exists) {
      assert.equal(replay.data().tenantId, tenantId); assert.equal(replay.data().metadata.fingerprint, expectedHash);
      for (const expected of replay.data().metadata.references) {
        const current = claims.docs.find(doc => doc.data().reference === expected.reference)?.data();
        assert.ok(current); assert.equal(current.historyImportId, archiveId);
        assert.equal(current.allocatedMinor, expected.amountMinor); assert.equal(current.limitMinor, expected.amountMinor);
        assert.deepEqual(current.sourcePaymentIds, expected.sourcePaymentIds);
      }
      return { result: 'already imported', tenantId, importedReferences: replay.data().metadata.references.length, paymentsCreated: 0, billsSettled: 0 };
    }
    const plan = planHistory(tenantId, payments.docs.map(doc => ({ ...doc.data(), id: doc.id })), claims.docs.map(doc => doc.data()));
    if (apply) {
      assert.equal(expectedHash, plan.fingerprint, 'History changed since preview; review a fresh plan');
      assert.ok(plan.imports.length > 0 && plan.imports.length <= 200, 'Expected 1–200 references for this atomic import');
      const now = Timestamp.now();
      for (const row of plan.imports) {
        const ref = db.doc(`payment_receipt_claims/${deterministicId('mpesa-receipt', `${tenantId}:${row.reference}`)}`);
        tx.create(ref, { tenantId, provider: 'mpesa', reference: row.reference,
          allocationId: `history:${tenantId}:${row.reference}`, targets: row.targets,
          allocatedMinor: row.amountMinor, limitMinor: row.amountMinor, verified: false,
          amountSource: 'historical_allocations', amountMeaning: 'previously_applied_only',
          sourcePaymentIds: row.sourcePaymentIds, branchIds: row.branchIds,
          historyImportId: archiveId, createdAt: now, updatedAt: now,
          ...(row.paidAtMs !== null ? { paidAt: Timestamp.fromMillis(row.paidAtMs) } : {}) });
      }
      tx.create(db.doc(`audit_logs/${archiveId}`), { tenantId, action: 'mpesa.receipt_history.imported', createdAt: now,
        actorType: 'user_authorized_maintenance', entityType: 'receipt_history', entityId: tenantId,
        metadata: { fingerprint: plan.fingerprint, references: plan.imports, skipped: plan.skipped,
          reason: 'User requested importing saved historical M-Pesa records and rechecking the reported bill. Only previous allocations are indexed; no new money, payment or invoice settlement is created.' } });
    }
    const dates = plan.imports.map(row => row.paidAtMs).filter(Number.isFinite);
    return { result: apply ? 'imported' : plan.imports.length ? 'ready (dry run)' : 'up to date', tenantId, fingerprint: plan.fingerprint,
      successfulMpesaRows: plan.successfulMpesaRows, distinctReferences: plan.distinctReferences,
      existingReferences: plan.existingReferences, importedReferences: plan.imports.length, skippedRows: plan.skipped.length,
      oldestImportedPayment: dates.length ? new Date(Math.min(...dates)).toISOString() : null,
      newestImportedPayment: dates.length ? new Date(Math.max(...dates)).toISOString() : null,
      availableMoneyCreated: 0, paymentsCreated: 0, billsSettled: 0, existingClaimsOverwritten: 0 };
  });
}
async function main() {
  const args = process.argv.slice(2), value = key => args.includes(key) ? args[args.indexOf(key) + 1] : undefined;
  assert.equal(value('--project'), 'vanbransa-pos'); assert.ok(!process.env.FIRESTORE_EMULATOR_HOST);
  const backend = require('node:module').createRequire(path.resolve(__dirname, '../backend/functions/package.json'));
  const { initializeApp, applicationDefault } = backend('firebase-admin/app');
  const { getFirestore } = backend('firebase-admin/firestore');
  const app = initializeApp({ projectId: 'vanbransa-pos', credential: applicationDefault() });
  try { console.log(JSON.stringify(await importHistory(getFirestore(app), value('--tenant'), {
    apply: args.includes('--apply'), expectedHash: value('--expected-hash'),
  }), null, 2)); } finally { await app.delete(); }
}
module.exports = { planHistory, importHistory };
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
