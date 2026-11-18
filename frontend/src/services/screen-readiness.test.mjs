import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

async function method(file, name, dependencies = {}) {
  const source = (await readFile(new URL(`../ui/${file}.js`, import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
  const prefix = source.includes(`  async ${name}(`) ? 'async ' : '';
  const start = source.indexOf(`  ${prefix}${name}(`);
  const body = source.slice(start, source.indexOf('\n  }', start) + 4).replace(`${prefix}${name}(`, `${prefix}function ${name}(`);
  return new Function(...Object.keys(dependencies), `return ${body};`)(...Object.values(dependencies));
}
const stalled = () => new Promise(() => {});

test('Settings renders cached controls and starts refresh without waiting on the network', async () => {
  const calls = [];
  const load = await method('settings', 'load', { cachedTradingHours: () => ({ dayStartHour: 6 }), cachedAcceptedMethods: () => ['mpesa'] });
  await load.call({ render: () => calls.push('render'), bindEvents: () => calls.push('bind'), refreshSettings: () => { calls.push('refresh'); return stalled(); } });
  assert.deepEqual(calls, ['render', 'bind', 'refresh']);
});

test('Settings refresh keeps an edited form instead of replacing its input values', async () => {
  const status = {};
  const refresh = await method('settings', 'refreshSettings', {
    pullStock: async () => {}, pullPaymentSettings: async () => {},
    pullTradingHours: async () => ({ dayStartHour: 7 }), pullAcceptedMethods: async () => ['mpesa'],
  });
  let renders = 0, updates = 0;
  await refresh.call({ settingsEdited: true, container: { querySelector: () => status }, render: () => renders++, setSettingsWriteState: () => updates++ });
  assert.equal(renders, 0);
  assert.equal(updates, 1);
  assert.match(status.textContent, /up to date/);
});

test('Customers shows its cached directory while the server is stalled', async () => {
  const calls = [];
  const load = await method('customers', 'load');
  await load.call({ render() {}, bindEvents() {}, loadCustomers: async () => calls.push('cache'), refreshCustomers: () => { calls.push('refresh'); return stalled(); } });
  assert.deepEqual(calls, ['cache', 'refresh']);
});

test('cached Settings cannot save before refresh and non-owner buttons remain disabled afterwards', async () => {
  const buttons = [{ disabled: true, dataset: {} }, { disabled: false, dataset: {} }];
  const update = await method('settings', 'setSettingsWriteState');
  const view = { settingsReady: false, container: { querySelectorAll: () => buttons } };
  update.call(view);
  assert.deepEqual(buttons.map(button => button.disabled), [true, true]);
  view.settingsReady = true;
  update.call(view);
  assert.deepEqual(buttons.map(button => button.disabled), [true, false]);
});

test('Finance renders filters without waiting for trading-hour or ledger requests', async () => {
  const calls = [];
  const load = await method('finance', 'load', {
    cachedTradingHours: () => ({ dayStartHour: 6 }), pullTradingHours: stalled, createMobileFilters: () => ({}),
    ProformaRegister: class { async load() {} dispose() {} },
  });
  await load.call({ container: { querySelector() {} }, render: () => calls.push('render'), bindEvents: () => calls.push('bind'), loadMetrics: () => { calls.push('metrics'); return stalled(); } });
  assert.deepEqual(calls, ['render', 'bind', 'metrics']);
});

test('Till finishes local setup before refreshing the customer directory', async () => {
  const calls = [];
  const load = await method('till', 'load', {
    db: { customers: { where: () => ({ equals: () => ({ first: async () => ({ id: 'guest' }) }) }) } },
    WALK_IN_CUSTOMER_ID: 'guest', window: { location: { search: '' } },
  });
  await load.call({ restoreDraft: async () => {}, render() {}, loadProducts: async () => {}, loadOpenTabs: async () => {},
    loadCustomerDropdown: (_id, options) => { calls.push(options?.refresh === false ? 'cache' : 'refresh'); return options?.refresh === false ? Promise.resolve() : stalled(); },
    updateCartUI: () => calls.push('ready'), refreshCatalogue() {}, selectedCustomer: null,
  });
  assert.deepEqual(calls, ['cache', 'ready', 'refresh']);
});

test('Shifts renders from local data without waiting for payment settings', async () => {
  let rendered = false;
  const load = await method('shifts', 'load', {
    db: { shifts: { where: () => ({ equals: () => ({ filter: () => ({ first: async () => null }) }) }) } },
    state: { currentUser: { id: 'staff' } }, pullPaymentSettings: stalled,
  });
  await load.call({ render: () => { rendered = true; }, bindEvents() {} });
  assert.equal(rendered, true);
});

test('Staff directory populates before a server refresh', async () => {
  const calls = [];
  const load = await method('users', 'load', { createMobileFilters: () => ({}) });
  await load.call({ container: { querySelector() {} }, render() {}, bindEvents() {}, populateUsers: async () => calls.push('cache'), refresh: () => { calls.push('refresh'); return stalled(); } });
  assert.deepEqual(calls, ['cache', 'refresh']);
});
