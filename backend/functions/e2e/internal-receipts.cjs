'use strict';
// Real Firestore contention and replay checks; never seed or pay production bills.
const assert = require('node:assert/strict');
if (process.env.GCLOUD_PROJECT !== 'demo-tokgut-pos'
  || !/^127\.0\.0\.1:\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST || '')) {
  throw Error('Run only against the local demo-tokgut-pos Firestore emulator.');
}
const { db } = require('../lib/lib/firebase');
const { Timestamp } = require('firebase-admin/firestore');
const { settleSale } = require('../lib/modules/sales/settle');
const { lookupMpesaReceipt } = require('../lib/modules/sales/receipt-balance');
const { deterministicId } = require('../lib/shared/identifiers');
const { standardReceiptPolicy } = require('../lib/shared/receipt-policy');
const { printedBill } = require('../test/fixtures/printed-bill.cjs');
const tenantId = 'internal-receipt-regression', branchId = 'receipt-branch';
const controlRef = db.doc(`mpesa_receipt_controls/${tenantId}`);
const auth = staff => ({ token: { tenant_id: tenantId, staff_id: staff, staff_role: 'cashier' } });
const saleId = uuid => deterministicId('sale', `${tenantId}:${uuid}`);
const claimRef = code => db.doc(`payment_receipt_claims/${deterministicId('mpesa-receipt', `${tenantId}:${code}`)}`);
const settle = (uuid, reference, receiptAmountMinor, amountMinor, requestId = uuid, staff = uuid) => settleSale.run({ auth: auth(staff),
  data: { saleUuid: uuid, reference, receiptAmountMinor, amountMinor, requestId, method: 'mpesa' } });
const preview = (reference, receiptAmountMinor) => lookupMpesaReceipt.run({ auth: auth('reader'), data: { branchId, reference, receiptAmountMinor } });
async function seedSale(uuid, amountMinor) {
  const batch = db.batch();
  batch.set(db.doc(`sales/${saleId(uuid)}`), printedBill({ tenantId, branchId, totalMinor: amountMinor, status: 'COMPLETED' }));
  batch.set(db.doc(`payments/receipt-credit-${uuid}`), { tenantId, saleId: saleId(uuid), method: 'credit', amountMinor });
  await batch.commit();
}
async function main() {
  await controlRef.set({ tenantId, mode: 'internal', duration: 'ongoing', policyVersion: 1, until: null,
    branchIds: [branchId], authorizationId: 'emulator-authorization' });
  await db.doc('stock_balances/receipt-stock-sentinel').set({ tenantId, qty: 17 });

  await seedSale('replay', 40000);
  const before = await preview('REPLAY0001', 100000);
  assert.equal(before.availableMinor, 100000);
  assert.equal((await claimRef('REPLAY0001').get()).exists, false);
  const replays = await Promise.all(Array.from({ length: 4 }, () => settle('replay', 'REPLAY0001', 100000, 40000, 'lost-response', 'one-cashier')));
  assert.ok(replays.every(result => result.paymentId === replays[0].paymentId));
  assert.equal((await claimRef('REPLAY0001').get()).data().allocatedMinor, 40000);
  // Simulate a committed response lost on the connection, then replay exactly it.
  await assert.rejects((async () => { await settle('replay', 'REPLAY0001', 100000, 40000, 'lost-response', 'one-cashier'); throw Error('connection lost'); })(), /connection lost/);
  assert.deepEqual(await settle('replay', 'REPLAY0001', 100000, 40000, 'lost-response', 'one-cashier'), replays[0]);
  console.log('PASS: simultaneous identical requests and lost responses produce one payment');

  await Promise.all(Array.from({ length: 8 }, (_, index) => seedSale(`race-${index}`, 40000)));
  const competing = await Promise.allSettled(Array.from({ length: 8 }, (_, index) => settle(`race-${index}`, 'RACECODE01', 100000, 40000)));
  const accepted = competing.filter(row => row.status === 'fulfilled');
  assert.equal(accepted.length, 2);
  for (const row of competing.filter(row => row.status === 'rejected')) {
    assert.match(row.reason.message, /balance or bill amount changed/);
  }
  assert.equal((await preview('RACECODE01')).availableMinor, 20000);
  await seedSale('race-last', 50000);
  await settle('race-last', 'RACECODE01', 100000, 20000);
  assert.equal((await preview('RACECODE01')).availableMinor, 0);
  await assert.rejects(settle('race-last', 'RACECODE01', 100000, 1, 'overspend'), /no unallocated money/);
  const raceLedger = await db.collection('payments').where('reference', '==', 'RACECODE01').get();
  assert.equal(raceLedger.docs.reduce((sum, doc) => sum + doc.data().amountMinor, 0), 100000);
  console.log('PASS: eight tills competing for one receipt never overspend its total');

  await Promise.all([seedSale('different-a', 10000), seedSale('different-b', 10000)]);
  const amounts = await Promise.allSettled([settle('different-a', 'IMMUTABLE1', 95000, 10000), settle('different-b', 'IMMUTABLE1', 170000, 10000)]);
  assert.equal(amounts.filter(row => row.status === 'fulfilled').length, 1);
  assert.match(amounts.find(row => row.status === 'rejected').reason.message, /cannot be changed/);
  const immutable = (await claimRef('IMMUTABLE1').get()).data();
  assert.equal(immutable.allocatedMinor, 10000);
  assert.ok([95000, 170000].includes(immutable.limitMinor));
  assert.equal(immutable.entryAuthorizationId, 'emulator-authorization');
  console.log('PASS: conflicting amounts cannot change the first committed receipt total');

  await seedSale('split', 100000);
  await settle('split', 'SPLIT00400', 40000, 40000, 'split-400');
  const split = await settle('split', 'SPLIT00600', 60000, 60000, 'split-600');
  assert.equal(split.outstandingMinor, 0);
  await db.doc(`mpesa_c2b_events/${deterministicId('c2b', 'confirmation:SPLIT00400')}`).set({ tenantId, branchIds: [branchId], payload: { amountMinor: 40000 } });
  const late = await preview('SPLIT00400');
  assert.equal(late.availableMinor, 0); assert.equal(late.verified, true);
  console.log('PASS: two receipts pay one bill and a late provider confirmation creates no extra balance');

  await controlRef.update({ mode: 'provider' });
  await assert.rejects(preview('UNSEEN0001', 10000), /No confirmed/);
  assert.equal((await preview('REPLAY0001')).availableMinor, 60000);
  await seedSale('after-switch', 10000);
  await settle('after-switch', 'REPLAY0001', 100000, 10000);
  const preserved = (await claimRef('REPLAY0001').get()).data();
  assert.equal(preserved.entryAuthorizationId, 'emulator-authorization'); assert.equal(preserved.verified, false);
  await controlRef.set({ tenantId, mode: 'internal', branchIds: [branchId], until: Timestamp.fromMillis(Date.now() - 1000) });
  await seedSale('expired', 10000);
  await assert.rejects(settle('expired', 'EXPIRED001', 10000, 10000), /No confirmed/);
  assert.equal((await claimRef('EXPIRED001').get()).exists, false);
  await controlRef.set({ tenantId, mode: 'internal', duration: 'ongoing', policyVersion: 1, until: null,
    branchIds: [branchId], authorizationId: 'emulator-code-only', entryMode: 'recorded_only' });
  await assert.rejects(preview('UNSEEN0001'), /No saved M-Pesa payment/);
  await assert.rejects(preview('UNSEEN0001', 10000), /No saved M-Pesa payment/);
  await assert.rejects(settle('expired', 'UNSEEN0001', 10000, 10000), /No saved M-Pesa payment/);
  await seedSale('code-only', 50000);
  const codeOnly = await settle('code-only', 'REPLAY0001', undefined, 50000);
  assert.equal(codeOnly.availableMinor, 0);
  await assert.rejects(settle('expired', 'REPLAY0001', undefined, 1), /no unallocated money/);
  assert.equal((await claimRef('UNSEEN0001').get()).exists, false);
  console.log('PASS: code-only checkout rejects new amounts and spends saved balances only once');
  await db.doc(`branches/${branchId}`).set({ tenantId, status: 'active' });
  await db.doc('branches/receipt-future-branch').set({ tenantId, status: 'active' });
  await db.doc('branches/receipt-foreign-branch').set({ tenantId: 'receipt-other-business', status: 'active' });
  await controlRef.set(standardReceiptPolicy(tenantId, [branchId], 'shared-standard-audit'));
  await db.doc('payments/receipt-foreign-ledger').set({ tenantId: 'receipt-other-business', method: 'mpesa', reference: 'FOREIGN001', amountMinor: 44400, status: 'completed' });
  await assert.rejects(preview('FOREIGN001', 44400), /another business/);
  await assert.rejects(lookupMpesaReceipt.run({ auth: auth('reader'), data: { branchId: 'receipt-foreign-branch', reference: 'REPLAY0001' } }), /branch is unavailable/);
  await assert.rejects(lookupMpesaReceipt.run({ auth: auth('reader'), data: { branchId: 'receipt-future-branch', reference: 'UNSEEN0001' } }), /Enter the amount/);
  assert.equal((await preview('REPLAY0001')).availableMinor, 0);
  console.log('PASS: shared standard covers future own branches without exposing another business payment or branch');

  // Restored manual entry needs no preview or provider call. All destinations
  // share one immutable receipt total and spend only its remaining balance.
  const { payProforma } = require('../lib/modules/proformas');
  const { settleCustomerOrderByCode } = require('../lib/modules/customer-orders/payments');
  await db.doc(`tenant_settings/${tenantId}`).set({ acceptedPaymentMethods: ['mpesa'] });
  await seedSale('manual-new', 50000);
  const manual = await settle('manual-new', 'MANUAL1700', 170000, undefined);
  assert.equal(manual.settledMinor, 50000); assert.equal(manual.availableMinor, 120000); assert.equal(manual.verified, false);
  await db.doc('proformas/manual-invoice').set({ tenantId, branchId, paymentStatus: 'unpaid', invoice: { dueMinor: 70000 } });
  await payProforma.run({ auth: auth('reader'), data: { proformaId: 'manual-invoice', method: 'mpesa', reference: 'MANUAL1700', receiptAmountMinor: 170000 } });
  await db.doc('customer_orders/manual-menu').set(printedBill({ tenantId, branchId, totalMinor: 50000, paymentStatus: 'unpaid', status: 'received', ref: 'WEB-MANUAL' }));
  await settleCustomerOrderByCode.run({ auth: auth('reader'), data: { orderId: 'manual-menu', code: 'MANUAL1700', receiptAmountMinor: 170000 } });
  const saved = (await claimRef('MANUAL1700').get()).data();
  assert.equal(saved.limitMinor, 170000); assert.equal(saved.allocatedMinor, 170000); assert.equal(saved.verified, false);
  assert.equal(saved.recordedByStaffId, 'manual-new');
  assert.equal(saved.targets.length, 3);
  await seedSale('manual-spent', 10000);
  await assert.rejects(settle('manual-spent', 'MANUAL1700', 170000, undefined), /no unallocated money/);
  await assert.rejects(settle('manual-spent', 'MANUAL1700', 999999, undefined), /cannot be changed/);
  assert.equal((await db.doc('proformas/manual-invoice').get()).data().paymentStatus, 'paid');
  assert.equal((await db.doc('customer_orders/manual-menu').get()).data().paymentStatus, 'paid');
  console.log('PASS: manual code and amount, without a lookup, clear a sale, invoice and customer order; receipt total stays fixed and exhausted code is blocked');
  await assert.rejects(lookupMpesaReceipt.run({ auth: { token: { tenant_id: tenantId, staff_id: 'customer', staff_role: 'customer' } }, data: { branchId, reference: 'REPLAY0001' } }), /Sign in/);
  assert.equal((await db.doc('stock_balances/receipt-stock-sentinel').get()).data().qty, 17);
  const ledger = await db.collection('payments').where('tenantId', '==', tenantId).get();
  const settlementRows = ledger.docs.filter(doc => doc.data().source === 'sale_settlement');
  const audits = await db.collection('audit_logs').where('tenantId', '==', tenantId).get();
  const saleAudits = audits.docs.filter(doc => doc.data().action === 'sale.settled');
  assert.equal(saleAudits.length, settlementRows.length);
  assert.ok(saleAudits.every(doc => doc.data().metadata.paymentId && doc.data().metadata.requestId));
  console.log('PASS: policy switch, expiry, permissions, audit completeness and unchanged stock');

  // Historical imports index previously applied money, never new spendable funds.
  const { importHistory } = require('../../../scripts/import-mpesa-history.cjs');
  const historyTenant = 'receipt-history-import-test', historyBranch = 'history-branch';
  await db.doc(`tenants/${historyTenant}`).set({ status: 'active' });
  await db.doc(`branches/${historyBranch}`).set({ tenantId: historyTenant, status: 'active' });
  await db.doc(`mpesa_receipt_controls/${historyTenant}`).set(standardReceiptPolicy(historyTenant, [historyBranch], 'history-onboarding'));
  await db.doc('payments/history-paid-1').set({ tenantId: historyTenant, branchId: historyBranch, saleId: 'old-sale',
    method: 'mpesa', status: 'completed', amountMinor: 25000, reference: 'HISTORY001', paidAt: Timestamp.fromMillis(1234000) });
  await db.doc('payments/history-paid-2').set({ tenantId: historyTenant, branchId: historyBranch, saleId: 'other-old-sale',
    method: 'mpesa', status: 'completed', amountMinor: 25000, reference: 'HISTORY002' });
  const existingHistoryRef = db.doc(`payment_receipt_claims/${deterministicId('mpesa-receipt', `${historyTenant}:HISTORY002`)}`);
  const existingHistory = { tenantId: historyTenant, branchId: historyBranch, reference: 'HISTORY002',
    amountSource: 'staff_recorded_receipt', recordedByStaffId: 'original-recorder', limitMinor: 50000, allocatedMinor: 25000, verified: false };
  await existingHistoryRef.set(existingHistory);
  await db.doc('payments/history-open-credit').set({ tenantId: historyTenant, saleId: 'still-unpaid', method: 'credit', amountMinor: 25000 });
  await db.doc('payments/history-invalid-code').set({ tenantId: historyTenant, method: 'mpesa', status: 'completed', reference: 'BADREF123', amountMinor: 10000 });
  const sourceBefore = (await db.collection('payments').where('tenantId', '==', historyTenant).get()).docs.map(doc => ({ id: doc.id, ...doc.data() }));
  const previewImport = await importHistory(db, historyTenant);
  assert.equal(previewImport.importedReferences, 1); assert.equal(previewImport.existingReferences, 1);
  assert.equal(previewImport.skippedRows, 1);
  const importResults = await Promise.all([importHistory(db, historyTenant, { apply: true, expectedHash: previewImport.fingerprint }),
    importHistory(db, historyTenant, { apply: true, expectedHash: previewImport.fingerprint })]);
  assert.equal(importResults.filter(row => row.result === 'imported').length, 1);
  assert.equal(importResults.filter(row => row.result === 'already imported').length, 1);
  assert.deepEqual((await existingHistoryRef.get()).data(), existingHistory);
  const sourceAfter = (await db.collection('payments').where('tenantId', '==', historyTenant).get()).docs.map(doc => ({ id: doc.id, ...doc.data() }));
  assert.deepEqual(sourceAfter, sourceBefore);
  const historyAuth = { token: { tenant_id: historyTenant, staff_id: 'reader', staff_role: 'cashier' } };
  const historyLookup = reference => lookupMpesaReceipt.run({ auth: historyAuth, data: { branchId: historyBranch, reference } });
  assert.equal((await historyLookup('HISTORY001')).availableMinor, 0);
  assert.equal((await historyLookup('HISTORY002')).availableMinor, 25000);
  await assert.rejects(historyLookup('UKLC82RLYH'), /Enter the amount/);
  const importedClaim = (await db.doc(`payment_receipt_claims/${deterministicId('mpesa-receipt', `${historyTenant}:HISTORY001`)}`).get()).data();
  assert.equal(importedClaim.paidAt.toMillis(), 1234000); assert.equal(importedClaim.verified, false);
  console.log('PASS: audited historical import and concurrent replay preserve sources, existing balances and unpaid bills; unknown code remains rejected');
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => db.terminate());
