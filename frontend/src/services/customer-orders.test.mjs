import assert from 'node:assert/strict';
import test from 'node:test';

import { handledBy, handledLabel, mergeTabRounds, orderStats, saleAsOrder, visibleOrders, sortOrders } from './customer-orders.js';

test('a pending round without payment rows remains running until confirmed settlement', () => {
  const pending = saleAsOrder({ id: 'judy-round', branch_id: 'b1', status: 'PENDING_PAYMENT', grand_total: 520 });
  assert.equal(pending.paymentStatus, 'unpaid');
  assert.equal(pending.dueMinor, 52000);
  assert.equal(visibleOrders([pending], 'b1', { tab: 'running' }).length, 1);
  const paid = saleAsOrder({ id: 'judy-round', branch_id: 'b1', status: 'COMPLETED', grand_total: 520 }, { payments: [{ method: 'CASH', amount: 520 }] });
  assert.equal(visibleOrders([paid], 'b1', { tab: 'running' }).length, 0);
  assert.equal(visibleOrders([paid], 'b1', { tab: 'all' }).length, 1);
});

test('running tables sort numerically and can be grouped by staff or amount due', () => {
  const orders = [
    { id: 'a', tableNumber: '20', cashierName: 'Judy', dueMinor: 100 },
    { id: 'b', tableNumber: '2', cashierName: 'Kester', dueMinor: 500 },
    { id: 'c', tableNumber: '', cashierName: 'Judy', dueMinor: 300 },
  ];
  assert.deepEqual(sortOrders(orders, 'table').map(x => x.id), ['b', 'a', 'c']);
  assert.deepEqual(sortOrders(orders, 'staff').map(x => x.id), ['c', 'a', 'b']);
  assert.deepEqual(sortOrders(orders, 'amount').map(x => x.id), ['b', 'c', 'a']);
  assert.deepEqual(orders.map(x => x.id), ['a', 'b', 'c']);
});

const names = new Map([['staff-1', 'Wanjiku'], ['staff-2', 'Otieno']]);

test('server-booked credit remains on Pending until its receivable is settled', () => {
  const sale = { id: 'table20', status: 'COMPLETED', branch_id: 'b1', table_no: '20', grand_total: 100 };
  const unpaid = saleAsOrder(sale, { payments: [{ method: 'CREDIT', amount: 100 }] });
  assert.equal(unpaid.status, 'awaiting_payment');
  assert.equal(visibleOrders([unpaid], 'b1', { tab: 'pending' }).length, 1);
  const paid = saleAsOrder(sale, { payments: [
    { method: 'CREDIT', amount: 100, settled_at: '2026-11-07' }, { method: 'CASH', amount: 100 },
  ] });
  assert.equal(paid.status, 'completed');
  assert.equal(visibleOrders([paid], 'b1', { tab: 'pending' }).length, 0);
});

test('a table bills as one order, not one per trip to it', () => {
  const round = (id, at, name, total) => ({
    ...saleAsOrder(
      { id, branch_id: 'b1', table_no: '2', tab_id: 'tab-1', status: 'PENDING_PAYMENT', grand_total: total, sold_at: at },
      { payments: [{ method: 'PROFORMA', amount: total }], lines: [{ qty: 1, name }] },
    ),
    tabId: 'tab-1',
  });

  const merged = mergeTabRounds(
    [
      round('s1', '2026-09-11T21:05:49.000Z', 'Drinking Water', 100),
      round('s2', '2026-09-11T21:05:39.000Z', 'Samosa', 100),
    ],
    [{ id: 'tab-1', status: 'OPEN', order_no: 'ORD-2-845282', table_no: '2' }],
  );

  // One card for table 2, under the tab's order number, not two invoices.
  assert.equal(merged.length, 1);
  assert.equal(merged[0].ref, 'ORD-2-845282');
  assert.equal(merged[0].dueMinor, 20000);
  assert.equal(merged[0].totalMinor, 20000);
  assert.deepEqual(merged[0].lines.map((line) => line.name), ['Drinking Water', 'Samosa']);
  // Both rounds are reachable, so paying the card clears the whole table.
  assert.equal(merged[0].roundIds.length, 2);
  assert.equal(merged[0].paymentStatus, 'unpaid');
});

test('another device groups shared receivables without having the original tab header', () => {
  const rounds = ['a', 'b'].map(id => saleAsOrder({
    id, branch_id: 'b1', table_no: '709', tab_id: 'shared-tab', order_reference: 'ORD-709',
    grand_total: 100, status: 'COMPLETED', sale_uuid: id,
  }, { payments: [{ method: 'CREDIT', amount: 100 }] }));
  const grouped = mergeTabRounds(rounds, []);
  assert.equal(grouped.length, 1);
  assert.equal(grouped[0].ref, 'ORD-709');
  assert.equal(grouped[0].dueMinor, 20000);
  assert.deepEqual(grouped[0].roundIds, ['a', 'b']);
});

test('a combined table bill names every seller while each round keeps its author', () => {
  const rounds = ['nicole', 'hadrine'].map((staff, index) => saleAsOrder({
    id: `round-${index}`, branch_id: 'b1', table_no: '5', tab_id: 'shared', order_reference: 'ORD-5',
    staff_id: staff, customer_id: 'guest', grand_total: 100, status: 'PENDING_PAYMENT',
  }, { payments: [{ method: 'CREDIT', amount: 100 }] }));
  const [bill] = mergeTabRounds(rounds, []);
  const names = new Map([['nicole', 'Nicole'], ['hadrine', 'Hadrine']]);
  assert.deepEqual(bill.staffIds, ['nicole', 'hadrine']);
  assert.equal(handledBy(bill, names), 'Nicole, Hadrine');
  assert.deepEqual(rounds.map(round => round.staffId), ['nicole', 'hadrine']);
  assert.equal(visibleOrders([bill], 'b1', { search: 'hadrine' }).length, 1);
});

test('rounds on a closed tab stay separate history', () => {
  const round = (id) => ({
    ...saleAsOrder(
      { id, branch_id: 'b1', table_no: '2', tab_id: 'tab-1', grand_total: 100, sold_at: '2026-09-11T21:00:00.000Z' },
      { payments: [{ method: 'CASH', amount: 100 }] },
    ),
    tabId: 'tab-1',
  });

  // A settled tab is done; its rounds keep their own fiscal invoice numbers.
  const merged = mergeTabRounds([round('s1'), round('s2')], [{ id: 'tab-1', status: 'SETTLED' }]);
  assert.equal(merged.length, 2);
  // A sale on no tab at all is untouched.
  assert.equal(mergeTabRounds([saleAsOrder({ id: 's3', grand_total: 50 }, {})], []).length, 1);
});

test('a till sale is traced to whoever rang it up, wherever it was rung up', () => {
  const order = saleAsOrder(
    { id: 's1', branch_id: 'b1', staff_id: 'staff-1', grand_total: 700, sold_at: '2026-09-08T10:00:00.000Z' },
    { customerName: 'Guest' },
  );
  assert.equal(order.staffId, 'staff-1');
  assert.equal(handledBy(order, names), 'Wanjiku');
  assert.equal(handledLabel(order), 'Billed by');

  // Rows written before sales carried a staff id fall back to created_by.
  assert.equal(saleAsOrder({ id: 's2', created_by: 'staff-2' }, {}).staffId, 'staff-2');
});

test('an order registered at Pay Now is on the board before any money moves', () => {
  const sale = {
    id: 's1', branch_id: 'b1', status: 'PENDING_PAYMENT',
    grand_total: 1200, sold_at: '2026-09-08T10:00:00.000Z',
  };
  const order = saleAsOrder(sale, { payments: [{ method: 'PROFORMA', amount: 1200 }] });

  assert.equal(order.status, 'awaiting_payment');
  assert.equal(order.paymentStatus, 'unpaid');
  assert.equal(order.dueMinor, 120000);
  // It sits under Pending, where the counter looks for what is still open.
  assert.equal(visibleOrders([order], 'b1', { tab: 'pending' }).length, 1);

  // Settling it stamps the receivable and adds the tender that paid.
  const settled = saleAsOrder({ ...sale, status: 'COMPLETED' }, {
    payments: [
      { method: 'PROFORMA', amount: 1200, settled_at: '2026-09-08T10:05:00.000Z' },
      { method: 'CASH', amount: 1200, reference: '' },
    ],
  });
  assert.equal(settled.status, 'completed');
  assert.equal(settled.paymentStatus, 'paid');
  assert.equal(settled.dueMinor, 0);
  assert.equal(settled.paymentMethod, 'CASH');
});

test('a voided order stays visible and owes nothing', () => {
  const order = saleAsOrder(
    { id: 's1', branch_id: 'b1', status: 'VOIDED', grand_total: 1200, sold_at: '2026-09-08T10:00:00.000Z' },
    { payments: [] },
  );
  assert.equal(order.status, 'cancelled');
  // Not 'paid': that put "PAID · Settled at the till" on a cancelled order.
  assert.equal(order.paymentStatus, 'void');
  assert.equal(visibleOrders([order], 'b1', { tab: 'cancelled' }).length, 1);
});

test('a proforma reaches the board unpaid, with what is owed on it', () => {
  const sale = { id: 's1', branch_id: 'b1', customer_id: 'cust-9', grand_total: 1200, sold_at: '2026-09-08T10:00:00.000Z' };
  const order = saleAsOrder(sale, { payments: [{ method: 'PROFORMA', amount: 1200 }] });

  assert.equal(order.paymentStatus, 'unpaid');
  assert.equal(order.dueMinor, 120000);
  assert.equal(order.customerId, 'cust-9');
  // Booked work remains on the floor's Pending board until it is paid.
  assert.equal(order.status, 'awaiting_payment');
});

test('once settled it reads paid, under the tender that actually arrived', () => {
  const sale = { id: 's1', branch_id: 'b1', grand_total: 1200, sold_at: '2026-09-08T10:00:00.000Z' };
  const order = saleAsOrder(sale, {
    payment: { method: 'PROFORMA', amount: 1200, settled_at: 'then' },
    payments: [
      { method: 'PROFORMA', amount: 1200, settled_at: 'then' },
      { method: 'MPESA', amount: 1200, reference: 'QGH4T21XZ9' },
    ],
  });

  assert.equal(order.paymentStatus, 'paid');
  assert.equal(order.dueMinor, 0);
  // The code to reconcile against the money screens, not the word "proforma".
  assert.equal(order.paymentMethod, 'MPESA');
  assert.equal(order.paymentReference, 'QGH4T21XZ9');
});

test('an ordinary cash sale is paid, as it always was', () => {
  const order = saleAsOrder(
    { id: 's2', branch_id: 'b1', grand_total: 300, sold_at: '2026-09-08T10:00:00.000Z' },
    { payment: { method: 'CASH', amount: 300 } },
  );
  assert.equal(order.paymentStatus, 'paid');
  assert.equal(order.dueMinor, 0);
});

test('a menu order names the last person who acted on it', () => {
  const base = { source: 'menu', status: 'received' };
  assert.equal(handledBy({ ...base, updatedByStaffId: 'staff-2' }, names), 'Otieno');
  // Settling outranks printing, which outranks a status nudge.
  assert.equal(handledBy({
    ...base, settledByStaffId: 'staff-1', lastPrintedByStaffId: 'staff-2', updatedByStaffId: 'staff-2',
  }, names), 'Wanjiku');
  assert.equal(handledLabel(base), 'Handled by');
  // Nobody has touched it yet, so nobody is named.
  assert.equal(handledBy(base, names), '');
  assert.equal(handledBy(null, names), '');
});

test('a staff id nobody can name is shown as the id, never dropped', () => {
  assert.equal(handledBy({ source: 'pos', staffId: 'staff-9' }, names), 'staff-9');
  assert.equal(handledBy({ source: 'pos', staffId: 'staff-9' }, undefined), 'staff-9');
});

test('search finds an order by who handled it, by state, and by staff id', () => {
  const orders = [
    { id: 'a', branchId: 'b1', status: 'completed', ref: 'INV-1', customerName: 'Guest', cashierName: 'Wanjiku', staffId: 'staff-1', lines: [] },
    { id: 'b', branchId: 'b1', status: 'preparing', ref: 'INV-2', customerName: 'Guest', cashierName: 'Otieno', staffId: 'staff-2', lines: [] },
    { id: 'c', branchId: 'b2', status: 'completed', ref: 'INV-3', customerName: 'Guest', cashierName: 'Wanjiku', lines: [] },
  ];

  const found = visibleOrders(orders, 'b1', { search: 'wanjiku' });
  assert.deepEqual(found.map((order) => order.id), ['a']);
  assert.deepEqual(visibleOrders(orders, 'b1', { search: 'staff-2' }).map((o) => o.id), ['b']);
  assert.deepEqual(visibleOrders(orders, 'b1', { search: 'preparing' }).map((o) => o.id), ['b']);
  // Another branch's orders stay out of this branch's board.
  assert.equal(visibleOrders(orders, 'b1', {}).length, 2);
});

test('an owner can drop the branch filter and see the whole business', () => {
  const orders = [
    { id: 'a', branchId: 'b1', status: 'completed', ref: 'INV-1', customerName: 'Guest', lines: [] },
    { id: 'c', branchId: 'b2', status: 'completed', ref: 'INV-3', customerName: 'Guest', lines: [] },
  ];

  assert.equal(visibleOrders(orders, 'b1', { allBranches: true }).length, 2);
  assert.equal(visibleOrders(orders, 'b1', {}).length, 1);
  // The tiles have to agree with the board, or the counts accuse it of hiding.
  const all = orderStats(orders, 'b1', true).find((tile) => tile.id === 'all');
  assert.equal(all.count, 2);
  assert.equal(orderStats(orders, 'b1').find((tile) => tile.id === 'all').count, 1);
});

test('a tab round becomes a priceless kitchen ticket without the till pseudo-products', async () => {
  const { roundKitchenTicket } = await import('./customer-orders.js');
  const { renderReceiptHtml } = await import('./print-receipt.js');
  const ticket = roundKitchenTicket({
    ref: 'ORD-12', tableNumber: 7, customerName: 'Walk-in', staffName: 'Kester', onTab: true,
    items: [
      { product: { id: 'p1', name: 'Tusker', sell_price: 350 }, qty: 2 },
      { product: { id: 'prod-staff-discount', name: 'Staff discount' }, qty: 1 },
      { product: { id: 'prod-table-service', name: 'VIP' }, qty: 1 },
    ],
  });
  assert.deepEqual(ticket.lines, [{ name: 'Tusker', qty: 2 }]);
  assert.equal(ticket.kind, 'kitchen');
  assert.equal(ticket.tableNumber, '7');
  const html = renderReceiptHtml(ticket);
  assert.match(html, /KITCHEN ORDER/);
  assert.match(html, /TABLE 7/);
  assert.match(html, /ON TAB/);
  assert.match(html, /Kester/);
  assert.doesNotMatch(html, /350/);
  assert.equal(roundKitchenTicket({ ref: 'x', items: [{ product: { id: 'prod-staff-discount' }, qty: 1 }] }), null);
});

test('a paid counter order prints as takeaway and paid', async () => {
  const { roundKitchenTicket } = await import('./customer-orders.js');
  const { renderReceiptHtml } = await import('./print-receipt.js');
  const html = renderReceiptHtml(roundKitchenTicket({ ref: 'INV-1', paid: true, paymentMethod: 'CASH',
    items: [{ product: { id: 'p1', name: 'Chips' }, qty: 1 }] }));
  assert.match(html, /TAKEAWAY/);
  assert.match(html, /PAID CASH/);
});
