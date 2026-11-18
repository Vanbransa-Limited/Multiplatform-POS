import { Timestamp, type Transaction } from "firebase-admin/firestore";
import { HttpsError } from "firebase-functions/v2/https";

import { db } from "../../lib/firebase";
import { deterministicId } from "../../shared/identifiers";
import { readReceiptUsage, receiptAllocation } from '../../shared/mpesa-receipt';
import { needsProviderIntent } from "./constants";
import { mpesaIntentMatchesSale } from "./domain";
import { sellingLocation } from '../stock';
import type {
  ParsedSaleInput,
  PreparedLine,
  SaleDependencies,
} from "./types";

function stockBalanceId(branchId: string, productId: string, location: string): string {
  // This is an existing persistence contract. Changing it requires a data migration.
  return `${branchId}_${productId}_${location}`;
}

export async function loadSaleDependencies(
  transaction: Transaction,
  input: ParsedSaleInput,
  preparedLines: readonly PreparedLine[],
  timestamp: Timestamp,
  settings: Record<string, unknown> = {},
): Promise<SaleDependencies> {
  const location = sellingLocation();
  const candidateLines = preparedLines.filter((line) => !line.isService);
  const candidateRefs = candidateLines.map((line) =>
    db.collection("stock_balances").doc(
      stockBalanceId(input.branchId, line.productId, location),
    ),
  );

  const digitalPayments = input.payments.filter(
    (payment) => needsProviderIntent(payment.method, payment.unverified),
  );
  for (const payment of digitalPayments) {
    if (!payment.reference) {
      throw new HttpsError(
        "failed-precondition",
        `${payment.method} requires a verified provider reference.`,
      );
    }
  }
  const paymentIntentRefs = digitalPayments.map((payment) =>
    db.collection("payment_intents").doc(
      deterministicId("intent", `${input.tenantId}:${payment.reference}`),
    ),
  );

  const dependencyRefs = [...candidateRefs, ...paymentIntentRefs];
  const dependencyDocuments = dependencyRefs.length
    ? await transaction.getAll(...dependencyRefs)
    : [];
  const candidateDocuments = dependencyDocuments.slice(0, candidateRefs.length);
  const paymentIntentDocuments = dependencyDocuments.slice(candidateRefs.length);

  // The till has already sold this and taken the money, so stock never refuses
  // it: refusing stranded the sale on the device, out of Orders and Financials.
  // An item with no balance is not counted and moves nothing; a counted item is
  // deducted even past zero, so the shortfall shows up on the stock screens.
  const counted = candidateDocuments.flatMap((snapshot, index) => {
    const line = candidateLines[index];
    const balance = snapshot.data() ?? {};
    return snapshot.exists
      && balance.tenantId === input.tenantId
      && balance.branchId === input.branchId
      && balance.productId === line.productId
      && balance.location === location
      && Number.isSafeInteger(balance.qty)
      ? [{ line, balance, snapshot, ref: candidateRefs[index] }]
      : [];
  });
  const physicalLines = counted.map((entry) => entry.line);
  const balanceRefs = counted.map((entry) => entry.ref);

  const updatedBalances = counted.map(({ line, balance, snapshot }) => {
    return {
      id: snapshot.id,
      tenantId: input.tenantId,
      branchId: input.branchId,
      productId: line.productId,
      location,
      qty: balance.qty - line.qty,
      updatedAt: timestamp,
    };
  });

  paymentIntentDocuments.forEach((snapshot, index) => {
    const expected = digitalPayments[index];
    const intent = snapshot.data() ?? {};
    if (
      !snapshot.exists
      || intent.tenantId !== input.tenantId
      || intent.method !== expected.method
      || intent.amountMinor !== expected.amountMinor
      || intent.status !== "verified"
      || intent.consumedSaleId
      || (Array.isArray(intent.settlementSaleIds) && intent.settlementSaleIds.length > 0)
      || (
        expected.method === "mpesa"
        && !mpesaIntentMatchesSale(input, preparedLines, intent, expected)
      )
    ) {
      throw new HttpsError(
        "failed-precondition",
        `Payment reference for ${expected.method} is not verified or was already consumed.`,
      );
    }
  });

  const receiptClaims = [];
  const receiptConflicts: string[] = [];
  const codes = new Set<string>();
  for (const payment of input.payments.filter(row => row.method === 'mpesa' && row.reference)) {
    const reference = payment.reference!.trim().toUpperCase();
    if (codes.has(reference)) throw new HttpsError('invalid-argument', 'Enter each M-Pesa receipt only once.');
    codes.add(reference);
    const usage = await readReceiptUsage(transaction, input.tenantId, reference);
    try { receiptClaims.push({ ref: usage.ref, data: receiptAllocation(usage, {
      tenantId: input.tenantId, reference, allocationId: `sale:${deterministicId('sale', `${input.tenantId}:${input.idempotencyKey}`)}`,
      target: `sale:${deterministicId('sale', `${input.tenantId}:${input.idempotencyKey}`)}`,
      amountMinor: payment.amountMinor, limitMinor: payment.amountMinor, verified: !payment.unverified, now: timestamp,
    }) }); } catch (error) {
      // A completed offline sale must reach the business even when the
      // cashier reused a code. Retain it for review without claiming money.
      if (!payment.unverified || !(error instanceof HttpsError) || error.code !== 'failed-precondition') throw error;
      receiptConflicts.push(reference);
    }
  }
  return {
    receiptClaims,
    receiptConflicts,
    physicalLines,
    digitalPayments,
    balanceRefs,
    paymentIntentRefs,
    paymentIntentDocuments,
    updatedBalances,
  };
}
