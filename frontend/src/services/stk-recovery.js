/**
 * Late M-Pesa confirmation recovery.
 *
 * The server marks an STK attempt paid when Safaricom confirms it, but only the
 * till settles the saved bill against that attempt. A customer who entered the
 * PIN after the till stopped waiting left a confirmed payment on a bill still
 * shown unpaid. Each prompt is remembered here, per business and cashier, until
 * it settles, fails or needs a person.
 *
 * Every settlement goes through settleSale with the attempt as proof and a
 * request id derived from the attempt and the bill, so the original checkout,
 * a recovery and a retry on any device all resolve to one payment record.
 */

// v2: keyed by the signed-in business. The unreleased v1 key used a build-wide
// tenant id, so its records are never read under any business.
const PREFIX = 'pos_stk_recovery_v2:';
const DAY_MS = 24 * 60 * 60_000;
/** The dialog's own 90 s wait plus its Safaricom query, before recovery steps in. */
export const FIRST_CHECK_MS = 3 * 60_000;
const DONE = /already settled by that payment|Nothing is outstanding|already been paid/i;
const inFlight = new Set();

export const stkSettlementRequestId = (attemptId, saleUuid) => `${attemptId}-${saleUuid}`;

/**
 * The server's attempt id for a prompt (deterministicId in the backend), known
 * before the prompt is sent so a crash while it is in flight is still recoverable.
 */
export async function stkAttemptId(tenantId, stkKey, subtle = globalThis.crypto?.subtle) {
  const digest = await subtle.digest('SHA-256', new TextEncoder().encode(`${tenantId}:${stkKey}`));
  const hex = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
  return `mpesa-attempt-${hex.slice(0, 48)}`;
}

const keyFor = scope => `${PREFIX}${JSON.stringify([scope.tenantId, scope.staffId])}`;

/**
 * Records belong to one business and one cashier, both from the signed-in
 * session's verified claims (the user built from the ID token), never from a
 * cached or build-time tenant. No session, no records.
 */
export function recoveryScope(user) {
  const tenantId = user?.tenantId, staffId = user?.id;
  return typeof tenantId === 'string' && tenantId && typeof staffId === 'string' && staffId ? { tenantId, staffId } : null;
}

/**
 * The server returned a real attempt that may still take money: anything with
 * an id that is not a definitive failure, including `ambiguous`. Recording it
 * never settles it; recovery settles only `paid`.
 */
export const recoverableResponse = response => Boolean(response?.attemptId)
  && !['failed', 'cancelled', 'expired'].includes(String(response.status || '').toLowerCase());

function load(scope, storage) {
  try {
    const rows = JSON.parse(storage?.getItem(keyFor(scope)) || '[]');
    return Array.isArray(rows) ? rows.filter(row => row?.attemptId && Array.isArray(row.saleUuids)) : [];
  } catch { return []; }
}

function store(scope, rows, storage) {
  try {
    if (rows.length) storage?.setItem(keyFor(scope), JSON.stringify(rows));
    else storage?.removeItem(keyFor(scope));
  } catch { /* Private mode or full storage: the typed M-Pesa code remains the fallback. */ }
}

export const pendingRecoveries = (scope, storage = globalThis.localStorage) => load(scope, storage);

export function saveRecovery(scope, record, storage = globalThis.localStorage) {
  store(scope, [...load(scope, storage).filter(row => row.attemptId !== record.attemptId), record], storage);
}

export function updateRecovery(scope, attemptId, changes, storage = globalThis.localStorage) {
  store(scope, load(scope, storage).map(row => (row.attemptId === attemptId ? { ...row, ...changes } : row)), storage);
}

export function removeRecovery(scope, attemptId, storage = globalThis.localStorage) {
  store(scope, load(scope, storage).filter(row => row.attemptId !== attemptId), storage);
}

/**
 * Remembers a prompt before it is sent. Needs the signed-in claim's tenant (the
 * server hashes that, not a cached one) and WebCrypto; without either it returns
 * null and acknowledgePrompt records the prompt from the server's reply instead.
 */
export async function rememberPrompt(scope, record, { tenantId, stkKey }, storage = globalThis.localStorage) {
  if (!scope || !tenantId) return null;
  try {
    const attemptId = await stkAttemptId(tenantId, stkKey);
    saveRecovery(scope, { ...record, attemptId, sent: false }, storage);
    return attemptId;
  } catch { return null; }
}

/** Records the server's attempt id once the prompt is acknowledged, replacing any precomputed one. */
export function acknowledgePrompt(scope, provisionalId, record, attemptId, storage = globalThis.localStorage) {
  if (!scope || !attemptId) return null;
  if (provisionalId && provisionalId !== attemptId) removeRecovery(scope, provisionalId, storage);
  saveRecovery(scope, { ...record, attemptId, sent: true }, storage);
  return attemptId;
}

async function recoverOne(record, { readAttempt, settle, now, force }) {
  const age = now - Number(record.createdAt || now);
  const later = message => ({ state: 'awaiting', lastError: message || null,
    nextCheckAt: now + (age < 10 * 60_000 ? 60_000 : 5 * 60_000) });
  let attempt;
  try { attempt = await readAttempt(record.attemptId, { force }); } catch (error) { attempt = { error }; }

  if (!attempt || attempt.error) {
    // Never acknowledged and never created: no prompt reached a phone.
    if (!record.sent && age > FIRST_CHECK_MS) return { remove: true, outcome: 'not_sent' };
    if (age > DAY_MS) {
      return { state: 'needs_review', lastError: 'This till cannot read that M-Pesa payment. Enter the M-Pesa code from the customer’s message, or ask a manager.' };
    }
    return later(attempt?.error?.message);
  }

  const status = String(attempt.status || '').toLowerCase();
  if (['failed', 'cancelled', 'expired'].includes(status)) return { remove: true, outcome: status };
  if (status === 'ambiguous' || attempt.settlementStatus === 'receipt_conflict') {
    return { state: 'needs_review', lastError: attempt.resultDesc || 'M-Pesa reported this payment in a way that needs a manager to reconcile it.' };
  }
  if (status === 'paid') {
    for (const saleUuid of record.saleUuids) {
      try { await settle(record, saleUuid); } catch (error) {
        if (DONE.test(String(error?.message))) continue;
        return { state: 'failed', lastError: error?.message || 'The confirmed payment could not be applied.', nextCheckAt: now + 5 * 60_000 };
      }
    }
    return { remove: true, outcome: 'settled' };
  }
  if (age > DAY_MS) return { state: 'needs_review', lastError: 'M-Pesa has not confirmed this payment after 24 hours. Check the customer’s message before releasing goods.' };
  return later(status === 'verification_pending' ? 'M-Pesa received it but has not verified it yet.' : null);
}

/**
 * Checks remembered prompts that are due and settles the confirmed ones.
 * Unverified, ambiguous or failing ones stay listed for staff; nothing here
 * marks an order paid without a successful server settlement.
 */
export async function recoverStkAttempts(scope, { readAttempt, settle, now = Date.now(), force = false, only, storage = globalThis.localStorage }) {
  const outcomes = [];
  if (!scope?.tenantId || !scope?.staffId) return outcomes;
  for (const record of load(scope, storage)) {
    if (only && record.attemptId !== only) continue;
    if (!force && (record.state === 'needs_review' || Number(record.nextCheckAt || 0) > now)) continue;
    if (inFlight.has(record.attemptId)) continue;
    inFlight.add(record.attemptId);
    try {
      const { remove, outcome, ...changes } = await recoverOne(record, { readAttempt, settle, now, force });
      if (remove) removeRecovery(scope, record.attemptId, storage);
      else updateRecovery(scope, record.attemptId, changes, storage);
      outcomes.push({ attemptId: record.attemptId, label: record.label, outcome: outcome || changes.state, error: changes.lastError || null });
    } finally { inFlight.delete(record.attemptId); }
  }
  return outcomes;
}
