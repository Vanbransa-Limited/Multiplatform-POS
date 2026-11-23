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
  const receiptLookup = readFileSync('src/services/receipt-lookup.js', 'utf8').replace('export function', 'function');
  const receiptMessages = readFileSync('src/ui/receipt-messages.js', 'utf8').replace(/^export /gm, '');
  await page.addScriptTag({ content: `
    const state = { currentUser:{role:'Owner'}, currentBranch:{id:'b1'}, currentTenant:{id:'t1'} };
    const MpesaService = class {};
    const cashIsEnabled = () => true;
    const tenantStorage = {getItem:()=>null};
    const unavailableMpesaCapability = () => ({available:false,status:'unconfigured',message:'Unavailable'});
    const WALK_IN_CUSTOMER_ID = 'cust-walkin';
    const showNotification = () => {};
    ${receiptLookup}
    ${receiptMessages}
    const lookupMpesaReceipt = createReceiptLookup(input => window.receiptLookup(input), () => JSON.stringify([state.currentTenant?.id,state.currentUser?.id]));
    const mpesaConfirmationCode = value => /^[A-Z0-9]{10}$/.test(String(value).trim().toUpperCase()) ? String(value).trim().toUpperCase() : null;
    const toMinor = value => Math.round(value * 100);
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

for (const width of [390, 1440]) {
  test(`Orders receipt lookup shows 1700 less 500 and rejects unknown codes at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await setup(page, 'orders', 'OrdersView');
    await page.evaluate(`
      view.render(); view.bindEvents();
      view.posOrders=[{id:'sale1',ref:'ORD-55-861692',customerName:'Walk-In',cashierName:'Linda',dueMinor:120000}];
      view.openSettleModal('sale1');
      window.receiptLookup=async ({reference})=>{
        if(reference==='UNKNOWN123') throw new Error('No confirmed M-Pesa payment with that code has reached this business.');
        return {reference,receivedMinor:170000,allocatedMinor:50000,availableMinor:120000,verified:true};
      };
    `);
    await page.locator('[data-settle-method=mpesa]').click();
    await expect(page.locator('#settle-confirm')).toBeDisabled();
    await page.locator('#settle-reference').fill('UKL6537WE3');
    await page.locator('#settle-check-code').click();
    await expect(page.locator('#settle-receipt-balance')).toHaveText('Amount: KES 1700.00. Available: KES 1200.00.');
    await expect(page.locator('#settle-confirm')).toHaveText('Apply KES 1200.00');
    await expect(page.locator('#settle-confirm')).toBeEnabled();
    await page.locator('#settle-modal').screenshot({ path: `../tmp/receipt-checkout-${width}.png` });
    await page.locator('#settle-reference').fill('UNKNOWN123');
    await expect(page.locator('#settle-confirm')).toBeDisabled();
    await page.locator('#settle-check-code').click();
    await expect(page.locator('#settle-receipt-balance')).toHaveText('Payment not found. Check the code and try again.');
    await expect(page.locator('#settle-confirm')).toBeDisabled();
  });
}

test('receipt responses arriving after a changed code cannot enable payment', async ({ page }) => {
  await setup(page, 'orders', 'OrdersView');
  await page.evaluate(`view.render();view.bindEvents();view.posOrders=[{id:'sale1',ref:'BILL',customerName:'Guest',dueMinor:100000}];view.openSettleModal('sale1');window.receiptLookup=()=>new Promise(resolve=>window.resolveReceipt=resolve);`);
  await page.locator('[data-settle-method=mpesa]').click();
  await page.locator('#settle-reference').fill('CODE400ABC');
  await page.locator('#settle-check-code').click();
  await page.locator('#settle-reference').fill('CODE600ABC');
  await page.evaluate(`resolveReceipt({reference:'CODE400ABC',receivedMinor:40000,allocatedMinor:0,availableMinor:40000,verified:true})`);
  await expect(page.locator('#settle-confirm')).toBeDisabled();
  await expect(page.locator('#settle-receipt-balance')).toBeHidden();
});

for (const screen of ['orders', 'till']) {
  test(`${screen} exits a stuck receipt check, ignores the late response and allows retry`, async ({ page }) => {
    await setup(page, screen, screen === 'orders' ? 'OrdersView' : 'TillView');
    await page.clock.install();
    if (screen === 'orders') {
      await page.evaluate(`view.render();view.bindEvents();view.posOrders=[{id:'sale1',ref:'BILL',customerName:'Guest',dueMinor:100000}];view.openSettleModal('sale1');`);
      await page.locator('[data-settle-method=mpesa]').click();
    } else {
      await page.evaluate(`view.selectedCustomer={id:'guest'};view.activeTabId='tab';view.totals={total:1000};view.render();view.refreshMpesaCapability=async()=>{};view.openCheckoutModal();`);
      await page.locator('[data-method=MPESA_CODE]').click();
    }
    const input = page.locator(screen === 'orders' ? '#settle-reference' : '#pay-mpesa-code');
    const check = page.locator(screen === 'orders' ? '#settle-check-code' : '#pay-check-mpesa-code');
    const summary = page.locator(screen === 'orders' ? '#settle-receipt-balance' : '#pay-receipt-balance');
    const confirm = page.locator(screen === 'orders' ? '#settle-confirm' : '#pay-confirm-btn');
    await page.evaluate(`window.receiptLookup=()=>new Promise(resolve=>window.resolveStuckReceipt=resolve);`);
    await input.fill('CODE400ABC');
    if (screen === 'orders') await check.click();
    else await page.evaluate('void view.checkTillReceipt()');
    await expect(check).toBeDisabled();
    await page.clock.fastForward(12001);
    await expect(summary).toHaveText('Could not check payment. Try again.');
    await expect(check).toBeEnabled();
    await expect(confirm).toBeDisabled();
    await page.evaluate(`resolveStuckReceipt({reference:'CODE400ABC',receivedMinor:40000,allocatedMinor:0,availableMinor:40000,verified:true});`);
    await expect(confirm).toBeDisabled();
    await expect(summary).toHaveText('Could not check payment. Try again.');
    await page.evaluate(`window.receiptLookup=async({reference})=>({reference,receivedMinor:40000,allocatedMinor:0,availableMinor:40000,verified:true});`);
    if (screen === 'orders') await check.click();
    else await page.evaluate('view.checkTillReceipt()');
    await expect(summary).toContainText('Available: KES 400.00');
    await expect(confirm).toBeEnabled();
  });
}

test('Till checks the receipt before enabling partial payment', async ({ page }) => {
  await setup(page, 'till', 'TillView');
  await page.evaluate(`view.selectedCustomer={id:'guest'};view.activeTabId='tab';view.totals={total:1000};view.render();view.refreshMpesaCapability=async()=>{};view.openCheckoutModal();window.receiptLookup=async({reference})=>({reference,receivedMinor:40000,allocatedMinor:0,availableMinor:40000,verified:true});`);
  await page.locator('[data-method=MPESA_CODE]').click();
  await expect(page.locator('#pay-confirm-btn')).toBeDisabled();
  await page.locator('#pay-mpesa-code').fill('CODE400ABC');
  // The rendering harness binds only controls used by its tests.
  await page.evaluate('view.checkTillReceipt()');
  await expect(page.locator('#pay-receipt-balance')).toContainText('Available: KES 400.00');
  await expect(page.locator('#pay-confirm-btn')).toHaveText('Apply KES 400.00');
  await expect(page.locator('#pay-confirm-btn')).toBeEnabled();
});

for (const [screen, width] of [['orders', 390], ['orders', 1440], ['till', 390], ['till', 1440]] as const) {
  test(`${screen} loads a saved internal amount by code without amount entry at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    await setup(page, screen, screen === 'orders' ? 'OrdersView' : 'TillView');
    if (screen === 'orders') {
      await page.evaluate(`view.render();view.bindEvents();view.posOrders=[{id:'sale1',ref:'ORD-6-023885',customerName:'Guest',cashierName:'Kester',dueMinor:95000}];view.openSettleModal('sale1');`);
      await page.locator('[data-settle-method=mpesa]').click();
    } else {
      await page.evaluate(`view.selectedCustomer={id:'guest'};view.activeTabId='tab';view.totals={total:950};view.render();view.refreshMpesaCapability=async()=>{};view.openCheckoutModal();`);
      await page.locator('[data-method=MPESA_CODE]').click();
    }
    const code = page.locator(screen === 'orders' ? '#settle-reference' : '#pay-mpesa-code');
    const amount = page.locator(screen === 'orders' ? '#settle-receipt-amount' : '#pay-receipt-amount');
    await expect(amount).toHaveCount(0);
    const confirm = page.locator(screen === 'orders' ? '#settle-confirm' : '#pay-confirm-btn');
    const summary = page.locator(screen === 'orders' ? '#settle-receipt-balance' : '#pay-receipt-balance');
    await page.evaluate(`window.receiptLookup=async input=>{
      window.checkedInternalInput=input;
      if(input.reference==='EXISTING01')return {reference:input.reference,receivedMinor:50000,allocatedMinor:50000,availableMinor:0,verified:false,internalOnly:true};
      if(input.reference==='UNKNOWN123')throw new Error('No saved M-Pesa payment matches this code.');
      return {reference:input.reference,receivedMinor:170000,allocatedMinor:50000,availableMinor:120000,verified:false,internalOnly:true,registerOnPayment:false};
    };`);
    await code.fill('UNKNOWN123');
    if (screen === 'orders') await page.locator('#settle-check-code').click();
    else await page.evaluate('view.checkTillReceipt()');
    await expect(summary).toHaveText('Payment not found. Check the code and try again.');
    await expect(confirm).toBeDisabled();
    await code.fill('UKL6537WE3');
    if (screen === 'orders') await page.locator('#settle-check-code').click();
    else await page.evaluate('view.checkTillReceipt()');
    await expect(summary).toHaveText('Amount: KES 1700.00. Available: KES 1200.00.');
    await expect(confirm).toHaveText('Apply KES 950.00');
    await expect(confirm).toBeEnabled();
    await confirm.scrollIntoViewIfNeeded();
    await expect(confirm).toBeInViewport();
    expect(await page.evaluate('window.checkedInternalInput.receiptAmountMinor')).toBeUndefined();
    await page.locator(screen === 'orders' ? '#settle-modal' : '#payment-modal').screenshot({ path: `../tmp/code-only-receipts-${screen}-${width}.png` });
    await code.fill('EXISTING01');
    if (screen === 'orders') await page.locator('#settle-check-code').click();
    else await page.evaluate('view.checkTillReceipt()');
    await expect(summary).toHaveText('This code has already been fully used.');
    await expect(confirm).toBeDisabled();
  });
}

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
