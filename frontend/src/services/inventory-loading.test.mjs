import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = (await readFile(new URL('../ui/inventory.js', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
const method = source.slice(source.indexOf('  async load()'), source.indexOf('\n  async refreshMenu()')).replace('async load()', 'async function load()');
const load = (refresh) => new Function('pullCatalogue', 'pullStock', 'pullIdentity', 'showNotification', `return ${method};`)(refresh, async () => {}, async () => {}, () => {});
const refreshMethod = source.slice(source.indexOf('  async refreshMenu()'), source.indexOf('\n  dispose()')).replace('async refreshMenu()', 'async function refreshMenu()');
const makeRefresh = refresh => new Function('pullCatalogue', 'pullStock', 'pullIdentity', 'showNotification', `return ${refreshMethod};`)(refresh, async () => {}, async () => {}, () => {});

test('a discarded inventory refresh cannot replace the current screen or its Actions controls', async () => {
  let finish;
  const waiting = new Promise(resolve => { finish = resolve; });
  let rendered = 0;
  const view = { render() {}, bindEvents() {}, async loadSubTab() { rendered++; } };
  let background;
  view.refreshMenu = () => (background = makeRefresh(() => waiting).call(view));
  await load(() => waiting).call(view);
  assert.equal(rendered, 1, 'cached ledger opens before the server responds');
  view.disposed = true;
  finish();
  await background;
  assert.equal(rendered, 1);
});

test('the current inventory screen still opens when the refresh settles', async () => {
  let rendered = 0;
  const view = { render() {}, bindEvents() {}, async loadSubTab() { rendered++; } };
  let background;
  view.refreshMenu = () => (background = makeRefresh(async () => {}).call(view));
  await load(async () => {}).call(view);
  await background;
  assert.equal(rendered, 2);
});

test('inventory refresh preserves a count or import the operator has started editing', async () => {
  let rendered = 0;
  await makeRefresh(async () => {}).call({ menuEdited: true, async loadSubTab() { rendered++; } });
  assert.equal(rendered, 0);
});
