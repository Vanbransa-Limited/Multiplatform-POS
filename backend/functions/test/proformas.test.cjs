const test = require('node:test');
const assert = require('node:assert/strict');
const { db } = require('../lib/lib/firebase');
const { issueProforma, payProforma, parseProforma } = require('../lib/modules/proformas');
const { deterministicId } = require('../lib/shared/identifiers');

const invoice = () => ({
  business: { name: 'Bransa' }, client: { name: 'Acme' }, number: 'PF-001',
  date: '2026-10-01', dueDate: '2026-10-08', subject: 'Event',
  lines: [{ description: 'Event service', qty: 2, unitMinor: 10000 }], discountMinor: 1000,
  bank: { bank: 'Bank', accountNo: '123' }, terms: 'On payment',
});
const auth = (role = 'owner', tenant = 't1') => ({ uid: 'u1', token: { tenant_id: tenant, staff_id: 's1', staff_role: role } });

test('issued invoices validate dates, bounded integer amounts, quantities and named clients', () => {
  const parsed = parseProforma({ ...invoice(), dueMinor: 1 });
  assert.equal(parsed.dueMinor, 19000);
  assert.equal(parsed.vatMinor, Math.round(19000 * 16 / 116));
  for (const change of [
    { client: {} }, { business: {} }, { lines: [] }, { discountMinor: 20000 },
    { date: '2026-02-30' }, { dueDate: '2026-09-30' },
    { lines: [{ description: 'x', qty: 0, unitMinor: 10 }] },
    { lines: [{ description: 'x', qty: 1.5, unitMinor: 10 }] },
    { lines: [{ description: 'x', qty: 1, unitMinor: -10 }] },
    { lines: [{ description: 'x', qty: 1000000, unitMinor: 1000000000000 }] },
  ]) assert.throws(() => parseProforma({ ...invoice(), ...change }));
});

test('issuing locks the original; payments are atomic, tenant-scoped and written only once', async () => {
  const docs = new Map([
    ['tenants/t1', { status: 'active' }],
    ['branches/b1', { tenantId: 't1', status: 'active' }],
    ['tenant_settings/t1', { acceptedPaymentMethods: ['bank_transfer', 'mpesa', 'card'] }],
  ]);
  let sequence = 0;
  const ref = (name, id) => ({ id, path: `${name}/${id}` });
  const snapshot = ref => ({ id: ref.id, ref, exists: docs.has(ref.path), data: () => docs.get(ref.path) });
  const originals = { collection: db.collection, runTransaction: db.runTransaction };
  db.collection = name => ({ doc: id => ref(name, id || `auto-${++sequence}`),
    where: (field, _op, value) => ({ collection: name, field, value }) });
  db.runTransaction = async work => {
    const writes = [];
    const result = await work({
      getAll: async (...refs) => refs.map(snapshot),
      set: (ref, data) => writes.push([ref.path, data]),
      get: async target => target.collection ? { docs: [...docs].filter(([key, data]) => key.startsWith(`${target.collection}/`) && data[target.field] === target.value)
        .map(([key]) => snapshot(ref(target.collection, key.split('/')[1]))) } : snapshot(target),
      create: (ref, data) => { assert.equal(docs.has(ref.path), false); writes.push([ref.path, data]); },
      update: (ref, patch) => { assert.equal(docs.has(ref.path), true); writes.push([ref.path, { ...docs.get(ref.path), ...patch }]); },
    });
    writes.forEach(([key, data]) => docs.set(key, data));
    return result;
  };
  const issue = (overrides = {}, identity = auth()) => issueProforma.run({ auth: identity,
    data: { requestId: 'request-1', branchId: 'b1', invoice: invoice(), ...overrides } });
  const pay = (id, method = 'bank_transfer', reference = 'BANK-001', identity = auth('cashier')) =>
    payProforma.run({ auth: identity, data: { proformaId: id, method, reference } });
  try {
    await assert.rejects(issue({}, auth('cashier')), /Only an owner/);
    await assert.rejects(issue({ branchId: 'missing' }), /active branch/);
    const first = await issue();
    const original = docs.get(`proformas/${first.id}`).invoice;
    assert.equal(docs.get(`proformas/${first.id}`).paymentStatus, 'unpaid');
    assert.equal([...docs.keys()].some(key => /^(sales|payments|stock_movements)\//.test(key)), false);
    assert.deepEqual(await issue(), first);
    await assert.rejects(issue({ invoice: { ...invoice(), subject: 'Changed' } }), /cannot be edited/);
    await assert.rejects(issue({ requestId: 'request-2' }), /already issued/);
    await assert.rejects(pay(first.id, 'cash'), /not enabled/);
    await assert.rejects(pay(first.id, 'bank_transfer', ''), /reference/);
    await assert.rejects(pay(first.id, 'card', 'CARD', auth('cashier', 't2')), /not found/);
    const paid = await pay(first.id);
    assert.equal(paid.alreadyPaid, false);
    assert.equal((await pay(first.id)).alreadyPaid, true);
    assert.deepEqual(docs.get(`proformas/${first.id}`).invoice, original);
    const ledger = [...docs].filter(([key]) => key.startsWith('payments/'));
    assert.equal(ledger.length, 1);
    assert.equal(ledger[0][1].amountMinor, 19000);
    assert.equal(ledger[0][1].proformaId, first.id);
    assert.equal(ledger[0][1].verified, false);
    assert.ok(ledger[0][1].paidAt.toMillis() > Date.parse('2026-10-08'));

    const second = await issue({ requestId: 'request-2', invoice: { ...invoice(), number: 'PF-002' } });
    await assert.rejects(pay(second.id, 'mpesa', 'CODE'), /unavailable/);
    const eventKey = `mpesa_c2b_events/${deterministicId('c2b', 'confirmation:CODE')}`;
    docs.set(eventKey, { tenantId: 't1', payload: { amountMinor: 18000 } });
    await assert.rejects(pay(second.id, 'mpesa', 'CODE'), /match the full/);
    docs.set(eventKey, { tenantId: 't1', payload: { amountMinor: 19000 } });
    await pay(second.id, 'mpesa', 'code');
    assert.equal(docs.get(eventKey).settledProformaId, second.id);
    const third = await issue({ requestId: 'request-3', invoice: { ...invoice(), number: 'PF-003' } });
    await assert.rejects(pay(third.id, 'mpesa', 'CODE'), /already used/);
    assert.equal(docs.get(`proformas/${third.id}`).paymentStatus, 'unpaid');
    assert.equal([...docs.keys()].filter(key => key.startsWith('payments/')).length, 2);
    assert.equal([...docs.keys()].some(key => /^(sales|stock_movements)\//.test(key)), false);
    // A previously prepared document can name an existing till receivable.
    docs.get(`proformas/${third.id}`).linkedSaleId = 'original';
    docs.set('sales/original', { tenantId: 't1', branchId: 'b1', proformaId: third.id, totalMinor: 19000, status: 'completed' });
    docs.set('payments/original-credit', { tenantId: 't1', saleId: 'original', method: 'credit', amountMinor: 18000 });
    await assert.rejects(pay(third.id), /balance differs/);
    assert.equal(docs.get('payments/original-credit').settledAt, undefined);
    docs.get('payments/original-credit').amountMinor = 19000;
    await pay(third.id);
    assert.ok(docs.get('payments/original-credit').settledAt);
    assert.equal(docs.get('payments/original-credit').settledProformaId, third.id);
    const linkedPayment = [...docs.values()].find(row => row.proformaId === third.id && row.method === 'bank_transfer');
    assert.equal(linkedPayment.saleId, 'original');
    assert.equal(linkedPayment.amountMinor, 19000);
    assert.equal((await pay(third.id)).alreadyPaid, true);
  } finally { Object.assign(db, originals); }
});
