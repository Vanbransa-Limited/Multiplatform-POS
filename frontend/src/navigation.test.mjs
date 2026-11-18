import test from 'node:test';
import assert from 'node:assert/strict';

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => store.get(k) ?? null,
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
const { canViewTab, canSell } = await import('./navigation.js');
const setAccess = (map) => localStorage.setItem('pos_module_access', JSON.stringify(map));

test('without an owner map, the built-in table decides and everyone sells', () => {
  store.clear();
  assert.equal(canViewTab('Cashier', 'tabs'), true);
  assert.equal(canViewTab('Cashier', 'settings'), false);
  assert.equal(canViewTab('Cashier', 'till'), true);
  for (const role of ['Owner', 'Store Manager', 'Supervisor', 'Cashier', 'Bar Staff', 'Store Keeper']) {
    assert.equal(canSell(role), true);
  }
});

test("the owner's map overrides the table, in role codes, and never locks the owner out", () => {
  store.clear();
  setAccess({ tabs: ['bar_staff'], settings: [], sell: ['cashier'], till: ['cashier'] });
  assert.equal(canViewTab('Cashier', 'tabs'), false);
  assert.equal(canViewTab('Bar Staff', 'tabs'), true);
  assert.equal(canViewTab('Store Manager', 'settings'), false);
  assert.equal(canViewTab('Owner', 'settings'), true);
  assert.equal(canViewTab('Bar Staff', 'till'), false);
  // Modules the owner never touched keep their defaults.
  assert.equal(canViewTab('Cashier', 'orders'), true);
  assert.equal(canSell('Cashier'), true);
  assert.equal(canSell('Store Keeper'), false);
  assert.equal(canSell('Owner'), true);
});

test('a switched-off Store hides its screen whatever the map says, and junk in the cache falls back', () => {
  store.clear();
  setAccess({ 'store-stock': ['store_keeper'] });
  localStorage.setItem('pos_store_enabled', 'false');
  assert.equal(canViewTab('Store Keeper', 'store-stock'), false);
  store.clear();
  localStorage.setItem('pos_module_access', '{not json');
  assert.equal(canViewTab('Cashier', 'tabs'), true);
  assert.equal(canSell('Cashier'), true);
});
