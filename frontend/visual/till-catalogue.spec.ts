import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

test('large till catalogue pages, searches every item and adds the selected product', async ({ page }) => {
  await page.setContent('<div id="host"><input id="till-search"><div id="cat-filters"></div><div id="till-prod-grid"></div><div id="till-product-pager"></div></div>');
  const source = readFileSync('src/ui/till.js', 'utf8')
    .replace(/^import[\s\S]*?;\r?\n/gm, '')
    .replace('export function getCanonicalCategoryName', 'function getCanonicalCategoryName')
    .replace('export class TillView', 'window.TillView = class TillView');
  const pager = readFileSync('src/services/paginate.js', 'utf8').replaceAll('export ', '');
  await page.addScriptTag({ content: `${pager}
    const MpesaService = class {};
    const unavailableMpesaCapability = () => ({});
    const firebaseConfigured = true;
    const state = { currentBranch: { id: 'b1' } };
    const products = Array.from({length: 3000}, (_, i) => ({id: 'p'+i, name: 'Item '+i, sku: 'SKU'+i, category_id: i % 2 ? 'drinks' : 'food', sell_price: 100, is_active: 1}));
    const table = rows => ({toArray: async () => rows, where: () => ({equals: () => ({toArray: async () => rows})})});
    const db = {
      products: table(products),
      stock_movements: {toArray: () => {throw new Error('Do not scan movement history');}},
      stock_balances: table([{productId:'p2999',location:'HOUSE',qty:12,reservedQty:2}]),
      barcodes: table([{product_id:'p2999',barcode:'BAR-LAST'}]),
      categories: table([{id:'food',name:'Food'},{id:'drinks',name:'Drinks'}])
    };
    ${source}
    window.view = new window.TillView(document.querySelector('#host'));
    window.view.addToCart = product => { window.selectedProduct = product; };
    window.loadFinished = window.view.loadProducts();
  ` });
  await page.evaluate('window.loadFinished');
  await expect(page.locator('.product-card')).toHaveCount(48);
  await page.locator('[data-page="next"]').click();
  await expect(page.locator('.product-card').first()).toHaveAttribute('data-id', 'p48');

  await page.fill('#till-search', 'bar-last');
  await page.evaluate('window.view.filterCatalogue()');
  await expect(page.locator('.product-card')).toHaveCount(1);
  await expect(page.locator('.product-card')).toHaveAttribute('data-id', 'p2999');
  await expect(page.locator('.product-card .stock')).toHaveText('10 left');
  await page.locator('.product-card').click();
  expect(await page.evaluate('window.selectedProduct.id')).toBe('p2999');
  expect(await page.evaluate('window.selectedProduct.sell_price')).toBe(100);

  await page.fill('#till-search', 'missing-item');
  await page.evaluate('window.view.filterCatalogue()');
  await expect(page.locator('.product-card')).toHaveCount(0);
  await expect(page.locator('#till-prod-grid')).toHaveText('No products match your search.');

  await page.fill('#till-search', '');
  await page.evaluate(`document.querySelector('.filter-chip.active').classList.remove('active'); document.querySelector('[data-cat-name="Drinks & Beverages"]').classList.add('active'); window.view.filterCatalogue();`);
  await expect(page.locator('.product-card')).toHaveCount(48);
  await expect(page.locator('.product-card').first()).toHaveAttribute('data-id', 'p1');
  await expect(page.locator('#till-page-controls')).toContainText('of 1500');
});
