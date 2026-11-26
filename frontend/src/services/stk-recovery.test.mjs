import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  FIRST_CHECK_MS, acknowledgePrompt, pendingRecoveries, recoverableResponse, recoverStkAttempts, recoveryScope, rememberPrompt, removeRecovery,
  saveRecovery, stkAttemptId, stkSettlementRequestId,
} from './stk-recovery.js';

const scope = { tenantId: 't1', staffId: 's1' };
const T0 = 1_000_000;

function memoryStorage() {
  const values = new Map();
  return {
    getItem: key => (values.has(key) ? values.get(key) : null),
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key),
    values,
  };
}

const record = (extra = {}) => ({ attemptId: 'mpesa-attempt-a1', saleUuids: ['uuid-1', 'uuid-2'], checkoutId: 'checkout-1',
  label: 'INV-001', createdAt: T0, nextCheckAt: T0 + FIRST_CHECK_MS, sent: true, state: 'awaiting', ...extra });

test('the precomputed attempt id is the backend deterministicId for the same key', async () => {
  const expected = `mpesa-attempt-${createHash('sha256').update('t1:mpesa_key').digest('hex').slice(0, 48)}`;
  assert.equal(await stkAttemptId('t1', 'mpesa_key'), expected);
  assert.ok(stkSettlementRequestId(expected, '0f8fad5b-d9cb-469f-a165-70867728950e').length <= 128);
});

test('a record survives a reload and is scoped to the business and cashier', () => {
  const storage = memoryStorage();
  saveRecovery(scope, record(), storage);
  assert.equal(pendingRecoveries(scope, storage).length, 1);
  assert.equal(pendingRecoveries({ tenantId: 't1', staffId: 'other' }, storage).length, 0);
  assert.equal(pendingRecoveries({ tenantId: 't2', staffId: 's1' }, storage).length, 0);
  removeRecovery(scope, 'mpesa-attempt-a1', storage);
  assert.equal(storage.values.size, 0);
});

test('nothing is read while the original checkout is still waiting, or when nothing is remembered', async () => {
  const storage = memoryStorage();
  let reads = 0;
  const readAttempt = async () => { reads++; return { status: 'paid' }; };
  await recoverStkAttempts(scope, { readAttempt, settle: async () => {}, now: T0, storage });
  saveRecovery(scope, record(), storage);
  await recoverStkAttempts(scope, { readAttempt, settle: async () => {}, now: T0 + 60_000, storage });
  assert.equal(reads, 0);
});

test('a late confirmation settles every bill once with the attempt-derived request id, then clears', async () => {
  const storage = memoryStorage();
  saveRecovery(scope, record(), storage);
  const calls = [];
  const outcomes = await recoverStkAttempts(scope, {
    readAttempt: async () => ({ status: 'paid' }),
    settle: async (row, saleUuid) => { calls.push([row.attemptId, saleUuid, stkSettlementRequestId(row.attemptId, saleUuid), row.checkoutId]); },
    now: T0 + FIRST_CHECK_MS, storage,
  });
  assert.deepEqual(calls, [
    ['mpesa-attempt-a1', 'uuid-1', 'mpesa-attempt-a1-uuid-1', 'checkout-1'],
    ['mpesa-attempt-a1', 'uuid-2', 'mpesa-attempt-a1-uuid-2', 'checkout-1'],
  ]);
  assert.equal(outcomes[0].outcome, 'settled');
  assert.equal(pendingRecoveries(scope, storage).length, 0);
});

test('two recoveries running together settle the attempt once', async () => {
  const storage = memoryStorage();
  saveRecovery(scope, record({ saleUuids: ['uuid-1'] }), storage);
  let settles = 0, release;
  const gate = new Promise(resolve => { release = resolve; });
  const deps = { readAttempt: async () => { await gate; return { status: 'paid' }; },
    settle: async () => { settles++; }, now: T0 + FIRST_CHECK_MS, storage };
  const first = recoverStkAttempts(scope, deps), second = recoverStkAttempts(scope, deps);
  release();
  await Promise.all([first, second]);
  assert.equal(settles, 1);
});

test('a bill another device already settled counts as done, never as a second payment', async () => {
  const storage = memoryStorage();
  saveRecovery(scope, record(), storage);
  const outcomes = await recoverStkAttempts(scope, {
    readAttempt: async () => ({ status: 'paid' }),
    settle: async (_row, saleUuid) => { if (saleUuid === 'uuid-1') throw new Error('This sale is already settled by that payment.'); },
    now: T0 + FIRST_CHECK_MS, storage,
  });
  assert.equal(outcomes[0].outcome, 'settled');
  assert.equal(pendingRecoveries(scope, storage).length, 0);
});

test('unverified and ambiguous attempts are never settled and stay visible', async () => {
  for (const [attempt, state] of [
    [{ status: 'verification_pending' }, 'awaiting'],
    [{ status: 'pending' }, 'awaiting'],
    [{ status: 'ambiguous', resultDesc: 'The M-Pesa receipt is already assigned to another payment.' }, 'needs_review'],
    [{ status: 'paid', settlementStatus: 'receipt_conflict' }, 'needs_review'],
  ]) {
    const storage = memoryStorage();
    saveRecovery(scope, record(), storage);
    let settles = 0;
    await recoverStkAttempts(scope, { readAttempt: async () => attempt, settle: async () => { settles++; }, now: T0 + FIRST_CHECK_MS, storage });
    assert.equal(settles, 0, attempt.status);
    const [kept] = pendingRecoveries(scope, storage);
    assert.equal(kept.state, state, attempt.status);
    if (state === 'needs_review') assert.ok(kept.lastError);
  }
});

test('needs-review records wait for staff; a forced check can still settle them', async () => {
  const storage = memoryStorage();
  saveRecovery(scope, record({ state: 'needs_review', saleUuids: ['uuid-1'] }), storage);
  let reads = 0, settles = 0;
  const deps = { readAttempt: async (_id, { force }) => { reads++; return { status: force ? 'paid' : 'pending' }; },
    settle: async () => { settles++; }, now: T0 + DAY(2), storage };
  await recoverStkAttempts(scope, deps);
  assert.equal(reads, 0);
  saveRecovery(scope, record({ attemptId: 'mpesa-attempt-other', state: 'needs_review' }), storage);
  await recoverStkAttempts(scope, { ...deps, force: true, only: 'mpesa-attempt-a1' });
  assert.equal(reads, 1, 'a staff check asks about the chosen payment only');
  assert.deepEqual(pendingRecoveries(scope, storage).map(row => row.attemptId), ['mpesa-attempt-other']);
  assert.equal(settles, 1);
});

test('failed, cancelled and expired prompts are cleared without settling', async () => {
  for (const status of ['failed', 'cancelled', 'expired']) {
    const storage = memoryStorage();
    saveRecovery(scope, record(), storage);
    let settles = 0;
    const [outcome] = await recoverStkAttempts(scope, { readAttempt: async () => ({ status }), settle: async () => { settles++; }, now: T0 + FIRST_CHECK_MS, storage });
    assert.equal(settles, 0);
    assert.equal(outcome.outcome, status);
    assert.equal(pendingRecoveries(scope, storage).length, 0);
  }
});

test('a settlement the server refuses stays visible and is retried later, not marked paid', async () => {
  const storage = memoryStorage();
  saveRecovery(scope, record({ saleUuids: ['uuid-1'] }), storage);
  const [outcome] = await recoverStkAttempts(scope, {
    readAttempt: async () => ({ status: 'paid' }),
    settle: async () => { throw new Error('That payment was requested for a different bill.'); },
    now: T0 + FIRST_CHECK_MS, storage,
  });
  assert.equal(outcome.outcome, 'failed');
  const [kept] = pendingRecoveries(scope, storage);
  assert.equal(kept.lastError, 'That payment was requested for a different bill.');
  assert.ok(kept.nextCheckAt > T0 + FIRST_CHECK_MS);
});

test('a prompt that never reached the server is dropped; an unreadable sent one goes to review after a day', async () => {
  const storage = memoryStorage();
  saveRecovery(scope, record({ sent: false }), storage);
  const [dropped] = await recoverStkAttempts(scope, { readAttempt: async () => null, settle: async () => {}, now: T0 + FIRST_CHECK_MS + 1, storage });
  assert.equal(dropped.outcome, 'not_sent');
  saveRecovery(scope, record(), storage);
  const readAttempt = async () => { throw new Error('Missing or insufficient permissions.'); };
  await recoverStkAttempts(scope, { readAttempt, settle: async () => {}, now: T0 + FIRST_CHECK_MS, storage });
  assert.equal(pendingRecoveries(scope, storage)[0].state, 'awaiting');
  await recoverStkAttempts(scope, { readAttempt, settle: async () => {}, now: T0 + DAY(1) + 1, storage });
  assert.equal(pendingRecoveries(scope, storage)[0].state, 'needs_review');
});

test('the server id replaces a precomputed one and marks the prompt sent', async () => {
  const storage = memoryStorage();
  const prompt = record();
  const provisional = await rememberPrompt(scope, prompt, { tenantId: 't1', stkKey: 'key' }, storage);
  assert.equal(pendingRecoveries(scope, storage)[0].sent, false);
  acknowledgePrompt(scope, provisional, prompt, 'mpesa-attempt-server', storage);
  const rows = pendingRecoveries(scope, storage);
  assert.deepEqual(rows.map(row => [row.attemptId, row.sent]), [['mpesa-attempt-server', true]]);
});

test('without the signed-in tenant or WebCrypto the prompt is still remembered from the server reply', async () => {
  for (const tenantId of [null, 't1']) {
    const storage = memoryStorage();
    const previous = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
    if (tenantId) Object.defineProperty(globalThis, 'crypto', { configurable: true, value: {} });
    try {
      assert.equal(await rememberPrompt(scope, record(), { tenantId, stkKey: 'key' }, storage), null);
    } finally { if (tenantId) Object.defineProperty(globalThis, 'crypto', previous); }
    assert.deepEqual(pendingRecoveries(scope, storage), []);
    acknowledgePrompt(scope, null, record(), 'mpesa-attempt-server', storage);
    assert.deepEqual(pendingRecoveries(scope, storage).map(row => [row.attemptId, row.sent]), [['mpesa-attempt-server', true]]);
  }
});

test('broken storage never breaks checkout', async () => {
  const storage = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); }, removeItem() { throw new Error('denied'); } };
  assert.doesNotThrow(() => saveRecovery(scope, record(), storage));
  assert.deepEqual(pendingRecoveries(scope, storage), []);
  assert.deepEqual(await recoverStkAttempts(scope, { readAttempt: async () => ({}), settle: async () => {}, storage }), []);
});

function DAY(n) { return n * 24 * 60 * 60_000; }

test('the scope comes only from a verified signed-in user; without one nothing is remembered', () => {
  assert.deepEqual(recoveryScope({ id: 's1', tenantId: 't1' }), { tenantId: 't1', staffId: 's1' });
  for (const user of [null, undefined, {}, { id: 's1' }, { tenantId: 't1' }, { id: '', tenantId: 't1' }, { id: 's1', tenantId: 7 }]) {
    assert.equal(recoveryScope(user), null, JSON.stringify(user));
  }
});

test('every returned attempt that may still take money is recoverable, ambiguous included', () => {
  for (const status of ['ambiguous', 'pending', 'initiating', 'verification_pending', 'paid', 'AMBIGUOUS']) {
    assert.equal(recoverableResponse({ attemptId: 'a', status }), true, status);
  }
  for (const response of [{ attemptId: 'a', status: 'failed' }, { attemptId: 'a', status: 'Cancelled' }, { attemptId: 'a', status: 'expired' },
    { status: 'ambiguous' }, { attemptId: null, status: 'pending' }, null]) {
    assert.equal(recoverableResponse(response), false, JSON.stringify(response));
  }
});

test('records never cross businesses, even for the same staff id, and stay per cashier within one', async () => {
  const storage = memoryStorage();
  const a = recoveryScope({ tenantId: 'business-a', id: 'staff-1' });
  const b = recoveryScope({ tenantId: 'business-b', id: 'staff-1' });
  const colleague = recoveryScope({ tenantId: 'business-a', id: 'staff-2' });
  saveRecovery(a, record({ attemptId: 'attempt-a', label: 'INV-A' }), storage);
  saveRecovery(colleague, record({ attemptId: 'attempt-colleague' }), storage);
  assert.deepEqual(pendingRecoveries(a, storage).map(row => row.attemptId), ['attempt-a']);
  assert.deepEqual(pendingRecoveries(b, storage), []);
  assert.deepEqual(pendingRecoveries(colleague, storage).map(row => row.attemptId), ['attempt-colleague']);
  let reads = 0;
  await recoverStkAttempts(b, { readAttempt: async () => { reads++; return { status: 'paid' }; }, settle: async () => {}, now: T0 + DAY(1), storage });
  assert.equal(reads, 0, 'another business never even checks them');
});

test('records under the unreleased build-wide key are never read under any business', async () => {
  const storage = memoryStorage();
  storage.setItem(`pos_stk_recovery:${JSON.stringify(['t1', 's1'])}`, JSON.stringify([record()]));
  assert.deepEqual(pendingRecoveries(scope, storage), []);
  let reads = 0;
  await recoverStkAttempts(scope, { readAttempt: async () => { reads++; return { status: 'paid' }; }, settle: async () => {}, now: T0 + DAY(1), storage });
  assert.equal(reads, 0);
  saveRecovery(scope, record({ attemptId: 'fresh' }), storage);
  assert.equal(storage.getItem(`pos_stk_recovery:${JSON.stringify(['t1', 's1'])}`) !== null, true, 'the old key is left as it was');
  assert.deepEqual(pendingRecoveries(scope, storage).map(row => row.attemptId), ['fresh']);
});
