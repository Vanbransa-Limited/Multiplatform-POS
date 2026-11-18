import { tenantStorage } from './tenant-cache.js';
import { getFirebase, currentClaims } from './firebase';

export const cashIsEnabled = () => tenantStorage.getItem('pos_cash_enabled') !== 'false';

export function cachedAcceptedMethods() {
  try {
    const methods = JSON.parse(tenantStorage.getItem('pos_accepted_methods') || '[]');
    return Array.isArray(methods) ? methods : [];
  } catch { return []; }
}

export async function pullPaymentSettings() {
  const fb = await getFirebase();
  const claims = await currentClaims();
  if (!fb || !claims?.tenant_id) return cashIsEnabled();
  const doc = await fb.firestore.getDoc(fb.firestore.doc(fb.dbInstance, 'tenant_settings', claims.tenant_id));
  if (!doc.exists()) throw new Error('Business payment settings are unavailable.');
  const settings = doc.data();
  const enabled = settings.cashEnabled === true && settings.acceptedPaymentMethods?.includes('cash') === true;
  tenantStorage.setItem('pos_cash_enabled', String(enabled));
  return enabled;
}

/**
 * The tenders this business accepts, besides cash.
 *
 * createSale refuses a sale carrying a tender that is not on this list, and it
 * refuses it as a failed-precondition - which the till treats as permanent. So
 * a bank transfer taken on a business that never enabled bank_transfer settles
 * at the counter, queues, and is rejected forever, with the money visible only
 * on that one device. Cash has had a switch for a long time; nothing else did.
 */
export const TENDERS = [
  { id: 'mpesa', label: 'M-Pesa', note: 'STK push and paybill confirmations.' },
  { id: 'bank_transfer', label: 'Bank transfer', note: 'Settled against a statement reference typed at the counter.' },
  { id: 'card', label: 'Card terminal', note: 'Recorded with the reference the terminal printed.' },
  { id: 'airtel_money', label: 'Airtel Money', note: 'Recorded like any other digital tender.' },
];

export async function pullAcceptedMethods() {
  const fb = await getFirebase();
  const claims = await currentClaims();
  if (!fb || !claims?.tenant_id) return [];
  const doc = await fb.firestore.getDoc(fb.firestore.doc(fb.dbInstance, 'tenant_settings', String(claims.tenant_id)));
  const methods = doc.exists() && Array.isArray(doc.data().acceptedPaymentMethods)
    ? doc.data().acceptedPaymentMethods
    : [];
  tenantStorage.setItem('pos_accepted_methods', JSON.stringify(methods));
  return methods;
}

/** Cash keeps its own switch, so it is never changed from here. */
export async function saveAcceptedMethods(methods) {
  const fb = await getFirebase();
  const claims = await currentClaims();
  if (!fb || !claims?.tenant_id) throw new Error('Sign in and connect to change accepted payments.');
  const wanted = new Set(TENDERS.map((tender) => tender.id).filter((id) => methods.includes(id)));

  const ref = fb.firestore.doc(fb.dbInstance, 'tenant_settings', String(claims.tenant_id));
  await fb.firestore.runTransaction(fb.dbInstance, async (transaction) => {
    const doc = await transaction.get(ref);
    if (!doc.exists()) throw new Error('Business payment settings are unavailable.');
    const current = new Set(doc.data().acceptedPaymentMethods || []);
    for (const tender of TENDERS) {
      if (wanted.has(tender.id)) current.add(tender.id); else current.delete(tender.id);
    }
    if (!current.size) throw new Error('Leave at least one payment method enabled.');
    transaction.update(ref, {
      acceptedPaymentMethods: [...current],
      updatedAt: fb.firestore.serverTimestamp(), updatedByStaffId: claims.staff_id,
    });
  });
  tenantStorage.setItem('pos_accepted_methods', JSON.stringify([...wanted]));
  return [...wanted];
}

export async function saveCashEnabled(enabled) {
  const fb = await getFirebase();
  const claims = await currentClaims();
  if (!fb || !claims?.tenant_id) throw new Error('Sign in and connect to save business payment settings.');
  const ref = fb.firestore.doc(fb.dbInstance, 'tenant_settings', claims.tenant_id);
  await fb.firestore.runTransaction(fb.dbInstance, async (transaction) => {
    const doc = await transaction.get(ref);
    if (!doc.exists()) throw new Error('Business payment settings are unavailable.');
    const methods = new Set(doc.data().acceptedPaymentMethods || []);
    if (enabled) methods.add('cash'); else methods.delete('cash');
    if (!methods.size) throw new Error('Enable another payment method before disabling cash.');
    transaction.update(ref, {
      cashEnabled: enabled, acceptedPaymentMethods: [...methods],
      updatedAt: fb.firestore.serverTimestamp(), updatedByStaffId: claims.staff_id,
    });
  });
  tenantStorage.setItem('pos_cash_enabled', String(enabled));
}
