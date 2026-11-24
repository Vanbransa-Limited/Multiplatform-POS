'use strict';
// Corrections for the bills Sherryl reported on Sun 22 and Mon 23 Nov 2026.
// Default is a read-only dry run. Apply requires the reviewed dry-run hash.
//
// 1. UKMLC3G4DZ (KES 700, paid 22 Nov 4:48 PM for Table 40, INV-BH001-003197)
//    was typed against INV-BH001-003180 (Table 36, Samosa) for KES 100.
//    Reverse that allocation and record the receipt at its real KES 700.
//    003180 is unpaid again; 003197 is then cleared with the code at the till.
// 2. INV-BH001-003318 duplicates INV-BH001-003320 (1 x Ugali Matumbo, Table 7).
//    Void the duplicate exactly as voidSale does.
// 3. INV-BH001-003320 missed the Staff 20% Discount (customer paid KES 240 with
//    UKNAJ32TS5). Apply it, approved by Sherryl (manager); settle at the till.
const assert = require('node:assert/strict');
const path = require('node:path');
const { createHash } = require('node:crypto');
const backend = require('node:module').createRequire(path.resolve(__dirname, '../backend/functions/package.json'));
const { initializeApp, applicationDefault } = backend('firebase-admin/app');
const { getFirestore, Timestamp, FieldValue } = backend('firebase-admin/firestore');
const { inclusiveTax } = require('../backend/functions/lib/shared/money');
const { TAX_BASIS_POINTS } = require('../backend/functions/lib/modules/sales/constants');

const tenantId = 'tenant-01', branchId = 'branch-nai-01';
const archiveId = 'sherryl-reports-20261123';
const actor = `reconciliation:${archiveId}`;
const reference = 'UKMLC3G4DZ', receiptMinor = 70000;
const ESTHER_SAMOSA = 'sale-bfabad2da813f20f927313cb7e1ccf0bbf4c4ada9d648f3d'; // INV-BH001-003180
const TABLE40 = 'sale-edcd6f1f17abec3b2c3b5d08548c0e766b377a73e0e0f826'; // INV-BH001-003197
const CLAIM = 'mpesa-receipt-4dab4cc0a558a496ce4ed522bbc641c71397024ecc22d1af';
const WRONG_SETTLEMENT = 'sale-settlement-81283e760736c08ba39e4579d16f0624d91b0f36c4450ff2';
const LINDA_DUP = 'sale-ec01f5fa1639c2228e02bf1ba1dc3f85fd2922e7e15234e5'; // INV-BH001-003318
const LINDA_KEEP = 'sale-9b03421b00ba434d88c2a783e2db3839fb20268cef0de4ec'; // INV-BH001-003320
const SHERRYL = 'staff-6fc10bf06ad622e004f2056af83b1ef72fc1a1b4a0a9f983';
const RECEIPT_PAID_AT = Timestamp.fromDate(new Date('2026-11-22T16:48:00+03:00'));

const stable = value => value?.toMillis ? { timestampMs: value.toMillis() }
  : Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
const fingerprint = value => createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');

async function reconcile(db, { apply = false, expectedHash = null } = {}) {
  const refs = {
    archive: db.doc(`reconciliation_archives/${archiveId}`),
    claim: db.doc(`payment_receipt_claims/${CLAIM}`),
    wrong: db.doc(`payments/${WRONG_SETTLEMENT}`),
    estherSale: db.doc(`sales/${ESTHER_SAMOSA}`),
    estherCredit: db.doc(`payments/${ESTHER_SAMOSA}_payment_01`),
    t40Sale: db.doc(`sales/${TABLE40}`),
    t40Credit: db.doc(`payments/${TABLE40}_payment_01`),
    dupSale: db.doc(`sales/${LINDA_DUP}`),
    dupLine: db.doc(`sale_lines/${LINDA_DUP}_line_01`),
    keepSale: db.doc(`sales/${LINDA_KEEP}`),
    keepLine: db.doc(`sale_lines/${LINDA_KEEP}_line_01`),
    keepCredit: db.doc(`payments/${LINDA_KEEP}_payment_01`),
  };
  return db.runTransaction(async tx => {
    const names = Object.keys(refs);
    const snaps = await tx.getAll(...Object.values(refs));
    const doc = Object.fromEntries(names.map((name, i) => [name, snaps[i]]));
    if (doc.archive.exists) return { result: 'already reconciled', archiveId };
    const [byReference, dupPayments, keepPayments, dupMoves, t40Payments] = await Promise.all([
      tx.get(db.collection('payments').where('reference', '==', reference)),
      tx.get(db.collection('payments').where('saleId', '==', LINDA_DUP)),
      tx.get(db.collection('payments').where('saleId', '==', LINDA_KEEP)),
      tx.get(db.collection('stock_movements').where('referenceId', '==', LINDA_DUP)),
      tx.get(db.collection('payments').where('saleId', '==', TABLE40)),
    ]);
    const d = name => { assert.ok(doc[name].exists, `${name} missing`); return doc[name].data(); };

    // 1. The receipt and the two bills are exactly as reviewed.
    const claim = d('claim');
    assert.equal(claim.tenantId, tenantId); assert.equal(claim.reference, reference);
    assert.equal(claim.limitMinor, 10000); assert.equal(claim.allocatedMinor, 10000);
    assert.deepEqual(claim.targets, [`sale:${ESTHER_SAMOSA}`]);
    assert.deepEqual(byReference.docs.map(row => row.id), [WRONG_SETTLEMENT]);
    const wrong = d('wrong');
    assert.equal(wrong.status, 'completed'); assert.equal(wrong.saleId, ESTHER_SAMOSA); assert.equal(wrong.amountMinor, 10000);
    assert.equal(d('estherSale').invoiceNumber, 'INV-BH001-003180'); assert.equal(d('estherSale').totalMinor, 10000);
    const estherCredit = d('estherCredit');
    assert.equal(estherCredit.method, 'credit'); assert.equal(estherCredit.settledReference, reference); assert.equal(estherCredit.amountMinor, 10000);
    const t40 = d('t40Sale');
    assert.equal(t40.invoiceNumber, 'INV-BH001-003197'); assert.equal(t40.totalMinor, receiptMinor); assert.equal(t40.status, 'completed');
    assert.deepEqual(t40Payments.docs.map(row => row.id), [`${TABLE40}_payment_01`]);
    assert.equal(d('t40Credit').method, 'credit'); assert.equal(d('t40Credit').settledAt, undefined);

    // 2 and 3. Linda's two copies: same item, same price, neither paid.
    const dup = d('dupSale'), keep = d('keepSale'), dupLine = d('dupLine'), keepLine = d('keepLine');
    assert.equal(dup.invoiceNumber, 'INV-BH001-003318'); assert.equal(dup.status, 'completed'); assert.equal(dup.totalMinor, 30000);
    assert.equal(keep.invoiceNumber, 'INV-BH001-003320'); assert.equal(keep.status, 'completed'); assert.equal(keep.totalMinor, 30000);
    assert.equal(keep.discountMinor, 0); assert.equal(keep.tableNumber, '7');
    assert.ok(!['fiscalized', 'signed'].includes(String(keep.fiscalStatus).toLowerCase()), 'A fiscal receipt needs a separate correction');
    assert.equal(dupLine.productId, keepLine.productId); assert.equal(keepLine.qty, 1); assert.equal(keepLine.unitPriceMinor, 30000);
    assert.equal(keepLine.discountMinor, 0);
    for (const payments of [dupPayments, keepPayments]) {
      assert.equal(payments.size, 1);
      assert.equal(payments.docs[0].data().method, 'credit'); assert.equal(payments.docs[0].data().settledAt, undefined);
    }
    assert.equal(dupMoves.empty, true, 'Tracked stock needs a separate restoration');

    const discountMinor = Math.round(keepLine.unitPriceMinor * keepLine.qty * 0.20);
    const totalMinor = keep.totalMinor - discountMinor;
    const taxMinor = inclusiveTax(totalMinor, TAX_BASIS_POINTS[keepLine.taxCode]);
    const records = Object.fromEntries(names.filter(name => name !== 'archive').map(name => [name, doc[name].data()]));
    const hash = fingerprint(records);
    const plan = {
      receipt: `${reference}: reverse KES 100 on INV-BH001-003180, record receipt at KES ${receiptMinor / 100}, 0 used`,
      void: 'INV-BH001-003318 voided as duplicate of INV-BH001-003320',
      discount: `INV-BH001-003320: discount KES ${discountMinor / 100}, total KES ${totalMinor / 100}, tax KES ${taxMinor / 100}`,
    };
    if (!apply) return { result: 'dry run, nothing written', hash, plan };
    assert.equal(expectedHash, hash, 'The records changed since the reviewed dry run.');

    const now = Timestamp.now();
    tx.create(refs.archive, { tenantId, records, sourceFingerprint: hash, plan, createdAt: now,
      authorizedBy: 'Owner, 24 Nov 2026, after reviewing Sherryl\'s 22-23 Nov reports' });

    tx.update(refs.wrong, { status: 'reversed', reversedAt: now, reversedBy: actor, reconciliationId: archiveId,
      reversalReason: `${reference} paid KES 700 for Table 40 (INV-BH001-003197), not this Samosa bill.` });
    tx.update(refs.estherCredit, { settledAt: FieldValue.delete(), settledByStaffId: FieldValue.delete(),
      settledMethod: FieldValue.delete(), settledReference: FieldValue.delete(), reopenedAt: now, reconciliationId: archiveId });
    tx.update(refs.claim, { amountSource: 'reviewed_receipt', branchId, reconciliationId: archiveId,
      limitMinor: receiptMinor, allocatedMinor: 0, targets: [], paidAt: RECEIPT_PAID_AT, verified: false,
      correctedFromLimitMinor: 10000, updatedAt: now });

    for (const row of dupPayments.docs) tx.update(row.ref, { status: 'voided', voidedAt: now, voidedByStaffId: actor });
    tx.update(refs.dupSale, { status: 'VOIDED', voidedAt: now, voidedByStaffId: actor, reconciliationId: archiveId,
      voidReason: 'Duplicate of INV-BH001-003320 (1 x Ugali Matumbo, Table 7), reported by Sherryl 23 Nov.' });

    tx.update(refs.keepLine, { discountMinor, taxMinor, lineTotalMinor: totalMinor });
    tx.update(refs.keepCredit, { amountMinor: totalMinor });
    tx.update(refs.keepSale, { discountMinor, taxMinor, totalMinor, updatedAt: now,
      discountApprovedByStaffId: SHERRYL, discountCorrection: { reconciliationId: archiveId,
        reason: 'Staff 20% discount missed at the till; approved by Sherryl (manager).' } });

    const audit = (suffix, action, entityType, entityId, metadata) => tx.create(db.doc(`audit_logs/${archiveId}-${suffix}`), {
      tenantId, branchId, actorStaffId: actor, action, entityType, entityId, metadata: { ...metadata, reconciliationId: archiveId }, createdAt: now });
    audit('receipt', 'receipt.reconciled', 'payment_receipt_claim', CLAIM, { reference, fromMinor: 10000, toMinor: receiptMinor, reversedPaymentId: WRONG_SETTLEMENT });
    audit('void', 'sale.voided', 'sale', LINDA_DUP, { invoiceNumber: 'INV-BH001-003318', reason: 'duplicate', totalMinor: 30000 });
    audit('discount', 'sale.discount_corrected', 'sale', LINDA_KEEP, { invoiceNumber: 'INV-BH001-003320', discountMinor, totalMinor, approvedByStaffId: SHERRYL });
    return { result: 'applied', archiveId, hash, plan };
  });
}

async function main() {
  const args = process.argv.slice(2);
  const value = name => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
  if (value('--project') !== 'vanbransa-pos') throw new Error('Explicit --project vanbransa-pos required.');
  const apply = args.includes('--apply');
  if (apply && !value('--expected-hash')) throw new Error('Apply requires the reviewed --expected-hash.');
  const db = getFirestore(initializeApp({ projectId: 'vanbransa-pos', credential: applicationDefault() }));
  console.log(JSON.stringify(await reconcile(db, { apply, expectedHash: value('--expected-hash') }), null, 2));
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { reconcile };
