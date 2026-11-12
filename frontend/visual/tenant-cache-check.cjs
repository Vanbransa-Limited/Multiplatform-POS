// Exercises the actual Dexie schema in an isolated browser origin; never
// connects to Firebase or opens a real till's browser profile.
const { chromium } = require('@playwright/test');
const { readFileSync } = require('node:fs');
const { createServer } = require('node:http');
const path = require('node:path');
const assert = require('node:assert/strict');

(async () => {
  const root = path.resolve(__dirname, '..');
  const server = createServer((_req, res) => res.end('<!doctype html><title>Cache isolation test</title>'));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.addScriptTag({ path: path.join(root, 'node_modules/dexie/dist/dexie.js') });
    const schema = readFileSync(path.join(root, 'src/db/schema.js'), 'utf8')
      .replace(/^import .*;\r?\n/gm, '')
      .replace('export const db =', 'const db =');
    const cache = readFileSync(path.join(root, 'src/services/tenant-cache.js'), 'utf8')
      .replace(/^export /gm, '');
    const result = await page.evaluate(async ({ schema, cache }) => {
      const scope = new Function(`${cache}; return { cacheName, selectCacheTenant, selectedCacheTenant, tenantStorageKey };`)();
      const makeDb = () => new Function('Dexie', 'cacheName', 'selectedCacheTenant', `${schema}; return db;`)(window.Dexie, scope.cacheName, scope.selectedCacheTenant);
      const legacy = makeDb();
      await legacy.open();
      await legacy.sales.put({ id: 'titanium-pending', tenant_id: 'tenant-01', synced_at: null, grand_total: 450 });
      await legacy.products.put({ id: 'titanium-product', tenant_id: 'tenant-01', name: 'Titanium stock' });
      localStorage.setItem('pos_discounts', 'Titanium-only');
      const before = await legacy.sales.toArray();
      legacy.close();
      scope.selectCacheTenant('tenant-new-business');
      const next = makeDb();
      await next.open();
      const initial = { sales: await next.sales.count(), products: await next.products.count() };
      await next.sales.put({ id: 'new-sale', tenant_id: 'tenant-new-business', synced_at: null });
      await next.products.put({ id: 'new-product', tenant_id: 'tenant-new-business', name: 'New catalogue' });
      localStorage.setItem(scope.tenantStorageKey('pos_discounts', 'tenant-new-business'), 'new discounts');
      next.close();
      scope.selectCacheTenant('tenant-01');
      const original = makeDb();
      await original.open();
      const output = {
        initial, before, after: await original.sales.toArray(),
        products: (await original.products.toArray()).map(row => row.id),
        discount: localStorage.getItem('pos_discounts'),
      };
      original.close();
      return output;
    }, { schema, cache });
    assert.deepEqual(result.initial, { sales: 0, products: 0 });
    assert.deepEqual(result.after, result.before);
    assert.equal(result.after[0].sync_pending, 1);
    assert.deepEqual(result.products, ['titanium-product']);
    assert.equal(result.discount, 'Titanium-only');
    console.log('Browser cache isolation passed: new tenant starts empty; Titanium pending sale, product and discounts unchanged.');
  } finally {
    await browser?.close();
    server.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
