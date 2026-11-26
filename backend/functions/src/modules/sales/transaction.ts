import { Timestamp } from "firebase-admin/firestore";
import { HttpsError } from 'firebase-functions/v2/https';
import { SAVE_FIRST_MESSAGE } from './printed-receipt';

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
import { approvalUsable } from "../approval-codes/domain";
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
      throw new HttpsError('failed-precondition', SAVE_FIRST_MESSAGE);
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
    // A waiter's staff discount carries the manager approval it was given.
    const approvalRef = input.discountApprovalId
      ? db.collection("discount_approvals").doc(input.discountApprovalId) : null;
    const approval = approvalRef ? (await transaction.get(approvalRef)).data() : undefined;
    const managerApproved = Boolean(approvalRef) && approvalUsable(approval, input, timestamp.toMillis());
    const discounted = preparedLines.some((line) => line.discountMinor > 0);
    if (approvalRef && !managerApproved && discounted) {
      throw new HttpsError(
        "permission-denied",
        "The manager approval for this discount has expired or was already used. Ask a manager to approve it again.",
      );
    }
    assertDiscountPermission(
      preparedLines,
      context.staff.role,
      hasProviderAuthorizedDiscount(
        input,
        preparedLines,
        dependencies.paymentIntentDocuments,
      ),
      managerApproved,
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
    if (approvalRef && managerApproved && discounted) {
      // Consumed with the sale, in the same transaction: one approval, one sale.
      Object.assign(records.sale, { discountApprovalId: approvalRef.id, discountApprovedByStaffId: approval?.approvedByStaffId ?? null });
      transaction.update(approvalRef, { consumedSaleId: saleId, consumedAt: timestamp });
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
