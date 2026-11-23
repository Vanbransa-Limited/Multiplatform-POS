// Desktop touch exercise with the real filters, select observer and notifications.
// Uses only synthetic products and a disposable browser; no Firebase connection.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';
const read = file => readFile(new URL(file, import.meta.url), 'utf8');
const strip = source => source.replace(/^import[\s\S]*?;\r?\n/gm, '').replace(/^export /gm, '');
const [till, pager, drafts, filters, selects, context, css, mobileCss, selectCss] = await Promise.all([
  read('../src/ui/till.js'), read('../src/services/paginate.js'), read('../src/services/till-draft.js'),
  read('../src/ui/mobile-filters.js'), read('../public/select-control.js'), read('../src/context.js'),
  read('../src/ui/styles.css'), read('../src/ui/mobile.css'), read('../public/select-control.css'),
]);
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport:{width:1366,height:768}, hasTouch:true });
  page.setDefaultTimeout(15000);
  await page.route('http://127.0.0.1:38887/**', route => route.fulfill({ contentType:'text/html',
    body:'<meta name="viewport" content="width=device-width, initial-scale=1"><body class="dark-mode"><main class="app-main-content"><section id="view-till" class="tab-view active"></section></main></body>' }));
  await page.goto('http://127.0.0.1:38887/');
  await page.addStyleTag({ content:css+mobileCss+selectCss });
  await page.addScriptTag({ content:`
    ${strip(context)}
    ${strip(pager)}
    ${strip(drafts)}
    ${strip(filters)}
    ${strip(selects)}
    const MpesaService = class {};
    const unavailableMpesaCapability = () => ({});
    const tabKey = value => String(value || '').trim().toLowerCase();
    ${strip(till).replace('class TillView', 'window.TillView = class TillView')}
    Object.assign(state, { currentTenant:{id:'test'}, currentBranch:{id:'test'}, currentUser:{id:'test'} });
    window.view = new TillView(document.querySelector('#view-till'));
    view.selectedCustomer = {id:'guest',price_tier:'RETAIL'};
    view.draftReady = true;
    view.invalidateMpesaAttempt = () => {};
    view.render();
    document.querySelector('#cart-customer-select').innerHTML = '<option value="guest">Walk-in</option>';
    window.cleanupSelects = installSelectControls(document);
    view.houseStockByProduct = new Map(); view.barcodeByProduct = new Map(); view.categoryMap = new Map();
    view.catalogueProducts = Array.from({length:3000}, (_, i) => ({id:'p'+i, name:'Item '+i, sku:'SKU'+i,
      searchText:('Item '+i+' SKU'+i).toLowerCase(),canonicalCategory:'Food',sell_price:100,tax_code:'A',uom:'EACH'}));
    view.filterCatalogue();
    window.longTasks = [];
    new PerformanceObserver(list => window.longTasks.push(...list.getEntries().map(entry => entry.duration)))
      .observe({type:'longtask',buffered:true});
  ` });
  const session = await page.context().newCDPSession(page);
  await session.send('Emulation.setCPUThrottlingRate', {rate:6});
  await session.send('Performance.enable');
  const metricsBefore = await session.send('Performance.getMetrics');
  const started = performance.now();
  for (let i=0; i<40; i++) await page.locator('.product-card').nth(i%3).tap();
  const results = await page.evaluate(() => ({
    qty:window.view.cart.reduce((sum,item) => sum+item.qty,0),
    toasts:document.querySelectorAll('.notification-toast').length,
    nodes:document.querySelectorAll('*').length,
    longTasks:window.longTasks,
    cardBlur:getComputedStyle(document.querySelector('.product-card')).backdropFilter,
  }));
  const metricsAfter = await session.send('Performance.getMetrics');
  const metric = (list,name) => list.metrics.find(item => item.name===name)?.value || 0;
  console.log(JSON.stringify({...results,elapsedMs:performance.now()-started,
    scriptMs:1000*(metric(metricsAfter,'ScriptDuration')-metric(metricsBefore,'ScriptDuration')),
    layoutMs:1000*(metric(metricsAfter,'LayoutDuration')-metric(metricsBefore,'LayoutDuration')),
  },null,2));
  assert.equal(results.qty,40,'Every touchscreen tap must add exactly one item');
  assert.equal(results.toasts,0,'Routine taps must not pile overlays over checkout');
  assert.equal(results.cardBlur,'none');
  assert.equal(await page.locator('.product-card').first().evaluate(el => getComputedStyle(el).touchAction),'manipulation');

  // Hold a finger on + while another input increments the same item. Replacing
  // the button during that interval causes the browser to drop the held tap.
  const increase = page.locator('.qty-btn.inc').first();
  const heldButton = await increase.elementHandle();
  const rect = await increase.boundingBox();
  const prior = await page.evaluate(() => window.view.cart[0].qty);
  await session.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:rect.x+rect.width/2,y:rect.y+rect.height/2}]});
  await page.evaluate(() => window.view.addToCart(window.view.catalogueProducts[0]));
  assert.equal(await heldButton.evaluate(el => el.isConnected),true,'Quantity updates must retain the touched button');
  await session.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  await page.waitForFunction(expected => window.view.cart[0].qty===expected,prior+2);

  await page.screenshot({path:new URL('../../tmp/till-touch-desktop.png',import.meta.url).pathname.replace(/^\/([A-Za-z]:)/,'$1')});
  // Check the phone layout before the fling below; resizing a viewport during
  // an inertial gesture changes what the browser treats as its next tap.
  await page.setViewportSize({width:390,height:844});
  await page.locator('#till-cart-toggle').tap();
  await page.waitForFunction(() => document.querySelector('.till-grid').dataset.mobilePanel==='sale');
  await page.screenshot({path:new URL('../../tmp/till-touch-mobile.png',import.meta.url).pathname.replace(/^\/([A-Za-z]:)/,'$1')});
  assert.ok(await page.locator('.qty-btn.inc').first().evaluate(el => el.getBoundingClientRect().height)>=44);
  await page.setViewportSize({width:1366,height:768});

  // Swiping the product catalogue scrolls without ringing up the touched item.
  const qtyBeforeSwipe = await page.evaluate(() => window.view.cart.reduce((sum,item) => sum+item.qty,0));
  const product = await page.locator('.product-card').first().boundingBox();
  const x = product.x+product.width/2;
  const y = product.y+product.height/2;
  await session.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y}]});
  for (let step=1;step<=5;step++) await session.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x,y:y-step*25}]});
  await session.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  assert.equal(await page.evaluate(() => window.view.cart.reduce((sum,item) => sum+item.qty,0)),qtyBeforeSwipe);
  assert.ok(await page.locator('.product-grid').evaluate(el => el.scrollTop)>0,'Touch panning must still scroll');
  await page.locator('.product-grid').evaluate(el => {el.scrollTop=0;});
  console.log('Verified held touch, exactly-once additions, swipe scrolling and phone controls.');
} finally { await browser.close(); }
