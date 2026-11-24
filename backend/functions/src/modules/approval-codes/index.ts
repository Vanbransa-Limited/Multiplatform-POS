import { Timestamp } from "firebase-admin/firestore";
import { HttpsError, onCall } from "firebase-functions/v2/https";

import { FUNCTION_REGION } from "../../config/runtime";
import { db } from "../../lib/firebase";
import { deterministicId } from "../../shared/identifiers";
import { asRecord, documentId } from "../../shared/validation";
import { SELLING_ROLES } from "../sales/constants";
import {
  afterFailure, APPROVAL_TTL_MS, assertCodeShape, CODE_HOLDER_ROLES, CODE_PATTERN,
  codeMatches, generateCode, hashCode, MAX_FAILURES, pausedForMs,
} from "./domain";

type Token = Record<string, unknown> | undefined;
type Actor = { tenantId: string; staffId: string };

function actorWith(token: Token, allowed: (role: string) => boolean, message: string): Actor {
  if (!token?.tenant_id || !token.staff_id || !allowed(String(token.staff_role))) {
    throw new HttpsError("permission-denied", message);
  }
  return { tenantId: String(token.tenant_id), staffId: String(token.staff_id) };
}

const ownerOnly = (token: Token) => actorWith(token, (role) => role === "owner", "Only the owner manages approval codes.");
const codeRef = (tenantId: string, staffId: string) =>
  db.collection("approval_codes").doc(deterministicId("approval-code", `${tenantId}:${staffId}`));
const millis = (value: unknown) => (value instanceof Timestamp ? value.toMillis() : null);

function audit(actor: Actor, action: string, entityId: string | null, metadata: Record<string, unknown>, now: Timestamp) {
  return db.collection("audit_logs").add({
    tenantId: actor.tenantId, branchId: null, actorStaffId: actor.staffId,
    action, entityType: "approval_code", entityId, metadata, createdAt: now,
  });
}

/** A person who may hold a code: active, in this business, owner or manager. */
async function holder(tenantId: string, staffId: string) {
  const snapshot = await db.collection("staff").doc(staffId).get();
  const staff = snapshot.data();
  return snapshot.exists && staff?.tenantId === tenantId && staff.status === "active"
    && CODE_HOLDER_ROLES.has(String(staff.role)) ? staff : null;
}

export const listApprovalCodes = onCall({ region: FUNCTION_REGION }, async (request) => {
  const actor = ownerOnly(request.auth?.token);
  const [staff, codes, events] = await Promise.all([
    db.collection("staff").where("tenantId", "==", actor.tenantId).get(),
    db.collection("approval_codes").where("tenantId", "==", actor.tenantId).get(),
    // ponytail: the latest 200 audit entries on the existing index; older approvals drop off the log.
    db.collection("audit_logs").where("tenantId", "==", actor.tenantId).orderBy("createdAt", "desc").limit(200).get(),
  ]);
  const byStaff = new Map(codes.docs.map((doc) => [doc.data().staffId, doc.data()]));
  const names = new Map(staff.docs.map((doc) => [doc.id, String(doc.data().name || doc.id)]));
  return {
    recent: events.docs.map((doc) => doc.data())
      .filter((event) => event.entityType === "approval_code")
      .slice(0, 30)
      .map((event) => ({
        at: millis(event.createdAt),
        action: String(event.action),
        by: names.get(String(event.actorStaffId)) || "",
        approver: names.get(String(event.metadata?.approvedByStaffId || "")) || "",
        subject: names.get(String(event.entityId || "")) || "",
        paused: Boolean(event.metadata?.paused),
      })),
    holders: staff.docs
      .filter((doc) => doc.data().status === "active" && CODE_HOLDER_ROLES.has(String(doc.data().role)))
      .map((doc) => {
        const code = byStaff.get(doc.id);
        return {
          staffId: doc.id,
          name: String(doc.data().name || doc.id),
          role: String(doc.data().role),
          hasCode: Boolean(code?.hash),
          active: Boolean(code?.hash && code.active),
          changedAt: millis(code?.changedAt),
          lastApprovedAt: millis(code?.lastApprovedAt),
        };
      }),
  };
});

/**
 * Sets, or with no code given creates, a holder's code. Also how a leaked code
 * is rotated: the old hash is replaced, so it stops working on every till.
 * Only a generated code is returned, once; nothing can read it back later.
 */
export const setApprovalCode = onCall({ region: FUNCTION_REGION }, async (request) => {
  const actor = ownerOnly(request.auth?.token);
  const input = asRecord(request.data);
  const staffId = documentId(input.staffId, "staffId");
  const typed = input.code == null ? null : assertCodeShape(input.code);
  if (!(await holder(actor.tenantId, staffId))) {
    throw new HttpsError("failed-precondition", "Only an active owner or manager can hold an approval code.");
  }

  // Two people sharing a code would make every approval unattributable.
  const others = (await db.collection("approval_codes").where("tenantId", "==", actor.tenantId).get())
    .docs.map((doc) => doc.data()).filter((data) => data.staffId !== staffId && data.hash);
  const taken = async (code: string) => (await Promise.all(others.map((data) => codeMatches(code, data)))).some(Boolean);
  let code = typed ?? generateCode();
  if (await taken(code)) {
    if (typed) throw new HttpsError("already-exists", "Someone already uses that code. Pick a different one.");
    do code = generateCode(); while (await taken(code));
  }

  const ref = codeRef(actor.tenantId, staffId);
  const existed = Boolean((await ref.get()).data()?.hash);
  const now = Timestamp.now();
  await ref.set({
    tenantId: actor.tenantId, staffId, ...(await hashCode(code)),
    active: true, changedAt: now, changedByStaffId: actor.staffId,
  }, { merge: true });
  await audit(actor, existed ? "approval_code.rotated" : "approval_code.created", staffId, { generated: !typed }, now);
  return { staffId, code: typed ? null : code };
});

export const setApprovalAccess = onCall({ region: FUNCTION_REGION }, async (request) => {
  const actor = ownerOnly(request.auth?.token);
  const input = asRecord(request.data);
  const staffId = documentId(input.staffId, "staffId");
  if (typeof input.active !== "boolean") throw new HttpsError("invalid-argument", "active must be true or false.");
  const ref = codeRef(actor.tenantId, staffId);
  if (!(await ref.get()).data()?.hash) throw new HttpsError("failed-precondition", "Create a code for this person first.");
  const now = Timestamp.now();
  await ref.update({ active: input.active, changedAt: now, changedByStaffId: actor.staffId });
  await audit(actor, input.active ? "approval_code.enabled" : "approval_code.disabled", staffId, {}, now);
  return { staffId, active: input.active };
});

/**
 * A waiter's till asks: does this code belong to a manager who may approve?
 * Success returns a single-use approval that createSale consumes with the sale.
 */
export const approveStaffDiscount = onCall({ region: FUNCTION_REGION }, async (request) => {
  const actor = actorWith(request.auth?.token, (role) => SELLING_ROLES.has(role), "Sign in to ask for an approval.");
  const code = asRecord(request.data).code;
  if (typeof code !== "string" || !CODE_PATTERN.test(code)) {
    throw new HttpsError("invalid-argument", "Enter the 6-digit code.");
  }
  const throttleRef = db.collection("approval_throttles")
    .doc(deterministicId("approval-throttle", `${actor.tenantId}:${actor.staffId}`));
  const pauseMessage = (ms: number) => `Too many wrong codes. Try again in ${Math.ceil(ms / 60_000)} minutes, or remove the discount.`;
  const nowMs = Date.now();
  const waiting = pausedForMs((await throttleRef.get()).data(), nowMs);
  if (waiting) throw new HttpsError("resource-exhausted", pauseMessage(waiting));

  const active = await db.collection("approval_codes")
    .where("tenantId", "==", actor.tenantId).where("active", "==", true).get();
  let matched: { ref: FirebaseFirestore.DocumentReference; staffId: string; name: string } | null = null;
  for (const doc of active.docs) {
    if (!(await codeMatches(code, doc.data()))) continue;
    const staff = await holder(actor.tenantId, String(doc.data().staffId));
    if (staff) matched = { ref: doc.ref, staffId: String(doc.data().staffId), name: String(staff.name || "Manager") };
    break;
  }

  const now = Timestamp.now();
  if (!matched) {
    const state = await db.runTransaction(async (tx) => {
      const next = afterFailure((await tx.get(throttleRef)).data() ?? {}, nowMs);
      tx.set(throttleRef, { tenantId: actor.tenantId, staffId: actor.staffId, ...next, updatedAt: now });
      return next;
    });
    await audit(actor, "discount_approval.refused", null, { paused: state.failures === 0 }, now);
    if (state.failures === 0) throw new HttpsError("resource-exhausted", pauseMessage(pausedForMs(state, nowMs)));
    const left = MAX_FAILURES - state.failures;
    throw new HttpsError("permission-denied", `That code was not accepted. ${left} ${left === 1 ? "try" : "tries"} left.`);
  }

  const approval = db.collection("discount_approvals").doc();
  await Promise.all([
    approval.set({
      tenantId: actor.tenantId, requestedByStaffId: actor.staffId,
      approvedByStaffId: matched.staffId, approvedByName: matched.name,
      createdAt: now, expiresAtMs: nowMs + APPROVAL_TTL_MS, consumedSaleId: null,
    }),
    throttleRef.set({ tenantId: actor.tenantId, staffId: actor.staffId, failures: 0, pausedUntilMs: 0, updatedAt: now }),
    matched.ref.update({ lastApprovedAt: now }),
    audit(actor, "discount_approval.granted", approval.id, { approvedByStaffId: matched.staffId }, now),
  ]);
  return { approvalId: approval.id, approvedByStaffId: matched.staffId, approvedByName: matched.name };
});
