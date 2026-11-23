import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
const source = (path: string) => readFileSync(path, 'utf8').replace(/\r\n/g, '\n')
  .replace(/^import[\s\S]*?;\n/gm, '').replace(/\bexport /g, '');

for (const method of ['card', 'mpesa', 'stk']) {
  test(`KES2100 checkout ignores an empty discount round and settles three saved rounds by ${method}`, async ({ page }) => {
    await page.goto('/orders/');
    await page.evaluate(() => { document.body.innerHTML = '<main id="host"><div id="settle-message"></div><input id="settle-receipt-amount" value="2100"><input id="settle-reference" value="TESTREF001"><input id="settle-phone" value="0712345678"><div id="settle-stk-status"></div><div id="settle-stk-badge"></div><div id="settle-due"></div></main>'; });
    await page.addScriptTag({ content: readFileSync('node_modules/dexie/dist/dexie.js', 'utf8') });
    const orders = source('src/ui/orders.js').replace("const { firebaseConfigured } = await import('../services/firebase');", 'const firebaseConfigured = true;');
    await page.addScriptTag({ content: `
      const db = new Dexie('checkout-recovery-'+crypto.randomUUID());
      db.version(1).stores({sales:'id,sale_uuid,tab_id',sale_lines:'id,sale_id',payments:'id,sale_id',customers:'id'});
      const state={currentUser:{id:'seller',role:'Cashier'},currentTenant:{id:'tenant'},currentBranch:{id:'branch'}};
      const DEVICE_ID='device'; const cashIsEnabled=()=>true;
      const isReceivable=m=>['CREDIT','PROFORMA'].includes(String(m).toUpperCase());
      const toMinor=v=>Math.round((Number(v)||0)*100);
      const MpesaService=class{};const calls=[];
      const pullSales=async()=>{};
      const claimSalePayment=async input=>{calls.push({type:'claim',...input});if(input.saleUuids.length!==3||input.expectedMinor!==210000)throw Error('Wrong bill claim');return {dueMinor:210000};};
      const settleSale=async input=>{calls.push({type:'settlement',...input});const round=await db.sales.where('sale_uuid').equals(input.saleUuid).first();return{paymentId:'receipt-'+round.id,method:input.method,reference:'TESTREF001',settledMinor:Math.round(round.grand_total*100),receivedMinor:210000,verified:input.method==='mpesa'};};
      const freeSettledTab=async()=>{calls.push({type:'free-table'});return '78';};
      const catalogueCartLines=()=>[];
      ${source('src/services/manual-receipt.js')}
      ${source('src/services/receipt-settlement.js')}
      ${source('src/services/checkout-rounds.js')}
      ${orders}
      window.testDb=db;window.calls=calls;
      window.view=new OrdersView(document.querySelector('#host'));
      view.settleMethod=${JSON.stringify(method)};view.settleRequestId='checkout';view.settleStkKey='prompt-original';
      view.settleTarget=()=>({id:'tab',ref:'EXAMPLE-TABLE',roundIds:['r1','empty','r2','r3'],customerId:'walk-in',branchId:'branch',dueMinor:210000});
      view.loadPosOrders=async()=>{};view.renderCustomerBoard=()=>{};view.pushSettledRounds=async()=>({ok:true});
      view.mpesa={initiateStkPush:async input=>{calls.push({type:'prompt',...input});return{success:true,attemptId:'provider-proof'};},awaitResult:async()=>({status:'paid',receipt:'TESTREF001',amountMinor:210000})};
      state.syncManager={publishSale:async id=>{calls.push({type:'publish',id});throw Error('The empty adjustment must never be uploaded');}};
      window.ready=(async()=>{
        await db.sales.bulkPut([1100,800,200].map((amount,i)=>({id:'r'+(i+1),sale_uuid:'uuid'+(i+1),synced_at:'server',tab_id:'tab',grand_total:amount,status:'COMPLETED'})));
        await db.sales.put({id:'empty',sale_uuid:'empty-uuid',tab_id:'tab',grand_total:0,status:'PENDING_PAYMENT'});
        await db.sale_lines.put({id:'discount',sale_id:'empty',product_id:'prod-staff-discount',unit_price:0,line_total:0,qty:1});
        await db.payments.bulkPut([1100,800,200].map((amount,i)=>({id:'credit'+i,sale_id:'r'+(i+1),method:'CREDIT',amount})));
        await db.payments.put({id:'empty-credit',sale_id:'empty',method:'PROFORMA',amount:0});
      })();
    ` });
    await page.evaluate('window.ready');
    await page.evaluate('view.performSettlement({disabled:false})');
    const calls = await page.evaluate('window.calls') as any[];
    expect(calls.filter(call => call.type === 'settlement')).toHaveLength(3);
    expect(calls.filter(call => call.type === 'publish')).toHaveLength(0);
    expect(calls.find(call => call.type === 'claim').saleUuids).toEqual(['uuid1', 'uuid2', 'uuid3']);
    expect(await page.evaluate('testDb.payments.toArray().then(rows=>rows.filter(row=>!isReceivable(row.method)).reduce((sum,row)=>sum+row.amount,0))')).toBe(2100);
    expect(await page.evaluate('testDb.payments.get("empty-credit")')).not.toHaveProperty('settled_at');
    if (method === 'stk') expect(calls.find(call => call.type === 'prompt')).toMatchObject({amountKes:2100,settlementSaleUuids:['uuid1','uuid2','uuid3'],checkoutId:'checkout',lines:[]});
    await expect(page.locator('#settle-message')).not.toContainText('all zero');
  });
}

test('a discount-only cart cannot create another zero round', async ({ page }) => {
  await page.goto('/till/');
  const till=source('src/ui/till.js');
  const method=till.slice(till.indexOf('  async registerOrder('),till.indexOf('  /** Closes the checkout')).replace('async registerOrder(','async function registerOrder(');
  await page.addScriptTag({content:`const notices=[];const showNotification=message=>notices.push(message);window.register=${method};window.notices=notices;`});
  expect(await page.evaluate('register.call({cart:[{product:{id:"prod-staff-discount"},qty:1}]},[],{pending:true})')).toBe(false);
  expect(await page.evaluate('notices[0]')).toContain('Add an item');
});
