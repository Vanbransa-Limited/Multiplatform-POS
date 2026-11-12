import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const orders = (await readFile(new URL('../ui/orders.js', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
const method = orders.slice(orders.indexOf('  async load()'), orders.indexOf('\n  dispose()')).replace('async load()', 'async function load()');
const makeLoad = new Function('watchCustomerOrders', `return ${method};`);

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
  };
  t.after(() => clearInterval(view.refreshTimer));
  await makeLoad(async () => () => {}).call(view);
  view.disposed = true;
  release();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(draws, 1);
});
