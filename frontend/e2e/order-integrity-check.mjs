// Isolated real IndexedDB check of the actual till registration methods.
import { chromium } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

const read = async path => (await readFile(new URL(path, import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
// Every import goes; the tenant cache name is the only one schema.js uses.
const schema = "const cacheName = () => 'order-integrity-ledger'; const selectedCacheTenant = () => 'tenant';\n"
  + (await read('../src/db/schema.js')).replace(/^import .*;\n/gm, '').replace('export const db', 'const db');
const source = await read('../src/ui/till.js');
const method = (name, end) => source.slice(source.indexOf(`  async ${name}(`), source.indexOf(end, source.indexOf(`  async ${name}(`)))
  .replace(`async ${name}(`, `async function ${name}(`);
const register = method('registerOrder', '\n  /** Closes the checkout');
const resolveTab = method('resolveTabForRound', '\n  /**\n   * The two ways out');
const tabs = (await read('../src/services/tabs.js')).replace(/^export /gm, '');
const charges = (await read('../src/services/service-charges.js')).replace(/^export /gm, '');
const management = (await read('../src/ui/tab-management.js')).replace(/^import .*;\n/gm, '').replace('export class', 'class');
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  await page.route('http://127.0.0.1:38888/**', route => route.fulfill({ contentType: 'text/html', body: '<input id="cart-buyer-pin"><input id="checkout-table-number">' }));
  await page.goto('http://127.0.0.1:38888/');
  await page.addScriptTag({ path: new URL('../node_modules/dexie/dist/dexie.js', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1') });
  const result = await page.evaluate(async ({ schema, register, resolveTab, tabs, charges, management }) => {
    const db = new Function(`${schema};return db;`)();
    await db.open();
    const state = { currentTenant: { id: 'tenant' }, currentBranch: { id: 'branch' }, currentUser: { id: 'staff' } };
    await db.shifts.put({ id: 'shift', branch_id: 'branch', user_id: 'staff', status: 'OPEN' });
    const helpers = new Function(`${tabs};return {newTab,openTabAt,OPEN};`)();
    const prices = new Function(`${charges};return {recordedSaleTotals,saleLineRate};`)();
    const registerOrder = new Function('db', 'state', 'DEVICE_ID', 'firebaseConfigured', 'recordedSaleTotals', 'saleLineRate', 'HELD_ORDER_MS', 'logAuditEvent', 'getHouseStock', 'showNotification', 'WALK_IN_CUSTOMER_ID',
      `return ${register};`)(db, state, 'device', false, prices.recordedSaleTotals, prices.saleLineRate, 180_000,
      async () => {}, async () => 100, () => {}, 'walk-in');
    const resolve = new Function('db', 'state', 'openTabAt', 'newTab', 'OPEN', 'WALK_IN_CUSTOMER_ID', `return ${resolveTab};`)(db, state, helpers.openTabAt, helpers.newTab, helpers.OPEN, 'walk-in');
    const view = {
      activeTable: '20', selectedPaymentMethod: 'CASH',
      selectedCustomer: { id: 'cust-walkin', price_tier: 'RETAIL' },
      cart: [{ product: { id: 'tea', name: 'Tea', sell_price: 100, cost_price: 50, tax_code: 'A' }, qty: 1 }],
      totals: { subtotal: 100, total: 100, tax: 0 }, resolveTabForRound: resolve,
    };
    const add = db.sale_lines.add.bind(db.sale_lines);
    db.sale_lines.add = async () => { throw new Error('simulated disk failure'); };
    let failed = false;
    try { await registerOrder.call(view, [{ id: 'p-failed', method: 'PROFORMA', amount: 100 }], { pending: true }); }
    catch (error) { failed = error.message.includes('simulated disk failure'); }
    const afterFailure = { tabs: await db.tabs.count(), sales: await db.sales.count(), lines: await db.sale_lines.count(), payments: await db.payments.count() };
    db.sale_lines.add = add;
    const saved = await registerOrder.call(view, [{ id: 'p-saved', method: 'PROFORMA', amount: 100 }], { pending: true });
    const sale = await db.sales.get(saved.saleId);
    const tab = await db.tabs.get(sale.tab_id);
    const afterSuccess = { tabs: await db.tabs.count(), sales: await db.sales.count(), lines: await db.sale_lines.count(), payments: await db.payments.count() };
    const panel = document.createElement('div');
    panel.id = 'tabs-saved-results';
    document.body.appendChild(panel);
    const Manager = new Function('db', 'state', 'escapeHtml', `${management};return TabManagementView;`)(db, state,
      value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;'));
    const manager = new Manager(document.body);
    manager.search = '20';
    await manager.checkSavedOrders();
    const diagnostic = panel.textContent;
    const afterDiagnostic = await db.sales.count();
    db.close();
    await Dexie.delete('POS_DB');
    // Pay now on every tab card, including one running on another till.
    manager.names = new Map();
    const localCard = manager.card({ table: '20', order_no: 'ORD-20', rounds: [{}], items: 1, dueMinor: 100, readOnly: false });
    const sharedCard = manager.card({ table: '7', order_no: 'ORD-7', rounds: [{}], items: 2, dueMinor: 500, readOnly: true });
    return { failed, afterFailure, afterSuccess, table: tab.table_no, pending: sale.status, queue: sale.sync_pending, diagnostic, afterDiagnostic, localCard, sharedCard };
  }, { schema, register, resolveTab, tabs, charges, management });
  assert.equal(result.failed, true);
  assert.deepEqual(result.afterFailure, { tabs: 0, sales: 0, lines: 0, payments: 0 });
  assert.deepEqual(result.afterSuccess, { tabs: 1, sales: 1, lines: 1, payments: 1 });
  assert.equal(result.table, '20');
  assert.equal(result.pending, 'PENDING_PAYMENT');
  assert.equal(result.queue, 1);
  assert.match(result.diagnostic, /1 saved order/);
  assert.match(result.diagnostic, /Table 20/);
  assert.match(result.diagnostic, /Still on this till/);
  assert.equal(result.afterDiagnostic, 1);
  assert.ok(result.localCard.includes(`href="/orders?order=ORD-20">Pay now<`), result.localCard);
  assert.match(result.localCard, /Add a round/);
  assert.ok(result.sharedCard.includes(`href="/orders?order=ORD-7">Pay now<`), result.sharedCard);
  assert.doesNotMatch(result.sharedCard, /Add a round|Watching only/);
  console.log('Order integrity browser check passed: failed writes roll back tab and order together; successful Table 20 round retains lines, receivable and outbox membership.');
} finally { await browser.close(); }
