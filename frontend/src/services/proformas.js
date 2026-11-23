import { getFirebase, currentClaims, callFunction } from './firebase.js';

export async function watchProformas(onInvoices, onError) {
  const [fb, claims] = await Promise.all([getFirebase(), currentClaims()]);
  if (!fb || !claims?.tenant_id) {
    onInvoices([]);
    return () => {};
  }
  return fb.firestore.onSnapshot(fb.firestore.query(
    fb.firestore.collection(fb.dbInstance, 'proformas'),
    fb.firestore.where('tenantId', '==', claims.tenant_id),
  ), snapshot => onInvoices(snapshot.docs.map(doc => ({ ...doc.data(), id: doc.id }))), onError);
}

export const issueProforma = input => callFunction('issueProforma', input);
export const payProforma = input => callFunction('payProforma', input);
