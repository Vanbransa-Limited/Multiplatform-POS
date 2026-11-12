import { tenantStorage } from './tenant-cache.js';
import { getFirebase, currentClaims } from './firebase.js';
import { DEFAULT_TRADING_DAY, tradingDayConfig } from './financial-period.js';

/**
 * When this business's trading day rolls over.
 *
 * These two hours decide which day money is booked to - a night that crosses
 * midnight belongs to the day it started - so they live on the tenant, not in
 * this browser, and only the roles that own the rest of settings may set them.
 */

const CACHE_KEY = 'pos_trading_hours';

/** Last known hours, for rendering before the server answers. */
export function cachedTradingHours() {
  try {
    return tradingDayConfig(JSON.parse(tenantStorage.getItem(CACHE_KEY) || 'null'));
  } catch {
    return { ...DEFAULT_TRADING_DAY };
  }
}

export async function pullTradingHours() {
  const fb = await getFirebase();
  const claims = await currentClaims();
  if (!fb || !claims?.tenant_id) return cachedTradingHours();
  const doc = await fb.firestore.getDoc(
    fb.firestore.doc(fb.dbInstance, 'tenant_settings', String(claims.tenant_id)),
  );
  const hours = tradingDayConfig(doc.exists() ? doc.data() : null);
  try { tenantStorage.setItem(CACHE_KEY, JSON.stringify(hours)); } catch { /* private window */ }
  return hours;
}

export async function saveTradingHours({ dayStartHour, nightStartHour }) {
  const fb = await getFirebase();
  const claims = await currentClaims();
  if (!fb || !claims?.tenant_id) throw new Error('Sign in and connect to save trading hours.');
  // Refused here as well as in the rules, so the cashier gets a sentence rather
  // than a permission error, and an inverted pair never reaches the books.
  if (!Number.isInteger(dayStartHour) || !Number.isInteger(nightStartHour)
    || dayStartHour < 0 || dayStartHour > 23 || nightStartHour < 0 || nightStartHour > 23) {
    throw new Error('Choose an hour of the day for both.');
  }
  if (nightStartHour <= dayStartHour) {
    throw new Error('The night session has to start after the trading day opens.');
  }

  const ref = fb.firestore.doc(fb.dbInstance, 'tenant_settings', String(claims.tenant_id));
  await fb.firestore.runTransaction(fb.dbInstance, async (transaction) => {
    const doc = await transaction.get(ref);
    if (!doc.exists()) throw new Error('Business settings are unavailable.');
    transaction.update(ref, {
      dayStartHour, nightStartHour,
      updatedAt: fb.firestore.serverTimestamp(), updatedByStaffId: claims.staff_id,
    });
  });
  try {
    tenantStorage.setItem(CACHE_KEY, JSON.stringify({ dayStartHour, nightStartHour }));
  } catch { /* private window */ }
  return { dayStartHour, nightStartHour };
}
