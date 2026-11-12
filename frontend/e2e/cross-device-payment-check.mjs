// Actual OrdersView, catalogue import and Dexie ledgers in two isolated browser
// contexts. Only the shared server transport is substituted; backend payment
// transaction/claim rules are exercised in sale-settlement.test.cjs.
import { chromium } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

const read = async file => (await readFile(new URL(`../src/${file}.js`, import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
const plain = source => source.replace(/^import[\s\S]*?;\n/gm, '').replace(/\bexport /g, '');
const schema = plain(await read('db/schema'));
const catalogue = await read('services/catalogue');
const pull = catalogue.slice(catalogue.indexOf('export async function pullSales('), catalogue.indexOf('/**\n * Refreshes who this business'))
  .replace('export async function', 'async function')
  .replace("const { getFirebase } = await import('./firebase.js');", '')
  .replace("const { readSaleChildren, readSalesSince } = await import('./sale-history.js');", '')
  .replace("const { db } = await import('../db/schema');", '');
const edit = await read('services/tab-edit');
const free = edit.slice(edit.indexOf('export async function freeSettledTab(')).replace('export async function', 'async function');
const sync = await read('services/sync');
const refreshStart = sync.indexOf('  async refreshSharedOrders(');
const refresh = sync.slice(refreshStart, sync.indexOf('\n  /**', refreshStart + 1))
  .replace('async refreshSharedOrders(', 'async function refreshSharedOrders(')
  .replace("const { pullSales } = await import('./catalogue');", '')
  .replace("const { freeSettledTab } = await import('./tab-edit');", '');

const records = {
  sales: [{ id: 'server-sale', tenantId: 'tenant', branchId: 'branch', staffId: 'judy', customerId: 'guest',
    idempotencyKey: 'original-uuid', invoiceNumber: 'INV-001', tabId: 'original-tab', orderReference: 'ORD-709',
    tableNumber: '709', status: 'completed', totalMinor: 52000, soldAt: '2026-11-11T15:00:00Z' }],
  payments: [{ id: 'credit', tenantId: 'tenant', saleId: 'server-sale', method: 'credit', amountMinor: 52000 }],
  sale_lines: [{ id: 'server-line', tenantId: 'tenant', saleId: 'server-sale', productId: 'tea', productName: 'Tea', qty: 2, lineTotalMinor: 52000 }],
};
let settlementCount = 0;
const pageErrors = [];
const browser = await chromium.launch();
try {
  const pages = [];
  for (const original of [true, false]) {
    const context = await browser.newContext();
    const page = await context.newPage(); pages.push(page);
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.route('http://127.0.0.1:38889/**', route => route.fulfill({ contentType: 'text/html', body: '<main id="host"></main>' }));
    await page.goto('http://127.0.0.1:38889/');
    await page.exposeFunction('serverRead', (name, constraints) => records[name].filter(row => constraints.every(({ field, op, value }) => op === 'in' ? value.includes(row[field]) : row[field] === value)));
    await page.exposeFunction('sharedCall', (name, input) => {
      const credit = records.payments[0];
      if (name === 'claimSalePayment') {
        assert.ok(input.checkoutId);
        if (credit.settledAt) throw new Error('Already paid');
        assert.equal(input.expectedMinor, 52000);
        return { checkoutId: input.checkoutId, dueMinor: 52000 };
      }
      assert.equal(name, 'settleSale');
      assert.equal(input.saleUuid, 'original-uuid');
      if (credit.settledAt) throw new Error('Already paid');
      credit.settledAt = '2026-11-11T16:00:00Z'; settlementCount++;
      records.payments.push({ id: 'shared-settlement', tenantId: 'tenant', saleId: 'server-sale', method: 'cash', amountMinor: 52000, source: 'sale_settlement' });
      return { paymentId: 'shared-settlement', saleUuid: input.saleUuid, method: 'cash', settledMinor: 52000, receivedMinor: 52000 };
    });
    await page.addScriptTag({ path: new URL('../node_modules/dexie/dist/dexie.js', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1') });
    const scripts = await Promise.all(['services/customer-orders', 'services/takings', 'services/paginate', 'services/tabs', 'services/sale-history', 'ui/mobile-filters', 'ui/orders'].map(read));
    await page.addScriptTag({ content: `
      const cacheName=()=> 'cross-device-ledger';const selectedCacheTenant=()=> 'tenant';
      ${schema}
      const state={currentUser:{role:'Owner'},currentBranch:{id:'branch'},syncManager:{syncOutbox:async()=>{}}};
      const MpesaService=class{}; const cashIsEnabled=()=>true;
      const escapeHtml=v=>String(v??''); const callFunction=(...args)=>window.sharedCall(...args);
      const activeTenantId=async()=> 'tenant';
      const fb={dbInstance:null,firestore:{collection:(_,name)=>name,where:(field,op,value)=>({field,op,value}),query:(name,...constraints)=>({name,constraints}),
        getDocsFromServer:async({name,constraints})=>({docs:(await window.serverRead(name,constraints)).map(row=>({id:row.id,data:()=>row}))})}};
      const getFirebase=async()=>fb;
      ${scripts.map(plain).join('\n')}
      ${pull}
      ${free}
      ${refresh}
      window.ledger=db;window.refreshShared=refreshSharedOrders;
      window.view=new OrdersView(document.querySelector('#host'));
      const load=view.loadPosOrders.bind(view);view.loadPosOrders=()=>load({refresh:false});
    ` });
    await page.evaluate(async original => {
      const db = window.ledger;
      await db.open();
      if (original) {
        await db.tabs.put({ id: 'original-tab', branch_id: 'branch', table_no: '709', order_no: 'ORD-709', status: 'OPEN' });
        await db.sales.put({ id: 'local-round', tenant_id: 'tenant', branch_id: 'branch', tab_id: 'original-tab', table_no: '709', sale_uuid: 'original-uuid', status: 'PENDING_PAYMENT', grand_total: 520, synced_at: '2026-11-11T15:00:00Z' });
        await db.payments.put({ id: 'local-credit', sale_id: 'local-round', method: 'PROFORMA', amount: 520 });
      }
      window.view.remoteOpenOrders = original ? [] : [{ id: 'shared-snapshot', readOnly: true, source: 'pos', branchId: 'branch',
        ref: 'ORD-709', tableNumber: '709', customerName: 'Guest', paymentStatus: 'unpaid', status: 'received', dueMinor: 52000,
        totalMinor: 52000, saleUuids: ['original-uuid'], roundCount: 1, lines: [{ name: 'Tea', qty: 2 }] }];
      window.view.render();window.view.bindEvents();await window.view.loadPosOrders();window.view.renderCustomerBoard();
    }, original);
  }
  const [origin, cashier] = pages;
  assert.equal(await cashier.evaluate('ledger.sales.count()'), 0, 'cashier starts without the original local sale');
  await cashier.locator('[data-settle-sale="shared-snapshot"]').click();
  await cashier.locator('[data-settle-method="cash"]').click();
  await cashier.locator('#settle-confirm').click();
  await cashier.waitForFunction("document.querySelector('#settle-message').textContent.includes('Recorded and sent')");
  assert.equal(await cashier.locator('.co-card').count(), 0, 'paid order clears the cashier Running view');
  await origin.evaluate(async () => { await window.refreshShared();await window.view.loadPosOrders();window.view.renderCustomerBoard(); });
  assert.equal(await origin.evaluate("ledger.tabs.get('original-tab').then(tab=>tab.status)"), 'SETTLED');
  assert.equal(await origin.locator('.co-card').count(), 0, 'original device clears the same table');
  assert.equal(await origin.evaluate('ledger.sales.count()'), 1, 'original sale keeps its local identity');
  assert.equal(await origin.evaluate('ledger.payments.count()'), 2, 'one receivable and one settlement');
  assert.equal(await cashier.evaluate('ledger.payments.count()'), 2, 'cashier also records one receivable and one settlement');
  assert.equal(settlementCount, 1);
  assert.equal(records.sales.length, 1, 'payment does not recreate the sale');
  assert.deepEqual(pageErrors, []);
  console.log('Cross-device payment passed: cashier pays a shared table, original device frees it, one sale and one settlement remain.');
} finally { await browser.close(); }
