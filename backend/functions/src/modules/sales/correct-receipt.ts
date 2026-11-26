import { Timestamp } from 'firebase-admin/firestore';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import { FUNCTION_REGION } from '../../config/runtime';
import { db } from '../../lib/firebase';
import { deterministicId } from '../../shared/identifiers';
import { asRecord, optionalText } from '../../shared/validation';
import { receiptCode } from './receipt-balance';

/** Largest single correction: a typo of an extra digit must not mint a fortune. */
const MAX_TOTAL_MINOR = 50_000_000;

/** Pure rules, so the refusals are testable without Firestore. */
export function correctionRefusal(claim: Record<string, unknown> | undefined, totalMinor: number, providerProof: boolean): string | null {
  if (!Number.isSafeInteger(totalMinor) || totalMinor <= 0 || totalMinor > MAX_TOTAL_MINOR) return 'Enter the amount on the M-Pesa message.';
  if (providerProof) return 'M-Pesa confirmed this payment itself; its amount cannot be changed.';
  if (!claim) return 'That code has not been recorded in this business.';
  if (!['staff_recorded_receipt', 'reviewed_receipt'].includes(String(claim.amountSource))) {
    return 'Only an amount typed in by staff can be corrected.';
  }
  const allocated = Number(claim.allocatedMinor || 0);
  if (totalMinor < allocated) {
    return `KES ${(allocated / 100).toFixed(2)} of this receipt is already used on bills. Void or reverse those first.`;
  }
  if (totalMinor === Number(claim.limitMinor)) return 'That is already the recorded amount.';
  return null;
}

/**
 * The owner corrects a staff-typed M-Pesa total (500 typed for 850, 25 Nov 2026)
 * instead of a developer running a script. It stays unverified: this is the
 * owner's word, not Safaricom's. Every correction leaves an audit row.
 */
export const correctReceiptTotal = onCall({ region: FUNCTION_REGION }, async (request) => {
  const token = request.auth?.token;
  if (!token?.tenant_id || !token.staff_id || token.staff_role !== 'owner') {
    throw new HttpsError('permission-denied', 'Only the owner can correct an M-Pesa amount.');
  }
  const tenantId = String(token.tenant_id), staffId = String(token.staff_id);
  const input = asRecord(request.data);
  const reference = receiptCode(input.reference);
  const totalMinor = Number(input.totalMinor);
  const reason = optionalText(input.reason, 'reason', 200) ?? '';
  if (!reason) throw new HttpsError('invalid-argument', 'Say why the amount is being corrected.');
  const claimRef = db.collection('payment_receipt_claims').doc(deterministicId('mpesa-receipt', `${tenantId}:${reference}`));
  const eventRef = db.collection('mpesa_c2b_events').doc(deterministicId('c2b', `confirmation:${reference}`));
  const intentRef = db.collection('payment_intents').doc(deterministicId('intent', `${tenantId}:${reference}`));

  return db.runTransaction(async (tx) => {
    const [claimDoc, eventDoc, intentDoc] = await tx.getAll(claimRef, eventRef, intentRef);
    const claim = claimDoc.data();
    const providerProof = (eventDoc.exists && eventDoc.data()?.tenantId === tenantId)
      || (intentDoc.exists && intentDoc.data()?.tenantId === tenantId);
    const refusal = correctionRefusal(claim?.tenantId === tenantId ? claim : undefined, totalMinor, providerProof);
    if (refusal) throw new HttpsError('failed-precondition', refusal);
    const now = Timestamp.now();
    const auditRef = db.collection('audit_logs').doc();
    const fromMinor = Number(claim!.limitMinor);
    // readReceiptBalance reads a reviewed_receipt with a reconciliationId as an audited correction.
    tx.update(claimRef, { amountSource: 'reviewed_receipt', limitMinor: totalMinor, verified: false,
      reconciliationId: `owner-correction:${auditRef.id}`, correctedFromMinor: fromMinor,
      correctedByStaffId: staffId, correctedAt: now, correctionReason: reason, updatedAt: now });
    tx.create(auditRef, { tenantId, branchId: claim!.branchId ?? null, actorStaffId: staffId, action: 'receipt.total_corrected',
      entityType: 'payment_receipt_claim', entityId: claimRef.id,
      metadata: { reference, fromMinor, toMinor: totalMinor, allocatedMinor: Number(claim!.allocatedMinor || 0), reason },
      createdAt: now });
    return { reference, fromMinor, totalMinor, availableMinor: totalMinor - Number(claim!.allocatedMinor || 0) };
  });
});
