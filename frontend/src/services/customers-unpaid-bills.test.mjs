import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { escapeHtml } from './print-receipt.js';
import { visibleOrders } from './customer-orders.js';

const customers = (await readFile(new URL('../ui/customers.js', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
const orders = (await readFile(new URL('../ui/orders.js', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
const linkSource = customers.slice(customers.indexOf('export function unpaidBillsLink('), customers.indexOf('\nexport class CustomersView'))
  .replace('export function', 'function');
const unpaidBillsLink = new Function('escapeHtml', `${linkSource}; return unpaidBillsLink;`)(escapeHtml);

test('Customers no longer simulates a tab repayment on the device', () => {
  // The old flow lowered credit_balance locally and wrote a CASH row against a
  // made-up repay-<customer> sale behind scripted delays. None of it may remain.
  for (const banned of ['repayCustomerTab', 'btn-repay-tab', 'repay-modal', 'CREDIT_REPAY', 'repay-${', 'setTimeout',
    'db.payments', 'credit_balance', 'Clear Tab', 'Repay Tab']) {
    assert.equal(customers.includes(banned), false, `${banned} is still in customers.js`);
  }
  assert.doesNotMatch(customers, /db\.customers\.update/);
});

test('each customer links to their unpaid bills in Orders, never to a payment it makes itself', () => {
  const html = unpaidBillsLink({ id: 'c1', name: 'Nicole & Co <b>' });
  assert.match(html, /href="\/orders\?order=Nicole%20%26%20Co%20%3Cb%3E"/);
  assert.match(html, /aria-label="View unpaid bills for Nicole &amp; Co &lt;b&gt;"/);
  assert.match(html, />View unpaid bills<\/a>/);
  // A plain link: clicking it any number of times only navigates.
  assert.doesNotMatch(html, /<button|data-cust|onclick/);
  // No amount and nothing that reads as "clear" from a device-local value.
  assert.doesNotMatch(html, /KES|\bclear|\bpaid\b|settled/i);
});

test('the link lands on the customer’s unpaid bills and does not open a payment by itself', () => {
  const rows = [
    { id: 'a', source: 'pos', ref: 'INV-1', customerName: 'Nicole', branchId: 'b', status: 'awaiting_payment', paymentStatus: 'unpaid' },
    { id: 'b', source: 'pos', ref: 'INV-2', customerName: 'Nicole', branchId: 'b', status: 'completed', paymentStatus: 'paid' },
    { id: 'c', source: 'pos', ref: 'INV-3', customerName: 'Brian', branchId: 'b', status: 'awaiting_payment', paymentStatus: 'unpaid' },
  ];
  // Orders opens on Running (unpaid, all dates) unless a proforma is linked.
  assert.match(orders, /this\.customerTab = this\.proformaId \? 'proformas' : 'running';/);
  assert.deepEqual(visibleOrders(rows, 'b', { tab: 'running', search: 'Nicole' }).map(row => row.ref), ['INV-1']);

  const body = orders.slice(orders.indexOf('  openLinkedReconciliation() {'), orders.indexOf('\n  startPrintedCustomerPayment('))
    .replace('openLinkedReconciliation() {', 'function openLinkedReconciliation() {');
  const open = new Function(`return ${body}`)();
  const started = [];
  const view = { reconcileReference: 'Nicole', allOrders: () => rows, container: { querySelector: () => ({}) },
    startPrintedSettlement: id => started.push(id), startPrintedCustomerPayment: id => started.push(id), openTabEditor: id => started.push(id) };
  open.call(view);
  assert.deepEqual(started, [], 'a customer name is a search, not an invoice to settle');
});
