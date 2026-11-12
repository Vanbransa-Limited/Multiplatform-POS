import test from 'node:test';
import assert from 'node:assert/strict';
import { readSaleChildren, readSalesSince } from './sale-history.js';

function fakeFirestore(records = {}, failAt = -1) {
  const calls = [];
  let active = 0;
  let peak = 0;
  return { calls, get peak() { return peak; }, firestore: {
    collection: (_db, name) => name,
    where: (field, op, value) => ({ field, op, value }),
    query: (name, ...constraints) => ({ name, constraints }),
    getDocsFromServer: async query => {
      const position = calls.push(query) - 1;
      peak = Math.max(peak, ++active);
      await new Promise(resolve => setImmediate(resolve));
      active--;
      if (position === failAt) throw new Error('network unavailable');
      const matches = row => query.constraints.every(({ field, op, value }) => {
        if (op === 'in') return value.includes(row[field]);
        if (op === '==') return row[field] === value;
        if (row[field] == null || typeof row[field] !== typeof value) return false;
        return op === '>=' ? row[field] >= value : row[field] <= value;
      });
      return { docs: (records[query.name] || []).filter(matches).map(row => ({ id: row.id, data: () => row })) };
    },
  } };
}

test('related reads use only selected IDs, at most 30 per query and four concurrent requests', async () => {
  const ids = Array.from({ length: 120 }, (_, i) => `sale${i}`);
  const payments = ids.map((saleId, i) => ({ id: `p${i}`, tenantId: 'tenant', saleId }));
  const fb = fakeFirestore({ payments: [...payments,
    { id: 'old', tenantId: 'tenant', saleId: 'unselected' },
    { id: 'other', tenantId: 'other', saleId: ids[0] },
  ] });
  const result = await readSaleChildren(fb, 'tenant', 'payments', [...ids, ids[0]]);
  assert.equal(result.docs.length, 120);
  assert.equal(fb.calls.length, 4);
  assert.equal(fb.peak, 4);
  for (const query of fb.calls) {
    assert.ok(query.constraints.find(c => c.op === 'in').value.length <= 30);
    assert.deepEqual(query.constraints.find(c => c.field === 'tenantId'), { field: 'tenantId', op: '==', value: 'tenant' });
  }
});

test('broad history avoids dozens of query waves and filters the bulk result by selected sale', async () => {
  const ids = Array.from({ length: 301 }, (_, i) => `sale${i}`);
  const fb = fakeFirestore({ payments: [
    ...ids.map((saleId, i) => ({ id: `p${i}`, tenantId: 'tenant', saleId })),
    { id: 'unselected', tenantId: 'tenant', saleId: 'old-sale' },
  ] });
  const result = await readSaleChildren(fb, 'tenant', 'payments', ids);
  assert.equal(result.docs.length, 301);
  assert.equal(fb.calls.length, 1);
});

test('an empty sales selection performs no child reads and failures do not return partial success', async () => {
  const fb = fakeFirestore({}, 0);
  assert.deepEqual(await readSaleChildren(fb, 'tenant', 'sale_lines', []), { docs: [] });
  assert.equal(fb.calls.length, 0);
  await assert.rejects(readSaleChildren(fb, 'tenant', 'sale_lines', ['s1']), /network unavailable/);
});

test('history date queries include Timestamp-like Dates and legacy ISO/createdAt records, without old history', async () => {
  const since = '2026-11-01T00:00:00.000Z';
  const records = [
    { id: 'canonical', tenantId: 'tenant', soldAt: new Date(since), createdAt: new Date(since) },
    { id: 'legacy', tenantId: 'tenant', soldAt: since },
    { id: 'fallback', tenantId: 'tenant', createdAt: since },
    { id: 'old', tenantId: 'tenant', soldAt: '2025-01-01T00:00:00.000Z' },
    { id: 'foreign', tenantId: 'other', soldAt: since },
  ];
  const fb = fakeFirestore({ sales: records });
  const result = await readSalesSince(fb, 'tenant', since);
  assert.deepEqual(result.docs.map(d => d.id).sort(), ['canonical', 'fallback', 'legacy']);
  assert.equal(fb.calls.length, 4);
  for (const query of fb.calls) assert.equal(query.constraints.length, 3);
  await assert.rejects(readSalesSince(fb, 'tenant', 'invalid'), /valid sales history/);
});
