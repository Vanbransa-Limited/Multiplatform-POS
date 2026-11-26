'use strict';
// Sales that tablets rang between 5 Sep and 7 Nov 2026 and could never upload.
// Default is a read-only dry run. Apply requires the reviewed dry-run hash.
//
// The tablets queued these already paid (or with a waiter's Staff 20%), and
// createSale now refuses both - "print the receipt first", "this staff role
// cannot apply checkout discounts" - so every retry failed and each tablet kept
// publishing them to the board. The M-Pesa money for every paid one reached
// the till's STK records and was never counted in the books.
//
// From each tablet's published copy this records:
//   import   - a paid sale whose M-Pesa payment arrived and is not counted on
//              any other sale: recorded as completed and paid (no stock moved:
//              stock takes since then already reflect it).
//   void     - a duplicate, or money already counted elsewhere: recorded as
//              VOIDED so the tablet's retry is answered and it stops showing.
//   (absent) - unpaid and unexplained: left alone for the owner to decide.
// Every record is marked repairedFromDevice, which makes createSale answer the
// tablet's retry with it (replay.ts); the published copies are removed.
const assert = require('node:assert/strict');
const path = require('node:path');
const { createHash } = require('node:crypto');
const backend = require('node:module').createRequire(path.resolve(__dirname, '../backend/functions/package.json'));
const { initializeApp, applicationDefault } = backend('firebase-admin/app');
const { getFirestore, Timestamp } = backend('firebase-admin/firestore');
const { deterministicId } = require('../backend/functions/lib/shared/identifiers');
const { inclusiveTax } = require('../backend/functions/lib/shared/money');
const { TAX_BASIS_POINTS } = require('../backend/functions/lib/modules/sales/constants');

const tenantId = 'tenant-01';
const archiveId = 'stuck-tablet-sales-20261124';
const actor = `reconciliation:${archiveId}`;

// open_orders id prefix -> decision, reviewed against M-Pesa on 24 Nov.
const IMPORT = {
  '7dae7c82': 'UI5MI4WCO7', // Owner, Mineral Water, 5 Sep (published twice)
  'df36a9c1': 'UINAJ7EEBY', // Wycliffe, Samosa + staff 20%, 23 Sep
  '3e1615a8': 'UIO9X817AI', // Kester, Samosa + staff 20%, 24 Sep
  '8ee827b2': 'UIOPU7AI1O', // Kester, Water, 24 Sep (STK)
  '83af24d3': 'UIPNA7ZE4V', // Stacy, Pork choma + ugali, 25 Sep (STK)
  'deb9080c': 'UJA2S9F772', // Stacy, Coke + staff 20%, 10 Oct (STK)
  'a9317f91': 'UJCG79C5P0', // Judith, Samosa + sausages + staff 20%, 12 Oct
  'd7c2bf25': 'UJCJ39POBB', // Kester, Ugali beef + water + staff 20%, 12 Oct
  '58820568': 'UJC2S9M5PH', // Stacy, Coke + staff 20%, 12 Oct
  '593b132d': 'UJGLAA6SQ9', // Stacy, 16 Oct
  'b8debebb': 'UJHPOAEN3E', // Stacy, Singleton 12, 17 Oct (STK)
  'bc522dd1': 'UJM4706SMU', // Judith, 22 Oct
  '35887b57': 'UJMPGAQY3Y', // Judith, 22 Oct
  'd588581d': 'UJOJ3B81RA', // Tamia, 24 Oct
  'ddfa5e30': 'UJOBPBFDQA', // Stacy, 24 Oct
  'd4f252c1': 'UJUMW02MBZ', // Judith, 30 Oct
  'a0921512': 'UK2GH0ZBEC', // Judith, 2 Nov
  '3231ec78': 'UK7PG0TJDP', // Judith, 7 Nov
  'e2a7de61': 'UK7D00WU1N', // Judith, 7 Nov (STK)
};
const VOID = {
  'e6ad1399': 'Second published copy of the Owner\'s 5 Sep Mineral Water (UI5MI4WCO7).',
  '5ea96971': 'Unpaid copy rung a minute before the paid INV-BH001-869832 (UINAJ7EEBY).',
  'b6036c4d': 'Duplicate of INV-BH001-094220: same items, same M-Pesa UJCG79C5P0.',
  '48eea6bc': 'Duplicate of INV-BH001-094220: same items, same M-Pesa UJCG79C5P0.',
  '4cb207a5': 'KWV Cabernet: M-Pesa UJCG79CJS5 is already counted on a recorded sale.',
  '6640831d': 'Unpaid copy rung two minutes before the paid INV-BH001-015957 (UJC2S9M5PH).',
};
const STAFF_DISCOUNT = /^staff 20% discount$/i;

const stable = value => value?.toMillis ? { timestampMs: value.toMillis() }
  : Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
const fingerprint = value => createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
const key = value => String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');

/** The bill as it was rung: current catalogue lines, 20% where the tablet applied it, checked against what it charged. */
function rebuildLines(order, productsByName) {
  const discounted = order.lines.some(line => STAFF_DISCOUNT.test(line.name));
  const lines = order.lines.filter(line => !STAFF_DISCOUNT.test(line.name)).map(line => {
    const product = productsByName.get(key(line.name));
    assert.ok(product, `${order.ref}: no product named "${line.name}"`);
    return { productId: product.id, productName: product.name, qty: Number(line.qty), unitPriceMinor: Number(product.sellPriceMinor), taxCode: product.taxCode || 'A' };
  });
  const eligible = lines.filter(line => line.productId !== 'prod-table-service');
  const eligibleMinor = eligible.reduce((sum, line) => sum + line.unitPriceMinor * line.qty, 0);
  const discountMinor = discounted ? Math.round(eligibleMinor * 0.2) : 0;
  const grossMinor = lines.reduce((sum, line) => sum + line.unitPriceMinor * line.qty, 0);
  // Prices since then may differ; the tablet's charge is the record. Fit to it.
  const target = order.totalMinor;
  const scale = grossMinor - discountMinor === target ? 1 : null;
  let left = target;
  return {
    priceDrift: scale === null ? `catalogue now gives ${(grossMinor - discountMinor) / 100}, tablet charged ${target / 100}` : null,
    discountMinor: scale === 1 ? discountMinor : Math.max(0, grossMinor - target),
    subtotalMinor: scale === 1 ? grossMinor : Math.max(grossMinor, target),
    lines: lines.map((line, index) => {
      const gross = line.unitPriceMinor * line.qty;
      const lineTotalMinor = index === lines.length - 1 ? left : Math.round(target * (gross / (grossMinor || 1)));
      left -= lineTotalMinor;
      return { ...line, discountMinor: Math.max(0, gross - lineTotalMinor), lineTotalMinor,
        taxMinor: inclusiveTax(lineTotalMinor, TAX_BASIS_POINTS[line.taxCode] ?? 0) };
    }),
  };
}

async function repair(db, { apply = false, expectedHash = null } = {}) {
  const archiveRef = db.doc(`reconciliation_archives/${archiveId}`);
  if ((await archiveRef.get()).exists) return { result: 'already repaired', archiveId };
  const snapshots = (await db.collection('open_orders').where('tenantId', '==', tenantId).get()).docs;
  const byPrefix = prefix => {
    const found = snapshots.filter(doc => doc.id.slice(11, 19) === prefix);
    assert.equal(found.length, 1, `open_orders ${prefix} not found exactly once`);
    return found[0];
  };
  const products = (await db.collection('products').where('tenantId', '==', tenantId).get()).docs.map(doc => ({ id: doc.id, ...doc.data() }));
  const productsByName = new Map(products.map(product => [key(product.name), product]));

  const plan = [];
  const records = {};
  for (const [prefix, receipt] of Object.entries(IMPORT)) {
    const doc = byPrefix(prefix), order = doc.data();
    records[doc.id] = order;
    assert.equal(order.kind, 'sale'); assert.equal(order.saleUuids.length, 1);
    assert.equal(order.payments.length, 1); assert.equal(order.payments[0].method, 'MPESA');
    const paid = order.payments[0];
    assert.equal(paid.amountMinor, order.totalMinor, `${order.ref}: paid differs from total`);
    // The money arrived (STK paid), for this amount, and nothing counts it yet.
    const stk = (await db.collection('mpesa_payments').where(/^ws_CO_/.test(paid.reference) ? 'checkoutRequestId' : 'receipt', '==', paid.reference).get()).docs.map(d => d.data());
    assert.ok(stk.some(row => row.status === 'paid'), `${order.ref}: ${paid.reference} not confirmed paid`);
    if (/^ws_CO_/.test(paid.reference)) assert.equal(stk.find(row => row.status === 'paid').receipt, receipt, `${order.ref}: STK receipt differs`);
    else assert.equal(paid.reference, receipt);
    const used = (await db.collection('payments').where('reference', '==', receipt).get()).docs.filter(d => d.data().status !== 'reversed');
    assert.equal(used.length, 0, `${order.ref}: ${receipt} already counted`);
    const saleId = deterministicId('sale', `${tenantId}:${order.saleUuids[0]}`);
    assert.equal((await db.doc(`sales/${saleId}`).get()).exists, false, `${order.ref}: sale already exists`);
    const bill = rebuildLines(order, productsByName);
    plan.push({ action: 'import', openOrder: doc.id, saleId, saleUuid: order.saleUuids[0], ref: order.ref, staffId: order.staffId,
      openedAt: order.openedAt, paidAt: paid.paidAt || order.openedAt, receipt, totalMinor: order.totalMinor, deviceId: order.deviceId,
      branchId: order.branchId, tableNumber: order.tableNumber || null, ...bill });
  }
  for (const [prefix, reason] of Object.entries(VOID)) {
    const doc = byPrefix(prefix), order = doc.data();
    records[doc.id] = order;
    assert.equal(order.saleUuids.length, 1);
    const saleId = deterministicId('sale', `${tenantId}:${order.saleUuids[0]}`);
    const existing = await db.doc(`sales/${saleId}`).get();
    plan.push({ action: existing.exists ? 'clear-copy' : 'void', openOrder: doc.id, saleId, saleUuid: order.saleUuids[0], ref: order.ref,
      staffId: order.staffId, openedAt: order.openedAt, totalMinor: order.totalMinor, deviceId: order.deviceId, branchId: order.branchId,
      tableNumber: order.tableNumber || null, reason });
  }
  // Two published copies of one sale share its uuid: record it once.
  const seen = new Set();
  for (const step of plan) {
    if (step.action === 'void' && seen.has(step.saleUuid)) step.action = 'clear-copy';
    seen.add(step.saleUuid);
  }
  const untouched = snapshots.filter(doc => !records[doc.id]).map(doc => {
    const o = doc.data();
    return `${o.ref} ${o.paymentStatus} KES ${o.totalMinor / 100} (${String(o.openedAt).slice(0, 10)})`;
  });

  const hash = fingerprint({ records, products: plan.flatMap(step => (step.lines || []).map(line => [line.productId, line.unitPriceMinor])) });
  const summary = {
    imported: plan.filter(s => s.action === 'import').map(s => `${s.ref} KES ${s.totalMinor / 100} ${s.receipt}${s.priceDrift ? ` [${s.priceDrift}]` : ''}`),
    importedTotalKes: plan.filter(s => s.action === 'import').reduce((sum, s) => sum + s.totalMinor, 0) / 100,
    voided: plan.filter(s => s.action === 'void').map(s => `${s.ref} KES ${s.totalMinor / 100} - ${s.reason}`),
    copiesCleared: plan.filter(s => s.action === 'clear-copy').map(s => s.ref),
    leftForOwner: untouched,
  };
  if (!apply) return { result: 'dry run, nothing written', hash, summary };
  assert.equal(expectedHash, hash, 'The records changed since the reviewed dry run.');

  const now = Timestamp.now();
  const when = value => Timestamp.fromDate(new Date(value));
  const batch = db.batch();
  batch.create(archiveRef, { tenantId, records, sourceFingerprint: hash, summary, createdAt: now,
    authorizedBy: 'Owner, 24 Nov 2026 ("repair 2")' });
  for (const step of plan) {
    batch.delete(db.doc(`open_orders/${step.openOrder}`));
    if (step.action === 'clear-copy') continue;
    const base = { id: step.saleId, tenantId, branchId: step.branchId, deviceId: step.deviceId, shiftId: null, staffId: step.staffId,
      customerId: 'cust-walkin', idempotencyKey: step.saleUuid, saleUuid: step.saleUuid, invoiceNumber: step.ref,
      tableNumber: step.tableNumber, orderReference: step.ref, buyerKraPin: null, fiscalStatus: 'NOT_APPLICABLE',
      soldAt: when(step.openedAt), createdAt: now, updatedAt: now, stockBalanceIds: [], stockBalanceSnapshots: [],
      repairedFromDevice: true, repair: { archiveId, openOrderId: step.openOrder } };
    if (step.action === 'void') {
      batch.create(db.doc(`sales/${step.saleId}`), { ...base, status: 'VOIDED', voidedAt: now, voidedByStaffId: actor, voidReason: step.reason,
        subtotalMinor: step.totalMinor, discountMinor: 0, taxMinor: 0, totalMinor: step.totalMinor, lineIds: [], paymentIds: [] });
      continue;
    }
    const lineIds = step.lines.map((_, i) => `${step.saleId}_line_${String(i + 1).padStart(2, '0')}`);
    const paymentId = `${step.saleId}_payment_01`;
    step.lines.forEach((line, i) => batch.create(db.doc(`sale_lines/${lineIds[i]}`), {
      id: lineIds[i], tenantId, saleId: step.saleId, productId: line.productId, productName: line.productName, qty: line.qty,
      unitPriceMinor: line.unitPriceMinor, discountMinor: line.discountMinor, taxCode: line.taxCode, taxMinor: line.taxMinor,
      lineTotalMinor: line.lineTotalMinor, createdAt: now }));
    batch.create(db.doc(`payments/${paymentId}`), { id: paymentId, tenantId, branchId: step.branchId, saleId: step.saleId,
      customerId: 'cust-walkin', method: 'mpesa', amountMinor: step.totalMinor, reference: step.receipt, providerTransactionId: step.receipt,
      status: 'completed', verified: true, source: 'device_repair', paidAt: when(step.paidAt), createdAt: now });
    batch.create(db.doc(`sales/${step.saleId}`), { ...base, status: 'completed', subtotalMinor: step.subtotalMinor,
      discountMinor: step.discountMinor, taxMinor: step.lines.reduce((s, l) => s + l.taxMinor, 0), totalMinor: step.totalMinor,
      lineIds, paymentIds: [paymentId] });
  }
  batch.create(db.doc(`audit_logs/${archiveId}`), { tenantId, actorStaffId: actor, action: 'sale.device_repair', entityType: 'reconciliation',
    entityId: archiveId, metadata: summary, createdAt: now });
  await batch.commit();
  return { result: 'applied', archiveId, hash, summary };
}

async function main() {
  const args = process.argv.slice(2);
  const value = name => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
  if (value('--project') !== 'vanbransa-pos') throw new Error('Explicit --project vanbransa-pos required.');
  const apply = args.includes('--apply');
  if (apply && !value('--expected-hash')) throw new Error('Apply requires the reviewed --expected-hash.');
  const db = getFirestore(initializeApp({ projectId: 'vanbransa-pos', credential: applicationDefault() }));
  console.log(JSON.stringify(await repair(db, { apply, expectedHash: value('--expected-hash') }), null, 2));
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { repair };
