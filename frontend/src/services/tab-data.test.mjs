import test from 'node:test';
import { withServerSessions } from './table-sessions.js';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { tabsWithTotals, tabOwes, closingUpdate, OPEN } from './tabs.js';
import { saleAsOrder } from './customer-orders.js';
import { billableCheckoutRounds } from './checkout-rounds.js';

const source = (await readFile(new URL('./tab-edit.js', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
const readBody = source.slice(source.indexOf('export async function readOpenTabs('), source.indexOf('/**\n * Frees a table'))
  .replace('export async function', 'async function');
const freeBody = source.slice(source.indexOf('export async function freeSettledTab(')).replace('export async function', 'async function');

function setup() {
  const rows = {
    tabs: [
      { id: 'open', status: OPEN, branch_id: 'b1', table_no: '1' },
      { id: 'closed', status: 'SETTLED', branch_id: 'b1' },
      { id: 'other', status: OPEN, branch_id: 'b2' },
    ],
    sales: [
      { id: 's1', tab_id: 'open', branch_id: 'b1', status: 'PENDING_PAYMENT', grand_total: 100 },
      { id: 's2', tab_id: 'open', branch_id: 'b1', status: 'COMPLETED', grand_total: 200 },
      { id: 'old', tab_id: 'closed', branch_id: 'b1', status: 'COMPLETED', grand_total: 1000 },
    ],
    payments: [
      { id: 'p1', sale_id: 's1', method: 'PROFORMA', amount: 100 },
      { id: 'p2', sale_id: 's2', method: 'CASH', amount: 200 },
      { id: 'old', sale_id: 'old', method: 'CASH', amount: 1000 },
    ],
    products: [{ id: 'beer', name: 'Beer' }],
    sale_lines: [{ id: 'l1', sale_id: 's1', product_id: 'beer', qty: 2 }, { id: 'l2', sale_id: 's2', qty: 3 }],
  };
  const calls = [];
  const db = Object.fromEntries(Object.entries(rows).map(([name, data]) => [name, {
    toArray: () => { throw new Error(`Whole-history ${name} scan`); },
    get: async id => data.find(row => row.id === id),
    bulkGet: async ids => ids.map(id => data.find(row => row.id === id)),
    update: async (id, changes) => Object.assign(data.find(row => row.id === id), changes),
    where: field => {
      const fields = field.startsWith('[') ? field.slice(1, -1).split('+') : [field];
      const keyOf = row => fields.length === 1 ? row[field] : fields.map(key => row[key]);
      const select = predicate => ({
        filter: filter => ({ toArray: async () => { calls.push(name); return data.filter(row => predicate(keyOf(row)) && filter(row)); } }),
        toArray: async () => { calls.push(name); return data.filter(row => predicate(keyOf(row))); },
      });
      return {
        equals: value => select(key => JSON.stringify(key) === JSON.stringify(value)),
        anyOf: values => select(key => values.includes(key)),
      };
    },
  }]));
  db.transaction = async (_mode, _tables, run) => run();
  return { rows, calls,
    // Server tabs unknown (offline): the local view is what these tests pin down.
    read: new Function('db', 'saleAsOrder', 'tabsWithTotals', 'OPEN', 'serverTableSessions', 'withServerSessions', `${readBody}; return readOpenTabs;`)(db, saleAsOrder, tabsWithTotals, OPEN, async () => null, withServerSessions),
    free: new Function('db', 'saleAsOrder', 'tabOwes', 'closingUpdate', 'OPEN', 'state', 'billableCheckoutRounds', `${freeBody}; return freeSettledTab;`)(db, saleAsOrder, tabOwes, closingUpdate, OPEN, { currentUser: { id: 'staff' } }, billableCheckoutRounds),
  };
}

test('open tabs follow indexes and retain unpaid totals, quantities and branch boundaries', async () => {
  const { read } = setup();
  const tabs = await read('b1');
  assert.equal(tabs.length, 1);
  assert.equal(tabs[0].dueMinor, 10_000);
  assert.equal(tabs[0].items, 2);
  assert.equal(tabs[0].unpaidRounds[0].lines[0].name, 'Beer');
  assert.equal(tabs[0].rounds.length, 2);
  assert.equal((await read()).length, 2);
});

test('no open tabs or unpaid table rounds means no child reads', async () => {
  const { rows, read, calls } = setup();
  rows.tabs.length = 0;
  assert.deepEqual(await read('b1'), []);
  assert.deepEqual(calls, ['tabs', 'sales']);
});

test('an unpaid saved round remains visible when its tab header is missing or incorrectly settled', async () => {
  for (const missing of [true, false]) {
    const { rows, read } = setup();
    rows.sales[0].table_no = '20';
    if (missing) rows.tabs.shift(); else rows.tabs[0].status = 'SETTLED';
    const tabs = await read('b1');
    assert.equal(tabs.length, 1);
    assert.equal(tabs[0].table, '20');
    assert.equal(tabs[0].recoveryRequired, true);
    assert.equal(tabs[0].dueMinor, 10_000);
  }
});

test('an explicitly written-off CLOSED tab is never reopened by recovery visibility', async () => {
  const { rows, read } = setup();
  rows.sales[0].table_no = '20';
  rows.tabs[0].status = 'CLOSED';
  assert.deepEqual(await read('b1'), []);
});

test('closing a tab queries only its rounds and does not close unpaid tables', async () => {
  const { rows, free } = setup();
  assert.equal(await free('open'), null);
  rows.payments[0].settled_at = '2026-11-07';
  assert.equal(await free('open'), '1');
  assert.equal(rows.tabs[0].status, 'SETTLED');
});

test('a preserved empty discount marker does not keep a fully paid table occupied', async () => {
  const { rows, free } = setup();
  rows.payments[0].settled_at = 'paid';
  rows.sales.push({id:'marker',tab_id:'open',status:'PENDING_PAYMENT',grand_total:0});
  rows.sale_lines.push({id:'marker-line',sale_id:'marker',product_id:'prod-staff-discount',unit_price:0,line_total:0,qty:1});
  rows.payments.push({id:'marker-credit',sale_id:'marker',method:'PROFORMA',amount:0});
  assert.equal(await free('open'),'1');
  assert.equal(rows.sales.find(row=>row.id==='marker').status,'PENDING_PAYMENT','source is preserved, never labelled paid');
});
