import { getFirebase, currentClaims } from './firebase';

export const cashIsEnabled = () => localStorage.getItem('pos_cash_enabled') !== 'false';

export async function pullPaymentSettings() {
  const fb = await getFirebase();
  const claims = await currentClaims();
  if (!fb || !claims?.tenant_id) return cashIsEnabled();
  const doc = await fb.firestore.getDoc(fb.firestore.doc(fb.dbInstance, 'tenant_settings', claims.tenant_id));
  if (!doc.exists()) throw new Error('Business payment settings are unavailable.');
  const settings = doc.data();
  const enabled = settings.cashEnabled === true && settings.acceptedPaymentMethods?.includes('cash') === true;
  localStorage.setItem('pos_cash_enabled', String(enabled));
  return enabled;
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
  localStorage.setItem('pos_cash_enabled', String(enabled));
}
