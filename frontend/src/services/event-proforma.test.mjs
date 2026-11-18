import test from 'node:test';
import assert from 'node:assert/strict';
import { proformaTotals, proformaHtml } from './event-proforma.js';

test('totals: amounts in minor units, VAT is the 16% already inside the prices', () => {
  const t = proformaTotals([{ qty: 10, unitMinor: 35000 }, { qty: 2, unitMinor: 150000 }, { qty: 0, unitMinor: 999 }], 50000);
  assert.deepEqual(t, { subtotalMinor: 650000, discountMinor: 50000, vatMinor: 82759, dueMinor: 600000 });
  // A discount larger than the bill is capped, never a negative amount due.
  assert.equal(proformaTotals([{ qty: 1, unitMinor: 1000 }], 5000).dueMinor, 0);
});

test('the A4 page carries the template sections and escapes what people type', () => {
  const html = proformaHtml({
    business: { name: 'Bransa <Lounge>', address: 'Nairobi', phone: '0700', email: 'a@b.c', kraPin: 'P0' },
    number: 'PF-0001', date: '2026-11-20', dueDate: '2026-11-27', quoteRef: '', lpo: 'LPO-9',
    client: { name: 'Acme', company: '', address: '', phone: '', email: '', kraPin: '' },
    subject: 'Wedding reception, 120 guests',
    lines: [{ description: 'Tusker 500ml', qty: 120, unitMinor: 35000 }],
    discountMinor: 0, terms: '50% deposit to confirm',
    bank: { bank: 'KCB', branch: 'Sarit', accountName: 'Bransa Ltd', accountNo: '123' }, paybill: '522522', signedBy: 'Lloyd',
  });
  for (const part of ['PROFORMA INVOICE', 'PF-0001', 'BILLED TO', 'Acme', 'Wedding reception', 'Tusker 500ml', '42,000.00',
    'This proforma is not a tax invoice', 'BANK TRANSFER', 'M-PESA', 'AUTHORISED BY', '@page']) {
    assert.ok(html.includes(part), part);
  }
  assert.ok(html.includes('Bransa &lt;Lounge&gt;') && !html.includes('<Lounge>'));
});
