// Isolated real-DOM interaction benchmark; never connects to Firebase or POS data.
// Run: node frontend/e2e/till-interaction-performance-check.mjs [--verify]
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';

const read = path => readFile(new URL(path, import.meta.url), 'utf8');
const source = (await read('../src/ui/till.js'))
  .replace(/^import[\s\S]*?;\r?\n/gm, '')
  .replace('export function', 'function').replace('export class TillView', 'window.TillView = class TillView');
const pager = (await read('../src/services/paginate.js')).replaceAll('export ', '');
const draft = (await read('../src/services/till-draft.js')).replaceAll('export ', '');
const css = await read('../src/ui/styles.css');
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
  await page.route('http://127.0.0.1:38888/**', route => route.fulfill({ contentType: 'text/html', body: '<main></main>' }));
  await page.goto('http://127.0.0.1:38888/');
  await page.addStyleTag({ content: css });
  await page.addScriptTag({ content: `
    ${pager}
    ${draft}
    const MpesaService = class {};
    const unavailableMpesaCapability = () => ({});
    const createMobileFilters = () => ({ dispose() {} });
    const showNotification = () => {};
    const state = { currentTenant: { id:'test' }, currentBranch: { id:'test' }, currentUser: { id:'test' } };
    ${source}
    window.view = new TillView(document.querySelector('main'));
    view.selectedCustomer = { id:'guest', price_tier:'RETAIL' };
    view.draftReady = true;
    view.invalidateMpesaAttempt = () => {};
    view.render();
    view.houseStockByProduct = new Map(); view.barcodeByProduct = new Map(); view.categoryMap = new Map();
    view.catalogueProducts = Array.from({length:3000}, (_, i) => ({
      id:'p'+i, name:'Item '+i, sku:'SKU'+i, searchText:('Item '+i+' SKU'+i).toLowerCase(),
      canonicalCategory:'Food', sell_price:100, tax_code:'A', uom:'EACH'
    }));
    view.filterCatalogue();
  ` });
  const session = await page.context().newCDPSession(page);
  await session.send('Emulation.setCPUThrottlingRate', { rate: 6 });
  const result = await page.evaluate(async () => {
    const view = window.view;
    const paint = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    // Warm layout and retain actual node identities, not just the final totals.
    await paint();
    const firstCard = document.querySelector('.product-card');
    const startSearch = performance.now();
    for (const query of ['i', 'it', 'ite', 'item']) {
      document.querySelector('#till-search').value = query;
      view.filterCatalogue();
      await paint();
    }
    const searchMs = performance.now() - startSearch;
    const retainedCard = document.querySelector('.product-card') === firstCard;
    // A busy table with forty different items; repeatedly add the last item.
    view.cart = view.catalogueProducts.slice(0, 40).map(product => ({product, qty:1, discount_amount:0}));
    view.updateCartUI();
    await paint();
    const firstRow = document.querySelector('.cart-item');
    const startAdd = performance.now();
    for (let i = 0; i < 10; i++) {
      await view.addToCart(view.catalogueProducts[39]);
      await paint();
    }
    const addMs = performance.now() - startAdd;
    const retainedRow = document.querySelector('.cart-item') === firstRow;
    const total = view.totals.total;
    const draftQty = JSON.parse(sessionStorage.getItem(view.draftKey)).cart[39].qty;
    // Removing a middle row must leave increment/remove handlers on the right item.
    document.querySelectorAll('.cart-item-remove')[5].click();
    document.querySelectorAll('.qty-btn.inc')[5].click();
    const shiftedQty = view.cart[5].qty;
    const shiftedId = view.cart[5].product.id;
    document.querySelector('#till-search').value = 'sku2999';
    document.querySelector('#till-search').dispatchEvent(new Event('input'));
    await new Promise(resolve => setTimeout(resolve, 200));
    const match = document.querySelector('.product-card')?.dataset.id;
    return { cpuThrottle:6, catalogueSize:3000, searchMs, addMs, retainedCard, retainedRow,
      total, draftQty, shiftedQty, shiftedId, match, matches:document.querySelectorAll('.product-card').length };
  });
  console.log(JSON.stringify(result, null, 2));
  assert.equal(result.total, 5000);
  assert.equal(result.draftQty, 11);
  assert.equal(result.shiftedId, 'p6');
  assert.equal(result.shiftedQty, 2);
  assert.equal(result.match, 'p2999');
  assert.equal(result.matches, 1);
  if (process.argv.includes('--verify')) {
    assert.equal(result.retainedCard, true, 'Unchanged search results must retain cards');
    assert.equal(result.retainedRow, true, 'Adding an item must retain unrelated cart rows');
    const lifecycle = await page.evaluate(async () => {
      const view = window.view;
      const filter = view.filterCatalogue.bind(view);
      let calls = 0;
      view.filterCatalogue = () => { calls++; filter(); };
      const search = document.querySelector('#till-search');
      for (const value of ['s', 'sk', 'sku', 'sku1']) {
        search.value = value;
        search.dispatchEvent(new Event('input'));
      }
      await new Promise(resolve => setTimeout(resolve, 200));
      const burstCalls = calls;
      search.dispatchEvent(new Event('input'));
      view.releaseHeldLease = () => {};
      view.dispose();
      await new Promise(resolve => setTimeout(resolve, 200));
      return { burstCalls, afterDispose:calls };
    });
    assert.deepEqual(lifecycle, { burstCalls:1, afterDispose:1 });
  }
} finally { await browser.close(); }
