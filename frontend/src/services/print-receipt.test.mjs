import assert from 'node:assert/strict';
import test from 'node:test';

import { escapeHtml, isPrintableReceipt, renderReceiptHtml } from './print-receipt.js';

const receipt = {
  tenantName: 'Titanium',
  branchName: 'Main',
  kraPin: 'P051234567A',
  branchCode: '00',
  invoiceNo: 'INV-001',
  soldAt: '2026-09-05 10:00',
  cashierName: 'Wanjiku',
  customerName: 'Guest',
  lines: [{ name: 'Pilau Rice', qty: 2, unitPrice: 350, lineTotal: 700, taxCode: 'A' }],
  subtotal: 603.45,
  taxTotal: 96.55,
  grandTotal: 700,
  paymentMethod: 'MPESA'
};

test('a name carrying markup is printed as text, never as an element', () => {
  const html = renderReceiptHtml({
    ...receipt,
    customerName: '<img src=x onerror="alert(1)">',
    lines: [{ ...receipt.lines[0], name: '<script>alert(1)</script>' }]
  });

  // The payload text may still read "onerror=", but only inside a text node:
  // what matters is that no tag or attribute context is ever opened.
  assert.ok(!html.includes('<script>'));
  assert.ok(!html.includes('<img'));
  assert.ok(!html.includes('onerror="'));
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(html.includes('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;'));
});

test('escapeHtml covers every character that can end a text context', () => {
  assert.equal(escapeHtml(`<>&"'`), '&lt;&gt;&amp;&quot;&#39;');
  assert.equal(escapeHtml(null), '');
  assert.equal(escapeHtml(undefined), '');
});

test('money always renders to two decimals and never as NaN', () => {
  const html = renderReceiptHtml({ ...receipt, grandTotal: undefined, subtotal: '12.5' });
  assert.ok(html.includes('KES 0.00'));
  assert.ok(html.includes('12.50'));
  assert.ok(!html.includes('NaN'));
});

test('an unsigned sale says so rather than printing a blank fiscal block', () => {
  assert.ok(renderReceiptHtml(receipt).includes('AWAITING FISCAL SIGNATURE'));
  const signed = renderReceiptHtml({
    ...receipt,
    fiscal: { cuSerial: 'CU1', signature: 'SIG', invoiceNo: '9' }
  });
  assert.ok(signed.includes('CU1'));
  assert.ok(!signed.includes('AWAITING FISCAL SIGNATURE'));
});

test('identity the merchant has not supplied yet prints nothing, not an empty label', () => {
  const html = renderReceiptHtml({ ...receipt, kraPin: '', branchName: '', branchCode: '', phone: '' });

  assert.ok(html.includes('Titanium'));
  assert.ok(!html.includes('PIN:'));
  assert.ok(!html.includes('Branch ID:'));
  assert.ok(!html.includes('Tel:'));
  assert.ok(!html.includes('undefined'));

  const filled = renderReceiptHtml({ ...receipt, phone: '+254712000000' });
  assert.ok(filled.includes('PIN: P051234567A'));
  assert.ok(filled.includes('Tel: +254712000000'));
});

test('a malformed job renders nothing rather than half a receipt', () => {
  assert.equal(isPrintableReceipt(null), false);
  assert.equal(isPrintableReceipt({ invoiceNo: 'X' }), false);
  assert.equal(renderReceiptHtml({ invoiceNo: '', lines: [] }), '');
  assert.equal(renderReceiptHtml(undefined), '');
});
