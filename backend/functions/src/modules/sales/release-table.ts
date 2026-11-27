import { Timestamp } from "firebase-admin/firestore";
import { HttpsError, onCall } from "firebase-functions/v2/https";

import { FUNCTION_REGION } from "../../config/runtime";
import { db } from "../../lib/firebase";
import { deterministicId } from "../../shared/identifiers";
import { asRecord, documentId, optionalText } from "../../shared/validation";
import { SELLING_ROLES } from "./constants";
import { isReleased, owesCredit, tableSales, tableSessionRef, withTableRefresh } from "./tab-identity";

/**
 * Frees a physical table while its customer's bill stays owed (agreed 27 Nov 2026).
 *
 * Any active selling staff member may release, whatever is owed, with a reason.
 * Each round on the tab is stamped `tableRelease` and one audit row is written;
 * no total, payment or status changes, so the bill stays payable from Orders.
 * Stamped rounds stop counting towards the table (tab-identity), so the next
 * customer gets a fresh tab, and a late round naming this tab is held for review.
 */
export async function releaseTableTab(token: Record<string, unknown> | undefined, data: unknown) {
  const input = asRecord(data);
  const tenantId = documentId(input.tenantId, "tenantId");
  const branchId = documentId(input.branchId, "branchId");
  const tabId = documentId(input.tabId, "tabId");
  const tableNumber = optionalText(input.tableNumber, "tableNumber", 40);
  const reason = typeof input.reason === "string" ? input.reason.trim().replace(/\s+/g, " ") : "";
  if (!tableNumber) throw new HttpsError("invalid-argument", "Choose the table to release.");
  if (reason.length < 3 || reason.length > 200) {
    throw new HttpsError("invalid-argument", "Give a reason of 3 to 200 characters for releasing the table.");
  }
  if (!token?.staff_id || token.tenant_id !== tenantId) {
    throw new HttpsError("permission-denied", "Sign in as staff of this business to release a table.");
  }
  const staffId = documentId(token.staff_id, "staff");

  return db.runTransaction(async (tx) => {
    const sessionRef = tableSessionRef(tenantId, branchId, tableNumber);
    const [staffDoc, branchDoc, lock] = await Promise.all([
      tx.get(db.collection("staff").doc(staffId)),
      tx.get(db.collection("branches").doc(branchId)),
      tx.get(sessionRef),
    ]);
    // The staff record, not the token: a deactivated waiter's token may still be valid.
    const staff = staffDoc.data();
    if (!staffDoc.exists || staff?.tenantId !== tenantId || staff?.status !== "active" || !SELLING_ROLES.has(String(staff?.role))) {
      throw new HttpsError("permission-denied", "Only active staff of this business can release a table.");
    }
    if (!branchDoc.exists || branchDoc.data()?.tenantId !== tenantId) {
      throw new HttpsError("not-found", "That branch is not in this business.");
    }
    // As createSale (base-context): a closed branch takes no table actions.
    if (branchDoc.data()?.status !== "active") {
      throw new HttpsError("failed-precondition", "This branch is not active.");
    }

    const rounds = (await tableSales(tx, tenantId, branchId, tableNumber, lock.data()))
      .filter(doc => doc.data().tabId === tabId && String(doc.data().status).toUpperCase() !== "VOIDED");
    if (!rounds.length) throw new HttpsError("not-found", "That tab is not open at this table.");

    const releaseId = deterministicId("release", `${tenantId}:${tabId}`);
    // A retried request: the release already happened and is not repeated.
    if (rounds.every(doc => isReleased(doc.data()))) {
      const previous = rounds[0].data().tableRelease;
      return { saleId: rounds[0].id, releaseId: previous.releaseId ?? releaseId, tabId, tableNumber,
        outstandingMinor: Number(previous.outstandingMinor || 0), replayed: true };
    }

    let outstandingMinor = 0;
    for (const doc of rounds) {
      if (Number(doc.data().checkoutExpiresAt?.toMillis?.() || 0) > Date.now()) {
        throw new HttpsError("failed-precondition", "This table is being paid. Finish checkout before releasing it.");
      }
      const ledger = await tx.get(db.collection("payments").where("saleId", "==", doc.id));
      for (const payment of ledger.docs) {
        if (owesCredit(payment.data(), tenantId)) outstandingMinor += Number(payment.data().amountMinor);
      }
    }
    if (outstandingMinor <= 0) {
      throw new HttpsError("failed-precondition", "Nothing is owed on this tab; it frees the table once paid.");
    }

    const now = Timestamp.now();
    const tableRelease = { releaseId, releasedAt: now, releasedByStaffId: staffId, reason,
      tableSessionId: sessionRef.id, outstandingMinor };
    for (const doc of rounds) {
      if (!isReleased(doc.data())) tx.update(doc.ref, { tableRelease });
    }
    const first = rounds[0].data();
    tx.create(db.collection("audit_logs").doc(releaseId), {
      tenantId, branchId, actorStaffId: staffId, action: "table.released", entityId: tabId, createdAt: now,
      metadata: { tableNumber: first.tableNumber ?? tableNumber, tableSessionId: sessionRef.id, tabId,
        orderReference: first.orderReference || first.invoiceNumber || null, saleIds: rounds.map(doc => doc.id),
        outstandingMinor, reason },
    });
    return { saleId: rounds[0].id, releaseId, tabId, tableNumber: first.tableNumber ?? tableNumber,
      outstandingMinor, releasedAt: now.toDate().toISOString(), replayed: false };
  });
}

export const releaseTable = onCall({ region: FUNCTION_REGION }, withTableRefresh(async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in before releasing a table.");
  return releaseTableTab(request.auth.token, request.data);
}));
