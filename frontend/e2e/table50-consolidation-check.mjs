// Real IndexedDB and the production import, tab selection and invoice methods.
import { chromium } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
const read = async file => (await readFile(new URL(`../src/${file}.js`, import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
const plain = text => text.replace(/^import[\s\S]*?;\n/gm, '').replace(/\bexport /g, '');
const catalogue = await read('services/catalogue');
const pull = catalogue.slice(catalogue.indexOf('export async function pullSales('), catalogue.indexOf('/**\n * Refreshes who this business'))
  .replace('export async function', 'async function')
  .replace("const { getFirebase } = await import('./firebase.js');", '')
  .replace("const { readSaleChildren, readSalesSince } = await import('./sale-history.js');", '')
  .replace("const { db } = await import('../db/schema');", '');
const edit = await read('services/tab-edit');
const readTabs = edit.slice(edit.indexOf('export async function readOpenTabs('), edit.indexOf('/**\n * Frees a table')).replace('export async function', 'async function');
const till = await read('ui/till');
const assertTab = till.slice(till.indexOf('  async assertTabNameFree('), till.indexOf('\n  async resolveTabForRound(')).replace('async assertTabNameFree(', 'async function assertTabNameFree(');
const resolveTab = till.slice(till.indexOf('  async resolveTabForRound('), till.indexOf('\n  /**\n   * The two ways out')).replace('async resolveTabForRound(', 'async function resolveTabForRound(');
const orders = await read('ui/orders');
const invoice = orders.slice(orders.indexOf('  async openInvoiceModal('), orders.indexOf('\n  /** Has KRA sign')).replace('async openInvoiceModal(', 'async function openInvoiceModal(');
const scripts = await Promise.all(['db/schema', 'services/tabs', 'services/customer-orders', 'services/takings', 'services/sale-history', 'ui/tab-management'].map(read));
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('http://127.0.0.1:38890/**', route => route.fulfill({ contentType: 'text/html', body: '<main id="board"></main><div id="orders-receipt-paper"></div><div id="orders-etr-row"></div><input id="orders-etr-pin">' }));
  await page.goto('http://127.0.0.1:38890/');
  await page.addScriptTag({ path: fileURLToPath(new URL('../node_modules/dexie/dist/dexie.js', import.meta.url)) });
  await page.addScriptTag({ content: `
    const cacheName=()=> 'table50-test';const selectedCacheTenant=()=> 'tenant';
    const state={currentTenant:{id:'tenant',trading_name:'Test Restaurant'},currentBranch:{id:'branch'}};
    const firebaseConfigured=true;const DEVICE_ID='device';const WALK_IN_CUSTOMER_ID='guest';
    const showNotification=()=>{};const escapeHtml=v=>String(v??'');const etrFor=async()=>null;
    const pullOpenOrders=async()=>[];const activeTenantId=async()=> 'tenant';
    ${scripts.map(plain).join('\n')}
    const records={sales:[],payments:[],sale_lines:[]};
    const fb={firestore:{collection:(_,name)=>name,where:(field,op,value)=>({field,op,value}),query:(name,...constraints)=>({name,constraints}),
      getDocsFromServer:async({name,constraints})=>({docs:records[name].filter(row=>constraints.every(c=>c.op==='in'?c.value.includes(row[c.field]):row[c.field]===c.value)).map(row=>({id:row.id,data:()=>row}))})}};
    const getFirebase=async()=>fb;
    ${pull}
    ${readTabs}
    ${assertTab}
    ${resolveTab}
    ${invoice}
    window.testRun=async()=>{
      await db.open();
      await db.tabs.bulkPut([{id:'split',branch_id:'branch',table_no:'50',order_no:'ORD-OLD',status:'OPEN'},
        {id:'canonical',branch_id:'branch',table_no:'50',order_no:'ORD-50-276837',status:'OPEN'}]);
      const totals=[14000,100,800,700], quantities=[7,1,2,5];
      for(let i=0;i<4;i++){
        records.sales.push({id:'s'+i,tenantId:'tenant',branchId:'branch',idempotencyKey:'u'+i,tableNumber:'50',
          tabId:'canonical',orderReference:'ORD-50-276837',invoiceNumber:'INV-'+i,totalMinor:totals[i]*100,
          subtotalMinor:totals[i]*100,status:'completed',soldAt:'2026-11-20T17:00:00Z'});
        records.payments.push({id:'p'+i,tenantId:'tenant',saleId:'s'+i,method:'credit',amountMinor:totals[i]*100});
        records.sale_lines.push({id:'l'+i,tenantId:'tenant',saleId:'s'+i,productName:'Meal '+i,qty:quantities[i],lineTotalMinor:totals[i]*100});
      }
      await db.sales.put({id:'original-local',sale_uuid:'u0',branch_id:'branch',tab_id:'split',table_no:'50',status:'PENDING_PAYMENT',grand_total:14000});
      await db.payments.put({id:'original-credit',sale_id:'original-local',method:'PROFORMA',amount:14000});
      await db.sale_lines.put({id:'original-line',sale_id:'original-local',product_name:'Meal 0',qty:7,line_total:14000});
      await pullSales(undefined,undefined,{tableNumber:'50',branchId:'branch'});
      const tabs=await readOpenTabs('branch');
      const allSales=await db.sales.toArray(), ledger=await db.payments.toArray();
      const mapped=allSales.map(sale=>saleAsOrder(sale,{payments:ledger.filter(p=>p.sale_id===sale.id)}));
      const grouped=mergeTabRounds(mapped,await db.tabs.toArray());
      const manager=new TabManagementView(document.querySelector('#board'));manager.names=new Map();
      document.querySelector('#board').innerHTML=tabs.map(tab=>manager.card(tab)).join('');
      const view={allOrders:()=>grouped,settleRounds:async()=>allSales,showModal(){}};
      await openInvoiceModal.call(view,'canonical');
      const tillView={activeTabId:'split'};
      await assertTabNameFree.call(tillView,'50');
      const nextId=await db.transaction('rw',[db.tabs],()=>resolveTabForRound.call(tillView,'50','new-shift'));
      return {count:tabs.length,due:tabs[0].dueMinor,items:tabs[0].items,rounds:tabs[0].rounds.length,
        nextId,sales:await db.sales.count(),payments:await db.payments.count(),oldStatus:(await db.tabs.get('split')).status,
        invoice:document.querySelector('#orders-receipt-paper').textContent};
    };
  ` });
  const result = await page.evaluate(() => window.testRun());
  assert.equal(result.count, 1); assert.equal(result.due, 1560000); assert.equal(result.items, 15);
  assert.equal(result.rounds, 4); assert.equal(result.nextId, 'canonical'); assert.equal(result.oldStatus, 'MERGED');
  assert.equal(result.sales, 4); assert.equal(result.payments, 4);
  assert.match(result.invoice, /ORD-50-276837/); assert.match(result.invoice, /15,600\.00/);
  assert.equal(await page.locator('.tab-card').count(), 1); assert.deepEqual(errors, []);
  console.log('Table 50 browser check passed: one card, four rounds, 15 items, KES15,600 invoice; next round reuses its tab without duplicate sales or tenders.');
} finally { await browser.close(); }
