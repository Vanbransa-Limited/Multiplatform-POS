import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

const source = (file: string) => readFileSync(file, 'utf8').replace(/^import[\s\S]*?;\r?\n/gm, '').replace(/\bexport /g, '');
async function gate(page: any) {
  await page.setContent('<meta name="viewport" content="width=device-width, initial-scale=1"><main><button id="start">Checkout</button></main>');
  await page.addStyleTag({ content: readFileSync('src/ui/styles.css', 'utf8') + readFileSync('src/ui/mobile.css', 'utf8') });
  await page.addScriptTag({ content: `
    window.calls=[];window.printed=false;window.queued=false;window.paid=0;window.cancelled=0;
    const callFunction=async(name,input)=>{
      calls.push({name,input});
      if(window.fail)throw Error('Printer connection unavailable. Try again.');
      if(input.queue)window.queued=true;
      return {printed:window.printed,queued:window.queued};
    };
    ${source('src/ui/checkout-print.js')}
    document.querySelector('#start').onclick=()=>requirePrintedReceipt({saleUuids:['saved-bill']},{onReady:()=>window.paid++,onCancel:()=>window.cancelled++});
  ` });
  await page.locator('#start').click();
}

for (const width of [390, 1440]) {
  test(`receipt must print before Pay Now unlocks at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await gate(page);
    const modal = page.getByRole('dialog');
    await expect(modal).toBeVisible();
    await expect(page.getByRole('button', { name: 'Pay Now', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: 'Send to printer', exact: true }).click();
    await expect(page.getByRole('status')).toHaveText('Waiting for the counter to print and confirm the receipt.');
    await expect(page.getByRole('button', { name: 'Pay Now', exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Send to printer', exact: true })).toBeDisabled();
    expect(await page.evaluate('paid')).toBe(0);
    await page.screenshot({ path: `../tmp/checkout-print-${width}.png` });
    expect(await page.evaluate('document.documentElement.scrollWidth <= innerWidth')).toBe(true);
    await page.evaluate('window.printed=true');
    await expect(page.getByRole('button', { name: 'Pay Now', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: 'Pay Now', exact: true }).click();
    await expect(modal).toHaveCount(0);
    expect(await page.evaluate('paid')).toBe(1);
  });
}

test('failed status checks keep payment locked and can be retried; Escape leaves the order unpaid', async ({ page }) => {
  await gate(page);
  await page.evaluate('window.fail=true');
  await page.getByRole('button', { name: 'Send to printer', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Printer connection unavailable');
  await expect(page.getByRole('button', { name: 'Pay Now', exact: true })).toBeDisabled();
  await page.evaluate('window.fail=false');
  await page.getByRole('button', { name: 'Send to printer', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Waiting for the counter');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('#start')).toBeFocused();
  expect(await page.evaluate('[paid,cancelled]')).toEqual([0, 1]);
});

test('an already printed bill still needs a deliberate Pay Now and the gate cannot be doubled', async ({ page }) => {
  await gate(page);
  await page.evaluate(`window.printed=true;requirePrintedReceipt({saleUuids:['other']},{onReady:()=>window.paid++})`);
  await expect(page.getByRole('dialog')).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Pay Now', exact: true })).toBeEnabled();
  expect(await page.evaluate('paid')).toBe(0);
});

test('the till freezes checkout while saving, and only opens tender after printing', async ({ page }) => {
  await gate(page);
  await page.keyboard.press('Escape');
  await page.addScriptTag({ content: `
    const MpesaService=class{};const db={};const firebaseConfigured=true;
    const state={syncManager:{publishSale:async()=>({sale_uuid:'saved-bill'})}};
    ${source('src/ui/till.js')}
    window.view=Object.create(TillView.prototype);
    Object.assign(view,{container:document.querySelector('main'),cart:[{}],registerPendingOrder:()=>new Promise(resolve=>window.finishSaving=()=>{view.pendingSale={saleId:'saved-bill'};resolve(true);}),roundsBeingSettled:async()=>['saved-bill'],openCheckoutModal:()=>window.paid++});
    view.startPrintedCheckout();
  ` });
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Close', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Pay Now', exact: true })).toBeDisabled();
  await page.evaluate('finishSaving()');
  await expect(page.getByRole('button', { name: 'Close', exact: true })).toBeEnabled();
  await page.evaluate('window.printed=true');
  await expect(page.getByRole('button', { name: 'Pay Now', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Pay Now', exact: true }).click();
  expect(await page.evaluate('paid')).toBe(1);
});

for (const confirmed of [false, true]) {
  test(`station ${confirmed ? 'confirms paper' : 'cancels print'} before authorizing payment`, async ({ page }) => {
    await page.setContent('<div id="station"><div id="station-receipt-paper"></div><span id="station-count"></span></div>');
    await page.addScriptTag({ content: `
      const renderReceiptHtml=()=>'<p>Unpaid receipt</p>';
      const showNotification=()=>{};const MAX_ATTEMPTS=3;
      const markJobPrinted=async(...args)=>window.marked.push(args);
      ${source('src/ui/print-station.js').replace('const MAX_ATTEMPTS = 3;', '')}
      window.print=()=>{};window.marked=[];
      window.station=new PrintStationView(document.querySelector('#station'));
      station.log=()=>{};station.renderQueue=()=>{};
    ` });
    page.on('dialog', dialog => confirmed ? dialog.accept() : dialog.dismiss());
    const result = await page.evaluate(`station.printOne({id:'checkout-job',checkoutReceipt:{},receipt:{}})`);
    expect(result).toBe(confirmed);
    expect(await page.evaluate('marked')).toEqual(confirmed ? [['checkout-job', true]] : []);
  });
}
