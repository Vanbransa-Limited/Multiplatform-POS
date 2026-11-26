import { Timestamp, type DocumentData, type Transaction } from 'firebase-admin/firestore';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import { FUNCTION_REGION } from '../../config/runtime';
import { db } from '../../lib/firebase';
import { deterministicId } from '../../shared/identifiers';
import { readReceiptUsage, receiptTarget } from '../../shared/mpesa-receipt';
import { asRecord, documentId, minorUnits } from '../../shared/validation';
import { SELLING_ROLES } from './constants';

export function receiptCode(value: unknown): string {
  const code = String(value ?? '').trim().toUpperCase();
  if (!/^[A-Z0-9]{10}$/.test(code)) throw new HttpsError('invalid-argument', 'Enter the ten-character M-Pesa confirmation code.');
  return code;
}

const LOOK_ALIKE = [['O', '0'], ['I', '1', 'L'], ['S', '5'], ['B', '8'], ['Z', '2']];

/**
 * Codes one misread character away from this one (O/0, I/1/L, S/5, B/8, Z/2).
 * UKPH53LY0K was typed for UKPH53LYOK on 25 Nov 2026 and one KES 260 payment
 * cleared two bills. ponytail: single swaps only; two misreads in one code pass.
 */
export function lookAlikeCodes(code: string): string[] {
  const out = new Set<string>();
  [...code].forEach((char, i) => LOOK_ALIKE.find(group => group.includes(char))
    ?.filter(other => other !== char).forEach(other => out.add(code.slice(0, i) + other + code.slice(i + 1))));
  return [...out];
}

/** Ongoing entry is an explicit, audited opt-in; a missing expiry never enables it. */
export function internalReceiptEntryEnabled(control: DocumentData | undefined, tenantId: string, branchId: string, nowMs = Date.now(), branch?: DocumentData): boolean {
  if (control?.tenantId !== tenantId || control.mode !== 'internal') return false;
  if (control.policyVersion === 2 || control.policyVersion === 3) {
    // New branches inherit the standard only when they belong to this business.
    return control.entryMode === (control.policyVersion === 3 ? 'staff_entry' : 'recorded_only') && control.branchScope === 'tenant'
      && control.duration === 'ongoing' && control.until === null
      && typeof control.authorizationId === 'string' && control.authorizationId.length > 0
      && branch?.tenantId === tenantId && branch.status === 'active';
  }
  if (!Array.isArray(control.branchIds) || !control.branchIds.includes(branchId)) return false;
  if (control.duration === 'ongoing') {
    return control.policyVersion === 1 && control.until === null
      && typeof control.authorizationId === 'string' && control.authorizationId.length > 0;
  }
  return (control.duration === undefined || control.duration === 'temporary')
    && Number(control.until?.toMillis?.() || 0) > nowMs;
}

/** All proof and allocation reads happen inside the settlement transaction. */
export async function readReceiptBalance(tx: Transaction, tenantId: string, code: string, branchId: string, saleId?: string, manualAmountMinor?: unknown) {
  const eventRef = db.collection('mpesa_c2b_events').doc(deterministicId('c2b', `confirmation:${code}`));
  const intentRef = db.collection('payment_intents').doc(deterministicId('intent', `${tenantId}:${code}`));
  const [[eventDoc, intentDoc, branchDoc], usage, controlDoc] = await Promise.all([
    tx.getAll(eventRef, intentRef, db.collection('branches').doc(branchId)),
    readReceiptUsage(tx, tenantId, code),
    tx.get(db.collection('mpesa_receipt_controls').doc(tenantId)),
  ]);
  const control = controlDoc.data(), branch = branchDoc.data();
  if ([2, 3].includes(control?.policyVersion) && (branch?.tenantId !== tenantId || branch.status !== 'active')) {
    throw new HttpsError('not-found', 'This branch is unavailable for this business.');
  }
  const event = eventDoc.data(), intent = intentDoc.data();
  let amountMinor = 0, consumedMinor = 0, verified = true;
  let paidAt: Timestamp | undefined;
  let attemptRef: FirebaseFirestore.DocumentReference | null = null;
  let attempt: DocumentData | undefined;
  let manualEntry = false, internalOnly = false;
  let entryUntil: Timestamp | null = null;
  let entryAuthorizationId: string | null = null;
  if (intent?.tenantId === tenantId && typeof intent.attemptId === 'string') {
    attemptRef = db.collection('mpesa_payments').doc(intent.attemptId);
    attempt = (await tx.get(attemptRef)).data();
    if (!attempt || attempt.tenantId !== tenantId || attempt.status !== 'paid' || attempt.receipt !== code
      || attempt.amountMinor !== intent.amountMinor || !['verified', 'consumed'].includes(intent.status)) {
      throw new HttpsError('failed-precondition', 'M-Pesa has not confirmed that payment.');
    }
    if (attempt.branchId !== branchId || attempt.customerOrderId
      || (intent.consumedSaleId && intent.settlementAttemptId !== intent.attemptId)
      || (saleId && Array.isArray(attempt.settlementSaleIds) && !attempt.settlementSaleIds.includes(saleId))) {
      throw new HttpsError('failed-precondition', 'That payment belongs to another branch, order or sale.');
    }
    amountMinor = Number(attempt.amountMinor);
    consumedMinor = Number(attempt.settledMinor || 0);
    paidAt = attempt.completedAt || intent.createdAt;
  } else if (event?.tenantId === tenantId && event.disposition !== 'quarantined') {
    if (Array.isArray(event.branchIds) && event.branchIds.length && !event.branchIds.includes(branchId)) {
      throw new HttpsError('failed-precondition', 'That payment belongs to another branch or invoice.');
    }
    amountMinor = Number(event.payload?.amountMinor || 0);
    consumedMinor = Number(event.settledMinor || 0);
    // Old confirmations did not store the allocated amount. Never invent headroom.
    if ((event.settledSaleId || event.settledProformaId || event.settledCustomerOrderId)
      && !consumedMinor && !usage.payments.length && !usage.claim) {
      throw new HttpsError('failed-precondition', 'That receipt needs reconciliation before its remaining balance can be used.');
    }
    paidAt = event.receivedAt || event.createdAt;
  } else if (usage.claim?.amountSource === 'reviewed_receipt' && usage.claim?.tenantId === tenantId
    && usage.claim.branchId === branchId && usage.claim.reconciliationId) {
    // An explicit audited historical correction is not provider verification.
    amountMinor = Number(usage.claim.limitMinor);
    paidAt = usage.claim.paidAt;
    verified = false;
  } else if (usage.claim?.amountSource === 'staff_recorded_receipt' && usage.claim.tenantId === tenantId) {
    if (usage.claim.branchId !== branchId) throw new HttpsError('failed-precondition', 'That receipt is registered to another branch.');
    amountMinor = Number(usage.claim.limitMinor);
    if (manualAmountMinor !== undefined && manualAmountMinor !== amountMinor) {
      throw new HttpsError('failed-precondition', `This reference already has a recorded total of KES ${(amountMinor / 100).toFixed(2)}. Its amount cannot be changed here.`);
    }
    paidAt = usage.claim.paidAt;
    verified = false;
    internalOnly = true;
  } else {
    const enabled = internalReceiptEntryEnabled(control, tenantId, branchId, Date.now(), branch);
    if (!enabled) throw new HttpsError('not-found', 'No confirmed M-Pesa payment with that code has reached this business. Check the code or reconcile the receipt.');
    // Include paid prompts shown in the M-Pesa tab even if a legacy intent is missing.
    const [prompts, providerReceipt] = await Promise.all([
      tx.get(db.collection('mpesa_payments').where('receipt', '==', code)),
      tx.get(db.collection('mpesa_receipts').doc(deterministicId('mpesa-receipt', code))),
    ]);
    if (eventDoc.exists || intentDoc.exists || providerReceipt.exists
      || prompts.docs.some(doc => doc.data().tenantId === tenantId && doc.data().status === 'paid')) {
      throw new HttpsError('failed-precondition', 'This reference already has a payment record that needs reconciliation. It cannot be entered as a new receipt.');
    }
    const usedMinor = Math.max(Number(usage.claim?.allocatedMinor || 0), usage.payments.reduce((sum, row) => sum + Number(row.amountMinor || 0), 0));
    if (usage.claim || usage.payments.length) {
      // A historical row proves previous use, not extra money on its receipt.
      if (!Number.isSafeInteger(usedMinor) || usedMinor <= 0) throw new HttpsError('failed-precondition', 'That reference is already registered. Reconcile its recorded balance.');
      amountMinor = usedMinor;
      consumedMinor = usedMinor;
    } else {
      if (usage.foreignPaymentExists) throw new HttpsError('failed-precondition', 'This code is already registered to another business.');
      if (control?.entryMode === 'recorded_only') {
        throw new HttpsError('not-found', 'No saved M-Pesa payment matches this code. Check the code or have the received payment reconciled into the register. No payment was applied.');
      }
      if (manualAmountMinor === undefined) throw new HttpsError('failed-precondition', 'Enter the amount on the M-Pesa receipt.');
      // A brand-new typed code that is one misread away from a recorded one is that receipt again.
      const twins = lookAlikeCodes(code);
      // getAll() with no references throws; a code with no misreadable
      // character has no twins (every such payment failed with "internal", 26 Nov 2026).
      const twinDocs = twins.length ? await tx.getAll(...twins.map(twin => db.collection('payment_receipt_claims')
        .doc(deterministicId('mpesa-receipt', `${tenantId}:${twin}`)))) : [];
      const twin = twinDocs.findIndex(doc => doc.data()?.tenantId === tenantId);
      if (twin >= 0) {
        throw new HttpsError('failed-precondition', `${code} looks like ${twins[twin]}, which is already recorded. `
          + 'Check each letter O / zero and I / one on the customer\'s message. If it really is a different payment, ask a manager to reconcile it.');
      }
      amountMinor = minorUnits(manualAmountMinor, 'Receipt amount', false);
      manualEntry = true;
      entryUntil = control?.until || null;
      entryAuthorizationId = control?.authorizationId || null;
    }
    verified = false;
    internalOnly = true;
  }
  const allocatedMinor = Math.max(consumedMinor, Number(usage.claim?.allocatedMinor || 0),
    usage.payments.reduce((sum, row) => sum + Number(row.amountMinor || 0), 0));
  if (manualAmountMinor !== undefined && minorUnits(manualAmountMinor, 'Receipt amount', false) !== amountMinor) {
    throw new HttpsError('failed-precondition', `This code was recorded for KES ${(amountMinor / 100).toFixed(2)}. Enter the original receipt amount.`);
  }
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0 || !Number.isSafeInteger(allocatedMinor) || allocatedMinor < 0
    || allocatedMinor > amountMinor) throw new HttpsError('failed-precondition', 'That receipt has inconsistent allocations and needs reconciliation.');
  return { usage, event, eventRef, intent, intentRef, attempt, attemptRef, amountMinor, allocatedMinor,
    availableMinor: amountMinor - allocatedMinor, verified, paidAt, manualEntry, internalOnly, entryUntil, entryAuthorizationId };
}

const kes = (minor: number) => `KES ${(minor / 100).toFixed(2)}`;
const TARGET_COLLECTIONS: Record<string, string> = { sale: 'sales', proforma: 'proformas', customer_order: 'customer_orders' };

/**
 * Why a receipt cannot pay this bill, in figures staff can check. Reads only
 * on the refusal path, before any write, and names an earlier bill only when
 * it belongs to this business; anything else is "another bill". Provider-backed
 * totals are "received"; staff-entered or inferred totals are "recorded".
 */
export async function describeReceiptUse(tx: Transaction, tenantId: string,
  balance: Pick<Awaited<ReturnType<typeof readReceiptBalance>>, 'usage' | 'amountMinor' | 'allocatedMinor' | 'verified'>, currentTarget?: string) {
  const targets: string[] = [...new Set<string>(Array.isArray(balance.usage.claim?.targets) && balance.usage.claim.targets.length
    ? balance.usage.claim.targets : balance.usage.payments.map(receiptTarget).filter(Boolean))];
  const shown = targets.slice(0, 3);
  const refs = shown.map(target => {
    const split = target.indexOf(':'), collection = TARGET_COLLECTIONS[target.slice(0, split)];
    return target !== currentTarget && collection && split > 0 ? db.collection(collection).doc(target.slice(split + 1)) : null;
  });
  const wanted = refs.filter((ref): ref is FirebaseFirestore.DocumentReference => ref !== null);
  const docs = wanted.length ? await tx.getAll(...wanted) : [];
  let read = 0;
  const names = shown.map((target, index) => {
    if (target === currentTarget) return 'this bill';
    if (!refs[index]) return 'another bill';
    const data = docs[read++]?.data();
    const name = data?.tenantId === tenantId ? data.invoiceNumber || data.invoice?.number || data.ref : null;
    return typeof name === 'string' && name ? name : 'another bill';
  });
  const others = targets.length - shown.length;
  const where = names.length ? ` on ${[...new Set(names)].join(', ')}${others > 0 ? ` and ${others} other bill${others === 1 ? '' : 's'}` : ''}` : '';
  return `That M-Pesa receipt has no unallocated money left: ${balance.verified ? 'received' : 'recorded'} ${kes(balance.amountMinor)}, `
    + `already used ${kes(balance.allocatedMinor)}${where}, remaining ${kes(Math.max(0, balance.amountMinor - balance.allocatedMinor))}.`;
}

/** All callers read first; this writes one shared, capped allocation and its provenance. */
export function allocateReceiptBalance(tx: Transaction, balance: Awaited<ReturnType<typeof readReceiptBalance>>, input: {
  tenantId: string; branchId: string; staffId: string; reference: string;
  target: string; amountMinor: number; now: Timestamp;
}) {
  if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0 || input.amountMinor > balance.availableMinor) {
    throw new HttpsError('failed-precondition', 'That code has insufficient unused balance.');
  }
  const allocation = { ...balance.usage.claim, tenantId: input.tenantId, provider: 'mpesa', reference: input.reference,
    ...(balance.manualEntry ? { amountSource: 'staff_recorded_receipt', branchId: input.branchId,
      createdAt: input.now, paidAt: input.now, recordedByStaffId: input.staffId,
      entryPolicyUntil: balance.entryUntil, entryAuthorizationId: balance.entryAuthorizationId } : {}),
    allocationId: balance.usage.claim?.allocationId || `receipt:${input.tenantId}:${input.reference}`,
    targets: [...new Set([...(balance.usage.claim?.targets || []), ...balance.usage.payments.map(row =>
      row.proformaId ? `proforma:${row.proformaId}` : row.customerOrderId ? `customer_order:${row.customerOrderId}` : `sale:${row.saleId}`), input.target])],
    allocatedMinor: balance.allocatedMinor + input.amountMinor, limitMinor: balance.amountMinor,
    verified: balance.verified, updatedAt: input.now };
  tx.set(balance.usage.ref, allocation);
  const split = input.target.indexOf(':'), kind = input.target.slice(0, split), id = input.target.slice(split + 1);
  const field = kind === 'proforma' ? 'settledProformaId' : kind === 'customer_order' ? 'settledCustomerOrderId' : 'settledSaleId';
  const source = balance.attempt || balance.event;
  const update = { settlementStatus: kind === 'proforma' ? 'settled_proforma' : kind === 'customer_order' ? 'settled_customer_order' : 'settled_sale',
    [field]: source?.[field] || id,
    ...(kind === 'sale' ? { settledSaleIds: [...new Set([...(source?.settledSaleIds || []), id])] } : {}),
    settledMinor: allocation.allocatedMinor, settledAt: input.now, settledByStaffId: input.staffId };
  if (balance.attemptRef && balance.attempt) {
    tx.update(balance.intentRef, { status: 'consumed', consumedSaleId: balance.intent?.consumedSaleId || id,
      settlementAttemptId: balance.attemptRef.id, consumedAt: input.now });
    tx.update(balance.attemptRef, update);
  } else if (balance.event?.tenantId === input.tenantId) tx.update(balance.eventRef, update);
  return allocation;
}

export const lookupMpesaReceipt = onCall({ region: FUNCTION_REGION, timeoutSeconds: 12 }, async request => {
  const token = request.auth?.token;
  if (!token?.tenant_id || !token.staff_id || !SELLING_ROLES.has(String(token.staff_role))) {
    throw new HttpsError('permission-denied', 'Sign in to check an M-Pesa receipt.');
  }
  const input = asRecord(request.data), reference = receiptCode(input.reference);
  const branchId = documentId(input.branchId, 'branchId');
  return db.runTransaction(async tx => {
    const balance = await readReceiptBalance(tx, String(token.tenant_id), reference, branchId, undefined, input.receiptAmountMinor);
    return { reference, receivedMinor: balance.amountMinor, allocatedMinor: balance.allocatedMinor,
      availableMinor: balance.availableMinor, verified: balance.verified,
      ...(balance.internalOnly ? { internalOnly: true, registerOnPayment: balance.manualEntry } : {}) };
  }, { readOnly: true });
});
