import { Timestamp } from "firebase-admin/firestore";
import { HttpsError, onCall } from "firebase-functions/v2/https";

import { FUNCTION_REGION } from "../../config/runtime";
import { db } from "../../lib/firebase";
import { deterministicId } from "../../shared/identifiers";
import { asRecord, documentId } from "../../shared/validation";
import { approvalUsable } from "../approval-codes/domain";
import { SELLING_ROLES, STAFF_PRESET_ROLES } from "./constants";
import { roundDiscountRefusal, roundStaffDiscount } from "./round-discount";
import { withTableRefresh } from "./tab-identity";

/**
 * Adds the Staff 20% to one round already on a tab, before it is paid.
 *
 * Owners and managers add it themselves; anyone else brings a manager's
 * approval from approveStaffDiscount, used up by this round - the same rule
 * createSale applies when the 20% is rung with the round.
 */
export const addRoundStaffDiscount = onCall({ region: FUNCTION_REGION }, withTableRefresh(async (request) => {
  const token = request.auth?.token;
  const role = String(token?.staff_role || "");
  if (!token?.tenant_id || !token.staff_id || !SELLING_ROLES.has(role)) {
    throw new HttpsError("permission-denied", "Sign in to change a bill.");
  }
  const actor = { tenantId: String(token.tenant_id), staffId: String(token.staff_id) };
  const input = asRecord(request.data);
  const saleUuid = documentId(input.saleUuid, "saleUuid");
  const approvalId = typeof input.discountApprovalId === "string" && input.discountApprovalId
    ? documentId(input.discountApprovalId, "discountApprovalId") : null;
  const selfApproved = STAFF_PRESET_ROLES.has(role);
  if (!selfApproved && !approvalId) {
    throw new HttpsError("permission-denied", "A manager's code is needed to add the staff discount.");
  }

  const saleId = deterministicId("sale", `${actor.tenantId}:${saleUuid}`);
  const saleRef = db.collection("sales").doc(saleId);
  const approvalRef = approvalId ? db.collection("discount_approvals").doc(approvalId) : null;

  return db.runTransaction(async (tx) => {
    const now = Timestamp.now();
    const sale = (await tx.get(saleRef)).data();
    const paymentDocs = await tx.get(db.collection("payments").where("saleId", "==", saleId));
    const refusal = roundDiscountRefusal(sale, paymentDocs.docs.map((doc) => doc.data()), actor.tenantId, now.toMillis());
    if (refusal) throw new HttpsError("failed-precondition", refusal);

    let approvedByStaffId = actor.staffId;
    if (approvalRef) {
      const approval = (await tx.get(approvalRef)).data();
      if (!approvalUsable(approval as never, actor, now.toMillis())) {
        throw new HttpsError("permission-denied", "The manager approval has expired or was already used. Ask a manager to approve it again.");
      }
      approvedByStaffId = String(approval?.approvedByStaffId || "");
    }

    const lineIds = Array.isArray(sale!.lineIds) ? sale!.lineIds.map(String) : [];
    const lineSnaps = lineIds.length ? await tx.getAll(...lineIds.map((id) => db.collection("sale_lines").doc(id))) : [];
    if (!lineSnaps.length || lineSnaps.some((snap) => !snap.exists)) {
      throw new HttpsError("failed-precondition", "That round's items could not be read. Refresh and try again.");
    }
    const lines = lineSnaps.map((snap) => snap.data() as { productId: string; qty: number; unitPriceMinor: number; discountMinor: number; taxCode?: string });
    const next = roundStaffDiscount(lines);
    if (next.discountMinor <= 0) throw new HttpsError("failed-precondition", "Nothing on that round can take the staff discount.");

    next.lines.forEach((line, index) => tx.update(lineSnaps[index].ref, {
      discountMinor: line.discountMinor, lineTotalMinor: line.lineTotalMinor, taxMinor: line.taxMinor,
    }));
    const credit = paymentDocs.docs.filter((doc) => doc.data().method === "credit");
    credit.forEach((doc, index) => tx.update(doc.ref, { amountMinor: index === 0 ? next.totalMinor : 0, updatedAt: now }));
    tx.update(saleRef, {
      discountMinor: next.discountMinor, taxMinor: next.taxMinor, totalMinor: next.totalMinor, updatedAt: now,
      discountApprovedByStaffId: approvedByStaffId,
      ...(approvalId ? { discountApprovalId: approvalId } : {}),
      discountAddedAfterSale: { byStaffId: actor.staffId, at: now, fromTotalMinor: Number(sale!.totalMinor) },
    });
    if (approvalRef) tx.update(approvalRef, { consumedSaleId: saleId, consumedAt: now });
    tx.create(db.collection("audit_logs").doc(), {
      tenantId: actor.tenantId, actorStaffId: actor.staffId, action: "sale.staff_discount_added",
      entityType: "sale", entityId: saleId,
      metadata: { invoiceNumber: sale!.invoiceNumber ?? null, discountMinor: next.discountMinor, fromTotalMinor: sale!.totalMinor,
        totalMinor: next.totalMinor, approvedByStaffId, discountApprovalId: approvalId },
      createdAt: now,
    });
    // The till that rang the round holds its own copy; these are what it rewrites.
    return { saleId, saleUuid, invoiceNumber: sale!.invoiceNumber ?? null, discountMinor: next.discountMinor,
      taxMinor: next.taxMinor, totalMinor: next.totalMinor,
      lines: next.lines.map((line) => ({ productId: line.productId, discountMinor: line.discountMinor, taxMinor: line.taxMinor, lineTotalMinor: line.lineTotalMinor })) };
  });
}));
