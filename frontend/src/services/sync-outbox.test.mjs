import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { isNonBillableAdjustment, missingReceivable } from './checkout-rounds.js';

// sync.js reaches for Dexie through a bundler-resolved path, so the predicate
// is lifted out of the source the same way pullSales is in financial-sync.
const source = (await readFile(new URL('./sync.js', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
const body = source.slice(
  source.indexOf('export function awaitingTransmission('),
  source.indexOf('export class SyncManager'),
).replace('export function', 'function');
const awaitingTransmission = new Function(`${body}; return awaitingTransmission;`)();

const now = Date.parse('2026-09-11T10:00:00.000Z');
const held = new Date(now + 60_000).toISOString();
const lapsed = new Date(now - 60_000).toISOString();

test('Pay Now orders publish immediately even with a tab or checkout lease', () => {
  assert.equal(awaitingTransmission({ status: 'PENDING_PAYMENT', synced_at: null, server_pending: true, tab_id: 'tab1', held_until: held }, now), true);
  assert.equal(awaitingTransmission({ status: 'VOIDED', server_pending: true }, now), false);
  assert.equal(awaitingTransmission({ synced_at: 'already-saved', server_pending: true }, now), false);
});

test('a till working an order keeps it; a lapsed lease lets it go', () => {
  const sale = { id: 's1', synced_at: null, status: 'PENDING_PAYMENT' };

  // Still being worked at the till: it settles there and goes up once, paid.
  assert.equal(awaitingTransmission({ ...sale, held_until: held }, now), false);
  // Abandoned mid-checkout: it goes up as the receivable it is, so an owner
  // can see it and any till can settle or void it.
  assert.equal(awaitingTransmission({ ...sale, held_until: lapsed }, now), true);
  assert.equal(awaitingTransmission({ ...sale, held_until: null }, now), true);
});

test('unpaid tab rounds transmit as shared receivables before another device takes payment', () => {
  const round = { id: 's1', synced_at: null, tab_id: 'tab-1', status: 'PENDING_PAYMENT' };
  assert.equal(awaitingTransmission({ ...round, held_until: null }, now), true);
  assert.equal(awaitingTransmission({ ...round, held_until: lapsed }, now), true);

  // What settleRoundLocally leaves behind: paid, so it belongs on the server.
  const settled = { ...round, status: 'COMPLETED', held_until: null };
  assert.equal(awaitingTransmission(settled, now), true);
});

test('voided orders never transmit, and transmitted ones are not resent', () => {
  const sale = { id: 's1', synced_at: null };

  assert.equal(awaitingTransmission({ ...sale, status: 'COMPLETED' }, now), true);
  // Nothing to withdraw if it never went up; a synced one uses voidSale.
  assert.equal(awaitingTransmission({ ...sale, status: 'VOIDED' }, now), false);
  assert.equal(awaitingTransmission({ ...sale, status: 'VOIDED', held_until: lapsed }, now), false);
  // Already transmitted.
  assert.equal(awaitingTransmission({ ...sale, status: 'COMPLETED', synced_at: '2026-09-11T09:00:00.000Z' }, now), false);
  // A row written before sales carried a status or a lease is still a sale.
  assert.equal(awaitingTransmission({ id: 's2', synced_at: undefined }, now), true);
});

/** The drain itself, lifted out the same way, with its collaborators faked. */
function drain({ transmits, sales = [{ id: 's1' }, { id: 's2' }], refresh = async () => {}, onTransmit = () => {} }) {
  const calls = [];
  // Ends at the next method, whatever it is: anchoring on a later one swept
  // publishOpenTabs into the slice and failed as a bare syntax error.
  const start = source.indexOf('  async syncOutbox()');
  const body = source
    .slice(start, source.indexOf('\n  /**', start + 1))
    .replace('async syncOutbox()', 'async function syncOutbox()');
  const syncOutbox = new Function(
    'db', 'firebaseConfigured', 'hasTenantSession', 'awaitingTransmission', 'pullStock', 'readWithDeadline',
    `return ${body}`,
  )(
    { sales: { where: () => ({ equals: () => ({ filter: () => ({ toArray: async () => sales, count: async () => 0 }) }) }) } },
    true, async () => true, () => true,
    async () => { calls.push('pullStock'); },
    async read => read(),
  );

  return syncOutbox.call({
    isSyncing: false,
    connectionStatus: 'ONLINE',
    onStatusChange: null,
    refreshSharedOrders: refresh,
    transmitSale: async (sale) => { calls.push(`transmit:${sale.id}`); onTransmit(sale); return transmits; },
    publishOpenTabs: async () => { calls.push('publishOpenTabs'); },
  }).then(() => calls);
}

test('House balances are refreshed after the sales land, never beside them', async () => {
  // The server decrements the House inside createSale, so a refresh that runs
  // in parallel with the drain reads the balances back before they have moved
  // and the till shows a sold item still on the shelf.
  assert.deepEqual(await drain({ transmits: true }),
    ['transmit:s1', 'transmit:s2', 'pullStock', 'publishOpenTabs']);
});

test('a queue that transmitted nothing does not re-read every balance', async () => {
  assert.deepEqual(await drain({ transmits: false }),
    ['transmit:s1', 'transmit:s2', 'publishOpenTabs']);
});

test('a stalled shared-order read cannot prevent paid sales from uploading', async () => {
  let finish;
  const waiting = new Promise(resolve => { finish = resolve; });
  const uploaded = [];
  const run = drain({ transmits: true, refresh: () => waiting, onTransmit: sale => uploaded.push(sale.id) });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(uploaded, ['s1', 's2']);
  finish();
  await run;
});

test('open tabs are published even when a quiet till has no queued sales', async () => {
  // A table can open, order and settle without a single row entering the
  // outbox. Publishing only after a transmission left those floors dark.
  const calls = await drain({ transmits: false, sales: [] });
  assert.deepEqual(calls, ['publishOpenTabs']);
  // And again afterwards, because settling is what closes a tab on every
  // other screen.
  assert.equal(calls.at(-1), 'publishOpenTabs');
});

test('a refused sale waits out its retry time instead of going up every tick', async () => {
  // One till resent ten refused M-Pesa sales every 10 s for days: ~68,000
  // createSale calls a day, each reading Firestore before refusing again.
  const later = new Date(Date.now() + 60_000).toISOString();
  const earlier = new Date(Date.now() - 60_000).toISOString();
  assert.deepEqual(await drain({ transmits: false, sales: [{ id: 's1', sync_retry_after: later }, { id: 's2', sync_retry_after: earlier }, { id: 's3' }] }),
    ['transmit:s2', 'transmit:s3', 'publishOpenTabs']);
});

/** buildSalePayload, lifted the same way, with its collaborators faked. */
function payloadFor({ payments, lines = [{ product_id: 'p1', qty: 1, line_total: 100 }], sale = {}, saved = [] }) {
  const start = source.indexOf('  async buildSalePayload(');
  const body = source
    .slice(start, source.indexOf('\n  /**', start + 1))
    .replace('async buildSalePayload(', 'async function buildSalePayload(');
  assert.ok(!body.includes('await import('), 'harness is stale: buildSalePayload was not lifted cleanly');

  const table = (rows) => ({ where: () => ({ equals: () => ({ toArray: async () => rows }) }) });
  const build = new Function(
    'db', 'isReceivable', 'mapPaymentMethod', 'toMinor', 'staffDiscountAsLineDiscounts', 'TENANT_ID', 'isNonBillableAdjustment', 'missingReceivable',
    `return ${body}`,
  )(
    { sale_lines: table(lines), payments: { ...table(payments), put: async row => saved.push(row) }, shifts: { get: async () => ({ user_id: 'staff-1' }) } },
    (method) => ['CREDIT', 'PROFORMA'].includes(String(method).toUpperCase()),
    (method) => ({ CASH: 'cash', BANK: 'bank_transfer', PROFORMA: 'credit', CREDIT: 'credit' }[String(method).toUpperCase()] || null),
    (amount) => Math.round(Number(amount) * 100),
    (rows) => rows,
    'tenant',
    isNonBillableAdjustment, missingReceivable,
  );

  return build({
    id: 's1', tenant_id: 'tenant', branch_id: 'b1', device_id: 'd1',
    shift_id: 'sh1', customer_id: 'c1', sale_uuid: 'uuid-1', created_by: 'staff-1',
    ...sale,
  });
}

test('a zero-amount tender never reaches the server, and never strands the real ones beside it', async () => {
  // A round on a tab that owed nothing was still written a zero settlement.
  // The server refuses the whole invoice on it - "amountMinor must be a
  // positive safe integer" - so every real tender on that sale stayed on the
  // till, unseen by the business.
  const mixed = await payloadFor({ payments: [
    { method: 'BANK', amount: 100, reference: '79980' },
    { method: 'CASH', amount: 0 },
  ] });
  assert.equal(mixed.payments.length, 1, 'the zero is dropped');
  assert.deepEqual(mixed.payments[0], { method: 'bank_transfer', amountMinor: 10000, reference: '79980' });

  // Nothing but zeroes is not a sale worth submitting; it stays queued rather
  // than being rejected in a loop.
  assert.equal(await payloadFor({ payments: [{ method: 'CASH', amount: 0 }] }), null);

  // A settled receivable is not sent; the tender that cleared it is.
  const settled = await payloadFor({ payments: [
    { method: 'CREDIT', amount: 100, settled_at: 'then' },
    { method: 'BANK', amount: 100, reference: '79980' },
  ] });
  assert.equal(settled.payments.length, 1);
  assert.equal(settled.payments[0].method, 'bank_transfer');
});

test('an unpaid KES2100 bill with zero credit uploads its recovered debt once', async () => {
  const saved=[];
  const payload=await payloadFor({payments:[{method:'CREDIT',amount:0}],sale:{status:'PENDING_PAYMENT',grand_total:2100},saved});
  assert.equal(saved.length,1);
  assert.equal(saved[0].amount,2100);
  assert.deepEqual(payload.payments,[{method:'credit',amountMinor:210000,reference:undefined}]);
  const retried=await payloadFor({payments:[{method:'CREDIT',amount:0},...saved],sale:{status:'PENDING_PAYMENT',grand_total:2100},saved});
  assert.equal(saved.length,1);
  assert.deepEqual(retried.payments,payload.payments);
});

test('an empty discount round is never uploaded as a zero-value sale', async () => {
  const payload=await payloadFor({payments:[{method:'CREDIT',amount:0}],sale:{status:'PENDING_PAYMENT',grand_total:0},
    lines:[{product_id:'prod-staff-discount',qty:1,unit_price:0,line_total:0}]});
  assert.equal(payload,null);
  assert.equal(awaitingTransmission({sync_omitted:'adjustment_only',sync_pending:1,server_pending:true}),false);
});

test('overlapping uploads cannot use another round’s omission state to drop a real bill', async () => {
  const start=source.indexOf('  async transmitSale(');
  const body=source.slice(start,source.indexOf('\n  startSyncScheduler()',start)).replace('async transmitSale(','async function transmitSale(');
  for(const marker of [true,false]) {
    const sale={id:'bill',status:'PENDING_PAYMENT',grand_total:marker?0:2100,sync_pending:1};
    const lines=[{product_id:marker?'prod-staff-discount':'real-food',unit_price:marker?0:2100,line_total:marker?0:2100}];
    const updates=[];
    const table=rows=>({where:()=>({equals:()=>({toArray:async()=>rows})})});
    const db={sales:{update:async(id,patch)=>updates.push(patch)},sale_lines:table(lines),payments:table([{method:'CREDIT',amount:0}])};
    const run=new Function('db','firebaseConfigured','isNonBillableAdjustment',`return ${body}`)(db,true,isNonBillableAdjustment);
    assert.equal(await run.call({buildSalePayload:async()=>null,skipTransmissionReason:'adjustment_only',incompleteReason:'its payments are all zero'},sale),false);
    if(marker)assert.equal(updates[0].sync_omitted,'adjustment_only');
    else {assert.equal(updates[0].fiscal_status,'NEEDS_REVIEW');assert.equal(updates[0].sync_omitted,undefined);assert.equal(updates[0].sync_pending,undefined);}
  }
});

test('a round held because its tab was released is never resent', () => {
  const round = { id: 'late', status: 'PENDING_PAYMENT', synced_at: null, tab_id: 'released-tab', server_pending: true };
  assert.equal(awaitingTransmission(round, now), true);
  assert.equal(awaitingTransmission({ ...round, sync_hold: 'table_released' }, now), false);
});

test('the outbox pulls an audited missing-item recovery into the original row without creating another sale', async () => {
  const start = source.indexOf('  async transmitSale(');
  const body = source.slice(start, source.indexOf('\n  startSyncScheduler()', start))
    .replace('async transmitSale(', 'async function transmitSale(')
    .replace("const { pullSales } = await import('./catalogue');", 'const pullSales = restore;');
  const sale = { id: 'local', sale_uuid: 'original-uuid', grand_total: 350, status: 'PENDING_PAYMENT' };
  const patches = []; let restored = false;
  const db = { sales: { get: async () => ({ ...sale, synced_at: restored ? 'server' : null }), update: async (_id, patch) => patches.push(patch) },
    sale_lines: { where: () => ({ equals: () => ({ toArray: async () => [], count: async () => restored ? 1 : 0 }) }) },
    payments: { where: () => ({ equals: () => ({ toArray: async () => [{ method: 'CREDIT', amount: 350 }] }) }) } };
  const run = new Function('db', 'firebaseConfigured', 'restore', 'readWithDeadline', 'callFunction', `return ${body}`)(db, true,
    async (_since, uuids) => { assert.deepEqual(uuids, ['original-uuid']); restored = true; }, async read => read(),
    () => { throw Error('Recovery must never create another sale'); });
  assert.equal(await run.call({ buildSalePayload: async () => null }, sale), true);
  assert.equal(patches.at(-1).sync_error_msg, null);
});
