import { Timestamp } from 'firebase-admin/firestore';
import { HttpsError, onCall } from 'firebase-functions/v2/https';

import { FUNCTION_REGION } from '../../config/runtime';
import { db } from '../../lib/firebase';
import { deterministicId } from '../../shared/identifiers';
import { asRecord, documentId, minorUnits, optionalText } from '../../shared/validation';

/**
 * The customer directory.
 *
 * createSale refuses any sale whose customer is not an active document in this
 * tenant, so a customer typed into a till and kept there was a sale that
 * printed and then never synced. Adding one has to reach the server, and this
 * is the only door: firestore.rules denies every client write to /customers.
 */

/**
 * Who the directory belongs to.
 *
 * A customer record carries a credit limit and a running tab, so adding one is
 * a decision about who this business will let walk out owing money. It stays
 * with the owner and the supervisor running the floor.
 *
 * Deleting is the owner's alone: a customer is what unpaid invoices are billed
 * to, and removing one takes the name off a debt.
 */
const CUSTOMER_ROLES = ['owner', 'supervisor'];
const DELETE_ROLES = ['owner'];

const KRA_PIN_PATTERN = /^[A-Z]\d{9}[A-Z]$/;

export function customerActor(
  auth: { token: Record<string, unknown> } | undefined,
  job: 'save' | 'delete' = 'save',
) {
  const token = auth?.token;
  const allowed = job === 'delete' ? DELETE_ROLES : CUSTOMER_ROLES;
  if (!token?.tenant_id || !token.staff_id || !allowed.includes(String(token.staff_role))) {
    throw new HttpsError(
      'permission-denied',
      job === 'delete'
        ? 'Only the owner can remove a customer.'
        : 'Only an owner or supervisor can add a customer.',
    );
  }
  return { tenantId: String(token.tenant_id), staffId: String(token.staff_id) };
}

/**
 * Digits only, keyed on the last nine.
 *
 * The same person is written 0712 345678 at one till and +254712345678 at the
 * next, and two spellings of one phone number is two debtor accounts for one
 * debtor.
 */
export function normalisePhone(phone: unknown): string {
  const digits = String(phone ?? '').replace(/\D/g, '');
  return digits.length > 9 ? digits.slice(-9) : digits;
}

/** The natural key is the phone; someone without one keys on their name. */
export function customerKey(tenantId: string, name: string, phone: unknown): string {
  return `${tenantId}:${normalisePhone(phone) || name.trim().toLowerCase()}`;
}

export const saveCustomer = onCall({ region: FUNCTION_REGION }, async (request) => {
  const actor = customerActor(request.auth);
  const input = asRecord(request.data);

  const name = optionalText(input.name, 'name', 120);
  if (!name) throw new HttpsError('invalid-argument', 'Give the customer a name.');

  const phone = optionalText(input.phone, 'phone', 32);
  const kraPin = optionalText(input.kraPin, 'kraPin', 32)?.toUpperCase() ?? null;
  if (kraPin && !KRA_PIN_PATTERN.test(kraPin)) {
    throw new HttpsError('invalid-argument', 'A KRA PIN looks like A000000000Z.');
  }

  // One person, one document: re-registering somebody already on file updates
  // them instead of opening a second account their debt can hide behind.
  const id = deterministicId('customer', customerKey(actor.tenantId, name, phone));

  // Only what the caller actually sent is written. The till adds a name and a
  // phone; that must not blank the KRA PIN or reset the credit limit of a
  // customer the office already set one for.
  const record: Record<string, unknown> = {
    tenantId: actor.tenantId,
    name,
    isActive: true,
  };
  if (phone !== null) record.phone = phone;
  if (kraPin !== null) record.kraPin = kraPin;
  if (input.priceTier !== undefined) {
    record.priceTier = String(input.priceTier).toUpperCase() === 'WHOLESALE' ? 'WHOLESALE' : 'RETAIL';
  }
  if (input.creditLimitMinor !== undefined) {
    record.creditLimitMinor = minorUnits(input.creditLimitMinor, 'creditLimitMinor');
  }

  await db.collection('customers').doc(id).set(
    { ...record, updatedAt: Timestamp.now(), updatedByStaffId: actor.staffId },
    { merge: true },
  );

  return { id, ...record };
});

/**
 * Removes a customer from the directory.
 *
 * Retired rather than deleted: sales point at this document, and a sale whose
 * customer no longer exists is a sale nobody can bill, reprint or reconcile.
 * The walk-in is refused outright - every anonymous sale is booked to it.
 *
 * A customer still owing money is refused too. Deleting one is how a debt
 * quietly stops being anybody's.
 */
export const deleteCustomer = onCall({ region: FUNCTION_REGION }, async (request) => {
  const actor = customerActor(request.auth, 'delete');
  const customerId = documentId(asRecord(request.data).customerId, 'customerId');
  if (customerId === 'cust-walkin') {
    throw new HttpsError('failed-precondition', 'The walk-in customer cannot be removed.');
  }

  const ref = db.collection('customers').doc(customerId);

  return db.runTransaction(async (tx) => {
    const doc = await tx.get(ref);
    if (!doc.exists || doc.data()?.tenantId !== actor.tenantId) {
      throw new HttpsError('not-found', 'Customer not found.');
    }

    // Payments have named their customer since sales started recording it, so
    // this catches every receivable raised from that version on.
    const unpaid = await tx.get(
      db.collection('payments')
        .where('customerId', '==', customerId)
        .where('method', '==', 'credit'),
    );
    const owing = unpaid.docs.some((payment) => !payment.data().settledAt);
    if (owing) {
      throw new HttpsError('failed-precondition', 'This customer still has unpaid invoices. Settle them first.');
    }

    const now = Timestamp.now();
    tx.update(ref, { isActive: false, retiredAt: now, retiredByStaffId: actor.staffId });
    tx.create(db.collection('audit_logs').doc(), {
      tenantId: actor.tenantId,
      actorStaffId: actor.staffId,
      action: 'customer.retired',
      entityId: customerId,
      metadata: { name: doc.data()?.name ?? null },
      createdAt: now,
    });

    return { customerId, isActive: false };
  });
});
