'use strict';
// Hadrine's 25 Nov 2026 report: one M-Pesa payment, UKP6749DGE, of KES 850 paid
// INV-BH001-003457 (Ugali Beef 500, Table 6) and INV-BH001-003463 (Smirnoff
// Pineapple Punch 350, rung separately because the till would not add it to
// 003457). The receipt was recorded at KES 500, so 003463 stayed unpaid and the
// code was refused as used up. The owner confirmed the KES 850 on 26 Nov 2026.
//
// Corrects the recorded total to KES 850 as a reviewed receipt (still unverified:
// no provider proof), then settles 003463's KES 350 through settleSale itself.
// Default is a read-only dry run. Apply requires the reviewed dry-run hash.
const assert = require('node:assert/strict');
const path = require('node:path');
const { createHash } = require('node:crypto');
const backend = require('node:module').createRequire(path.resolve(__dirname, '../backend/functions/package.json'));
const { initializeApp, applicationDefault } = backend('firebase-admin/app');
const { Timestamp } = backend('firebase-admin/firestore');

const tenantId = 'tenant-01', branchId = 'branch-nai-01';
const archiveId = 'receipt-ukp6749dge-20261125';
const actor = `reconciliation:${archiveId}`;
const OWNER = { tenant_id: tenantId, staff_id: 'user-owner', staff_role: 'owner' };
const CODE = 'UKP6749DGE', RECORDED = 50000, ACTUAL = 85000;
const PAID = 'sale-e1b056df028ad5cdff08978121d313da4492e0d4bfd573f3'; // 003457
const OWED = 'sale-4668dc308bab0fbe30eb3a54a57011c9e485aa37b850f5d0'; // 003463

const stable = value => value?.toMillis ? { timestampMs: value.toMillis() }
  : Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
const fingerprint = value => createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');

async function correct(db, { deterministicId }, { apply, expectedHash }) {
  const refs = {
    archive: db.doc(`reconciliation_archives/${archiveId}`),
    claim: db.doc(`payment_receipt_claims/${deterministicId('mpesa-receipt', `${tenantId}:${CODE}`)}`),
    paid: db.doc(`sales/${PAID}`), owed: db.doc(`sales/${OWED}`),
  };
  return db.runTransaction(async tx => {
    const [archive, claim, paid, owed] = await tx.getAll(...Object.values(refs));
    // A settle that failed after the correction is retried; settleSale replays by requestId.
    if (archive.exists) return { result: 'already corrected', archiveId, saleUuid: owed.data().idempotencyKey };
    const used = (await tx.get(db.collection('payments').where('reference', '==', CODE))).docs.map(d => ({ id: d.id, ...d.data() }));
    const owedPays = (await tx.get(db.collection('payments').where('saleId', '==', OWED))).docs.map(d => ({ id: d.id, ...d.data() }));

    const c = claim.data(), p = paid.data(), o = owed.data();
    assert.equal(c.amountSource, 'staff_recorded_receipt'); assert.equal(c.limitMinor, RECORDED); assert.equal(c.allocatedMinor, RECORDED);
    assert.deepEqual(c.targets, [`sale:${PAID}`]); assert.equal(c.branchId, branchId);
    assert.equal(used.length, 1); assert.equal(used[0].saleId, PAID); assert.equal(used[0].amountMinor, RECORDED); assert.equal(used[0].status, 'completed');
    assert.equal(p.invoiceNumber, 'INV-BH001-003457'); assert.equal(p.totalMinor, RECORDED);
    assert.equal(o.invoiceNumber, 'INV-BH001-003463'); assert.equal(o.totalMinor, ACTUAL - RECORDED); assert.equal(o.status, 'completed');
    assert.equal(o.staffId, p.staffId, 'different waiters');
    assert.ok(owedPays.length === 1 && owedPays[0].method === 'credit' && !owedPays[0].settledAt, '003463 is not simply unpaid');

    const records = { claim: c, paid: p, owed: o, used, owedPays };
    const hash = fingerprint(records);
    const plan = `${CODE}: recorded total KES ${RECORDED / 100} -> KES ${ACTUAL / 100}; settle INV-BH001-003463 KES ${(ACTUAL - RECORDED) / 100} with it`;
    if (!apply) return { result: 'dry run, nothing written', hash, plan, saleUuid: o.idempotencyKey };
    assert.equal(expectedHash, hash, 'The records changed since the reviewed dry run.');

    const now = Timestamp.now();
    tx.create(refs.archive, { tenantId, records, sourceFingerprint: hash, plan, createdAt: now,
      authorizedBy: 'Owner, 26 Nov 2026, after Hadrine\'s voice note of 25 Nov 21:33' });
    // Read by readReceiptBalance as an audited correction, never as provider proof.
    tx.update(refs.claim, { amountSource: 'reviewed_receipt', limitMinor: ACTUAL, reconciliationId: archiveId,
      correctedFromMinor: RECORDED, verified: false, updatedAt: now });
    tx.create(db.doc(`audit_logs/${archiveId}`), { tenantId, branchId, actorStaffId: actor, action: 'receipt.total_corrected',
      entityType: 'payment_receipt_claim', entityId: refs.claim.id,
      metadata: { reference: CODE, fromMinor: RECORDED, toMinor: ACTUAL, reconciliationId: archiveId }, createdAt: now });
    return { result: 'corrected', archiveId, hash, plan, saleUuid: o.idempotencyKey };
  });
}

async function main() {
  const args = process.argv.slice(2);
  const value = name => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
  if (value('--project') !== 'vanbransa-pos') throw new Error('Explicit --project vanbransa-pos required.');
  const apply = args.includes('--apply');
  if (apply && !value('--expected-hash')) throw new Error('Apply requires the reviewed --expected-hash.');
  initializeApp({ projectId: 'vanbransa-pos', credential: applicationDefault() });
  const { db } = require('../backend/functions/lib/lib/firebase');
  const { deterministicId } = require('../backend/functions/lib/shared/identifiers');
  const { settleSale } = require('../backend/functions/lib/modules/sales/settle');

  const outcome = await correct(db, { deterministicId }, { apply, expectedHash: value('--expected-hash') });
  console.log(JSON.stringify(outcome, null, 2));
  if (!apply || !outcome.saleUuid) return;
  // Settled exactly as a till would, so the payment, receivable and claim agree. Retry-safe by requestId.
  const result = await settleSale.run({ auth: { uid: 'owner-reconciliation', token: OWNER }, data: {
    saleUuid: outcome.saleUuid, requestId: archiveId, method: 'mpesa', reference: CODE, amountMinor: ACTUAL - RECORDED } });
  console.log('INV-BH001-003463:', JSON.stringify(result));
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
