'use strict';
const assert = require('node:assert/strict'), path = require('node:path'), { createHash } = require('node:crypto');
const backend = require('node:module').createRequire(path.resolve(__dirname, '../../backend/functions/package.json'));
const { Timestamp } = backend('firebase-admin/firestore');
const { deterministicId } = require('../../backend/functions/lib/shared/identifiers');
const stable = v => v?.toMillis ? { timestampMs: v.toMillis() } : Array.isArray(v) ? v.map(stable)
  : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, stable(v[k])])) : v;
async function recoverHeldSale(db, plan, { apply = false, expectedHash } = {}) {
  const { input, heldId, archiveId, openedAt, reason } = plan;
  const saleId = deterministicId('sale', `${input.tenantId}:${input.idempotencyKey}`);
  const archiveRef = db.doc(`reconciliation_archives/${archiveId}`), heldRef = db.doc(`open_orders/${heldId}`);
  const preview = await db.runTransaction(async tx => {
    const tableKey = input.tableNumber.trim().toLowerCase().replace(/\s+/g, ' ').replace(/^table\s*/, '');
    const [archive, held, sale, product, movement, session] = await tx.getAll(archiveRef, heldRef, db.doc(`sales/${saleId}`),
      db.doc(`products/${input.lines[0].productId}`), db.doc(`stock_movements/${saleId}_movement_01`),
      db.doc(`table_sessions/${deterministicId('table', `${input.tenantId}:${input.branchId}:${tableKey}`)}`));
    if (archive.exists) {
      assert.equal(archive.data().tenantId, input.tenantId); assert.equal(archive.data().saleId, saleId);
      assert.deepEqual(archive.data().plan, plan);
      return { hash: archive.data().sourceFingerprint, resumed: true };
    }
    assert.equal(sale.exists, false, 'Sale already exists; refresh instead of restoring again');
    assert.equal(movement.exists, false, 'Stock already moved; review before recovering');
    const order = held.data(); assert.ok(order);
    assert.equal(order.tenantId, input.tenantId); assert.equal(order.branchId, input.branchId);
    assert.equal(order.staffId, input.staffId); assert.equal(order.tabId, input.tabId);
    assert.ok(order.deviceId === input.deviceId || order.deviceId.startsWith(`${input.deviceId}--`));
    assert.ok(session.data()?.status !== 'OPEN' || session.data().tabId === input.tabId, 'Table now holds a different bill; review before recovering');
    assert.equal(order.tableNumber, input.tableNumber); assert.equal(order.ref, input.orderReference);
    assert.deepEqual(order.saleUuids, [input.idempotencyKey]); assert.equal(order.openedAt, openedAt);
    assert.deepEqual(order.lines, []); assert.deepEqual(order.payments, []);
    assert.equal(order.totalMinor, 35000); assert.equal(order.dueMinor, 35000);
    assert.equal(order.customerName, 'Walk-In Guest');
    const item = product.data(); assert.equal(item?.tenantId, input.tenantId);
    assert.equal(item.isActive, true); assert.equal(item.sellPriceMinor, 35000);
    assert.equal(item.name, 'TUSKER LAGER BOTTLE 500ML');
    assert.deepEqual(input.lines, [{ productId: product.id, qty: 1 }]);
    assert.deepEqual(input.payments, [{ method: 'credit', amountMinor: 35000 }]);
    // Publication time changes every sync tick; the bill's identity and content must not.
    const { publishedAt: _published, ...source } = order;
    const hash = createHash('sha256').update(JSON.stringify(stable({ plan, source, product: item }))).digest('hex');
    if (apply) {
      assert.equal(expectedHash, hash, 'Held order changed since the reviewed preview');
      tx.create(archiveRef, { tenantId: input.tenantId, branchId: input.branchId, saleId, plan, source,
        sourceFingerprint: hash, status: 'authorized', createdAt: Timestamp.now() });
    }
    return { hash, resumed: false };
  });
  if (!apply) return { ...preview, dryRun: true, saleId, orderReference: input.orderReference, restoredQty: 1, dueMinor: 35000 };
  const { createSale } = require('../../backend/functions/lib/modules/sales/create-sale');
  const response = await createSale.run({ auth: { uid: 'owner-approved-recovery',
    token: { tenant_id: input.tenantId, staff_id: 'user-owner', staff_role: 'owner' } }, data: input });
  assert.equal(response.sale.id, saleId); assert.equal(response.sale.totalMinor, 35000);
  const result = { saleId, invoiceNumber: response.sale.invoiceNumber, orderReference: input.orderReference, restoredQty: 1, dueMinor: 35000 };
  await db.runTransaction(async tx => {
    const [archive, held, current] = await tx.getAll(archiveRef, heldRef, db.doc(`sales/${saleId}`));
    assert.equal(current.data().tenantId, input.tenantId);
    assert.equal(current.data().idempotencyKey, input.idempotencyKey);
    assert.equal(current.data().tableNumber, input.tableNumber);
    const now = Timestamp.now();
    if (archive.data().status === 'complete') {
      if (current.data().orderReference === input.orderReference) return;
      // resolveSharedTab can retire an old voided header and mint a fresh tab.
      // Preserve that safe tab identity while retaining the source bill's reference.
      assert.equal(current.data().orderReference, null);
      tx.update(current.ref, { orderReference: input.orderReference, updatedAt: now });
      tx.create(db.doc(`audit_logs/${archiveId}-reference`), { tenantId: input.tenantId, branchId: input.branchId,
        actorStaffId: 'user-owner', action: 'sale.recovered_reference_restored', entityType: 'sale', entityId: saleId,
        metadata: { from: null, to: input.orderReference, archiveId }, createdAt: now });
      return;
    }
    tx.update(db.doc(`sales/${saleId}`), { soldAt: Timestamp.fromDate(new Date(openedAt)), updatedAt: now,
      orderReference: input.orderReference, reconciliationId: archiveId, recoveredFromDevice: true, recoveryReason: reason });
    if (held.exists && held.data().tenantId === input.tenantId
      && JSON.stringify(held.data().saleUuids) === JSON.stringify([input.idempotencyKey])) tx.delete(heldRef);
    tx.update(archiveRef, { status: 'complete', completedAt: now, result });
    tx.create(db.doc(`audit_logs/${archiveId}`), { tenantId: input.tenantId, branchId: input.branchId,
      actorStaffId: 'user-owner', action: 'sale.missing_items_recovered', entityType: 'sale', entityId: saleId,
      metadata: { reason, restoredQty: 1, productId: input.lines[0].productId, totalMinor: 35000, archiveId }, createdAt: now });
  });
  await require('../../backend/functions/lib/modules/sales/tab-identity').refreshTableSessionForSale(saleId);
  return result;
}
module.exports = { recoverHeldSale };
