import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as recovery from './stk-recovery.js';
import { toMinor } from './tender.js';

const read = async file => (await readFile(new URL(file, import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
const orders = await read('../ui/orders.js');
const till = await read('../ui/till.js');
const scope = { tenantId: 'tenant', staffId: 'cashier' };
const RECOVERY = ['FIRST_CHECK_MS', 'acknowledgePrompt', 'recoverableResponse', 'recoveryScope', 'rememberPrompt', 'removeRecovery', 'stkSettlementRequestId', 'updateRecovery'];

function withStorage(t) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const values = new Map();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true,
    value: { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) } });
  t.after(() => { if (previous) Object.defineProperty(globalThis, 'localStorage', previous); else delete globalThis.localStorage; });
}

function method(source, start, end, name) {
  return source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start) + 1)).replace(`async ${name}(`, `async function ${name}(`);
}

function ordersSettleByStk(settleSale, claimTenant = 'tenant') {
  const body = method(orders, '  async settleByStk(', '\n  async openTabEditor(', 'settleByStk');
  const db = { sale_lines: { where: () => ({ anyOf: () => ({ toArray: async () => [] }) }) } };
  return new Function('db', 'catalogueCartLines', 'DEVICE_ID', 'state', 'settleSale', 'freeSettledTab', 'activeTenantId', ...RECOVERY, `return ${body};`)(
    db, () => [], 'device', { currentBranch: { id: 'branch' } }, settleSale, async () => null, async () => claimTenant, ...RECOVERY.map(name => recovery[name]));
}

function ordersView(result) {
  const nodes = new Map();
  const querySelector = selector => { if (!nodes.has(selector)) nodes.set(selector, { value: '0712345678', classList: { remove() {} } }); return nodes.get(selector); };
  return { container: { querySelector }, settleStkKey: 'mpesa_key', settleRequestId: 'checkout', stkScope: () => scope,
    mpesa: { initiateStkPush: async () => ({ success: true, attemptId: 'mpesa-attempt-server' }), awaitResult: async () => result },
    roundOutstandingMinor: async () => 50000, recordSettlementLocally: async () => {}, pushSettledRounds: async () => ({ ok: true }),
    loadPosOrders: async () => {}, renderCustomerBoard() {}, renderStkRecovery() {}, nodes };
}

const bill = { dueMinor: 50000, customerId: 'guest', branchId: 'branch', ref: 'INV-7' };
const rounds = [{ id: 'local-1', sale_uuid: 'uuid-1', synced_at: 'server' }];

test('Orders remembers a saved-bill prompt before sending it and keeps it when M-Pesa is late', async t => {
  withStorage(t);
  let remembered;
  const view = ordersView({ status: 'pending' });
  const send = view.mpesa.initiateStkPush;
  view.mpesa.initiateStkPush = async payload => { remembered = recovery.pendingRecoveries(scope); return send(payload); };
  let settles = 0;
  await ordersSettleByStk(async () => { settles++; }).call(view, {}, bill, rounds);
  assert.equal(remembered.length, 1, 'written before the prompt leaves the till');
  assert.equal(remembered[0].attemptId, await recovery.stkAttemptId('tenant', 'mpesa_key'));
  assert.equal(remembered[0].sent, false);
  const [kept] = recovery.pendingRecoveries(scope);
  assert.equal(kept.attemptId, 'mpesa-attempt-server');
  assert.equal(kept.sent, true);
  assert.deepEqual(kept.saleUuids, ['uuid-1']);
  assert.equal(kept.checkoutId, 'checkout');
  assert.equal(settles, 0, 'an unconfirmed prompt never settles');
  assert.match(view.nodes.get('#settle-stk-badge').innerText, /Do not release goods/);
});

test('the precomputed id hashes the signed-in tenant, and a missing claim still records the server reply', async t => {
  withStorage(t);
  let remembered;
  const view = ordersView({ status: 'pending' });
  const send = view.mpesa.initiateStkPush;
  view.mpesa.initiateStkPush = async payload => { remembered = recovery.pendingRecoveries(scope); return send(payload); };
  await ordersSettleByStk(async () => {}, 'claim-tenant').call(view, {}, bill, rounds);
  assert.equal(remembered[0].attemptId, await recovery.stkAttemptId('claim-tenant', 'mpesa_key'));
  globalThis.localStorage.removeItem(`pos_stk_recovery_v2:${JSON.stringify(['tenant', 'cashier'])}`);
  await ordersSettleByStk(async () => {}, null).call(ordersView({ status: 'pending' }), {}, bill, rounds);
  assert.deepEqual(recovery.pendingRecoveries(scope).map(row => [row.attemptId, row.sent]), [['mpesa-attempt-server', true]]);
});

test('Orders settles a confirmed prompt with the shared request id and forgets it', async t => {
  withStorage(t);
  const calls = [];
  await ordersSettleByStk(async input => { calls.push(input); return { receivedMinor: 50000, paymentId: 'p1' }; })
    .call(ordersView({ status: 'paid', receipt: 'TESTCODE01' }), {}, bill, rounds);
  assert.deepEqual(calls, [{ saleUuid: 'uuid-1', checkoutId: 'checkout', requestId: 'mpesa-attempt-server-uuid-1', method: 'mpesa', attemptId: 'mpesa-attempt-server' }]);
  assert.deepEqual(recovery.pendingRecoveries(scope), []);
});

test('a definitive failure forgets the prompt and allows a fresh one', async t => {
  withStorage(t);
  const view = ordersView({ status: 'cancelled' });
  await ordersSettleByStk(async () => { throw new Error('must not settle'); }).call(view, {}, bill, rounds);
  assert.deepEqual(recovery.pendingRecoveries(scope), []);
  assert.notEqual(view.settleStkKey, 'mpesa_key');
});

test('recovery settles through settleSale with the attempt as proof, and skips a bill already paid here', async () => {
  const body = method(orders, '  async settleRecoveredRound(', '\n  async runStkRecovery(', 'settleRecoveredRound');
  const calls = [], freed = [];
  let owed = 50000;
  const db = { sales: { where: () => ({ equals: () => ({ first: async () => ({ id: 'local-1', tab_id: 'tab' }) }) }) } };
  const settle = new Function('db', 'settleSale', 'stkSettlementRequestId', 'freeSettledTab', `return ${body};`)(
    db, async input => { calls.push(input); return { paymentId: 'p1' }; }, recovery.stkSettlementRequestId, async tab => freed.push(tab));
  const view = { roundOutstandingMinor: async () => owed, recordSettlementLocally: async () => {} };
  const record = { attemptId: 'mpesa-attempt-a', checkoutId: 'checkout' };
  await settle.call(view, record, 'uuid-1');
  assert.deepEqual(calls, [{ saleUuid: 'uuid-1', checkoutId: 'checkout', method: 'mpesa', requestId: 'mpesa-attempt-a-uuid-1', attemptId: 'mpesa-attempt-a' }]);
  assert.deepEqual(freed, ['tab']);
  owed = 0;
  await settle.call(view, record, 'uuid-1');
  assert.equal(calls.length, 1);
});

test('the till remembers its saved-bill prompt before sending and keeps it while unconfirmed', async t => {
  withStorage(t);
  const body = method(till, '  async runMpesaAttempt(', '\n  async triggerPaystack', 'runMpesaAttempt');
  const nodes = new Map();
  const document = { getElementById: id => { if (!nodes.has(id)) nodes.set(id, { value: '0712345678' }); return nodes.get(id); } };
  const state = { currentTenant: { id: 'build-wide-tenant' }, currentUser: { id: 'cashier', tenantId: 'tenant' }, currentBranch: { id: 'branch' },
    syncManager: { publishSale: async id => ({ sale_uuid: `uuid-${id}`, invoice_no: `INV-${id}`, synced_at: 'server' }) } };
  const run = new Function('state', 'firebaseConfigured', 'document', 'toMinor', 'claimSalePayment', 'DEVICE_ID', 'showNotification', 'activeTenantId', ...RECOVERY, `return ${body}`)(
    state, true, document, toMinor, async () => {}, 'device', () => {}, async () => 'tenant', ...RECOVERY.map(name => recovery[name]));
  let remembered;
  const view = { activeTabId: 'tab', totals: { total: 500 }, selectedCustomer: { id: 'guest' }, mpesaCapability: { available: true },
    beginMpesaAttempt: () => ({ idempotencyKey: 'till-key', requestAmountMinor: 50000, cashAmountMinor: 0 }), mpesaOffline: () => false,
    roundsBeingSettled: async () => ['r0'], showMpesaStatus() {}, applyMpesaCapabilityToUi() {}, applyServerPricing: () => ({ ok: true }),
    mpesa: { initiateStkPush: async () => { remembered = recovery.pendingRecoveries(scope); return { success: true, attemptId: 'mpesa-attempt-till' }; },
      awaitResult: async () => ({ status: 'pending' }) } };
  await run.call(view, 'mpesa');
  assert.equal(remembered[0].attemptId, await recovery.stkAttemptId('tenant', 'till-key'));
  const [kept] = recovery.pendingRecoveries(scope);
  assert.equal(kept.attemptId, 'mpesa-attempt-till');
  assert.deepEqual(kept.saleUuids, ['uuid-r0']);
  assert.equal(kept.label, 'INV-r0');
});

test('the till settles an STK payment under the request id Orders recovery would use', () => {
  assert.match(till, /stkSettlementRequestId\(this\.mpesaAttempt\.attemptId, round\.sale_uuid\)/);
});

function ambiguousView() {
  const view = ordersView({ status: 'pending' });
  view.mpesa.initiateStkPush = async () => ({ success: false, status: 'ambiguous', attemptId: 'mpesa-attempt-server',
    message: 'M-Pesa did not confirm whether the prompt was sent.' });
  view.mpesa.awaitResult = async () => { throw new Error('an unaccepted prompt is not awaited'); };
  return view;
}

test('an ambiguous reply keeps the server attempt, with or without a precomputed id, and never settles it', async t => {
  for (const claimTenant of ['tenant', null]) {
    withStorage(t);
    let settles = 0;
    const view = ambiguousView();
    await ordersSettleByStk(async () => { settles++; }, claimTenant).call(view, {}, bill, rounds);
    const kept = recovery.pendingRecoveries(scope);
    assert.deepEqual(kept.map(row => [row.attemptId, row.sent, row.saleUuids]), [['mpesa-attempt-server', true, ['uuid-1']]], String(claimTenant));
    assert.equal(settles, 0);
    assert.equal(view.settleStkKey, 'mpesa_key', 'an ambiguous prompt keeps its key so a retry cannot charge twice');

    // After a reload the board finds it, reports it for review, and still never settles it.
    const outcomes = await recovery.recoverStkAttempts(scope, {
      readAttempt: async () => ({ status: 'ambiguous', resultDesc: 'Not confirmed by M-Pesa.' }),
      settle: async () => { settles++; }, now: Date.now() + recovery.FIRST_CHECK_MS + 1 });
    assert.equal(outcomes[0].outcome, 'needs_review');
    assert.equal(recovery.pendingRecoveries(scope)[0].state, 'needs_review');
    assert.equal(settles, 0);
  }
});

test('a definitive failure with an attempt id leaves nothing to recover', async t => {
  withStorage(t);
  const view = ordersView({ status: 'pending' });
  view.mpesa.initiateStkPush = async () => ({ success: false, status: 'failed', attemptId: 'mpesa-attempt-server' });
  await ordersSettleByStk(async () => {}, null).call(view, {}, bill, rounds);
  assert.deepEqual(recovery.pendingRecoveries(scope), []);
  assert.notEqual(view.settleStkKey, 'mpesa_key');
});

test('the till keeps an ambiguous attempt under the signed-in business, not the cached one', async t => {
  withStorage(t);
  const body = method(till, '  async runMpesaAttempt(', '\n  async triggerPaystack', 'runMpesaAttempt');
  const document = { getElementById: () => ({ value: '0712345678' }) };
  const state = { currentTenant: { id: 'build-wide-tenant' }, currentUser: { id: 'cashier', tenantId: 'tenant' }, currentBranch: { id: 'branch' },
    syncManager: { publishSale: async id => ({ sale_uuid: `uuid-${id}`, invoice_no: `INV-${id}`, synced_at: 'server' }) } };
  const run = new Function('state', 'firebaseConfigured', 'document', 'toMinor', 'claimSalePayment', 'DEVICE_ID', 'showNotification', 'activeTenantId', ...RECOVERY, `return ${body}`)(
    state, true, document, toMinor, async () => {}, 'device', () => {}, async () => null, ...RECOVERY.map(name => recovery[name]));
  const view = { activeTabId: 'tab', totals: { total: 500 }, selectedCustomer: { id: 'guest' }, mpesaCapability: { available: true },
    beginMpesaAttempt: () => ({ idempotencyKey: 'till-key', requestAmountMinor: 50000, cashAmountMinor: 0 }), mpesaOffline: () => false,
    roundsBeingSettled: async () => ['r0'], showMpesaStatus() {}, applyMpesaCapabilityToUi() {},
    invalidateMpesaAttempt() { throw new Error('an ambiguous prompt must not be discarded'); },
    mpesa: { initiateStkPush: async () => ({ success: false, status: 'ambiguous', attemptId: 'mpesa-attempt-till' }) } };
  await run.call(view, 'mpesa');
  assert.deepEqual(recovery.pendingRecoveries(scope).map(row => [row.attemptId, row.sent]), [['mpesa-attempt-till', true]]);
  assert.deepEqual(recovery.pendingRecoveries({ tenantId: 'build-wide-tenant', staffId: 'cashier' }), []);
});
