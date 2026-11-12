import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

async function mount(page: Page, file: string, name: string) {
  await page.setContent('<meta name="viewport" content="width=device-width, initial-scale=1"><div id="app-container"><div id="pos-shell"><main class="app-main-content"><section id="view-orders" class="tab-view active"></section></main></div></div>');
  await page.addStyleTag({ content: readFileSync('src/ui/styles.css', 'utf8') + readFileSync('src/ui/mobile.css', 'utf8') });
  const source = readFileSync(`src/ui/${file}.js`, 'utf8').replace(/^import[\s\S]*?;\r?\n/gm, '').replace(`export class ${name}`, `window.Screen = class ${name}`);
  const filters = readFileSync('src/ui/mobile-filters.js', 'utf8').replace('export function', 'function');
  await page.addScriptTag({ content: `
    const state={currentUser:{role:'Owner'},currentBranch:{id:'b1'}};
    const escapeHtml=value=>String(value??''); const esc=escapeHtml;
    const cashIsEnabled=()=>true; const storeIsEnabled=()=>Boolean(window.hasStore);
    const MpesaService=class{}; const DEVICE_ID='test-device';
    const db={users:{toArray:async()=>[]}};
    const readOpenTabs=async()=>[{id:'tab1',table:'9',order_no:'TAB-9',dueMinor:50000,items:2,rounds:[{ref:'TAB-9'}],opened_at:'2026-11-10T10:00:00Z'}];
    const pullOpenOrders=async()=>[];
    ${filters}
    ${source}
    window.view=new window.Screen(document.querySelector('.tab-view'));
  ` });
}

test('Orders search and filter remain pinned after scrolling a long list', async ({ page }) => {
  await mount(page, 'orders', 'OrdersView');
  await page.evaluate(`view.render();view.bindEvents();document.querySelector('#customer-orders-status').textContent='';document.querySelector('#customer-orders-list').innerHTML=Array.from({length:30},(_,i)=>'<article style="height:120px">Order '+i+'</article>').join('');document.querySelector('.app-main-content').scrollTop=900;`);
  await expect.poll(() => page.locator('#orders-search-toolbar').evaluate(el => Math.round(el.getBoundingClientRect().top))).toBe(0);
  await expect(page.locator('#customer-orders-search')).toBeInViewport();
  await page.getByRole('button', { name: /^Order filters/ }).click();
  await expect(page.getByRole('dialog', { name: 'Order filters' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('#orders-search-toolbar')).toBeInViewport();
  await expect(page.locator('#customer-orders-status')).toBeHidden();
  await page.screenshot({ path: 'visual/report/orders-sticky-phone.png' });
});

test('House cards align both quantities and Correct on one row with wrapping names', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await mount(page, 'stock', 'StockView');
  await page.evaluate(`window.hasStore=true;view.rows=async()=>[{product:{id:'p1',name:'1 Litre'},qty:1,storeQty:0,reservedQty:0},{product:{id:'p2',name:'1.415gms Balance 0.585gms mince pre carried forward'},qty:0,storeQty:0,reservedQty:0}];view.refreshStatus='';view.bindImport=()=>{};view.bindNewItem=()=>{};view.render();`);
  await expect(page.getByText('How stock works', { exact: true })).toHaveCount(0);
  const first = page.locator('#stk-body tr').first();
  const store = await first.locator('[data-label="In Store"]').boundingBox();
  const house = await first.locator('[data-label="In House"]').boundingBox();
  const correct = await first.locator('[data-correct]').boundingBox();
  expect(Math.abs(store!.y - house!.y)).toBeLessThan(2);
  expect(correct!.x).toBeGreaterThan(house!.x + house!.width - 1);
  expect(correct!.y).toBeLessThan(house!.y + house!.height);
  expect(correct!.height).toBeGreaterThanOrEqual(44);
  expect((await first.boundingBox())!.height).toBeLessThan(125);
  const second = await page.locator('#stk-body tr').nth(1).boundingBox();
  expect(second!.x + second!.width).toBeLessThanOrEqual(360);
  await page.screenshot({ path: 'visual/report/house-compact-cards.png' });
});

test('Tabs fit the phone and keep search available above readable cards', async ({ page }) => {
  await mount(page, 'tab-management', 'TabManagementView');
  await page.evaluate('view.load()');
  await expect(page.getByRole('link', { name: 'Pay now', exact: true })).toBeVisible();
  await expect(page.locator('.tab-card')).toContainText('Table 9');
  await page.locator('#tabs-search').fill('no such table');
  await expect(page.locator('.tab-card')).toHaveCount(0);
  await page.locator('#tabs-search').fill('9');
  await expect(page.locator('.tab-card')).toBeVisible();
  const rect = await page.locator('.tab-card').boundingBox();
  expect(rect!.x).toBeGreaterThanOrEqual(0);
  expect(rect!.x + rect!.width).toBeLessThanOrEqual(390);
  await page.screenshot({ path: 'visual/report/tabs-phone.png' });
});

test('House uses labelled item cards and an Actions sheet that opens the selected form', async ({ page }) => {
  await mount(page, 'stock', 'StockView');
  await page.evaluate(`view.rows=async()=>Array.from({length:25},(_,i)=>({product:{id:'p'+i,name:'Stock item '+i},qty:15,storeQty:0,reservedQty:0}));view.refreshStatus='';view.bindImport=()=>{};view.bindNewItem=()=>{};view.render();`);
  await expect(page.locator('#stk-body tr')).toHaveCount(25);
  await expect(page.locator('.stock-balances thead')).toBeHidden();
  await expect(page.locator('#stk-body tr').first().locator('[data-label="In House"]')).toBeVisible();
  await page.getByRole('button', { name: 'Stock actions', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Stock actions' })).toBeVisible();
  await page.locator('[data-stock-panel=entry]').click();
  await expect(page.getByRole('dialog', { name: 'Stock actions' })).toHaveCount(0);
  await expect(page.locator('#stk-entry-panel')).toBeVisible();
  await page.locator('#stk-product-search').fill('Stock item');
  await page.locator('#stk-search').fill('item 24');
  await expect(page.locator('#stk-body tr')).toHaveCount(1);
  await expect(page.locator('#stk-body')).toContainText('Stock item 24');
  await expect(page.locator('#stk-refresh-status')).toBeHidden();
  await page.locator('#stk-search').fill('');
  await page.evaluate(`document.querySelector('.app-main-content').scrollTop=0`);
  await page.screenshot({ path: 'visual/report/house-phone.png' });
});
