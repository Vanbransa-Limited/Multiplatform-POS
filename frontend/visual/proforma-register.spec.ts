import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

const script = (file: string) => readFileSync(`src/${file}.js`, 'utf8')
  .replace(/^import[\s\S]*?;\r?\n/gm, '').replace(/\bexport /g, '');

for (const width of [1440, 390]) {
  test(`locked standalone proformas and payment at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.route('**/proforma-register-test', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body></body></html>' }));
    await page.goto('/proforma-register-test');
    await page.setContent('<meta name="viewport" content="width=device-width, initial-scale=1"><main id="host" style="max-width:1000px;margin:24px auto;padding:16px"></main>');
    await page.addStyleTag({ content: readFileSync('src/ui/styles.css', 'utf8') + readFileSync('src/ui/mobile.css', 'utf8') });
    await page.addScriptTag({ content: `
      const esc=v=>String(v??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');
      const timestamp=v=>new Date(v).getTime();
      const fixture={id:'pf-1',createdAt:'2026-11-18T09:00:00Z',paymentStatus:'unpaid',invoice:{
        number:'PF-261118-01',client:{name:'Acme Events'},date:'2026-11-18',dueDate:'2026-11-25',
        subject:'Corporate event catering',lines:[{description:'Catering service for 40 guests',qty:40,unitMinor:150000}],
        dueMinor:6000000,discountMinor:0,terms:'Balance payable before the event.'}};
      let update;let calls=0;
      const watchProformas=async fn=>{update=fn;fn([fixture]);return ()=>{};};
      const payProforma=async input=>{
        calls++;window.paymentInput=input;
        Object.assign(fixture,{paymentStatus:'paid',paidAt:'2026-11-18T12:00:00Z',paymentMethod:input.method,paymentReference:input.reference});
        update([fixture]);return {paymentStatus:'paid'};
      };
      ${script('services/paginate')}
      ${script('ui/proformas')}
      window.register=new ProformaRegister(document.querySelector('#host'));
      register.load();
    ` });
    await expect(page.getByRole('cell', { name: 'PF-261118-01 Acme Events', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'View invoice PF-261118-01' }).click();
    await expect(page.getByRole('heading', { name: 'PF-261118-01 · Acme Events' })).toBeVisible();
    await expect(page.locator('.proforma-detail input')).toHaveCount(1);
    await expect(page.locator('.proforma-detail')).toContainText('Locked on issue');
    await expect(page.locator('.proforma-register')).toContainText('outside Running orders');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: `visual/artifacts/proformas-${width}.png`, fullPage: true });
    await page.getByRole('textbox', { name: 'Payment reference' }).fill('BANK-REF-123');
    await page.getByRole('button', { name: 'Record KES 60,000.00 received', exact: true }).click();
    await expect(page.locator('.proforma-detail')).toContainText('Payment recorded');
    await expect(page.locator('[data-pf-payment]')).toHaveCount(0);
    expect(await page.evaluate('calls')).toBe(1);
    expect(await page.evaluate('window.paymentInput')).toEqual({ proformaId: 'pf-1', method: 'bank_transfer', reference: 'BANK-REF-123' });
    await page.getByRole('combobox', { name: 'Payment status' }).selectOption('unpaid');
    await expect(page.locator('[data-pf-list]')).toContainText('No proforma invoices match this view');
  });
}

test('QR issues a saved immutable document and resets only when preparing another invoice', async ({ page }) => {
  await page.route('**/proforma-compose-test', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body></body></html>' }));
  await page.goto('/proforma-compose-test');
  await page.setContent('<main id="host"></main>');
  await page.addScriptTag({ content: `
    const esc=v=>String(v??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');
    const state={currentUser:{name:'Manager'},currentTenant:{id:'t1',trading_name:'Bransa'},currentBranch:{id:'b1'}};
    const tenantStorage={getItem:()=>null,setItem:()=>{}};
    const db={products:{where:()=>({equals:()=>({toArray:async()=>[]})})}};
    const showNotification=()=>{};
    const proformaTotals=lines=>({dueMinor:lines.reduce((s,l)=>s+l.qty*l.unitMinor,0),vatMinor:0});
    const ProformaRegister=class{async load(){} dispose(){} select(id){window.selectedSaved=id;}};
    const issueProforma=async input=>{window.createdInvoice=structuredClone(input);return {id:'saved-pf',number:input.invoice.number};};
    ${script('ui/qr_export')}
    window.tools=new QrToolsView(document.querySelector('#host'));tools.activeTab='proforma';tools.load();
  ` });
  await page.locator('#pf-client-name').fill('Acme');
  await page.getByRole('button', { name: 'Add a service line' }).click();
  await page.getByRole('textbox', { name: 'Description, line 1', exact: true }).fill('Event service');
  await page.getByRole('spinbutton', { name: 'Unit price, line 1', exact: true }).fill('1500');
  await page.getByRole('button', { name: 'Save & lock invoice', exact: true }).click();
  await expect(page.getByRole('heading', { name: /saved and locked/ })).toBeVisible();
  await expect(page.locator('#pf-client-name')).toHaveCount(0);
  expect(await page.evaluate('window.createdInvoice.invoice.lines')).toEqual([{ description: 'Event service', qty: 1, unitMinor: 150000 }]);
  expect(await page.evaluate('window.selectedSaved')).toBe('saved-pf');
  await page.getByRole('button', { name: 'Prepare another invoice', exact: true }).click();
  await expect(page.locator('#pf-client-name')).toHaveValue('');
  await expect(page.locator('#pf-lines')).toContainText('No items yet');
});
