const test = require('node:test');
const assert = require('node:assert/strict');
const { parseCustomerOrder, publicProduct, priceCustomerOrder } = require('../lib/modules/customer-orders/domain');
const { db } = require('../lib/lib/firebase');
const { getPublicMenu, submitCustomerOrder, updateCustomerOrder, printCustomerOrder } = require('../lib/modules/customer-orders');
const { openShift } = require('../lib/modules/shifts/open-shift');

const product = { tenantId: 't1', name: 'Actual item', isActive: true, sellPriceMinor: 15000, costPriceMinor: 5000 };
const input = () => ({ tenantId: 't1', branchId: 'b1', requestId: 'unique-1', customerName: 'Guest', tableNumber: '4', lines: [{ productId: 'p1', qty: 2, unitPriceMinor: 15000 }] });

test('public catalogue excludes inactive items and private product fields', () => {
  assert.equal(publicProduct('p1', { ...product, isActive: false }), null);
  assert.equal(publicProduct('p1', { ...product, sellPriceMinor: 0 }), null);
  assert.equal(publicProduct('p1', product).costPriceMinor, undefined);
});
test('orders are priced from central products and reject stale prices or other tenants', () => {
  const order = parseCustomerOrder(input());
  assert.equal(priceCustomerOrder(order, new Map([['p1', product]]))[0].totalMinor, 30000);
  assert.throws(() => priceCustomerOrder(order, new Map([['p1', { ...product, sellPriceMinor: 16000 }]])), /new price/);
  assert.throws(() => priceCustomerOrder(order, new Map([['p1', { ...product, tenantId: 't2' }]])), /no longer available/);
  assert.throws(() => parseCustomerOrder({ ...input(), lines: [{ productId: 'p1', qty: -1, unitPriceMinor: 15000 }] }), /Quantity/);
});

test('the table chooses between being served and taking away', () => {
  assert.equal(parseCustomerOrder(input()).orderType, 'dine_in');
  const takeaway = parseCustomerOrder({ ...input(), orderType: 'takeaway' });
  assert.equal(takeaway.orderType, 'takeaway');
  // A takeaway must not send a runner to a table someone else is sitting at.
  assert.equal(takeaway.tableNumber, null);
  assert.throws(() => parseCustomerOrder({ ...input(), tableNumber: '' }), /table number/);
});

test('menu submission reaches shared orders, retries do not duplicate, staff can manage it, and cashless shifts ignore float', async () => {
  const docs = new Map([
    ['tenants/t1', { status: 'active', tradingName: 'Real business' }],
    ['branches/b1', { tenantId: 't1', status: 'active', name: 'Branch' }],
    ['products/p1', product],
    ['products/hidden', { ...product, isActive: false }],
    ['devices/d1', { tenantId: 't1', branchId: 'b1', status: 'active' }],
    ['tenant_settings/t1', { cashEnabled: false, acceptedPaymentMethods: ['mpesa'] }],
  ]);
  const snapshot = (ref) => ({ id: ref.id, exists: docs.has(ref.path), data: () => docs.get(ref.path) });
  const originalCollection = db.collection;
  const originalTransaction = db.runTransaction;
  db.collection = (name) => ({
    doc: (id) => ({ id, path: `${name}/${id}`, get: async () => snapshot({ id, path: `${name}/${id}` }) }),
    where: (field, op, value) => ({ get: async () => ({ docs: [...docs].filter(([path, data]) => path.startsWith(`${name}/`) && data[field] === value).map(([path]) => snapshot({ id: path.split('/')[1], path })) }) }),
  });
  db.runTransaction = async (fn) => {
    const writes = [];
    const result = await fn({
      getAll: async (...refs) => refs.map(snapshot), get: async (ref) => snapshot(ref),
      create: (ref, data) => { assert.equal(docs.has(ref.path), false); writes.push([ref.path, data]); },
      set: (ref, data) => writes.push([ref.path, data]),
      update: (ref, data) => writes.push([ref.path, { ...docs.get(ref.path), ...data }]),
    });
    writes.forEach(([path, data]) => docs.set(path, data));
    return result;
  };
  try {
    const menu = await getPublicMenu.run({ data: { tenantId: 't1' } });
    assert.equal(menu.products.length, 1);
    assert.equal(menu.products[0].name, 'Actual item');
    const request = { data: input(), rawRequest: { ip: '127.0.0.1' } };
    const first = await submitCustomerOrder.run(request);
    const retry = await submitCustomerOrder.run(request);
    assert.equal(first.orderId, retry.orderId);
    const stored = docs.get(`customer_orders/${first.orderId}`);
    assert.equal(stored.status, 'received');
    assert.equal(stored.paymentStatus, 'unpaid');
    assert.equal(stored.orderType, 'dine_in');
    assert.equal(stored.printCount, 0);
    assert.equal(stored.lines[0].name, menu.products[0].name);
    assert.equal([...docs.keys()].filter((k) => k.startsWith('customer_orders/')).length, 1);
    await assert.rejects(submitCustomerOrder.run({ ...request, data: { ...input(), note: 'changed' } }), /different order/);
    const auth = { token: { tenant_id: 't1', staff_id: 's1', staff_role: 'cashier' } };
    await assert.rejects(updateCustomerOrder.run({ data: { orderId: first.orderId, status: 'ready' } }), /Sign in/);
    await updateCustomerOrder.run({ auth, data: { orderId: first.orderId, status: 'preparing' } });
    assert.equal(docs.get(`customer_orders/${first.orderId}`).status, 'preparing');
    await assert.rejects(updateCustomerOrder.run({ auth: { token: { ...auth.token, tenant_id: 't2' } }, data: { orderId: first.orderId, status: 'ready' } }), /not found/);
    // Nothing reaches the kitchen unpaid, whatever the button is doing.
    await assert.rejects(printCustomerOrder.run({ auth, data: { orderId: first.orderId } }), /Take payment/);
    docs.set(`customer_orders/${first.orderId}`, { ...docs.get(`customer_orders/${first.orderId}`), paymentStatus: 'paid' });
    // The printed ticket is the cook order, so each print is counted on it.
    assert.equal((await printCustomerOrder.run({ auth, data: { orderId: first.orderId } })).printCount, 1);
    assert.equal((await printCustomerOrder.run({ auth, data: { orderId: first.orderId } })).printCount, 2);
    assert.equal(docs.get(`customer_orders/${first.orderId}`).status, 'preparing');
    await updateCustomerOrder.run({ auth, data: { orderId: first.orderId, status: 'ready' } });
    await printCustomerOrder.run({ auth, data: { orderId: first.orderId } });
    assert.equal(docs.get(`customer_orders/${first.orderId}`).status, 'ready');
    await assert.rejects(printCustomerOrder.run({ data: { orderId: first.orderId } }), /Sign in/);
    await updateCustomerOrder.run({ auth, data: { orderId: first.orderId, status: 'completed' } });
    await assert.rejects(printCustomerOrder.run({ auth, data: { orderId: first.orderId } }), /already closed/);
    const shift = await openShift.run({ auth, data: { branchId: 'b1', deviceId: 'd1', openingFloatMinor: 200000 } });
    assert.equal(shift.openingFloatMinor, 0);
    assert.equal(docs.get(`shifts/${shift.shiftId}`).expectedCashMinor, 0);
  } finally { db.collection = originalCollection; db.runTransaction = originalTransaction; }
});
