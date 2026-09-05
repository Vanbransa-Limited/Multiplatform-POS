import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createMpesaIdempotencyKey,
  ensureMpesaAttempt,
  mpesaAttemptFingerprint,
  normalizeMpesaCapability,
} from './mpesa-state.js';

test('M-Pesa capability fails closed unless the server explicitly reports live and available', () => {
  assert.deepEqual(normalizeMpesaCapability(null), {
    status: 'unavailable',
    available: false,
    message: 'M-Pesa availability could not be confirmed. Use another tender.'
  });
  assert.equal(normalizeMpesaCapability({ status: 'live', available: false }).available, false);
  assert.equal(normalizeMpesaCapability({ status: 'staged', available: true }).available, false);
  assert.equal(normalizeMpesaCapability({ status: 'suspended', available: true }).available, false);
  assert.deepEqual(normalizeMpesaCapability({ status: 'live', available: true, message: ' Ready ' }), {
    status: 'live',
    available: true,
    message: 'Ready'
  });
});

test('M-Pesa idempotency key is backend-safe', () => {
  const key = createMpesaIdempotencyKey(() => '12345678-1234-4234-9234-123456789abc');
  assert.equal(key, 'mpesa_12345678-1234-4234-9234-123456789abc');
  assert.match(key, /^[A-Za-z0-9:_-]{8,160}$/);
});

test('one unchanged payment attempt reuses its key and a changed input gets a new key', () => {
  let sequence = 0;
  const createKey = () => `mpesa_test_${++sequence}`;
  const first = ensureMpesaAttempt(null, 'cart-a', createKey);
  const retried = ensureMpesaAttempt(first, 'cart-a', createKey);
  const changed = ensureMpesaAttempt(retried, 'cart-b', createKey);
  const explicitlyReset = ensureMpesaAttempt(null, 'cart-b', createKey);

  assert.equal(retried, first);
  assert.equal(retried.idempotencyKey, 'mpesa_test_1');
  assert.equal(changed.idempotencyKey, 'mpesa_test_2');
  assert.equal(explicitlyReset.idempotencyKey, 'mpesa_test_3');
});

test('attempt fingerprint changes with phone, tender, amount, customer, or cart', () => {
  const base = {
    paymentMethod: 'MPESA',
    phone: '0712345678',
    amountMinor: 10000,
    cashAmountMinor: 0,
    branchId: 'branch-1',
    deviceId: 'device-1',
    customerId: 'walk-in',
    cartFingerprint: 'soda:1'
  };
  const original = mpesaAttemptFingerprint(base);

  for (const replacement of [
    { phone: '0799999999' },
    { paymentMethod: 'SPLIT' },
    { amountMinor: 5000 },
    { cashAmountMinor: 5000 },
    { customerId: 'customer-2' },
    { cartFingerprint: 'soda:2' }
  ]) {
    assert.notEqual(mpesaAttemptFingerprint({ ...base, ...replacement }), original);
  }
});
