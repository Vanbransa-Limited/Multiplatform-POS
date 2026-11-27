import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CLOSED, OPEN, SETTLED,
  closingUpdate, newTab, openTabAt, shiftCloseBlockers, tabOrderNumber, tabsWithTotals,
} from './tabs.js';

const tab = (id, table, openedAt, status = OPEN) => ({
  id, table_no: table, branch_id: 'b1', status, opened_at: openedAt,
});
const round = (id, tabId, dueMinor, qty, paymentStatus = 'unpaid') => ({
  id, tabId, dueMinor, paymentStatus, lines: [{ qty }],
});

test('a table keeps one open tab, so the whole night is one bill', () => {
  const tabs = [tab('t1', '11', '2026-09-11T21:00:00.000Z')];

  // The eleven o'clock round finds the tab the nine o'clock one opened.
  assert.equal(openTabAt(tabs, 'b1', '11').id, 't1');
  assert.equal(openTabAt(tabs, 'b1', ' 11 ').id, 't1');
  // A table with nothing open starts a new tab instead of joining someone's.
  assert.equal(openTabAt(tabs, 'b1', '12'), null);
  // Another branch's table 11 is not this one.
  assert.equal(openTabAt(tabs, 'b2', '11'), null);
});

test('a closed tab never takes another round', () => {
  // This is the "tomorrow morning" case: last night's table 11 is done, so
  // tonight's customer at the same table opens a tab of their own.
  assert.equal(openTabAt([tab('t1', '11', 'last night', SETTLED)], 'b1', '11'), null);
  assert.equal(openTabAt([tab('t1', '11', 'last night', CLOSED)], 'b1', '11'), null);
});

test('a tab is worth what is still owed on it, oldest tab first', () => {
  const tabs = [
    tab('t1', '11', '2026-09-11T21:00:00.000Z'),
    tab('t2', '4', '2026-09-11T19:00:00.000Z'),
  ];
  const rounds = [
    round('s1', 't1', 60000, 2),
    round('s2', 't1', 40000, 1),
    // Already paid for, so it is history and not part of what is owed.
    round('s3', 't1', 0, 3, 'paid'),
    round('s4', 't2', 25000, 1),
  ];

  const totals = tabsWithTotals(tabs, rounds);
  assert.deepEqual(totals.map((entry) => entry.table), ['4', '11']);

  const eleven = totals.find((entry) => entry.table === '11');
  assert.equal(eleven.dueMinor, 100000);
  assert.equal(eleven.items, 3);
  // Every round stays on the tab; only the unpaid ones count towards the bill.
  assert.equal(eleven.rounds.length, 3);
  assert.equal(eleven.unpaidRounds.length, 2);
});

test('a shift cannot close over an open tab', () => {
  const tabs = [
    tab('t1', '11', 'then'),
    tab('t2', '4', 'then', SETTLED),
    tab('t3', '7', 'then', CLOSED),
    { ...tab('t4', '9', 'then'), branch_id: 'b2' },
  ];

  // Only what is still open, and only in this branch.
  assert.deepEqual(shiftCloseBlockers(tabs, 'b1').map((entry) => entry.id), ['t1']);
  assert.deepEqual(shiftCloseBlockers([], 'b1'), []);
});

test('a tab that owes nothing settles; one that owes needs a reason', () => {
  const settled = closingUpdate({ dueMinor: 0, staffId: 'staff-1', now: 'now' });
  assert.equal(settled.status, SETTLED);
  assert.equal(settled.close_reason, null);

  const walkout = closingUpdate({ dueMinor: 50000, reason: 'walkout', staffId: 'staff-1', now: 'now' });
  assert.equal(walkout.status, CLOSED);
  assert.equal(walkout.close_reason, 'walkout');

  // Money owed cannot be closed away without saying what happened to it.
  assert.throws(() => closingUpdate({ dueMinor: 50000, staffId: 'staff-1', now: 'now' }));
  assert.throws(() => closingUpdate({ dueMinor: 50000, reason: 'because', staffId: 'staff-1', now: 'now' }));
});

test('a tab carries one order number for the whole night', () => {
  const opened = newTab({
    id: 't1', tenantId: 'ten', branchId: 'b1', tableNo: '9',
    staffId: 'staff-1', now: '2026-09-11T21:00:00.000Z',
  });

  // The number names the table's bill, so every round joins the same one.
  assert.match(opened.order_no, /^ORD-9-\d{6}$/);
  assert.equal(tabOrderNumber('9', new Date('2026-09-11T21:00:00.000Z')), opened.order_no);
  // A table written any way still reads back uppercase on the bill.
  assert.ok(tabOrderNumber('patio 3').startsWith('ORD-PATIO 3-'));
});

test('a tab needs a table to hang on', () => {
  assert.throws(() => newTab({ id: 't1', tableNo: '  ' }));
  const opened = newTab({
    id: 't1', tenantId: 'ten', branchId: 'b1', tableNo: ' 11 ', staffId: 'staff-1', now: 'now',
  });
  assert.equal(opened.table_no, '11');
  assert.equal(opened.status, OPEN);
  assert.equal(opened.closed_at, null);
});

import { tabOwes } from './tabs.js';
import { saleAsOrder } from './customer-orders.js';

test('a table is free only when every round on its tab is paid for', () => {
  const paid = { id: 's1', grand_total: 400, status: 'COMPLETED' };
  const owing = { id: 's2', grand_total: 400, status: 'COMPLETED' };
  const voided = { id: 's3', grand_total: 400, status: 'VOIDED' };
  const ledger = new Map([
    ['s1', [{ method: 'CASH', amount: 400 }]],
    // A receivable nobody has settled: this is what keeps a table open.
    ['s2', [{ method: 'CREDIT', amount: 400 }]],
    ['s3', [{ method: 'CREDIT', amount: 400 }]],
  ]);

  assert.equal(tabOwes([paid], ledger, saleAsOrder), false);
  assert.equal(tabOwes([paid, owing], ledger, saleAsOrder), true);
  // Taken back before anyone paid, so it owes nothing and holds no table.
  assert.equal(tabOwes([paid, voided], ledger, saleAsOrder), false);
  // Every item removed, so its only round was voided: the tab closes.
  assert.equal(tabOwes([voided], ledger, saleAsOrder), false);
  // Settled later: the receivable is stamped, so the table is released.
  assert.equal(tabOwes([owing], new Map([['s2', [{ method: 'CREDIT', amount: 400, settled_at: 'then' }]]]), saleAsOrder), false);
  assert.equal(tabOwes([], ledger, saleAsOrder), false);
});

test('one open tab per name, however the name is typed', async () => {
  const { tabKey, openTabAt } = await import('./tabs.js');
  assert.equal(tabKey('  VIP   Lounge '), 'vip lounge');
  assert.equal(tabKey('Table 5'), '5');
  assert.equal(tabKey('table5'), '5');
  assert.equal(tabKey('T5'), 't5');
  const tabs = [{ id: 'a', status: 'OPEN', table_no: 'VIP', branch_id: 'b1' }];
  assert.equal(openTabAt(tabs, 'b1', 'vip ')?.id, 'a');
  assert.equal(openTabAt(tabs, 'b1', 'Table VIP')?.id, 'a');
  assert.equal(openTabAt(tabs, 'b2', 'VIP'), null);
});


import { mergeTabLines } from './tabs.js';

const billRound = (overrides = {}) => ({
  paymentStatus: 'unpaid', subtotal: 100, tax_total: 16, grand_total: 100,
  dueMinor: 10000, totalMinor: 10000,
  lines: [{ product_id: 'beer', name: 'Beer', qty: 1, line_total: 100 }],
  ...overrides,
});

test('tab invoice merges the same product across rounds without changing amounts', () => {
  const result = mergeTabLines([billRound(), billRound({
    lines: [{ product_id: 'beer', product_name: 'Beer', qty: 2, line_total: 250 }],
  })]);
  assert.equal(result.lines.length, 1);
  assert.equal(result.lines[0].name, 'Beer');
  assert.equal(result.lines[0].qty, 3);
  assert.equal(result.lines[0].line_total, 350);
});

test('tab invoice excludes voided rounds and their totals', () => {
  assert.deepEqual(mergeTabLines([billRound(), billRound({ paymentStatus: 'void' }),
    billRound({ status: 'VOIDED' })]), mergeTabLines([billRound()]));
});

test('tab invoice excludes paid rounds and their totals', () => {
  assert.deepEqual(mergeTabLines([billRound(), billRound({ paymentStatus: 'paid' })]),
    mergeTabLines([billRound()]));
});

test('tab invoice totals equal the sum of unpaid rounds', () => {
  const result = mergeTabLines([billRound(), billRound({
    subtotal: 250, tax_total: 40, grand_total: 250, dueMinor: 25000, totalMinor: 25000,
    lines: [{ product_id: 'food', name: 'Food', qty: 1, line_total: 250 }],
  })]);
  assert.equal(result.subtotal, 350);
  assert.equal(result.tax_total, 56);
  assert.equal(result.grand_total, 350);
  assert.equal(result.dueMinor, 35000);
  assert.equal(result.totalMinor, 35000);
  assert.equal(result.lines.reduce((sum, line) => sum + line.line_total, 0), result.grand_total);
});

// Table 001, 23 Nov: a 500 milkshake with the staff 20%, then rice and mbuzi.
// The bill said Subtotal 1,100 and Total 1,000 with nothing between them.
test('tab invoice carries the rounds\' discounts so subtotal - discount = total', () => {
  const result = mergeTabLines([
    billRound({ subtotal: 500, discount: 100, grand_total: 400, lines: [{ product_id: 'shake', name: 'Shake', qty: 1, line_total: 400 }] }),
    billRound({ subtotal: 100, grand_total: 100, lines: [{ product_id: 'rice', name: 'Rice', qty: 1, line_total: 100 }] }),
    billRound({ subtotal: 500, grand_total: 500, lines: [{ product_id: 'mbuzi', name: 'Mbuzi', qty: 1, line_total: 500 }] }),
  ]);
  assert.equal(result.discount, 100);
  assert.equal(result.subtotal - result.discount, result.grand_total);
});

import { tableChoices, tabAge } from './tabs.js';

test('the table dropdown lists open tabs first, then free tables, and keeps a typed table', () => {
  const tabs = [{ table: '7', dueMinor: 148000, rounds: [{}, {}] }, { table: 'Patio 3', dueMinor: 64000, rounds: [{}] }];
  const choices = tableChoices(tabs, ['1', '7', 'VIP 1'], '7');
  assert.deepEqual(choices.open.map(o => [o.value, o.label]), [['7', 'Table 7 · 2 rounds · KES 1,480'], ['Patio 3', 'Patio 3 · 1 round · KES 640']]);
  assert.deepEqual(choices.free.map(o => o.value), ['1', 'VIP 1']);
  assert.equal(choices.selected, '7');
  assert.equal(choices.typed, false);
  assert.equal(choices.badge, 'Open tab · 2 rounds');
  const typed = tableChoices([], ['1'], 'Garden');
  assert.equal(typed.typed, true);
  assert.equal(typed.badge, '');
  assert.equal(tableChoices([], ['1'], null).selected, '');
  assert.equal(tableChoices(tabs, ['1'], 'table 7').selected, '7');
});

test('an occupied table says since when its bill is unpaid; free tables and bad timestamps say nothing', () => {
  const now = new Date(2026, 10, 27, 12, 0);
  const tabs = [
    { table: '2', dueMinor: 401000, rounds: [{}], opened_at: new Date(2026, 10, 23, 16, 27).toISOString() },
    { table: '8', dueMinor: 300000, rounds: [{}], opened_at: new Date(2026, 10, 25, 10, 23).toISOString() },
    { table: '1', dueMinor: 70000, rounds: [{}], opened_at: new Date(2026, 10, 27, 0, 5).toISOString() },
    { table: '4', dueMinor: 50000, rounds: [{}], opened_at: 'not a date' },
    { table: '5', dueMinor: 35000, rounds: [{}], opened_at: null },
  ];
  const choices = tableChoices(tabs, ['1', '2', '3', '4', '5', '8'], '', now);
  assert.deepEqual(choices.open.map(o => o.label), [
    'Table 2 · Since 23 Nov · 1 round · KES 4,010',
    'Table 8 · Since 25 Nov · 1 round · KES 3,000',
    'Table 1 · Active today · 1 round · KES 700',
    'Table 4 · 1 round · KES 500',
    'Table 5 · 1 round · KES 350',
  ]);
  assert.deepEqual(choices.free.map(o => o.label), ['Table 3']);
  assert.equal(tabAge(new Date(2025, 10, 27).toISOString(), now), 'Since 27 Nov', 'same day last year is not today');
});

test('a paid table frees up: a tab with every round paid or voided is no longer open', () => {
  const tab = (id, table) => ({ id, status: 'OPEN', table_no: table, branch_id: 'b', opened_at: '2026-11-26T10:00:00Z' });
  const round = (tabId, paymentStatus, dueMinor = 0) => ({ id: `${tabId}-${paymentStatus}`, tabId, tableNumber: tabId, branchId: 'b', paymentStatus, dueMinor });
  const open = tabsWithTotals(
    [tab('paid', 'paid'), tab('voided', 'voided'), tab('owing', 'owing'), tab('new', 'new')],
    [round('paid', 'paid'), round('voided', 'void'), round('owing', 'paid'), round('owing', 'unpaid', 35000)],
  );
  assert.deepEqual(open.map(t => [t.id, t.dueMinor]), [['owing', 35000], ['new', 0]]);
});
