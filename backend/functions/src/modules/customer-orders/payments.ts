import { Timestamp } from 'firebase-admin/firestore';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import { FUNCTION_REGION } from '../../config/runtime';
import { db } from '../../lib/firebase';
import { asRecord, documentId } from '../../shared/validation';
import { deterministicId } from '../../shared/identifiers';
import { MPESA_SECRETS, normalizePhone, parseMpesaConfig, sanitizeAccountReference } from '../mpesa/daraja';
import { startReservedMpesa, verifyAttempt, type Reservation } from '../mpesa';
import { serviceStaff } from './domain';
import { readReceiptUsage, receiptAllocation } from '../../shared/mpesa-receipt';
import { readReceiptBalance, allocateReceiptBalance } from '../sales/receipt-balance';
import { assertCustomerReceiptPrinted } from '../sales/printed-receipt';

/**
 * Payment for a table-menu order is driven from the counter, not the customer's
 * phone. The customer leaves the table with a tracking number; the cashier
 * finds the order by it and takes payment, which is what releases the kitchen
 * ticket. Every callable here therefore requires a signed-in member of staff.
 */

/** Both settlement paths refuse an order that is cancelled or already paid. */
function payableOrder(order: Record<string, unknown> | undefined, tenantId: string) {
  if (!order || order.tenantId !== tenantId) throw new HttpsError('not-found', 'Order not found.');
  if (order.status === 'cancelled') throw new HttpsError('failed-precondition', 'This order was cancelled.');
  if (order.paymentStatus === 'paid') throw new HttpsError('failed-precondition', 'This order is already paid.');
  assertCustomerReceiptPrinted(order);
  return order;
}

/** Sends the M-Pesa prompt to a number the cashier reads from the customer. */
export const chargeCustomerOrder = onCall({ region: FUNCTION_REGION, secrets: MPESA_SECRETS }, async (request) => {
  const actor = serviceStaff(request.auth?.token);
  const input = asRecord(request.data);
  const orderId = documentId(input.orderId, 'orderId');
  const paymentRequestId = documentId(input.paymentRequestId, 'paymentRequestId');
  const phone = normalizePhone(input.phone);
  const orderRef = db.collection('customer_orders').doc(orderId);
  const reservation: Reservation = await db.runTransaction(async (tx) => {
    const order = payableOrder((await tx.get(orderRef)).data(), actor.tenantId);
    const [tenant, branch, settings, configDoc] = await tx.getAll(db.collection('tenants').doc(String(order.tenantId)), db.collection('branches').doc(String(order.branchId)), db.collection('tenant_settings').doc(String(order.tenantId)), db.collection('mpesa_configs').doc(String(order.tenantId)));
    if (order.paymentAttemptId) {
      const activeRef = db.collection('mpesa_payments').doc(String(order.paymentAttemptId));
      const active = await tx.get(activeRef);
      // A prompt already in flight is resumed rather than duplicated, so a
      // second press of Pay now never bills the customer twice.
      if (active.exists && (active.data()?.status !== 'failed' || active.data()?.idempotencyKey === paymentRequestId)) {
        if (active.data()?.phone !== phone) throw new HttpsError('failed-precondition', 'A payment is already in progress on another number.');
        return { created: false, attemptId: active.id, attemptRef: activeRef, record: active.data()!, config: null };
      }
    }
    const config = parseMpesaConfig(configDoc.data());
    if (tenant.data()?.status !== 'active' || branch.data()?.tenantId !== order.tenantId || branch.data()?.status !== 'active' || !settings.data()?.acceptedPaymentMethods?.includes('mpesa') || config?.lifecycle !== 'live' || (config.allowedBranchIds && !config.allowedBranchIds.includes(String(order.branchId)))) throw new HttpsError('failed-precondition', 'M-Pesa is unavailable for this branch. Take another payment method.');
    if (!Number.isSafeInteger(order.totalMinor) || Number(order.totalMinor) <= 0 || Number(order.totalMinor) % 100 !== 0) throw new HttpsError('failed-precondition', 'M-Pesa requires a whole-shilling order total.');
    if (Number(order.paymentAttemptCount || 0) >= 5) throw new HttpsError('resource-exhausted', 'Too many payment attempts on this order.');
    const attemptId = deterministicId('mpesa-web', `${orderId}:${paymentRequestId}`);
    const attemptRef = db.collection('mpesa_payments').doc(attemptId);
    const now = Timestamp.now();
    const record = {
      id: attemptId, provider: 'mpesa', tenantId: order.tenantId, branchId: order.branchId, customerOrderId: orderId,
      phone, amountMinor: order.totalMinor, cartGrossMinor: order.totalMinor, baseAmountMinor: order.totalMinor, cashAmountMinor: 0,
      membershipDiscountMinor: 0, membershipDiscountBasisPoints: 0, lineDiscounts: [],
      staffId: actor.staffId,
      idempotencyKey: paymentRequestId, orderReference: order.ref, accountReference: config.transactionType === 'CustomerBuyGoodsOnline' ? sanitizeAccountReference(String(order.ref), config.accountReference) : config.accountReference,
      transactionType: config.transactionType, partyB: config.partyB, status: 'initiating', callbackClaim: null, requestedAt: now, updatedAt: now,
    };
    tx.create(attemptRef, record);
    tx.update(orderRef, { paymentAttemptId: attemptId, paymentAttemptCount: Number(order.paymentAttemptCount || 0) + 1 });
    return { created: true, attemptId, attemptRef, record, config };
  });
  const result = await startReservedMpesa(reservation);
  return { status: result.status, attemptId: reservation.attemptId, message: result.customerMessage || 'The M-Pesa prompt has been sent to the customer.' };
});

/**
 * Re-checks a prompt against M-Pesa.
 *
 * A lost callback would otherwise leave a paid order marked unpaid, and with
 * the kitchen ticket gated on payment that silently strands the food.
 */
export const checkCustomerOrderPayment = onCall({ region: FUNCTION_REGION, secrets: MPESA_SECRETS }, async (request) => {
  const actor = serviceStaff(request.auth?.token);
  const orderRef = db.collection('customer_orders').doc(documentId(asRecord(request.data).orderId, 'orderId'));
  const order = (await orderRef.get()).data();
  if (!order || order.tenantId !== actor.tenantId) throw new HttpsError('not-found', 'Order not found.');
  if (order.paymentStatus !== 'paid' && order.paymentAttemptId) {
    const mayQuery = await db.runTransaction(async (tx) => {
      const current = await tx.get(orderRef);
      const now = Date.now();
      if (now - Number(current.data()?.paymentQueriedAt || 0) < 10000) return false;
      tx.update(orderRef, { paymentQueriedAt: now }); return true;
    });
    if (mayQuery) await verifyAttempt(String(order.paymentAttemptId), db.collection('mpesa_payments').doc(String(order.paymentAttemptId)));
  }
  const latest = (await orderRef.get()).data()!;
  const attempt = latest.paymentAttemptId ? (await db.collection('mpesa_payments').doc(String(latest.paymentAttemptId)).get()).data() : null;
  return { orderId: orderRef.id, ref: latest.ref, paymentStatus: latest.paymentStatus, status: attempt?.status || 'unpaid', message: attempt?.resultDesc || attempt?.customerMessage || '', receipt: latest.paymentReference || null };
});

/** M-Pesa confirmation codes, as printed in the customer's SMS. */
const RECEIPT_CODE = /^[A-Za-z0-9]{6,32}$/;

/**
 * Settles an order against money M-Pesa has already confirmed receiving.
 *
 * The customer reads out the code from their SMS. It is matched against the
 * C2B confirmation the provider sent us, which the C2B module deliberately
 * parks as `manual_review_required` precisely because a paybill payment names
 * a tenant and not the order it was meant to pay for. This is that missing
 * reconciliation step.
 *
 * No match means no settlement. A code the provider never confirmed is a claim
 * about money, not money, and clearing an order on it would let anyone with the
 * counter screen mark food paid for by typing something.
 *
 * The confirmation is consumed as it settles, so one payment cannot clear two
 * orders.
 */
export const settleCustomerOrderByCode = onCall({ region: FUNCTION_REGION }, async (request) => {
  const actor = serviceStaff(request.auth?.token);
  const input = asRecord(request.data);
  const orderId = documentId(input.orderId, 'orderId');
  const code = String(input.code ?? '').trim().toUpperCase();
  if (!RECEIPT_CODE.test(code)) throw new HttpsError('invalid-argument', 'Enter the M-Pesa confirmation code from the customer’s message.');

  const orderRef = db.collection('customer_orders').doc(orderId);
  // The confirmation's id is derived from the transaction id, so the code finds
  // its record directly rather than through a query and an index.
  const eventRef = db.collection('mpesa_c2b_events').doc(deterministicId('c2b', `confirmation:${code}`));

  return db.runTransaction(async (tx) => {
    const [orderDoc, eventDoc] = await tx.getAll(orderRef, eventRef);
    const order = payableOrder(orderDoc.data(), actor.tenantId);
    const event = eventDoc.data();

    if (input.receiptAmountMinor !== undefined) {
      const branchId = documentId(order.branchId, 'branchId');
      const balance = await readReceiptBalance(tx, actor.tenantId, code, branchId, undefined, input.receiptAmountMinor);
      const dueMinor = Number(order.totalMinor || 0);
      if (balance.availableMinor < dueMinor) throw new HttpsError('failed-precondition', 'The unused receipt balance is less than the order total.');
      const now = Timestamp.now();
      const allocation = allocateReceiptBalance(tx, balance, { tenantId: actor.tenantId, branchId,
        staffId: actor.staffId, reference: code, target: `customer_order:${orderId}`, amountMinor: dueMinor, now });
      tx.update(orderRef, { paymentStatus: 'paid', paymentMethod: 'mpesa', paymentReference: code, paidAt: now,
        settledByStaffId: actor.staffId, status: order.status === 'received' ? 'awaiting_print' : order.status });
      tx.set(db.collection('payments').doc(`web_${orderId}`), { tenantId: actor.tenantId, branchId,
        customerOrderId: orderId, method: 'mpesa', amountMinor: dueMinor, receivedMinor: balance.amountMinor,
        reference: code, status: 'completed', paidAt: balance.paidAt || now, receivedByStaffId: actor.staffId,
        source: 'customer_menu_code', verified: balance.verified,
        receiptAllocationId: allocation.allocationId, receiptLimitMinor: allocation.limitMinor });
      tx.create(db.collection('audit_logs').doc(), { tenantId: actor.tenantId, actorStaffId: actor.staffId,
        action: 'customer_order.code_settled', entityId: orderId,
        metadata: { ref: order.ref, code, dueMinor, receivedMinor: balance.amountMinor,
          verified: balance.verified, receiptAllocationId: allocation.allocationId }, createdAt: now });
      return { orderId, paymentStatus: 'paid', receivedMinor: balance.amountMinor,
        availableMinor: balance.availableMinor - dueMinor, changeMinor: 0 };
    }

    if (!eventDoc.exists || event?.tenantId !== actor.tenantId || event?.disposition === 'quarantined') {
      throw new HttpsError('not-found', 'No M-Pesa payment with that code has reached this business. Check the code, or take another payment method.');
    }
    if (event.settledSaleId || event.settledProformaId) {
      throw new HttpsError('failed-precondition', 'That code has already settled another invoice.');
    }
    if (event.settledCustomerOrderId) {
      throw new HttpsError('failed-precondition', event.settledCustomerOrderId === orderId
        ? 'This order is already settled by that code.'
        : 'That code has already settled another order.');
    }
    const receivedMinor = Number(event.payload?.amountMinor || 0);
    const dueMinor = Number(order.totalMinor || 0);
    if (receivedMinor < dueMinor) {
      throw new HttpsError('failed-precondition', `That payment was KES ${(receivedMinor / 100).toFixed(2)}, short of the KES ${(dueMinor / 100).toFixed(2)} due.`);
    }

    const paidAt = Timestamp.now();
    const usage = await readReceiptUsage(tx, actor.tenantId, code);
    tx.set(usage.ref, receiptAllocation(usage, { tenantId: actor.tenantId, reference: code,
      allocationId: `customer_order:${orderId}`, target: `customer_order:${orderId}`,
      amountMinor: dueMinor, limitMinor: receivedMinor, verified: true, now: paidAt }));
    tx.update(orderRef, {
      paymentStatus: 'paid', paymentMethod: 'mpesa', paymentReference: code, paidAt,
      settledByStaffId: actor.staffId,
      status: order.status === 'received' ? 'awaiting_print' : order.status,
    });
    tx.set(db.collection('payments').doc(`web_${orderId}`), {
      tenantId: actor.tenantId, branchId: order.branchId, customerOrderId: orderId, method: 'mpesa',
      amountMinor: dueMinor, receivedMinor, reference: code, status: 'completed', paidAt,
      receivedByStaffId: actor.staffId, source: 'customer_menu_code',
    });
    // Consumed, so the same confirmation cannot clear a second order.
    tx.update(eventRef, {
      settlementStatus: 'settled_customer_order',
      settledCustomerOrderId: orderId,
      settledAt: paidAt,
      settledByStaffId: actor.staffId,
    });
    tx.create(db.collection('audit_logs').doc(), {
      tenantId: actor.tenantId, actorStaffId: actor.staffId, action: 'customer_order.code_settled',
      entityId: orderId, metadata: { ref: order.ref, code, dueMinor, receivedMinor }, createdAt: paidAt,
    });
    return { orderId, paymentStatus: 'paid', receivedMinor, changeMinor: receivedMinor - dueMinor };
  });
});

/**
 * Records an order settled on the card terminal.
 *
 * There is no card integration: the terminal takes the money and this records
 * that it did, with whatever reference the terminal printed. It is a record of
 * a payment taken elsewhere, not a charge, so it is written under the staff id
 * of whoever asserts it.
 */
export const settleCustomerOrderCard = onCall({ region: FUNCTION_REGION }, async (request) => {
  const actor = serviceStaff(request.auth?.token);
  const input = asRecord(request.data);
  const orderId = documentId(input.orderId, 'orderId');
  const reference = typeof input.reference === 'string' ? input.reference.trim().slice(0, 60) : '';
  const orderRef = db.collection('customer_orders').doc(orderId);

  return db.runTransaction(async (tx) => {
    const order = payableOrder((await tx.get(orderRef)).data(), actor.tenantId);
    const paidAt = Timestamp.now();
    tx.update(orderRef, {
      paymentStatus: 'paid', paymentMethod: 'card', paymentReference: reference || null, paidAt,
      settledByStaffId: actor.staffId,
      status: order.status === 'received' ? 'awaiting_print' : order.status,
    });
    tx.set(db.collection('payments').doc(`web_${orderId}`), {
      tenantId: actor.tenantId, branchId: order.branchId, customerOrderId: orderId, method: 'card',
      amountMinor: order.totalMinor, reference: reference || null, status: 'completed', paidAt,
      receivedByStaffId: actor.staffId, source: 'customer_menu',
    });
    tx.create(db.collection('audit_logs').doc(), {
      tenantId: actor.tenantId, actorStaffId: actor.staffId, action: 'customer_order.card_settled',
      entityId: orderId, metadata: { ref: order.ref, amountMinor: order.totalMinor, reference }, createdAt: paidAt,
    });
    return { orderId, paymentStatus: 'paid' };
  });
});

/**
 * Marries a received bank transfer to an unpaid customer order.
 * There is no bank feed, so nothing here can check the statement reference -
 * whatever the cashier types is recorded as typed, and the audit trail records
 * who performed the reconciliation.
 */
export const settleCustomerOrderBank = onCall({ region: FUNCTION_REGION }, async (request) => {
  const actor = serviceStaff(request.auth?.token);
  const input = asRecord(request.data);
  const orderId = documentId(input.orderId, 'orderId');
  const reference = typeof input.reference === 'string' ? input.reference.trim().slice(0, 60) : '';
  const orderRef = db.collection('customer_orders').doc(orderId);

  return db.runTransaction(async (tx) => {
    const order = payableOrder((await tx.get(orderRef)).data(), actor.tenantId);
    const paidAt = Timestamp.now();
    tx.update(orderRef, {
      paymentStatus: 'paid', paymentMethod: 'bank_transfer', paymentReference: reference || null, paidAt,
      settledByStaffId: actor.staffId,
      status: order.status === 'received' ? 'awaiting_print' : order.status,
    });
    tx.set(db.collection('payments').doc(`web_${orderId}`), {
      tenantId: actor.tenantId, branchId: order.branchId, customerOrderId: orderId,
      method: 'bank_transfer', amountMinor: order.totalMinor, reference: reference || null,
      status: 'completed', paidAt, receivedByStaffId: actor.staffId,
      source: 'customer_menu_bank', verified: false,
    });
    tx.create(db.collection('audit_logs').doc(), {
      tenantId: actor.tenantId, actorStaffId: actor.staffId,
      action: 'customer_order.bank_settled', entityId: orderId,
      metadata: { ref: order.ref, amountMinor: order.totalMinor, reference }, createdAt: paidAt,
    });
    return { orderId, paymentStatus: 'paid', reference };
  });
});

/**
 * Records cash taken at the counter for a table-menu order.
 *
 * Without this a cash house could never release a kitchen ticket, because the
 * ticket is gated on payment and only the M-Pesa callback would ever clear it.
 * It is refused unless the tenant actually accepts cash.
 */
export const settleCustomerOrderCash = onCall({ region: FUNCTION_REGION }, async (request) => {
  const actor = serviceStaff(request.auth?.token);
  const orderId = documentId(asRecord(request.data).orderId, 'orderId');
  const orderRef = db.collection('customer_orders').doc(orderId);
  return db.runTransaction(async (tx) => {
    const order = payableOrder((await tx.get(orderRef)).data(), actor.tenantId);
    const settings = await tx.get(db.collection('tenant_settings').doc(actor.tenantId));
    if (!settings.data()?.acceptedPaymentMethods?.includes('cash')) throw new HttpsError('failed-precondition', 'This business does not accept cash.');
    const paidAt = Timestamp.now();
    tx.update(orderRef, { paymentStatus: 'paid', paymentMethod: 'cash', paidAt, settledByStaffId: actor.staffId, status: order.status === 'received' ? 'awaiting_print' : order.status });
    tx.set(db.collection('payments').doc(`web_${orderId}`), {
      tenantId: actor.tenantId, branchId: order.branchId, customerOrderId: orderId, method: 'cash',
      amountMinor: order.totalMinor, reference: null, status: 'completed', paidAt,
      receivedByStaffId: actor.staffId, source: 'customer_menu',
    });
    tx.create(db.collection('audit_logs').doc(), {
      tenantId: actor.tenantId, actorStaffId: actor.staffId, action: 'customer_order.cash_settled',
      entityId: orderId, metadata: { ref: order.ref, amountMinor: order.totalMinor }, createdAt: paidAt,
    });
    return { orderId, paymentStatus: 'paid', amountMinor: order.totalMinor };
  });
});
