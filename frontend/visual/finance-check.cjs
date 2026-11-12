const { chromium, expect } = require('@playwright/test');
const { readFileSync } = require('node:fs');
const path = require('node:path');
(async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ timezoneId: 'Africa/Nairobi', viewport: { width: 1500, height: 900 } });
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.route('https://finance.test/**', route => {
      const pathname = new URL(route.request().url()).pathname;
      let body;
      if (pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<div id="app"></div><script type="module">import { FinanceView } from "/ui/finance.js"; window.view = new FinanceView(document.getElementById("app")); await window.view.load(); window.ready = true;</script>' });
      if (pathname === '/db/schema.js') body = 'export const db = Object.fromEntries(["sales","payments","users","shifts"].map(name => [name,{toArray:async()=>[]}]));';
      else if (pathname === '/context.js') body = 'export const showNotification = () => {};';
      else if (pathname === '/services/firebase.js') body = `
        export const currentClaims = async () => ({tenant_id:'signed-in-tenant',staff_role:'owner'});
        const rows = [880,200,250,400,550,1000].map((amount,i)=>({id:'receipt'+i,tenantId:'signed-in-tenant',receipt:'receipt'+i,status:'paid',amountMinor:amount*100,requestedAt:i<4?'2026-09-09T10:00:00Z':'2026-09-08T18:00:00Z'}));
        rows.push({id:'failed',tenantId:'signed-in-tenant',status:'failed',amountMinor:88000,requestedAt:'2026-09-09T10:00:00Z'});
        rows.push({id:'pending',tenantId:'signed-in-tenant',status:'pending',amountMinor:30000,orderReference:'ORDER-42',requestedAt:'2026-09-09T10:00:00Z'});
        export const getFirebase = async () => ({firestore:{collection:(_,name)=>name,where:(...args)=>args,query:(name,...filters)=>({name,filters}),
          doc:(_,name,id)=>({name,id}),
          getDoc:async ref=>({data:()=>(ref.name==='tenant_settings'?{dayStartHour:5,nightStartHour:17}:undefined)}),
          getDocsFromServer:async q=>{
          if(q.filters[0][2]!=='signed-in-tenant') throw new Error('Wrong tenant');
          if(window.failSales && q.name==='sales') throw new Error('Unavailable');
          const orders = [{id:'unpaid-order',tenantId:'signed-in-tenant',branchId:'branch-2',ref:'WEB-42',customerName:'Akinyi',totalMinor:30000,paymentStatus:'unpaid',status:'received',createdAt:'2026-09-09T10:00:00Z'}];
          const selected = q.name==='mpesa_payments' ? rows : q.name==='customer_orders' ? orders : [];
          return {docs:selected.map(row=>({id:row.id,data:()=>row}))};
        }}});`;
      else body = readFileSync(path.join(__dirname, '..', 'src', pathname), 'utf8');
      return route.fulfill({ contentType: 'application/javascript', body });
    });
    await page.goto('https://finance.test/');
    await page.waitForFunction(() => window.ready);
    await page.locator('#fin-start').fill('2026-09-08');
    await page.locator('#fin-end').fill('2026-09-09');
    await page.locator('#fin-load-btn').click();
    await expect(page.locator('#fin-collected')).toHaveText('KES 3,280.00');
    await expect(page.locator('#fin-mpesa')).toHaveText('KES 3,280.00');
    await expect(page.locator('#fin-count')).toHaveText('0');
    await expect(page.locator('#fin-payment-count')).toHaveText('6');
    await expect(page.locator('#fin-unmatched')).toHaveText('KES 3,280.00');
    await expect(page.locator('#fin-failed')).toHaveText('KES 880.00');
    await expect(page.locator('#fin-pending')).toHaveText('KES 300.00');
    await expect(page.locator('#fin-pending-count')).toHaveText('1 order · unreceived');
    await expect(page.locator('#fin-unpaid')).toHaveText('KES 300.00');
    await expect(page.locator('#fin-unpaid-orders')).toContainText('WEB-42');
    await expect(page.locator('#fin-unpaid-orders .fin-reconcile')).toHaveAttribute('href', '/orders?order=WEB-42');
    await expect(page.locator('#fin-transactions tbody tr')).toHaveCount(8);
    await expect(page.locator('#fin-transactions')).toContainText('PENDING / UNPAID');
    await expect(page.locator('#fin-transactions')).toContainText('ORDER-42');
    await page.locator('#ai-inp').fill('payments');
    await page.locator('#ai-send').click();
    await expect(page.locator('#ai-msgs .ai-bubble').last()).toContainText('3,280.00');
    await page.locator('#fin-start').fill('2026-09-09');
    await page.locator('#fin-load-btn').click();
    await expect(page.locator('#fin-collected')).toHaveText('KES 1,730.00');
    await expect(page.locator('#ai-msgs .ai-bubble').last()).toContainText('1,730.00');
    await page.locator('[data-fin-range="yesterday"]').click();
    await expect(page.locator('[data-fin-range="yesterday"]')).toHaveClass(/active/);
    await expect(page.locator('#fin-start')).toHaveValue(await page.locator('#fin-end').inputValue());
    await page.locator('#fin-start').fill('2026-09-09');
    await page.locator('#fin-end').fill('2026-09-09');
    await page.evaluate(() => { window.failSales = true; });
    await page.locator('#fin-load-btn').click();
    await expect(page.locator('#fin-source')).toContainText('Incomplete report');
    await expect(page.locator('#fin-collected')).toHaveText('KES 1,730.00');
    if(errors.length) throw new Error(errors.join('\n'));
    console.log('Finance browser check passed: provider-only receipts, date changes, AI, failed attempts and partial refresh.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode=1; });
