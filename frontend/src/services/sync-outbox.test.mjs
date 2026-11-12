import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

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
function drain({ transmits, sales = [{ id: 's1' }, { id: 's2' }] }) {
  const calls = [];
  // Ends at the next method, whatever it is: anchoring on a later one swept
  // publishOpenTabs into the slice and failed as a bare syntax error.
  const start = source.indexOf('  async syncOutbox()');
  const body = source
    .slice(start, source.indexOf('\n  /**', start + 1))
    .replace('async syncOutbox()', 'async function syncOutbox()');
  const syncOutbox = new Function(
    'db', 'DEMO_FISCAL', 'firebaseConfigured', 'hasTenantSession', 'awaitingTransmission', 'pullStock',
    `return ${body}`,
  )(
    { sales: { where: () => ({ equals: () => ({ filter: () => ({ toArray: async () => sales, count: async () => 0 }) }) }) } },
    false, true, async () => true, () => true,
    async () => { calls.push('pullStock'); },
  );

  return syncOutbox.call({
    isSyncing: false,
    connectionStatus: 'ONLINE',
    onStatusChange: null,
    refreshSharedOrders: async () => {},
    transmitSale: async (sale) => { calls.push(`transmit:${sale.id}`); return transmits; },
    publishOpenTabs: async () => { calls.push('publishOpenTabs'); },
  }).then(() => calls);
}

test('House balances are refreshed after the sales land, never beside them', async () => {
  // The server decrements the House inside createSale, so a refresh that runs
  // in parallel with the drain reads the balances back before they have moved
  // and the till shows a sold item still on the shelf.
  assert.deepEqual(await drain({ transmits: true }),
    ['publishOpenTabs', 'transmit:s1', 'transmit:s2', 'pullStock', 'publishOpenTabs']);
});

test('a queue that transmitted nothing does not re-read every balance', async () => {
  assert.deepEqual(await drain({ transmits: false }),
    ['publishOpenTabs', 'transmit:s1', 'transmit:s2', 'publishOpenTabs']);
});

test('open tabs are published before the drain, so a quiet till is still visible', async () => {
  // A table can open, order and settle without a single row entering the
  // outbox. Publishing only after a transmission left those floors dark.
  const calls = await drain({ transmits: false });
  assert.equal(calls[0], 'publishOpenTabs');
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
    ['publishOpenTabs', 'transmit:s2', 'transmit:s3', 'publishOpenTabs']);
});

/** buildSalePayload, lifted the same way, with its collaborators faked. */
function payloadFor({ payments, lines = [{ product_id: 'p1', qty: 1, line_total: 100 }] }) {
  const start = source.indexOf('  async buildSalePayload(');
  const body = source
    .slice(start, source.indexOf('\n  /**', start + 1))
    .replace('async buildSalePayload(', 'async function buildSalePayload(');
  assert.ok(!body.includes('await import('), 'harness is stale: buildSalePayload was not lifted cleanly');

  const table = (rows) => ({ where: () => ({ equals: () => ({ toArray: async () => rows }) }) });
  const build = new Function(
    'db', 'isReceivable', 'mapPaymentMethod', 'toMinor', 'staffDiscountAsLineDiscounts', 'TENANT_ID',
    `return ${body}`,
  )(
    { sale_lines: table(lines), payments: table(payments), shifts: { get: async () => ({ user_id: 'staff-1' }) } },
    (method) => ['CREDIT', 'PROFORMA'].includes(String(method).toUpperCase()),
    (method) => ({ CASH: 'cash', BANK: 'bank_transfer' }[String(method).toUpperCase()] || null),
    (amount) => Math.round(Number(amount) * 100),
    (rows) => rows,
    'tenant',
  );

  return build({
    id: 's1', tenant_id: 'tenant', branch_id: 'b1', device_id: 'd1',
    shift_id: 'sh1', customer_id: 'c1', sale_uuid: 'uuid-1', created_by: 'staff-1',
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
