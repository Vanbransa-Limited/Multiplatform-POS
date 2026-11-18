import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const source = (await readFile(new URL('./customers.js', import.meta.url), 'utf8')).replace(/^import .*;\r?\n/gm, '').replaceAll('export ', '');

test('directory refresh reads cached customers in one batch and preserves local balances', async () => {
  let batchReads = 0, written;
  const docs = [{ id: 'guest', data: () => ({ tenantId: 'tenant', name: 'Guest' }) }, { id: 'retired', data: () => ({ isActive: false }) }];
  const fb = { dbInstance: null, firestore: { collection: () => 'customers', where: () => ({}), query: () => ({}), getDocs: async () => ({ docs }) } };
  const db = { customers: {
    get: () => { throw Error('Serial customer reads returned'); },
    bulkGet: async ids => { batchReads++; assert.deepEqual(ids, ['guest']); return [{ credit_balance: 250, loyalty_points: 30 }]; },
    bulkPut: async rows => { written = rows; },
  } };
  const pull = new Function('getFirebase', 'currentClaims', 'db', `${source};return pullCustomers;`)(async () => fb, async () => ({ tenant_id: 'tenant' }), db);
  assert.equal(await pull(), 1);
  assert.equal(batchReads, 1);
  assert.equal(written[0].credit_balance, 250);
  assert.equal(written[0].loyalty_points, 30);
});
