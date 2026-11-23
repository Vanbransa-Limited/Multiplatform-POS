import { createHash, randomUUID } from 'node:crypto';
import { getAuth } from 'firebase-admin/auth';
import { Timestamp } from 'firebase-admin/firestore';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import { FUNCTION_REGION } from '../../config/runtime';
import { db } from '../../lib/firebase';
import { asRecord, documentId } from '../../shared/validation';
import { deterministicId } from '../../shared/identifiers';
import { standardReceiptPolicy } from '../../shared/receipt-policy';

const ADMIN_EMAIL = 'tech@vanbransa2.com';
type AuthContext = { uid: string; token: Record<string, unknown> } | undefined;

export async function requirePlatformAdmin(auth: AuthContext): Promise<string> {
  if (!auth) throw new HttpsError('unauthenticated', 'Sign in to platform administration.');
  if (auth.token.platform_admin !== true || auth.token.email !== ADMIN_EMAIL) {
    throw new HttpsError('permission-denied', 'Platform administrator access is required.');
  }
  const profile = await db.collection('platform_admins').doc(auth.uid).get();
  if (profile.data()?.status !== 'active' || profile.data()?.email !== ADMIN_EMAIL) {
    throw new HttpsError('permission-denied', 'Platform administrator access is inactive.');
  }
  return auth.uid;
}

function text(value: unknown, label: string, max = 120): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) {
    throw new HttpsError('invalid-argument', `Enter ${label} (up to ${max} characters).`);
  }
  return value.trim();
}

export function parseLogo(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.length > 245_800) throw new HttpsError('invalid-argument', 'Logo must be an image up to 180 KB.');
  const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (match) {
    const bytes = Buffer.from(match[2], 'base64');
    const valid = bytes.length <= 180 * 1024 && bytes.toString('base64') === match[2]
      && (match[1] === 'png' ? bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
        : match[1] === 'jpeg' ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
          : bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP');
    if (valid) return value;
  } else if (value.length <= 2048) {
    try {
      const url = new URL(value);
      if (url.protocol === 'https:' && !url.username && !url.password) return url.href;
    } catch { /* handled below */ }
  }
  throw new HttpsError('invalid-argument', 'Use an HTTPS logo URL or a PNG, JPEG or WebP image up to 180 KB.');
}

export function parseTenantInput(data: unknown) {
  const input = asRecord(data);
  const slug = text(input.slug, 'a business identifier', 48).toLowerCase();
  if (!/^[a-z][a-z0-9-]{1,46}[a-z0-9]$/.test(slug) || slug.includes('--')) throw new HttpsError('invalid-argument', 'Business identifier must have 3–48 characters, start with a letter and use lowercase letters, numbers and single hyphens.');
  const ownerEmail = text(input.ownerEmail, 'the owner email', 254).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(ownerEmail)) throw new HttpsError('invalid-argument', 'Enter a valid owner email.');
  if (typeof input.ownerPassword !== 'string' || input.ownerPassword.length < 12 || input.ownerPassword.length > 128) throw new HttpsError('invalid-argument', 'Use an owner password of 12–128 characters.');
  return {
    requestId: documentId(input.requestId, 'requestId'),
    businessName: text(input.businessName, 'the business name'), slug,
    ownerName: text(input.ownerName, 'the owner name'), ownerEmail,
    ownerPassword: input.ownerPassword,
    branchName: text(input.branchName, 'the first branch name'), logoUrl: parseLogo(input.logoUrl),
  };
}

export const createPlatformTenant = onCall({ region: FUNCTION_REGION, timeoutSeconds: 120 }, async (request) => {
  const actorUid = await requirePlatformAdmin(request.auth);
  const input = parseTenantInput(request.data);
  // No password or password hash is persisted in Firestore or audit metadata.
  const { ownerPassword, requestId, ...details } = input;
  const fingerprint = createHash('sha256').update(JSON.stringify(details)).digest('hex');
  const tenantId = `tenant-${input.slug}`;
  const branchId = `${tenantId}-main`;
  const deviceId = `${tenantId}-till-01`;
  const customerId = `${tenantId}-walkin`;
  const staffId = deterministicId('staff', `${tenantId}:${input.ownerEmail}`);
  const result = { tenantId, branchId, deviceId, customerId, staffId, ownerEmail: input.ownerEmail, businessName: input.businessName, slug: input.slug, status: 'active' };
  const requestRef = db.collection('platform_onboarding').doc(`${actorUid}_${requestId}`);
  const tenantRef = db.collection('tenants').doc(tenantId);
  const slugRef = db.collection('platform_tenant_slugs').doc(input.slug);
  const now = Timestamp.now();
  const auth = getAuth();
  // Catch an already-used email before reserving the business identifier. A
  // matching interrupted onboarding may still continue with its own identity.
  try {
    const existing = await auth.getUserByEmail(input.ownerEmail);
    const previous = await requestRef.get();
    if (previous.exists && previous.data()?.fingerprint !== fingerprint) throw new HttpsError('already-exists', 'This request was used for different business details. Start a new onboarding request.');
    if (previous.data()?.authUid !== existing.uid || previous.data()?.fingerprint !== fingerprint) {
      throw new HttpsError('already-exists', 'That owner email already has an account. Use a new email; existing accounts are never changed.');
    }
  } catch (error) {
    if ((error as {code?: string}).code !== 'auth/user-not-found') throw error;
  }
  const reservation = await db.runTransaction(async (tx) => {
    const [previous, tenant, slug] = await tx.getAll(requestRef, tenantRef, slugRef);
    if (previous.exists) {
      const value = previous.data()!;
      if (value.fingerprint !== fingerprint || value.actorUid !== actorUid) throw new HttpsError('already-exists', 'This request was used for different business details. Start a new onboarding request.');
      return { authUid: String(value.authUid), provisioned: value.status === 'provisioned' || value.status === 'complete', complete: value.status === 'complete' };
    }
    if (tenant.exists || slug.exists) throw new HttpsError('already-exists', 'That business identifier is already in use. Existing businesses cannot be overwritten.');
    const authUid = randomUUID();
    tx.create(requestRef, { actorUid, fingerprint, authUid, tenantId, status: 'reserved', createdAt: now });
    tx.create(slugRef, { tenantId, requestPath: requestRef.path });
    return { authUid, provisioned: false, complete: false };
  });
  if (reservation.complete) return result;
  if (!reservation.provisioned) {
    try {
      await auth.createUser({ uid: reservation.authUid, email: input.ownerEmail, password: ownerPassword, displayName: input.ownerName, disabled: true });
    } catch (error) {
      const code = (error as {code?: string}).code;
      if (code !== 'auth/uid-already-exists' && code !== 'auth/email-already-exists') throw error;
      let user;
      try { user = await auth.getUser(reservation.authUid); }
      catch (lookupError) {
        if (code !== 'auth/email-already-exists' || (lookupError as {code?: string}).code !== 'auth/user-not-found') throw lookupError;
        // An email claimed concurrently by another account did not create our
        // reserved identity. Release only this untouched reservation atomically.
        await db.runTransaction(async (tx) => {
          const [previous, slug, tenant] = await tx.getAll(requestRef, slugRef, tenantRef);
          if (!tenant.exists && previous.data()?.status === 'reserved' && previous.data()?.authUid === reservation.authUid && slug.data()?.requestPath === requestRef.path) {
            tx.delete(requestRef); tx.delete(slugRef);
          }
        });
        throw new HttpsError('already-exists', 'That owner email already has an account. Use a new email; existing accounts are never changed.');
      }
      if (user.email !== input.ownerEmail || (user.customClaims?.tenant_id && user.customClaims.tenant_id !== tenantId)) throw new HttpsError('failed-precondition', 'The reserved owner identity does not match. Contact support.');
    }
    if ((await requestRef.get()).data()?.status === 'complete') return result;
    await auth.setCustomUserClaims(reservation.authUid, { tenant_id: tenantId, staff_id: staffId, staff_role: 'owner' });
    await db.runTransaction(async (tx) => {
      const current = await tx.get(requestRef);
      if (current.data()?.status === 'provisioned' || current.data()?.status === 'complete') return;
      if (current.data()?.authUid !== reservation.authUid || current.data()?.fingerprint !== fingerprint) throw new HttpsError('failed-precondition', 'Onboarding reservation changed.');
      const fields = { tenantId, createdAt: now };
      tx.create(tenantRef, { ...fields, id: tenantId, legalName: input.businessName, tradingName: input.businessName, businessName: input.businessName, slug: input.slug, ownerEmail: input.ownerEmail, logoUrl: input.logoUrl, status: 'active', defaultBranchId: branchId, defaultDeviceId: deviceId, walkInCustomerId: customerId });
      tx.create(db.collection('tenant_settings').doc(tenantId), { ...fields, establishmentName: input.businessName, receiptFooter: 'Thank you for your business.', locale: 'en-KE', timezone: 'Africa/Nairobi', cashEnabled: true, acceptedPaymentMethods: ['cash'], lowStockThresholdQty: 10, storeEnabled: false, updatedByStaffId: staffId });
      tx.create(db.collection('branches').doc(branchId), { ...fields, id: branchId, name: input.branchName, code: 'BH001', etimsBranchId: '00', status: 'active' });
      tx.create(db.collection('mpesa_receipt_controls').doc(tenantId), {
        ...standardReceiptPolicy(tenantId, [branchId], `${tenantId}-onboarding`),
        enabledAt: now, enabledBy: 'platform_onboarding', enabledByPlatformAdminUid: actorUid,
      });
      tx.create(db.collection('devices').doc(deviceId), { ...fields, id: deviceId, branchId, label: 'Main Till', status: 'active' });
      tx.create(db.collection('customers').doc(customerId), { ...fields, id: customerId, name: 'Walk-In Guest', phone: '', kraPin: '', priceTier: 'RETAIL', membershipDiscountBasisPoints: 0, isActive: true, isWalkIn: true });
      tx.create(db.collection('staff').doc(staffId), { ...fields, id: staffId, authUid: reservation.authUid, email: input.ownerEmail, name: input.ownerName, phone: null, role: 'owner', status: 'active', createdByStaffId: null, createdByPlatformAdminUid: actorUid });
      tx.create(db.collection('platform_tenants').doc(tenantId), { ...result, logoUrl: input.logoUrl, createdAt: now });
      tx.create(db.collection('audit_logs').doc(`${tenantId}-onboarding`), { ...fields, actorPlatformAdminUid: actorUid, action: 'tenant.created', entityId: tenantId,
        metadata: { ownerEmail: input.ownerEmail, branchId, receiptPolicyVersion: 3, receiptEntryMode: 'staff_entry' } });
      tx.update(requestRef, { status: 'provisioned', result, provisionedAt: now });
    });
  }
  // Retry after an activation failure only enables this newly reserved identity;
  // it never creates a second owner or changes a password on an existing account.
  if ((await requestRef.get()).data()?.status === 'complete') return result;
  await auth.updateUser(reservation.authUid, { disabled: false });
  await requestRef.update({ status: 'complete', activatedAt: Timestamp.now() });
  return result;
});

export const listPlatformTenants = onCall({ region: FUNCTION_REGION }, async (request) => {
  await requirePlatformAdmin(request.auth);
  const snapshot = await db.collection('tenants').limit(200).get();
  return { tenants: snapshot.docs.map((entry) => {
    const value = entry.data();
    return { tenantId: entry.id, businessName: value.businessName || value.tradingName || value.legalName || entry.id, slug: value.slug ?? null, ownerEmail: value.ownerEmail ?? null, status: value.status ?? 'unknown', logoUrl: value.logoUrl ?? null, branchId: value.defaultBranchId ?? null, deviceId: value.defaultDeviceId ?? null };
  }) };
});
