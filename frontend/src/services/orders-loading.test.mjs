import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const orders = (await readFile(new URL('../ui/orders.js', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
const method = orders.slice(orders.indexOf('  async load()'), orders.indexOf('\n  dispose()')).replace('async load()', 'async function load()');
const buildLoad = new Function('watchCustomerOrders', 'cachedTradingHours', 'pullTradingHours', 'ProformaRegister', `return ${method};`);
const makeLoad = watch => buildLoad(watch, () => ({ dayStartHour: 6 }), () => new Promise(() => {}), class { async load() {} dispose() {} });

test('saved invoice STK sends the original balance and binding; only a definitive failure permits a fresh prompt', async () => {
  const source = orders.slice(orders.indexOf('  async settleByStk('), orders.indexOf('\n  async openTabEditor('))
    .replace('async settleByStk(', 'async function settleByStk(');
  const db = { sale_lines: { where: () => ({ anyOf: () => ({ toArray: async () => [] }) }) } };
  const settle = new Function('db', 'catalogueCartLines', 'DEVICE_ID', 'state', `return ${source};`)(db, () => [], 'device', {});
  for (const status of ['failed', 'cancelled', 'expired', 'ambiguous', 'network-error']) {
    const nodes = new Map();
    const querySelector = selector => { if (!nodes.has(selector)) nodes.set(selector, { value: '0712345678', classList: { remove() {} } }); return nodes.get(selector); };
    let sent;
    const view = { container: { querySelector }, settleStkKey: 'original-key', settleRequestId: 'reservation', stkScope: () => null,
      mpesa: { initiateStkPush: async payload => { sent = payload; if (status === 'network-error') throw new Error('Response lost'); return { success: false, status }; } } };
    const button = {};
    await settle.call(view, button, { dueMinor: 105000, customerId: null, branchId: 'branch' },
      [{ id: 'bill', sale_uuid: 'original-bill', synced_at: 'server-confirmed' }]);
    assert.equal(sent.amountKes, 1050);
    assert.deepEqual(sent.settlementSaleUuids, ['original-bill']);
    assert.equal(sent.checkoutId, 'reservation');
    assert.deepEqual(sent.lines, []);
    assert.equal(button.disabled, false);
    assert.equal(view.settleStkKey !== 'original-key', ['failed', 'cancelled', 'expired'].includes(status));
  }
});

test('reopening a partly settled bill preserves its checkout across reloads and isolates staff accounts', () => {
  const source = orders.slice(orders.indexOf('  openSettleModal('), orders.indexOf('\n  /**\n   * Picks how the money arrived'))
    .replace('openSettleModal(', 'function openSettleModal(');
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const saved = new Map();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: key => saved.get(key), setItem: (key, value) => saved.set(key,value) } });
  const state = { currentTenant: { id: 'tenant' }, currentBranch: { id: 'branch' }, currentUser: { id: 'cashier' } };
  const open = new Function('state', `return ${source};`)(state);
  const makeView = () => ({ settleTarget: () => ({ dueMinor: 50000, ref: 'INV', customerName: 'Guest', branchId: 'branch' }),
    container: { querySelector: () => ({ classList: { add() {} } }) }, selectSettleMethod() {}, showModal() {} });
  try {
    const view = makeView(); open.call(view, 'bill'); const original = view.settleRequestId;
    open.call(view, 'bill'); assert.equal(view.settleRequestId, original);
    const reloaded = makeView(); open.call(reloaded, 'bill'); assert.equal(reloaded.settleRequestId, original);
    state.currentUser.id = 'another-cashier'; const another = makeView(); open.call(another, 'bill'); assert.notEqual(another.settleRequestId, original);
  } finally {
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous); else delete globalThis.localStorage;
  }
});

test('cached Orders render and the live subscription starts without waiting for cloud history', async (t) => {
  let release;
  const server = new Promise(resolve => { release = resolve; });
  const calls = [];
  const status = {};
  const view = {
    container: { querySelector: () => status },
    render: () => calls.push('shell'),
    loadProductImages: async () => {},
    loadPosOrders: async options => {
      if (options?.refresh === false) { calls.push('cache'); view.syncWarning = 'cached'; return; }
      calls.push('refresh-start');
      await server;
      view.syncWarning = '';
      calls.push('refresh-finish');
    },
    bindEvents: () => calls.push('events'),
    renderCustomerBoard: () => calls.push('board'),
    openLinkedReconciliation: () => {},
    renderStkRecovery: () => {},
    runStkRecovery: async () => {},
  };
  t.after(() => clearInterval(view.refreshTimer));
  await makeLoad(async () => { calls.push('subscribe'); return () => {}; }).call(view);
  assert.deepEqual(calls, ['shell', 'cache', 'events', 'board', 'refresh-start', 'subscribe']);
  assert.equal(status.textContent, 'cached');
  release();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls.slice(-2), ['refresh-finish', 'board']);
  assert.equal(status.textContent, '');
});

test('an Orders refresh finishing after navigation does not redraw the old screen', async (t) => {
  let release;
  const server = new Promise(resolve => { release = resolve; });
  let draws = 0;
  const view = {
    container: { querySelector: () => ({}) }, render() {}, loadProductImages: async () => {},
    loadPosOrders: options => options?.refresh === false ? Promise.resolve() : server,
    bindEvents() {}, renderCustomerBoard() { draws++; }, openLinkedReconciliation() {},
    renderStkRecovery() {}, runStkRecovery: async () => {},
  };
  t.after(() => clearInterval(view.refreshTimer));
  await makeLoad(async () => () => {}).call(view);
  view.disposed = true;
  release();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(draws, 1);
});

test('leaving Orders during cached setup cannot bind or mount a detached register', async () => {
  let release;
  const cached = new Promise(resolve => { release = resolve; });
  let bound = false;
  const view = { render() {}, loadProductImages: async () => {}, loadPosOrders: () => cached,
    bindEvents: () => { bound = true; } };
  const loading = makeLoad(async () => () => {}).call(view);
  view.disposed = true;
  release();
  await loading;
  assert.equal(bound, false);
  assert.equal(view.proformaRegister, undefined);
});
