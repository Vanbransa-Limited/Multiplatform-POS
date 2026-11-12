import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = (await readFile(new URL('../ui/inventory.js', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
const method = source.slice(source.indexOf('  async load()'), source.indexOf('\n  dispose()')).replace('async load()', 'async function load()');
const load = (refresh) => new Function('pullCatalogue', 'pullStock', 'pullIdentity', 'showNotification', `return ${method};`)(refresh, async () => {}, async () => {}, () => {});

test('a discarded inventory refresh cannot replace the current screen or its Actions controls', async () => {
  let finish;
  const waiting = new Promise(resolve => { finish = resolve; });
  let rendered = 0;
  const view = { render() {}, bindEvents() {}, async loadSubTab() { rendered++; } };
  const pending = load(() => waiting).call(view);
  view.disposed = true;
  finish();
  await pending;
  assert.equal(rendered, 0);
});

test('the current inventory screen still opens when the refresh settles', async () => {
  let rendered = 0;
  await load(async () => {}).call({ render() {}, bindEvents() {}, async loadSubTab() { rendered++; } });
  assert.equal(rendered, 1);
});
