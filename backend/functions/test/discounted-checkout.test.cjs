const test = require('node:test');
const assert = require('node:assert/strict');
const { createSale } = require('../lib/modules/sales/create-sale');
const { claimSalePayment, settleSale } = require('../lib/modules/sales/settle');
const { db } = require('../lib/lib/firebase');
const { deterministicId } = require('../lib/shared/identifiers');

const auth = { uid: 'cashier-login', token: { tenant_id: 'tenant', staff_id: 'cashier', staff_role: 'cashier' } };
const input = {
  tenantId: 'tenant', branchId: 'branch', deviceId: 'device', shiftId: 'shift',
  staffId: 'cashier', customerId: 'guest', idempotencyKey: 'discounted-order-651015',
  lines: [{ productId: 'meal', qty: 1, discountMinor: 34000 }],
  payments: [{ method: 'credit', amountMinor: 136000 }],
};

function harness() {
  const docs = new Map([
    ['tenants/tenant', { status: 'active', etimsMode: 'none' }],
    ['branches/branch', { tenantId: 'tenant', status: 'active', code: 'BH001' }],
    ['devices/device', { tenantId: 'tenant', branchId: 'branch', status: 'active' }],
    ['shifts/shift', { tenantId: 'tenant', branchId: 'branch', deviceId: 'device', staffId: 'cashier', status: 'open', expectedCashMinor: 0 }],
    ['staff/cashier', { tenantId: 'tenant', status: 'active', role: 'cashier' }],
    ['customers/guest', { tenantId: 'tenant', isActive: true }],
    ['tenant_settings/tenant', { tenantId: 'tenant', acceptedPaymentMethods: ['mpesa'] }],
    ['products/meal', { tenantId: 'tenant', isActive: true, sellPriceMinor: 170000, taxCode: 'A', name: 'Meal' }],
    ['stock_balances/branch_meal_HOUSE', { tenantId: 'tenant', branchId: 'branch', productId: 'meal', location: 'HOUSE', qty: 5 }],
  ]);
  const original = { collection: db.collection, runTransaction: db.runTransaction };
  const snapshot = ref => ({ id: ref.id, ref, exists: docs.has(ref.path), data: () => docs.get(ref.path) });
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

for (const method of ['typed-code', 'stk']) {
  test(`cashier registers the KES 1,360 staff-discount order and settles by ${method}`, async () => {
    const { docs, restore } = harness();
    try {
      const saved = await createSale.run({ auth, data: input });
      assert.equal(saved.sale.totalMinor, 136000);
      assert.equal(saved.sale.discountMinor, 34000);
      assert.equal(docs.get('stock_balances/branch_meal_HOUSE').qty, 4);
      const checkoutId = 'checkout-651015';
      const stkKey = 'staff-discount-stk';
      const claim = await claimSalePayment.run({ auth, data: {
        saleUuids: [input.idempotencyKey], checkoutId, expectedMinor: 136000,
        ...(method === 'stk' ? { stkKey } : {}),
      } });
      assert.equal(claim.dueMinor, 136000);
      const attemptId = deterministicId('mpesa-attempt', `tenant:${stkKey}`);
      if (method === 'stk') {
        docs.set(`mpesa_payments/${attemptId}`, { tenantId: 'tenant', branchId: 'branch', status: 'paid', receipt: 'TESTSTAFFRECEIPT', amountMinor: 136000 });
        docs.set(`payment_intents/${deterministicId('intent', 'tenant:TESTSTAFFRECEIPT')}`, { tenantId: 'tenant', attemptId, status: 'verified', amountMinor: 136000 });
      }
      const payment = { saleUuid: input.idempotencyKey, checkoutId, requestId: 'payment-651015', method: 'mpesa',
        ...(method === 'stk' ? { attemptId } : { reference: 'TYPEDSTAFFCODE' }) };
      const settled = await settleSale.run({ auth, data: payment });
      assert.equal(settled.settledMinor, 136000);
      assert.equal(settled.verified, method === 'stk');
      assert.deepEqual(await settleSale.run({ auth, data: payment }), settled);
      assert.equal([...docs.keys()].filter(path => path.startsWith('sales/')).length, 1);
      assert.equal([...docs.values()].filter(row => row.source === 'sale_settlement').length, 1);
      assert.equal(docs.get('stock_balances/branch_meal_HOUSE').qty, 4);
      assert.equal((await createSale.run({ auth, data: input })).replayed, true);
    } finally { restore(); }
  });
}

test('a confirmed staff-discount receipt can upload without being mistaken for a membership discount', async () => {
  const { docs, restore } = harness();
  try {
    docs.set(`payment_intents/${deterministicId('intent', 'tenant:STAFFPAIDRECEIPT')}`, {
      tenantId: 'tenant', branchId: 'branch', deviceId: 'device', authorizedStaffId: 'cashier',
      customerId: 'guest', method: 'mpesa', status: 'verified', reference: 'STAFFPAIDRECEIPT',
      amountMinor: 136000, baseAmountMinor: 136000, cartGrossMinor: 170000, cashAmountMinor: 0,
      membershipDiscountMinor: 0, lines: [{ productId: 'meal', qty: 1 }],
      lineDiscounts: [{ productId: 'meal', discountMinor: 0 }],
    });
    const saved = await createSale.run({ auth, data: { ...input,
      payments: [{ method: 'mpesa', amountMinor: 136000, reference: 'STAFFPAIDRECEIPT' }],
    } });
    assert.equal(saved.sale.totalMinor, 136000);
    assert.equal(docs.get(`payment_intents/${deterministicId('intent', 'tenant:STAFFPAIDRECEIPT')}`).consumedSaleId, saved.sale.id);
  } finally { restore(); }
});
