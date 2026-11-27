import test from 'node:test';
import assert from 'node:assert/strict';
import { withServerSessions } from './table-sessions.js';
import { tableChoices } from './tabs.js';

const local = (id, table, extra = {}) => ({ id, status: 'OPEN', branch_id: 'b', table, table_no: table,
  opened_at: '2026-11-26T10:00:00Z', dueMinor: 50000, rounds: [{ id: `${id}-r` }], unpaidRounds: [{ id: `${id}-r` }], ...extra });
const session = (table, dueMinor, extra = {}) => ({ status: 'OPEN', branchId: 'b', tableNumber: table, tabId: `srv-${table}`,
  orderReference: `ORD-${table}`, dueMinor, roundSaleIds: ['s1', 's2'], openedAt: '2026-11-26T09:00:00Z', ...extra });

test('the till picker frees exactly the tables nothing is owed on', () => {
  const presets = ['1', '2', '3', '4', '5', '6'];
  const picker = (tabs, sessions) => {
    const { open, free } = tableChoices(withServerSessions(tabs, sessions), presets, '');
    return { open: open.map(o => o.value).sort(), free: free.map(f => f.value) };
  };
  const tabs = [
    local('paid-on-another-tablet', '1', { pendingUploadMinor: 0 }),
    local('part-paid', '2'),
    local('unpaid', '3'),
    local('being-paid', '4'),
    // Refused by the server, so still only here: money owed that nobody else can see.
    local('not-uploaded', '5', { pendingUploadMinor: 50000 }),
  ];
  const server = [session('2', 20000), session('3', 50000), session('4', 50000)];
  assert.deepEqual(picker(tabs, server), { open: ['2', '3', '4', '5'], free: ['1', '6'] });
  // A retry or a later pull re-reads this device's stale copy of table 1: the server still decides.
  assert.deepEqual(picker([...tabs, local('stale-copy', '1')], server).free, ['1', '6']);
  // Table 2 settled on another tablet: its session leaves the OPEN list and the table frees here.
  assert.deepEqual(picker(tabs, server.filter(s => s.tableNumber !== '2')).free, ['1', '2', '6']);
});

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

test('a table released elsewhere shows the server\'s new tab, not this tablet\'s stale copy', () => {
  // This tablet still holds the released tab T1 at table 9; the server's tab there is now T2.
  const stale = local('T1', '9', { pendingUploadMinor: 0 });
  const [tab] = withServerSessions([stale], [session('9', 20000, { tabId: 'T2', roundSaleIds: ['n1'] })]);
  assert.equal(tab.id, 'T2'); assert.equal(tab.serverTabId, 'T2'); assert.equal(tab.dueMinor, 20000);
  assert.ok(tab.readOnly && tab.recoveryRequired, 'the till re-creates T2\'s header and joins it');
  // Nobody at table 9 yet: the released table is simply free.
  assert.deepEqual(tableChoices(withServerSessions([stale], []), ['9'], '').free.map(f => f.value), ['9']);
  // Rounds still uploading from here are never hidden.
  const uploading = withServerSessions([local('T1', '9', { pendingUploadMinor: 5000 })], [session('9', 20000, { tabId: 'T2' })]);
  assert.equal(uploading[0].id, 'T1');
});
