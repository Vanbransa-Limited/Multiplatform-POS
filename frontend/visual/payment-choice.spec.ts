import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

async function setup(page: import('@playwright/test').Page, file: string, className: string) {
  await page.setContent('<meta name="viewport" content="width=device-width, initial-scale=1"><main class="app-main-content"><section id="host" class="tab-view active"></section></main>');
  await page.addStyleTag({ content: readFileSync('src/ui/styles.css', 'utf8') + readFileSync('src/ui/mobile.css', 'utf8') });
  const source = readFileSync(`src/ui/${file}.js`, 'utf8')
    .replace(/^import[\s\S]*?;\r?\n/gm, '')
    .replace('export function getCanonicalCategoryName', 'function getCanonicalCategoryName')
    .replace(`export class ${className}`, `window.Screen = class ${className}`);
  const filters = readFileSync('src/ui/mobile-filters.js', 'utf8').replace('export function', 'function');
  await page.addScriptTag({ content: `
    const state = { currentUser:{role:'Owner'}, currentBranch:{id:'b1'}, currentTenant:{id:'t1'} };
    const MpesaService = class {};
    const cashIsEnabled = () => true;
    const tenantStorage = {getItem:()=>null};
    const unavailableMpesaCapability = () => ({available:false,status:'unconfigured',message:'Unavailable'});
    const WALK_IN_CUSTOMER_ID = 'cust-walkin';
    const showNotification = () => {};
    const escapeHtml = value => String(value ?? '');
    const db = {};
    let sequence = 0;
    crypto.randomUUID ||= () => 'payment-test-' + (++sequence);
    ${filters}
    ${source}
    window.view = new window.Screen(document.querySelector('#host'));
  ` });
}

test('cart button toggles the sale; tab checkout waits for a tender and reveals only its fields', async ({ page }) => {
  await setup(page, 'till', 'TillView');
  await page.evaluate(`view.selectedCustomer={id:'cust-walkin',phone:'0712345678'}; view.activeTabId='existing-tab'; view.totals={total:500}; view.refreshMpesaCapability=async()=>{}; view.render();`);
  await page.getByRole('button', { name: /^View cart/ }).click();
  await expect(page.locator('#till-cart-toggle')).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('.till-cart-col')).toBeVisible();
  await page.getByRole('button', { name: /^Hide cart/ }).click();
  await expect(page.locator('.till-cart-col')).toBeHidden();
  await page.getByRole('button', { name: /^View cart/ }).click();
  await page.evaluate('view.openCheckoutModal()');
  await expect(page.locator('#payment-modal')).toBeVisible();
  await expect(page.locator('#pay-confirm-btn')).toBeDisabled();
  for (const id of ['cash', 'mpesa', 'mpesa-code', 'card', 'credit', 'proforma']) await expect(page.locator(`#payment-inputs-${id}`)).toBeHidden();
  await page.locator('[data-method=MPESA_CODE]').click();
  await expect(page.locator('#pay-mpesa-code')).toBeVisible();
  await expect(page.locator('#pay-mpesa-phone')).toBeHidden();
  await expect(page.locator('#pay-cash-tendered')).toBeHidden();
  await page.locator('[data-method=CARD]').focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#pay-card-reference')).toBeVisible();
  await expect(page.locator('#pay-mpesa-code')).toBeHidden();
  await page.locator('[data-method=CASH]').click();
  await expect(page.locator('#pay-cash-tendered')).toHaveValue('500');
  await expect(page.locator('#pay-card-reference')).toBeHidden();
  await expect(page.locator('#pay-confirm-btn')).toBeEnabled();
});

test('Orders tab settlement shows no inputs until a method is picked and resets on reopen', async ({ page }) => {
  await setup(page, 'orders', 'OrdersView');
  await page.evaluate(`view.render(); view.bindEvents(); view.posOrders=[{id:'sale1',ref:'TAB-9',customerName:'Walk-In',customerPhone:'0712345678',dueMinor:50000}]; view.openSettleModal('sale1');`);
  await expect(page.locator('#settle-confirm')).toBeDisabled();
  await expect(page.locator('#settle-phone')).toBeHidden();
  await expect(page.locator('#settle-reference')).toBeHidden();
  await page.locator('[data-settle-method=mpesa]').click();
  await expect(page.locator('#settle-reference')).toBeVisible();
  await expect(page.locator('label[for=settle-reference]')).toHaveText('M-Pesa confirmation code');
  await expect(page.locator('#settle-phone')).toBeHidden();
  await page.locator('[data-settle-method=cash]').click();
  await expect(page.locator('#settle-reference')).toBeHidden();
  await expect(page.locator('#settle-note')).toBeVisible();
  await page.locator('[data-settle-method=stk]').click();
  await expect(page.locator('#settle-phone')).toHaveValue('0712345678');
  await expect(page.locator('#settle-reference')).toBeHidden();
  await page.locator('#settle-close').click();
  await page.evaluate(`view.openSettleModal('sale1')`);
  await expect(page.locator('#settle-confirm')).toBeDisabled();
  await expect(page.locator('#settle-phone')).toBeHidden();
});
