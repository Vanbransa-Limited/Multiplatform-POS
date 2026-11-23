import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { newTab, tabKey } from './tabs.js';
const source = (await readFile(new URL('../ui/till.js', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
const body = source.slice(source.indexOf('  async assertTabNameFree('), source.indexOf('\n  async resolveTabForRound('))
  .replace('async assertTabNameFree(', 'async function assertTabNameFree(');
function setup(tabs, refresh = async () => {}, remote = async () => []) {
  const writes = [];
  const run = new Function('db', 'state', 'firebaseConfigured', 'pullSales', 'readOpenTabs', 'tabKey', 'newTab', 'pullOpenOrders', 'DEVICE_ID', `return ${body}`)(
    { tabs: { put: async row => writes.push(row) } }, { currentTenant: { id: 'tenant' }, currentBranch: { id: 'branch' } }, true,
    refresh, async () => tabs, tabKey, newTab, remote, 'device');
  return { run, writes };
}

test('adding to an imported table adopts its original identity and reference before saving a round', async () => {
  let refreshed = false;
  const h = setup([{ id: 'original', table: '50', dueMinor: 1400000, recoveryRequired: true,
    order_no: 'ORD-50', opened_at: '2026-11-20T16:44:31Z' }], async (...args) => {
    assert.deepEqual(args[2], { tableNumber: '50', branchId: 'branch' }); refreshed = true;
  });
  const view = {};
  await h.run.call(view, '50');
  assert.equal(refreshed, true);
  assert.equal(view.activeTabId, 'original');
  assert.equal(h.writes[0].id, 'original');
  assert.equal(h.writes[0].order_no, 'ORD-50');
});

test('an existing local header still refreshes shared sales before choosing the bill', async () => {
  let refreshed = false;
  const h = setup([{ id: 'open', table: '50', dueMinor: 100 }], async () => { refreshed = true; });
  await h.run.call({}, '50');
  assert.equal(refreshed, true);
  assert.equal(h.writes.length, 0);
});

test('split unpaid tabs and a failed shared read cannot silently create another tab', async () => {
  const h = setup([{ id: 'a', table: '50', dueMinor: 1400000 }, { id: 'b', table: '50', dueMinor: 160000 }]);
  await assert.rejects(h.run.call({}, '50'), /multiple unpaid bills/);
  const failed = setup([], async () => { throw Error('Offline'); });
  await assert.rejects(failed.run.call({}, '50'), /Offline/);
  assert.equal(h.writes.length, 0);
});
