'use strict';
// Read-only ledger health check. Keep this scan out of the checkout request path.
const path = require('node:path');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const backend = require('node:module').createRequire(path.resolve(__dirname, '../backend/functions/package.json'));
const { initializeApp, applicationDefault } = backend('firebase-admin/app');
const { getFirestore } = backend('firebase-admin/firestore');
function auditReceipts(claims, payments) {
  const usage = new Map();
  for (const row of payments) {
    if (String(row.method).toLowerCase() !== 'mpesa'
      || !['completed', 'paid', 'success'].includes(String(row.status || 'completed').toLowerCase())) continue;
    // The two fields can contain the same code: one payment still counts once.
    for (const code of new Set([row.reference, row.providerTransactionId].map(value => String(value || '').trim().toUpperCase()).filter(Boolean))) {
      const current = usage.get(code) || { amountMinor: 0, rows: 0, invalid: false };
      current.invalid ||= !Number.isSafeInteger(row.amountMinor) || row.amountMinor <= 0;
      current.amountMinor += Number(row.amountMinor || 0); current.rows++;
      usage.set(code, current);
    }
  }
  const issues = [], tracked = new Set();
  let internalClaims = 0, remainingMinor = 0;
  for (const claim of claims) {
    const code = String(claim.reference || '').trim().toUpperCase(); tracked.add(code);
    const ledger = usage.get(code) || { amountMinor: 0, rows: 0 };
    const valid = Number.isSafeInteger(claim.limitMinor) && claim.limitMinor > 0
      && Number.isSafeInteger(claim.allocatedMinor) && claim.allocatedMinor >= 0 && claim.allocatedMinor <= claim.limitMinor;
    if (!code || !valid || ledger.invalid || ledger.amountMinor !== claim.allocatedMinor) {
      issues.push({ reference: code, problem: !valid ? 'invalid receipt limit/allocation' : ledger.invalid ? 'invalid ledger amount' : 'claim and ledger differ',
        allocatedMinor: claim.allocatedMinor, ledgerMinor: ledger.amountMinor });
    }
    if (claim.amountSource === 'staff_recorded_receipt') {
      internalClaims++;
      // Later provider proof may verify the shared claim; its original staff
      // attribution must survive that transition.
      if (typeof claim.verified !== 'boolean' || !claim.recordedByStaffId || !claim.branchId) issues.push({ reference: code, problem: 'missing internal receipt provenance' });
      if (valid) remainingMinor += claim.limitMinor - claim.allocatedMinor;
    }
  }
  return { trackedReceipts: claims.length, staffRecordedReceipts: internalClaims, remainingInternalMinor: remainingMinor,
    historicalReferencesWithoutClaim: [...usage.keys()].filter(code => !tracked.has(code)).length, issues };
}
async function main() {
  const args = process.argv.slice(2);
  assert.ok(args.includes('--project') && args[args.indexOf('--project') + 1] === 'vanbransa-pos', 'Pass --project vanbransa-pos');
  assert.ok(!process.env.FIRESTORE_EMULATOR_HOST);
  const tenantId = args.includes('--tenant') ? args[args.indexOf('--tenant') + 1] : 'tenant-01';
  assert.match(tenantId || '', /^[A-Za-z0-9_-]{1,128}$/, 'Invalid --tenant');
  const app = initializeApp({ projectId: 'vanbransa-pos', credential: applicationDefault() });
  try {
    const db = getFirestore(app);
    const result = await db.runTransaction(async tx => {
      const [claims, payments] = await Promise.all([
        tx.get(db.collection('payment_receipt_claims').where('tenantId', '==', tenantId)),
        tx.get(db.collection('payments').where('tenantId', '==', tenantId)),
      ]);
      return auditReceipts(claims.docs.map(doc => doc.data()), payments.docs.map(doc => doc.data()));
    }, { readOnly: true });
    // Do not print customer receipt references in routine release output.
    result.issues = result.issues.map(({ reference, ...issue }) => ({ referenceHash: createHash('sha256').update(reference).digest('hex').slice(0, 16), ...issue }));
    console.log(JSON.stringify({ tenantId, readOnly: true, ...result }, null, 2));
    if (result.issues.length) process.exitCode = 1;
  } finally { await app.delete(); }
}
module.exports = { auditReceipts };
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
