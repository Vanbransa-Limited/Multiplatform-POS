import { createHash } from 'node:crypto';
import { Timestamp, type DocumentData, type DocumentReference, type Transaction } from 'firebase-admin/firestore';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import { FUNCTION_REGION } from '../../config/runtime';
import { db } from '../../lib/firebase';
import { deterministicId } from '../../shared/identifiers';
import { asRecord, documentId } from '../../shared/validation';
import { serviceStaff } from '../customer-orders/domain';
import { hasPrintedReceipt, receiptFingerprint, saleReceiptLines } from './printed-receipt';

type Target = { ref: DocumentReference; data: DocumentData; lines: DocumentData[]; fingerprint: string };

async function targetsFor(tx: Transaction, tenantId: string, input: DocumentData): Promise<Target[]> {
  const refs = input.customerOrderId
    ? [db.collection('customer_orders').doc(documentId(input.customerOrderId, 'customerOrderId'))]
    : (() => {
      if (!Array.isArray(input.saleUuids) || !input.saleUuids.length || input.saleUuids.length > 200) {
        throw new HttpsError('invalid-argument', 'Choose the orders to print.');
      }
      return [...new Set<string>(input.saleUuids.map((id: unknown) => documentId(id, 'saleUuid')))]
        .sort().map(uuid => db.collection('sales').doc(deterministicId('sale', `${tenantId}:${uuid}`)));
    })();
  const docs = await tx.getAll(...refs);
  const targets: Target[] = [];
  for (const doc of docs) {
    const data = doc.data();
    if (!data || data.tenantId !== tenantId || ['VOIDED', 'CANCELLED'].includes(String(data.status).toUpperCase())) {
      throw new HttpsError('failed-precondition', 'This order is unavailable. Refresh orders.');
    }
    if (targets.length && targets[0].data.branchId !== data.branchId) {
      throw new HttpsError('invalid-argument', 'Print orders from one branch at a time.');
    }
    const lines = input.customerOrderId ? data.lines || [] : await saleReceiptLines(tx, doc.id);
    if (!lines.length) throw new HttpsError('failed-precondition', 'This order has no items to print.');
    targets.push({ ref: doc.ref, data, lines, fingerprint: receiptFingerprint(data, lines) });
  }
  const branch = await tx.get(db.collection('branches').doc(String(targets[0].data.branchId)));
  if (branch.data()?.tenantId !== tenantId || branch.data()?.status !== 'active') {
    throw new HttpsError('failed-precondition', 'This branch is unavailable.');
  }
  return targets;
}

/** A server-built unpaid receipt; status checks never create jobs or move money. */
export const prepareCheckoutReceipt = onCall({ region: FUNCTION_REGION }, async request => {
  const actor = serviceStaff(request.auth?.token);
  const input = asRecord(request.data);
  return db.runTransaction(async tx => {
    const targets = await targetsFor(tx, actor.tenantId, input);
    const printed = targets.every(target => hasPrintedReceipt(target.data, target.lines));
    if (printed) return { printed: true, queued: false };
    const signature = targets.map(target => ({ path: target.ref.path, fingerprint: target.fingerprint }));
    const hash = createHash('sha256').update(JSON.stringify(signature)).digest('hex');
    const jobRef = db.collection('print_jobs').doc(`checkout_${hash}`);
    const job = await tx.get(jobRef);
    if (job.exists) return { printed: false, queued: job.data()?.status === 'queued', jobId: jobRef.id };
    if (input.queue !== true) return { printed: false, queued: false };
    const first = targets[0].data;
    const [tenant, branch, staff, customer] = await tx.getAll(
      db.collection('tenants').doc(actor.tenantId), db.collection('branches').doc(String(first.branchId)),
      db.collection('staff').doc(actor.staffId), db.collection('customers').doc(String(first.customerId || '_walkin')),
    );
    const business = tenant.data() || {};
    const minorSum = (field: string) => targets.reduce((sum, target) => sum + Number(target.data[field] || 0), 0) / 100;
    const now = Timestamp.now();
    tx.create(jobRef, {
      id: jobRef.id, tenantId: actor.tenantId, branchId: first.branchId,
      status: 'queued', widthClass: 'receipt-paper-58', createdAt: now,
      createdByStaffId: actor.staffId,
      // Rules forbid browsers from creating or updating this authorization payload.
      checkoutReceipt: {
        customerOrderId: input.customerOrderId || null,
        saleUuids: input.customerOrderId ? [] : input.saleUuids,
        targets: signature,
      },
      receipt: {
        tenantName: business.tradingName || business.trading_name || business.name || '',
        branchName: branch.data()?.name || '', kraPin: business.kraPin || business.kra_pin || '',
        phone: business.phone || '', invoiceNo: first.orderReference || first.invoiceNumber || first.ref,
        soldAt: now.toDate().toISOString(), cashierName: staff.data()?.name || '',
        customerName: first.customerName || (customer.data()?.tenantId === actor.tenantId ? customer.data()?.name : '') || 'Guest',
        tableNo: first.tableNumber || null,
        lines: targets.flatMap(target => target.lines.map(line => ({
          name: line.productName || line.name || 'Item', qty: line.qty,
          unitPrice: Number(line.unitPriceMinor || 0) / 100,
          lineTotal: Number(line.lineTotalMinor ?? line.totalMinor ?? 0) / 100,
          taxCode: line.taxCode || '',
        }))),
        subtotal: minorSum('subtotalMinor') || minorSum('totalMinor'),
        taxTotal: minorSum('taxMinor'), grandTotal: minorSum('totalMinor'),
        paymentMethod: 'PROFORMA', unpaid: true,
      },
    });
    return { printed: false, queued: true, jobId: jobRef.id };
  });
});

/** The station confirms paper after the dialog; queued or cancelled jobs cannot unlock payment. */
export const confirmCheckoutReceiptPrinted = onCall({ region: FUNCTION_REGION }, async request => {
  const actor = serviceStaff(request.auth?.token);
  const input = asRecord(request.data);
  const jobId = documentId(input.jobId, 'jobId');
  const deviceId = documentId(input.deviceId, 'deviceId');
  if (input.confirmed !== true) throw new HttpsError('failed-precondition', 'Confirm the receipt printed first.');
  return db.runTransaction(async tx => {
    const jobRef = db.collection('print_jobs').doc(jobId);
    const [jobDoc, device] = await tx.getAll(jobRef, db.collection('devices').doc(deviceId));
    const job = jobDoc.data();
    if (!job || job.tenantId !== actor.tenantId || !job.checkoutReceipt) throw new HttpsError('not-found', 'Receipt not found.');
    if (device.data()?.tenantId !== actor.tenantId || device.data()?.branchId !== job.branchId || device.data()?.status !== 'active') {
      throw new HttpsError('failed-precondition', 'Use an active print station in this branch.');
    }
    if (job.status === 'printed') return { printed: true };
    const targets = await targetsFor(tx, actor.tenantId, job.checkoutReceipt);
    if (JSON.stringify(targets.map(target => ({ path: target.ref.path, fingerprint: target.fingerprint }))) !== JSON.stringify(job.checkoutReceipt.targets)) {
      throw new HttpsError('failed-precondition', 'This bill changed. Print the updated receipt.');
    }
    const now = Timestamp.now();
    for (const target of targets) tx.update(target.ref, {
      printedReceipt: { fingerprint: target.fingerprint, jobId, confirmedAt: now, confirmedByStaffId: actor.staffId, deviceId },
    });
    tx.update(jobRef, { status: 'printed', printedAt: now, printedByDeviceId: deviceId, printedByStaffId: actor.staffId });
    return { printed: true };
  });
});
