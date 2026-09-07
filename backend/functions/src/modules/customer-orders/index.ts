import { createHash } from 'node:crypto';
import { Timestamp } from 'firebase-admin/firestore';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import { FUNCTION_REGION } from '../../config/runtime';
import { db } from '../../lib/firebase';
import { deterministicId } from '../../shared/identifiers';
import { asRecord, documentId } from '../../shared/validation';
import { houseBalanceId, parseCustomerOrder, priceCustomerOrder, publicProduct, serviceStaff } from './domain';

export const getPublicMenu = onCall({ region: FUNCTION_REGION, maxInstances: 10 }, async (request) => {
  const input = asRecord(request.data);
  const tenantId = documentId(input.tenantId, 'tenantId');
  const tenant = await db.collection('tenants').doc(tenantId).get();
  if (tenant.data()?.status !== 'active') throw new HttpsError('not-found', 'Menu unavailable.');
  const [products, categories, branches] = await Promise.all([
    db.collection('products').where('tenantId', '==', tenantId).get(),
    db.collection('categories').where('tenantId', '==', tenantId).get(),
    db.collection('branches').where('tenantId', '==', tenantId).get(),
  ]);
  const listed = products.docs.map((doc) => publicProduct(doc.id, doc.data())).filter(Boolean) as NonNullable<ReturnType<typeof publicProduct>>[];
  const active = branches.docs.filter((doc) => doc.data().status === 'active');

  // Availability is per branch, so it is only known once one is chosen. The
  // balances are fetched by document id rather than queried, which keeps this
  // off any composite index and bounded by the number of counted products.
  const branchId = typeof input.branchId === 'string' && active.some((doc) => doc.id === input.branchId) ? input.branchId : null;
  const counted = branchId ? listed.filter((product) => product.trackStock) : [];
  const balances = counted.length
    ? await db.getAll(...counted.map((product) => db.collection('stock_balances').doc(houseBalanceId(branchId!, product.id))))
    : [];
  const onHand = new Map(balances.map((doc) => [doc.id, Number(doc.data()?.qty || 0)]));

  return {
    name: tenant.data()?.tradingName || tenant.data()?.legalName || 'Menu',
    branchId,
    products: listed.map((product) => ({
      ...product,
      soldOut: product.trackStock && branchId ? (onHand.get(houseBalanceId(branchId, product.id)) || 0) <= 0 : false,
    })),
    categories: categories.docs.map((doc) => ({ id: doc.id, name: String(doc.data().name || 'General') })),
    branches: active.map((doc) => ({ id: doc.id, name: String(doc.data().name || doc.id) })),
  };
});

export const submitCustomerOrder = onCall({ region: FUNCTION_REGION, maxInstances: 10 }, async (request) => {
  const input = parseCustomerOrder(request.data);
  const id = deterministicId('order', `${input.tenantId}:${input.requestId}`);
  const ref = db.collection('customer_orders').doc(id);
  const fingerprint = createHash('sha256').update(JSON.stringify(input)).digest('hex');
  const rateRef = db.collection('public_order_limits').doc(deterministicId('rate', `${input.tenantId}:${request.rawRequest.ip || 'unknown'}`));
  return db.runTransaction(async (transaction) => {
    const [existing, tenant, branch, rate, ...rest] = await transaction.getAll(
      ref, db.collection('tenants').doc(input.tenantId), db.collection('branches').doc(input.branchId), rateRef,
      ...input.lines.map((line) => db.collection('products').doc(line.productId)),
      ...input.lines.map((line) => db.collection('stock_balances').doc(houseBalanceId(input.branchId, line.productId))),
    );
    const products = rest.slice(0, input.lines.length);
    const balances = rest.slice(input.lines.length);
    if (existing.exists) {
      if (existing.data()?.fingerprint !== fingerprint) throw new HttpsError('already-exists', 'This request was already used for a different order.');
      return { orderId: id, ref: existing.data()?.ref, totalMinor: existing.data()?.totalMinor };
    }
    if (tenant.data()?.status !== 'active' || branch.data()?.status !== 'active' || branch.data()?.tenantId !== input.tenantId) {
      throw new HttpsError('failed-precondition', 'This branch is unavailable.');
    }
    const now = Timestamp.now();
    const windowStart = Number(rate.data()?.windowStart || 0);
    const count = now.toMillis() - windowStart < 60000 ? Number(rate.data()?.count || 0) : 0;
    if (count >= 20) throw new HttpsError('resource-exhausted', 'Too many orders. Please wait a minute.');
    const lines = priceCustomerOrder(input, new Map(products.map((doc) => [doc.id, doc.data() || {}])));
    // The menu greys out what is finished, but the check that counts is here:
    // a stale page must not be able to order the last plate twice.
    input.lines.forEach((line, index) => {
      if (products[index].data()?.trackStock !== true) return;
      const available = Number(balances[index].data()?.qty || 0);
      if (available < line.qty) {
        throw new HttpsError('failed-precondition', `${lines[index].name} is out of stock. Refresh the menu and review your order.`);
      }
    });
    const totalMinor = lines.reduce((sum, line) => sum + line.totalMinor, 0);
    const reference = `WEB-${id.slice(-10).toUpperCase()}`;
    transaction.create(ref, {
      id, tenantId: input.tenantId, branchId: input.branchId, ref: reference,
      customerName: input.customerName, orderType: input.orderType, tableNumber: input.tableNumber, note: input.note,
      lines, totalMinor, status: 'received', paymentStatus: 'unpaid', printCount: 0, source: 'customer_menu',
      fingerprint, createdAt: now,
    });
    transaction.set(rateRef, { count: count + 1, windowStart: count ? windowStart : now.toMillis() });
    return { orderId: id, ref: reference, totalMinor };
  });
});

export const updateCustomerOrder = onCall({ region: FUNCTION_REGION }, async (request) => {
  const actor = serviceStaff(request.auth?.token);
  const input = asRecord(request.data);
  const id = documentId(input.orderId, 'orderId');
  if (!['preparing', 'ready', 'completed', 'cancelled'].includes(String(input.status))) throw new HttpsError('invalid-argument', 'Invalid order status.');
  const ref = db.collection('customer_orders').doc(id);
  await db.runTransaction(async (transaction) => {
    const order = await transaction.get(ref);
    if (order.data()?.tenantId !== actor.tenantId) throw new HttpsError('not-found', 'Order not found.');
    if (['completed', 'cancelled'].includes(order.data()?.status)) throw new HttpsError('failed-precondition', 'Order already closed.');
    transaction.update(ref, { status: input.status, updatedAt: Timestamp.now(), updatedByStaffId: actor.staffId });
  });
  return { orderId: id, status: input.status };
});

/**
 * The counter has printed the kitchen ticket for this order.
 *
 * The printed ticket is what the kitchen cooks, so the count of prints is kept
 * on the order itself: a second print is a reprint of food already on, and the
 * kitchen needs to see that on the paper rather than guess.
 */
export const printCustomerOrder = onCall({ region: FUNCTION_REGION }, async (request) => {
  const actor = serviceStaff(request.auth?.token);
  const id = documentId(asRecord(request.data).orderId, 'orderId');
  const ref = db.collection('customer_orders').doc(id);
  return db.runTransaction(async (transaction) => {
    const order = await transaction.get(ref);
    const data = order.data();
    if (data?.tenantId !== actor.tenantId) throw new HttpsError('not-found', 'Order not found.');
    if (['completed', 'cancelled'].includes(String(data.status))) throw new HttpsError('failed-precondition', 'Order already closed.');
    // The ticket is what puts food on. Enforced here and not only on the button,
    // because a disabled button is a hint and this is the rule.
    if (data.paymentStatus !== 'paid') throw new HttpsError('failed-precondition', 'Take payment before sending this order to the kitchen.');
    const printCount = Number(data.printCount || 0) + 1;
    const now = Timestamp.now();
    transaction.update(ref, {
      printCount, lastPrintedAt: now, lastPrintedByStaffId: actor.staffId,
      // Printing puts the order on the pass; a ticket reprinted after the kitchen
      // called it ready must not drag it back to preparing.
      status: data.status === 'ready' ? 'ready' : 'preparing',
      updatedAt: now,
    });
    return { orderId: id, printCount };
  });
});
