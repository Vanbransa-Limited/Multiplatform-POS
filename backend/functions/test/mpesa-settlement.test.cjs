const test = require('node:test');
const assert = require('node:assert/strict');
const { claimedBillAmount } = require('../lib/modules/mpesa/settlement');
const { db } = require('../lib/lib/firebase');
const actor = { tenantId: 'tenant', staffId: 'staff' };
const input = { saleUuids: ['original'], branchId: 'branch', checkoutId: 'checkout', stkKey: 'key' };
const bill = () => ({ tenantId: 'tenant', branchId: 'branch', checkoutId: 'checkout', checkoutStaffId: 'staff',
  checkoutStkKey: 'key', checkoutExpiresAt: { toMillis: () => 2000 }, totalMinor: 105000 });

test('saved invoice payment uses its original 1050 balance without repricing catalogue items', async () => {
  const original = db.collection;
  const collections = [];
  db.collection = name => { collections.push(name); return { doc: id => ({ id }), where: () => ({}) }; };
  try {
    const tx = { getAll: async () => [{ id: 'sale', exists: true, data: bill }],
      get: async () => ({ docs: [{ data: () => ({ method: 'credit', amountMinor: 105000 }) }] }) };
    assert.deepEqual(await claimedBillAmount(tx, actor, input, 1000), { dueMinor: 105000, saleIds: ['sale'] });
    assert.deepEqual(collections, ['sales', 'payments']);
  } finally { db.collection = original; }
});

test('saved invoice payment refuses foreign, expired, changed, cancelled and already-paid bills', async () => {
  const original = db.collection;
  db.collection = () => ({ doc: id => ({ id }), where: () => ({}) });
  try {
    for (const patch of [{ tenantId: 'other' }, { branchId: 'other' }, { checkoutStkKey: 'changed' },
      { checkoutStaffId: 'other' }, { checkoutExpiresAt: { toMillis: () => 1 } }, { status: 'VOIDED' }, { proformaId: 'pf' }]) {
      const tx = { getAll: async () => [{ id: 'sale', exists: true, data: () => ({ ...bill(), ...patch }) }] };
      await assert.rejects(claimedBillAmount(tx, actor, input, 1000));
    }
    await assert.rejects(claimedBillAmount({ getAll: async () => [{ id: 'sale', exists: true, data: bill }],
      get: async () => ({ docs: [{ data: () => ({ method: 'credit', amountMinor: 105000, settledAt: 'paid' }) }] }) }, actor, input, 1000), /already paid/);
  } finally { db.collection = original; }
});
