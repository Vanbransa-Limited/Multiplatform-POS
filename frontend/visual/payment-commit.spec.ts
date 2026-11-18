import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

async function setup(page: any) {
  await page.goto('/till/');
  await page.evaluate(() => { document.body.innerHTML = '<input id="cart-buyer-pin"><input id="checkout-table-number">'; });
  await page.addScriptTag({ content: readFileSync('node_modules/dexie/dist/dexie.js', 'utf8') });
  const database = readFileSync('src/db/index.js', 'utf8');
  const audit = database.slice(database.indexOf('export async function computeHash'), database.indexOf('export async function getStockOnHand')).replaceAll('export async function', 'async function');
  const till = readFileSync('src/ui/till.js', 'utf8').replace(/\r\n/g, '\n');
  const method = till.slice(till.indexOf('  async registerOrder('), till.indexOf('  /** Closes the checkout')).replace('async registerOrder(', 'async function registerOrder(');
  const pending = till.slice(till.indexOf('  async registerPendingOrder('), till.indexOf('  /**\n   * Closes a tab the moment')).replace('async registerPendingOrder(', 'async function registerPendingOrder(');
  const settling = till.slice(till.indexOf('  async settlePendingOrder('), till.indexOf('  /**\n   * Takes back an order')).replace('async settlePendingOrder(', 'async function settlePendingOrder(');
  const pricing = readFileSync('src/services/service-charges.js', 'utf8').replaceAll('export ', '');
  await page.addScriptTag({ content: `
    const db = new Dexie('payment-commit-test-' + crypto.randomUUID());
    db.version(1).stores({tabs:'id',shifts:'id,user_id',sales:'id,sale_uuid',sale_lines:'id,sale_id',payments:'id,sale_id',stock_movements:'id',audit_log:'id,created_at',customers:'id'});
    const state={currentTenant:{id:'t1'},currentBranch:{id:'b1'},currentUser:{id:'s1',role:'Owner'},cloudShiftId:'shift1'};
    const canSell=()=>true;
    const claimSalePayment=async()=>({});
    const DEVICE_ID='device1',WALK_IN_CUSTOMER_ID='walk-in',firebaseConfigured=true,HELD_ORDER_MS=60000;
    const showNotification=()=>{};const getHouseStock=async()=>100;
    const isReceivable=method=>['CREDIT','PROFORMA'].includes(String(method).toUpperCase());
    const mapPaymentMethod=method=>String(method).toLowerCase();
    const serverCalls=[];window.serverCalls=serverCalls;
    const settleSale=async input=>{serverCalls.push(input);if(window.failSettlement)throw new Error('Server settlement unavailable');return {paymentId:'server-payment1',method:input.method,reference:'TEST-RECEIPT',verified:true,settledMinor:500};};
    state.syncManager={publishSale:async id=>{if(window.failPublish)throw new Error('Server save unavailable');await db.sales.update(id,{synced_at:'confirmed-server-save'});return db.sales.get(id);}};
    ${pricing}
    ${audit}
    const digest=crypto.subtle.digest.bind(crypto.subtle);
    crypto.subtle.digest=async(...args)=>{await new Promise(resolve=>setTimeout(resolve,80));return digest(...args);};
    window.registerOrder=${method};
    window.registerPending=${pending};window.settlePending=${settling};
    window.testDb=db;window.audit=logAuditEvent;window.verifyAudit=verifyAuditTrail;
    window.paymentRow=()=>({id:crypto.randomUUID(),method:'MPESA',amount:5,reference:'TEST-RECEIPT',verified:1});
    window.view={selectedPaymentMethod:'MPESA',mpesaAttempt:{idempotencyKey:'confirmed-attempt-1',attemptId:'stk1'},mpesaRef:'TEST-RECEIPT',
      mpesaProofMatchesCurrentCart:()=>true,resolveTabForRound:async()=>null,
      selectedCustomer:{id:WALK_IN_CUSTOMER_ID,price_tier:'RETAIL'},totals:{subtotal:5,total:5,tax:0,discount:0},
      cart:[{product:{id:'p1',name:'Test item',is_service:0,tax_code:'A',sell_price:5,cost_price:0},qty:1}]};
    view.registerOrder=registerOrder;view.releaseHeldLease=()=>{};view.assertTabNameFree=async()=>{};
    view.buildPendingPaymentRecords=()=>[{id:crypto.randomUUID(),method:'CREDIT',amount:5}];
    view.buildPaymentRecords=()=>[paymentRow()];
    view.roundsBeingSettled=async()=>[view.pendingSale.saleId];
    view.completeRegisteredOrder=result=>{window.completed=result;};
    window.ready=db.shifts.put({id:'shift1',user_id:'s1',branch_id:'b1',status:'OPEN'});
  ` });
  await page.evaluate('window.ready');
}

test('confirmed payment registration waits for delayed crypto and commits sale, tender and audit together', async ({ page }) => {
  await setup(page);
  const result = await page.evaluate('registerOrder.call(view,[paymentRow()],{pending:false})') as { saleRecord: { status: string } };
  expect(result.saleRecord.status).toBe('COMPLETED');
  expect(await page.evaluate('Promise.all([testDb.sales.count(),testDb.payments.count(),testDb.sale_lines.count(),testDb.stock_movements.count(),testDb.audit_log.count()])')).toEqual([1, 1, 1, 1, 1]);
  expect(await page.evaluate('verifyAudit()')).toMatchObject({ valid: true, count: 1 });
});

test('Pay Now saves unpaid to the server and clears that same pending order on confirmed payment', async ({ page }) => {
  await setup(page);
  expect(await page.evaluate('registerPending.call(view)')).toBe(true);
  expect(await page.evaluate('testDb.sales.toArray()')).toMatchObject([{ server_pending: true, synced_at: 'confirmed-server-save', status: 'PENDING_PAYMENT' }]);
  expect(await page.evaluate('testDb.payments.toArray()')).toMatchObject([{ method: 'CREDIT' }]);
  expect(await page.evaluate('testDb.payments.toArray().then(rows=>rows.some(row=>row.settled_at))')).toBe(false);
  expect(await page.evaluate('settlePending.call(view)')).toBe(true);
  expect(await page.evaluate('serverCalls')).toMatchObject([{ method: 'mpesa', attemptId: 'stk1' }]);
  expect(await page.evaluate('Promise.all([testDb.sales.count(),testDb.stock_movements.count()])')).toEqual([1, 1]);
  expect(await page.evaluate('testDb.payments.get("server-payment1")')).toMatchObject({ method: 'MPESA', amount: 5 });
  expect(await page.evaluate('testDb.sales.toArray()')).toMatchObject([{ status: 'COMPLETED' }]);
});

test('failed server settlement retains Pending and never marks the local order paid', async ({ page }) => {
  await setup(page);
  await page.evaluate('registerPending.call(view)');
  const error = await page.evaluate('(async()=>{window.failSettlement=true;try{await settlePending.call(view);}catch(error){return error.message;}})()');
  expect(error).toBe('Server settlement unavailable');
  expect(await page.evaluate('testDb.sales.toArray()')).toMatchObject([{ status: 'PENDING_PAYMENT' }]);
  expect(await page.evaluate('testDb.payments.count()')).toBe(1);
  expect(await page.evaluate('testDb.stock_movements.count()')).toBe(1);
});

test('retries of a previously saved confirmed payment reuse one local sale and payment', async ({ page }) => {
  await setup(page);
  const results = await page.evaluate(`(async()=>{
    const first=await registerOrder.call(view,[paymentRow()],{pending:false});
    const retries=await Promise.all([registerOrder.call(view,[paymentRow()],{pending:false}),registerOrder.call(view,[paymentRow()],{pending:false})]);
    return {first:first.saleId,retries:retries.map(row=>({id:row.saleId,replayed:row.replayed}))};
  })()`) as { first: string; retries: { id: string; replayed: boolean }[] };
  expect(results.retries).toEqual([{ id: results.first, replayed: true }, { id: results.first, replayed: true }]);
  expect(await page.evaluate('Promise.all([testDb.sales.count(),testDb.payments.count(),testDb.stock_movements.count(),testDb.audit_log.count()])')).toEqual([1, 1, 1, 1]);
});

test('failure after hashing rolls the entire sale and audit back instead of leaving a partial commit', async ({ page }) => {
  await setup(page);
  const failure = await page.evaluate(`(async()=>{
    try {
      await testDb.transaction('rw',[testDb.sales,testDb.payments,testDb.audit_log],async()=>{
        await testDb.sales.add({id:'abort-sale'});await testDb.payments.add({id:'abort-payment'});
        await audit('t1','s1','SALE_CHECKOUT','SALE','abort-sale');
        throw new Error('Simulated failure after audit');
      });
    } catch(error){return error.message;}
  })()`);
  expect(failure).toBe('Simulated failure after audit');
  expect(await page.evaluate('Promise.all([testDb.sales.count(),testDb.payments.count(),testDb.audit_log.count()])')).toEqual([0, 0, 0]);
});
