'use strict';
// User-requested Table 50 repair. Dry run by default; exact records only.
const assert = require('node:assert/strict');
const path = require('node:path');
const { createHash } = require('node:crypto');
const backend = require('node:module').createRequire(path.resolve(__dirname, '../backend/functions/package.json'));
const { Timestamp } = backend('firebase-admin/firestore');
const tenantId = 'tenant-01', branchId = 'branch-nai-01';
const canonicalTabId = 'f6755eb4-6b90-444d-9b6a-69d86d07540a';
const reference = 'ORD-50-276837', archiveId = 'table50-consolidation-20261120';
const targets = [
  ['sale-fbb629cf0b9287b90c99b51c56f19e45fdde200407a728c5', 'INV-BH001-002960', 1400000],
  ['sale-aa1564e4ca9c98deef9d86b05f0a4baa9e78760baedec13c', 'INV-BH001-002967', 10000],
  ['sale-7f8f1972ea3948ef2e7a40f656652436f536335e765b160a', 'INV-BH001-002979', 80000],
  ['sale-0c7779f7ac746877e7121f36500c6071f56fab695e3369ff', 'INV-BH001-002980', 70000],
];
const stable = value => value?.toMillis ? { timestampMs: value.toMillis() }
  : Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
const fingerprint = value => createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');

async function consolidateTable(db, { apply = false, expectedHash } = {}) {
  const archiveRef = db.doc(`reconciliation_archives/${archiveId}`);
  return db.runTransaction(async tx => {
    const archive = await tx.get(archiveRef);
    if (archive.exists) return { result: 'already consolidated', reference, totalKES: 15600, archiveId };
    const all = await tx.get(db.collection('sales').where('tenantId', '==', tenantId).where('tableNumber', '==', '50'));
    const records = [], activeIds = [];
    for (const doc of all.docs) {
      const sale = doc.data();
      if (sale.branchId !== branchId || String(sale.status).toUpperCase() === 'VOIDED') continue;
      const ledger = await tx.get(db.collection('payments').where('saleId', '==', doc.id));
      if (!ledger.docs.some(d => d.data().method === 'credit' && !d.data().settledAt)) continue;
      activeIds.push(doc.id);
      const expected = targets.find(([id]) => id === doc.id);
      assert.ok(expected, 'An additional unpaid Table 50 round appeared; review again');
      assert.equal(sale.invoiceNumber, expected[1]); assert.equal(sale.totalMinor, expected[2]);
      assert.equal(sale.staffId, 'staff-6fc10bf06ad622e004f2056af83b1ef72fc1a1b4a0a9f983');
      assert.equal(sale.shiftId, 'shift-5c0946e69016a44fea5ac2831bd69a5ada8fbebf6e4e42ab');
      assert.ok(!sale.etr && !sale.etrReceiptId && !sale.proformaId);
      assert.ok(Number(sale.checkoutExpiresAt?.toMillis?.() || 0) < Date.now(), 'Checkout in progress');
      assert.equal(sale.tabId, doc.id === targets[0][0] ? '26a2af83-e7a5-4053-ae0e-6d554026f41c' : canonicalTabId);
      assert.equal(ledger.size, 1); assert.equal(ledger.docs[0].data().amountMinor, expected[2]);
      const lines = await tx.get(db.collection('sale_lines').where('saleId', '==', doc.id));
      records.push(...[doc, ...ledger.docs, ...lines.docs].map(d => ({ path: d.ref.path, data: d.data() })));
    }
    assert.deepEqual(new Set(activeIds), new Set(targets.map(([id]) => id)));
    records.sort((a, b) => a.path.localeCompare(b.path));
    const sourceFingerprint = fingerprint(records);
    if (apply) {
      assert.equal(sourceFingerprint, expectedHash, 'Records changed after the dry run');
      const now = Timestamp.now();
      tx.create(archiveRef, { tenantId, branchId, records, sourceFingerprint, createdAt: now,
        reason: 'User reported Table 50 split into two tabs and requested one invoice.',
        authorization: 'User request and screenshots, 2026-11-20', canonicalTabId, reference, totalMinor: 1560000 });
      tx.update(db.doc(`sales/${targets[0][0]}`), { tabId: canonicalTabId, orderReference: reference,
        reconciliationId: archiveId, updatedAt: now });
      tx.create(db.doc(`audit_logs/${archiveId}`), { tenantId, branchId, action: 'TABLE_TABS_CONSOLIDATED',
        createdAt: now, canonicalTabId, orderReference: reference, saleIds: activeIds, totalMinor: 1560000,
        reconciliationId: archiveId });
    }
    return { result: apply ? 'consolidated' : 'ready (dry run)', reference, canonicalTabId,
      totalKES: 15600, roundCount: 4, sourceFingerprint, archiveId };
  });
}

async function verifyTable(db) {
  const archive = (await db.doc(`reconciliation_archives/${archiveId}`).get()).data();
  assert.ok(archive);
  let total = 0, qty = 0;
  for (const original of archive.records) {
    const current = (await db.doc(original.path).get()).data();
    const expected = { ...original.data };
    if (original.path === `sales/${targets[0][0]}`) {
      expected.tabId = canonicalTabId; expected.orderReference = reference;
      expected.reconciliationId = archiveId; expected.updatedAt = current.updatedAt;
    }
    assert.equal(fingerprint(current), fingerprint(expected), `Unexpected change: ${original.path}`);
    if (original.path.startsWith('sales/')) {
      assert.equal(current.tabId, canonicalTabId); assert.equal(current.orderReference, reference);
      total += current.totalMinor;
    }
    if (original.path.startsWith('sale_lines/')) qty += current.qty;
  }
  assert.equal(total, 1560000); assert.equal(qty, 15);
  return { verified: true, reference, totalKES: total / 100, items: qty, rounds: 4,
    paymentsAndLinesUnchanged: true, archiveId };
}

async function main() {
  const args = process.argv.slice(2);
  assert.ok(args.includes('--project')); assert.equal(args[args.indexOf('--project') + 1], 'vanbransa-pos');
  assert.ok(!process.env.FIRESTORE_EMULATOR_HOST, 'Production repair cannot use an emulator override');
  const { initializeApp, applicationDefault } = backend('firebase-admin/app');
  const { getFirestore } = backend('firebase-admin/firestore');
  const app = initializeApp({ projectId: 'vanbransa-pos', credential: applicationDefault() });
  try {
    const db = getFirestore(app);
    const result = args.includes('--verify') ? await verifyTable(db) : await consolidateTable(db, {
      apply: args.includes('--apply'), expectedHash: args[args.indexOf('--expected-hash') + 1],
    });
    console.log(JSON.stringify(result, null, 2));
  } finally { await app.delete(); }
}
module.exports = { consolidateTable, verifyTable, targets, tenantId, branchId, canonicalTabId, reference, archiveId };
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
