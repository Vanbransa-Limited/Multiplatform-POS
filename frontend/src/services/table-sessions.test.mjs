import test from 'node:test';
import assert from 'node:assert/strict';
import { withServerSessions } from './table-sessions.js';

const local = (id, table, extra = {}) => ({ id, status: 'OPEN', branch_id: 'b', table, table_no: table,
  opened_at: '2026-11-26T10:00:00Z', dueMinor: 50000, rounds: [{ id: `${id}-r` }], unpaidRounds: [{ id: `${id}-r` }], ...extra });
const session = (table, dueMinor, extra = {}) => ({ status: 'OPEN', branchId: 'b', tableNumber: table, tabId: `srv-${table}`,
  orderReference: `ORD-${table}`, dueMinor, roundSaleIds: ['s1', 's2'], openedAt: '2026-11-26T09:00:00Z', ...extra });

test('offline or unknown: this device\'s own view stands', () => {
  const tabs = [local('a', '6')];
  assert.equal(withServerSessions(tabs, null), tabs);
});

test('the server decides what is owed and what is open', () => {
  const tabs = withServerSessions([
    local('paid-elsewhere', '6'),
    local('owing', '7', { pendingUploadMinor: 0 }),
    local('uploading', '8', { pendingUploadMinor: 20000 }),
    local('opening', '9', { rounds: [], unpaidRounds: [] }),
    local('mixed', 'Table 10', { pendingUploadMinor: 15000 }),
  ], [session('7', 85000), session('10', 30000), session('11', 40000)]);
  const byTable = Object.fromEntries(tabs.map(t => [t.table, t]));
  assert.equal(byTable['6'], undefined, 'paid on another till: gone here too');
  assert.equal(byTable['7'].dueMinor, 85000, 'server amount, including another tablet\'s round');
  assert.equal(byTable['8'].dueMinor, 50000, 'not on the server yet: kept from here');
  assert.ok(byTable['9'], 'a tab being opened stays');
  assert.equal(byTable['Table 10'].dueMinor, 45000, 'server due plus what is still uploading');
  const unseen = byTable['11'];
  assert.equal(unseen.id, 'srv-11'); assert.equal(unseen.dueMinor, 40000); assert.equal(unseen.rounds.length, 2);
  assert.ok(unseen.readOnly && unseen.recoveryRequired, 'addable: the till re-creates its header');
});
