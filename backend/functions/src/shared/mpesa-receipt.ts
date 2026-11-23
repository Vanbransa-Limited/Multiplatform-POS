import { HttpsError } from 'firebase-functions/v2/https';
import type { DocumentData, DocumentReference, Timestamp, Transaction } from 'firebase-admin/firestore';
import { db } from '../lib/firebase';
import { deterministicId } from './identifiers';

export type ReceiptUsage = { ref: DocumentReference; claim: DocumentData | undefined; payments: DocumentData[]; foreignPaymentExists?: boolean };
export async function readReceiptUsage(tx: Transaction, tenantId: string, reference: string): Promise<ReceiptUsage> {
  const code = reference.trim().toUpperCase();
  const ref = db.collection('payment_receipt_claims').doc(deterministicId('mpesa-receipt', `${tenantId}:${code}`));
  // A single-field lookup also catches receipts recorded before claims existed.
  const [claim, ledger, providerLedger] = await Promise.all([
    tx.get(ref),
    tx.get(db.collection('payments').where('reference', '==', code)),
    tx.get(db.collection('payments').where('providerTransactionId', '==', code)),
  ]);
  const payments = [...new Map([...ledger.docs, ...providerLedger.docs].map(row => [row.id, row.data()])).values()].filter(row => row.tenantId === tenantId
    && String(row.method).toLowerCase() === 'mpesa'
    && ['completed', 'paid', 'success'].includes(String(row.status || 'completed').toLowerCase()));
  const foreignPaymentExists = [...ledger.docs, ...providerLedger.docs].some(row => row.data().tenantId !== tenantId);
  return { ref, claim: claim.data(), payments, foreignPaymentExists };
}

export const receiptTarget = (row: DocumentData) => row.proformaId ? `proforma:${row.proformaId}`
  : row.customerOrderId ? `customer_order:${row.customerOrderId}` : row.saleId ? `sale:${row.saleId}` : '';

/** Prepare a shared receipt allocation after all reads, before any writes. */
export function receiptAllocation(usage: ReceiptUsage, input: {
  tenantId: string; reference: string; allocationId: string; target: string;
  amountMinor: number; limitMinor: number; allowedTargets?: string[]; verified: boolean; now: Timestamp;
}) {
  const allowed = new Set(input.allowedTargets || []);
  if ((usage.claim && usage.claim.allocationId !== input.allocationId)
    || usage.payments.some(payment => !allowed.has(receiptTarget(payment)))) {
    throw new HttpsError('failed-precondition', 'That M-Pesa receipt is already recorded against another bill. Reconcile the original payment instead of reusing its code.');
  }
  const previous = Math.max(Number(usage.claim?.allocatedMinor || 0),
    usage.payments.reduce((sum, row) => sum + Number(row.amountMinor || 0), 0));
  const targets = new Set<string>(usage.claim?.targets || usage.payments.map(receiptTarget));
  if (targets.has(input.target) || previous + input.amountMinor > input.limitMinor) {
    throw new HttpsError('failed-precondition', 'That M-Pesa receipt has already been used or has insufficient unallocated money.');
  }
  targets.add(input.target);
  return { tenantId: input.tenantId, provider: 'mpesa', reference: input.reference.trim().toUpperCase(),
    allocationId: input.allocationId, targets: [...targets], allocatedMinor: previous + input.amountMinor,
    limitMinor: input.limitMinor, verified: input.verified, updatedAt: input.now };
}
