import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { readSaleChildren, readSalesSince } from './sale-history.js';

const source = (await readFile(new URL('./catalogue.js', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
const body = source.slice(source.indexOf('export async function pullSales('), source.indexOf('/**\n * Refreshes who this business'))
  .replace('export async function', 'async function')
  .replace("const { getFirebase } = await import('./firebase.js');", 'const { getFirebase } = dependencies;')
  // The tenant now comes from the signed-in claim rather than a build-time
  // constant, so the harness supplies it the same way it supplies the rest.
  .replace('const tenantId = await activeTenantId();', 'const tenantId = dependencies.TENANT_ID;')
  .replace("const { readSaleChildren, readSalesSince } = await import('./sale-history.js');", 'const { readSaleChildren, readSalesSince } = dependencies;')
  .replace("const { db } = await import('../db/schema');", 'const { db } = dependencies;');
// This harness rewrites pullSales' source, so a rename in catalogue.js silently
// leaves a real import in the extracted body and the failure surfaces as a
// baffling assertion about item detail. Fail on the actual cause instead.
for (const leftover of ["await import('./firebase.js')", 'await activeTenantId()', "await import('../db/schema')"]) {
  assert.ok(!body.includes(leftover), `financial-sync harness is stale: "${leftover}" was not substituted. Update the replacements to match catalogue.js.`);
}
const makePull = new Function('dependencies', body + '; return pullSales;');
function table(initial = []) {
  const rows = new Map(initial.map(row => [row.id, row]));
  return { rows, toArray: async () => [...rows.values()],
    bulkPut: async values => values.forEach(row => rows.set(row.id, row)),
    update: async (id, value) => rows.set(id, { ...rows.get(id), ...value }),
    where: field => ({
      equals: value => ({ toArray: async () => [...rows.values()].filter(row => row[field] === value) }),
      anyOf: values => ({ toArray: async () => [...rows.values()].filter(row => values.includes(row[field])) }),
    }) };
}
function setup(local = false) {
  const records = {
    sales: [{ id: 'server', tenantId: 'tenant', idempotencyKey: 'uuid', soldAt: '2026-09-09T12:00:00Z', totalMinor: 10000, status: 'completed' }],
    payments: [{ id: 'credit', saleId: 'server', method: 'credit', amountMinor: 10000 }],
    sale_lines: [{ id: 'line', saleId: 'server', productName: 'Tea', qty: 2, lineTotalMinor: 10000 }],
  };
  const db = { sales: table(local ? [{ id: 'local', sale_uuid: 'uuid' }] : []), payments: table(local ? [{ id: 'local-credit', sale_id: 'local', method: 'PROFORMA', amount: 100 }] : []), sale_lines: table() };
  db.transaction = async (_mode, _tables, run) => run();
  const fb = { firestore: { collection: (_, name) => name, where: (field, op, value) => ({ field, op, value }), query: (name, ...constraints) => ({ name, constraints }),
    getDocsFromServer: async ({ name, constraints }) => ({ docs: records[name]
      .filter(row => constraints.every(c => {
        if (c.field === 'tenantId') return true;
        const value = row[c.field];
        if (c.op === 'in') return c.value.includes(value);
        if (c.op === '==') return value === c.value;
        if (typeof value !== typeof c.value || value == null) return false;
        return c.op === '>=' ? value >= c.value : value <= c.value;
      }))
      .map(row => ({ id: row.id, data: () => row })) }) } };
  return { db, records, pull: makePull({ db, TENANT_ID: 'tenant', getFirebase: async () => fb, readSaleChildren, readSalesSince }) };
}
test('owner refresh keeps remote payment settlement current and imports item detail once', async () => {
  const { db, records, pull } = setup();
  await pull('2026-09-09');
  assert.equal(db.sale_lines.rows.get('line').product_name, 'Tea');
  records.payments[0].settledAt = '2026-09-09T13:00:00Z';
  records.payments.push({ id: 'settlement', saleId: 'server', source: 'sale_settlement', method: 'cash', amountMinor: 10000 });
  await pull('2026-09-09');
  await pull('2026-09-09');
  assert.equal(db.sales.rows.size, 1);
  assert.equal(db.sale_lines.rows.size, 1);
  assert.equal(db.payments.rows.size, 2);
  assert.ok(db.payments.rows.get('credit').settled_at);
  assert.equal(db.payments.rows.get('settlement').amount, 100);
});
test('selling device refresh preserves local ids without duplicating tender', async () => {
  const { db, records, pull } = setup(true);
  await pull('2026-09-09');
  records.payments[0].settledAt = '2026-09-09T13:00:00Z';
  records.payments.push({ id: 'settlement', saleId: 'server', source: 'sale_settlement', method: 'cash', amountMinor: 10000 });
  await pull('2026-09-09');
  assert.equal(db.sales.rows.size, 1);
  assert.equal(db.payments.rows.size, 2);
  assert.ok(db.payments.rows.get('local-credit').settled_at);
  assert.equal(db.payments.rows.get('settlement').sale_id, 'local');
});

test('targeted shared-order refresh imports old unpaid rounds and retains table identity', async () => {
  const { db, records, pull } = setup();
  Object.assign(records.sales[0], { soldAt: '2025-01-01T00:00:00Z', tabId: 'judy-tab', orderReference: 'ORD-709', tableNumber: '709' });
  await pull(undefined, ['uuid']);
  assert.equal(db.sales.rows.get('server').tab_id, 'judy-tab');
  assert.equal(db.sales.rows.get('server').order_reference, 'ORD-709');
  assert.equal(db.payments.rows.get('credit').amount, 100);
});

test('old sales and their children are excluded before local writes', async () => {
  const { db, records, pull } = setup();
  records.sales.push({ id: 'old-sale', tenantId: 'tenant', soldAt: '2025-01-01T00:00:00Z' });
  records.payments.push({ id: 'old-payment', saleId: 'old-sale', method: 'cash', amountMinor: 100 });
  records.sale_lines.push({ id: 'old-line', saleId: 'old-sale', productName: 'Old', qty: 1 });
  await pull('2026-09-09');
  assert.equal(db.sales.rows.size, 1);
  assert.equal(db.payments.rows.size, 1);
  assert.equal(db.sale_lines.rows.size, 1);
});

test('unchanged sales are not rewritten on another refresh', async () => {
  const { db, pull } = setup();
  await pull('2026-09-09');
  let writes = 0;
  const update = db.sales.update;
  db.sales.update = async (...args) => { writes++; return update(...args); };
  await pull('2026-09-09');
  assert.equal(writes, 0);
});

test('legacy timezone offsets are normalized before applying the date cutoff', async () => {
  const { db, records, pull } = setup();
  records.sales.push({ id: 'offset', tenantId: 'tenant', soldAt: '2026-09-08T23:00:00-02:00' });
  await pull('2026-09-09');
  assert.equal(db.sales.rows.get('offset').sold_at, '2026-09-09T01:00:00.000Z');
});

