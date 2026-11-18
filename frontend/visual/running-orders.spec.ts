import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

const script = (file: string) => readFileSync(`src/${file}.js`, 'utf8')
  .replace(/^import[\s\S]*?;\r?\n/gm, '').replace(/\bexport /g, '');

for (const width of [1440, 390]) {
  test(`running tables, payment and sorting at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.setContent('<meta name="viewport" content="width=device-width, initial-scale=1"><main class="app-main-content"><section class="tab-view active" id="host"></section></main>');
    await page.addStyleTag({ content: readFileSync('src/ui/styles.css', 'utf8') + readFileSync('src/ui/mobile.css', 'utf8') });
    await page.addScriptTag({ content: `
      const state={currentUser:{role:'Owner'},currentBranch:{id:'b1'}};
      const MpesaService=class{}; const cashIsEnabled=()=>true;
      const isReceivable=m=>['CREDIT','PROFORMA'].includes(m);
      const escapeHtml=v=>String(v??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');
      ${script('services/paginate')}
      ${script('services/customer-orders')}
      ${script('ui/mobile-filters')}
      ${script('ui/orders')}
      window.view=new OrdersView(document.querySelector('#host'));
      view.render();view.bindEvents();
      view.posOrders=[
        {...saleAsOrder({id:'a',branch_id:'b1',table_no:'20',status:'PENDING_PAYMENT',grand_total:520,sold_at:'2026-11-10T18:00:00Z'}),cashierName:'Judith Nandacha'},
        {...saleAsOrder({id:'b',branch_id:'b1',table_no:'2',status:'PENDING_PAYMENT',grand_total:320,sold_at:'2026-11-11T18:00:00Z'}),cashierName:'Kester Muiruri'}
      ];
      view.dateFrom='2026-11-11';view.dateTo='2026-11-11';
      view.renderCustomerBoard();document.querySelector('#customer-orders-status').textContent='';
    ` });
    await expect(page.locator('.co-card')).toHaveCount(2);
    await expect(page.locator('.co-card').first()).toContainText('TABLE 2');
    if (width < 600) await page.getByRole('button', { name: /^Order filters/ }).click();
    await page.locator('#orders-sort').selectOption('staff');
    await expect(page.locator('.co-card').first()).toContainText('Judith Nandacha');
    if (width < 600) await page.getByRole('button', { name: 'Show results', exact: true }).click();
    await page.screenshot({ path: `visual/artifacts/running-orders-${width}.png`, fullPage: true });
    await page.evaluate(`view.posOrders[0]={...view.posOrders[0],status:'completed',paymentStatus:'paid',dueMinor:0};view.renderCustomerBoard();`);
    await expect(page.locator('.co-card')).toHaveCount(1);
    await expect(page.locator('.co-card')).toContainText('Kester');
    await page.evaluate(`view.remoteOpenOrders=[{id:'stale',saleUuids:['settled-round'],paymentStatus:'unpaid'}];view.posOrders[0].saleUuid='settled-round';`);
    expect(await page.evaluate('view.allOrders().some(o=>o.id==="stale")')).toBe(false);
    if (width < 600) await page.getByRole('button', { name: /^Order filters/ }).click();
    await page.getByRole('tab', { name: 'Proforma invoices', exact: true }).click();
    if (width < 600) await page.getByRole('button', { name: 'Show results', exact: true }).click();
    await expect(page.locator('#customer-orders-list')).toBeHidden();
    await expect(page.locator('#customer-orders-stats')).toBeHidden();
    if (width >= 600) await expect(page.locator('#orders-search-toolbar')).toBeHidden();
    await expect(page.locator('#orders-proformas')).toHaveJSProperty('hidden', false);
    if (width < 600) await page.getByRole('button', { name: /^Order filters/ }).click();
    await page.getByRole('tab', { name: 'Running', exact: true }).click();
    if (width < 600) await page.getByRole('button', { name: 'Show results', exact: true }).click();
    await expect(page.locator('#customer-orders-list')).toBeVisible();
  });
}
