/**
 * Staff identity administration.
 *
 * Firebase Authentication carries identity: a person signs in with an email and
 * a password they chose, and the tenant, staff id and role ride along as custom
 * claims on the ID token. No credential is ever seeded into the app bundle and
 * nothing is verified in the browser.
 *
 * Replaces the PIN flow, where every staff PIN shipped inside the published
 * JavaScript and the check that mattered ran client-side.
 */

import { getAuth } from "firebase-admin/auth";
import { staffCredential } from "./credential";
import { Timestamp } from "firebase-admin/firestore";
import { defineSecret } from "firebase-functions/params";
import { HttpsError, onCall } from "firebase-functions/v2/https";

import { FUNCTION_REGION } from "../../config/runtime";
import { db } from "../../lib/firebase";
import { SELLING_ROLES } from "../sales/constants";
import { deterministicId } from "../../shared/identifiers";
import { ADMIN_ROLES, canAssignRole, normaliseModuleAccess, STAFF_ROLES } from "../../shared/roles";
import { asRecord, documentId, optionalText } from "../../shared/validation";

const BOOTSTRAP_SECRET = defineSecret("POS_BOOTSTRAP_SECRET");

// Allow short numeric passcodes as well as existing full-length passwords.
const MIN_PASSWORD_LENGTH = 8;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface Actor {
  tenantId: string;
  staffId: string;
  role: string;
}

/** The verified administrator behind a request, or an error. */
function requireAdmin(auth: { token: Record<string, unknown> } | undefined): Actor {
  if (!auth) throw new HttpsError("unauthenticated", "Sign in first.");

  const tenantId = typeof auth.token.tenant_id === "string" ? auth.token.tenant_id : null;
  const staffId = typeof auth.token.staff_id === "string" ? auth.token.staff_id : null;
  const role = typeof auth.token.staff_role === "string" ? auth.token.staff_role : null;
  if (!tenantId || !staffId || !role) {
    throw new HttpsError("permission-denied", "This session carries no staff claims.");
  }
  if (!ADMIN_ROLES.has(role)) {
    throw new HttpsError("permission-denied", "Only an owner or store manager can manage staff.");
  }

  return { tenantId, staffId, role };
}

function email(value: unknown): string {
  if (typeof value !== "string" || !EMAIL_PATTERN.test(value.trim()) || value.length > 254) {
    throw new HttpsError("invalid-argument", "Enter a valid email address.");
  }
  return value.trim().toLowerCase();
}

function password(value: unknown): string {
  if (typeof value === "string" && /^[0-9]{1,4}$/.test(value)) {
    return staffCredential(value);
  }
  if (typeof value !== "string" || value.length < MIN_PASSWORD_LENGTH || value.length > 128) {
    throw new HttpsError(
      "invalid-argument",
      `Use a 1–4 digit passcode or a password of ${MIN_PASSWORD_LENGTH}–128 characters.`,
    );
  }
  return value;
}

function role(value: unknown): string {
  if (typeof value !== "string" || !STAFF_ROLES.has(value)) {
    throw new HttpsError("invalid-argument", "Choose a valid staff role.");
  }
  return value;
}

/**
 * Creates one staff member: a Firebase Auth account, the claims that scope it
 * to one tenant and role, and the staff profile the app reads.
 *
 * Shared by the single-user form and the bulk import so both mint an identity
 * exactly the same way - a second copy of this would be a second place for the
 * claims to drift out of step with the profile.
 */
async function createStaff(
  actor: Actor,
  input: Record<string, unknown>,
): Promise<{ staffId: string; email: string; role: string }> {
  const staffRole = role(input.role);
  if (!canAssignRole(actor.role, staffRole)) {
    throw new HttpsError("permission-denied", "Only an owner can create another owner.");
  }

  const address = email(input.email);
  const secret = password(input.password);
  const name = optionalText(input.name, "name", 120);
  if (!name) throw new HttpsError("invalid-argument", "Enter the staff member's name.");
  const phone = optionalText(input.phone, "phone", 20);

  // Deterministic so a retried create collides on the document rather than
  // silently minting a second profile for the same person.
  const staffId = deterministicId("staff", `${actor.tenantId}:${address}`);
  const staffRef = db.collection("staff").doc(staffId);
  const existing = await staffRef.get();
  const wasDisabled = existing.exists && existing.data()?.status !== "active";

  // Somebody who was removed is the same person coming back, so their record is
  // taken up again rather than refused. Removing a staff member disables the
  // profile - the sales and audit rows they left behind still point at this
  // id - and without this, re-adding them was impossible from inside the app:
  // the id is derived from the email, so it collided every time.
  if (existing.exists && !wasDisabled) {
    throw new HttpsError("already-exists", "That email already belongs to a staff member.");
  }
  if (existing.exists && existing.data()?.tenantId !== actor.tenantId) {
    throw new HttpsError("already-exists", "That email already belongs to a staff member.");
  }

  const auth = getAuth();
  let authUid: string;
  let reusedIdentity = false;
  try {
    const created = await auth.createUser({
      email: address,
      password: secret,
      displayName: name,
    });
    authUid = created.uid;
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code !== "auth/email-already-exists") throw error;

    // The sign-in identity outlived its profile - a removed staff member, or a
    // create that failed half way. Reusing it is what keeps an owner out of the
    // Firebase console just to hire somebody back.
    const found = await auth.getUserByEmail(address);
    // An email collision is not proof this tenant owns the identity. Check
    // server-issued claims before changing a password, enabling an account,
    // or replacing its claims. Unclaimed accounts require operator recovery.
    if (found.customClaims?.tenant_id !== actor.tenantId
      || found.customClaims?.staff_id !== staffId
      || found.customClaims?.platform_admin === true
      || (existing.exists && existing.data()?.authUid !== found.uid)) {
      throw new HttpsError("already-exists", "That email already belongs to another sign-in account.");
    }
    await auth.updateUser(found.uid, { password: secret, displayName: name, disabled: false });
    authUid = found.uid;
    reusedIdentity = true;
  }

  // Claims are the authorisation, so they are set before the profile exists:
  // a profile without claims is inert, claims without a profile are not.
  try {
  await auth.setCustomUserClaims(authUid, {
    tenant_id: actor.tenantId,
    staff_id: staffId,
    staff_role: staffRole,
  });

  const now = Timestamp.now();
  await staffRef.set({
    id: staffId,
    tenantId: actor.tenantId,
    authUid,
    name,
    email: address,
    phone: phone ?? null,
    role: staffRole,
    status: "active",
    createdAt: existing.data()?.createdAt ?? now,
    createdByStaffId: existing.data()?.createdByStaffId ?? actor.staffId,
    ...(existing.exists
      ? { rehiredAt: now, rehiredByStaffId: actor.staffId, retiredAt: null }
      : {}),
  }, { merge: true });
  } catch (error) {
    // A failed profile/claims write must not leave an unusable registered email
    // - but an identity that was already here is not this call's to delete.
    if (!reusedIdentity) await auth.deleteUser(authUid);
    throw error;
  }

  return { staffId, email: address, role: staffRole };
}

/**
 * Creates a staff member.
 *
 * Cashiers rarely have a work inbox, so the address only has to be unique and
 * well-formed - an owner typically issues `name@business.pos` and hands over
 * the password. Those accounts cannot self-serve a reset; an admin re-passwords
 * them with resetStaffPassword.
 */
export const createStaffUser = onCall(
  { region: FUNCTION_REGION },
  async (request) => {
    const actor = requireAdmin(request.auth);
    const created = await createStaff(actor, asRecord(request.data, "Request data"));

    await db.collection("audit_logs").add({
      tenantId: actor.tenantId,
      branchId: null,
      actorStaffId: actor.staffId,
      action: "staff.created",
      entityType: "staff",
      entityId: created.staffId,
      metadata: { role: created.role, email: created.email },
      createdAt: Timestamp.now(),
    });

    return created;
  },
);

/**
 * Firebase Auth account creation is one network round trip per person and is
 * rate limited, so a roster arrives in chunks rather than as one call. The till
 * splits a larger sheet and reports progress across the chunks.
 */
export const MAX_IMPORT_ROWS = 100;

/**
 * Bulk staff import - a whole roster of cashiers from one spreadsheet.
 *
 * A bad row is reported, never thrown: the point of importing thirty cashiers
 * is that one typo in row 12 does not cost you the other twenty-nine. Rows are
 * created one at a time because each is an Auth account, not a document write,
 * so there is no batch to commit.
 */
export const importStaff = onCall(
  { region: FUNCTION_REGION, timeoutSeconds: 300 },
  async (request) => {
    const actor = requireAdmin(request.auth);
    const input = asRecord(request.data, "Request data");

    const rows = Array.isArray(input.rows) ? input.rows : null;
    if (!rows || rows.length === 0) {
      throw new HttpsError("invalid-argument", "The file contained no rows.");
    }
    if (rows.length > MAX_IMPORT_ROWS) {
      throw new HttpsError(
        "invalid-argument",
        `Send at most ${MAX_IMPORT_ROWS} rows per call; this one carried ${rows.length}.`,
      );
    }

    const created: { staffId: string; email: string; role: string }[] = [];
    const rejected: { row: number; email: string; message: string }[] = [];
    const seen = new Set<string>();

    for (let index = 0; index < rows.length; index += 1) {
      // Row 1 is the header in the file the person is looking at.
      const line = index + 2;
      const row = (rows[index] ?? {}) as Record<string, unknown>;
      const address = typeof row.email === "string" ? row.email.trim().toLowerCase() : "";

      // Two rows on one address would create the account, then fail the second
      // on "already registered" - a confusing way to say the file repeats.
      if (address && seen.has(address)) {
        rejected.push({ row: line, email: address, message: "Duplicate email in this file." });
        continue;
      }

      try {
        if (input.cashierOnly !== false && row.role !== 'cashier' && row.role != null && row.role !== '') {
          throw new HttpsError('invalid-argument', 'Cashier-only import accepts only Cashier access.');
        }
        if (row.role == null || row.role === '') row.role = 'cashier';
        const staff = await createStaff(actor, row);
        seen.add(staff.email);
        created.push(staff);
      } catch (error) {
        const message = error instanceof HttpsError
          ? error.message
          : (error as Error).message || "Could not create this user.";
        rejected.push({ row: line, email: address, message });
      }
    }

    await db.collection("audit_logs").add({
      tenantId: actor.tenantId,
      branchId: null,
      actorStaffId: actor.staffId,
      action: "staff.imported",
      entityType: "staff",
      entityId: null,
      metadata: { imported: created.length, rejected: rejected.length },
      createdAt: Timestamp.now(),
    });

    return { imported: created.length, created, rejected };
  },
);

/**
 * Disables or re-enables a staff member.
 *
 * Disabling revokes refresh tokens as well as the account, so a till already
 * signed in loses access at its next token refresh rather than at end of shift.
 */
export const setStaffActive = onCall(
  { region: FUNCTION_REGION },
  async (request) => {
    const actor = requireAdmin(request.auth);
    const input = asRecord(request.data, "Request data");
    const staffId = documentId(input.staffId, "staffId");
    const active = input.active === true;

    if (staffId === actor.staffId) {
      throw new HttpsError("failed-precondition", "You cannot disable your own account.");
    }

    const staffRef = db.collection("staff").doc(staffId);
    const snapshot = await staffRef.get();
    const staff = snapshot.data();
    if (!snapshot.exists || staff?.tenantId !== actor.tenantId) {
      throw new HttpsError("not-found", "No such staff member.");
    }
    if (staff.role === "owner" && actor.role !== "owner") {
      throw new HttpsError("permission-denied", "Only an owner can disable an owner.");
    }

    // Losing the last owner locks everyone out of staff administration for good.
    if (!active && staff.role === "owner") {
      const owners = await db.collection("staff")
        .where("tenantId", "==", actor.tenantId)
        .where("role", "==", "owner")
        .where("status", "==", "active")
        .get();
      if (owners.size <= 1) {
        throw new HttpsError("failed-precondition", "This is the last active owner.");
      }
    }

    const auth = getAuth();
    if (typeof staff.authUid === "string") {
      await auth.updateUser(staff.authUid, { disabled: !active });
      if (!active) await auth.revokeRefreshTokens(staff.authUid);
    }

    const now = Timestamp.now();
    await staffRef.update({ status: active ? "active" : "disabled", updatedAt: now });
    await db.collection("audit_logs").add({
      tenantId: actor.tenantId,
      branchId: null,
      actorStaffId: actor.staffId,
      action: active ? "staff.enabled" : "staff.disabled",
      entityType: "staff",
      entityId: staffId,
      metadata: {},
      createdAt: now,
    });

    return { staffId, status: active ? "active" : "disabled" };
  },
);

/** Sets a new password for a staff member who cannot reset their own. */
export const resetStaffPassword = onCall(
  { region: FUNCTION_REGION },
  async (request) => {
    const actor = requireAdmin(request.auth);
    const input = asRecord(request.data, "Request data");
    const staffId = documentId(input.staffId, "staffId");
    const secret = password(input.password);

    const snapshot = await db.collection("staff").doc(staffId).get();
    const staff = snapshot.data();
    if (!snapshot.exists || staff?.tenantId !== actor.tenantId) {
      throw new HttpsError("not-found", "No such staff member.");
    }
    if (staff.role === "owner" && actor.role !== "owner") {
      throw new HttpsError("permission-denied", "Only an owner can re-password an owner.");
    }
    if (typeof staff.authUid !== "string") {
      throw new HttpsError("failed-precondition", "That staff member has no sign-in account.");
    }

    const auth = getAuth();
    await auth.updateUser(staff.authUid, { password: secret });
    // Force every other signed-in device for this person to re-authenticate.
    await auth.revokeRefreshTokens(staff.authUid);

    await db.collection("audit_logs").add({
      tenantId: actor.tenantId,
      branchId: null,
      actorStaffId: actor.staffId,
      action: "staff.password_reset",
      entityType: "staff",
      entityId: staffId,
      metadata: {},
      createdAt: Timestamp.now(),
    });

    return { staffId };
  },
);

/**
 * Creates the first owner for a tenant that has none.
 *
 * There is no signed-in administrator to authorise the very first account, so
 * this is gated on the deployment's bootstrap secret and refuses to run once an
 * owner exists - it can create the first account, never a back door into a
 * tenant already in use.
 */
export const bootstrapOwner = onCall(
  { region: FUNCTION_REGION, secrets: [BOOTSTRAP_SECRET] },
  async (request) => {
    const input = asRecord(request.data, "Request data");
    const expected = BOOTSTRAP_SECRET.value();
    if (!expected) {
      throw new HttpsError("failed-precondition", "No bootstrap secret is configured.");
    }
    if (typeof input.bootstrapSecret !== "string" || input.bootstrapSecret !== expected) {
      throw new HttpsError("permission-denied", "Invalid bootstrap secret.");
    }

    const tenantId = documentId(input.tenantId, "tenantId");
    const address = email(input.email);
    const secret = password(input.password);
    const name = optionalText(input.name, "name", 120) ?? "Owner";

    const tenant = await db.collection("tenants").doc(tenantId).get();
    if (!tenant.exists) {
      throw new HttpsError("not-found", "Provision the tenant before its owner.");
    }

    const owners = await db.collection("staff")
      .where("tenantId", "==", tenantId)
      .where("role", "==", "owner")
      .where("status", "==", "active")
      .limit(1)
      .get();

    const auth = getAuth();

    // The retired PIN provisioning left an owner profile whose Auth password
    // was random and discarded, so it exists but nobody can sign in as it.
    // Adopting is how that account is recovered: it re-points the tenant's
    // existing owner at an address and password someone actually holds, rather
    // than quietly minting a second owner beside it.
    if (!owners.empty) {
      if (input.adoptExisting !== true) {
        throw new HttpsError(
          "already-exists",
          "This tenant already has an owner. Pass adoptExisting to take that account over, "
            + "or create further staff from the app.",
        );
      }

      const existing = owners.docs[0];
      const current = existing.data();
      if (current.tenantId !== tenantId || current.role !== "owner") {
        throw new HttpsError("failed-precondition", "The existing owner profile does not match this business.");
      }
      let uid = typeof current.authUid === "string" ? current.authUid : null;

      if (uid) {
        const identity = await auth.getUser(uid);
        if (identity.customClaims?.tenant_id !== tenantId
          || identity.customClaims?.staff_id !== existing.id
          || identity.customClaims?.platform_admin === true) {
          throw new HttpsError("failed-precondition", "The owner identity is not linked to this business. Operator recovery is required.");
        }
        await auth.updateUser(uid, {
          email: address,
          password: secret,
          displayName: name,
          disabled: false,
        });
      } else {
        const created = await auth.createUser({ email: address, password: secret, displayName: name });
        uid = created.uid;
      }

      await auth.setCustomUserClaims(uid, {
        tenant_id: tenantId,
        staff_id: existing.id,
        staff_role: "owner",
      });
      // Any session minted under the old identity stops working now.
      await auth.revokeRefreshTokens(uid);

      await existing.ref.update({
        authUid: uid,
        email: address,
        name,
        status: "active",
        updatedAt: Timestamp.now(),
      });

      return { staffId: existing.id, email: address, adopted: true };
    }

    const staffId = deterministicId("staff", `${tenantId}:${address}`);

    // The tenant may already carry a seeded Auth account on this address from
    // the retired PIN provisioning, which never had a usable password.
    let authUid: string;
    try {
      const existing = await auth.getUserByEmail(address);
      if (existing.customClaims?.tenant_id !== tenantId
        || existing.customClaims?.staff_id !== staffId
        || existing.customClaims?.platform_admin === true) {
        throw new HttpsError("already-exists", "That email belongs to another sign-in account. Existing accounts cannot be adopted.");
      }
      authUid = existing.uid;
      await auth.updateUser(authUid, { password: secret, displayName: name, disabled: false });
    } catch (error) {
      if ((error as { code?: string }).code !== "auth/user-not-found") throw error;
      const created = await auth.createUser({ email: address, password: secret, displayName: name });
      authUid = created.uid;
    }

    await auth.setCustomUserClaims(authUid, {
      tenant_id: tenantId,
      staff_id: staffId,
      staff_role: "owner",
    });

    const now = Timestamp.now();
    await db.collection("staff").doc(staffId).set({
      id: staffId,
      tenantId,
      authUid,
      name,
      email: address,
      phone: null,
      role: "owner",
      status: "active",
      createdAt: now,
      createdByStaffId: null,
    });

    return { staffId, email: address };
  },
);

/**
 * Names only, for anyone who sells.
 *
 * /staff is readable by owners and managers alone because it holds emails,
 * phones and auth ids. A supervisor's till still has to say who billed an
 * order, so this returns id -> name and nothing else.
 */
export const listStaffNames = onCall({ region: FUNCTION_REGION }, async (request) => {
  const token = request.auth?.token;
  if (!token?.tenant_id || !token.staff_id || !SELLING_ROLES.has(String(token.staff_role))) {
    throw new HttpsError("permission-denied", "Sign in to see staff names.");
  }
  const snapshot = await db.collection("staff").where("tenantId", "==", String(token.tenant_id)).get();
  return {
    staff: snapshot.docs.map((doc) => ({ id: doc.id, name: String(doc.data().name || doc.id) })),
  };
});

/**
 * The owner's switches for which roles reach each module, and who may sell.
 *
 * Owner only: a store manager who could edit this could grant themselves
 * anything. The map is not on the client write allowlist in firestore.rules,
 * so this callable is the only way in.
 */
export const setModuleAccess = onCall({ region: FUNCTION_REGION }, async (request) => {
  const token = request.auth?.token;
  if (!token?.tenant_id || !token.staff_id || token.staff_role !== "owner") {
    throw new HttpsError("permission-denied", "Only the owner can change module access.");
  }
  const tenantId = String(token.tenant_id);
  const staffId = String(token.staff_id);
  const moduleAccess = normaliseModuleAccess(asRecord(request.data, "Request data").moduleAccess);
  const now = Timestamp.now();
  await db.collection("tenant_settings").doc(tenantId).update({ moduleAccess, updatedAt: now, updatedByStaffId: staffId });
  await db.collection("audit_logs").add({
    tenantId, branchId: null, actorStaffId: staffId, action: "settings.module_access",
    entityType: "tenant_settings", entityId: tenantId, metadata: { moduleAccess }, createdAt: now,
  });
  return { moduleAccess };
});
