import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = (await readFile(new URL('./sync.js', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
const start = source.indexOf('  async publishOpenTabs()');
const body = source.slice(start, source.indexOf('\n  /**', start + 1)).replace('async publishOpenTabs()', 'async function publishOpenTabs()');
function setup(devices, branchId, publish) {
  const warnings = [];
  const run = new Function('db', 'state', 'DEVICE_ID', 'publishOpenOrders', 'showNotification', `return ${body};`)(
    { devices: { toArray: async () => devices } }, { currentBranch: branchId ? { id: branchId } : null }, 'enrolled-till', publish,
    text => warnings.push(text));
  return { run, warnings };
}

test('a Firebase till with no seeded device row still publishes its open tables', async () => {
  const calls = [];
  const { run } = setup([], 'branch', async payload => calls.push(payload));
  const manager = {};
  await run.call(manager);
  assert.deepEqual(calls, [{ branchId: 'branch', deviceId: 'enrolled-till' }]);
  assert.equal(manager.openOrderPublishError, null);
});

test('failed publication is visible and a later successful retry clears the failure', async () => {
  let fail = true;
  const { run, warnings } = setup([], 'branch', async () => { if (fail) throw new Error('offline'); });
  const manager = {};
  await run.call(manager);
  await run.call(manager);
  assert.equal(warnings.length, 1);
  assert.equal(manager.openOrderPublishError, 'offline');
  fail = false;
  await run.call(manager);
  assert.equal(manager.openOrderPublishError, null);
});
