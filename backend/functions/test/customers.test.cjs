const test = require('node:test');
const assert = require('node:assert/strict');
const { customerActor, customerKey, deleteCustomer, normalisePhone, saveCustomer } = require('../lib/modules/customers');
const { db } = require('../lib/lib/firebase');

test('one phone number is one customer, however it was typed', () => {
  assert.equal(normalisePhone('0712345678'), '712345678');
  assert.equal(normalisePhone('+254 712 345 678'), '712345678');
  assert.equal(normalisePhone('254712345678'), '712345678');
  assert.equal(normalisePhone(''), '');
  assert.equal(normalisePhone(undefined), '');

  // Which means the same person keys to the same document every time.
  const key = customerKey('t1', 'Achieng Otieno', '0712345678');
  assert.equal(customerKey('t1', 'Achieng Otieno', '+254712345678'), key);
  // A different tenant is never the same customer.
  assert.notEqual(customerKey('t2', 'Achieng Otieno', '0712345678'), key);
});

test('without a phone the name is the key, and case does not split it', () => {
  assert.equal(customerKey('t1', 'Bidii Ltd', ''), customerKey('t1', ' bidii ltd ', null));
  assert.notEqual(customerKey('t1', 'Bidii Ltd', ''), customerKey('t1', 'Bidii Two', ''));
});

test('adding a customer is the owner and supervisor only; deleting is the owner alone', () => {
  for (const role of ['owner', 'supervisor']) {
    assert.deepEqual(
      customerActor({ token: { tenant_id: 't1', staff_id: 's1', staff_role: role } }),
      { tenantId: 't1', staffId: 's1' },
    );
  }
  // A credit limit is a decision about who may walk out owing money.
  for (const role of ['cashier', 'bar_staff', 'store_keeper', 'store_manager']) {
    assert.throws(
      () => customerActor({ token: { tenant_id: 't1', staff_id: 's1', staff_role: role } }),
      /Only an owner or supervisor can add a customer/,
    );
  }
  for (const token of [undefined, {}, { tenant_id: 't1' }]) {
    assert.throws(() => customerActor(token === undefined ? undefined : { token }), /Only an owner or supervisor/);
  }

  assert.deepEqual(
    customerActor({ token: { tenant_id: 't1', staff_id: 's9', staff_role: 'owner' } }, 'delete'),
    { tenantId: 't1', staffId: 's9' },
  );
  assert.throws(
    () => customerActor({ token: { tenant_id: 't1', staff_id: 's1', staff_role: 'supervisor' } }, 'delete'),
    /Only the owner can remove a customer/,
  );
});

test('a customer is retired, never deleted, and never while they still owe', async () => {
  const docs = new Map([
    ['customers/c1', { tenantId: 't1', name: 'Bidii Ltd', isActive: true }],
    ['payments/p1', { tenantId: 't1', customerId: 'c1', method: 'credit', amountMinor: 50000 }],
  ]);
  const snapshot = (ref) => ({ id: ref.id, ref, exists: docs.has(ref.path), data: () => docs.get(ref.path) });
  const original = { collection: db.collection, runTransaction: db.runTransaction };
  db.collection = (name) => {
    const chain = (filters) => ({
      where: (field, op, value) => chain([...filters, [field, value]]),
      __query: { name, filters },
    });
    return { doc: (id) => ({ id, path: `${name}/${id}` }), where: (f, o, v) => chain([[f, v]]) };
  };
  db.runTransaction = async (fn) => {
    const writes = [];
    const result = await fn({
      get: async (target) => (target.__query
        ? {
          docs: [...docs]
            .filter(([path, data]) => path.startsWith(`${target.__query.name}/`)
              && target.__query.filters.every(([field, value]) => data[field] === value))
            .map(([path]) => snapshot({ id: path.split('/')[1], path })),
        }
        : snapshot(target)),
      update: (ref, data) => writes.push([ref.path, { ...docs.get(ref.path), ...data }]),
      create: (ref, data) => writes.push([ref.path, data]),
    });
    writes.forEach(([path, data]) => docs.set(path, data));
    return result;
  };

  const auth = { token: { tenant_id: 't1', staff_id: 's9', staff_role: 'owner' } };
  try {
    await assert.rejects(deleteCustomer.run({ auth, data: { customerId: 'c1' } }), /still has unpaid invoices/);

    // Settled, so the name can leave the directory.
    docs.set('payments/p1', { ...docs.get('payments/p1'), settledAt: 'then' });
    const result = await deleteCustomer.run({ auth, data: { customerId: 'c1' } });
    assert.equal(result.isActive, false);
    // Retired, not removed: sales still point at this document.
    assert.equal(docs.get('customers/c1').name, 'Bidii Ltd');
    assert.equal(docs.get('customers/c1').isActive, false);

    await assert.rejects(deleteCustomer.run({ auth, data: { customerId: 'cust-walkin' } }), /walk-in customer cannot be removed/);
    await assert.rejects(deleteCustomer.run({ auth, data: { customerId: 'nope' } }), /Customer not found/);
  } finally {
    db.collection = original.collection;
    db.runTransaction = original.runTransaction;
  }
});

test('a saved customer is active, tenant-scoped, and merged onto the same document', async () => {
  const docs = new Map();
  const original = db.collection;
  db.collection = (name) => ({
    doc: (id) => ({
      set: async (data, options) => {
        docs.set(`${name}/${id}`, options?.merge ? { ...docs.get(`${name}/${id}`), ...data } : data);
      },
    }),
  });

  try {
    const auth = { token: { tenant_id: 't1', staff_id: 's1', staff_role: 'supervisor' } };
    const first = await saveCustomer.run({
      auth,
      data: { name: 'Achieng Otieno', phone: '0712345678', creditLimitMinor: 50000 },
    });
    assert.equal(first.isActive, true);
    assert.equal(first.tenantId, 't1');
    assert.equal(first.creditLimitMinor, 50000);

    // The same person under the international spelling updates that document.
    const again = await saveCustomer.run({
      auth,
      data: { name: 'Achieng Otieno', phone: '+254712345678', kraPin: 'a001234567z', priceTier: 'wholesale' },
    });
    assert.equal(again.id, first.id);
    assert.equal(again.kraPin, 'A001234567Z');
    assert.equal(again.priceTier, 'WHOLESALE');
    assert.equal(docs.size, 1);

    // A supervisor adding a name and a phone must not wipe what the office set.
    await saveCustomer.run({ auth, data: { name: 'Achieng Otieno', phone: '0712345678' } });
    const stored = docs.get(`customers/${first.id}`);
    assert.equal(stored.creditLimitMinor, 50000);
    assert.equal(stored.kraPin, 'A001234567Z');
    assert.equal(stored.priceTier, 'WHOLESALE');

    await assert.rejects(
      saveCustomer.run({ auth, data: { name: 'Bad Pin', kraPin: 'NOTAPIN' } }),
      /KRA PIN/,
    );
    await assert.rejects(saveCustomer.run({ auth, data: { name: '  ' } }), /Give the customer a name/);
  } finally {
    db.collection = original;
  }
});
