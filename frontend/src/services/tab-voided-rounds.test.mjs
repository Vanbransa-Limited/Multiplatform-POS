import assert from 'node:assert/strict';
import test from 'node:test';

import { mergeTabRounds, saleAsOrder, visibleOrders } from './customer-orders.js';
import { tabsWithTotals } from './tabs.js';

// Table 1 on 12 Nov 2026: four rounds voided by Edit items, one live round.
// The board showed KES 1400 and eight items; only one tea (KES 150) was owed.
const TAB = 'tab-table-1';
const round = (id, invoice, status, total, items, ref = 'INV-BH001-002377') => saleAsOrder(
  { id, invoice_no: invoice, sale_uuid: `uuid-${id}`, tab_id: TAB, table_no: '1', branch_id: 'b1',
    order_reference: ref, status, grand_total: total, sold_at: '2026-11-12T20:00:00Z' },
  // Pulled receivables carry no status, so a voided round's row still reads unsettled.
  { payments: [{ method: 'CREDIT', amount: total }], lines: items.map(name => ({ name, qty: 1 })) },
);
const rounds = [
  round('r1', 'INV-BH001-002281', 'VOIDED', 300, ['CHIPS MAYAI']),
  round('r2', 'INV-BH001-002312', 'VOIDED', 550, ['CHIPS MAYAI', 'COKE', 'AFRICAN TEA']),
  round('r3', 'INV-BH001-002377', 'VOIDED', 250, ['AFRICAN TEA', 'COKE']),
  round('r4', 'INV-BH001-002378', 'VOIDED', 150, ['AFRICAN TEA']),
  round('r5', 'INV-BH001-002379', 'PENDING_PAYMENT', 150, ['AFRICAN TEA']),
];

test('a voided round owes nothing, whatever its receivable row says', () => {
  assert.equal(rounds[0].paymentStatus, 'void');
  assert.equal(rounds[0].dueMinor, 0);
});

test('a tab card bills only its live rounds, not the ones Edit items voided', () => {
  const [card, ...rest] = mergeTabRounds(rounds, []).filter(order => order.roundIds);
  assert.equal(rest.length, 0);
  assert.equal(card.totalMinor, 15000);
  assert.equal(card.dueMinor, 15000);
  assert.deepEqual(card.lines.map(line => line.name), ['AFRICAN TEA']);
  assert.deepEqual(card.roundIds, ['r5']);
  assert.deepEqual(card.roundUuids, ['uuid-r5']);
});

test('voided rounds stay on the board as cancelled history', () => {
  const cancelled = mergeTabRounds(rounds, []).filter(order => order.paymentStatus === 'void');
  assert.equal(cancelled.length, 4);
});

test('the tab card is found by any live round invoice', () => {
  const merged = mergeTabRounds(rounds, []);
  const card = merged.find(order => order.roundIds);
  assert.ok(card.roundRefs.includes('INV-BH001-002379'));
  assert.ok(visibleOrders(merged, 'b1', { search: 'INV-BH001-002379' }).includes(card));
});

test('Tab Management counts only live rounds on an open tab', () => {
  const [tab] = tabsWithTotals([{ id: TAB, status: 'OPEN', table_no: '1', opened_at: '2026-11-12T09:58:56Z' }],
    rounds.map(order => ({ ...order, tabId: TAB })));
  assert.equal(tab.dueMinor, 15000);
  assert.equal(tab.rounds.length, 1);
  assert.equal(tab.items, 1);
});
