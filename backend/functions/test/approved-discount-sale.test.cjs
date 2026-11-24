const test = require('node:test');
const assert = require('node:assert/strict');
const { createSale } = require('../lib/modules/sales/create-sale');
const { db } = require('../lib/lib/firebase');
const { printedSnapshotData } = require('./fixtures/printed-bill.cjs');

// A cashier rings the fixed 20% staff discount on a KES 1,700 meal.
const auth = { uid: 'cashier-login', token: { tenant_id: 'tenant', staff_id: 'cashier', staff_role: 'cashier' } };
const sale = (key, extra = {}) => ({
  tenantId: 'tenant', branchId: 'branch', deviceId: 'device', shiftId: 'shift',
  staffId: 'cashier', customerId: 'guest', idempotencyKey: key,
  lines: [{ productId: 'meal', qty: 1, discountMinor: 34000 }],
  payments: [{ method: 'credit', amountMinor: 136000 }],
  ...extra,
});

function harness() {
  const docs = new Map([
    ['tenants/tenant', { status: 'active', etimsMode: 'none' }],
    ['branches/branch', { tenantId: 'tenant', status: 'active', code: 'BH001' }],
    ['devices/device', { tenantId: 'tenant', branchId: 'branch', status: 'active' }],
    ['shifts/shift', { tenantId: 'tenant', branchId: 'branch', deviceId: 'device', staffId: 'cashier', status: 'open', expectedCashMinor: 0 }],
    ['staff/cashier', { tenantId: 'tenant', status: 'active', role: 'cashier' }],
    ['customers/guest', { tenantId: 'tenant', isActive: true }],
    ['tenant_settings/tenant', { tenantId: 'tenant', acceptedPaymentMethods: ['cash'] }],
    ['products/meal', { tenantId: 'tenant', isActive: true, sellPriceMinor: 170000, taxCode: 'A', name: 'Meal' }],
    ['stock_balances/branch_meal_HOUSE', { tenantId: 'tenant', branchId: 'branch', productId: 'meal', location: 'HOUSE', qty: 5 }],
    ['discount_approvals/approval-1', { tenantId: 'tenant', requestedByStaffId: 'cashier', approvedByStaffId: 'grace', expiresAtMs: Date.now() + 60_000, consumedSaleId: null }],
  ]);
  const original = { collection: db.collection, runTransaction: db.runTransaction };
  const snapshot = ref => ({ id: ref.id, ref, exists: docs.has(ref.path), data: () => printedSnapshotData(docs, ref.path) });
  let sequence = 0;
  db.collection = name => ({
    doc: (id = `auto-${++sequence}`) => ({ id, path: `${name}/${id}` }),
    where: (field, operator, value) => ({ collection: name, field, value }),
  });
  db.runTransaction = async run => {
    const writes = [];
    const result = await run({
      getAll: async (...refs) => refs.map(snapshot),
      get: async target => target.collection ? {
        docs: [...docs].filter(([path, row]) => path.startsWith(`${target.collection}/`) && row[target.field] === target.value)
          .map(([path]) => snapshot({ id: path.split('/')[1], path })),
      } : snapshot(target),
      set: (ref, data) => writes.push([ref.path, data]),
      create: (ref, data) => { assert.equal(docs.has(ref.path), false); writes.push([ref.path, data]); },
      update: (ref, changes) => writes.push([ref.path, { ...docs.get(ref.path), ...changes }]),
    });
    for (const [path, row] of writes) docs.set(path, row);
    return result;
  };
  return { docs, restore: () => { Object.assign(db, original); } };
}

test('a cashier\'s staff discount needs a manager approval, which one sale uses up', async () => {
  const { docs, restore } = harness();
  try {
    await assert.rejects(createSale.run({ auth, data: sale('no-approval-1') }), /cannot apply checkout discounts/);

    const result = await createSale.run({ auth, data: sale('approved-sale-1', { discountApprovalId: 'approval-1' }) });
    assert.equal(docs.get('discount_approvals/approval-1').consumedSaleId, result.sale.id);
    const saleDoc = docs.get(`sales/${result.sale.id}`);
    assert.equal(saleDoc.discountApprovedByStaffId, 'grace');
    assert.equal(saleDoc.totalMinor, 136000);

    await assert.rejects(
      createSale.run({ auth, data: sale('approved-sale-2', { discountApprovalId: 'approval-1' }) }),
      /already used/,
    );
  } finally { restore(); }
});

test('an expired approval, or another waiter\'s, does not carry the discount', async () => {
  const { docs, restore } = harness();
  try {
    docs.set('discount_approvals/old', { tenantId: 'tenant', requestedByStaffId: 'cashier', expiresAtMs: Date.now() - 1, consumedSaleId: null });
    docs.set('discount_approvals/linda', { tenantId: 'tenant', requestedByStaffId: 'linda', expiresAtMs: Date.now() + 60_000, consumedSaleId: null });
    await assert.rejects(createSale.run({ auth, data: sale('expired-1', { discountApprovalId: 'old' }) }), /expired/);
    await assert.rejects(createSale.run({ auth, data: sale('borrowed-1', { discountApprovalId: 'linda' }) }), /expired or was already used/);
    // An approval cannot stretch past the fixed 20%.
    await assert.rejects(createSale.run({ auth, data: sale('larger-1', {
      discountApprovalId: 'approval-1', lines: [{ productId: 'meal', qty: 1, discountMinor: 50000 }], payments: [{ method: 'credit', amountMinor: 120000 }],
    }) }), /cannot apply checkout discounts/);
    assert.equal(docs.get('discount_approvals/approval-1').consumedSaleId, null);
  } finally { restore(); }
});
