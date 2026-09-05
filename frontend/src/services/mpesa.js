/**
 * M-Pesa STK push for the till.
 *
 * The push is raised by the backend, which holds the Daraja credentials, and
 * the result arrives on the mpesa_payments document that Safaricom's callback
 * writes. The till never decides for itself whether a customer paid - it only
 * ever reports what the backend has confirmed.
 */

import { callFunction, getFirebase } from './firebase';
import { normalizeMpesaCapability, unavailableMpesaCapability } from './mpesa-state';
import { toMinor } from './tender';

/** Safaricom gives the customer about a minute at the PIN prompt. */
const WAIT_MS = 90_000;
const SETTLED_STATUSES = new Set(['paid', 'failed', 'cancelled', 'expired']);

function settlement(data) {
  const rawStatus = typeof data?.status === 'string' ? data.status.toLowerCase() : '';
  return {
    // Unknown states are unresolved, never successful.
    status: SETTLED_STATUSES.has(rawStatus) ? rawStatus : 'pending',
    receipt: typeof data?.receipt === 'string' && data.receipt ? data.receipt : null,
    resultDesc: typeof data?.resultDesc === 'string' ? data.resultDesc : '',
    amountMinor: Number.isSafeInteger(data?.amountMinor) ? data.amountMinor : null
  };
}

export class MpesaService {
  /**
   * Reads the server-owned lifecycle. A missing backend, rejected call, or
   * malformed response stays unavailable; the browser cannot opt itself in.
   */
  async getCapability() {
    try {
      return normalizeMpesaCapability(await callFunction('getMpesaCapability', {}));
    } catch {
      return unavailableMpesaCapability();
    }
  }

  /**
   * Raises the push. The account reference is chosen server-side from the
   * tenant record, so the till cannot direct a payment to another merchant.
   */
  async initiateStkPush({
    phone,
    amountKes,
    cashAmountMinor = 0,
    branchId,
    deviceId,
    idempotencyKey,
    orderReference,
    customerId,
    lines
  }) {
    const amountMinor = toMinor(amountKes);
    if (amountMinor <= 0) {
      return { success: false, status: 'invalid', message: 'Enter an amount greater than zero.' };
    }
    if (amountMinor % 100 !== 0) {
      return { success: false, status: 'invalid', message: 'M-Pesa only charges whole shillings.' };
    }
    if (!branchId || !deviceId || !idempotencyKey || !orderReference) {
      return {
        success: false,
        status: 'invalid',
        message: 'This till is missing its branch, device, or payment attempt identity.'
      };
    }

    // Re-check immediately before initiation. The checkout-open result is only
    // advisory and may have changed while the cashier was building the tender.
    const capability = await this.getCapability();
    if (!capability.available) {
      return {
        success: false,
        status: capability.status,
        message: capability.message,
        capability
      };
    }

    try {
      const data = await callFunction('initiateMpesaStk', {
        phone,
        amountMinor,
        cashAmountMinor,
        branchId,
        deviceId,
        idempotencyKey,
        orderReference,
        customerId: customerId || null,
        lines: Array.isArray(lines) ? lines : []
      });
      const status = typeof data?.status === 'string' ? data.status.toLowerCase() : 'unavailable';
      const attemptId = typeof data?.attemptId === 'string' && data.attemptId
        ? data.attemptId
        : null;
      if (!attemptId || (status !== 'pending' && status !== 'paid')) {
        return {
          success: false,
          status,
          attemptId,
          checkoutRequestId: data?.checkoutRequestId || null,
          pricing: data?.pricing || null,
          capability,
          message: data?.customerMessage || 'M-Pesa did not accept this payment attempt.'
        };
      }

      return {
        success: true,
        status,
        attemptId,
        checkoutRequestId: data.checkoutRequestId || null,
        pricing: data.pricing || null,
        capability,
        customerMessage: data.customerMessage || 'Enter your M-Pesa PIN on the phone.'
      };
    } catch (error) {
      return {
        success: false,
        status: 'unavailable',
        capability,
        message: error.message || 'M-Pesa request failed.'
      };
    }
  }

  /**
   * Resolves once the payment is settled one way or the other.
   *
   * Returns status 'paid', 'failed', or 'pending'. Pending means nobody knows
   * yet - never treat it as either outcome.
   */
  async awaitResult(attemptId, onStatus) {
    const fb = await getFirebase();
    if (!fb) throw new Error('Firebase is not configured on this till.');

    const reference = fb.firestore.doc(fb.dbInstance, 'mpesa_payments', attemptId);

    const settled = await new Promise((resolve) => {
      let stop = () => {};
      const timer = setTimeout(() => {
        stop();
        resolve(null);
      }, WAIT_MS);

      stop = fb.firestore.onSnapshot(
        reference,
        (snapshot) => {
          const data = snapshot.data();
          const status = typeof data?.status === 'string' ? data.status.toLowerCase() : '';
          if (!data || !SETTLED_STATUSES.has(status)) return;
          clearTimeout(timer);
          stop();
          resolve(data);
        },
        () => {
          clearTimeout(timer);
          stop();
          resolve(null);
        }
      );
    });

    if (settled) return settlement(settled);

    // No callback inside the window. Ask Safaricom directly rather than
    // guessing: this is the case that would otherwise strand a real payment.
    if (onStatus) onStatus('Confirming with Safaricom...');
    const queried = await callFunction('queryMpesaStatus', { attemptId });
    return settlement(queried);
  }
}
