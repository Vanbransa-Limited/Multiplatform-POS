import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { unavailableMpesaCapability } from './mpesa-state.js';
import { toMinor } from './tender.js';

const source = await readFile(new URL('./mpesa.js', import.meta.url), 'utf8');
const body = source.slice(source.indexOf('export class MpesaService')).replace('export class', 'class');
const make = call => new (new Function('callFunction', 'toMinor', 'unavailableMpesaCapability', `${body};return MpesaService;`)(call, toMinor, unavailableMpesaCapability))();
const input = { phone: '0712345678', amountKes: 100, branchId: 'b1', deviceId: 'd1', idempotencyKey: 'key', orderReference: 'order' };

test('STK initiation makes one authoritative call, without a preceding capability request', async () => {
  const calls = [];
  const mpesa = make(async (name, payload) => {
    calls.push({ name, payload });
    return { status: 'pending', attemptId: 'attempt', checkoutRequestId: 'checkout' };
  });
  mpesa.getCapability = () => { throw new Error('Redundant capability request'); };
  const result = await mpesa.initiateStkPush(input);
  assert.equal(result.success, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'initiateMpesaStk');
  assert.equal(calls[0].payload.amountMinor, 10_000);
});

test('server refusal stays unavailable and never reports a successful payment', async () => {
  const mpesa = make(async () => { throw new Error('M-Pesa is suspended'); });
  const result = await mpesa.initiateStkPush(input);
  assert.equal(result.success, false);
  assert.equal(result.capability.available, false);
  assert.equal(result.message, 'M-Pesa is suspended');
});
