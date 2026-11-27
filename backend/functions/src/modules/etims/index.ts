import { randomUUID } from 'node:crypto';
import { Timestamp } from 'firebase-admin/firestore';
import type { DocumentData } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions';
import { HttpsError, onCall } from 'firebase-functions/v2/https';

import { FUNCTION_REGION } from '../../config/runtime';
import { db } from '../../lib/firebase';
import { deterministicId } from '../../shared/identifiers';
import { asRecord, documentId, optionalText } from '../../shared/validation';
import { outstandingMinor, settlingStaff } from '../sales/settle';
import {
  buildItemBody, buildSalesBody, itemCode, oscuPost, OscuUnreachable, signedReceiptData, verifyUrl,
  type EtimsEnvironment, type EtrLine,
} from './oscu';

/**
 * ETR receipts, issued on request once a bill is paid.
 *
 * Each branch is one OSCU device. Its cmcKey is KRA's credential for that
 * device, so it lives in etims_devices, which no client can read; the till
 * only ever sees the signed result.
 */

const PIN = /^[AP]\d{9}[A-Z]$/;
const LEASE_MS = 45_000;
const OK = '000';
const ALREADY_REGISTERED = '994';

const deviceRef = (tenantId: string, branchId: string) => db.collection('etims_devices').doc(`${tenantId}_${branchId}`);
// Counters and registrations belong to one KRA identity and survive reconnects.
const deviceKey = (tenantId: string, branchId: string, device: DocumentData) =>
  `${tenantId}:${branchId}:${device.environment}:${device.tin}:${device.bhfId}`;

function kraRefusal(what: string, reply: { resultCd: string; resultMsg: string }): HttpsError {
  return new HttpsError('failed-precondition', `KRA refused ${what}: ${reply.resultMsg || 'no reason given'} (code ${reply.resultCd}).`);
}

async function assertActiveContext(tenantId: string, branchId: string, staffId: string) {
  const [tenant, branch, staff] = await db.getAll(
    db.collection('tenants').doc(tenantId), db.collection('branches').doc(branchId), db.collection('staff').doc(staffId),
  );
  if (tenant.data()?.status !== 'active' || branch.data()?.tenantId !== tenantId || branch.data()?.status !== 'active'
    || staff.data()?.tenantId !== tenantId || staff.data()?.status !== 'active') {
    throw new HttpsError('failed-precondition', 'This business, branch or staff account is not active.');
  }
  return staff.data()!;
}

/** Connects a branch to its KRA OSCU device. Owners and managers only. */
export const setupEtims = onCall({ region: FUNCTION_REGION }, async (request) => {
  const token = request.auth?.token;
  if (!token?.tenant_id || !token.staff_id || !['owner', 'manager'].includes(String(token.staff_role))) {
    throw new HttpsError('permission-denied', 'Only an owner or manager can connect eTIMS.');
  }
  const tenantId = String(token.tenant_id);
  const input = asRecord(request.data);
  const branchId = documentId(input.branchId, 'branchId');
  const tin = String(optionalText(input.tin, 'KRA PIN', 11) ?? '').toUpperCase();
  const bhfId = optionalText(input.bhfId, 'eTIMS branch ID', 2) ?? '00';
  const dvcSrlNo = optionalText(input.deviceSerial, 'device serial', 100);
  if (input.environment !== undefined && !['sandbox', 'production'].includes(String(input.environment))) {
    throw new HttpsError('invalid-argument', 'Choose sandbox or production.');
  }
  const environment: EtimsEnvironment = input.environment === 'production' ? 'production' : 'sandbox';
  const defaultItemClassCode = optionalText(input.defaultItemClassCode, 'item classification code', 10);
  if (!PIN.test(tin)) throw new HttpsError('invalid-argument', 'Enter the business KRA PIN, e.g. P051234567A.');
  if (!/^\d{2}$/.test(bhfId)) throw new HttpsError('invalid-argument', 'The eTIMS branch ID is two digits, e.g. 00.');
  if (!dvcSrlNo) throw new HttpsError('invalid-argument', 'Enter the device serial number KRA approved for OSCU.');
  if (defaultItemClassCode && !/^\d{1,10}$/.test(defaultItemClassCode)) {
    throw new HttpsError('invalid-argument', 'The item classification code is up to 10 digits.');
  }

  const staff = await assertActiveContext(tenantId, branchId, String(token.staff_id));
  if (!['owner', 'manager'].includes(String(staff.role))) {
    throw new HttpsError('permission-denied', 'Only an owner or manager can connect eTIMS.');
  }

  let reply;
  try {
    reply = await oscuPost(environment, '/selectInitOsdcInfo', {}, { tin, bhfId, dvcSrlNo });
  } catch (error) {
    throw new HttpsError('unavailable', `KRA eTIMS could not be reached: ${(error as Error).message}`);
  }
  const info = (reply.data?.info ?? {}) as Record<string, unknown>;
  if (reply.resultCd !== OK) throw kraRefusal('the device', reply);
  if (typeof info.cmcKey !== 'string' || !info.cmcKey.trim() || !String(info.sdcId ?? info.sdicId ?? '').trim()) {
    throw new HttpsError('unavailable', 'KRA returned incomplete device details. Contact your eTIMS administrator.');
  }

  const ref = deviceRef(tenantId, branchId);
  const device = { tenantId, branchId, environment, tin, bhfId, dvcSrlNo };
  await db.runTransaction(async (tx) => {
    const [existingDoc, branchDoc] = await tx.getAll(ref, db.collection('branches').doc(branchId));
    if (branchDoc.data()?.tenantId !== tenantId || branchDoc.data()?.status !== 'active') {
      throw new HttpsError('failed-precondition', 'This branch is not active.');
    }
    const existing = existingDoc.data();
    if (existing && (existing.tenantId !== tenantId || existing.branchId !== branchId)) {
      throw new HttpsError('failed-precondition', 'This eTIMS connection needs administrator review.');
    }
    const sameIdentity = existing && deviceKey(tenantId, branchId, existing) === deviceKey(tenantId, branchId, device);
    // Switching back to an earlier identity must not reuse its invoice numbers.
    const counterRef = db.collection('etims_counters').doc(deterministicId('etims-counter', deviceKey(tenantId, branchId, device)));
    const counters = (await tx.get(counterRef)).data();
    if (existing && !sameIdentity) {
      const previousCounterRef = db.collection('etims_counters').doc(deterministicId('etims-counter', deviceKey(tenantId, branchId, existing)));
      tx.set(previousCounterRef, { tenantId, branchId, nextInvcNo: existing.nextInvcNo ?? 1, nextItemSeq: existing.nextItemSeq ?? 1 });
    }
    tx.set(ref, {
      ...device,
      cmcKey: info.cmcKey,
      sdcId: String(info.sdcId ?? info.sdicId ?? ''),
      mrcNo: String(info.mrcNo ?? ''),
      defaultItemClassCode,
      nextInvcNo: sameIdentity ? existing.nextInvcNo : counters?.nextInvcNo ?? 1,
      nextItemSeq: sameIdentity ? existing.nextItemSeq : counters?.nextItemSeq ?? 1,
      updatedAt: Timestamp.now(),
      updatedByStaffId: String(token.staff_id ?? ''),
    });
    tx.create(db.collection('audit_logs').doc(), {
      tenantId, branchId, actorStaffId: String(token.staff_id), action: 'etims.device_connected',
      entityType: 'etims_device', entityId: ref.id, createdAt: Timestamp.now(),
      metadata: { environment, tin, bhfId, sdcId: String(info.sdcId ?? info.sdicId), defaultItemClassCode },
    });
  });
  return { environment, sdcId: String(info.sdcId ?? info.sdicId ?? ''), mrcNo: String(info.mrcNo ?? '') };
});

/** Registers every product on the bill with KRA that has not been registered yet. */
async function registerItems(
  tenantId: string, branchId: string, device: DocumentData, staffId: string,
  products: Map<string, DocumentData>,
): Promise<Map<string, string>> {
  const codes = new Map<string, string>();
  const ref = deviceRef(tenantId, branchId);
  for (const [productId, product] of products) {
    const itemRef = db.collection('etims_items').doc(deterministicId('etims-item', `${deviceKey(tenantId, branchId, device)}:${productId}`));
    const item = await db.runTransaction(async (tx) => {
      const [itemDoc, deviceDoc] = await tx.getAll(itemRef, ref);
      if (deviceKey(tenantId, branchId, deviceDoc.data() ?? {}) !== deviceKey(tenantId, branchId, device)
        || deviceDoc.data()?.cmcKey !== device.cmcKey) {
        throw new HttpsError('aborted', 'The eTIMS connection changed. Refresh before trying again.');
      }
      if (itemDoc.exists) return itemDoc.data() as DocumentData;
      const sequence = Number(deviceDoc.data()?.nextItemSeq) || 1;
      const created = { tenantId, branchId, productId, itemCd: itemCode(product.isService === true, sequence), registered: false };
      tx.set(itemRef, created);
      tx.update(ref, { nextItemSeq: sequence + 1 });
      return created;
    });
    if (!item.registered) {
      const reply = await oscuPost(device.environment, '/saveItem', { tin: device.tin, bhfId: device.bhfId, cmcKey: device.cmcKey }, buildItemBody({
        tin: device.tin, bhfId: device.bhfId, itemCd: item.itemCd, itemClsCd: product.itemClsCd,
        isService: product.isService === true, name: String(product.name ?? ''), taxCode: String(product.taxCode),
        priceMinor: Number(product.sellPriceMinor) || 0, staffId,
      }));
      if (reply.resultCd !== OK && reply.resultCd !== ALREADY_REGISTERED) throw kraRefusal(`item "${product.name}"`, reply);
      await itemRef.update({ registered: true, registeredAt: Timestamp.now() });
    }
    codes.set(productId, item.itemCd);
  }
  return codes;
}

/**
 * Signs a paid bill with KRA and returns what the ETR receipt prints.
 *
 * A table's bill can span several rounds; they become one KRA invoice. Asking
 * again for the same bill returns the same signature rather than a second one.
 */
export const generateEtr = onCall({ region: FUNCTION_REGION, timeoutSeconds: 120 }, async (request) => {
  const actor = settlingStaff(request.auth?.token);
  const input = asRecord(request.data);
  if (!Array.isArray(input.saleIds) || !input.saleIds.length || input.saleIds.length > 50) {
    throw new HttpsError('invalid-argument', 'Choose the bill to generate an ETR for.');
  }
  const saleIds = [...new Set(input.saleIds.map((id) => documentId(id, 'saleId')))].sort();
  const buyerPin = optionalText(input.buyerPin, 'buyer KRA PIN', 11)?.toUpperCase() ?? null;
  if (buyerPin && !PIN.test(buyerPin)) throw new HttpsError('invalid-argument', 'The buyer KRA PIN looks wrong. It is 11 characters, e.g. P051234567A.');

  const saleDocs = await db.getAll(...saleIds.map((id) => db.collection('sales').doc(id)));
  const sales = saleDocs.map((doc) => {
    const sale = doc.data();
    if (!doc.exists || !sale || sale.tenantId !== actor.tenantId) throw new HttpsError('not-found', 'This bill has not reached the server yet. Try again in a moment.');
    if (String(sale.status).toUpperCase() === 'VOIDED') throw new HttpsError('failed-precondition', 'A voided order cannot have an ETR.');
    return sale;
  });
  const branchId = String(sales[0].branchId);
  if (sales.some((sale) => sale.branchId !== branchId)) throw new HttpsError('invalid-argument', 'One ETR covers one branch.');
  const staff = await assertActiveContext(actor.tenantId, branchId, actor.staffId);
  settlingStaff({ tenant_id: actor.tenantId, staff_id: actor.staffId, staff_role: staff.role });
  if (sales.every((sale) => sale.etr?.rcptSign) && new Set(sales.map((sale) => sale.etr.rcptSign)).size === 1) return sales[0].etr;

  const deviceDoc = await deviceRef(actor.tenantId, branchId).get();
  const device = deviceDoc.data();
  if (!device?.cmcKey || device.tenantId !== actor.tenantId || device.branchId !== branchId) {
    throw new HttpsError('failed-precondition', 'eTIMS is not connected for this branch. An owner can connect it in Settings → KRA eTIMS.');
  }
  const key = deviceKey(actor.tenantId, branchId, device);
  const receiptId = deterministicId('etr', `${key}:${saleIds.join(',')}`);
  if (sales.some((sale) => sale.etrReceiptId && sale.etrReceiptId !== receiptId)) {
    throw new HttpsError('failed-precondition', 'Part of this bill already has its own ETR.');
  }

  const payments: DocumentData[] = [];
  for (const saleId of saleIds) {
    const ledger = await db.collection('payments').where('saleId', '==', saleId).get();
    const rows = ledger.docs.map((row) => row.data());
    if (rows.some((row) => row.tenantId !== actor.tenantId || row.status === 'receipt_conflict')) {
      throw new HttpsError('failed-precondition', 'Review this bill\'s payments before generating an ETR.');
    }
    if (!rows.length || outstandingMinor(rows) > 0) throw new HttpsError('failed-precondition', 'Take payment first. An ETR is issued for a paid bill.');
    payments.push(...rows);
  }

  const lineIds = sales.flatMap((sale) => (Array.isArray(sale.lineIds) ? sale.lineIds.map(String) : []));
  const lineDocs = lineIds.length ? await db.getAll(...lineIds.map((id) => db.collection('sale_lines').doc(id))) : [];
  if (lineDocs.some((doc) => !doc.exists || doc.data()?.tenantId !== actor.tenantId || !saleIds.includes(String(doc.data()?.saleId)))) {
    throw new HttpsError('failed-precondition', 'This bill\'s items need review before generating an ETR.');
  }
  const lines = lineDocs.map((doc) => doc.data()).filter((line): line is DocumentData => Boolean(line) && Number(line?.qty) > 0);
  if (!lines.length) throw new HttpsError('failed-precondition', 'This bill has no items.');

  const productIds = [...new Set(lines.map((line) => String(line.productId)))];
  const productDocs = await db.getAll(...productIds.map((id) => db.collection('products').doc(id)));
  const products = new Map<string, DocumentData>();
  const unclassified: string[] = [];
  productDocs.forEach((doc, index) => {
    const product = doc.data() ?? {};
    if (!doc.exists || product.tenantId !== actor.tenantId) {
      throw new HttpsError('failed-precondition', 'An item on this bill is unavailable for this business.');
    }
    const itemClsCd = String(product.itemClassCode || device.defaultItemClassCode || '');
    if (!itemClsCd) unclassified.push(String(product.name || productIds[index]));
    products.set(productIds[index], { ...product, itemClsCd });
  });
  if (unclassified.length) {
    throw new HttpsError('failed-precondition', `Set a KRA item classification code for: ${unclassified.join(', ')}. A default can be set in Settings → KRA eTIMS.`);
  }

  const headers = { tin: device.tin, bhfId: device.bhfId, cmcKey: device.cmcKey };
  const receiptRef = db.collection('etims_receipts').doc(receiptId);
  const attemptId = randomUUID();
  try {
    const itemCodes = await registerItems(actor.tenantId, branchId, device, actor.staffId, products);
    const etrLines: EtrLine[] = lines.map((line) => ({
      productName: String(line.productName || products.get(String(line.productId))?.name || ''),
      qty: Number(line.qty),
      unitPriceMinor: Number(line.unitPriceMinor),
      discountMinor: Number(line.discountMinor) || 0,
      taxCode: String(line.taxCode),
      taxMinor: Number(line.taxMinor) || 0,
      lineTotalMinor: Number(line.lineTotalMinor),
      itemCd: itemCodes.get(String(line.productId)) ?? '',
      itemClsCd: String(products.get(String(line.productId))?.itemClsCd),
    }));

    // Claim the entire bill atomically, including overlapping requests from other tills.
    // Once allocated, the invoice body is immutable even after a refusal.
    const submission = await db.runTransaction(async (tx) => {
      const [receiptDoc, freshDevice, ...freshSales] = await tx.getAll(receiptRef, deviceRef(actor.tenantId, branchId), ...saleDocs.map(doc => doc.ref));
      const receipt = receiptDoc.data();
      if (deviceKey(actor.tenantId, branchId, freshDevice.data() ?? {}) !== key || freshDevice.data()?.cmcKey !== device.cmcKey) {
        throw new HttpsError('aborted', 'The eTIMS connection changed. Refresh before trying again.');
      }
      freshSales.forEach((doc, index) => {
        const sale = doc.data();
        if (!sale || sale.tenantId !== actor.tenantId || sale.branchId !== branchId || String(sale.status).toUpperCase() === 'VOIDED') {
          throw new HttpsError('failed-precondition', 'This bill is no longer available. Refresh before trying again.');
        }
        if (sale.etrReceiptId && sale.etrReceiptId !== receiptId) {
          throw new HttpsError('failed-precondition', 'Part of this bill already has its own ETR.');
        }
        if (!doc.updateTime?.isEqual(saleDocs[index].updateTime!)) {
          throw new HttpsError('aborted', 'This bill changed. Refresh before generating an ETR.');
        }
      });
      const now = Date.now();
      if (receipt?.status === 'signed') return null;
      if (receipt?.status === 'needs_reconciliation') {
        throw new HttpsError('failed-precondition', 'This ETR needs review by your eTIMS administrator.');
      }
      if (receipt && Number(receipt.leaseUntil?.toMillis?.() || 0) > now) {
        throw new HttpsError('aborted', 'This ETR is already being generated on another till. Try again in a moment.');
      }
      let invcNo = Number(receipt?.invcNo);
      let next = receipt?.body as Record<string, unknown> | undefined;
      if (!receipt) {
        invcNo = Number(freshDevice.data()?.nextInvcNo) || 1;
        tx.update(freshDevice.ref, { nextInvcNo: invcNo + 1 });
      }
      if (!next) {
        next = buildSalesBody({
          tin: device.tin, bhfId: device.bhfId, invcNo,
          trdInvcNo: String(sales[0].orderReference || sales[0].invoiceNumber || saleIds[0]),
          buyerPin, soldAt: sales[0].soldAt.toDate(), confirmedAt: new Date(now),
          staffId: actor.staffId, lines: etrLines, payments,
        });
      }
      // Firestore maps do not retain JSON property order. Persist the wire bytes
      // as well as the inspectable body so a retry really is the same request.
      const requestJson = typeof receipt?.requestJson === 'string' ? receipt.requestJson : JSON.stringify(next);
      tx.set(receiptRef, {
        tenantId: actor.tenantId, branchId, saleIds, invcNo, body: next, requestJson, status: 'sending',
        leaseUntil: Timestamp.fromMillis(now + LEASE_MS), attemptId, requestedByStaffId: actor.staffId,
        createdAt: receipt?.createdAt ?? Timestamp.now(), updatedAt: Timestamp.now(),
      }, { merge: true });
      for (const doc of saleDocs) tx.update(doc.ref, { etrReceiptId: receiptId });
      return { body: next, requestJson };
    });
    if (!submission) return (await receiptRef.get()).data()?.etr;
    const { body, requestJson } = submission;

    // Fence late responses: an expired request must not overwrite a newer attempt.
    const finishAttempt = async (changes: DocumentData, etr?: DocumentData) => db.runTransaction(async tx => {
      const current = (await tx.get(receiptRef)).data();
      if (current?.status === 'signed') return current.etr;
      if (current?.attemptId !== attemptId) throw new HttpsError('aborted', 'Another till is handling this ETR. Refresh in a moment.');
      tx.update(receiptRef, { ...changes, leaseUntil: null, updatedAt: Timestamp.now() });
      if (etr) {
        for (const doc of saleDocs) tx.update(doc.ref, { etr, fiscalStatus: 'fiscalized', updatedAt: Timestamp.now() });
        tx.create(db.collection('audit_logs').doc(deterministicId('etr-signed', receiptId)), {
          tenantId: actor.tenantId, branchId, actorStaffId: actor.staffId, action: 'etims.invoice_signed',
          entityType: 'etims_receipt', entityId: receiptId,
          metadata: { environment: device.environment, saleIds, invcNo: body.invcNo, rcptSign: etr.rcptSign }, createdAt: Timestamp.now(),
        });
      }
      return etr;
    });

    let reply;
    let signed;
    try {
      reply = await oscuPost(device.environment, '/saveTrnsSalesOsdc', headers, requestJson);
      if (reply.resultCd === OK) signed = signedReceiptData(reply.data);
    } catch (error) {
      const completed = await finishAttempt({ status: 'uncertain', error: (error as Error).message });
      if (completed) return completed;
      throw new HttpsError('unavailable', 'KRA confirmation is pending. Try Generate ETR again in a moment.');
    }
    if (reply.resultCd !== OK) {
      const completed = await finishAttempt({ status: reply.resultCd === ALREADY_REGISTERED ? 'needs_reconciliation' : 'rejected', resultCd: reply.resultCd, resultMsg: reply.resultMsg });
      if (completed) return completed;
      throw kraRefusal('the invoice', reply);
    }

    const etr = {
      environment: device.environment,
      invcNo: Number(body.invcNo),
      sdcId: device.sdcId,
      mrcNo: device.mrcNo,
      ...signed!,
      buyerPin: (body.custTin as string | null) ?? null,
      verifyUrl: verifyUrl(device.environment, device.tin, device.bhfId, signed!.rcptSign),
    };
    return await finishAttempt({ status: 'signed', resultCd: reply.resultCd, etr, signedAt: Timestamp.now() }, etr);
  } catch (error) {
    if (error instanceof HttpsError) throw error;
    if (error instanceof OscuUnreachable) throw new HttpsError('unavailable', `KRA eTIMS could not be reached: ${error.message}`);
    logger.error('generateEtr failed', { error, tenantId: actor.tenantId, saleIds });
    throw new HttpsError('internal', 'The ETR could not be generated.');
  }
});
