import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { billableCheckoutRounds } from './checkout-rounds.js';
import { saleAsOrder } from './customer-orders.js';
import { toMinor } from './tender.js';
import { manualReceipt } from './manual-receipt.js';
import { recoveryScope } from './stk-recovery.js';
const source=(await readFile(new URL('../ui/till.js',import.meta.url),'utf8')).replace(/\r\n/g,'\n');

test('Till checkout filters the same zero adjustment as Orders while preserving all KES2100 rounds', async()=>{
  const real=[1100,800,200].map((grand_total,i)=>({id:'r'+i,sale_uuid:'u'+i,grand_total,status:'COMPLETED',synced_at:'server'}));
  const marker={id:'marker',grand_total:0,status:'PENDING_PAYMENT'};
  const rows=[...real,marker];
  const payments=rows.map(row=>({sale_id:row.id,method:'CREDIT',amount:row.grand_total}));
  const db={sales:{where:()=>({equals:()=>({toArray:async()=>rows})}),bulkGet:async ids=>rows.filter(row=>ids.includes(row.id))},
    payments:{where:()=>({anyOf:()=>({toArray:async()=>payments}),equals:id=>({toArray:async()=>payments.filter(row=>row.sale_id===id)})})},
    sale_lines:{where:()=>({equals:()=>({toArray:async()=>[{product_id:'prod-staff-discount',unit_price:0,line_total:0,qty:1}]})})}};
  const body=source.slice(source.indexOf('  async roundsBeingSettled()'),source.indexOf('\n  async settlePendingByCode()')).replace('async roundsBeingSettled()','async function roundsBeingSettled()');
  const run=new Function('db','saleAsOrder','billableCheckoutRounds',`return ${body}`)(db,saleAsOrder,billableCheckoutRounds);
  assert.deepEqual(await run.call({activeTabId:'tab'}),['r0','r1','r2']);
});

test('Till STK carries the reserved saved-bill UUIDs, original total and no new service surcharge', async()=>{
  const start=source.indexOf('  async runMpesaAttempt(');
  const body=source.slice(start,source.indexOf('\n  async triggerPaystack',start+1)).replace('async runMpesaAttempt(','async function runMpesaAttempt(');
  const calls=[];
  const nodes=new Map(); const document={getElementById:id=>{if(!nodes.has(id))nodes.set(id,{value:'0712345678'});return nodes.get(id);}};
  const state={currentBranch:{id:'branch'},syncManager:{publishSale:async id=>({sale_uuid:'uuid-'+id,synced_at:'server'})}};
  const run=new Function('state','firebaseConfigured','document','toMinor','claimSalePayment','DEVICE_ID','showNotification','recoveryScope',`return ${body}`)
    (state,true,document,toMinor,async payload=>calls.push({type:'claim',...payload}),'device',()=>{},recoveryScope);
  const view={activeTabId:'tab',totals:{total:2100,vipSurcharge:225},selectedCustomer:{id:'guest'},mpesaCapability:{available:true},
    beginMpesaAttempt:()=>({idempotencyKey:'stable-stk-key',requestAmountMinor:210000,cashAmountMinor:0}),mpesaOffline:()=>false,
    roundsBeingSettled:async()=>['r0','r1','r2'],showMpesaStatus(){},applyMpesaCapabilityToUi(){},
    mpesa:{initiateStkPush:async payload=>{calls.push({type:'prompt',...payload});return{success:false,status:'ambiguous'};}},
    compactCartLines(){throw Error('Saved bill must not be repriced');}};
  await run.call(view,'mpesa');
  assert.equal(calls.length,2);
  assert.equal(calls[0].expectedMinor,210000);
  assert.deepEqual(calls[1].settlementSaleUuids,['uuid-r0','uuid-r1','uuid-r2']);
  assert.equal(calls[1].checkoutId,calls[0].checkoutId);
  assert.equal(calls[1].amountKes,2100);
  assert.equal(calls[1].serviceChargeMinor,0);
  assert.deepEqual(calls[1].lines,[]);
});

test('Till records a typed receipt without lookup and keeps the unpaid remainder on the bill', async () => {
  const start = source.indexOf('  async settlePendingByCode()');
  const body = source.slice(start, source.indexOf('\n  async settlePendingOrder()', start)).replace('async settlePendingByCode()', 'async function settlePendingByCode()');
  const nodes = new Map([['pay-mpesa-code', { value: 'UKL0B2RHOX' }], ['pay-mpesa-amount', { value: '400' }], ['checkout-due-amount', {}]]);
  const calls = [], notices = [];
  const round = { id: 'round', sale_uuid: 'saved-uuid' };
  const state = { syncManager: { publishSale: async () => round } };
  const db = { payments: { where: () => ({ equals: () => ({ toArray: async () => [{ method: 'CREDIT', amount: 1000 }] }) }) } };
  const run = new Function('manualReceipt', 'document', 'firebaseConfigured', 'showNotification', 'state', 'claimSalePayment', 'DEVICE_ID', 'db', 'isReceivable', 'toMinor', 'settleSale', 'recordReceiptSettlement', `return ${body}`)(
    manualReceipt, { getElementById: id => nodes.get(id) }, true, text => notices.push(text), state,
    async () => ({ dueMinor: 100000 }), 'device', db, method => method === 'CREDIT', toMinor,
    async input => { calls.push(input); return { settledMinor: 40000, outstandingMinor: 60000, availableMinor: 0 }; }, async () => {});
  const view = { roundsBeingSettled: async () => ['round'], settlementRequestId: 'checkout', totals: { total: 1000 }, releaseHeldLease() {} };
  assert.equal(await run.call(view), false);
  assert.equal(calls[0].receiptAmountMinor, 40000);
  assert.equal(calls[0].amountMinor, undefined, 'The server decides the usable balance');
  assert.equal(view.totals.total, 600);
  assert.match(notices[0], /600.00 still due/);
  assert.equal(nodes.get('pay-mpesa-amount').value, '');
});
