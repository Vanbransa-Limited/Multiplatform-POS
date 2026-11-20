'use strict';

// Real Firestore transactions, restricted to a local demo emulator.
const assert = require('node:assert/strict');
const project = process.env.GCLOUD_PROJECT;
if (project !== 'demo-tokgut-pos' || !/^127\.0\.0\.1:\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST || '')) {
  throw new Error('Run only against the local demo-tokgut-pos Firestore emulator.');
}
const { db } = require('../lib/lib/firebase');
const { changeStock, decideStockRequest } = require('../lib/modules/stock');
const auth = role => ({ token: { tenant_id: 'stock-regression', staff_id: role, staff_role: role } });
const change = (role, data) => changeStock.run({ auth: auth(role), data: { branchId: 'stock-branch', productId: 'sugar', ...data } });
const decide = (role, requestId) => decideStockRequest.run({ auth: auth(role), data: { requestId, decision: 'approve' } });
const ref = location => db.doc(`stock_balances/stock-branch_sugar_${location}`);
const qty = async location => (await ref(location).get()).data().qty;

async function main() {
  await Promise.all([
    db.doc('tenant_settings/stock-regression').set({ storeEnabled: true }),
    db.doc('branches/stock-branch').set({ tenantId: 'stock-regression', status: 'active' }),
    db.doc('products/sugar').set({ tenantId: 'stock-regression', name: 'Sugar 1kg', isActive: false, sellPriceMinor: 0 }),
    ref('STORE').set({ qty: 8 }), ref('HOUSE').set({ qty: -3 }),
  ]);
  const input = { action: 'request', qty: 2, requestId: 'sugar-bar', reason: 'Bar' };
  const pending = await change('bar_staff', input);
  assert.equal(pending.status, 'pending');
  assert.deepEqual(await change('bar_staff', input), pending);
  assert.equal(await qty('STORE'), 8);
  assert.equal(await qty('HOUSE'), -3);
  const results = await Promise.all([decide('owner', pending.requestId), decide('store_manager', pending.requestId)]);
  assert.equal(results.filter(result => result.alreadyDecided).length, 1);
  assert.equal(await qty('STORE'), 6);
  assert.equal(await qty('HOUSE'), -1);
  assert.equal((await db.collection('stock_movements').where('referenceId', '==', pending.requestId).get()).size, 2);
  console.log('PASS: unpriced supply request, replay, concurrent approval, balanced movements, negative House refill');

  await change('store_manager', { action: 'request', qty: 1, requestId: 'direct-sugar' });
  assert.equal(await qty('STORE'), 5);
  assert.equal(await qty('HOUSE'), 0);
  const oversized = await change('cashier', { action: 'request', qty: 6, requestId: 'too-much-sugar' });
  await assert.rejects(decide('store_manager', oversized.requestId), /holds only 5/);
  assert.equal((await db.doc(`stock_requests/${oversized.requestId}`).get()).data().status, 'pending');
  assert.equal(await qty('STORE'), 5);
  assert.equal(await qty('HOUSE'), 0);
  console.log('PASS: direct manager transfer and insufficient-stock rollback');

  await db.doc('products/sugar').update({ retiredAt: new Date() });
  await assert.rejects(change('bar_staff', { action: 'request', qty: 1, requestId: 'retired-sugar' }), /Restore/);
  await assert.rejects(decide('owner', oversized.requestId), /no longer active/);
  assert.equal(await qty('STORE'), 5);
  assert.equal(await qty('HOUSE'), 0);
  assert.equal((await db.doc('products/sugar').get()).data().isActive, false);
  console.log('PASS: retired-item restrictions and sale eligibility preserved');
}

main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => db.terminate());
