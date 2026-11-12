import { chromium } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { readWithDeadline } from '../src/services/read-deadline.js';

const source = (await readFile(new URL('../src/ui/stock.js', import.meta.url), 'utf8'))
  .replace(/^import .*;\r?\n/gm, '').replace('export class', 'class');
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  await page.setContent('<main></main>');
  await page.evaluate(async ({ source, deadline }) => {
    window.mode = 'pending';
    window.stockQty = 7;
    const products = [{ id: 'tea', name: 'Tea', tenant_id: 'tenant', sku: 'TEA' }];
    const selection = { toArray: async () => products, filter: () => selection };
    const db = {
      products: { where: () => ({ equals: () => selection }), toArray: async () => products },
      stock_balances: { where: () => ({ equals: () => ({ toArray: async () => [
        { productId: 'tea', location: 'STORE', qty: window.stockQty },
      ] }) }) },
      users: { toArray: async () => [] },
    };
    const bounded = new Function(`return (${deadline});`)();
    const View = new Function('db', 'state', 'pullStock', 'pullCatalogue', 'pullStockMovements', 'storeIsEnabled', 'readWithDeadline', 'compareNames', 'esc', 'createMobileFilters',
      `${source};return StockView;`)(db,
      { currentTenant: { id: 'tenant' }, currentBranch: { id: 'branch' }, currentUser: { role: 'Owner' } },
      () => window.mode === 'pending' ? new Promise(() => {}) : Promise.resolve(),
      async () => {}, async () => [], () => true, read => bounded(read, 40),
      (a, b) => a.localeCompare(b), value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;'), () => ({ close() {}, dispose() {} }));
    window.stock = new View(document.querySelector('main'), 'STORE');
    await window.stock.load();
  }, { source, deadline: readWithDeadline.toString() });
  assert.match(await page.locator('#stk-body').innerText(), /Tea/);
  await page.waitForFunction(() => document.querySelector('#stk-refresh-status').textContent.includes('timed out'));
  assert.equal(await page.locator('#stk-refresh').isEnabled(), true);
  await page.locator('[data-stock-panel="entry"]').click();
  await page.locator('#stk-qty').fill('4');
  await page.locator('#stk-reason').fill('Delivery in progress');
  await page.evaluate(() => { window.mode = 'ready'; window.stockQty = 13; });
  await page.locator('#stk-refresh').click();
  // A successful refresh clears the status rather than announcing itself.
  await page.waitForFunction(() => { const text = document.querySelector('#stk-refresh-status').textContent; return !text.includes('Refreshing') && !text.includes('timed out'); });
  assert.equal(await page.locator('#stk-qty').inputValue(), '4');
  assert.equal(await page.locator('#stk-reason').inputValue(), 'Delivery in progress');
  assert.match(await page.locator('#stk-body').innerText(), /13/);
  await page.locator('#stk-search').fill('Tea');
  assert.match(await page.locator('#stk-body').innerText(), /13/);
  await page.evaluate(async () => {
    window.mode = 'pending';
    const pending = window.stock.refresh();
    window.stock.dispose();
    document.querySelector('main').innerHTML = '<p>Another screen</p>';
    await pending;
  });
  assert.equal(await page.locator('main').innerText(), 'Another screen');
  console.log('Stock browser checks passed: cached render, timeout, retry, refreshed quantities, form preservation, search and navigation cleanup.');
} finally {
  await browser.close();
}
