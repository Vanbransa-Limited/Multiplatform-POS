/** Bounded, read-only checks. Never cache a balance for a later payment. */
export function createReceiptLookup(invoke, scope, { timeoutMs = 12000 } = {}) {
  const pending = new Map();
  return input => {
    const identity = scope();
    const payload = { ...input, reference: String(input.reference || '').trim().toUpperCase() };
    const key = JSON.stringify([identity, payload.branchId, payload.reference, payload.receiptAmountMinor ?? null]);
    if (pending.has(key)) return pending.get(key);
    let timer;
    // Include initialization and token refresh, before the SDK's HTTP timeout.
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => {
        const error = new Error('The receipt check took too long. Check your connection and retry. No payment was applied.');
        error.code = 'receipt/timeout';
        reject(error);
      }, timeoutMs);
    });
    const request = Promise.race([Promise.resolve().then(() => invoke(payload)), deadline])
      .then(result => {
        if (scope() !== identity) throw new Error('The signed-in business changed. Check the receipt again.');
        return result;
      })
      .catch(error => {
        if (['functions/deadline-exceeded', 'functions/unavailable', 'functions/internal'].includes(error?.code)) {
          throw new Error('The receipt service could not respond. Check your connection and retry. No payment was applied.');
        }
        throw error;
      })
      .finally(() => { clearTimeout(timer); pending.delete(key); });
    pending.set(key, request);
    return request;
  };
}
