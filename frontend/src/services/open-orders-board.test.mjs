import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const source = await readFile(new URL('./open-orders.js', import.meta.url), 'utf8');
const body = source.slice(source.indexOf('export async function pullOpenOrders(')).replace(/export /g, '');

test('shared paid sales leave Running, including free sales, while zero-value open bills remain unpaid', async () => {
  const rows = [
    { id: 'paid', kind: 'sale', totalMinor: 32000, dueMinor: 0, paymentStatus: 'unpaid' },
    { id: 'free-paid', kind: 'sale', totalMinor: 0, dueMinor: 0, paymentStatus: 'paid' },
    { id: 'free-pending', kind: 'sale', totalMinor: 0, dueMinor: 0, paymentStatus: 'unpaid' },
    { id: 'tab', kind: 'tab', totalMinor: 0, dueMinor: 0 },
    { id: 'pending', kind: 'sale', totalMinor: 32000, dueMinor: 32000, saleUuids: ['judy-round'] },
  ];
  const pull = new Function('openOrderPublisherId', 'readOpenOrders', `${body};return pullOpenOrders;`)(() => 'mine', async () => rows);
  const result = await pull('device');
  assert.deepEqual(result.map(row => row.paymentStatus), ['paid', 'paid', 'unpaid', 'unpaid', 'unpaid']);
  assert.deepEqual(result.map(row => row.status), ['completed', 'completed', 'received', 'received', 'received']);
  assert.deepEqual(result[4].saleUuids, ['judy-round']);
});

test('stale copies of the same rounds show once and one table from several tablets is one bill', async () => {
  const rows = [
    // Tamia's tablet lost its publisher id: the old row still holds her rounds.
    { id: 'old', deviceId: 'tab--old', branchId: 'b', tableNumber: '4', kind: 'tab', totalMinor: 35000, dueMinor: 35000, saleUuids: ['t1'], lines: [{ name: 'Tusker', qty: 1 }], publishedAt: 1 },
    { id: 'new', deviceId: 'tab--new', branchId: 'b', tableNumber: '4', kind: 'tab', totalMinor: 35000, dueMinor: 35000, saleUuids: ['t1'], lines: [{ name: 'Tusker', qty: 1 }], publishedAt: 5 },
    // Kester's table 9, rounds rung on three tablets.
    { id: 'k1', deviceId: 'a', branchId: 'b', tableNumber: '9', kind: 'tab', totalMinor: 35000, dueMinor: 35000, saleUuids: ['k1'], lines: [{ name: 'A', qty: 1 }], publishedAt: 3 },
    { id: 'k2', deviceId: 'c', branchId: 'b', tableNumber: 'Table 9', kind: 'sale', totalMinor: 48000, dueMinor: 48000, saleUuids: ['k2'], lines: [{ name: 'B', qty: 1 }], publishedAt: 2 },
    { id: 'k3', deviceId: 'd', branchId: 'b', tableNumber: '9', kind: 'tab', totalMinor: 8000, dueMinor: 8000, saleUuids: ['k3'], lines: [{ name: 'C', qty: 1 }], publishedAt: 4 },
    // A paid counter sale at the same table is history, not part of the bill.
    { id: 'paid', deviceId: 'a', branchId: 'b', tableNumber: '9', kind: 'sale', totalMinor: 1000, dueMinor: 0, paymentStatus: 'paid', saleUuids: ['p'], publishedAt: 3 },
  ];
  const [pull, collapse] = new Function('openOrderPublisherId', 'readOpenOrders', `${body};return [pullOpenOrders, collapseOpenOrders];`)(() => 'mine', async () => rows);
  const result = collapse(await pull('device'));
  const table4 = result.filter(row => row.tableNumber === '4');
  assert.equal(table4.length, 1);
  assert.deepEqual(table4[0].saleUuids, ['t1']);
  const table9 = result.filter(row => row.paymentStatus === 'unpaid' && /9/.test(row.tableNumber));
  assert.equal(table9.length, 1);
  assert.equal(table9[0].totalMinor, 35000 + 48000 + 8000);
  assert.equal(table9[0].dueMinor, 91000);
  assert.deepEqual([...table9[0].saleUuids].sort(), ['k1', 'k2', 'k3']);
  assert.equal(table9[0].lines.length, 3);
  assert.equal(table9[0].roundCount, 3);
  assert.equal(result.filter(row => row.paymentStatus === 'paid').length, 1);
});
