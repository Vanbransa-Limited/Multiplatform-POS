const test = require('node:test');
const assert = require('node:assert/strict');
const { addRoundStaffDiscount } = require('../lib/modules/sales/add-round-discount');
const { db } = require('../lib/lib/firebase');
const { deterministicId } = require('../lib/shared/identifiers');

const waiter = { uid: 'w', token: { tenant_id: 'tenant', staff_id: 'judith', staff_role: 'cashier' } };
const manager = { uid: 'm', token: { tenant_id: 'tenant', staff_id: 'grace', staff_role: 'manager' } };
const saleId = deterministicId('sale', 'tenant:round-mbuzi');

function harness() {
  const docs = new Map([
    [`sales/${saleId}`, { tenantId: 'tenant', status: 'completed', invoiceNumber: 'INV-1', discountMinor: 0, totalMinor: 50000, lineIds: [`${saleId}_line_01`] }],
    [`sale_lines/${saleId}_line_01`, { saleId, productId: 'mbuzi', qty: 1, unitPriceMinor: 50000, discountMinor: 0, taxCode: 'A', lineTotalMinor: 50000 }],
    [`payments/${saleId}_payment_01`, { saleId, method: 'credit', amountMinor: 50000, status: 'completed' }],
    ['discount_approvals/ok', { tenantId: 'tenant', requestedByStaffId: 'judith', approvedByStaffId: 'grace', expiresAtMs: Date.now() + 60_000, consumedSaleId: null }],
  ]);
  const original = { collection: db.collection, runTransaction: db.runTransaction };
  const snap = ref => ({ id: ref.id, ref, exists: docs.has(ref.path), data: () => docs.get(ref.path) });
  let n = 0;
  db.collection = name => ({ doc: (id = `auto-${++n}`) => ({ id, path: `${name}/${id}` }), where: (field, _op, value) => ({ collection: name, field, value }) });
  db.runTransaction = async run => {
    const writes = [];
    const result = await run({
      getAll: async (...refs) => refs.map(snap),
      get: async t => t.collection ? { docs: [...docs].filter(([p, row]) => p.startsWith(`${t.collection}/`) && row[t.field] === t.value).map(([p]) => snap({ id: p.split('/')[1], path: p })) } : snap(t),
      update: (ref, changes) => writes.push([ref.path, { ...docs.get(ref.path), ...changes }]),
      create: (ref, data) => writes.push([ref.path, data]),
    });
    for (const [p, row] of writes) docs.set(p, row);
    return result;
  };
  return { docs, restore: () => Object.assign(db, original) };
}

test('a waiter adds the staff 20% to a sent round with a manager code, once', async () => {
  const { docs, restore } = harness();
  try {
    await assert.rejects(addRoundStaffDiscount.run({ auth: waiter, data: { saleUuid: 'round-mbuzi' } }), /manager's code/);
    const result = await addRoundStaffDiscount.run({ auth: waiter, data: { saleUuid: 'round-mbuzi', discountApprovalId: 'ok' } });
    assert.equal(result.totalMinor, 40000);
    assert.equal(docs.get(`sales/${saleId}`).totalMinor, 40000);
    assert.equal(docs.get(`sales/${saleId}`).discountApprovedByStaffId, 'grace');
    assert.equal(docs.get(`sale_lines/${saleId}_line_01`).lineTotalMinor, 40000);
    assert.equal(docs.get(`payments/${saleId}_payment_01`).amountMinor, 40000);
    assert.equal(docs.get('discount_approvals/ok').consumedSaleId, saleId);
    await assert.rejects(addRoundStaffDiscount.run({ auth: manager, data: { saleUuid: 'round-mbuzi' } }), /already has a discount/);
  } finally { restore(); }
});

test('a manager adds it without a code; a paid round is refused', async () => {
  const { docs, restore } = harness();
  try {
    docs.set(`payments/${saleId}_payment_01`, { saleId, method: 'credit', amountMinor: 50000, status: 'completed', settledAt: 1 });
    await assert.rejects(addRoundStaffDiscount.run({ auth: manager, data: { saleUuid: 'round-mbuzi' } }), /already been paid/);
    docs.set(`payments/${saleId}_payment_01`, { saleId, method: 'credit', amountMinor: 50000, status: 'completed' });
    const result = await addRoundStaffDiscount.run({ auth: manager, data: { saleUuid: 'round-mbuzi' } });
    assert.equal(result.discountMinor, 10000);
  } finally { restore(); }
});
