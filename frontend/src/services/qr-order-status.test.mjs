import test from 'node:test';
import assert from 'node:assert/strict';
import { isRunningOrder, paymentStateLabel, renderOrderCard, statusTab, updateCustomerOrder } from './customer-orders.js';

const menuOrder = (extra = {}) => ({ id: 'web-1', source: 'menu', ref: 'WEB-1', customerName: 'Nicole', branchId: 'b',
  orderType: 'dine_in', tableNumber: '4', status: 'received', paymentStatus: 'unpaid', totalMinor: 26000, lines: [], ...extra });
const statusOptions = html => [...html.matchAll(/<option value="([a-z]*)">/g)].map(match => match[1]);

function withLocalOrders(t, orders) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const values = new Map([['pos_local_customer_orders', JSON.stringify(orders)]]);
  Object.defineProperty(globalThis, 'localStorage', { configurable: true,
    value: { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) } });
  t.after(() => { if (previous) Object.defineProperty(globalThis, 'localStorage', previous); else delete globalThis.localStorage; });
  return () => JSON.parse(values.get('pos_local_customer_orders'));
}

test('an unpaid menu order is not offered Completed; cancelling and kitchen steps remain', () => {
  assert.deepEqual(statusOptions(renderOrderCard(menuOrder(), new Map())), ['', 'preparing', 'ready', 'cancelled']);
  assert.deepEqual(statusOptions(renderOrderCard(menuOrder({ status: 'preparing' }), new Map())), ['', 'preparing', 'ready', 'cancelled']);
});

test('a paid menu order can still be completed', () => {
  assert.deepEqual(statusOptions(renderOrderCard(menuOrder({ paymentStatus: 'paid', status: 'awaiting_print' }), new Map())),
    ['', 'preparing', 'ready', 'completed', 'cancelled']);
});

test('the device-only fallback refuses to complete an unpaid order and changes nothing', async t => {
  const stored = withLocalOrders(t, [menuOrder(), menuOrder({ id: 'web-2', paymentStatus: 'paid', status: 'awaiting_print' })]);
  await assert.rejects(updateCustomerOrder('web-1', 'completed'), /Take payment before completing/);
  assert.equal(stored()[0].status, 'received');
  assert.equal(stored()[0].paymentStatus, 'unpaid');
  await updateCustomerOrder('web-1', 'cancelled');
  assert.equal(stored()[0].status, 'cancelled');
  await updateCustomerOrder('web-2', 'completed');
  assert.equal(stored()[1].status, 'completed');
  assert.equal(stored()[1].paymentStatus, 'paid');
});

test('labels separate payment from progress for every status, print count and source', () => {
  const cases = [
    [{ status: 'received', paymentStatus: 'unpaid' }, 'Pending payment'],
    [{ status: 'awaiting_payment', paymentStatus: 'unpaid' }, 'Pending payment'],
    [{ status: 'preparing', paymentStatus: 'unpaid' }, 'Pending payment · preparing'],
    [{ status: 'ready', paymentStatus: 'unpaid' }, 'Pending payment · served'],
    [{ status: 'completed', paymentStatus: 'unpaid' }, 'Pending payment · completed'],
    [{ status: 'received', paymentStatus: 'paid' }, 'Paid · awaiting print'],
    [{ status: 'awaiting_print', paymentStatus: 'paid' }, 'Paid · awaiting print'],
    [{ status: 'preparing', paymentStatus: 'paid', printCount: 1 }, 'Paid · preparing'],
    [{ status: 'ready', paymentStatus: 'paid', printCount: 2 }, 'Paid · served'],
    [{ status: 'completed', paymentStatus: 'paid' }, 'Paid · completed'],
    [{ status: 'cancelled', paymentStatus: 'unpaid' }, 'Cancelled'],
    [{ status: 'cancelled', paymentStatus: 'paid' }, 'Cancelled · was paid'],
    [{ status: 'cancelled', paymentStatus: 'void', source: 'pos' }, 'Cancelled'],
    [{ status: 'completed', paymentStatus: 'paid', source: 'pos' }, 'Paid · completed'],
    [{ status: 'awaiting_payment', paymentStatus: 'unpaid', source: 'pos' }, 'Pending payment'],
  ];
  for (const [fields, label] of cases) {
    const order = Object.freeze(menuOrder(fields));
    assert.equal(paymentStateLabel(order), label, JSON.stringify(fields));
    // The print count never decides payment; only status and payment do.
    assert.equal(paymentStateLabel({ ...order, printCount: 9 }), label);
  }
});

test('the card shows the label without touching the order, and the board filters are unchanged', () => {
  const order = menuOrder({ status: 'awaiting_print', paymentStatus: 'paid' });
  const before = JSON.stringify(order);
  const html = renderOrderCard(order, new Map());
  assert.match(html, /<span class="co-pill pending">Paid · awaiting print<\/span>/);
  assert.equal(JSON.stringify(order), before);
  // Still filed under Pending (kitchen has not got it) and not under Running (nothing owed).
  assert.equal(statusTab(order)?.id, 'pending');
  assert.equal(isRunningOrder(order), false);
  const unpaid = menuOrder();
  assert.equal(statusTab(unpaid)?.id, 'pending');
  assert.equal(isRunningOrder(unpaid), true);
  assert.match(renderOrderCard(unpaid, new Map()), />Pending payment<\/span>/);
});
