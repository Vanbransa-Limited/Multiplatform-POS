import test from 'node:test';
import assert from 'node:assert/strict';
import { createReceiptLookup } from './receipt-lookup.js';
const input = { reference: 'ukldq29eaj', branchId: 'branch' };
const flush = () => new Promise(resolve => setImmediate(resolve));

test('stuck initialization stops at the deadline and the next check can succeed', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let resolveFirst, calls = 0;
  const lookup = createReceiptLookup(() => ++calls === 1 ? new Promise(resolve => { resolveFirst = resolve; })
    : Promise.resolve({ availableMinor: 60000 }), () => 'tenant:staff');
  const first = lookup(input);
  const rejected = assert.rejects(first, /took too long.*No payment was applied/);
  await flush();
  t.mock.timers.tick(12000);
  await rejected;
  assert.deepEqual(await lookup(input), { availableMinor: 60000 });
  resolveFirst({ availableMinor: 99999999 });
  await flush();
  assert.equal(calls, 2);
});

test('concurrent checks share one request but later checks read a fresh balance', async () => {
  let calls = 0, resolveRequest;
  const lookup = createReceiptLookup(payload => {
    calls++;
    assert.equal(payload.reference, 'UKLDQ29EAJ');
    return new Promise(resolve => { resolveRequest = resolve; });
  }, () => 'tenant:staff');
  const first = lookup(input), same = lookup({ ...input, reference: ' UKLDQ29EAJ ' });
  assert.equal(first, same);
  await flush();
  resolveRequest({ availableMinor: 60000 });
  await first;
  const next = lookup(input);
  await flush();
  assert.equal(calls, 2);
  resolveRequest({ availableMinor: 0 });
  assert.deepEqual(await next, { availableMinor: 0 });
});

test('business or staff changes cannot inherit an in-flight receipt response', async () => {
  let identity = 'tenant:alice';
  const responses = [];
  const lookup = createReceiptLookup(() => new Promise(resolve => responses.push(resolve)), () => identity);
  const alice = lookup(input), rejected = assert.rejects(alice, /business changed/);
  identity = 'tenant:bob';
  const bob = lookup(input);
  await flush();
  assert.equal(responses.length, 2);
  responses[0]({ availableMinor: 100 });
  responses[1]({ availableMinor: 200 });
  await rejected;
  assert.deepEqual(await bob, { availableMinor: 200 });
});

test('unknown codes stay rejected; network failures offer retry without suggesting success', async () => {
  for (const code of ['functions/unavailable', 'functions/deadline-exceeded']) {
    const lookup = createReceiptLookup(async () => { throw Object.assign(new Error('unavailable'), { code }); }, () => 'tenant');
    await assert.rejects(lookup(input), /retry.*No payment was applied/);
  }
  const lookup = createReceiptLookup(async () => { throw Object.assign(new Error('No confirmed payment'), { code: 'functions/not-found' }); }, () => 'tenant');
  await assert.rejects(lookup(input), /No confirmed payment/);
});

test('checks with different entered receipt amounts do not share a pending response', async () => {
  const replies = [];
  const lookup = createReceiptLookup(payload => new Promise(resolve => replies.push(() => resolve(payload.receiptAmountMinor))), () => 'tenant:staff');
  const first = lookup({ ...input, receiptAmountMinor: 40000 });
  const corrected = lookup({ ...input, receiptAmountMinor: 95000 });
  await flush();
  assert.equal(replies.length, 2);
  replies.forEach(reply => reply());
  assert.equal(await first, 40000);
  assert.equal(await corrected, 95000);
});
