'use strict';
const assert = require('node:assert/strict');
if (process.env.GCLOUD_PROJECT !== 'demo-tokgut-pos'
  || !/^127\.0\.0\.1:\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST || '')) {
  throw Error('Run only against the local demo-tokgut-pos Firestore emulator.');
}
const { db } = require('../lib/lib/firebase');
const { deterministicId } = require('../lib/shared/identifiers');
const { prepareCheckoutReceipt, confirmCheckoutReceiptPrinted } = require('../lib/modules/sales/checkout-print');
const { claimSalePayment, settleSale } = require('../lib/modules/sales/settle');
const { settleCustomerOrderCash } = require('../lib/modules/customer-orders/payments');
const { PRINT_BEFORE_PAYMENT } = require('../lib/modules/sales/printed-receipt');
// The refusal is only asserted while the owner has print-before-payment on;
// with it off, the queue, confirmation, scope and replay checks still run.
const printGate = call => (PRINT_BEFORE_PAYMENT ? assert.rejects(call(), /Print the receipt/) : undefined);
const tenantId = 'print-checkout-regression', branchId = 'print-checkout-branch';
const auth = { token: { tenant_id: tenantId, staff_id: 'print-cashier', staff_role: 'cashier' } };
const saleId = uuid => deterministicId('sale', `${tenantId}:${uuid}`);
const prepare = (saleUuids, queue = false, extra = {}) => prepareCheckoutReceipt.run({ auth, data: { saleUuids, queue, ...extra } });
const confirm = (jobId, extra = {}) => confirmCheckoutReceiptPrinted.run({ auth, data: { jobId, deviceId: 'print-device', confirmed: true, ...extra } });
const claim = (saleUuids, checkoutId = 'print-checkout') => claimSalePayment.run({ auth, data: { saleUuids, checkoutId, deviceId: 'print-device', method: 'cash' } });
async function rulesCheck(jobId) {
  // The Firestore emulator accepts unsigned emulator ID tokens. No live account
  // or external service is used by these security-rule checks.
  const encoded = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const token = `${encoded({ alg: 'none', typ: 'JWT' })}.${encoded({
    aud: 'demo-tokgut-pos', iss: 'https://securetoken.google.com/demo-tokgut-pos',
    sub: 'print-rules-user', user_id: 'print-rules-user', iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600, ...auth.token,
    firebase: { identities: {}, sign_in_provider: 'custom' },
  })}.`;
  const root = `projects/demo-tokgut-pos/databases/(default)/documents`;
  const commit = writes => fetch(`http://${process.env.FIRESTORE_EMULATOR_HOST}/v1/projects/demo-tokgut-pos/databases/(default)/documents:commit`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ writes }),
  });
  const fields = { id: { stringValue: 'rules-generic' }, tenantId: { stringValue: tenantId }, branchId: { stringValue: branchId },
    status: { stringValue: 'queued' }, createdByStaffId: { stringValue: auth.token.staff_id },
    widthClass: { stringValue: 'receipt-paper-58' }, receipt: { mapValue: { fields: {} } } };
  const create = (id, values) => ({ update: { name: `${root}/print_jobs/${id}`, fields: values },
    updateTransforms: [{ fieldPath: 'createdAt', setToServerValue: 'REQUEST_TIME' }] });
  assert.equal((await commit([create('rules-generic', fields)])).status, 200, 'ordinary queue creation still works');
  assert.equal((await commit([create('rules-forged', { ...fields, id: { stringValue: 'rules-forged' }, checkoutReceipt: { mapValue: { fields: {} } } })])).status, 403);
  assert.equal((await commit([{ update: { name: `${root}/print_jobs/${jobId}`, fields: { status: { stringValue: 'printed' }, printedByDeviceId: { stringValue: 'print-device' } } },
    updateMask: { fieldPaths: ['status', 'printedByDeviceId'] }, updateTransforms: [{ fieldPath: 'printedAt', setToServerValue: 'REQUEST_TIME' }] }])).status, 403);
  assert.equal((await commit([{ update: { name: `${root}/sales/${saleId('first')}`, fields: { printedReceipt: { mapValue: { fields: {} } } } },
    updateMask: { fieldPaths: ['printedReceipt'] } }])).status, 403);
}
async function seed(uuid, extra = {}) {
  const id = saleId(uuid);
  const batch = db.batch();
  batch.set(db.doc(`sales/${id}`), { tenantId, branchId, invoiceNumber: `INV-${uuid}`, status: 'completed',
    subtotalMinor: 10000, totalMinor: 10000, taxMinor: 0, ...extra });
  batch.set(db.doc(`sale_lines/${id}_line_01`), { saleId: id, tenantId, productId: 'print-item', productName: 'Printed item',
    qty: 1, unitPriceMinor: 10000, lineTotalMinor: 10000 });
  batch.set(db.doc(`payments/${id}_credit`), { saleId: id, tenantId, method: 'credit', amountMinor: 10000 });
  await batch.commit();
}
async function main() {
  await Promise.all([
    db.doc(`tenants/${tenantId}`).set({ status: 'active', tradingName: 'Print test' }),
    db.doc(`branches/${branchId}`).set({ tenantId, status: 'active', name: 'Counter' }),
    db.doc('devices/print-device').set({ tenantId, branchId, status: 'active' }),
    db.doc('devices/print-foreign-device').set({ tenantId: 'another-business', branchId, status: 'active' }),
    db.doc(`tenant_settings/${tenantId}`).set({ acceptedPaymentMethods: ['cash', 'mpesa', 'card', 'bank_transfer'] }),
    seed('first'), seed('second'),
  ]);
  assert.deepEqual(await prepare(['first']), { printed: false, queued: false });
  for (const method of ['cash', 'card', 'bank_transfer', 'mpesa']) {
    await printGate(() => settleSale.run({ auth, data: { saleUuid: 'first', requestId: method, method, reference: 'PRINT00001' } }));
  }
  await printGate(() => claim(['first']));
  const jobs = await Promise.all(Array.from({ length: 4 }, () => prepare(['first', 'second'], true,
    { receipt: { invoiceNo: 'FORGED', grandTotal: 0 } })));
  assert.ok(jobs.every(job => job.jobId === jobs[0].jobId));
  const jobId = jobs[0].jobId;
  await rulesCheck(jobId);
  const job = (await db.doc(`print_jobs/${jobId}`).get()).data();
  assert.equal(job.receipt.grandTotal, 200);
  assert.equal(job.receipt.unpaid, true);
  assert.notEqual(job.receipt.invoiceNo, 'FORGED');
  assert.equal((await prepare(['first', 'second'])).queued, true);
  await printGate(() => claim(['first', 'second']));
  await assert.rejects(confirm(jobId, { confirmed: false }), /Confirm the receipt/);
  await assert.rejects(confirm(jobId, { deviceId: 'print-foreign-device' }), /active print station/);
  const foreign = { token: { ...auth.token, tenant_id: 'another-business' } };
  await assert.rejects(confirmCheckoutReceiptPrinted.run({ auth: foreign, data: { jobId, deviceId: 'print-device', confirmed: true } }), /Receipt not found/);
  await assert.rejects(prepareCheckoutReceipt.run({ auth: foreign, data: { saleUuids: ['first'], queue: true } }), /unavailable/);
  await db.doc('print_jobs/generic-job').set({ tenantId, branchId, status: 'printed', receipt: job.receipt });
  await assert.rejects(confirm('generic-job'), /Receipt not found/);
  await Promise.all([confirm(jobId), confirm(jobId)]);
  assert.equal((await prepare(['first', 'second'])).printed, true);
  const proof = (await db.doc(`sales/${saleId('first')}`).get()).data().printedReceipt;
  assert.equal(proof.confirmedByStaffId, auth.token.staff_id);
  assert.equal(proof.deviceId, 'print-device');
  assert.equal((await claim(['first', 'second'])).dueMinor, 20000);
  const paid = await settleSale.run({ auth, data: { saleUuid: 'first', requestId: 'paid', checkoutId: 'print-checkout', method: 'cash' } });
  assert.equal(paid.settledMinor, 10000);
  assert.deepEqual(await settleSale.run({ auth, data: { saleUuid: 'first', requestId: 'paid', checkoutId: 'print-checkout', method: 'cash' } }), paid);

  // Even a same-price item edit requires the new paper, on every till.
  await db.doc(`sale_lines/${saleId('second')}_line_01`).update({ productName: 'Changed item' });
  assert.equal((await prepare(['second'])).printed, false);
  await printGate(() => claim(['second']));
  const changed = await prepare(['second'], true);
  await db.doc(`sale_lines/${saleId('second')}_line_01`).update({ qty: 2 });
  await assert.rejects(confirm(changed.jobId), /bill changed/);
  const latest = await prepare(['second'], true);
  assert.notEqual(latest.jobId, changed.jobId);
  await confirm(latest.jobId);
  assert.equal((await prepare(['second'])).printed, true);
  await seed('new-round');
  await printGate(() => claim(['second', 'new-round']));

  // Menu checkout shares the gate; a kitchen ticket's print count is insufficient.
  await db.doc('customer_orders/print-menu').set({ tenantId, branchId, ref: 'WEB-PRINT', totalMinor: 10000,
    status: 'received', paymentStatus: 'unpaid', printCount: 5,
    lines: [{ productId: 'print-item', name: 'Menu item', qty: 1, unitPriceMinor: 10000, totalMinor: 10000 }] });
  await printGate(() => settleCustomerOrderCash.run({ auth, data: { orderId: 'print-menu' } }));
  const menu = await prepareCheckoutReceipt.run({ auth, data: { customerOrderId: 'print-menu', queue: true } });
  await confirm(menu.jobId);
  assert.equal((await settleCustomerOrderCash.run({ auth, data: { orderId: 'print-menu' } })).paymentStatus, 'paid');
  await seed('inactive', { branchId: 'inactive-print-branch' });
  await db.doc('branches/inactive-print-branch').set({ tenantId, status: 'inactive' });
  await assert.rejects(prepare(['inactive'], true), /branch is unavailable/);
  console.log('Checkout print emulator checks passed: queue deduplication, paper confirmation, tenant scope, edited bills, new rounds, payment replay and menu checkout.');
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => db.terminate());
