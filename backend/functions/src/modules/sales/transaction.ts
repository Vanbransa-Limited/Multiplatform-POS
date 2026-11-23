import { Timestamp } from "firebase-admin/firestore";
import { HttpsError } from 'firebase-functions/v2/https';
import { PRINT_FIRST_MESSAGE } from './printed-receipt';

import { db } from "../../lib/firebase";
import { deterministicId } from "../../shared/identifiers";
import { loadBaseSaleContext } from "./base-context";
import { loadSaleDependencies } from "./dependencies";
import {
  assertAcceptedPayments,
  assertDiscountPermission,
  calculateSaleTotals,
  hasProviderAuthorizedDiscount,
  prepareSaleLines,
} from "./domain";
import { saleRequestFingerprint } from "./fingerprint";
import { writeSaleRecords } from "./persistence";
import { buildSaleRecords } from "./records";
import { replaySale } from "./replay";
import { newSaleResponse } from "./response";
import { resolveSharedTab } from "./tab-identity";
import type { ParsedSaleInput } from "./types";

export async function executeCreateSale(
  input: ParsedSaleInput,
): Promise<Record<string, unknown>> {
  const saleId = deterministicId(
    "sale",
    `${input.tenantId}:${input.idempotencyKey}`,
  );
  const requestFingerprint = saleRequestFingerprint(input);
  const saleRef = db.collection("sales").doc(saleId);

  return db.runTransaction(async (transaction) => {
    const existingSale = await transaction.get(saleRef);
    if (existingSale.exists) {
      return replaySale(
        transaction,
        existingSale.data() ?? {},
        input,
        requestFingerprint,
      );
    }

    // Replays above preserve historical paid sales. New sales first save the
    // unpaid bill, print it, then settle through the guarded payment routes.
    if (input.payments.some(payment => payment.method !== 'credit')) {
      throw new HttpsError('failed-precondition', PRINT_FIRST_MESSAGE);
    }
    const context = await loadBaseSaleContext(transaction, input);
    const preparedLines = prepareSaleLines(
      input.lines,
      context.productDocuments,
      input.tenantId,
    );
    const totals = calculateSaleTotals(preparedLines, input.payments);
    assertAcceptedPayments(input.payments, context.settings);

    const timestamp = Timestamp.now();
    const dependencies = await loadSaleDependencies(
      transaction,
      input,
      preparedLines,
      timestamp,
      context.settings,
    );
    assertDiscountPermission(
      preparedLines,
      context.staff.role,
      hasProviderAuthorizedDiscount(
        input,
        preparedLines,
        dependencies.paymentIntentDocuments,
      ),
    );
    const sharedTab = await resolveSharedTab(transaction, input);
    const records = buildSaleRecords({
      saleId,
      requestFingerprint,
      input,
      context,
      preparedLines,
      totals,
      dependencies,
      timestamp,
    });
    if (sharedTab) {
      Object.assign(records.sale, { tabId: sharedTab.data.tabId, orderReference: sharedTab.data.orderReference });
      transaction.set(sharedTab.ref, { ...sharedTab.data, updatedAt: timestamp });
    }
    writeSaleRecords({
      transaction,
      input,
      context,
      dependencies,
      records,
      timestamp,
    });

    return newSaleResponse(records, dependencies);
  });
}
