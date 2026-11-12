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
