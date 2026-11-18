import { Timestamp } from 'firebase-admin/firestore';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import { FUNCTION_REGION } from '../../config/runtime';
import { db } from '../../lib/firebase';
import { deterministicId } from '../../shared/identifiers';
import { asRecord, documentId, minorUnits, optionalText } from '../../shared/validation';
import { settlingStaff, outstandingMinor, attemptBlocks } from '../sales/settle';
import { readReceiptUsage, receiptAllocation } from '../../shared/mpesa-receipt';

const ISSUERS = new Set(['owner', 'store_manager', 'supervisor']);
const required = (value: unknown, name: string, max = 160) => {
  const text = optionalText(value, name, max);
  if (!text) throw new HttpsError('invalid-argument', `Enter ${name}.`);
  return text;
};
const date = (value: unknown, name: string) => {
  const text = required(value, name, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || !Number.isFinite(Date.parse(text))
    || new Date(text).toISOString().slice(0, 10) !== text) {
    throw new HttpsError('invalid-argument', `Enter a valid ${name}.`);
  }
  return text;
};

/** Only the immutable, printable fields cross this boundary. Totals are server-calculated. */
export function parseProforma(value: unknown) {
  const input = asRecord(value);
  const fields = (value: unknown, keys: string[]) => {
    const record = asRecord(value);
    return Object.fromEntries(keys.map(key => [key, optionalText(record[key], key, 500) || '']));
  };
  const business = fields(input.business, ['name', 'address', 'phone', 'email', 'kraPin']);
  const client = fields(input.client, ['name', 'company', 'address', 'phone', 'email', 'kraPin']);
  if (!client.name || !business.name) throw new HttpsError('invalid-argument', 'Enter the business and client names.');
  if (!Array.isArray(input.lines) || !input.lines.length || input.lines.length > 100) {
    throw new HttpsError('invalid-argument', 'Add between 1 and 100 invoice lines.');
  }
  const lines = input.lines.map(value => {
    const line = asRecord(value);
    const qty = Number(line.qty);
    if (!Number.isSafeInteger(qty) || qty <= 0 || qty > 1_000_000) {
      throw new HttpsError('invalid-argument', 'Quantity must be a positive whole number.');
    }
    return { description: required(line.description, 'line description', 500), qty,
      unitMinor: minorUnits(line.unitMinor, 'unit price') };
  });
  const subtotalMinor = minorUnits(lines.reduce((sum, line) => sum + line.qty * line.unitMinor, 0), 'subtotal');
  const discountMinor = minorUnits(input.discountMinor ?? 0, 'discount');
  if (discountMinor >= subtotalMinor) throw new HttpsError('invalid-argument', 'The amount due must be greater than zero.');
  const dueMinor = subtotalMinor - discountMinor;
  const invoiceDate = date(input.date, 'invoice date');
  const dueDate = date(input.dueDate, 'due date');
  if (dueDate < invoiceDate) throw new HttpsError('invalid-argument', 'Due date cannot be before the invoice date.');
  return {
    business, client, number: required(input.number, 'proforma number', 80), date: invoiceDate, dueDate,
    subject: optionalText(input.subject, 'subject', 500) || '',
    quoteRef: optionalText(input.quoteRef, 'quote reference', 120) || '',
    lpo: optionalText(input.lpo, 'LPO', 120) || '', lines, discountMinor,
    terms: optionalText(input.terms, 'terms', 2000) || '',
    bank: fields(input.bank, ['bank', 'branch', 'accountName', 'accountNo']),
    paybill: optionalText(input.paybill, 'paybill', 80) || '',
    signedBy: optionalText(input.signedBy, 'authorised by', 160) || '',
    subtotalMinor, dueMinor, vatMinor: Math.round(dueMinor * 16 / 116),
  };
}

export const issueProforma = onCall({ region: FUNCTION_REGION }, async request => {
  const actor = settlingStaff(request.auth?.token);
  if (!ISSUERS.has(String(request.auth?.token.staff_role))) {
    throw new HttpsError('permission-denied', 'Only an owner, store manager or supervisor can issue a proforma.');
  }
  const input = asRecord(request.data);
  const requestId = documentId(input.requestId, 'requestId');
  const branchId = documentId(input.branchId, 'branchId');
  const invoice = parseProforma(input.invoice);
  const fingerprint = deterministicId('content', JSON.stringify({ invoice, branchId }));
  const ref = db.collection('proformas').doc(deterministicId('proforma', `${actor.tenantId}:${requestId}`));
  const numberRef = db.collection('proforma_numbers').doc(deterministicId('number', `${actor.tenantId}:${invoice.number.toUpperCase()}`));
  return db.runTransaction(async tx => {
    const [existing, number, tenant, branch] = await tx.getAll(ref, numberRef,
      db.collection('tenants').doc(actor.tenantId), db.collection('branches').doc(branchId));
    if (existing.exists) {
      if (existing.data()?.fingerprint !== fingerprint) throw new HttpsError('failed-precondition', 'This proforma is already issued and cannot be edited.');
      return { id: ref.id, number: invoice.number };
    }
    if (number.exists) throw new HttpsError('already-exists', 'That proforma number is already issued. Choose another number.');
    if (tenant.data()?.status !== 'active' || branch.data()?.tenantId !== actor.tenantId || branch.data()?.status !== 'active') {
      throw new HttpsError('failed-precondition', 'Choose an active branch for this business.');
    }
    const now = Timestamp.now();
    tx.create(ref, { tenantId: actor.tenantId, branchId, invoice, fingerprint,
      createdAt: now, createdByStaffId: actor.staffId, paymentStatus: 'unpaid' });
    tx.create(numberRef, { tenantId: actor.tenantId, proformaId: ref.id });
    tx.create(db.collection('audit_logs').doc(), { tenantId: actor.tenantId, actorStaffId: actor.staffId,
      action: 'proforma.issued', entityId: ref.id, metadata: { number: invoice.number, dueMinor: invoice.dueMinor }, createdAt: now });
    return { id: ref.id, number: invoice.number };
  });
});

/** No invoice updates: one atomic settlement writes the shared payment ledger once. */
export const payProforma = onCall({ region: FUNCTION_REGION }, async request => {
  const actor = settlingStaff(request.auth?.token);
  const input = asRecord(request.data);
  const id = documentId(input.proformaId, 'proformaId');
  const method = String(input.method || '');
  if (!['cash', 'bank_transfer', 'card', 'mpesa'].includes(method)) throw new HttpsError('invalid-argument', 'Choose a payment method.');
  const reference = method === 'mpesa'
    ? required(input.reference, 'M-Pesa code', 60).toUpperCase()
    : optionalText(input.reference, 'payment reference', 120) || '';
  if (['bank_transfer', 'card'].includes(method) && !reference) throw new HttpsError('invalid-argument', 'Enter the payment reference.');
  const ref = db.collection('proformas').doc(id);
  const paymentRef = db.collection('payments').doc(deterministicId('proforma-payment', `${actor.tenantId}:${id}`));
  const eventRef = db.collection('mpesa_c2b_events').doc(deterministicId('c2b', `confirmation:${reference}`));
  const intentRef = db.collection('payment_intents').doc(deterministicId('intent', `${actor.tenantId}:${reference}`));
  return db.runTransaction(async tx => {
    const [doc, payment, settings, event, intent] = await tx.getAll(ref, paymentRef,
      db.collection('tenant_settings').doc(actor.tenantId), eventRef, intentRef);
    const record = doc.data();
    if (!doc.exists || record?.tenantId !== actor.tenantId) throw new HttpsError('not-found', 'Proforma not found.');
    if (payment.exists || record.paymentStatus === 'paid') return { id, paymentStatus: 'paid', alreadyPaid: true };
    if (!settings.data()?.acceptedPaymentMethods?.includes(method)) throw new HttpsError('failed-precondition', 'This business has not enabled that payment method.');
    const dueMinor = minorUnits(record.invoice.dueMinor, 'amount due', false);
    // A prepared document can re-present an existing unpaid till bill. Its
    // original receivable and this invoice must settle in the same transaction.
    let linkedCredit: FirebaseFirestore.QueryDocumentSnapshot[] = [];
    if (record.linkedSaleId) {
      const sale = await tx.get(db.collection('sales').doc(documentId(record.linkedSaleId, 'linkedSaleId')));
      const saved = sale.data();
      if (!sale.exists || saved?.tenantId !== actor.tenantId || saved.branchId !== record.branchId
        || saved.proformaId !== id || String(saved.status).toUpperCase() === 'VOIDED') {
        throw new HttpsError('failed-precondition', 'The original bill is unavailable. Reconcile it before recording payment.');
      }
      if (Number(saved.checkoutExpiresAt?.toMillis?.() || 0) > Date.now()) {
        throw new HttpsError('failed-precondition', 'Payment is in progress on the original bill. Reconcile it first.');
      }
      if (saved.checkoutStkKey) {
        const previous = await tx.get(db.collection('mpesa_payments').doc(deterministicId('mpesa-attempt', `${actor.tenantId}:${saved.checkoutStkKey}`)));
        const blocked = attemptBlocks(previous.data(), method === 'mpesa' ? 'mpesa' : 'other', Date.now());
        if (blocked) throw new HttpsError('failed-precondition', blocked);
      }
      const ledger = await tx.get(db.collection('payments').where('saleId', '==', sale.id));
      if (outstandingMinor(ledger.docs.map(row => row.data())) !== dueMinor) {
        throw new HttpsError('failed-precondition', 'The original bill balance differs from this proforma. Reconcile the bill first.');
      }
      linkedCredit = ledger.docs.filter(row => row.data().method === 'credit' && !row.data().settledAt);
    }
    if (method === 'mpesa') {
      const confirmation = event.data();
      if (!event.exists || confirmation?.tenantId !== actor.tenantId || confirmation.disposition === 'quarantined'
        || confirmation.settledSaleId || confirmation.settledCustomerOrderId || confirmation.settledProformaId
        || (intent.exists && (intent.data()?.status !== 'verified' || intent.data()?.consumedSaleId))) {
        throw new HttpsError('failed-precondition', 'This M-Pesa code is unavailable or already used. Check the received payment.');
      }
      // Match exactly: an overpayment must be reconciled, never silently discarded.
      if (confirmation.payload?.amountMinor !== dueMinor) throw new HttpsError('failed-precondition', 'The confirmed M-Pesa amount must match the full invoice amount.');
    }
    const now = Timestamp.now();
    if (method === 'mpesa') {
      const usage = await readReceiptUsage(tx, actor.tenantId, reference);
      tx.set(usage.ref, receiptAllocation(usage, { tenantId: actor.tenantId, reference,
        allocationId: `proforma:${id}`, target: `proforma:${id}`, amountMinor: dueMinor,
        limitMinor: dueMinor, verified: true, now }));
    }
    tx.update(ref, { paymentStatus: 'paid', paidAt: now, settledByStaffId: actor.staffId,
      paymentMethod: method, paymentReference: reference, paymentId: paymentRef.id });
    tx.create(paymentRef, { tenantId: actor.tenantId, branchId: record.branchId, proformaId: id,
      ...(record.linkedSaleId ? { saleId: record.linkedSaleId } : {}),
      method, amountMinor: dueMinor, reference, status: 'completed', paidAt: now,
      receivedByStaffId: actor.staffId, verified: method === 'mpesa', source: 'proforma' });
    for (const credit of linkedCredit) tx.update(credit.ref, { settledAt: now, settledByStaffId: actor.staffId,
      settledMethod: method, settledReference: reference || null, settledProformaId: id });
    if (method === 'mpesa') {
      tx.update(eventRef, { settledProformaId: id, settledAt: now, settlementStatus: 'settled_proforma' });
      if (intent.exists) tx.update(intentRef, { status: 'consumed', consumedProformaId: id, consumedAt: now });
    }
    tx.create(db.collection('audit_logs').doc(), { tenantId: actor.tenantId, actorStaffId: actor.staffId,
      action: 'proforma.paid', entityId: id, metadata: { method, reference, amountMinor: dueMinor }, createdAt: now });
    return { id, paymentStatus: 'paid', alreadyPaid: false };
  });
});
