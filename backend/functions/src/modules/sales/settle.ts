import { Timestamp } from 'firebase-admin/firestore';
import { HttpsError, onCall } from 'firebase-functions/v2/https';

import { FUNCTION_REGION } from '../../config/runtime';
import { db } from '../../lib/firebase';
import { deterministicId } from '../../shared/identifiers';
import { asRecord, documentId, optionalText } from '../../shared/validation';
import { SELLING_ROLES } from './constants';

/**
 * Settling a sale that went out unpaid.
 *
 * A proforma prints, the goods leave, and the money arrives later - by M-Pesa,
 * by bank transfer, or in cash at the counter. Until it is recorded against the
 * sale, the receivable sits on the books forever and nobody can tell which
 * transfer cleared which invoice.
 *
 * The M-Pesa path is the reason this is a server callable rather than a local
 * write: a code is checked against the C2B confirmation the provider actually
 * sent us, so "paid" means money arrived, not that somebody typed a code.
 */

/** What a receivable can be settled with. Only M-Pesa can be verified. */
const METHODS = new Set(['mpesa', 'cash', 'card', 'bank_transfer']);

/** Anyone who can take money at the counter can record that it arrived. */
export function settlingStaff(token: Record<string, unknown> | undefined) {
  if (!token?.tenant_id || !token.staff_id || !SELLING_ROLES.has(String(token.staff_role))) {
    throw new HttpsError('permission-denied', 'Sign in to settle a sale.');
  }
  return { tenantId: String(token.tenant_id), staffId: String(token.staff_id) };
}

/**
 * What is still owed on a sale.
 *
 * Credit is the receivable tender - a proforma rides that path - so the amount
 * outstanding is whatever was booked to credit and has not been settled since.
 */
export function outstandingMinor(payments: { method?: unknown; amountMinor?: unknown; settledAt?: unknown }[]): number {
  return payments.reduce((total, payment) => {
    if (String(payment?.method) !== 'credit' || payment?.settledAt) return total;
    const amount = Number(payment?.amountMinor);
    return total + (Number.isSafeInteger(amount) && amount > 0 ? amount : 0);
  }, 0);
}

/** How long an STK prompt can still be answered on the customer's phone. */
const LIVE_PROMPT_MS = 3 * 60_000;

/**
 * Why an earlier STK attempt on this sale blocks the payment being started, or null.
 *
 * Any non-failed attempt used to block everything, so a callback Safaricom
 * could not be re-queried for (verification_pending) locked the order for good:
 * no new prompt, and the customer's own typed code refused too.
 */
export function attemptBlocks(
  attempt: { status?: unknown; requestedAt?: { toMillis?: () => number } } | undefined,
  next: 'stk' | 'mpesa' | 'other',
  nowMs: number,
): string | null {
  const status = String(attempt?.status ?? 'failed').toLowerCase();
  if (status === 'failed') return null;
  // The customer's receipt is its own proof, and a receipt is consumed once.
  if (next === 'mpesa') return null;
  if (status === 'paid') return 'M-Pesa already confirmed a payment for this order. Settle it with that payment.';
  // The customer may have paid on these; another prompt or cash could charge twice.
  if (status === 'verification_pending' || status === 'ambiguous') {
    return 'An M-Pesa payment for this order is still unconfirmed. Enter the M-Pesa code from the customer’s message to close it.';
  }
  // pending / initiating: a prompt nobody answered expires on the phone.
  const age = nowMs - Number(attempt?.requestedAt?.toMillis?.() || 0);
  return age < LIVE_PROMPT_MS
    ? 'An M-Pesa prompt for this order is still open on the customer’s phone. Wait for it, or enter the M-Pesa code from their message.'
    : null;
}

/** Reserve the existing bill before a device starts a payment prompt. */
export const claimSalePayment = onCall({ region: FUNCTION_REGION }, async (request) => {
  const actor = settlingStaff(request.auth?.token);
  const input = asRecord(request.data);
  const checkoutId = documentId(input.checkoutId, 'checkoutId');
  const stkKey = input.stkKey ? documentId(input.stkKey, 'stkKey') : null;
  // Older tills do not send the method; treat them as a typed code, the case
  // that was wrongly blocked.
  const nextMethod = input.method === undefined || input.method === 'mpesa' ? 'mpesa' : 'other';
  if (!Array.isArray(input.saleUuids) || !input.saleUuids.length || input.saleUuids.length > 200) {
    throw new HttpsError('invalid-argument', 'Choose the orders to pay.');
  }
  const uuids = [...new Set(input.saleUuids.map(value => documentId(value, 'saleUuid')))];
  const refs = uuids.map(uuid => db.collection('sales').doc(deterministicId('sale', `${actor.tenantId}:${uuid}`)));
  return db.runTransaction(async tx => {
    const sales = await tx.getAll(...refs);
    const now = Timestamp.now();
    let dueMinor = 0;
    let branchId: unknown;
    for (const doc of sales) {
      const sale = doc.data();
      if (!doc.exists || sale?.tenantId !== actor.tenantId || String(sale.status).toUpperCase() === 'VOIDED') {
        throw new HttpsError('failed-precondition', 'This order is unavailable. Refresh orders before taking payment.');
      }
      if (branchId && branchId !== sale.branchId) throw new HttpsError('invalid-argument', 'Pay orders from one branch at a time.');
      branchId = sale.branchId;
      const ledger = await tx.get(db.collection('payments').where('saleId', '==', doc.id));
      const owed = outstandingMinor(ledger.docs.map(row => row.data()));
      if (!owed) continue;
      dueMinor += owed;
      const own = sale.checkoutId === checkoutId && sale.checkoutStaffId === actor.staffId;
      if (!own && Number(sale.checkoutExpiresAt?.toMillis?.() || 0) > now.toMillis()) {
        throw new HttpsError('failed-precondition', 'Another device is taking payment for this order. Refresh before trying again.');
      }
      if (sale.checkoutStkKey) {
        const attemptId = deterministicId('mpesa-attempt', `${actor.tenantId}:${sale.checkoutStkKey}`);
        const attempt = await tx.get(db.collection('mpesa_payments').doc(attemptId));
        const blocked = own && stkKey === sale.checkoutStkKey
          ? null
          : attemptBlocks(attempt.data(), stkKey ? 'stk' : nextMethod, now.toMillis());
        if (blocked) throw new HttpsError('failed-precondition', blocked);
      }
    }
    if (dueMinor <= 0) throw new HttpsError('failed-precondition', 'This order has already been paid. Refresh orders.');
    if (input.expectedMinor !== undefined && input.expectedMinor !== dueMinor) {
      throw new HttpsError('failed-precondition', 'The amount due changed. Refresh orders before taking payment.');
    }
    for (const doc of sales) tx.update(doc.ref, {
      checkoutId, checkoutStaffId: actor.staffId,
      checkoutExpiresAt: Timestamp.fromMillis(now.toMillis() + 5 * 60_000),
      checkoutStkKey: stkKey,
    });
    return { checkoutId, dueMinor };
  });
});

/**
 * Whether a sale is still entirely unpaid.
 *
 * Voiding is only ever allowed on an order nobody has paid for. Once money has
 * arrived against it the correction is a refund, which is a different event
 * with different books, so this refuses rather than quietly unwinding it.
 */
export function isVoidable(payments: { method?: unknown; settledAt?: unknown }[]): boolean {
  return payments.length > 0
    && payments.every((payment) => String(payment?.method) === 'credit' && !payment?.settledAt);
}

/**
 * Takes back an order that was registered but never paid for.
 *
 * An order is written the moment Pay Now is tapped, so it exists - and has
 * moved stock - before anyone has paid. A mis-rung order therefore has to be
 * withdrawable from any till, not just the one that rang it up, and the stock
 * it took has to come back.
 *
 * The sale is kept and stamped VOIDED rather than deleted: it really did move
 * stock, and that is a fact somebody will want to find later.
 */
export const voidSale = onCall({ region: FUNCTION_REGION }, async (request) => {
  const actor = settlingStaff(request.auth?.token);
  const input = asRecord(request.data);
  const saleUuid = documentId(input.saleUuid, 'saleUuid');
  const saleId = deterministicId('sale', `${actor.tenantId}:${saleUuid}`);
  const reason = optionalText(input.reason, 'reason', 200) ?? '';
  if (!reason) throw new HttpsError('invalid-argument', 'Give a reason for voiding this order.');

  const saleRef = db.collection('sales').doc(saleId);

  return db.runTransaction(async (tx) => {
    const saleDoc = await tx.get(saleRef);
    const sale = saleDoc.data();
    if (!saleDoc.exists || sale?.tenantId !== actor.tenantId) {
      throw new HttpsError('not-found', 'Sale not found.');
    }
    // A second press of Void returns what the first one did rather than
    // restoring the same stock twice.
    if (sale.status === 'VOIDED') return { saleId, saleUuid, voided: true, alreadyVoided: true };
    if (Number(sale.checkoutExpiresAt?.toMillis?.() || 0) > Date.now()) {
      throw new HttpsError('failed-precondition', 'Payment is in progress on this order. Finish or reconcile it before voiding.');
    }
    if (sale.checkoutStkKey) {
      const attempt = await tx.get(db.collection('mpesa_payments').doc(deterministicId('mpesa-attempt', `${actor.tenantId}:${sale.checkoutStkKey}`)));
      if (attempt.exists && attempt.data()?.status !== 'failed') throw new HttpsError('failed-precondition', 'Reconcile the M-Pesa payment before voiding this order.');
    }

    const paymentDocs = await tx.get(db.collection('payments').where('saleId', '==', saleId));
    const payments = paymentDocs.docs.map((doc) => ({
      ref: doc.ref as FirebaseFirestore.DocumentReference,
      method: doc.data().method as unknown,
      settledAt: doc.data().settledAt as unknown,
    }));
    if (!isVoidable(payments)) {
      throw new HttpsError(
        'failed-precondition',
        'This order has been paid for. Refund it rather than voiding it.',
      );
    }

    const movementDocs = await tx.get(
      db.collection('stock_movements').where('referenceId', '==', saleId),
    );
    // Read every balance before writing any of them: a transaction may not
    // read after it has written.
    const restorations = [];
    for (const movement of movementDocs.docs) {
      const data = movement.data();
      if (data.type !== 'SALE') continue;
      const soldQty = Number(data.qty) || 0;
      const balanceRef = db.collection('stock_balances').doc(
        `${String(data.branchId)}_${String(data.productId)}_${String(data.location)}`,
      );
      const balance = await tx.get(balanceRef);
      restorations.push({ data, soldQty, balanceRef, currentQty: Number(balance.data()?.qty) || 0 });
    }

    const now = Timestamp.now();
    restorations.forEach(({ data, soldQty, balanceRef, currentQty }, index) => {
      // The movement is negative, so subtracting it puts the stock back.
      const restoredQty = currentQty - soldQty;
      tx.update(balanceRef, { qty: restoredQty, updatedAt: now });
      const movementId = `${saleId}_void_${String(index + 1).padStart(2, '0')}`;
      tx.set(db.collection('stock_movements').doc(movementId), {
        id: movementId,
        tenantId: actor.tenantId,
        branchId: data.branchId,
        productId: data.productId,
        location: data.location,
        type: 'SALE_VOID',
        qty: -soldQty,
        balanceAfterQty: restoredQty,
        referenceType: 'sale',
        referenceId: saleId,
        createdByStaffId: actor.staffId,
        createdAt: now,
      });
    });

    // Stamped, not deleted: the receivable existed and then was withdrawn.
    for (const payment of payments) {
      tx.update(payment.ref, { status: 'voided', voidedAt: now, voidedByStaffId: actor.staffId });
    }

    tx.update(saleRef, {
      status: 'VOIDED',
      voidedAt: now,
      voidedByStaffId: actor.staffId,
      voidReason: reason,
    });

    tx.create(db.collection('audit_logs').doc(), {
      tenantId: actor.tenantId,
      branchId: sale.branchId ?? null,
      actorStaffId: actor.staffId,
      action: 'sale.voided',
      entityType: 'sale',
      entityId: saleId,
      metadata: { invoiceNumber: sale.invoiceNumber ?? null, reason, totalMinor: sale.totalMinor ?? null },
      createdAt: now,
    });

    return { saleId, saleUuid, voided: true, restoredLines: restorations.length };
  });
});

export const settleSale = onCall({ region: FUNCTION_REGION }, async (request) => {
  const actor = settlingStaff(request.auth?.token);
  const input = asRecord(request.data);
  // The till knows a sale by the key it submitted it under; the document id is
  // derived from that here, exactly as createSale derived it. Asking the client
  // for the document id would only work for sales it did not itself sell.
  const saleUuid = documentId(input.saleUuid, 'saleUuid');
  const saleId = deterministicId('sale', `${actor.tenantId}:${saleUuid}`);
  const requestId = documentId(input.requestId, 'requestId');
  const method = String(input.method ?? '');
  if (!METHODS.has(method)) throw new HttpsError('invalid-argument', 'Choose how the money arrived.');

  // An M-Pesa payment reaches us one of two ways: the customer sent it to the
  // till number themselves and reads the code off their SMS, or the till
  // pushed an STK prompt and the provider confirmed it against that attempt.
  // Both are the provider saying money arrived; only the proof differs.
  const attemptId = input.attemptId === undefined
    ? null
    : documentId(input.attemptId, 'attemptId');

  const typed = optionalText(input.reference, 'reference', 60) ?? '';
  const code = method === 'mpesa' ? typed.toUpperCase() : '';
  if (method === 'mpesa' && !attemptId && !code) {
    throw new HttpsError('invalid-argument', 'Enter the M-Pesa confirmation code from the payment message.');
  }
  // A code is recorded in the form the provider printed it, which is the form
  // it will be searched for in later.
  // An STK settlement takes its reference from the receipt the provider
  // returned, not from anything typed here.
  // Nothing here verifies a bank or card reference - there is no bank feed -
  // so whatever the cashier types is what gets recorded, including nothing.
  let reference = method === 'mpesa' ? code : typed;

  const saleRef = db.collection('sales').doc(saleId);
  // Derived from the transaction id, so a code finds its confirmation directly
  // rather than through a query and an index.
  const eventRef = db.collection('mpesa_c2b_events').doc(deterministicId('c2b', `confirmation:${code}`));
  const settingsRef = db.collection('tenant_settings').doc(actor.tenantId);
  const settlementRef = db.collection('payments').doc(
    deterministicId('sale-settlement', `${actor.tenantId}:${saleId}:${requestId}`),
  );

  return db.runTransaction(async (tx) => {
    const [saleDoc, settlementDoc, eventDoc, settingsDoc] = await tx.getAll(saleRef, settlementRef, eventRef, settingsRef);
    // A retry after a lost response returns what the first call did rather
    // than recording the same money twice.
    if (settlementDoc.exists) return { ...(settlementDoc.data()?.result ?? { saleId, saleUuid, settled: true }), paymentId: settlementRef.id };

    const sale = saleDoc.data();
    if (!saleDoc.exists || sale?.tenantId !== actor.tenantId) {
      throw new HttpsError('not-found', 'Sale not found.');
    }
    if (method === 'cash' && !settingsDoc.data()?.acceptedPaymentMethods?.includes('cash')) {
      throw new HttpsError('failed-precondition', 'This business does not accept cash.');
    }
    if (String(sale.status).toUpperCase() === 'VOIDED') throw new HttpsError('failed-precondition', 'This order was voided.');
    if (Number(sale.checkoutExpiresAt?.toMillis?.() || 0) > Date.now()
      && (input.checkoutId !== sale.checkoutId || actor.staffId !== sale.checkoutStaffId)) {
      throw new HttpsError('failed-precondition', 'Another device is taking payment for this order.');
    }
    if (sale.checkoutStkKey) {
      const previousId = deterministicId('mpesa-attempt', `${actor.tenantId}:${sale.checkoutStkKey}`);
      const previous = await tx.get(db.collection('mpesa_payments').doc(previousId));
      const blocked = attemptId === previousId
        ? null
        : attemptBlocks(previous.data(), method === 'mpesa' ? 'mpesa' : 'other', Date.now());
      if (blocked) throw new HttpsError('failed-precondition', blocked);
    }

    const paymentDocs = await tx.get(
      db.collection('payments').where('saleId', '==', saleId),
    );
    // Only the three fields settlement reasons about; spreading the document
    // would hand TypeScript an index signature and lose all of them.
    const payments = paymentDocs.docs.map((doc) => ({
      ref: doc.ref as FirebaseFirestore.DocumentReference,
      method: doc.data().method as unknown,
      amountMinor: doc.data().amountMinor as unknown,
      settledAt: doc.data().settledAt as unknown,
    }));
    const dueMinor = outstandingMinor(payments);
    if (dueMinor <= 0) throw new HttpsError('failed-precondition', 'Nothing is outstanding on this sale.');

    const now = Timestamp.now();
    let receivedMinor = dueMinor;
    let verified = method === 'mpesa';

    if (method === 'mpesa' && attemptId) {
      // The till pushed an STK prompt and is settling against what the
      // provider confirmed for it. The attempt is the proof, exactly as the
      // C2B event is below, and is consumed the same way.
      const attemptRef = db.collection('mpesa_payments').doc(attemptId);
      const attemptDoc = await tx.get(attemptRef);
      const attempt = attemptDoc.data();
      if (!attemptDoc.exists || attempt?.tenantId !== actor.tenantId) {
        throw new HttpsError('not-found', 'That M-Pesa payment attempt does not belong to this business.');
      }
      if (String(attempt.status).toLowerCase() !== 'paid') {
        throw new HttpsError('failed-precondition', 'M-Pesa has not confirmed that payment. Do not release goods on it.');
      }
      if (attempt.branchId !== sale.branchId || attempt.customerOrderId) {
        throw new HttpsError('failed-precondition', 'That payment belongs to another branch or customer order.');
      }
      const intentRef = db.collection('payment_intents').doc(deterministicId('intent', `${actor.tenantId}:${String(attempt.receipt || '')}`));
      const intentDoc = await tx.get(intentRef);
      const intent = intentDoc.data();
      if (!intentDoc.exists || intent?.tenantId !== actor.tenantId || intent?.attemptId !== attemptId
        || intent?.amountMinor !== attempt.amountMinor
        || (intent?.consumedSaleId && intent?.settlementAttemptId !== attemptId)
        || (!intent?.consumedSaleId && intent?.status !== 'verified')) {
        throw new HttpsError('failed-precondition', 'That payment is unavailable or was already used for another sale.');
      }
      // One prompt pays for a whole table, and a table is several rounds, so
      // an attempt may clear more than one sale - up to what was actually
      // paid. Each round takes its due out of the headroom that is left, so
      // the rounds settled against a payment can never exceed it.
      const alreadySettled: string[] = Array.isArray(attempt.settledSaleIds)
        ? attempt.settledSaleIds
        : (attempt.settledSaleId ? [attempt.settledSaleId] : []);
      if (alreadySettled.includes(saleId)) {
        throw new HttpsError('failed-precondition', 'This sale is already settled by that payment.');
      }
      receivedMinor = Number(attempt.amountMinor || 0);
      const consumedMinor = Number(attempt.settledMinor || 0);
      const headroomMinor = receivedMinor - consumedMinor;
      if (headroomMinor < dueMinor) {
        throw new HttpsError('failed-precondition', consumedMinor > 0
          ? `That payment has KES ${(headroomMinor / 100).toFixed(2)} left, short of the KES ${(dueMinor / 100).toFixed(2)} outstanding on this round.`
          : `That payment was KES ${(receivedMinor / 100).toFixed(2)}, short of the KES ${(dueMinor / 100).toFixed(2)} outstanding.`);
      }
      reference = String(attempt.receipt || attemptId);
      // Reserve the same provider intent createSale consumes. This prevents
      // one receipt being used once for settlement and again for a new sale.
      tx.update(intentRef, { status: 'consumed', consumedSaleId: intent?.consumedSaleId || saleId,
        settlementAttemptId: attemptId, consumedAt: now });
      tx.update(attemptRef, {
        settlementStatus: 'settled_sale',
        settledSaleIds: [...alreadySettled, saleId],
        // Kept so anything reading the single-sale field still finds a sale.
        settledSaleId: alreadySettled[0] ?? saleId,
        settledMinor: consumedMinor + dueMinor,
        settledAt: now,
        settledByStaffId: actor.staffId,
      });
    } else if (method === 'mpesa') {
      const event = eventDoc.data();
      // A typed code is never refused. It is verified only when an unused
      // confirmation covers the amount; otherwise it is the cashier's word, like
      // a bank reference, and Financials shows it as unverified.
      verified = eventDoc.exists
        && event?.tenantId === actor.tenantId
        && event?.disposition !== 'quarantined'
        && !event?.settledSaleId && !event?.settledCustomerOrderId
        && Number(event?.payload?.amountMinor || 0) >= dueMinor;
    }
    if (method === 'mpesa' && !attemptId && verified) {
      receivedMinor = Number(eventDoc.data()?.payload?.amountMinor || 0);
      // Consumed, so one payment cannot clear two invoices.
      tx.update(eventRef, {
        settlementStatus: 'settled_sale',
        settledSaleId: saleId,
        settledAt: now,
        settledByStaffId: actor.staffId,
      });
    }

    // The receivable rows are stamped rather than deleted: the sale still went
    // out on credit, and that is a fact about the night it happened.
    for (const payment of payments) {
      if (String(payment.method) !== 'credit' || payment.settledAt) continue;
      tx.update(payment.ref, {
        settledAt: now,
        settledByStaffId: actor.staffId,
        settledMethod: method,
        settledReference: reference || null,
      });
    }

    const result = {
      paymentId: settlementRef.id,
      saleId,
      saleUuid,
      method,
      reference: reference || null,
      settledMinor: dueMinor,
      receivedMinor,
      // Only the provider can confirm money arrived; everything else is a
      // member of staff asserting it did.
      verified,
    };

    tx.set(settlementRef, {
      tenantId: actor.tenantId,
      branchId: sale.branchId ?? null,
      saleId,
      method,
      amountMinor: dueMinor,
      reference: reference || null,
      status: 'completed',
      source: 'sale_settlement',
      verified: result.verified,
      receivedByStaffId: actor.staffId,
      paidAt: now,
      createdAt: now,
      result,
    });

    tx.create(db.collection('audit_logs').doc(), {
      tenantId: actor.tenantId,
      actorStaffId: actor.staffId,
      action: 'sale.settled',
      entityId: saleId,
      metadata: { invoiceNumber: sale.invoiceNumber ?? null, method, reference: reference || null, dueMinor, receivedMinor },
      createdAt: now,
    });

    return result;
  });
});
