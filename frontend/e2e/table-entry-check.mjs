// Production till markup, handlers, custom select and IndexedDB in a disposable
// browser. All data is synthetic; no Firebase session or payment transport.
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
const read = file => readFile(new URL(file, import.meta.url), 'utf8');
const strip = source => source.replace(/^import[\s\S]*?;\r?\n/gm, '').replace(/^export /gm, '');
const files = await Promise.all(['../src/ui/till.js', '../src/services/tabs.js', '../src/services/till-draft.js',
  '../src/context.js', '../src/db/schema.js', '../src/ui/mobile-filters.js', '../public/select-control.js',
  '../src/ui/styles.css', '../src/ui/mobile.css', '../src/ui/approval.css', '../public/select-control.css'].map(read));
const [till, tabs, drafts, context, schema, filters, selects, ...styles] = files;
const output = new URL('../../.tmp/table-entry/', import.meta.url);
await mkdir(output, { recursive: true });
const browser = await chromium.launch();
try {
  for (const [name, viewport] of [['desktop', { width: 1366, height: 900 }], ['phone', { width: 390, height: 844 }]]) {
    const browserContext = await browser.newContext({ viewport, hasTouch: name === 'phone' });
    const page = await browserContext.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => route.request().url() === 'http://127.0.0.1:38886/'
      ? route.fulfill({ contentType: 'text/html', body: '<meta name="viewport" content="width=device-width, initial-scale=1"><body class="dark-mode"><main class="app-main-content"><section id="view-till" class="tab-view active"></section></main></body>' })
      : route.abort());
    await page.goto('http://127.0.0.1:38886/');
    await page.addStyleTag({ content: styles.join('\n') });
    await page.addScriptTag({ path: fileURLToPath(new URL('../node_modules/dexie/dist/dexie.js', import.meta.url)) });
    await page.addScriptTag({ content: `
      const cacheName=()=> 'table-entry-test', selectedCacheTenant=()=> 'test';
      const WALK_IN_CUSTOMER_ID='guest', DEVICE_ID='test-device', firebaseConfigured=false;
      const MpesaService=class {}, unavailableMpesaCapability=()=>({}), discountAwaitingCode=()=>false, canSell=()=>true;
      const escapeHtml=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
      ${[context, schema, tabs, drafts, filters, selects].map(strip).join('\n')}
      ${strip(till).replace('class TillView', 'window.TillView = class TillView')}
      Object.assign(state,{currentTenant:{id:'test'},currentBranch:{id:'branch'},currentUser:{id:'hadrine',name:'Hadrine',role:'Cashier'}});
      window.view=new TillView(document.querySelector('#view-till'));
      view.selectedCustomer={id:'guest',name:'Walk-In Customer',price_tier:'RETAIL'};
      view.invalidateMpesaAttempt=()=>{};
      view.recomputeTotals=()=>view.renderTabActions();
      view.totals={total:0};
      view.render();
      document.querySelector('#cart-customer-select').innerHTML='<option value="guest">Walk-In Customer</option><option value="nicole">Nicole</option><option value="brian">Brian</option>';
      view.openTabs=[{id:'tab-5',table:'5',customer_id:'nicole',dueMinor:35000,rounds:[{}],unpaidRounds:[{}]}];
      view.renderOpenTabs();
      installSelectControls(document);
      window.seed=async()=>{await db.customers.bulkPut([{id:'guest',name:'Walk-In Customer',price_tier:'RETAIL'},
        {id:'nicole',name:'Nicole',price_tier:'RETAIL'},{id:'brian',name:'Brian',price_tier:'RETAIL'}]);};
    ` });
    await page.evaluate(() => window.seed());
    if (name === 'phone') await page.locator('#till-cart-toggle').click();
    await page.evaluate(() => { view.addToTab('5'); document.querySelector('#checkout-table-number').value = '5'; });
    await page.waitForFunction(() => view.selectedCustomer.id === 'nicole');
    await page.locator('#till-new-table-btn').click();
    assert.deepEqual(await page.evaluate(() => [view.activeTable, view.activeTabId, view.selectedCustomer.id,
      document.querySelector('#checkout-table-number').value]), [null, null, 'guest', '']);
    const input = page.locator('#till-table-input');
    await input.pressSequentially('1');
    assert.equal(await input.isVisible(), true, 'a preset prefix must not close the entry');
    await page.evaluate(() => view.renderOpenTabs()); // background tab refresh while typing
    assert.equal(await input.inputValue(), '1');
    await input.pressSequentially('2');
    assert.equal(await input.inputValue(), '12');
    assert.equal(await page.evaluate(() => view.activeTable), null, 'typing cannot route a cart to table 1');
    assert.equal(await page.locator('#till-pay-now-btn').isDisabled(), true);
    await page.evaluate(() => { view.cart = [{ product: { id: 'synthetic' }, qty: 1 }]; view.totals = { total: 100 }; });
    await page.locator('#till-use-table-btn').click();
    assert.equal(await page.evaluate(() => view.activeTable), '12');
    assert.equal(await page.locator('#till-pay-now-btn').isEnabled(), true, 'applying the table restores checkout for the cart');
    assert.match(await page.locator('#cart-heading').textContent(), /Table 12/);
    assert.equal(await page.evaluate(() => view.selectedCustomer.id), 'guest');

    // The dropdown's Other table path behaves exactly like the visible entry action.
    await page.locator('#till-table-select').selectOption('__other__');
    await input.press('Enter');
    assert.equal(await page.evaluate(() => view.activeTable), null, 'blank entry cannot reuse table 12');
    await input.pressSequentially('101');
    await page.evaluate(() => view.renderOpenTabs());
    assert.equal(await input.inputValue(), '101');
    await page.screenshot({ path: fileURLToPath(new URL(`${name}.png`, output)), fullPage: true });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.ok(await input.evaluate(node => node.getBoundingClientRect().height) >= 44);
    await input.press('Enter');
    assert.equal(await page.evaluate(() => view.activeTable), '101');
    await page.locator('#till-new-table-btn').click();
    await input.fill('Patio 3');
    await page.locator('#till-use-table-btn').click();
    assert.equal(await page.evaluate(() => view.activeTable), 'Patio 3');

    await page.evaluate(() => view.addToTab('5'));
    await page.waitForFunction(() => view.selectedCustomer.id === 'nicole');
    await page.locator('#till-type-takeaway').click();
    assert.deepEqual(await page.evaluate(() => [view.activeTable, view.selectedCustomer.id]), [null, 'guest']);
    await page.evaluate(() => { view.applyCustomer({ id: 'brian', name: 'Brian', price_tier: 'RETAIL' }); view.addToTab('12'); });
    assert.equal(await page.evaluate(() => view.selectedCustomer.id), 'brian', 'an explicitly attached customer is retained');
    assert.deepEqual(errors, []);
    console.log(`${name}: multi-digit and named tables, refresh while typing, explicit application, cleared prior table/account, touch size and overflow passed.`);
    await browserContext.close();
  }
} finally { await browser.close(); }
