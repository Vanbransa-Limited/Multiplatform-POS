import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// A tab paid on another device must leave this till's table list without a
// reload: the background sync closes it locally and tells the till to re-read.
const read = async (file) => (await readFile(new URL(file, import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
const sync = await read('./sync.js');
const till = await read('../ui/till.js');

const refreshBody = sync.slice(sync.indexOf('  async refreshSharedOrders('), sync.indexOf('\n  /** Returns true when the sale reached the backend'))
  .replace('async refreshSharedOrders(', 'async function refreshSharedOrders(')
  .replace("const { pullSales } = await import('./catalogue');", '')
  .replace("const { freeSettledTab } = await import('./tab-edit');", '');

function syncWith({ tabs, rounds, freedIds = [] }) {
  const events = [], pulled = [], freedCalls = [];
  const db = {
    tabs: { where: () => ({ equals: () => ({ toArray: async () => tabs }) }) },
    sales: { where: () => ({ anyOf: () => ({ toArray: async () => rounds }) }) },
  };
  const pullSales = async (_since, uuids) => { pulled.push(...uuids); return uuids.length; };
  const freeSettledTab = async (id) => { freedCalls.push(id); return freedIds.includes(id) ? `T-${id}` : null; };
  const window = { dispatchEvent: (event) => events.push(event.type) };
  const run = new Function('db', 'pullSales', 'freeSettledTab', 'globalThis', `${refreshBody}; return refreshSharedOrders;`)(db, pullSales, freeSettledTab, { window });
  return { run: () => run(), events, pulled, freedCalls };
}

test('a tab paid elsewhere closes here and the till is told to re-read its tables', async () => {
  const s = syncWith({ tabs: [{ id: 'a' }, { id: 'b' }], rounds: [{ synced_at: 'x', sale_uuid: 'u1', tab_id: 'a' }], freedIds: ['a'] });
  await s.run();
  assert.deepEqual(s.pulled, ['u1']);
  assert.deepEqual(s.freedCalls, ['a', 'b']);
  assert.deepEqual(s.events, ['pos:tabs-updated']);
});

test('nothing closed, nothing announced: an unpaid tab stays and the till is not redrawn every tick', async () => {
  const s = syncWith({ tabs: [{ id: 'a' }], rounds: [{ synced_at: 'x', sale_uuid: 'u1', tab_id: 'a' }] });
  await s.run();
  assert.deepEqual(s.freedCalls, ['a']);
  assert.deepEqual(s.events, []);
});

test('no open tabs or no uploaded rounds: no pull and no announcement, as before', async () => {
  const none = syncWith({ tabs: [], rounds: [] });
  await none.run();
  assert.deepEqual([none.pulled, none.events], [[], []]);
  const local = syncWith({ tabs: [{ id: 'a' }], rounds: [{ synced_at: null, sale_uuid: 'u1' }] });
  await local.run();
  assert.deepEqual([local.pulled, local.freedCalls, local.events], [[], [], []]);
});

// The till's listener, rebuilt from its source with a stand-in view.
const handlerSource = till.slice(till.indexOf('this.onTabsUpdated = () => {'), till.indexOf("window.addEventListener('pos:tabs-updated'"));
function tillWith(state, modalOpen = false) {
  const view = { disposed: false, container: { isConnected: true }, finalizingInvoice: false, preparingPrintedCheckout: false, loads: 0,
    loadOpenTabs() { this.loads++; return Promise.resolve(); }, ...state };
  const document = { getElementById: (id) => (id === 'payment-modal' ? { classList: { contains: (c) => c === 'active' && modalOpen } } : null) };
  new Function('document', `${handlerSource}`).call(view, document);
  view.onTabsUpdated();
  return view.loads;
}

test('the till re-reads its open tabs when told, unless a payment is in progress on it', () => {
  assert.equal(tillWith({}), 1);
  assert.equal(tillWith({ finalizingInvoice: true }), 0, 'mid-settlement the active tab must not change underneath it');
  assert.equal(tillWith({ preparingPrintedCheckout: true }), 0);
  assert.equal(tillWith({}, true), 0, 'payment window open');
  assert.equal(tillWith({ disposed: true }), 0);
  assert.equal(tillWith({ container: { isConnected: false } }), 0);
});

// Leave pending, run from the till's own handler with a stand-in view.
const cancelStart = till.indexOf("document.getElementById('pay-cancel-btn').addEventListener('click', ");
const cancelHandler = till.slice(cancelStart, till.indexOf("\n    document.getElementById('pay-confirm-btn')", cancelStart))
  .replace("document.getElementById('pay-cancel-btn').addEventListener('click', ", '').replace(/\);\s*$/, '');
async function leavePending(state) {
  const calls = [];
  const view = { pendingRegistration: null, mpesaAttempt: null, mpesaVerified: false, activeTabId: null, activeTable: null, pendingSale: null,
    confirmDiscardingPaidMpesa: () => true, invalidateMpesaAttempt() {}, releaseHeldLease() {}, updateCartUI() {},
    clearCart() { calls.push('clearCart'); }, loadOpenTabs() { calls.push('loadOpenTabs'); return Promise.resolve(); }, ...state };
  const document = { getElementById: () => ({ classList: { remove() {} } }) };
  const handler = new Function('document', 'showNotification', `return (${cancelHandler});`).call(view, document, (text) => calls.push(`notify:${text}`));
  await handler();
  return calls;
}

test('Leave pending on a takeaway re-reads the open tabs, so a table settled elsewhere meanwhile leaves the list', async () => {
  const takeaway = await leavePending({ pendingSale: { saleId: 's1' } });
  assert.deepEqual(takeaway, ['clearCart', 'notify:Order left unpaid in Pending. Use Pay now in Orders to clear it.', 'loadOpenTabs']);
  // On a tab it already re-read them, once, as before.
  const onTab = await leavePending({ activeTabId: 'tab1', activeTable: '7', pendingSale: { saleId: 's1' } });
  assert.deepEqual(onTab.filter(c => c === 'loadOpenTabs'), ['loadOpenTabs']);
  assert.equal(onTab.includes('clearCart'), false);
  // An unresolved M-Pesa attempt still keeps the window and changes nothing.
  assert.deepEqual(await leavePending({ mpesaAttempt: {}, mpesaVerified: false }), ['notify:Wait for the M-Pesa attempt to resolve before leaving this payment.']);
});

test('the till listens while mounted and stops when disposed', () => {
  assert.match(till, /window\.addEventListener\('pos:tabs-updated', this\.onTabsUpdated\)/);
  assert.match(till.slice(till.indexOf('  dispose() {')), /window\.removeEventListener\('pos:tabs-updated', this\.onTabsUpdated\)/);
});
