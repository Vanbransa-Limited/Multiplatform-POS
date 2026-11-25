import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { mergeTabLines, tabCustomerId, tabKey } from './tabs.js';
import { renderOrderCard } from './customer-orders.js';
import { escapeHtml } from './print-receipt.js';

const read = async file => (await readFile(new URL(file, import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
const till = await read('../ui/till.js');
const tabs = await read('../ui/tab-management.js');
const WALK_IN = 'walk-in';
const nicole = { id: 'nicole', name: 'Nicole', kra_pin: 'P051234567X', price_tier: 'RETAIL' };

test('a tab belongs to the customer it was opened for, or to the one customer its rounds were billed to', () => {
  assert.equal(tabCustomerId({ customer_id: 'nicole', rounds: [{ customerId: 'brian' }] }, WALK_IN), 'nicole');
  assert.equal(tabCustomerId({ customer_id: WALK_IN, rounds: [{ customerId: WALK_IN }, { customerId: 'nicole' }] }, WALK_IN), 'nicole');
  // A repaired header carries no customer; the uploaded rounds still say whose it is.
  assert.equal(tabCustomerId({ rounds: [{ customerId: 'nicole' }, { customerId: 'nicole' }] }, WALK_IN), 'nicole');
  // Never guessed: nobody, only the walk-in, or two different customers.
  for (const tab of [{}, { rounds: [] }, { rounds: [{ customerId: WALK_IN }] }, { rounds: [{ customerId: 'nicole' }, { customerId: 'brian' }] }]) {
    assert.equal(tabCustomerId(tab, WALK_IN), null, JSON.stringify(tab));
  }
});

function tillTabMethods() {
  const body = till.slice(till.indexOf('  addToTab(table) {'), till.indexOf('\n  clearActiveTab() {'));
  const notices = [];
  const nodes = new Map();
  const select = { value: WALK_IN, options: [{ value: WALK_IN }, { value: 'nicole' }] };
  const document = { getElementById: id => (id === 'cart-customer-select' ? select : (nodes.get(id) || nodes.set(id, {}).get(id))) };
  const customers = new Map([['nicole', nicole], [WALK_IN, { id: WALK_IN, name: 'Walk-in' }]]);
  const db = { customers: { get: async id => customers.get(id) } };
  const methods = new Function('db', 'document', 'showNotification', 'tabKey', 'tabCustomerId', 'WALK_IN_CUSTOMER_ID',
    `return class { ${body} };`)(db, document, (text) => notices.push(text), tabKey, tabCustomerId, WALK_IN);
  const view = Object.assign(Object.create(methods.prototype), {
    selectedCustomer: customers.get(WALK_IN), invalidated: 0, drafts: 0, totals: 0,
    persistDraft() { this.drafts++; }, renderOpenTabs() {}, invalidateMpesaAttempt() { this.invalidated++; }, recomputeTotals() { this.totals++; },
  });
  return { view, select, nodes, notices, customers };
}
const settle = () => new Promise(resolve => setImmediate(resolve));

test('adding to a customer’s tab bills the round to that customer', async () => {
  const { view, select, nodes, notices } = tillTabMethods();
  view.openTabs = [{ id: 'tab-1', table: 'Nicole', customer_id: null, dueMinor: 50000, rounds: [{ customerId: 'nicole' }] }];
  view.addToTab('nicole');
  await settle();
  assert.equal(view.activeTabId, 'tab-1');
  assert.equal(view.selectedCustomer.id, 'nicole');
  assert.equal(select.value, 'nicole');
  assert.equal(nodes.get('cart-buyer-pin').value, nicole.kra_pin);
  assert.equal(view.invalidated, 1, 'a changed customer invalidates any half-taken M-Pesa attempt');
  assert.match(notices[0], /KES 500\.00 already open/);
  assert.match(notices[1], /billed to Nicole/);
});

test('nothing is guessed: walk-in tabs, mixed tabs, unknown customers and a table changed mid-read keep the cart as it is', async () => {
  for (const tab of [
    { id: 't', table: '9', rounds: [{ customerId: WALK_IN }] },
    { id: 't', table: '9', rounds: [{ customerId: 'nicole' }, { customerId: 'brian' }] },
    { id: 't', table: '9', customer_id: 'not-on-this-device', rounds: [] },
  ]) {
    const { view, select } = tillTabMethods();
    view.openTabs = [tab];
    view.addToTab('9');
    await settle();
    assert.equal(view.selectedCustomer.id, WALK_IN, JSON.stringify(tab));
    assert.equal(select.value, WALK_IN);
  }
  const { view } = tillTabMethods();
  view.openTabs = [{ id: 't', table: '9', customer_id: 'nicole', rounds: [] }];
  view.addToTab('9');
  view.activeTable = '10';
  await settle();
  assert.equal(view.selectedCustomer.id, WALK_IN, 'a late read never changes the customer of another table');
});

test('a new table opens no tab and changes nothing', async () => {
  const { view, notices } = tillTabMethods();
  view.openTabs = [];
  view.addToTab('12');
  await settle();
  assert.equal(view.activeTabId, null);
  assert.equal(view.selectedCustomer.id, WALK_IN);
  assert.equal(notices.length, 1);
});

test('adding a round records one unpaid round for the selected customer, even when pressed twice', async () => {
  const body = till.slice(till.indexOf('  async addRoundToTab() {'), till.indexOf('\n  /**', till.indexOf('  async addRoundToTab() {')))
    .replace('async addRoundToTab() {', 'async function addRoundToTab() {');
  const registered = [], updates = [];
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const add = new Function('db', 'state', 'showNotification', 'tabKey', `return ${body}`)(
    { sales: { update: async (id, changes) => updates.push([id, changes]) } },
    { syncManager: { syncOutbox: async () => {} } }, () => {}, tabKey);
  const view = { activeTable: 'Nicole', cart: [{ product_id: 'meal', qty: 2 }], selectedCustomer: nicole, redeemedPoints: 0,
    buildPendingPaymentRecords() { return [{ method: 'CREDIT', amount: 520 }]; },
    async registerOrder(payments, options) { registered.push({ customer: this.selectedCustomer.id, payments, options }); await gate; return { saleId: 'round-2' }; },
    updateCartUI() {}, async loadOpenTabs() { this.openTabs = [{ table: 'Nicole', dueMinor: 102000 }]; } };
  const first = add.call(view), second = add.call(view);
  release();
  await Promise.all([first, second]);
  assert.equal(registered.length, 1, 'a second press while saving adds nothing');
  assert.deepEqual(registered[0], { customer: 'nicole', payments: [{ method: 'CREDIT', amount: 520 }], options: { pending: true } });
  assert.deepEqual(updates, [['round-2', { held_until: null }]], 'the round stays unpaid; no payment is recorded');
  assert.deepEqual(view.cart, []);
});

test('Orders offers Add items on an unpaid tab, and only there', () => {
  const tab = { id: 'tab-1', source: 'pos', ref: 'ORD-9', customerName: 'Nicole', branchId: 'b', tableNumber: 'Nicole & Co',
    tabId: 'tab-1', roundIds: ['r1', 'r2'], status: 'awaiting_payment', paymentStatus: 'unpaid', lines: [] };
  assert.match(renderOrderCard(tab, new Map()), /<a class="sec-btn" href="\/till\?table=Nicole%20%26%20Co"[^>]*>Add items<\/a>/);
  for (const order of [{ ...tab, paymentStatus: 'paid', status: 'completed' }, { ...tab, paymentStatus: 'void', status: 'cancelled' },
    { ...tab, tableNumber: '' }, { ...tab, roundIds: undefined }]) {
    assert.doesNotMatch(renderOrderCard(order, new Map()), />Add items</, JSON.stringify(order));
  }
});

test('Tab Management shows whose tab it is and finds it by customer name', () => {
  const pick = (start, end) => tabs.slice(tabs.indexOf(start), tabs.indexOf(end, tabs.indexOf(start)));
  const body = [pick('  customerFor(tab) {', '\n  /** The Orders Viewer'), pick('  refFor(tab) {', '\n  renderList()'),
    pick('  renderList() {', '\n  card(tab) {'), pick('  card(tab) {', '\n}\n')].join('\n');
  const View = new Function('escapeHtml', 'mergeTabLines', 'tabCustomerId', 'WALK_IN_CUSTOMER_ID', `return class { ${body} };`)(
    escapeHtml, mergeTabLines, tabCustomerId, WALK_IN);
  const list = {}, summary = {};
  const view = Object.assign(new View(), {
    container: { querySelector: selector => (selector === '#tabs-list' ? list : summary) },
    names: new Map([['s1', 'Akashi']]), customers: new Map([['nicole', 'Nicole']]), search: 'nico',
    tabs: [
      { id: 'a', table: '4', order_no: 'ORD-4', dueMinor: 50000, items: 2, rounds: [{ customerId: 'nicole', paymentStatus: 'unpaid', lines: [] }] },
      { id: 'b', table: '7', order_no: 'ORD-7', dueMinor: 30000, items: 1, rounds: [{ customerId: WALK_IN, paymentStatus: 'unpaid', lines: [] }] },
      { id: 'c', table: '8', order_no: 'ORD-8', dueMinor: 10000, items: 1, readOnly: true, customerName: 'Nicolette', rounds: [{}] },
    ],
  });
  view.renderList();
  assert.match(list.innerHTML, /Customer: <b>Nicole<\/b>/);
  assert.match(list.innerHTML, /Customer: <b>Nicolette<\/b>/);
  assert.doesNotMatch(list.innerHTML, /ORD-7/);
  assert.match(list.innerHTML, /href="\/till\?table=4">Add items/);
  assert.match(summary.textContent, /3 open tabs · KES 900\.00 still owed/);
});
