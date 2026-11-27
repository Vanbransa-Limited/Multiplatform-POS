// Production import/outbox methods with real IndexedDB and synthetic server data.
import { chromium } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
const read = async file => (await readFile(new URL(`../src/${file}.js`, import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
const plain = source => source.replace(/^import[\s\S]*?;\n/gm, '').replace(/\bexport /g, '');
const catalogue = await read('services/catalogue');
const pull = catalogue.slice(catalogue.indexOf('export async function pullSales('), catalogue.indexOf('/**\n * Refreshes who this business'))
  .replace('export async function', 'async function')
  .replace("const { getFirebase } = await import('./firebase.js');", '')
  .replace("const { readSaleChildren, readSalesSince } = await import('./sale-history.js');", '')
  .replace("const { db } = await import('../db/schema');", '');
const sync = await read('services/sync');
const at = sync.indexOf('  async transmitSale(');
const transmit = sync.slice(at, sync.indexOf('\n  startSyncScheduler()', at)).replace('async transmitSale(', 'async function transmitSale(')
  .replace("const { pullSales } = await import('./catalogue');", '');
const scripts = await Promise.all(['db/schema', 'services/receipt-lookup', 'services/customer-orders', 'services/takings', 'services/sale-history'].map(read));
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => route.request().url() === 'http://127.0.0.1:38894/'
    ? route.fulfill({ contentType: 'text/html', body: '<main id="bill"></main>' }) : route.abort());
  await page.goto('http://127.0.0.1:38894/');
  await page.addScriptTag({ path: fileURLToPath(new URL('../node_modules/dexie/dist/dexie.js', import.meta.url)) });
  await page.addScriptTag({ content: `
    const cacheName=()=> 'missing-items-demo', selectedCacheTenant=()=> 'tenant';
    const state={}; const firebaseConfigured=true; const activeTenantId=async()=> 'tenant';
    const escapeHtml=v=>String(v??''); const readWithDeadline=read=>read();
    const callFunction=()=>{throw Error('Recovery cannot create or settle a sale');};
    ${scripts.map(plain).join('\n')}
    const records={sales:[{id:'server',tenantId:'tenant',branchId:'branch',staffId:'seller',customerId:'guest',
      idempotencyKey:'original-uuid',invoiceNumber:'DEMO-350',tableNumber:'China',tabId:'china-tab',orderReference:'ORD-CHINA',
      totalMinor:35000,status:'completed',soldAt:'2026-11-27T18:36:11.146Z'}],
      payments:[{id:'server-credit',tenantId:'tenant',saleId:'server',method:'credit',amountMinor:35000}],
      sale_lines:[{id:'server-line',tenantId:'tenant',saleId:'server',productId:'tusker',productName:'Tusker Lager',qty:1,unitPriceMinor:35000,lineTotalMinor:35000}]};
    const fb={firestore:{collection:(_,name)=>name,where:(field,op,value)=>({field,op,value}),query:(name,...constraints)=>({name,constraints}),
      getDocsFromServer:async({name,constraints})=>({docs:records[name].filter(row=>constraints.every(c=>c.op==='in'?c.value.includes(row[c.field]):row[c.field]===c.value)).map(row=>({id:row.id,data:()=>row}))})}};
    const getFirebase=async()=>fb;
    ${pull}
    ${transmit}
    window.run=async()=>{
      await db.open();
      await db.sales.put({id:'local',sale_uuid:'original-uuid',tenant_id:'tenant',branch_id:'branch',table_no:'China',tab_id:'china-tab',
        status:'PENDING_PAYMENT',grand_total:350,sync_pending:1,sync_error_msg:'it has no items'});
      await db.payments.put({id:'original-credit',sale_id:'local',method:'PROFORMA',amount:350});
      const manager={buildSalePayload:async()=>null};
      const recovered=await transmitSale.call(manager,await db.sales.get('local'));
      await pullSales(undefined,['original-uuid']);
      const sale=await db.sales.get('local'),lines=await db.sale_lines.where('sale_id').equals('local').toArray(),payments=await db.payments.toArray();
      const order=saleAsOrder(sale,{payments,lines:lines.map(l=>({name:l.product_name,qty:l.qty}))});
      document.querySelector('#bill').innerHTML=renderOrderCard(order);
      return {recovered,sales:await db.sales.count(),items:lines.length,payments:payments.length,due:order.dueMinor,
        originalUuid:sale.sale_uuid,error:sale.sync_error_msg,synced:Boolean(sale.synced_at),itemSaleId:lines[0].sale_id};
    };
  ` });
  assert.deepEqual(errors, [], 'browser fixture must initialize without errors');
  const result = await page.evaluate(() => window.run());
  assert.deepEqual(result, { recovered: true, sales: 1, items: 1, payments: 1, due: 35000,
    originalUuid: 'original-uuid', error: null, synced: true, itemSaleId: 'local' });
  assert.match(await page.locator('#bill').textContent(), /Tusker Lager/);
  assert.equal(await page.getByRole('button', { name: 'Pay now', exact: true }).count(), 1);
  console.log('Real IndexedDB recovery passed: original UUID and local ID, one Tusker, one receivable, KES 350 due, no duplicate createSale or payment.');
} finally { await browser.close(); }
