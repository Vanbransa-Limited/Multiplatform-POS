import { tenantStorage } from './tenant-cache.js';
import { getFirebase, currentClaims, callFunction } from './firebase';
import { storeIsEnabled } from './stock.js';
import { NAV_ITEMS, canViewTab, canSell } from '../navigation.js';
import { ROLE_LABELS } from './roles.js';

/**
 * The owner's matrix of which roles reach each module, and who may sell.
 * The owner is not a column: they always have everything.
 */
export const ACCESS_ROLES = Object.keys(ROLE_LABELS).filter((code) => code !== 'owner');

export function accessModules() {
  // A switched-off Store has no screen to grant; its saved row is kept as is.
  const tabs = NAV_ITEMS.filter((item) => item.tab !== 'store-stock' || storeIsEnabled());
  return [{ key: 'sell', label: 'Sell (ring up sales)' }, ...tabs.map((item) => ({ key: item.tab, label: item.label }))];
}

/** What each role can reach right now, defaults included, in role codes. */
export function currentAccess() {
  return Object.fromEntries(accessModules().map(({ key }) => [key, ACCESS_ROLES.filter((code) => (
    key === 'sell' ? canSell(ROLE_LABELS[code]) : canViewTab(ROLE_LABELS[code], key)
  ))]));
}

export async function saveModuleAccess(changes) {
  let previous = {};
  try { previous = JSON.parse(tenantStorage.getItem('pos_module_access') || '{}') || {}; } catch { /* corrupt cache */ }
  const fb = await getFirebase();
  const claims = await currentClaims();
  const merged = { ...previous, ...changes };
  const moduleAccess = (fb && claims?.tenant_id)
    ? (await callFunction('setModuleAccess', { moduleAccess: merged })).moduleAccess
    : merged;
  tenantStorage.setItem('pos_module_access', JSON.stringify(moduleAccess));
  // The sidebar and mobile nav already redraw on this event.
  window.dispatchEvent(new Event('stock-policy-changed'));
  return moduleAccess;
}

