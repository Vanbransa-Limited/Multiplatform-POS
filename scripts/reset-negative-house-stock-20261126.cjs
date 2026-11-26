'use strict';
// Owner, 26 Nov 2026: House stock never shows a negative. Sales now stop at
// zero (dependencies.ts); this brings the balances already below zero up to 0.
// Each one gets an 'adjust' movement and the batch one audit row.
// Default is a read-only dry run. Apply requires the reviewed dry-run hash.
const assert = require('node:assert/strict');
const path = require('node:path');
const { createHash } = require('node:crypto');
const backend = require('node:module').createRequire(path.resolve(__dirname, '../backend/functions/package.json'));
const { initializeApp, applicationDefault } = backend('firebase-admin/app');
const { getFirestore, Timestamp } = backend('firebase-admin/firestore');

const archiveId = 'reset-negative-house-stock-20261126';
const actor = `reconciliation:${archiveId}`;

async function reset(db, { apply = false, expectedHash = null } = {}) {
  const archiveRef = db.doc(`reconciliation_archives/${archiveId}`);
  if ((await archiveRef.get()).exists) return { result: 'already reset', archiveId };
  const negative = (await db.collection('stock_balances').where('location', '==', 'HOUSE').get()).docs
    .filter(doc => Number(doc.data().qty) < 0).map(doc => ({ id: doc.id, ...doc.data() }))
    .sort((a, b) => a.id.localeCompare(b.id));
  const hash = createHash('sha256').update(JSON.stringify(negative.map(row => [row.id, row.qty]))).digest('hex');
  const plan = negative.map(row => `${row.tenantId} ${row.productId}: ${row.qty} -> 0`);
  if (!apply) return { result: 'dry run, nothing written', hash, count: negative.length, plan };
  assert.equal(expectedHash, hash, 'The balances changed since the reviewed dry run.');
  assert.ok(negative.length <= 400, 'too many for one batch');
  const now = Timestamp.now();
  const batch = db.batch();
  batch.create(archiveRef, { records: negative, sourceFingerprint: hash, plan, createdAt: now,
    authorizedBy: 'Owner, 26 Nov 2026: "remove the negative"' });
  for (const row of negative) {
    batch.update(db.doc(`stock_balances/${row.id}`), { qty: 0, updatedAt: now });
    batch.create(db.doc(`stock_movements/${archiveId}_${row.id}`), { tenantId: row.tenantId, branchId: row.branchId,
      productId: row.productId, location: 'HOUSE', qty: -row.qty, type: 'adjust', balanceAfterQty: 0,
      referenceId: archiveId, reason: 'Negative House balance reset to zero', createdByStaffId: actor, createdAt: now });
  }
  for (const tenantId of new Set(negative.map(row => row.tenantId))) {
    batch.create(db.doc(`audit_logs/${archiveId}-${tenantId}`), { tenantId, actorStaffId: actor, action: 'stock.negative_reset',
      entityType: 'reconciliation', entityId: archiveId,
      metadata: { balances: negative.filter(row => row.tenantId === tenantId).map(row => ({ productId: row.productId, from: row.qty })) },
      createdAt: now });
  }
  await batch.commit();
  return { result: 'applied', archiveId, hash, count: negative.length };
}

async function main() {
  const args = process.argv.slice(2);
  const value = name => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
  if (value('--project') !== 'vanbransa-pos') throw new Error('Explicit --project vanbransa-pos required.');
  const apply = args.includes('--apply');
  if (apply && !value('--expected-hash')) throw new Error('Apply requires the reviewed --expected-hash.');
  const db = getFirestore(initializeApp({ projectId: 'vanbransa-pos', credential: applicationDefault() }));
  console.log(JSON.stringify(await reset(db, { apply, expectedHash: value('--expected-hash') }), null, 2));
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { reset };
