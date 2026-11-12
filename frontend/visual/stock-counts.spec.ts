import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

async function mount(page: any) {
  await page.goto('/till/');
  await page.evaluate(() => { document.body.innerHTML = '<div id="inventory-pane-content"></div>'; });
  await page.addStyleTag({ content: readFileSync('src/ui/styles.css', 'utf8') + readFileSync('src/ui/mobile.css', 'utf8') });
  await page.addScriptTag({ content: readFileSync('node_modules/dexie/dist/dexie.js', 'utf8') });
  const service = readFileSync('src/services/stock-counts.js', 'utf8').replace('export async function', 'async function');
  const view = readFileSync('src/ui/inventory.js', 'utf8').replace(/^import[\s\S]*?;\r?\n/gm, '').replace('export class InventoryView', 'class InventoryView');
  await page.addScriptTag({ content: `
    const db = new Dexie('count-regression-' + Date.now());
    db.version(1).stores({stock_takes:'id,branch_id',stock_take_lines:'id,stock_take_id,product_id',stock_balances:'id,productId',products:'id,is_service'});
    const state = {currentBranch:{id:'b1'},currentUser:{id:'staff1',role:'Owner'}};
    const escapeHtml = value => String(value??'').replaceAll('&','&amp;').replaceAll('"','&quot;').replaceAll('<','&lt;');
    const notifications=[];const showNotification=(message,tone)=>notifications.push({message,tone});
    const stockLocations=()=>['HOUSE'];
    const stockCalls=[];const importStock=async payload=>{stockCalls.push(payload);if(window.failStockPost)throw new Error('Connection unavailable');return {rejected:[]};};
    ${service}
    ${view}
    window.countDb=db;window.notifications=notifications;window.stockCalls=stockCalls;
    window.countView=new InventoryView(document.querySelector('#inventory-pane-content'));
    countView.loadSubTab=async()=>{};
    window.ready=(async()=>{
      await db.stock_takes.put({id:'t1',branch_id:'b1',location:'HOUSE',status:'DRAFT'});
      await db.products.put({id:'p1',name:'Wine',sku:'W1',is_service:0});
      await db.stock_balances.bulkPut([
        {id:'house',productId:'p1',branchId:'b1',location:'HOUSE',qty:7,reservedQty:2},
        {id:'store',productId:'p1',branchId:'b1',location:'STORE',qty:10},
        {id:'other',productId:'p1',branchId:'b2',location:'HOUSE',qty:99}
      ]);
      await countView.openCountSheetModal('t1');
    })();
  ` });
  await page.evaluate('window.ready');
}

test('Save Counts commits with real IndexedDB, isolates the room, accepts zero and restores saved values', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await mount(page);
  const inputBounds = await page.getByLabel('Count for Wine').boundingBox();
  expect(inputBounds!.x).toBeGreaterThanOrEqual(0);
  expect(inputBounds!.x + inputBounds!.width).toBeLessThanOrEqual(360);
  await page.getByLabel('Count for Wine').fill('5');
  await page.getByRole('button', { name: 'Save Counts', exact: true }).click();
  await expect(page.locator('.variance-result')).toHaveText('-2');
  expect(await page.evaluate('countDb.stock_take_lines.toArray()')).toMatchObject([{ counted_qty: 5, expected_qty: 7, variance_qty: -2 }]);
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await page.evaluate("countView.openCountSheetModal('t1')");
  await expect(page.getByLabel('Count for Wine')).toHaveValue('5');
  await page.getByLabel('Count for Wine').fill('0');
  await page.getByRole('button', { name: 'Save Counts', exact: true }).click();
  await expect(page.locator('.variance-result')).toHaveText('-7');
  expect(await page.evaluate('countDb.stock_take_lines.toArray()')).toHaveLength(1);
  expect(await page.evaluate('countDb.stock_take_lines.toArray()')).toMatchObject([{ counted_qty: 0 }]);
  expect(await page.evaluate('countDb.stock_balances.get("house")')).toMatchObject({ qty: 7 });
});

test('count approval posts server stock, keeps failed submissions draft and can retry', async ({ page }) => {
  await mount(page);
  await page.getByLabel('Count for Wine').fill('3');
  await page.getByRole('button', { name: 'Save Counts', exact: true }).click();
  await expect(page.locator('.variance-result')).toHaveText('-4');
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await page.evaluate(`window.failStockPost=true;countView.renderTakes(document.querySelector('#inventory-pane-content'))`);
  await page.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect.poll(() => page.evaluate('notifications.at(-1)?.message')).toBe('Connection unavailable');
  expect(await page.evaluate('countDb.stock_takes.get("t1")')).toMatchObject({ status: 'DRAFT' });
  await page.evaluate('window.failStockPost=false');
  await page.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect.poll(() => page.evaluate('countDb.stock_takes.get("t1").then(take=>take.status)')).toBe('COMPLETED');
  expect(await page.evaluate('stockCalls[1]')).toMatchObject({ mode: 'count', branchId: 'b1', location: 'HOUSE', rows: [{ productId: 'p1', sku: 'W1', qty: 3 }] });
  expect(await page.evaluate('stockCalls[0].batchId===stockCalls[1].batchId')).toBe(true);
});

test('invalid, empty and closed counts show an error and keep the form usable', async ({ page }) => {
  await mount(page);
  for (const value of ['', '-1', '1.5']) {
    await page.getByLabel('Count for Wine').fill(value);
    await page.getByRole('button', { name: 'Save Counts', exact: true }).click();
    await expect.poll(() => page.evaluate('notifications.at(-1)?.tone')).toBe('error');
    await expect(page.locator('#save-count-sheet')).toBeEnabled();
    expect(await page.evaluate('countDb.stock_take_lines.count()')).toBe(0);
  }
  await page.evaluate('countDb.stock_takes.update("t1",{status:"COMPLETED"})');
  await page.getByLabel('Count for Wine').fill('4');
  await page.getByRole('button', { name: 'Save Counts', exact: true }).click();
  await expect.poll(() => page.evaluate('notifications.at(-1)?.message')).toContain('closed');
  expect(await page.evaluate('countDb.stock_take_lines.count()')).toBe(0);
});

