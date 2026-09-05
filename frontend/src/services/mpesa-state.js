/**
 * Pure M-Pesa lifecycle and attempt identity helpers.
 *
 * Keeping these free of Firebase and DOM imports makes the fail-closed rules
 * executable in Node tests as well as in the till.
 */

const SERVER_CAPABILITY_STATUSES = new Set(['live', 'staged', 'suspended']);

const DEFAULT_MESSAGES = {
  live: 'M-Pesa is active.',
  staged: 'M-Pesa is configured but not active. Use another tender until activation.',
  suspended: 'M-Pesa is temporarily suspended. Use another tender.',
  unavailable: 'M-Pesa availability could not be confirmed. Use another tender.'
};

/** Unknown or malformed capability responses are never treated as permission. */
export function normalizeMpesaCapability(value) {
  const response = value && typeof value === 'object' ? value : {};
  const status = SERVER_CAPABILITY_STATUSES.has(response.status)
    ? response.status
    : 'unavailable';
  const available = status === 'live' && response.available === true;
  const message = typeof response.message === 'string' && response.message.trim()
    ? response.message.trim()
    : available
      ? DEFAULT_MESSAGES.live
      : DEFAULT_MESSAGES[status];

  return { status, available, message };
}

export function unavailableMpesaCapability(message) {
  return normalizeMpesaCapability({
    status: 'unavailable',
    available: false,
    message: message || DEFAULT_MESSAGES.unavailable
  });
}

/**
 * Produces a backend-safe key. Firebase retries may resend this exact key; it
 * must identify the attempt, not the individual network request.
 */
export function createMpesaIdempotencyKey(randomUuid) {
  const makeUuid = randomUuid || globalThis.crypto?.randomUUID?.bind(globalThis.crypto);
  if (!makeUuid) throw new Error('Secure payment attempt identifiers are unavailable.');
  return `mpesa_${makeUuid()}`;
}

/**
 * Reuses one key while every payment-defining input is unchanged. Supplying a
 * different fingerprint starts a distinct attempt and therefore a distinct
 * key; callers explicitly discard the current object on input events too.
 */
export function ensureMpesaAttempt(current, fingerprint, createKey = createMpesaIdempotencyKey) {
  if (typeof fingerprint !== 'string' || fingerprint.length === 0) {
    throw new Error('A payment attempt fingerprint is required.');
  }
  if (current?.fingerprint === fingerprint && current.idempotencyKey) return current;

  return {
    fingerprint,
    idempotencyKey: createKey(),
    attemptId: null,
    checkoutRequestId: null
  };
}

/** A deterministic description of everything the cashier can change. */
export function mpesaAttemptFingerprint(input) {
  return JSON.stringify([
    String(input.paymentMethod || ''),
    String(input.phone || '').trim(),
    Number(input.amountMinor),
    Number(input.cashAmountMinor || 0),
    String(input.branchId || ''),
    String(input.deviceId || ''),
    String(input.customerId || ''),
    String(input.cartFingerprint || '')
  ]);
}
