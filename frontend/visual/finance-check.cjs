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
      let pathname = new URL(route.request().url()).pathname;
      if (pathname === '/favicon.ico') return route.fulfill({ status: 204, body: '' });
      if (pathname !== '/' && !path.extname(pathname)) pathname += '.js';
      let body;
      if (pathname === '/') return route.fulfill({ contentType: 'text/html', body: `<meta name="viewport" content="width=device-width,initial-scale=1"><style>${readFileSync(path.join(__dirname, '../src/ui/styles.css'), 'utf8')}\n${readFileSync(path.join(__dirname, '../src/ui/mobile.css'), 'utf8')}</style><main class="app-main-content"><section id="app" class="tab-view active"></section></main><script type="module">import { FinanceView } from "/ui/finance.js"; window.view = new FinanceView(document.getElementById("app")); await window.view.load(); window.ready = true;</script>` });
      if (pathname === '/db/schema.js') body = 'export const db = Object.fromEntries(["sales","payments","users","shifts"].map(name => [name,{toArray:async()=>[],where:()=>({equals:()=>({toArray:async()=>[]}),anyOf:()=>({toArray:async()=>[]})})}]));';
      else if (pathname === '/context.js') body = 'export const showNotification = () => {};';
      else if (pathname === '/services/print-receipt.js') body = `export const escapeHtml=value=>String(value??'').replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));`;
      else if (pathname === '/services/firebase.js') body = `
        export const currentClaims = async () => ({tenant_id:'signed-in-tenant',staff_role:'owner'});
        export const callFunction = async () => { throw Error('This read-only test must not record a payment.'); };
        const rows = [880,200,250,400,550,1000].map((amount,i)=>({id:'receipt'+i,tenantId:'signed-in-tenant',receipt:'receipt'+i,status:'paid',amountMinor:amount*100,requestedAt:i<4?'2026-09-09T10:00:00Z':'2026-09-08T18:00:00Z'}));
        rows.push({id:'failed',tenantId:'signed-in-tenant',status:'failed',amountMinor:88000,requestedAt:'2026-09-09T10:00:00Z'});
        rows.push({id:'pending',tenantId:'signed-in-tenant',status:'pending',amountMinor:30000,orderReference:'ORDER-42',requestedAt:'2026-09-09T10:00:00Z'});
        export const getFirebase = async () => ({firestore:{collection:(_,name)=>name,where:(...args)=>args,query:(name,...filters)=>({name,filters}),
          doc:(_,name,id)=>({name,id}),
          getDoc:async ref=>({exists:()=>true,data:()=>(ref.name==='tenant_settings'?{dayStartHour:5,nightStartHour:17}:undefined)}),
          onSnapshot:(q,callback)=>{window.invoiceWatchCount=(window.invoiceWatchCount||0)+1;callback({docs:[]});return()=>{window.invoiceWatchStops=(window.invoiceWatchStops||0)+1;};},
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
    await expect(page.getByRole('tab', { name: 'Overview', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('tabpanel')).toHaveCount(1);
    await expect(page.locator('.finance-right')).toBeHidden();
    await expect(page.locator('#fin-transactions')).toBeHidden();
    expect(await page.evaluate(() => window.invoiceWatchCount || 0)).toBe(0);
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
    await expect(page.locator('#fin-transactions')).toContainText('NO CONFIRMATION');
    await expect(page.locator('#fin-transactions')).toContainText('ORDER-42');
    await page.getByRole('tab', { name: 'Payments', exact: true }).click();
    await expect(page.locator('#fin-transactions')).toBeVisible();
    await expect(page.locator('#fin-collected')).toBeHidden();
    await page.getByRole('tab', { name: 'AI assistant', exact: true }).click();
    await page.locator('#ai-inp').fill('payments');
    await page.locator('#ai-send').click();
    await expect(page.locator('#ai-msgs .ai-bubble').last()).toContainText('3,280.00');
    await expect(page.locator('.fin-toolbar')).toBeHidden();
    await expect(page.locator('.fin-coverage')).toBeHidden();
    await page.getByRole('tab', { name: 'Overview', exact: true }).click();
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
    await expect(page.locator('.fin-coverage')).toHaveAttribute('open', '');
    await expect(page.locator('#fin-source-summary')).toContainText('Some records could not be refreshed');
    await page.evaluate(() => { window.failSales = false; });
    await page.locator('#fin-load-btn').click();
    await expect(page.locator('#fin-source-summary')).toHaveText('Report up to date');
    await expect(page.locator('#ai-report-context')).toHaveCount(1);

    // Tabs retain the report, support keyboard/back navigation, and load invoices once.
    await page.getByRole('tab', { name: 'Overview', exact: true }).click();
    await page.getByRole('tab', { name: 'Overview', exact: true }).focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('tab', { name: 'Payments', exact: true })).toBeFocused();
    await expect(page.getByRole('tab', { name: 'Payments', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(page).toHaveURL(/#payments$/);
    await page.keyboard.press('End');
    await expect(page.getByRole('tab', { name: 'AI assistant', exact: true })).toBeFocused();
    await page.evaluate(() => history.back());
    await expect(page.getByRole('tab', { name: 'Payments', exact: true })).toHaveAttribute('aria-selected', 'true');
    await page.getByRole('tab', { name: 'Invoices', exact: true }).click();
    await expect(page.locator('.fin-toolbar')).toBeHidden();
    await expect(page.locator('[data-pf-search]')).toBeVisible();
    await page.locator('[data-pf-search]').fill('Retained search');
    await page.getByRole('tab', { name: 'Overview', exact: true }).click();
    await page.getByRole('tab', { name: 'Invoices', exact: true }).click();
    await expect(page.locator('[data-pf-search]')).toHaveValue('Retained search');
    expect(await page.evaluate(() => window.invoiceWatchCount)).toBe(1);

    for (const width of [1500, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      for (const [section, label] of [['overview','Overview'],['payments','Payments'],['sales','Sales & staff'],['unpaid','Unpaid orders'],['invoices','Invoices'],['ai','AI assistant']]) {
        await page.getByRole('tab', { name: label, exact: true }).click();
        await expect(page.getByRole('tabpanel')).toHaveCount(1);
        await expect(page.locator(`#fin-panel-${section}`)).toBeVisible();
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
        expect(overflow, `${section} overflows at ${width}px`).toBe(false);
        if (section === 'ai') {
          await expect(page.locator('.fin-toolbar')).toBeHidden();
          await expect(page.locator('.fin-coverage')).toBeHidden();
          await page.locator('#ai-inp').scrollIntoViewIfNeeded();
          await expect(page.locator('#ai-send')).toBeInViewport();
          await page.getByRole('tab', { name: label, exact: true }).scrollIntoViewIfNeeded();
        }
        await page.screenshot({ path: path.resolve(__dirname, `../../tmp/finance-${section}-${width}.png`), fullPage: true });
      }
    }
    // The phone filter sheet moves the original date controls without losing values.
    await page.getByRole('tab', { name: 'Overview', exact: true }).click();
    const originalStart = await page.locator('#fin-start').inputValue();
    await page.getByRole('button', { name: /Report filters/ }).click();
    await expect(page.locator('#fin-start')).toBeVisible();
    await expect(page.locator('#fin-start')).toHaveValue(originalStart);
    await page.getByRole('button', { name: 'Show results', exact: true }).click();
    await expect(page.locator('.mobile-filter-sheet')).not.toBeVisible();
    await page.evaluate(() => window.view.dispose());
    expect(await page.evaluate(() => window.invoiceWatchStops)).toBe(1);
    if(errors.length) throw new Error(errors.join('\n'));
    console.log('Finance browser check passed: unchanged report totals, six focused panels, keyboard/back navigation, lazy invoices, AI, incomplete-report warnings and phone/desktop layouts.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode=1; });
