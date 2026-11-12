import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const source = await readFile(new URL('./open-orders.js', import.meta.url), 'utf8');
const body = source.slice(source.indexOf('export async function pullOpenOrders(')).replace('export async function', 'async function');

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
