import { createHash } from 'node:crypto';
import type { DocumentData, Transaction } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import { db } from '../../lib/firebase';

export const PRINT_FIRST_MESSAGE = 'Print the receipt before taking payment.';
/** Always enforced, independent of PRINT_BEFORE_PAYMENT: payment settles a bill already saved unpaid. */
export const SAVE_FIRST_MESSAGE = 'Save the bill unpaid before taking payment.';

/**
 * Off by the owner's request (2026-11-22): payment no longer waits for a
 * confirmed printed receipt. Bills are still saved unpaid first, then settled.
 * Keep in step with PRINT_BEFORE_PAYMENT in frontend/src/ui/checkout-print.js;
 * deploy functions before hosting when switching it back on.
 */
export const PRINT_BEFORE_PAYMENT = false;

/** Payment and print confirmation compare the same saved bill, including edits. */
export function receiptFingerprint(sale: DocumentData, lines: DocumentData[]) {
  return createHash('sha256').update(JSON.stringify({
    tenantId: sale.tenantId, branchId: sale.branchId,
    invoice: sale.invoiceNumber || sale.ref, table: sale.tableNumber || null,
    orderReference: sale.orderReference || null, buyerPin: sale.buyerKraPin || null,
    customer: sale.customerId || sale.customerName || null,
    subtotal: sale.subtotalMinor ?? null, tax: sale.taxMinor ?? null,
    total: sale.totalMinor,
    lines: lines.map(line => ({
      product: line.productId, name: line.productName || line.name,
      qty: line.qty, unit: line.unitPriceMinor,
      discount: line.discountMinor || 0, tax: line.taxMinor || 0,
      taxCode: line.taxCode || null,
      total: line.lineTotalMinor ?? line.totalMinor,
    })),
  })).digest('hex');
}

export async function saleReceiptLines(tx: Transaction, saleId: string) {
  const rows = await tx.get(db.collection('sale_lines').where('saleId', '==', saleId));
  return rows.docs.sort((a, b) => a.id.localeCompare(b.id)).map(doc => doc.data());
}

export function hasPrintedReceipt(sale: DocumentData, lines: DocumentData[]) {
  return Boolean(sale.printedReceipt?.confirmedAt
    && sale.printedReceipt?.fingerprint === receiptFingerprint(sale, lines));
}

export async function assertSaleReceiptPrinted(tx: Transaction, saleId: string, sale: DocumentData) {
  if (!PRINT_BEFORE_PAYMENT) return;
  if (!hasPrintedReceipt(sale, await saleReceiptLines(tx, saleId))) {
    throw new HttpsError('failed-precondition', PRINT_FIRST_MESSAGE);
  }
}

export function assertCustomerReceiptPrinted(order: DocumentData) {
  if (!PRINT_BEFORE_PAYMENT) return;
  if (!hasPrintedReceipt(order, order.lines || [])) {
    throw new HttpsError('failed-precondition', PRINT_FIRST_MESSAGE);
  }
}
