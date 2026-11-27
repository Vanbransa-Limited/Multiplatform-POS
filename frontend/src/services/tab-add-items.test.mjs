import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { canAddToTab, mergeTabLines, tabCustomerId, tabKey } from './tabs.js';
import { renderOrderCard } from './customer-orders.js';
import { escapeHtml } from './print-receipt.js';

const read = async file => (await readFile(new URL(file, import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
const till = await read('../ui/till.js');
const tabs = await read('../ui/tab-management.js');
const WALK_IN = 'walk-in';
const nicole = { id: 'nicole', name: 'Nicole', kra_pin: 'P051234567X', price_tier: 'RETAIL' };
const brian = { id: 'brian', name: 'Brian' };

test('a tab belongs to the customer it was opened for, or to the one customer every round was billed to', () => {
  assert.equal(tabCustomerId({ customer_id: 'nicole', rounds: [{ customerId: 'brian' }] }, WALK_IN), 'nicole');
  // A header repaired from another till's upload has no customer; its rounds still say whose it is.
  assert.equal(tabCustomerId({ rounds: [{ customerId: 'nicole' }, { customerId: 'nicole' }] }, WALK_IN), 'nicole');
  // No owner, so nothing is guessed: empty, walk-in, a walk-in tab with one customer's round, or mixed customers.
  for (const tab of [{}, { rounds: [] }, { rounds: [{ customerId: WALK_IN }] }, { customer_id: WALK_IN, rounds: [{ customerId: null }] },
    { rounds: [{ customerId: WALK_IN }, { customerId: 'nicole' }] }, { rounds: [{ customerId: 'nicole' }, { customerId: 'brian' }] }]) {
    assert.equal(tabCustomerId(tab, WALK_IN), null, JSON.stringify(tab));
  }
});

function tillTabMethods() {
  const body = till.slice(till.indexOf('  addToTab(table) {'), till.indexOf('\n  clearActiveTab() {'));
  const notices = [];
  const nodes = new Map();
  const select = { value: WALK_IN, options: [{ value: WALK_IN }, { value: 'nicole' }, { value: 'brian' }] };
  const document = { getElementById: id => (id === 'cart-customer-select' ? select : (nodes.get(id) || nodes.set(id, {}).get(id))) };
  const customers = new Map([['nicole', nicole], ['brian', brian], [WALK_IN, { id: WALK_IN, name: 'Walk-in' }]]);
  const db = { customers: { get: async id => customers.get(id) } };
  const methods = new Function('db', 'document', 'showNotification', 'tabKey', 'tabCustomerId', 'WALK_IN_CUSTOMER_ID',
    `return class { ${body} };`)(db, document, (text) => notices.push(text), tabKey, tabCustomerId, WALK_IN);
  const view = Object.assign(Object.create(methods.prototype), {
    selectedCustomer: customers.get(WALK_IN), invalidated: 0,
    persistDraft() {}, renderOpenTabs() {}, invalidateMpesaAttempt() { this.invalidated++; }, recomputeTotals() {},
  });
  return { view, select, nodes, notices };
}
const settle = () => new Promise(resolve => setImmediate(resolve));

test('entering a customer’s tab selects that customer for the round', async () => {
  const { view, select, nodes, notices } = tillTabMethods();
  view.selectedCustomer = brian; // left over from the previous sale
  view.openTabs = [{ id: 'tab-1', table: '4', customer_id: 'nicole', dueMinor: 50000, rounds: [] }];
  view.addToTab('4');
  await settle();
  assert.equal(view.activeTabId, 'tab-1');
  assert.equal(view.selectedCustomer.id, 'nicole');
  assert.equal(select.value, 'nicole');
  assert.equal(nodes.get('cart-buyer-pin').value, nicole.kra_pin);
  assert.equal(view.invalidated, 1, 'a changed customer invalidates any half-taken M-Pesa attempt');
  assert.match(notices[0], /Adding a round to Table 4\. KES 500\.00 already open/);
  assert.match(notices[1], /billed to Nicole/);
});

test('an automatically selected tab customer does not carry to another table', async () => {
  const { view, select } = tillTabMethods();
  view.openTabs = [{ id: 'tab-1', table: '4', customer_id: 'nicole', dueMinor: 50000, rounds: [] }];
  view.addToTab('4');
  await settle();
  assert.equal(view.selectedCustomer.id, 'nicole');
  view.addToTab('12');
  assert.equal(view.selectedCustomer.id, WALK_IN);
  assert.equal(select.value, WALK_IN);
  assert.equal(view.activeTable, '12');
  assert.equal(view.activeTabId, null);
});

test('walk-in, mixed and unknown owners, a new table, and a table changed mid-read leave the cart as it was', async () => {
  for (const tab of [
    { id: 't', table: '9', rounds: [{ customerId: WALK_IN }] },
    { id: 't', table: '9', rounds: [{ customerId: 'nicole' }, { customerId: 'brian' }] },
    { id: 't', table: '9', customer_id: 'not-on-this-device', rounds: [] },
    null,
  ]) {
    const { view, select } = tillTabMethods();
    view.openTabs = tab ? [tab] : [];
    view.addToTab('9');
    await settle();
    assert.equal(view.selectedCustomer.id, WALK_IN, JSON.stringify(tab));
    assert.equal(select.value, WALK_IN);
    assert.equal(view.activeTabId, tab ? 't' : null);
  }
  const { view } = tillTabMethods();
  view.openTabs = [{ id: 't', table: '9', customer_id: 'nicole', rounds: [] }];
  view.addToTab('9');
  view.activeTable = '10';
  await settle();
  assert.equal(view.selectedCustomer.id, WALK_IN, 'a late read never changes the customer for another table');
});

function addRound({ openTabs, selectedCustomer, activeTable = '4' }) {
  const body = till.slice(till.indexOf('  async addRoundToTab() {'), till.indexOf('\n  /**', till.indexOf('  async addRoundToTab() {')))
    .replace('async addRoundToTab() {', 'async function addRoundToTab() {');
  const registered = [], updates = [], notices = [];
  const customers = new Map([['nicole', nicole], ['brian', brian]]);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const add = new Function('db', 'state', 'showNotification', 'tabKey', 'tabCustomerId', 'WALK_IN_CUSTOMER_ID', `return ${body}`)(
    { sales: { update: async (id, changes) => updates.push([id, changes]) }, customers: { get: async id => customers.get(id) } },
    { syncManager: { syncOutbox: async () => {} } }, (text, level) => notices.push([level, text]), tabKey, tabCustomerId, WALK_IN);
  const view = { activeTable, openTabs, cart: [{ product_id: 'meal', qty: 2 }], selectedCustomer, redeemedPoints: 0,
    buildPendingPaymentRecords() { return [{ method: 'CREDIT', amount: 520 }]; },
    async registerOrder(payments, options) { registered.push({ table: this.activeTable, customer: this.selectedCustomer.id, payments, options }); await gate; return { saleId: 'round-2' }; },
    updateCartUI() {}, async loadOpenTabs() {} };
  return { run: () => add.call(view), release, registered, updates, notices, view };
}

test('a round on a customer’s tab is saved once, unpaid, for that customer and table', async () => {
  const h = addRound({ openTabs: [{ table: '4', customer_id: 'nicole', dueMinor: 50000, rounds: [] }], selectedCustomer: nicole });
  const first = h.run(), second = h.run();
  h.release();
  await Promise.all([first, second]);
  assert.equal(h.registered.length, 1, 'a second press while saving adds nothing');
  assert.deepEqual(h.registered[0], { table: '4', customer: 'nicole', payments: [{ method: 'CREDIT', amount: 520 }], options: { pending: true } });
  assert.deepEqual(h.updates, [['round-2', { held_until: null }]], 'the round stays unpaid; no payment is recorded');
  assert.deepEqual(h.view.cart, []);
});

test('the till’s current customer cannot be put on another customer’s tab, and an unloaded owner is refused', async () => {
  const other = addRound({ openTabs: [{ table: '4', customer_id: 'nicole', rounds: [] }], selectedCustomer: brian });
  await other.run();
  assert.equal(other.registered.length, 0);
  assert.deepEqual(other.notices, [['error', "Table 4 is Nicole's tab. Select Nicole as the customer to add this round, or use a different table."]]);
  assert.equal(other.view.cart.length, 1, 'the cart is kept for the cashier to fix');

  const unknown = addRound({ openTabs: [{ table: '4', customer_id: 'not-on-this-device', rounds: [] }], selectedCustomer: brian });
  await unknown.run();
  assert.equal(unknown.registered.length, 0);
  assert.match(unknown.notices[0][1], /has not loaded\. Refresh customers/);

  // The owner is read for the table being added to now, not a tab chosen earlier.
  const stale = addRound({ activeTable: '5', selectedCustomer: brian,
    openTabs: [{ table: '4', customer_id: 'brian', rounds: [] }, { table: '5', customer_id: 'nicole', rounds: [] }] });
  await stale.run();
  assert.equal(stale.registered.length, 0);
});

test('walk-in and mixed tabs, and a new table, keep the existing behaviour', async () => {
  for (const openTabs of [
    [{ table: '4', rounds: [{ customerId: WALK_IN }] }],
    [{ table: '4', rounds: [{ customerId: 'nicole' }, { customerId: 'brian' }] }],
    [],
  ]) {
    const h = addRound({ openTabs, selectedCustomer: brian });
    h.release();
    await h.run();
    assert.equal(h.registered.length, 1, JSON.stringify(openTabs));
    assert.equal(h.registered[0].customer, 'brian');
  }
});

test('Orders offers Add items on an unpaid tab, and only there', () => {
  const tab = { id: 'tab-1', source: 'pos', ref: 'ORD-9', customerName: 'Nicole', branchId: 'b', tableNumber: '9 & 10',
    tabId: 'tab-1', roundIds: ['r1', 'r2'], status: 'awaiting_payment', paymentStatus: 'unpaid', lines: [] };
  assert.match(renderOrderCard(tab, new Map()), /<a class="sec-btn" href="\/till\?table=9%20%26%2010"[^>]*>Add items<\/a>/);
  for (const order of [{ ...tab, paymentStatus: 'paid', status: 'completed' }, { ...tab, paymentStatus: 'void', status: 'cancelled' },
    { ...tab, tableNumber: '' }, { ...tab, roundIds: undefined }]) {
    assert.doesNotMatch(renderOrderCard(order, new Map()), />Add items</, JSON.stringify(order));
  }
});

test('Tab Management keeps its table-first cards and its table, order number and opener search', () => {
  const pick = (start, end) => tabs.slice(tabs.indexOf(start), tabs.indexOf(end, tabs.indexOf(start)));
  const body = [pick('  refFor(tab) {', '\n  renderList()'), pick('  renderList() {', '\n  card(tab) {'), pick('  card(tab) {', '\n}\n')].join('\n');
  const View = new Function('escapeHtml', 'mergeTabLines', 'canAddToTab', `return class { ${body} };`)(escapeHtml, mergeTabLines, canAddToTab);
  const list = {}, summary = {};
  const view = Object.assign(new View(), {
    container: { querySelector: selector => (selector === '#tabs-list' ? list : summary) },
    names: new Map([['s1', 'Akashi']]),
    tabs: [
      { id: 'a', table: '4', order_no: 'ORD-4', opened_by: 's1', opened_at: '2026-11-25T18:00:00Z', dueMinor: 50000, items: 2, customer_id: 'nicole',
        rounds: [{ customerId: 'nicole', paymentStatus: 'unpaid', lines: [{ name: 'Tea', qty: 2, line_total: 520 }] }] },
      { id: 'b', table: '7', order_no: 'ORD-7', dueMinor: 30000, items: 1, rounds: [{ paymentStatus: 'unpaid', lines: [{ name: 'Chips', qty: 1 }] }] },
    ],
  });
  const shows = search => { view.search = search; view.renderList(); return [...list.innerHTML.matchAll(/Table (\d+)</g)].map(match => match[1]); };
  assert.deepEqual(shows(''), ['4', '7']);
  assert.deepEqual(shows('7'), ['7'], 'table');
  assert.deepEqual(shows('ord-4'), ['4'], 'order number');
  assert.deepEqual(shows('akashi'), ['4'], 'who opened it');
  assert.deepEqual(shows('nicole'), [], 'customer names are not a search field');
  shows('');
  assert.match(list.innerHTML, /<span class="co-ref">Table 4<\/span>\s*<span class="co-unpaid">KES 500\.00 due<\/span>/);
  assert.match(list.innerHTML, /ORD-4 · 2 items · 1 round<br>\s*Opened [^<]* by <b>Akashi<\/b>/);
  assert.match(list.innerHTML, /<div>Tea &times; 2<\/div>/);
  assert.match(list.innerHTML, /href="\/till\?table=4">Add items<\/a>/);
  assert.doesNotMatch(list.innerHTML, /Customer|Nicole/);
  assert.match(tabs, /placeholder="Search table, order number or who opened it…"/);
});

test('a tablet can add to a tab another till opened, but not to one still uploading', () => {
  assert.equal(canAddToTab({ id: 'tab-1', status: 'OPEN' }), true);
  // Server copy of another till's tab: the till re-creates its header on Add round.
  assert.equal(canAddToTab({ id: 'tab-2', readOnly: true, recoveryRequired: true }), true);
  // Still uploading from another till, or no tab identity: the till would refuse.
  assert.equal(canAddToTab({ id: 'open-order-x', readOnly: true }), false);
  assert.equal(canAddToTab({ id: 'recovered-sale-1', readOnly: true, recoveryRequired: true }), false);
  assert.equal(canAddToTab(null), false);
});

test('an unpaid bill with no table offers Add items that joins it, so one payment settles both', () => {
  const bill = { id: 's1', source: 'pos', ref: 'INV-BH001-003457', saleUuid: 'uuid-1', customerName: 'Guest', branchId: 'b',
    tableNumber: '', status: 'awaiting_payment', paymentStatus: 'unpaid', lines: [] };
  assert.match(renderOrderCard(bill, new Map()), /href="\/till\?join=uuid-1&amp;ref=INV-BH001-003457"[^>]*>Add items<\/a>/);
  for (const order of [{ ...bill, paymentStatus: 'paid', status: 'completed' }, { ...bill, paymentStatus: 'void', status: 'cancelled' }]) {
    assert.doesNotMatch(renderOrderCard(order, new Map()), />Add items</, JSON.stringify(order));
  }
  assert.match(till, /join_sale_uuid: tableNo \? null : \(this\.joinBill\?\.saleUuid \|\| null\)/);
});

test('Void bill is offered on one unpaid bill, never on paid, voided or a whole merged table', () => {
  const bill = { id: 's1', source: 'pos', ref: 'INV-1', saleUuid: 'u1', customerName: 'Guest', branchId: 'b', tableNumber: '',
    status: 'awaiting_payment', paymentStatus: 'unpaid', lines: [] };
  assert.match(renderOrderCard(bill, new Map()), /class="sec-btn co-void" data-void-sale="s1"/);
  for (const order of [{ ...bill, paymentStatus: 'paid', status: 'completed' }, { ...bill, paymentStatus: 'void', status: 'cancelled' },
    { ...bill, tabId: 't', roundIds: ['a', 'b'], tableNumber: '6' }]) {
    assert.doesNotMatch(renderOrderCard(order, new Map()), /data-void-sale/, JSON.stringify(order));
  }
});

test('choosing a round\'s tab reads nothing outside the sale transaction (26 Nov 2026: no table sale could save)', () => {
  const body = till.slice(till.indexOf('  async resolveTabForRound('), till.indexOf('\n  }\n', till.indexOf('  async resolveTabForRound(')));
  assert.doesNotMatch(body, /readOpenTabs|pullSales|pullOpenOrders|callFunction|db\.products/);
  // The transaction it runs in, for reference: these are the only tables it may touch.
  assert.match(till, /db\.transaction\('rw', \[db\.tabs, db\.sales, db\.sale_lines, db\.payments, db\.stock_movements, db\.audit_log, db\.customers\]/);
});
