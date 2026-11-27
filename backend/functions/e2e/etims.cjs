'use strict';
const assert = require('node:assert/strict');
if (Number(process.versions.node.split('.')[0]) !== 22 || process.env.GCLOUD_PROJECT !== 'demo-tokgut-pos'
  || !/^127\.0\.0\.1:\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST || '')) {
  throw Error('Run with Node 22 against the local demo-tokgut-pos Firestore emulator only.');
}
const { db } = require('../lib/lib/firebase');
const { Timestamp } = require('firebase-admin/firestore');
const { generateEtr, setupEtims } = require('../lib/modules/etims');

const T = 'etims-test-tenant', B = 'etims-test-branch', S = 'etims-test-owner';
const auth = { uid: S, token: { tenant_id: T, staff_id: S, staff_role: 'owner' } };
const devicePath = `etims_devices/${T}_${B}`;
const pin = 'P051234567A';
const evidence = { curRcptNo: '1', totRcptNo: '1', intrlData: 'EAHSAV6ECUUXSY6PCCJYAUP6MI', rcptSign: 'QUII27MATATSHFRB', sdcDateTime: '20261127120000' };
const success = () => ({ resultCd: '000', resultMsg: 'Success', data: evidence });
let requests = [], responder = async () => success();
const originalFetch = global.fetch;

// All KRA calls are intercepted. Firebase still uses the real demo emulator.
global.fetch = async (url, options) => {
  assert.match(String(url), /^https:\/\/etims-api(?:-sbx)?\.kra\.go\.ke\/etims-api\//);
  const request = { path: new URL(url).pathname, body: JSON.parse(options.body), raw: options.body };
  requests.push(request);
  const reply = request.path.endsWith('/selectInitOsdcInfo')
    ? { resultCd: '000', data: { info: { cmcKey: 'test-only-key', sdcId: 'test-scu', mrcNo: 'test-mrc' } } }
    : request.path.endsWith('/saveItem') ? { resultCd: '000' } : await responder(request);
  return new Response(JSON.stringify(reply));
};
const write = (path, data) => db.doc(path).set(data);
const invoke = (saleIds, buyerPin) => generateEtr.run({ auth, data: { saleIds, buyerPin } });
const salesRequests = () => requests.filter(r => r.path.endsWith('/saveTrnsSalesOsdc'));
const setup = (extra = {}) => setupEtims.run({ auth, data: {
  branchId: B, tin: pin, bhfId: '00', deviceSerial: 'test-serial', environment: 'sandbox', defaultItemClassCode: '5059690800', ...extra,
} });

async function seedSale(id) {
  const lineId = `${id}-line`, productId = `${id}-product`;
  await write(`products/${productId}`, { tenantId: T, name: 'Test meal', taxCode: 'A', sellPriceMinor: 11600, itemClassCode: '5059690800' });
  await write(`sale_lines/${lineId}`, { tenantId: T, saleId: id, productId, productName: 'Test meal', qty: 1,
    unitPriceMinor: 11600, discountMinor: 0, taxCode: 'A', taxMinor: 1600, lineTotalMinor: 11600 });
  await write(`sales/${id}`, { tenantId: T, branchId: B, status: 'completed', soldAt: Timestamp.now(), lineIds: [lineId],
    totalMinor: 11600, fiscalStatus: 'pending', invoiceNumber: id });
  await write(`payments/${id}-payment`, { tenantId: T, saleId: id, method: 'mpesa', amountMinor: 11600, status: 'completed', verified: false });
}

async function main() {
  // Dedicated IDs make this safe to repeat without deleting unrelated fixtures.
  for (const collection of ['etims_receipts', 'etims_items', 'etims_counters', 'audit_logs']) {
    const rows = await db.collection(collection).where('tenantId', '==', T).get();
    for (const row of rows.docs) await row.ref.delete();
  }
  await db.doc(devicePath).delete();
  await write(`tenants/${T}`, { status: 'active' });
  await write(`branches/${B}`, { tenantId: T, status: 'inactive' });
  await write(`staff/${S}`, { tenantId: T, status: 'active', role: 'owner' });
  await assert.rejects(setup(), /not active/);
  assert.equal(requests.length, 0);
  await write(`branches/${B}`, { tenantId: 'another-tenant', status: 'active' });
  await assert.rejects(setup(), /not active/);
  assert.equal(requests.length, 0);
  await write(`branches/${B}`, { tenantId: T, status: 'active' });
  await assert.rejects(setup({ environment: 'typo' }), /sandbox or production/);
  await setup();
  let audit = await db.collection('audit_logs').where('tenantId', '==', T).get();
  assert.equal(audit.size, 1);
  assert.equal(audit.docs[0].data().action, 'etims.device_connected');
  assert.equal(JSON.stringify(audit.docs[0].data()).includes('test-only-key'), false);

  // Environment switching preserves each identity's next numbers.
  await db.doc(devicePath).update({ nextInvcNo: 8, nextItemSeq: 9 });
  await setup({ environment: 'production' }); // intercepted; no production network request
  assert.equal((await db.doc(devicePath).get()).data().nextInvcNo, 1);
  await setup();
  assert.equal((await db.doc(devicePath).get()).data().nextInvcNo, 8);
  assert.equal((await db.doc(devicePath).get()).data().nextItemSeq, 9);

  await seedSale('inactive-staff');
  await db.doc(`staff/${S}`).update({ status: 'inactive' });
  let before = requests.length;
  await assert.rejects(invoke(['inactive-staff']), /not active/);
  assert.equal(requests.length, before);
  await db.doc(`staff/${S}`).update({ status: 'active', role: 'viewer' });
  await assert.rejects(invoke(['inactive-staff']), /Sign in to settle/);
  assert.equal(requests.length, before);
  await db.doc(`staff/${S}`).update({ role: 'owner' });
  await seedSale('unpaid-bill');
  await db.doc('payments/unpaid-bill-payment').update({ method: 'credit' });
  await assert.rejects(invoke(['unpaid-bill']), /Take payment first/);
  assert.equal(requests.length, before);
  await seedSale('foreign-device');
  await db.doc(devicePath).update({ tenantId: 'another-tenant' });
  await assert.rejects(invoke(['foreign-device']), /not connected/);
  assert.equal(requests.length, before);
  await assert.rejects(setup(), /administrator review/);
  assert.equal((await db.doc(devicePath).get()).data().tenantId, 'another-tenant');
  await db.doc(devicePath).update({ tenantId: T });

  for (const [name, collection, changes] of [
    ['foreign-line', 'sale_lines', { tenantId: 'another-tenant' }],
    ['foreign-product', 'products', { tenantId: 'another-tenant' }],
    ['foreign-payment', 'payments', { tenantId: 'another-tenant' }],
    ['conflicted-payment', 'payments', { status: 'receipt_conflict' }],
  ]) {
    await seedSale(name);
    const suffix = collection === 'sale_lines' ? 'line' : collection === 'products' ? 'product' : 'payment';
    await db.doc(`${collection}/${name}-${suffix}`).update(changes);
    const before = requests.length;
    await assert.rejects(invoke([name]), /review|unavailable/i);
    assert.equal(requests.length, before);
  }

  // Overlapping bills are serialized by Firestore, not by an in-memory mock.
  await seedSale('overlap-one'); await seedSale('overlap-two');
  requests = [];
  const attempts = await Promise.allSettled([invoke(['overlap-one']), invoke(['overlap-one', 'overlap-two'])]);
  assert.equal(attempts.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(salesRequests().length, 1);
  const overlap = (await db.doc('sales/overlap-one').get()).data();
  assert.equal(overlap.fiscalStatus, 'fiscalized');
  assert.equal((await db.doc('payments/overlap-one-payment').get()).data().verified, false);
  const receipt = (await db.doc(`etims_receipts/${overlap.etrReceiptId}`).get()).data();
  const beforeReplay = requests.length;
  assert.equal((await invoke(receipt.saleIds)).rcptSign, evidence.rcptSign);
  assert.equal(requests.length, beforeReplay);

  // Missing signature is uncertain; a retry retains the original invoice and buyer.
  await seedSale('incomplete-reply'); requests = [];
  responder = async () => ({ resultCd: '000', data: {} });
  await assert.rejects(invoke(['incomplete-reply'], 'A123456789Z'), /confirmation is pending/);
  const pendingSale = (await db.doc('sales/incomplete-reply').get()).data();
  assert.equal(pendingSale.fiscalStatus, 'pending');
  assert.equal(pendingSale.etr, undefined);
  assert.equal((await db.doc(`etims_receipts/${pendingSale.etrReceiptId}`).get()).data().status, 'uncertain');
  responder = async () => success();
  await invoke(['incomplete-reply'], 'P051234567A');
  assert.equal(salesRequests()[0].raw, salesRequests()[1].raw);
  assert.equal((await db.doc('sales/incomplete-reply').get()).data().etr.buyerPin, 'A123456789Z');

  // Even a refusal cannot make the same invoice number acquire different details.
  await seedSale('rejected-reply'); requests = [];
  responder = async () => ({ resultCd: '910', resultMsg: 'Parameter error' });
  await assert.rejects(invoke(['rejected-reply'], 'A123456789Z'), /910/);
  responder = async () => success();
  await invoke(['rejected-reply'], 'P051234567A');
  assert.equal(salesRequests()[0].raw, salesRequests()[1].raw);

  // A duplicate acknowledgement supplies no signature: retain the invoice for review.
  await seedSale('duplicate-reply'); requests = [];
  responder = async () => { throw Error('connection interrupted'); };
  await assert.rejects(invoke(['duplicate-reply']), /confirmation is pending/);
  responder = async () => ({ resultCd: '994', resultMsg: 'Overlapped data' });
  await assert.rejects(invoke(['duplicate-reply']), /994/);
  const duplicate = (await db.doc('sales/duplicate-reply').get()).data();
  assert.equal((await db.doc(`etims_receipts/${duplicate.etrReceiptId}`).get()).data().status, 'needs_reconciliation');
  const count = salesRequests().length;
  await assert.rejects(invoke(['duplicate-reply']), /needs review/);
  assert.equal(salesRequests().length, count);
  assert.equal(duplicate.etr, undefined);

  // A late response from an expired lease cannot undo a newer signed result.
  await seedSale('late-reply'); requests = [];
  let releaseFirst, markStarted;
  const started = new Promise(resolve => { markStarted = resolve; });
  const held = new Promise(resolve => { releaseFirst = resolve; });
  responder = async () => {
    if (salesRequests().length === 1) { markStarted(); await held; return { resultCd: '999', resultMsg: 'Late failure' }; }
    return success();
  };
  const first = invoke(['late-reply']);
  await started;
  const lateSale = (await db.doc('sales/late-reply').get()).data();
  await db.doc(`etims_receipts/${lateSale.etrReceiptId}`).update({ leaseUntil: Timestamp.fromMillis(0) });
  await invoke(['late-reply']);
  releaseFirst();
  assert.equal((await first).rcptSign, evidence.rcptSign);
  assert.equal((await db.doc(`etims_receipts/${lateSale.etrReceiptId}`).get()).data().status, 'signed');
  audit = await db.collection('audit_logs').where('entityId', '==', lateSale.etrReceiptId).get();
  assert.equal(audit.size, 1);
  console.log(JSON.stringify({ etims: 'passed', realFirestoreConcurrency: true, tenantIsolation: true,
    immutableRetries: true, fiscalEvidenceRequired: true, lateResponsesFenced: true, kraNetworkCalls: 0 }));
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => { global.fetch = originalFetch; });
