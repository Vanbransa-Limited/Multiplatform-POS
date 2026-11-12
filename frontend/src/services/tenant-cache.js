// Keep the original database and preferences intact for the existing business.
export const LEGACY_TENANT_ID = 'tenant-01';
const SELECTION_KEY = 'pos_active_cache_tenant';

export function cacheName(tenantId) {
  return !tenantId || tenantId === LEGACY_TENANT_ID
    ? 'POS_DB' : `POS_DB_TENANT_${encodeURIComponent(tenantId)}`;
}

export function selectedCacheTenant(storage = globalThis.sessionStorage) {
  return storage?.getItem(SELECTION_KEY) || LEGACY_TENANT_ID;
}

export function selectCacheTenant(tenantId, storage = globalThis.sessionStorage) {
  if (!tenantId || typeof tenantId !== 'string') throw new Error('A verified business identity is required.');
  const changed = selectedCacheTenant(storage) !== tenantId;
  storage?.setItem(SELECTION_KEY, tenantId);
  return changed;
}

export const CACHE_TENANT_ID = selectedCacheTenant();

export function tenantStorageKey(key, tenantId = CACHE_TENANT_ID) {
  return tenantId === LEGACY_TENANT_ID ? key : `tenant:${encodeURIComponent(tenantId)}:${key}`;
}

export const tenantStorage = {
  getItem(key) { return globalThis.localStorage?.getItem(tenantStorageKey(key)) ?? null; },
  setItem(key, value) { globalThis.localStorage?.setItem(tenantStorageKey(key), value); },
  removeItem(key) { globalThis.localStorage?.removeItem(tenantStorageKey(key)); },
};

export function deviceForTenant(tenantId, legacyDevice = 'device-till-01') {
  return tenantId === LEGACY_TENANT_ID ? legacyDevice : `${tenantId}-till-01`;
}

export function walkInForTenant(tenantId) {
  return tenantId === LEGACY_TENANT_ID ? 'cust-walkin' : `${tenantId}-walkin`;
}
