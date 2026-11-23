const test = require('node:test');
const assert = require('node:assert/strict');
const { createSale } = require('../lib/modules/sales/create-sale');
const { claimSalePayment, settleSale } = require('../lib/modules/sales/settle');
const { db } = require('../lib/lib/firebase');
const { deterministicId } = require('../lib/shared/identifiers');
const { printedSnapshotData } = require('./fixtures/printed-bill.cjs');

const auth = { uid: 'cashier-login', token: { tenant_id: 'tenant', staff_id: 'cashier', staff_role: 'supervisor' } };
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
    ['staff/cashier', { tenantId: 'tenant', status: 'active', role: 'supervisor' }],
    ['customers/guest', { tenantId: 'tenant', isActive: true }],
    ['tenant_settings/tenant', { tenantId: 'tenant', acceptedPaymentMethods: ['mpesa'] }],
    ['products/meal', { tenantId: 'tenant', isActive: true, sellPriceMinor: 170000, taxCode: 'A', name: 'Meal' }],
    ['stock_balances/branch_meal_HOUSE', { tenantId: 'tenant', branchId: 'branch', productId: 'meal', location: 'HOUSE', qty: 5 }],
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

test('an unprinted offline paid sale is refused without moving stock or recording its receipt', async () => {
  const { docs, restore } = harness();
  try {
    docs.set('payments/original', { tenantId: 'tenant', saleId: 'original-sale', method: 'mpesa', reference: 'REUSEDCODE', amountMinor: 136000, status: 'completed' });
    const data = { ...input, payments: [{ method: 'mpesa', reference: 'REUSEDCODE', amountMinor: 136000, unverified: true }] };
    await assert.rejects(createSale.run({ auth, data }), /Print the receipt/);
    assert.equal(docs.get('stock_balances/branch_meal_HOUSE').qty, 5);
    assert.equal([...docs.keys()].filter(key => key.startsWith('payment_receipt_claims/')).length, 0);
  } finally { restore(); }
});

test('a KES925 table publishes its 30% service and 20% staff round, then one typed code settles both rounds once', async () => {
  const { docs, restore } = harness();
  try {
    for (const [id, price] of [['drink', 10000], ['potatoes', 25000], ['pork', 40000], ['prod-table-service', 10000]]) {
      docs.set(`products/${id}`, { tenantId: 'tenant', isActive: true, sellPriceMinor: price, taxCode: 'A', name: id, isService: id === 'prod-table-service' });
    }
    const firstInput = { ...input, idempotencyKey: 'table925-first-round', lines: [{ productId: 'drink', qty: 1 }], payments: [{ method: 'credit', amountMinor: 10000 }] };
    const first = await createSale.run({ auth, data: firstInput });
    // Discounts are allocated over recorded lines by the till, including the
    // computed service row: total discount150, goods750 + service225 =825.
    const roundInput = { ...input, idempotencyKey: 'table925-service-round', lines: [
      { productId: 'prod-table-service', qty: 1, discountMinor: 3461 },
      { productId: 'potatoes', qty: 1, discountMinor: 3846 },
      { productId: 'drink', qty: 1, discountMinor: 1538 },
      { productId: 'pork', qty: 1, discountMinor: 6155 },
    ], payments: [{ method: 'credit', amountMinor: 82500 }] };
    const round = await createSale.run({ auth, data: roundInput });
    assert.equal(round.sale.subtotalMinor, 97500);
    assert.equal(round.sale.discountMinor, 15000);
    assert.equal(round.sale.totalMinor, 82500);
    assert.equal(round.lines.find(line => line.productId === 'prod-table-service').unitPriceMinor, 22500);
    assert.equal((await createSale.run({ auth, data: roundInput })).replayed, true);
    const checkoutId = 'table925-checkout';
    const claim = await claimSalePayment.run({ auth, data: { saleUuids: [firstInput.idempotencyKey, roundInput.idempotencyKey], checkoutId, expectedMinor: 92500, method: 'mpesa' } });
    assert.equal(claim.dueMinor, 92500);
    docs.set(`mpesa_c2b_events/${deterministicId('c2b', 'confirmation:TEST925COD')}`, { tenantId: 'tenant', payload: { amountMinor: 92500 } });
    for (const [index, sale] of [firstInput, roundInput].entries()) {
      const data = { saleUuid: sale.idempotencyKey, checkoutId, requestId: `925-${index}`, method: 'mpesa', reference: 'TEST925COD' };
      const settled = await settleSale.run({ auth, data });
      assert.equal(settled.verified, true);
      assert.deepEqual(await settleSale.run({ auth, data }), settled);
    }
    const receipts = [...docs.values()].filter(row => row.source === 'sale_settlement');
    assert.equal(receipts.reduce((sum,row) => sum + row.amountMinor, 0), 92500);
    assert.equal(receipts.length, 2);
    assert.equal(first.sale.totalMinor + round.sale.totalMinor, 92500);
  } finally { restore(); }
});

for (const method of ['typed-code', 'stk']) {
  test(`supervisor registers the KES 1,360 staff-discount order and settles by ${method}`, async () => {
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
      if (method === 'typed-code') docs.set(`mpesa_c2b_events/${deterministicId('c2b', 'confirmation:STAFFCODE1')}`, { tenantId: 'tenant', payload: { amountMinor: 136000 } });
      const payment = { saleUuid: input.idempotencyKey, checkoutId, requestId: 'payment-651015', method: 'mpesa',
        ...(method === 'stk' ? { attemptId } : { reference: 'STAFFCODE1' }) };
      const settled = await settleSale.run({ auth, data: payment });
      assert.equal(settled.settledMinor, 136000);
      assert.equal(settled.verified, true);
      assert.deepEqual(await settleSale.run({ auth, data: payment }), settled);
      assert.equal([...docs.keys()].filter(path => path.startsWith('sales/')).length, 1);
      assert.equal([...docs.values()].filter(row => row.source === 'sale_settlement').length, 1);
      assert.equal(docs.get('stock_balances/branch_meal_HOUSE').qty, 4);
      assert.equal((await createSale.run({ auth, data: input })).replayed, true);
    } finally { restore(); }
  });
}

test('provider payment proof does not bypass the requirement to save and print the bill first', async () => {
  const { docs, restore } = harness();
  try {
    docs.set(`payment_intents/${deterministicId('intent', 'tenant:STAFFPAIDRECEIPT')}`, {
      tenantId: 'tenant', branchId: 'branch', deviceId: 'device', authorizedStaffId: 'cashier',
      customerId: 'guest', method: 'mpesa', status: 'verified', reference: 'STAFFPAIDRECEIPT',
      amountMinor: 136000, baseAmountMinor: 136000, cartGrossMinor: 170000, cashAmountMinor: 0,
      membershipDiscountMinor: 0, lines: [{ productId: 'meal', qty: 1 }],
      lineDiscounts: [{ productId: 'meal', discountMinor: 0 }],
    });
    await assert.rejects(createSale.run({ auth, data: { ...input,
      payments: [{ method: 'mpesa', amountMinor: 136000, reference: 'STAFFPAIDRECEIPT' }],
    } }), /Print the receipt/);
    assert.equal(docs.get(`payment_intents/${deterministicId('intent', 'tenant:STAFFPAIDRECEIPT')}`).consumedSaleId, undefined);
  } finally { restore(); }
});

test('a role the owner has switched off selling for cannot register a sale', async () => {
  const { docs, restore } = harness();
  try {
    docs.set('tenant_settings/tenant', { tenantId: 'tenant', acceptedPaymentMethods: ['mpesa'], moduleAccess: { sell: ['bar_staff'] } });
    await assert.rejects(createSale.run({ auth, data: input }), /Selling is switched off/);
    assert.equal([...docs.keys()].some(path => path.startsWith('sales/')), false);
    docs.set('tenant_settings/tenant', { tenantId: 'tenant', acceptedPaymentMethods: ['mpesa'], moduleAccess: { sell: ['supervisor'] } });
    assert.equal((await createSale.run({ auth, data: input })).sale.totalMinor, 136000);
  } finally { restore(); }
});
