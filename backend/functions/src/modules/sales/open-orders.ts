import { Timestamp } from 'firebase-admin/firestore';
import { HttpsError, onCall } from 'firebase-functions/v2/https';

import { FUNCTION_REGION } from '../../config/runtime';
import { db } from '../../lib/firebase';
import { deterministicId } from '../../shared/identifiers';
import { asRecord, documentId, optionalText } from '../../shared/validation';
import { SELLING_ROLES } from './constants';

/**
 * Open tabs, published so the business can be watched while it is happening.
 *
 * A round on an open tab is deliberately never submitted as a sale: it has not
 * been paid for, the table can still order more, and an item rung in error has
 * to come off. Booking it would move stock and raise a receivable on a server
 * the selling till could no longer correct.
 *
 * The cost of that was total blindness. Every open table lived only on the iPad
 * that rang it, so an owner asking "what is running right now" saw their own
 * device and nothing else - and no query could fix it, because there was
 * nothing to query.
 *
 * This publishes the *state* of those tabs and nothing more. No stock moves, no
 * receivable is raised, no payment is recorded, and no document written here is
 * ever read back as money - Financials counts `sales` and `payments`, never
 * this. It is a window, not a ledger, and settling still happens only on the
 * till that owns the tab.
 */

/** Bounds one call: a till with more open tables than this has another problem. */
const MAX_OPEN_ORDERS = 200;
const MAX_LINES = 40;

function sellingStaff(token: Record<string, unknown> | undefined) {
  if (!token?.tenant_id || !token.staff_id || !SELLING_ROLES.has(String(token.staff_role))) {
    throw new HttpsError('permission-denied', 'Sign in to publish open tabs.');
  }
  return { tenantId: String(token.tenant_id), staffId: String(token.staff_id) };
}

/**
 * A tender a till has taken against an order it is still holding.
 *
 * Published so the business can see that money was settled somewhere, even
 * though the sale carrying it has not arrived. It is reported as held and
 * never counted as taken: the only record that makes it real is the sale.
 */
function tenderOf(value: unknown, index: number) {
  const tender = asRecord(value);
  const amountMinor = Number(tender.amountMinor);
  return {
    id: optionalText(tender.id, `orders[].payments[${index}].id`, 200) ?? '',
    method: (optionalText(tender.method, `orders[].payments[${index}].method`, 40) ?? '').toUpperCase(),
    amountMinor: Number.isSafeInteger(amountMinor) && amountMinor >= 0 ? amountMinor : 0,
    reference: optionalText(tender.reference, `orders[].payments[${index}].reference`, 60) ?? '',
    staffId: optionalText(tender.staffId, `orders[].payments[${index}].staffId`, 200) ?? '',
    paidAt: optionalText(tender.paidAt, `orders[].payments[${index}].paidAt`, 40) ?? null,
  };
}

function lineOf(value: unknown, index: number) {
  const line = asRecord(value);
  const qty = Number(line.qty);
  return {
    name: optionalText(line.name, `orders[].lines[${index}].name`, 120) ?? 'Item',
    qty: Number.isFinite(qty) && qty > 0 ? Math.min(qty, 10_000) : 0,
  };
}

/**
 * Replaces everything this device has open.
 *
 * Sent whole rather than incrementally: a tab that closed, a round that was
 * removed, or a device that went offline mid-service all have to disappear from
 * the board, and a diff would leave any of them stranded there forever. What
 * this device no longer reports open, it no longer has open.
 */
export const publishOpenOrders = onCall({ region: FUNCTION_REGION }, async (request) => {
  const actor = sellingStaff(request.auth?.token);
  const input = asRecord(request.data);
  const branchId = documentId(input.branchId, 'branchId');
  const deviceId = documentId(input.deviceId, 'deviceId');
  if (!Array.isArray(input.orders) || input.orders.length > MAX_OPEN_ORDERS) {
    throw new HttpsError('invalid-argument', `orders must be an array of at most ${MAX_OPEN_ORDERS} entries. Existing orders were not changed.`);
  }
  const submitted = input.orders;

  const now = Timestamp.now();
  const orders = submitted.map((entry, index) => {
    const order = asRecord(entry);
    // The till's own key for this order: a tab id where the order is a table's
    // running bill, otherwise the sale id. Anything the till is holding that
    // the server does not have yet is publishable, not just open tabs - a
    // standalone unpaid order is exactly as invisible and matters as much.
    const tabId = documentId(order.key ?? order.tabId, `orders[${index}].key`);
    const totalMinor = Number(order.totalMinor);
    const dueMinor = Number(order.dueMinor);
    return {
      id: deterministicId('open-order', `${actor.tenantId}:${deviceId}:${tabId}`),
      tenantId: actor.tenantId,
      branchId,
      deviceId,
      tabId,
      // Whoever is running this table, so the board can name them.
      staffId: optionalText(order.staffId, `orders[${index}].staffId`, 200) ?? actor.staffId,
      ref: optionalText(order.ref, `orders[${index}].ref`, 60) ?? tabId,
      tableNumber: optionalText(order.tableNumber, `orders[${index}].table`, 30) ?? '',
      customerName: optionalText(order.customerName, `orders[${index}].customer`, 120) ?? '',
      totalMinor: Number.isSafeInteger(totalMinor) && totalMinor >= 0 ? totalMinor : 0,
      dueMinor: Number.isSafeInteger(dueMinor) && dueMinor >= 0 ? dueMinor : 0,
      lines: (Array.isArray(order.lines) ? order.lines.slice(0, MAX_LINES) : []).map(lineOf),
      // The till's own keys for the rounds behind this order. A payment names
      // one of these, so they are what lets a manager see which order a
      // payment belongs to while the sale itself is still on the till.
      // What has been tendered against it on that till. Cash, card and bank
      // settlements are invisible to everyone else until the sale syncs, so a
      // manager could see an order running and never know it had been paid.
      payments: (Array.isArray(order.payments) ? order.payments.slice(0, MAX_LINES) : [])
        .map(tenderOf)
        .filter((tender) => tender.method && tender.amountMinor > 0),
      roundCount: Array.isArray(order.saleUuids) ? order.saleUuids.length : 0,
      saleUuids: (Array.isArray(order.saleUuids) ? order.saleUuids.slice(0, MAX_OPEN_ORDERS) : [])
        .map((value, position) => optionalText(value, `orders[${index}].saleUuids[${position}]`, 60) ?? '')
        .filter(Boolean),
      openedAt: optionalText(order.openedAt, `orders[${index}].openedAt`, 40) ?? null,
      // Whether it is a table's running bill or a single unpaid order, so the
      // board can say which it is looking at.
      kind: order.kind === 'sale' ? 'sale' : 'tab',
      // This collection only ever holds work a till is still holding: once the
      // sale reaches `sales`, the till stops reporting it and it is cleared.
      status: 'open',
      paymentStatus: order.kind === 'sale' && order.paymentStatus === 'paid' ? 'paid' : 'unpaid',
      publishedAt: now,
      publishedByStaffId: actor.staffId,
    };
  });

  const collection = db.collection('open_orders');
  const existing = await collection
    .where('tenantId', '==', actor.tenantId)
    .where('deviceId', '==', deviceId)
    .get();

  const keep = new Set(orders.map((order) => order.id));
  let batch = db.batch();
  let operations = 0;
  for (const order of orders) {
    batch.set(collection.doc(order.id), order);
    operations++;
  }
  for (const doc of existing.docs) {
    if (!keep.has(doc.id)) {
      // A missing browser snapshot must not erase the only server evidence
      // of an unpaid order. Archive and remove together, within one batch.
      if (operations + 2 > 450) {
        await batch.commit();
        batch = db.batch();
        operations = 0;
      }
      batch.set(db.collection('open_order_archive').doc(`${doc.id}_${now.toMillis()}`), {
        ...doc.data(), archivedAt: now, archivedByStaffId: actor.staffId,
        archiveReason: 'omitted_from_publisher_snapshot',
      });
      batch.delete(doc.ref);
      operations += 2;
    }
  }
  await batch.commit();

  return { published: orders.length, cleared: existing.docs.filter((doc) => !keep.has(doc.id)).length };
});
