// Real Chromium IndexedDB verification, isolated from POS and Firebase data.
// Run: node frontend/e2e/performance-check.mjs
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { chromium } from '@playwright/test';
import { saleAsOrder } from '../src/services/customer-orders.js';
import { tabsWithTotals } from '../src/services/tabs.js';
import { isReceivable } from '../src/services/takings.js';
import { toMinor } from '../src/services/tender.js';

const checkoutSource = (await readFile(new URL('../src/services/checkout-rounds.js', import.meta.url), 'utf8'))
  .replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '');

const schema = (await readFile(new URL('../src/db/schema.js', import.meta.url), 'utf8'))
  .replace(/\r\n/g, '\n').replace(/^import .*;\n/gm, '').replace('export const db', 'const db')
  .replace(/^/, "const cacheName = () => 'POS_DB'; const selectedCacheTenant = () => 'tenant';\n");
const heldSource = (await readFile(new URL('../src/services/open-orders.js', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
// Includes heldOrdersSnapshot, which localHeldOrders delegates to.
const heldStart = heldSource.indexOf('export async function localHeldOrders(');
const heldBody = heldSource.slice(heldStart, heldSource.indexOf('/**\n * Publishes', heldStart))
  .replace('export async function', 'async function');
const tabSource = (await readFile(new URL('../src/services/tab-edit.js', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
const tabBody = tabSource.slice(tabSource.indexOf('export async function readOpenTabs('), tabSource.indexOf('/**\n * Frees a table'))
  .replace('export async function', 'async function');
const server = createServer((_req, res) => res.end('<!doctype html><title>Isolated performance test</title>'));
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  console.log('Launching isolated Chromium test...');
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  page.on('console', message => console.log(message.text()));
  page.setDefaultTimeout(60_000);
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.addScriptTag({ path: new URL('../node_modules/dexie/dist/dexie.js', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1') });
  const result = await page.evaluate(async ({ schema, heldBody, tabBody, asOrderSource, tabTotalsSource, receivableSource, checkoutSource, minorSource }) => {
    const receivable = new Function('RECEIVABLE_METHODS', `return (${receivableSource});`)(new Set(['CREDIT', 'PROFORMA']));
    const billableCheckoutRounds = new Function('isReceivable', 'toMinor', `${checkoutSource}; return billableCheckoutRounds;`)(
      receivable, new Function(`return (${minorSource});`)(),
    );
    const asOrder = new Function('SALE_STATUS', 'isReceivable', `return (${asOrderSource});`)(
      new Map([['PENDING_PAYMENT', 'awaiting_payment'], ['VOIDED', 'cancelled']]),
      new Function('RECEIVABLE_METHODS', `return (${receivableSource});`)(new Set(['CREDIT', 'PROFORMA'])),
    );
    const totals = new Function('OPEN', `return (${tabTotalsSource});`)('OPEN');
    console.log('Creating version 6 history...');
    const oldSchema = schema.slice(0, schema.indexOf('// IndexedDB does not index'));
    const oldDb = new Function(`${oldSchema}; return db;`)();
    await oldDb.open();
    const count = 20_000;
    const historical = Array.from({ length: count }, (_, i) => ({ id: `s${i}`, synced_at: '2026-11-01', status: 'COMPLETED' }));
    await oldDb.sales.bulkPut([...historical,
      { id: 'pending', customer_id: 'guest', tab_id: 'tab', branch_id: 'b1', status: 'PENDING_PAYMENT', grand_total: 10 },
      { id: 'null', synced_at: null, status: 'COMPLETED' },
      { id: 'void', status: 'VOIDED' },
    ]);
    await oldDb.sale_lines.bulkPut(historical.map(s => ({ id: `l${s.id}`, sale_id: s.id, qty: 1 })));
    await oldDb.payments.bulkPut(historical.map(s => ({ id: `p${s.id}`, sale_id: s.id, method: 'CASH', amount: 1 })));
    await oldDb.sale_lines.put({ id: 'held-line', sale_id: 'pending', product_id: 'tea', qty: 2 });
    await oldDb.payments.put({ id: 'held-payment', sale_id: 'null', method: 'CASH', amount: 10 });
    await oldDb.payments.put({ id: 'receivable', sale_id: 'pending', method: 'PROFORMA', amount: 10 });
    await oldDb.tabs.put({ id: 'tab', branch_id: 'b1', status: 'OPEN' });
    await oldDb.products.put({ id: 'tea', name: 'Tea' });
    await oldDb.customers.put({ id: 'guest', name: 'Guest' });
    oldDb.close();

    console.log('Upgrading queue index...');

    const db = new Function(`${schema}; return db;`)();
    const start = performance.now();
    await db.open();
    const migrationMs = performance.now() - start;
    const migrated = await db.sales.where('sync_pending').equals(1).count();
    const total = await db.sales.count();
    console.log('Verifying writers and query results...');
    await db.sales.add({ id: 'new', status: 'COMPLETED' });
    const inserted = (await db.sales.get('new')).sync_pending;
    await db.sales.update('new', { synced_at: '2026-11-07' });
    const synced = (await db.sales.get('new')).sync_pending;
    await db.sales.put({ id: 'new', synced_at: null });
    const replaced = (await db.sales.get('new')).sync_pending;
    await db.sales.update('new', { held_until: '2026-11-08' });
    const unrelatedUpdate = (await db.sales.get('new')).sync_pending;
    await db.sales.bulkPut([{ id: 'new', synced_at: '2026-11-07' }, { id: 'import', synced_at: '2026-11-07' }]);
    const imported = (await db.sales.get('import')).sync_pending;

    const timed = async fn => { const t = performance.now(); const value = await fn(); return { ms: performance.now() - t, count: value.length }; };
    const before = await timed(() => db.sales.filter(s => s.synced_at == null && s.status !== 'VOIDED').toArray());
    const after = await timed(() => db.sales.where('sync_pending').equals(1).filter(s => s.status !== 'VOIDED').toArray());
    const tabBefore = await timed(async () => {
      const [sales, payments, lines, tabs] = await Promise.all([
        db.sales.toArray(), db.payments.toArray(), db.sale_lines.toArray(), db.tabs.toArray(),
      ]);
      const ledger = new Map();
      const bySale = new Map();
      for (const p of payments) ledger.set(p.sale_id, [...(ledger.get(p.sale_id) || []), p]);
      for (const line of lines) bySale.set(line.sale_id, [...(bySale.get(line.sale_id) || []), { qty: line.qty }]);
      return totals(tabs, sales.filter(s => s.branch_id === 'b1').map(s => ({
        ...asOrder(s, { payments: ledger.get(s.id), lines: bySale.get(s.id) || [] }), tabId: s.tab_id || null,
      })));
    });
    // Any accidental return to whole-table child reads makes this test fail.
    db.sale_lines.toArray = db.payments.toArray = db.sales.toArray = () => { throw new Error('Historical full-table read'); };
    const readOpenTabs = new Function('db', 'saleAsOrder', 'tabsWithTotals', 'OPEN', `${tabBody}; return readOpenTabs;`)(db, asOrder, totals, 'OPEN');
    const tabAfter = await timed(() => readOpenTabs('b1'));
    const openTabs = await readOpenTabs('b1');
    if (openTabs[0]?.dueMinor !== 1000 || openTabs[0]?.items !== 2) throw new Error('Open tab totals changed');
    const localHeldOrders = new Function('db', 'saleAsOrder', 'billableCheckoutRounds', `${heldBody}; return localHeldOrders;`)(db, asOrder, billableCheckoutRounds);
    const held = await localHeldOrders();
    console.log('Verifying queue drain...');
    await db.sales.where('sync_pending').equals(1).modify({ synced_at: '2026-11-07' });
    const empty = await localHeldOrders();
    const cleared = await db.sales.where('sync_pending').equals(1).count();
    db.close();
    await Dexie.delete('POS_DB');
    return { total, migrated, inserted, synced, replaced, unrelatedUpdate, imported, cleared, migrationMs, before, after, tabBefore, tabAfter, held, empty };
  }, { schema, heldBody, tabBody, asOrderSource: saleAsOrder.toString(), tabTotalsSource: tabsWithTotals.toString(), receivableSource: isReceivable.toString(), checkoutSource, minorSource: toMinor.toString() });
  assert.equal(result.total, 20_003);
  assert.equal(result.migrated, 3);
  assert.equal(result.inserted, 1);
  assert.equal(result.synced, 0);
  assert.equal(result.replaced, 1);
  assert.equal(result.unrelatedUpdate, 1);
  assert.equal(result.imported, 0);
  assert.equal(result.cleared, 0);
  assert.equal(result.before.count, result.after.count);
  assert.equal(result.held.length, 2);
  assert.equal(result.held.find(o => o.key === 'tab').lines[0].name, 'Tea');
  assert.equal(result.held.find(o => o.key === 'null').payments[0].amountMinor, 1000);
  assert.deepEqual(result.empty, []);
  console.log(JSON.stringify({ ...result, held: 'verified', empty: 'verified' }, null, 2));
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
