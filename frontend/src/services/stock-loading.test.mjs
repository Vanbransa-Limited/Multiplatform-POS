import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { readWithDeadline } from './read-deadline.js';

const source = (await readFile(new URL('../ui/stock.js', import.meta.url), 'utf8'))
  .replace(/^import .*;\r?\n/gm, '').replace('export class', 'class');
const make = (stock, catalogue, deadline = fn => readWithDeadline(fn, 10)) => {
  const View = new Function('pullStock', 'pullCatalogue', 'readWithDeadline', `${source};return StockView;`)(stock, catalogue, deadline);
  const view = new View({ querySelector: () => null });
  view.renders = [];
  view.render = async options => view.renders.push(options);
  view.loadMovements = async () => { view.movements = []; };
  return view;
};

test('stock renders cached data before a stalled server read finishes', async () => {
  const view = make(() => new Promise(() => {}), async () => {});
  await view.load();
  assert.equal(view.renders.length, 1);
  assert.equal(view.refreshing, true);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(view.refreshing, false);
  assert.match(view.refreshStatus, /cached stock.*failed or timed out/);
});

test('failed optional reads do not hide refreshed stock, and an open form is preserved', async () => {
  const view = make(async () => {}, async () => { throw new Error('offline catalogue'); });
  view.openPanel = 'entry';
  view.loadMovements = () => new Promise(() => {});
  await view.refresh();
  assert.doesNotMatch(view.refreshStatus, /refreshed from server/);
  assert.match(view.refreshStatus, /Product details could not refresh/);
  assert.match(view.refreshStatus, /Movement history is unavailable/);
  assert.deepEqual(view.renders, [{ preserveForm: true }]);
});

test('disposed stock views do not redraw when reads complete', async () => {
  let finish;
  const view = make(() => new Promise(resolve => { finish = resolve; }), async () => {});
  const pending = view.refresh();
  await Promise.resolve();
  view.dispose();
  finish();
  await pending;
  assert.equal(view.renders.length, 0);
});

test('read deadlines preserve errors and allow a later retry', async () => {
  await assert.rejects(readWithDeadline(() => new Promise(() => {}), 5), /timed out/);
  assert.equal(await readWithDeadline(async () => 12, 10), 12);
  await assert.rejects(readWithDeadline(async () => { throw new Error('permission denied'); }, 10), /permission denied/);
});
