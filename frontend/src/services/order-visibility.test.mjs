import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { mergeTabRounds, saleAsOrder, handledBy } from './customer-orders.js';

const source = (await readFile(new URL('../ui/orders.js', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
const start = source.indexOf('  async loadPosOrders(');
const body = source.slice(start, source.indexOf('\n  /** Everything the board', start))
  .replace('async loadPosOrders(', 'async function loadPosOrders(');
const make = (db, network = {}) => new Function('db', 'mergeTabRounds', 'saleAsOrder', 'handledBy', 'pullOpenOrders', 'pullSales', 'pullStaff', 'DEVICE_ID', `${body};return loadPosOrders;`)(db, mergeTabRounds, saleAsOrder, handledBy, network.pullOpenOrders, network.pullSales, async () => {}, 'device');

test('a shared snapshot handed over to sales cannot fall between the two cloud reads', async () => {
  const calls = [];
  let canonical = [];
  let local = [];
  const read = make({ transaction: async () => [local, [], [], [], [], [], [], []] }, {
    pullOpenOrders: async () => {
      calls.push('snapshots');
      // The publisher has removed its snapshot only after committing the sale.
      canonical = [{ id: 'handoff', status: 'COMPLETED', grand_total: 100 }];
      return [];
    },
    pullSales: async () => { calls.push('sales'); local = canonical; return local.length; },
  });
  const view = { posOrders: [] };
  await read.call(view);
  assert.deepEqual(calls, ['snapshots', 'sales']);
  assert.equal(view.posOrders[0].id, 'handoff');
});

test('an IndexedDB refresh failure keeps the last displayed order instead of clearing the floor', async () => {
  const saved = [{ id: 'table-20', ref: 'ORD-20' }];
  const view = { posOrders: saved };
  await make({ transaction: async () => { throw new Error('interrupted read'); } }).call(view, { refresh: false });
  assert.equal(view.posOrders, saved);
  assert.match(view.syncWarning, /Keeping the last displayed orders/);
});

test('a late older snapshot cannot overwrite a newer order snapshot', async () => {
  const pending = [];
  const db = { transaction: () => new Promise(resolve => pending.push(resolve)) };
  const read = make(db);
  const view = { posOrders: [] };
  const older = read.call(view, { refresh: false });
  const newer = read.call(view, { refresh: false });
  const snapshot = id => [[{ id, status: 'COMPLETED', grand_total: 1 }], [], [], [], [], [], [], []];
  pending[1](snapshot('new-order'));
  await newer;
  pending[0](snapshot('old-order'));
  await older;
  assert.equal(view.posOrders[0].id, 'new-order');
});

test('seed migration refuses to erase a till even when its saved sales are synchronized', async () => {
  const index = (await readFile(new URL('../db/index.js', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
  const code = index.slice(index.indexOf('async function wipeAllTables('), index.indexOf('// Seed the DB'));
  let cleared = false;
  const db = { sales: { count: async () => 1 }, tables: [{ clear: async () => { cleared = true; } }] };
  const wipe = new Function('db', 'hasUnsyncedSales', `${code};return wipeAllTables;`)(db, async () => false);
  assert.equal(await wipe('upgrade'), false);
  assert.equal(cleared, false);
});
