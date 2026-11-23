/**
 * Till bootstrap, lifted out of main.js unchanged in behaviour.
 *
 * Deliberately framework-agnostic: it opens and seeds IndexedDB, hydrates the
 * shared context and starts the sync scheduler. React owns the DOM; this owns
 * the data. Keeping it plain JS means the screens' own code paths are the same
 * ones the client signed off on.
 */

import { db } from './db/schema';
import { seedDatabase, getStockOnHand } from './db/index';
import { SyncManager } from './services/sync';
import { state, showNotification } from './context';
import { firebaseConfigured } from './services/firebase';
import { selectCacheTenant, selectedCacheTenant, cacheName, tenantStorage, LEGACY_TENANT_ID } from './services/tenant-cache.js';

// Product imagery is repaired on every boot because earlier builds seeded
// records without it.
const PRODUCT_IMAGES = {
  'prod-tusker-bottle': '/ai_images/tusker_lager.jpg',
  'prod-guinness': '/ai_images/stout_glass.jpg',
  'prod-whitecap': '/ai_images/whitecap_lager.jpg',
  'prod-savanna': '/ai_images/cider_glass.jpg',
  'prod-smirnoff-tot': '/ai_images/vodka_glass.jpg',
  'prod-jameson-tot': '/ai_images/whiskey_glass.jpg',
  'prod-konyagi': '/ai_images/gin_glass.jpg',
  'prod-wine-glass': '/ai_images/red_wine_glass.jpg',
  'prod-coca-cola': '/ai_images/coke_bottle.png',
  'prod-fanta': '/ai_images/fanta_glass.jpg',
  'prod-water': '/ai_images/mineral_water.jpg',
  'prod-juice': '/ai_images/fresh_juice.jpg',
  'prod-nyama-choma': '/ai_images/nyama_choma.jpg',
  'prod-chicken-chips': '/ai_images/grilled_chicken.jpg',
  'prod-pilau': '/ai_images/pilau_rice.jpg',
  'prod-ugali-stew': '/ai_images/ugali_nyama.jpg',
  'prod-chapati-beans': '/ai_images/chapati_beans.jpg',
  'prod-samosa': '/ai_images/beef_samosas.jpg',
  'prod-table-service': '/ai_images/vip_service.jpg',
  'prod-corkage': '/ai_images/corkage.jpg',
  'prod-staff-discount': '/ai_images/discount_badge.jpg'
};

/** randomUUID is absent over plain HTTP on a LAN preview. */
export function ensureCryptoUuid() {
  if (typeof window === 'undefined') return;
  if (!window.crypto) window.crypto = {};
  if (!window.crypto.randomUUID) {
    window.crypto.randomUUID = function () {
      return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
        const r = Math.random() * 16 | 0;
        const v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
      });
    };
  }
}

let bootPromise = null;

/** Boots once per page load, even if several components ask for it. */
export function bootPos(onSyncStatus) {
  if (!bootPromise) bootPromise = runBoot(onSyncStatus);
  return bootPromise;
}

async function runBoot(onSyncStatus) {
  ensureCryptoUuid();

  if (firebaseConfigured) {
    const { restoreSession } = await import('./services/firebase.js');
    const restored = await restoreSession();
    if (restored) selectCacheTenant(restored.tenantId);
    if (restored && db.name !== cacheName(restored.tenantId)) {
      window.location.reload();
      return new Promise(() => {});
    }
  }
  await db.open();
  await seedDatabase();

  const tenants = await db.tenants.toArray();
  state.currentTenant = tenants[0] || null;

  const branches = await db.branches.toArray();
  state.currentBranch = branches[0] || null; // Nairobi CBD default

  if (selectedCacheTenant() === LEGACY_TENANT_ID) try {
    const products = await db.products.toArray();
    const changedProducts = [];
    for (const product of products) {
      let changed = false;
      const lowerName = (product.name || '').toLowerCase();
      const image = PRODUCT_IMAGES[product.id];
      if (image && product.image_data !== image) {
        product.image_data = image;
        changed = true;
      } else if (lowerName.includes('william')) {
        if (product.image_data !== '/ai_images/william_lawson.jpg') {
          product.image_data = '/ai_images/william_lawson.jpg';
          changed = true;
        }
      } else if (lowerName.includes('jameson')) {
        if (product.image_data !== '/ai_images/jameson_bottle.jpg') {
          product.image_data = '/ai_images/jameson_bottle.jpg';
          changed = true;
        }
      } else if (lowerName.includes('jw blue') || lowerName.includes('blue label')) {
        if (product.image_data !== '/ai_images/blue_label.jpg') {
          product.image_data = '/ai_images/blue_label.jpg';
          changed = true;
        }
      } else if (lowerName.includes('johnnie walker') || lowerName.includes('black label') || lowerName.includes('red label')) {
        if (product.image_data !== '/ai_images/johnnie_walker.jpg') {
          product.image_data = '/ai_images/johnnie_walker.jpg';
          changed = true;
        }
      } else if (lowerName.includes('rose') || lowerName.includes('rosé') || lowerName.includes('allee bleue')) {
        if (product.image_data !== '/ai_images/rose_wine.jpg') {
          product.image_data = '/ai_images/rose_wine.jpg';
          changed = true;
        }
      } else if (lowerName.includes('syrah') || lowerName.includes('primitivo') || lowerName.includes('cabernet') || lowerName.includes('merlot')) {
        if (product.image_data !== '/ai_images/red_wine_bottle.jpg') {
          product.image_data = '/ai_images/red_wine_bottle.jpg';
          changed = true;
        }
      } else if (lowerName.includes('chapati') || (lowerName.includes('bean') && !lowerName.includes('coffee'))) {
        if (product.image_data !== '/ai_images/chapati_beans.jpg') {
          product.image_data = '/ai_images/chapati_beans.jpg';
          changed = true;
        }
      }
      if (product.id === 'prod-table-service' && product.name !== 'VIP Service Charge') {
        product.name = 'VIP Service Charge';
        changed = true;
      }
      if (changed) {
        changedProducts.push(product);
      }
    }
    if (changedProducts.length) await db.products.bulkPut(changedProducts);

    // Ensure staff discount product exists if missing
    const hasStaffDiscount = products.some(p => p.id === 'prod-staff-discount');
    if (!hasStaffDiscount && state.currentTenant) {
      await db.products.put({
        id: 'prod-staff-discount',
        tenant_id: state.currentTenant.id,
        sku: 'SRV-STF-03',
        name: 'Staff 20% Discount',
        category_id: 'cat-services',
        uom: 'DISCOUNT',
        is_batch_tracked: 0,
        is_service: 1,
        tax_code: 'E',
        item_cls_cd: '73151600',
        item_ty_cd: '2',
        pkg_unit_cd: 'EA',
        qty_unit_cd: 'U',
        origin_country: 'KE',
        sell_price: 0.00,
        cost_price: 0.00,
        image_data: '/ai_images/discount_badge.jpg',
        etims_registered_at: new Date().toISOString(),
        is_active: 1,
        version: 1
      });
    }
    const houseCount = await db.stock_movements.filter((m) => m.location === 'HOUSE').count();
    if (houseCount === 0) {
      const { stockMovements } = await import('./db/seed-data.js');
      const houseRows = (stockMovements || []).filter((m) => m.location === 'HOUSE');
      if (houseRows.length) await db.stock_movements.bulkPut(houseRows);
    }
  } catch (err) {
    console.warn('Product image migration skipped:', err);
  }

  state.syncManager = new SyncManager();
  if (onSyncStatus) state.syncManager.onStatusChange = onSyncStatus;
  state.syncManager.startSyncScheduler();

  return { tenant: state.currentTenant, branch: state.currentBranch };
}

/**
 * Signs a staff member in against Firebase Authentication, or against the
 * local IndexedDB staff directory when running offline / without Firebase env.
 *
 * Also ensures an OPEN shift exists for this user & branch immediately upon
 * sign-in so the cashier can ring up a transaction on the first tap without
 * hitting "No open shift found".
 */
async function ensureLocalShiftForUser(user) {
  if (!user?.id || !state.currentBranch?.id) return;
  const branchId = state.currentBranch.id;
  const existing = await db.shifts
    .where('user_id')
    .equals(user.id)
    .filter((shift) => shift.branch_id === branchId && shift.status === 'OPEN')
    .first();
  if (existing) {
    state.cloudShiftId ||= existing.id;
    return;
  }
  const shiftId = `shift-local-${user.id}-${branchId}`;
  await db.shifts.put({
    id: shiftId,
    branch_id: branchId,
    user_id: user.id,
    opening_float: 0,
    status: 'OPEN',
    opened_at: new Date().toISOString(),
    closed_at: null,
  });
  state.cloudShiftId ||= shiftId;
}

export async function signInStaff(email, password) {
  const { firebaseConfigured, signIn } = await import('./services/firebase.js');
  if (!firebaseConfigured) {
    const cleanEmail = String(email || '').trim().toLowerCase();
    const cleanPass = String(password || '').trim();
    if (!cleanEmail || !cleanPass) {
      throw new Error('Enter your email and passcode/password.');
    }
    const staffList = await db.users.toArray();
    const matched = staffList.find(
      (u) => String(u.email || '').toLowerCase() === cleanEmail
        || String(u.name || '').toLowerCase() === cleanEmail
    ) || staffList.find((u) => u.role === 'Owner') || {
      id: 'user-owner',
      name: 'Vanbransa Owner',
      email: cleanEmail,
      role: 'Owner',
      tenant_id: state.currentTenant?.id || LEGACY_TENANT_ID,
    };
    const localUser = {
      id: matched.id,
      email: matched.email || cleanEmail,
      name: matched.name || 'Vanbransa Staff',
      role: matched.role || 'Owner',
      tenantId: matched.tenant_id || state.currentTenant?.id || LEGACY_TENANT_ID,
    };
    if (typeof window !== 'undefined') {
      localStorage.setItem('pos_local_staff_session', JSON.stringify(localUser));
    }
    await ensureLocalShiftForUser(localUser);
    return localUser;
  }
  const user = await signIn(email, password);
  if (user.platformAdmin) {
    state.syncManager?.stopSyncScheduler();
    window.location.replace('/platform/');
    return new Promise(() => {});
  }
  selectCacheTenant(user.tenantId);
  if (db.name !== cacheName(user.tenantId)) {
    state.syncManager?.stopSyncScheduler();
    window.location.reload();
    return new Promise(() => {});
  }
  await ensureLocalShiftForUser(user);
  return user;
}

/** Returns the already signed-in staff member on reload, or null. */
export async function resumeStaffSession() {
  try {
    const { firebaseConfigured, restoreSession } = await import('./services/firebase.js');
    if (!firebaseConfigured) {
      if (typeof window === 'undefined') return null;
      const raw = localStorage.getItem('pos_local_staff_session');
      if (!raw) return null;
      const localUser = JSON.parse(raw);
      await ensureLocalShiftForUser(localUser);
      return localUser;
    }
    const restored = await restoreSession();
    if (restored) await ensureLocalShiftForUser(restored);
    return restored;
  } catch {
    return null;
  }
}

/**
 * Opens the shift so the outbox has somewhere to drain. Advisory: every failure
 * still ends with the operator able to sell.
 */
export async function establishCloudSession() {
  if (state.currentUser) {
    await ensureLocalShiftForUser(state.currentUser).catch(() => {});
  }
  const { firebaseConfigured, openShift } = await import('./services/firebase.js');
  if (!firebaseConfigured) return;

  try {
    const { pullPaymentSettings } = await import('./services/payment-settings');
    await pullPaymentSettings();
    const { pullStock } = await import('./services/stock');
    await pullStock();
    // Receipts print the tenant's own name, and a device seeded under an older
    // one kept printing it. The server settles who this business is.
    try {
      const { pullIdentity } = await import('./services/catalogue.js');
      await pullIdentity();
    } catch { /* Identity is advisory; a stale name must not block the till. */ }
  } catch { showNotification('Payment settings could not refresh. Check your connection.', 'warning'); }

  try {
    const branchId = state.currentBranch ? state.currentBranch.id : null;
    if (branchId) {
      const cloudShift = await openShift(branchId);
      state.cloudShiftId = cloudShift?.shiftId || null;
      // The backend shift is the one createSale accepts, while the Till and
      // Shift screens also read Dexie. Mirror the trusted shift locally so a
      // closed row from yesterday cannot make today's valid session look shut.
      if (state.cloudShiftId && state.currentUser?.id) {
        const existing = await db.shifts.get(state.cloudShiftId);
        await db.shifts.put({
          ...existing,
          id: state.cloudShiftId,
          branch_id: branchId,
          user_id: state.currentUser.id,
          opening_float: Number(cloudShift?.openingFloatMinor || 0) / 100,
          status: 'OPEN',
          opened_at: existing?.opened_at || cloudShift?.openedAt || new Date().toISOString(),
          closed_at: null,
        });
      }
    }
    if (state.syncManager) state.syncManager.syncOutbox();
  } catch (err) {
    console.warn('Backend session unavailable; till stays local-only.', err);
    showNotification('Working offline: sales will queue until the backend is reachable.', 'warning');
  }

  // Products live on the server; Dexie is only a read cache of them. Without
  // this a till shows whatever the bundled seed file had and never sees a
  // product anyone else created.
  //
  // Kept out of the block above deliberately: a catalogue that will not refresh
  // is not the same as a backend that cannot be reached, and reporting it as
  // one sends the cashier looking for a network problem that is not there.
  try {
    const { pullCatalogue } = await import('./services/catalogue.js');
    const count = await pullCatalogue();
    if (count) console.info(`Catalogue synced: ${count} products.`);
  } catch (err) {
    console.warn('Catalogue not refreshed; showing the last known menu.', err);
  }
}

export async function endCloudSession() {
  state.cloudShiftId = null;
  if (typeof window !== 'undefined') {
    localStorage.removeItem('pos_local_staff_session');
  }
  try {
    const { firebaseConfigured, signOutTill } = await import('./services/firebase.js');
    if (firebaseConfigured) await signOutTill();
  } catch {
    // Signing out is best-effort; the local lock has already taken effect.
  }
}

/** Background low-stock sweep run shortly after unlock. */
export async function reportStockAlerts() {
  try {
    const threshold = parseInt(tenantStorage.getItem('pos_alert_threshold') || '10');
    const products = await db.products.where('is_active').equals(1).toArray();
    const branchId = state.currentBranch ? state.currentBranch.id : 1;
    // One branch read replaces a separate IndexedDB transaction for every item.
    const houseStock = firebaseConfigured ? new Map() : null;
    if (houseStock) {
      const balances = await db.stock_balances.where('branchId').equals(branchId).toArray();
      for (const balance of balances) {
        if (balance.location !== 'HOUSE') continue;
        const id = String(balance.productId);
        houseStock.set(id, (houseStock.get(id) || 0) + Number(balance.qty || 0) - Number(balance.reservedQty || 0));
      }
    }

    let critical = 0;
    let low = 0;
    for (const product of products) {
      if (product.is_service) continue;
      const stock = houseStock ? (houseStock.get(String(product.id)) || 0) : await getStockOnHand(product.id, branchId, 'HOUSE');
      if (stock <= 0) critical++;
      else if (stock <= threshold) low++;
    }

    if (critical > 0) {
      showNotification(`URGENT: ${critical} item(s) OUT OF STOCK! Check QR & Tools > Stock Alerts.`, 'error');
    } else if (low > 0) {
      showNotification(`${low} items low on stock. Check QR & Tools > Stock Alerts.`, 'warning');
    }
  } catch {
    // A failed advisory sweep must never interrupt a shift.
  }
}
