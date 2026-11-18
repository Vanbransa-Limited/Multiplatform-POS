import test from 'node:test';
import assert from 'node:assert/strict';
import { isNonBillableAdjustment, billableCheckoutRounds, missingReceivable } from './checkout-rounds.js';
const marker = { id: 'marker', status: 'PENDING_PAYMENT', grand_total: 0 };
const line = { sale_id: 'marker', product_id: 'prod-staff-discount', qty: 1, unit_price: 0, line_total: 0 };
const credit = { sale_id: 'marker', method: 'PROFORMA', amount: 0 };
const table = rows => ({ where: field => ({ equals: value => ({ toArray: async () => rows.filter(row => row[field] === value) }) }) });

test('a zero adjustment cannot block the three real KES2100 table rounds', async () => {
  const real = [1100,800,200].map((grand_total,i) => ({ id:`round${i}`,grand_total,status:'COMPLETED',synced_at:'server' }));
  const selected = await billableCheckoutRounds([real[0],marker,...real.slice(1)], { sale_lines:table([line]),payments:table([credit]) });
  assert.deepEqual(selected,real);
  assert.equal(selected.reduce((sum,sale)=>sum+sale.grand_total,0),2100);
});

test('only empty, unsynced adjustment markers are omitted; real goods, proof and paid or saved rows survive', () => {
  assert.equal(isNonBillableAdjustment(marker,[line],[credit]),true);
  for(const sale of [{...marker,grand_total:100},{...marker,synced_at:'server'},{...marker,status:'COMPLETED'}]) assert.equal(isNonBillableAdjustment(sale,[line],[credit]),false);
  for(const rows of [[{...line,product_id:'real-food'}],[{...line,unit_price:100}],[{...line,line_total:100}],[{...line,unit_price:undefined}]]) assert.equal(isNonBillableAdjustment(marker,rows,[credit]),false);
  for(const payment of [{...credit,amount:100},{...credit,settled_at:'paid'},{...credit,method:'MPESA',reference:'RECEIPT'}]) assert.equal(isNonBillableAdjustment(marker,[line],[payment]),false);
});

test('a pending bill missing positive receivables recovers debt, never a payment confirmation', () => {
  const sale={id:'bill',status:'PENDING_PAYMENT',grand_total:2100};
  for(const payments of [[],[{method:'PROFORMA',amount:0}],[{method:'CREDIT',amount:0},{method:'CASH',amount:0}]]) {
    const row=missingReceivable(sale,payments);assert.equal(row.method,'PROFORMA');assert.equal(row.amount,2100);assert.equal(row.verified,0);
  }
  assert.equal(missingReceivable(sale,[{method:'CARD',amount:100}]).amount,2000);
  for(const payments of [[{method:'PROFORMA',amount:2100}],[{method:'CREDIT',amount:0,settled_at:'paid'}],[{method:'CARD',amount:2100}]])assert.equal(missingReceivable(sale,payments),null);
  assert.equal(missingReceivable({...sale,status:'COMPLETED'},[]),null);
  assert.equal(missingReceivable({...sale,synced_at:'server'},[]),null);
});
