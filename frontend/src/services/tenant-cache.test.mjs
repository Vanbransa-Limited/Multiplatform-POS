import assert from 'node:assert/strict';
import test from 'node:test';
import {
  cacheName, selectCacheTenant, selectedCacheTenant, tenantStorageKey,
  deviceForTenant, walkInForTenant,
} from './tenant-cache.js';

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    entries: () => [...values],
  };
}

test('onboarding a business preserves Titanium database and pending queue address', () => {
  const oldDatabase = { name: cacheName('tenant-01'), sales: [{ id: 'unpaid', sync_pending: 1 }] };
  const snapshot = structuredClone(oldDatabase);
  const selection = memoryStorage();
  assert.equal(selectCacheTenant('tenant-new-shop', selection), true);
  assert.equal(selectedCacheTenant(selection), 'tenant-new-shop');
  assert.notEqual(cacheName(selectedCacheTenant(selection)), oldDatabase.name);
  assert.deepEqual(oldDatabase, snapshot);
  assert.equal(selectCacheTenant('tenant-01', selection), true);
  assert.equal(cacheName(selectedCacheTenant(selection)), 'POS_DB');
});

test('business discounts, menu links and payment preferences cannot read or overwrite legacy preferences', () => {
  const preferences = memoryStorage({ pos_discounts: '[{"name":"Titanium staff"}]', pos_cash_enabled: 'false' });
  const before = preferences.entries();
  for (const key of ['pos_discounts', 'pos_menu_url', 'pos_cash_enabled', 'db_seed_ver']) {
    assert.equal(preferences.getItem(tenantStorageKey(key, 'tenant-new-shop')), null);
    preferences.setItem(tenantStorageKey(key, 'tenant-new-shop'), 'new tenant value');
  }
  for (const [key, value] of before) assert.equal(preferences.getItem(key), value);
  assert.equal(tenantStorageKey('pos_discounts', 'tenant-01'), 'pos_discounts');
});

test('database names and preference namespaces remain distinct for punctuation in IDs', () => {
  assert.notEqual(cacheName('a/b'), cacheName('a%2Fb'));
  assert.notEqual(tenantStorageKey('x', 'a:b'), tenantStorageKey('b:x', 'a'));
  assert.throws(() => selectCacheTenant('', memoryStorage()), /verified business/);
});

test('device and walk-in identities preserve legacy IDs and match newly provisioned tenant IDs', () => {
  assert.equal(deviceForTenant('tenant-01', 'device-old'), 'device-old');
  assert.equal(walkInForTenant('tenant-01'), 'cust-walkin');
  assert.equal(deviceForTenant('tenant-new-shop'), 'tenant-new-shop-till-01');
  assert.equal(walkInForTenant('tenant-new-shop'), 'tenant-new-shop-walkin');
  assert.notEqual(deviceForTenant('tenant-new-shop'), deviceForTenant('tenant-other'));
});
