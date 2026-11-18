import test from 'node:test';
import assert from 'node:assert/strict';
import { financialSnapshot, financialAnswer } from './financial-snapshot.js';

const record = { id: 'pf1', tenantId: 'tenant', branchId: 'branch', createdByStaffId: 'issuer',
  createdAt: '2026-10-01T09:00:00Z', paymentStatus: 'unpaid',
  invoice: { number: 'PF-001', client: { name: 'Acme' }, dueMinor: 19000 } };
const snapshot = (day, changes = {}) => financialSnapshot({ tenantId: 'tenant',
  from: Date.parse(`${day}T00:00:00+03:00`), to: Date.parse(`${day}T23:59:59.999+03:00`),
  proformas: [record], ...changes });

test('standalone proformas remain outstanding across dates and never count as sales or receipts on issue', () => {
  const report = snapshot('2026-11-18');
  assert.equal(report.proformaOutstanding, 190);
  assert.equal(report.unpaid, 190);
  assert.equal(report.count, 0);
  assert.equal(report.collected, 0);
  assert.equal(report.net, 0);
  assert.equal(report.unpaidOrders[0].source, 'proforma');
  assert.equal(snapshot('2026-11-18', { staffScope: 'someone-else' }).unpaid, 0);
  assert.equal(snapshot('2026-11-18', { proformas: [{ ...record, tenantId: 'other' }] }).unpaid, 0);
});

test('an imported proforma represents its original unpaid till bill once', () => {
  const data = { proformas: [{ ...record, linkedSaleId: 'old-sale' }], serverSales: [{
    id: 'old-sale', tenantId: 'tenant', invoiceNumber: 'INV-OLD', staffId: 'original-cashier',
    status: 'completed', totalMinor: 19000, soldAt: '2026-10-01T09:00:00Z',
  }], serverPayments: [{ id: 'old-credit', tenantId: 'tenant', saleId: 'old-sale', method: 'credit', amountMinor: 19000 }] };
  const report = snapshot('2026-10-01', data);
  assert.equal(report.unpaid, 190);
  assert.equal(report.unpaidOrders.length, 1);
  assert.equal(report.unpaidOrders[0].source, 'proforma');
  assert.equal(report.collected, 0);
  assert.equal(report.net, 190); // The original sale remains in its historical day.
});

test('an older proforma payment enters only its receipt day, once, with the original invoice reference', () => {
  const data = { proformas: [{ ...record, paymentStatus: 'paid' }], serverPayments: [{
    id: 'payment1', tenantId: 'tenant', proformaId: 'pf1', amountMinor: 19000,
    method: 'bank_transfer', reference: 'BANK-REF', paidAt: '2026-11-18T10:00:00Z',
    receivedByStaffId: 'cashier', verified: false,
  }] };
  const report = snapshot('2026-11-18', data);
  assert.equal(report.proformaOutstanding, 0);
  assert.equal(report.unpaid, 0);
  assert.equal(report.collected, 190);
  assert.equal(report.bank, 190);
  assert.equal(report.proformaReceived, 190);
  assert.equal(report.paymentCount, 1);
  assert.equal(report.unmatched, 0);
  assert.equal(report.net, 0);
  assert.equal(report.payments[0].order_reference, 'PF-001');
  assert.equal(report.payments[0].customer_name, 'Acme');
  assert.equal(report.payments[0].verified, false);
  assert.equal(snapshot('2026-10-01', data).collected, 0);
  assert.equal(snapshot('2026-11-19', data).collected, 0);
  assert.equal(snapshot('2026-11-18', { ...data, staffScope: 'issuer' }).collected, 0);
  assert.equal(snapshot('2026-11-18', { ...data, staffScope: 'cashier' }).collected, 190);
  assert.match(financialAnswer(report, 'proforma invoices'), /Proforma payments received in this period: KES 190\.00/);
});
