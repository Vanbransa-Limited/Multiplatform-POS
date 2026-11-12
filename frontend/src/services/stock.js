import { tenantStorage } from './tenant-cache.js';
import { getFirebase, currentClaims, callFunction } from './firebase';
import { db } from '../db/schema';

/**
 * Every business has a House; the Store is optional and sits in front of it.
 * Cached locally so navigation can hide the Store screen before the network
 * answers, and refreshed by pullStock.
 */
export const storeIsEnabled = () => tenantStorage.getItem('pos_store_enabled') !== 'false';
export const stockLocations = () => storeIsEnabled() ? ['STORE', 'HOUSE'] : ['HOUSE'];

/** Where a delivery may be booked. With a Store, that is the only door. */
export const receivingLocation = () => storeIsEnabled() ? 'STORE' : 'HOUSE';

export async function pullStock() {
  const fb = await getFirebase(); const claims = await currentClaims();
  if (!fb || !claims?.tenant_id) throw new Error('Connect to the business to load stock.');
  const [settings, balances] = await Promise.all([
    fb.firestore.getDoc(fb.firestore.doc(fb.dbInstance, 'tenant_settings', claims.tenant_id)),
    fb.firestore.getDocs(fb.firestore.query(fb.firestore.collection(fb.dbInstance, 'stock_balances'), fb.firestore.where('tenantId', '==', claims.tenant_id))),
  ]);
  const data = settings.data() || {};
  // Mirrors the server's fallback: a tenant never migrated off the old
  // three-way mode keeps whatever Store it already had.
  const enabled = typeof data.storeEnabled === 'boolean' ? data.storeEnabled : data.stockMode !== 'house_only';
  tenantStorage.setItem('pos_store_enabled', String(enabled));
  await db.transaction('rw', db.stock_balances, async () => {
    await db.stock_balances.clear();
    await db.stock_balances.bulkPut(balances.docs.map((doc) => ({ ...doc.data(), id: doc.id })));
  });
  window.dispatchEvent(new Event('stock-policy-changed'));
}

/**
 * The stock audit trail.
 *
 * These rows are written only by the callables and `audit_logs` denies every
 * client write, so what comes back cannot have been edited by the person whose
 * correction it records.
 */
export async function pullStockAudits(max = 100) {
  const fb = await getFirebase(); const claims = await currentClaims();
  if (!fb || !claims?.tenant_id) throw new Error('Sign in to read the stock audit trail.');
  const snapshot = await fb.firestore.getDocs(fb.firestore.query(
    fb.firestore.collection(fb.dbInstance, 'audit_logs'),
    fb.firestore.where('tenantId', '==', claims.tenant_id),
    fb.firestore.orderBy('createdAt', 'desc'),
    fb.firestore.limit(400),
  ));
  return snapshot.docs
    .map((doc) => ({ id: doc.id, ...doc.data() }))
    .filter((row) => String(row.action || '').startsWith('stock.'))
    .slice(0, max);
}

/**
 * This branch's movement trail, newest first.
 *
 * Both rooms come back in one read so the two screens reconcile against each
 * other: the House can see what the Store issued, and the Store can see what
 * the House took.
 */
export async function pullStockMovements(branchId, max = 60) {
  const fb = await getFirebase(); const claims = await currentClaims();
  if (!fb || !claims?.tenant_id || !branchId) return [];
  const snapshot = await fb.firestore.getDocs(fb.firestore.query(
    fb.firestore.collection(fb.dbInstance, 'stock_movements'),
    fb.firestore.where('tenantId', '==', claims.tenant_id),
    fb.firestore.where('branchId', '==', branchId),
    fb.firestore.orderBy('createdAt', 'desc'),
    fb.firestore.limit(max),
  ));
  return snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
}

/** Books a whole delivery note or stock take from a spreadsheet. */
export async function importStock(payload) {
  const result = await callFunction('importStock', payload);
  await pullStock();
  return result;
}

export async function changeStock(input) { const result = await callFunction('changeStock', input); await pullStock(); return result; }
export async function configureStock(storeEnabled) { const result = await callFunction('configureStock', { storeEnabled }); await pullStock(); return result; }
