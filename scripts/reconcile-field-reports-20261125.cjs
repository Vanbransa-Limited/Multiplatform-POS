'use strict';
// Corrections for the bills reported on Wed 25 Nov 2026 (Kester, Sherryl).
// Default is a read-only dry run. Apply requires the reviewed dry-run hash.
//
// Each duplicate below was rung a second time when the customer paid, because
// the first copy waited unpaid in Orders after checkout was closed.
// 1. INV-BH001-003423 (Gogo, Redbull 400, no table) duplicates 003425 (Table 6),
//    paid with UKP5D3EW5H. "No unallocated money left" was right. Void 003423.
// 2. INV-BH001-003403 (Esther, Samosa 100) duplicates 003405, paid with
//    UKPCH3JTON. Void 003403.
// 3. One KES 260 payment, UKPH53LYOK (11:09), cleared two Americanos: 003404 at
//    11:30 under the mistyped UKPH53LY0K (zero), and 003402 at 20:18 under the
//    real code. Reverse the mistyped settlement and void 003404 as the duplicate.
// 4. INV-BH001-003406 (Esther, 2 x Water 200) missed the Staff 20%; the customer
//    paid KES 160 with UKPO63MHFK. Apply the 20%; record UKPO63MHFK in Orders.
const assert = require('node:assert/strict');
const path = require('node:path');
const { createHash } = require('node:crypto');
const backend = require('node:module').createRequire(path.resolve(__dirname, '../backend/functions/package.json'));
const { initializeApp, applicationDefault } = backend('firebase-admin/app');
const { Timestamp, FieldValue } = backend('firebase-admin/firestore');

const tenantId = 'tenant-01', branchId = 'branch-nai-01';
const archiveId = 'field-reports-20261125';
const actor = `reconciliation:${archiveId}`;
const OWNER = { tenant_id: tenantId, staff_id: 'user-owner', staff_role: 'owner' };
const S = {
  redbullDup: 'sale-ed9dc33faae3431ad0a1a7e7dd61c9aea820217b40f85a24', // 003423
  redbullPaid: 'sale-6d1c6abdb54d9317308a1593f7b1b7b8e97ecaf858eed9be', // 003425
  samosaDup: 'sale-39221845ab9d2819af95b13301a7b2a68fbf94b8f0d11d55', // 003403
  samosaPaid: 'sale-7579592207b55c84b15613336bf61ac677e47b8a95d467f5', // 003405
  americano: 'sale-934d64b9e7d77ad917434105f09007295dec0bdf2fdaa161', // 003402
  americanoDup: 'sale-f03e40e2fdd9079eba57b1a2c51d6a5e4905813a453c10c8', // 003404
  water: 'sale-a30b7a3f9cc435ca8e4f140b57717c7bdcc2f9b495abf41f', // 003406
};
const TYPO = 'UKPH53LY0K', REAL = 'UKPH53LYOK';
const TYPO_SETTLEMENT = 'sale-settlement-d5351c503720f1660a8c8200a24b2dba091bd3dd024fbafd';
const VOIDS = [
  [S.redbullDup, 'INV-BH001-003423', 'Duplicate of INV-BH001-003425 (Redbull, Table 6), paid with UKP5D3EW5H; reported 25 Nov.'],
  [S.samosaDup, 'INV-BH001-003403', 'Duplicate of INV-BH001-003405 (Samosa), paid with UKPCH3JTON; reported 25 Nov.'],
];
// 003404 keeps its reversed M-Pesa row, which voidSale refuses; it moved no stock, so it is voided here.
const AMERICANO_VOID = `Duplicate of INV-BH001-003402 (Americano), paid once with ${REAL}; ${TYPO} was a mistyped copy of it.`;

const stable = value => value?.toMillis ? { timestampMs: value.toMillis() }
  : Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
const fingerprint = value => createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
const unpaidCreditOnly = rows => rows.length === 1 && rows[0].method === 'credit' && !rows[0].settledAt;

async function correct(db, deps, { apply, expectedHash }) {
  const { deterministicId, roundStaffDiscount } = deps;
  const claimId = code => deterministicId('mpesa-receipt', `${tenantId}:${code}`);
  const refs = {
    archive: db.doc(`reconciliation_archives/${archiveId}`),
    typoClaim: db.doc(`payment_receipt_claims/${claimId(TYPO)}`),
    realClaim: db.doc(`payment_receipt_claims/${claimId(REAL)}`),
    paidClaim: db.doc(`payment_receipt_claims/${claimId('UKPO63MHFK')}`),
    typoSettlement: db.doc(`payments/${TYPO_SETTLEMENT}`),
    dupCredit: db.doc(`payments/${S.americanoDup}_payment_01`),
    ...Object.fromEntries(Object.entries(S).map(([name, id]) => [name, db.doc(`sales/${id}`)])),
  };
  return db.runTransaction(async tx => {
    const names = Object.keys(refs);
    const snaps = await tx.getAll(...Object.values(refs));
    const doc = Object.fromEntries(names.map((name, i) => [name, snaps[i]]));
    if (doc.archive.exists) return { result: 'already corrected', archiveId };
    const d = name => { assert.ok(doc[name].exists, `${name} missing`); return doc[name].data(); };
    const payments = {};
    for (const [name, id] of Object.entries(S)) {
      payments[name] = (await tx.get(db.collection('payments').where('saleId', '==', id))).docs.map(row => ({ id: row.id, ...row.data() }));
    }
    const waterLineSnaps = await tx.getAll(...d('water').lineIds.map(id => db.doc(`sale_lines/${id}`)));

    // 1-2. The duplicates are unpaid copies of paid bills with the same items.
    for (const [dup, paid, invoice, total] of [['redbullDup', 'redbullPaid', 'INV-BH001-003423', 40000], ['samosaDup', 'samosaPaid', 'INV-BH001-003403', 10000]]) {
      assert.equal(d(dup).invoiceNumber, invoice); assert.equal(d(dup).totalMinor, total); assert.equal(d(dup).status, 'completed');
      assert.ok(unpaidCreditOnly(payments[dup]), `${invoice} has a payment`);
      assert.equal(d(paid).totalMinor, total);
      assert.ok(payments[paid].some(row => row.method === 'mpesa' && row.amountMinor === total && row.status === 'completed'), `${paid} not paid`);
    }
    // 3. Two settlements of one payment; the mistyped code exists nowhere else.
    assert.equal(d('americanoDup').invoiceNumber, 'INV-BH001-003404'); assert.equal(d('americano').invoiceNumber, 'INV-BH001-003402');
    const typo = d('typoSettlement');
    assert.equal(typo.reference, TYPO); assert.equal(typo.saleId, S.americanoDup); assert.equal(typo.amountMinor, 26000); assert.equal(typo.status, 'completed');
    assert.deepEqual(d('typoClaim').targets, [`sale:${S.americanoDup}`]);
    assert.deepEqual(d('realClaim').targets, [`sale:${S.americano}`]);
    assert.equal((await tx.get(db.collection('payments').where('reference', '==', TYPO))).size, 1);
    assert.equal(d('dupCredit').method, 'credit'); assert.ok(d('dupCredit').settledAt, '003404 credit not settled');
    assert.equal(d('americanoDup').status, 'completed');
    assert.equal((await tx.get(db.collection('stock_movements').where('referenceId', '==', S.americanoDup))).size, 0, '003404 moved stock');
    // 4. 003406 is unpaid, undiscounted, and UKPO63MHFK is unused.
    const water = d('water');
    assert.equal(water.invoiceNumber, 'INV-BH001-003406'); assert.equal(water.totalMinor, 20000); assert.equal(Number(water.discountMinor || 0), 0);
    assert.ok(!['signed', 'fiscalized'].includes(String(water.fiscalStatus || '').toLowerCase()), 'Fiscalised: needs a credit note');
    assert.ok(unpaidCreditOnly(payments.water), '003406 has a payment');
    assert.equal(doc.paidClaim.exists, false, 'UKPO63MHFK already used');
    const waterLines = waterLineSnaps.map(snap => { assert.ok(snap.exists); return snap.data(); });
    const next = roundStaffDiscount(waterLines);
    assert.equal(next.totalMinor, 16000);

    const records = { ...Object.fromEntries(names.filter(n => n !== 'archive').map(n => [n, doc[n].data() ?? null])), payments, waterLines };
    const hash = fingerprint(records);
    const plan = {
      reverse: `${TYPO} (KES 260) on INV-BH001-003404 reversed: mistyped ${REAL}, already on INV-BH001-003402`,
      void: [...VOIDS.map(([, invoice, reason]) => `${invoice}: ${reason}`), `INV-BH001-003404: ${AMERICANO_VOID}`],
      discount: `INV-BH001-003406: Staff 20% KES ${next.discountMinor / 100}, total KES ${next.totalMinor / 100}; then record UKPO63MHFK KES 160 in Orders`,
    };
    if (!apply) return { result: 'dry run, nothing written', hash, plan };
    assert.equal(expectedHash, hash, 'The records changed since the reviewed dry run.');

    const now = Timestamp.now();
    tx.create(refs.archive, { tenantId, records, sourceFingerprint: hash, plan, createdAt: now,
      authorizedBy: 'Owner, after reviewing the 25 Nov 2026 field reports' });
    tx.update(refs.typoSettlement, { status: 'reversed', reversedAt: now, reversedBy: actor, reconciliationId: archiveId,
      reversalReason: plan.reverse });
    tx.update(refs.dupCredit, { settledAt: FieldValue.delete(), settledByStaffId: FieldValue.delete(), settledMethod: FieldValue.delete(),
      settledReference: FieldValue.delete(), status: 'voided', voidedAt: now, voidedByStaffId: actor, reconciliationId: archiveId });
    tx.update(refs.americanoDup, { status: 'VOIDED', voidedAt: now, voidedByStaffId: actor, reconciliationId: archiveId, voidReason: AMERICANO_VOID });
    tx.update(refs.typoClaim, { allocatedMinor: 0, targets: [], reversedAt: now, reconciliationId: archiveId,
      reversalReason: `Mistyped copy of ${REAL}.`, updatedAt: now });
    next.lines.forEach((line, i) => tx.update(waterLineSnaps[i].ref, { discountMinor: line.discountMinor, lineTotalMinor: line.lineTotalMinor, taxMinor: line.taxMinor }));
    tx.update(db.doc(`payments/${payments.water[0].id}`), { amountMinor: next.totalMinor, updatedAt: now });
    tx.update(refs.water, { discountMinor: next.discountMinor, taxMinor: next.taxMinor, totalMinor: next.totalMinor, updatedAt: now,
      discountCorrection: { reconciliationId: archiveId, reason: 'Staff 20% missed at the till; customer paid KES 160 (UKPO63MHFK).' } });
    const audit = (suffix, action, entityType, entityId, metadata) => tx.create(db.doc(`audit_logs/${archiveId}-${suffix}`), {
      tenantId, branchId, actorStaffId: actor, action, entityType, entityId, metadata: { ...metadata, reconciliationId: archiveId }, createdAt: now });
    audit('reverse', 'payment.reversed', 'payment', TYPO_SETTLEMENT, { reference: TYPO, realReference: REAL, amountMinor: 26000 });
    audit('void', 'sale.voided', 'sale', S.americanoDup, { invoiceNumber: 'INV-BH001-003404', reason: 'duplicate', totalMinor: 26000 });
    audit('discount', 'sale.discount_corrected', 'sale', S.water, { invoiceNumber: 'INV-BH001-003406', discountMinor: next.discountMinor, totalMinor: next.totalMinor });
    return { result: 'corrected', archiveId, hash, plan };
  });
}

async function main() {
  const args = process.argv.slice(2);
  const value = name => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
  if (value('--project') !== 'vanbransa-pos') throw new Error('Explicit --project vanbransa-pos required.');
  const apply = args.includes('--apply');
  if (apply && !value('--expected-hash')) throw new Error('Apply requires the reviewed --expected-hash.');
  // The backend modules reuse this app, so they act on production only when told to.
  initializeApp({ projectId: 'vanbransa-pos', credential: applicationDefault() });
  const { db } = require('../backend/functions/lib/lib/firebase');
  const { deterministicId } = require('../backend/functions/lib/shared/identifiers');
  const { roundStaffDiscount } = require('../backend/functions/lib/modules/sales/round-discount');
  const { voidSale } = require('../backend/functions/lib/modules/sales/settle');

  const outcome = await correct(db, { deterministicId, roundStaffDiscount }, { apply, expectedHash: value('--expected-hash') });
  console.log(JSON.stringify(outcome, null, 2));
  if (!apply) return;
  // Voids go through voidSale itself: stock comes back and the audit is a Void's.
  for (const [saleId, invoice, reason] of VOIDS) {
    const sale = (await db.doc(`sales/${saleId}`).get()).data();
    const result = await voidSale.run({ auth: { uid: 'owner-reconciliation', token: OWNER }, data: { saleUuid: sale.idempotencyKey, reason } });
    console.log(`${invoice}: ${result.alreadyVoided ? 'already voided' : 'voided'}`);
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
