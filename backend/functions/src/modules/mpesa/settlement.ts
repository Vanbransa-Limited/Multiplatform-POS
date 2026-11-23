import { HttpsError } from 'firebase-functions/v2/https';
import type { Transaction } from 'firebase-admin/firestore';
import { db } from '../../lib/firebase';
import { deterministicId } from '../../shared/identifiers';
import { outstandingMinor } from '../sales/settle';
import { assertSaleReceiptPrinted } from '../sales/printed-receipt';

/** A payment on a saved bill uses its locked ledger, never today's menu prices. */
export async function claimedBillAmount(tx: Transaction, actor: { tenantId: string; staffId: string },
  input: { saleUuids: string[]; branchId: string; checkoutId: string; stkKey: string }, nowMs: number) {
  const refs = input.saleUuids.map(uuid => db.collection('sales').doc(deterministicId('sale', `${actor.tenantId}:${uuid}`)));
  const sales = await tx.getAll(...refs);
  let dueMinor = 0;
  for (const doc of sales) {
    const sale = doc.data();
    if (!doc.exists || sale?.tenantId !== actor.tenantId || sale.branchId !== input.branchId
      || String(sale.status).toUpperCase() === 'VOIDED' || sale.proformaId) {
      throw new HttpsError('failed-precondition', 'The original bill is unavailable. Refresh orders before payment.');
    }
    if (sale.checkoutId !== input.checkoutId || sale.checkoutStaffId !== actor.staffId
      || sale.checkoutStkKey !== input.stkKey || Number(sale.checkoutExpiresAt?.toMillis?.() || 0) <= nowMs) {
      throw new HttpsError('failed-precondition', 'Reserve this bill before starting payment. Refresh orders and retry.');
    }
    const payments = await tx.get(db.collection('payments').where('saleId', '==', doc.id));
    await assertSaleReceiptPrinted(tx, doc.id, sale);
    dueMinor += outstandingMinor(payments.docs.map(row => row.data()));
  }
  if (!Number.isSafeInteger(dueMinor) || dueMinor <= 0) throw new HttpsError('failed-precondition', 'This bill is already paid. Refresh orders.');
  return { dueMinor, saleIds: sales.map(doc => doc.id) };
}
