import test from 'node:test';
import assert from 'node:assert/strict';
import { adjustTarget, stockTakeRows, findDuplicate } from './stock-actions.js';
import { readFile } from 'node:fs/promises';

test('a successful stock decision remains saved when its following refresh fails', async () => {
  const source = await readFile(new URL('./stock.js', import.meta.url), 'utf8');
  const method = source.slice(source.indexOf('async function refreshAfterStockCommit('), source.indexOf('/** Books a whole delivery'));
  const run = new Function('pullStock', `${method}; return refreshAfterStockCommit;`)(async () => { throw new Error('Offline'); });
  const result = await run({ status: 'approved', qty: 24, storeQty: 6 });
  assert.equal(result.status, 'approved');
  assert.equal(result.qty, 24);
  assert.equal(result.storeQty, 6);
  assert.match(result.refreshWarning, /Saved on the server.*Offline/);
});

test('add / remove becomes a target count, and never removes what is not there', () => {
  assert.deepEqual(adjustTarget(10, 'add', '2'), { qty: 12 });
  assert.deepEqual(adjustTarget(10, 'remove', '3'), { qty: 7 });
  assert.deepEqual(adjustTarget(-85, 'add', '80'), { qty: -5 });
  assert.match(adjustTarget(3, 'remove', '5').error, /Only 3/);
  for (const bad of ['', '0', '-2', '1.5', 'abc']) assert.match(adjustTarget(3, 'add', bad).error, /whole number/);
});

test('a stock take sends only what was counted, and names a bad entry', () => {
  const items = [{ id: 'a', name: 'Tusker' }, { id: 'b', name: 'Guinness' }, { id: 'c', name: 'Pilsner' }];
  assert.deepEqual(stockTakeRows(items, { a: '12', b: '', c: '0' }), { rows: [{ productId: 'a', name: 'Tusker', qty: 12 }, { productId: 'c', name: 'Pilsner', qty: 0 }] });
  assert.match(stockTakeRows(items, { a: '' }).error, /at least one/);
  assert.match(stockTakeRows(items, { b: '-1' }).error, /Guinness/);
  assert.match(stockTakeRows(items, { b: 'x' }).error, /Guinness/);
});

test('a new item may not reuse an existing name or SKU', () => {
  const products = [{ name: 'WHITECAP LAGER BOTTLE 500ML', sku: 'WC500' }];
  assert.ok(findDuplicate(products, ' whitecap lager bottle 500ml ', ''));
  assert.ok(findDuplicate(products, 'Something new', 'wc500'));
  assert.equal(findDuplicate(products, 'Whitecap Can', ''), undefined);
});
