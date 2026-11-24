'use strict';
// Table 001 tab ORD-001-079448 (Judith, 23 Nov 2026), reported by Kester 24 Nov.
// Default is a read-only dry run. Apply requires the reviewed dry-run hash.
//
// The guest was due the Staff 20% on the whole tab (KES 1,100 -> 880) and paid
// KES 880 with UKOG93BWUX. The 20% was rung only with the first round
// (milkshake), so the till still asks for KES 120 on INV-BH001-003269.
//
// Correction: give the two later rounds their 20% (Mbuzi 500 -> 400, Rice
// 100 -> 80) and move the money UKOG93BWUX already paid so each round gets
// exactly its total: 400 + 80 + 400 = 880. The receipt's limit, allocation and
// targets do not change; nothing is left owing.
const assert = require('node:assert/strict');
const path = require('node:path');
const { createHash } = require('node:crypto');
const backend = require('node:module').createRequire(path.resolve(__dirname, '../backend/functions/package.json'));
const { initializeApp, applicationDefault } = backend('firebase-admin/app');
const { getFirestore, Timestamp } = backend('firebase-admin/firestore');
const { inclusiveTax } = require('../backend/functions/lib/shared/money');
const { TAX_BASIS_POINTS } = require('../backend/functions/lib/modules/sales/constants');

const tenantId = 'tenant-01', branchId = 'branch-nai-01';
const archiveId = 'table001-discount-20261124';
const actor = `reconciliation:${archiveId}`;
const reference = 'UKOG93BWUX', receiptMinor = 88000;
const CLAIM = 'mpesa-receipt-04b215cc3f7c0cdb237c0d5451469bcf76b1512bbd4f5d2c';
const SHAKE = 'sale-e7c4b9bfbcf42cdaaae30f86f9ebb86459632d18ba14ac73'; // INV-BH001-003269, 20% already on
const RICE = 'sale-2dcfecc42ba5c94b8183575b7e27d413dfa7342851491147'; // INV-BH001-003274
const MBUZI = 'sale-06152766de158f6842c88b8bec7044736b718665e51886f1'; // INV-BH001-003275
const SETTLE = {
  [SHAKE]: 'sale-settlement-6019f8825325d9edd563b20a570610ad750db035c4fbeaf2',
  [RICE]: 'sale-settlement-2fa21047371c0d11353efe095be876de123b5ce8e92c4d26',
  [MBUZI]: 'sale-settlement-ce80bca1053db15ce45709694ec67dadb4a4ea92f29dc200',
};

const stable = value => value?.toMillis ? { timestampMs: value.toMillis() }
  : Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
const fingerprint = value => createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');

async function reconcile(db, { apply = false, expectedHash = null } = {}) {
  const refs = { archive: db.doc(`reconciliation_archives/${archiveId}`), claim: db.doc(`payment_receipt_claims/${CLAIM}`) };
  for (const [key, id] of [['shake', SHAKE], ['rice', RICE], ['mbuzi', MBUZI]]) {
    refs[`${key}Sale`] = db.doc(`sales/${id}`);
    refs[`${key}Line`] = db.doc(`sale_lines/${id}_line_01`);
    refs[`${key}Credit`] = db.doc(`payments/${id}_payment_01`);
    refs[`${key}Settle`] = db.doc(`payments/${SETTLE[id]}`);
  }
  return db.runTransaction(async tx => {
    const names = Object.keys(refs);
    const snaps = await tx.getAll(...Object.values(refs));
    const doc = Object.fromEntries(names.map((name, i) => [name, snaps[i]]));
    if (doc.archive.exists) return { result: 'already reconciled', archiveId };
    const d = name => { assert.ok(doc[name].exists, `${name} missing`); return doc[name].data(); };
    const byReference = await tx.get(db.collection('payments').where('reference', '==', reference));
    const perSale = await Promise.all([SHAKE, RICE, MBUZI].map(id => tx.get(db.collection('payments').where('saleId', '==', id))));

    // Exactly as reviewed on 24 Nov.
    const claim = d('claim');
    assert.equal(claim.tenantId, tenantId); assert.equal(claim.reference, reference);
    assert.equal(claim.limitMinor, receiptMinor); assert.equal(claim.allocatedMinor, receiptMinor);
    assert.deepEqual([...claim.targets].sort(), [MBUZI, RICE, SHAKE].map(id => `sale:${id}`).sort());
    assert.deepEqual(byReference.docs.map(row => row.id).sort(), Object.values(SETTLE).sort());
    perSale.forEach(snap => assert.equal(snap.size, 2, 'Each round has its credit row and one settlement'));
    const expect = { shake: ['INV-BH001-003269', 50000, 10000, 40000, 28000], rice: ['INV-BH001-003274', 10000, 0, 10000, 10000], mbuzi: ['INV-BH001-003275', 50000, 0, 50000, 50000] };
    for (const [key, [invoice, gross, discount, total, settled]] of Object.entries(expect)) {
      const sale = d(`${key}Sale`), line = d(`${key}Line`), settle = d(`${key}Settle`);
      assert.equal(sale.invoiceNumber, invoice); assert.equal(sale.status, 'completed'); assert.equal(sale.tableNumber, '001');
      assert.ok(!['fiscalized', 'signed'].includes(String(sale.fiscalStatus).toLowerCase()), 'A fiscal receipt needs a separate correction');
      assert.equal(sale.subtotalMinor, gross); assert.equal(sale.discountMinor, discount); assert.equal(sale.totalMinor, total);
      assert.equal(line.qty, 1); assert.equal(line.unitPriceMinor, gross); assert.equal(line.discountMinor, discount);
      assert.equal(settle.status, 'completed'); assert.equal(settle.method, 'mpesa'); assert.equal(settle.amountMinor, settled);
      assert.equal(d(`${key}Credit`).method, 'credit');
    }
    assert.equal(d('shakeCredit').amountMinor, 12000); assert.equal(d('shakeCredit').settledAt, undefined);

    // Each round's 20% and what it then costs.
    const fix = {};
    for (const key of ['rice', 'mbuzi']) {
      const line = d(`${key}Line`);
      const discountMinor = Math.round(line.unitPriceMinor * line.qty * 0.20);
      const totalMinor = line.unitPriceMinor * line.qty - discountMinor;
      fix[key] = { discountMinor, totalMinor, taxMinor: inclusiveTax(totalMinor, TAX_BASIS_POINTS[line.taxCode]) };
    }
    const newSettled = { shake: d('shakeSale').totalMinor, rice: fix.rice.totalMinor, mbuzi: fix.mbuzi.totalMinor };
    assert.equal(newSettled.shake + newSettled.rice + newSettled.mbuzi, receiptMinor, 'The receipt must cover the tab exactly');

    const records = Object.fromEntries(names.filter(name => name !== 'archive').map(name => [name, doc[name].data()]));
    const hash = fingerprint(records);
    const plan = {
      rice: `INV-BH001-003274: discount KES ${fix.rice.discountMinor / 100}, total KES ${fix.rice.totalMinor / 100}; ${reference} pays KES ${newSettled.rice / 100} (was 100)`,
      mbuzi: `INV-BH001-003275: discount KES ${fix.mbuzi.discountMinor / 100}, total KES ${fix.mbuzi.totalMinor / 100}; ${reference} pays KES ${newSettled.mbuzi / 100} (was 500)`,
      shake: `INV-BH001-003269: ${reference} pays KES ${newSettled.shake / 100} (was 280); nothing left owing`,
    };
    if (!apply) return { result: 'dry run, nothing written', hash, plan };
    assert.equal(expectedHash, hash, 'The records changed since the reviewed dry run.');

    const now = Timestamp.now();
    const correction = { reconciliationId: archiveId, reason: 'Staff 20% was due on the whole Table 001 tab; guest paid KES 880 with UKOG93BWUX. Authorized by the owner, 24 Nov 2026.' };
    tx.create(refs.archive, { tenantId, records, sourceFingerprint: hash, plan, createdAt: now,
      authorizedBy: 'Owner, 24 Nov 2026, after Kester\'s Table 001 report' });

    for (const key of ['rice', 'mbuzi']) {
      const { discountMinor, totalMinor, taxMinor } = fix[key];
      tx.update(refs[`${key}Line`], { discountMinor, taxMinor, lineTotalMinor: totalMinor });
      tx.update(refs[`${key}Sale`], { discountMinor, taxMinor, totalMinor, updatedAt: now, discountCorrection: correction });
      tx.update(refs[`${key}Credit`], { amountMinor: totalMinor, updatedAt: now });
    }
    for (const key of ['shake', 'rice', 'mbuzi']) {
      const settle = d(`${key}Settle`);
      tx.update(refs[`${key}Settle`], { amountMinor: newSettled[key], correctedFromMinor: settle.amountMinor, reconciliationId: archiveId, updatedAt: now });
    }
    tx.update(refs.shakeCredit, { amountMinor: d('shakeCredit').originalAmountMinor, settledAt: now, settledByStaffId: actor,
      settledMethod: 'mpesa', settledReference: reference, reconciliationId: archiveId, updatedAt: now });

    tx.create(db.doc(`audit_logs/${archiveId}`), { tenantId, branchId, actorStaffId: actor, action: 'sale.discount_corrected',
      entityType: 'sale', entityId: MBUZI, metadata: { ...correction, plan, reference, saleIds: [SHAKE, RICE, MBUZI] }, createdAt: now });
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
