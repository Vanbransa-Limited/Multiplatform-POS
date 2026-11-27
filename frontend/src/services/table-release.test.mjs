import test from 'node:test';
import assert from 'node:assert/strict';
import { heldRounds, releaseReason, releaseTarget, releasedUnpaid } from './table-release.js';

test('a release needs a reason of 3 to 200 characters', () => {
  assert.deepEqual(releaseReason('  Customer   moved to the bar '), { reason: 'Customer moved to the bar' });
  for (const bad of ['', '  ', 'ok', null, undefined, 'x'.repeat(201)]) assert.match(releaseReason(bad).error, /3 to 200/);
  assert.equal(releaseReason('x'.repeat(200)).reason.length, 200);
});

test('only a tab the server holds, with money owed, can be released from here', () => {
  const tab = { table: '9', serverTabId: 'tab-9', dueMinor: 150000, pendingUploadMinor: 0 };
  assert.deepEqual(releaseTarget(tab), { tableNumber: '9', tabId: 'tab-9', dueMinor: 150000 });
  assert.match(releaseTarget(tab, { online: false }).blocked, /connection/);
  assert.match(releaseTarget({ ...tab, pendingUploadMinor: 500 }).blocked, /still uploading/);
  assert.match(releaseTarget({ ...tab, serverTabId: undefined }).blocked, /not on the server/, 'local-only or another till\'s snapshot');
  assert.match(releaseTarget({ ...tab, serverTabId: 'recovered-s1' }).blocked, /not on the server/);
  assert.match(releaseTarget({ ...tab, dueMinor: 0 }).blocked, /Nothing is owed/);
});

test('managers see each released bill still owed once, with who released it, when and why', () => {
  const stamp = (at) => ({ id: 'rel-1', at, by: 'ann', reason: 'Customer moved to the bar' });
  const sales = [
    { id: 'r1', tab_id: 'T1', branch_id: 'b', table_no: '9', order_reference: 'ORD-9', status: 'PENDING_PAYMENT', grand_total: 500, table_release: stamp('2026-11-27T09:00:00Z') },
    { id: 'r2', tab_id: 'T1', branch_id: 'b', table_no: '9', order_reference: 'ORD-9', status: 'PENDING_PAYMENT', grand_total: 300, table_release: stamp('2026-11-27T09:00:00Z') },
    { id: 'paid', tab_id: 'T2', branch_id: 'b', table_no: '4', order_reference: 'ORD-4', status: 'COMPLETED', grand_total: 200, table_release: stamp('2026-11-27T10:00:00Z') },
    { id: 'voided', tab_id: 'T3', branch_id: 'b', table_no: '5', status: 'VOIDED', grand_total: 900, table_release: stamp('2026-11-27T11:00:00Z') },
    { id: 'other-branch', tab_id: 'T4', branch_id: 'x', table_no: '1', status: 'PENDING_PAYMENT', grand_total: 100, table_release: stamp('2026-11-27T12:00:00Z') },
    { id: 'not-released', tab_id: 'T5', branch_id: 'b', table_no: '2', status: 'PENDING_PAYMENT', grand_total: 100 },
  ];
  const payments = [
    { sale_id: 'r1', method: 'CREDIT', amount: 500 }, { sale_id: 'r2', method: 'CREDIT', amount: 300 },
    { sale_id: 'paid', method: 'CREDIT', amount: 200, settled_at: '2026-11-27T10:30:00Z' }, { sale_id: 'paid', method: 'CASH', amount: 200 },
    { sale_id: 'other-branch', method: 'CREDIT', amount: 100 }, { sale_id: 'not-released', method: 'CREDIT', amount: 100 },
  ];
  assert.deepEqual(releasedUnpaid(sales, payments, 'b'), [{ tabId: 'T1', table: '9', ref: 'ORD-9', dueMinor: 80000, rounds: 2,
    releasedBy: 'ann', releasedAt: '2026-11-27T09:00:00Z', reason: 'Customer moved to the bar' }]);
});

test('held rounds are listed for review with the released bill they were rung for', () => {
  const held = heldRounds([
    { id: 'h1', invoice_no: null, table_no: '9', branch_id: 'b', grand_total: 250, sync_hold: 'table_released',
      sync_hold_detail: { order_reference: 'ORD-9', held_at: '2026-11-27T11:00:00Z' }, sync_error_msg: 'Table 9 was released' },
    { id: 'h2', branch_id: 'b', sync_hold: 'table_released', status: 'VOIDED' },
    { id: 'n', branch_id: 'b', table_no: '9' },
  ], 'b');
  assert.deepEqual(held, [{ id: 'h1', ref: 'h1', table: '9', totalMinor: 25000, releasedTabRef: 'ORD-9',
    heldAt: '2026-11-27T11:00:00Z', message: 'Table 9 was released' }]);
});
