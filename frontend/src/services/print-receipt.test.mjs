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

test('the approved receipt keeps its labels and footer', () => {
  const html = renderReceiptHtml(receipt);
  assert.ok(html.includes('Waiter/Waitress'), 'the floor label, not "Cashier"');
  assert.ok(html.includes('Powered by KPOS Pro Systems'));
  // No inline size may undercut the print rules that force legible type.
  assert.ok(!/font-size:\s*1[12]px/.test(html.replace(/font-size:12px; color:#555/g, '')));
});

test('a table is printed when the sale carries one, and skipped when it does not', () => {
  // What the runner matches the paper against at the counter.
  assert.ok(renderReceiptHtml({ ...receipt, tableNo: 'Patio 3' }).includes('Patio 3'));
  assert.ok(!renderReceiptHtml(receipt).includes('<b>Table:</b>'));
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

const etr = {
  environment: 'sandbox', invcNo: 7, sdcId: 'KRACU013000001', mrcNo: 'WIS01000150', curRcptNo: '1', totRcptNo: '9',
  intrlData: 'EAHSAV6ECUUXSY6PCCJYAUP6MI', rcptSign: 'QUII27MATATSHFRB', sdcDateTime: '20261113120500', buyerPin: 'A123456789Z',
  verifyUrl: 'https://etims-sbx.kra.go.ke/common/link/etims/receipt/indexEtimsReceiptData?Data=P051234567A00QUII27MATATSHFRB',
};

test('a receipt KRA has not signed makes no fiscal claim', () => {
  const html = renderReceiptHtml(receipt);
  assert.ok(!/ETR|KRA eTIMS|FISCAL|SIGNATURE/i.test(html));
});

test('an ETR receipt prints the KRA signature, the buyer PIN and a QR code', () => {
  const html = renderReceiptHtml({ ...receipt, etr });
  assert.ok(html.includes('ETR RECEIPT'));
  assert.ok(html.includes('A123456789Z'));
  assert.ok(html.includes('KRACU013000001/1'));
  assert.ok(html.includes('QUII27MATATSHFRB'));
  assert.ok(html.includes('EAHSAV6ECUUXSY6PCCJYAUP6MI'));
  assert.ok(html.includes('<svg') && html.includes('<path d="M'));
});

test('a QR is only drawn for a KRA link, and job values stay text', () => {
  const html = renderReceiptHtml({ ...receipt, etr: { ...etr, verifyUrl: 'https://evil.example/', rcptSign: '<b>x</b>' } });
  assert.ok(!html.includes('<svg'));
  assert.ok(html.includes('&lt;b&gt;x&lt;/b&gt;'));
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

const ticket = {
  kind: 'kitchen',
  ref: 'WEB-0001',
  orderType: 'dine_in',
  tableNumber: '7',
  customerName: 'Guest',
  placedAt: '2026-09-06 12:00',
  paid: true,
  paymentMethod: 'mpesa',
  lines: [{ name: 'Pilau Rice', qty: 2 }],
  copy: 1
};

test('the kitchen ticket carries the serving instruction and no prices', () => {
  const dineIn = renderReceiptHtml(ticket);
  assert.ok(dineIn.includes('KITCHEN ORDER'));
  assert.ok(dineIn.includes('TABLE 7'));
  assert.ok(dineIn.includes('2 x Pilau Rice'));
  assert.ok(dineIn.includes('PAID mpesa'));
  // Nothing on the pass settles money: no totals, no fiscal block.
  assert.ok(!dineIn.includes('TOTAL DUE'));
  assert.ok(!dineIn.includes('FISCAL'));

  const takeaway = renderReceiptHtml({ ...ticket, orderType: 'takeaway', tableNumber: '', paid: false });
  assert.ok(takeaway.includes('TAKEAWAY'));
  assert.ok(!takeaway.includes('TABLE'));
  assert.ok(takeaway.includes('UNPAID'));
});

test('a reprint says so, and an empty ticket prints nothing', () => {
  assert.ok(!renderReceiptHtml(ticket).includes('REPRINT'));
  assert.ok(renderReceiptHtml({ ...ticket, copy: 2 }).includes('REPRINT - COPY 2'));
  assert.equal(renderReceiptHtml({ ...ticket, lines: [] }), '');
  assert.equal(renderReceiptHtml({ ...ticket, ref: '' }), '');
});

test('customer text on a ticket is printed as text, never as an element', () => {
  const html = renderReceiptHtml({ ...ticket, note: '<script>alert(1)</script>', customerName: '<img src=x>' });
  assert.ok(!html.includes('<script>'));
  assert.ok(!html.includes('<img'));
  assert.ok(html.includes('&lt;script&gt;'));
});

test('a staff discount is printed so the lines reconcile to the total', () => {
  const html = renderReceiptHtml({ ...receipt,
    lines: [{ name: 'Tusker', qty: 2, unitPrice: 500, lineTotal: 1000 }, { productId: 'prod-staff-discount', name: 'Staff discount', qty: 1, unitPrice: 0, lineTotal: 0 }],
    subtotal: 1000, discountTotal: 200, taxTotal: 110.34, grandTotal: 800 });
  assert.match(html, /Discount<\/span><span>-200\.00/);
  assert.doesNotMatch(html, /Staff discount/);
  assert.doesNotMatch(renderReceiptHtml({ ...receipt, discountTotal: 0 }), /Discount</);
});
