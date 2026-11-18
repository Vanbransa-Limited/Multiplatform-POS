import { escapeHtml as esc } from './print-receipt.js';

/**
 * Proforma invoice for a planned event (a wedding, a corporate booking).
 *
 * Deliberately not a sale: nothing is booked, no stock moves and no revenue
 * counts until the event happens and is rung up at the till. Issued copies
 * are saved immutably in the standalone register; payments enter the shared
 * ledger on receipt, independently of supply. The A4 template stays unchanged.
 *
 * Prices on the menu already include VAT, so the VAT line shows the 16% that
 * sits inside the amount due rather than adding it on top.
 */

const VAT_RATE = 0.16;

export function proformaTotals(lines, discountMinor = 0) {
  const subtotalMinor = lines.reduce((sum, line) => sum + Math.max(0, Math.round(Number(line.qty) || 0)) * Math.max(0, Math.round(Number(line.unitMinor) || 0)), 0);
  const discount = Math.min(subtotalMinor, Math.max(0, Math.round(Number(discountMinor) || 0)));
  const dueMinor = subtotalMinor - discount;
  return { subtotalMinor, discountMinor: discount, vatMinor: Math.round(dueMinor * VAT_RATE / (1 + VAT_RATE)), dueMinor };
}

const money = (minor) => (minor / 100).toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const day = (iso) => (iso ? new Date(`${iso}T00:00:00`).toLocaleDateString('en-GB') : '');
const join = (...parts) => parts.filter(Boolean).map(esc).join(' · ');

/** A complete printable page; opened in its own window and printed to A4. */
export function proformaHtml(doc) {
  const t = proformaTotals(doc.lines, doc.discountMinor);
  const rows = doc.lines.map((line, i) => `<tr>
      <td class="c">${i + 1}</td><td>${esc(line.description)}</td><td class="n">${Number(line.qty) || 0}</td>
      <td class="n">${money(Math.round(Number(line.unitMinor) || 0))}</td><td class="n">${money((Number(line.qty) || 0) * (Number(line.unitMinor) || 0))}</td></tr>`).join('');
  const b = doc.business;
  const c = doc.client;
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${esc(doc.number)} - Proforma invoice</title>
<style>
  @page { size: A4; margin: 16mm 14mm; }
  * { box-sizing: border-box; }
  body { font-family: Arial, sans-serif; color: #1A1F1C; font-size: 10.5pt; margin: 0; }
  .head { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 3px solid #1F4D3A; padding-bottom: 10px; }
  .biz h1 { margin: 0 0 4px; font-size: 16pt; color: #1F4D3A; }
  .biz p, .meta td { margin: 0; color: #4F5752; font-size: 9pt; }
  h2 { margin: 0 0 6px; font-size: 18pt; letter-spacing: .06em; color: #1F4D3A; text-align: right; }
  .meta td { padding: 1px 0 1px 12px; text-align: right; } .meta td:first-child { font-weight: bold; color: #1A1F1C; }
  .label { font-size: 8.5pt; font-weight: bold; letter-spacing: .08em; color: #1F4D3A; margin: 16px 0 4px; }
  .box p { margin: 1px 0; }
  table.items { width: 100%; border-collapse: collapse; margin-top: 14px; }
  .items th { background: #1F4D3A; color: #fff; font-size: 9pt; text-align: left; padding: 6px; }
  .items td { padding: 6px; border-bottom: 1px solid #E7EDE9; }
  .items tr:nth-child(even) td { background: #E7EDE9; }
  .c, .items th.c { text-align: center; width: 6%; } .n, .items th.n { text-align: right; white-space: nowrap; }
  .pay p { margin: 2px 0; }
  .foot { display: flex; gap: 24px; margin-top: 14px; align-items: flex-start; }
  .foot > div { flex: 1; }
  table.sum { width: 100%; border-collapse: collapse; } .sum td { padding: 4px 6px; } .sum td:last-child { text-align: right; }
  .sum tr.due td { background: #1F4D3A; color: #fff; font-weight: bold; font-size: 11.5pt; }
  .note { font-size: 8.5pt; color: #4F5752; font-style: italic; }
  .pay { display: flex; gap: 24px; } .pay > div { flex: 1; background: #E7EDE9; padding: 8px 10px; border-radius: 4px; }
  .sign { display: flex; gap: 40px; margin-top: 28px; } .sign div { flex: 1; border-top: 1px solid #1A1F1C; padding-top: 4px; font-size: 9pt; }
</style></head><body>
  <div class="head">
    <div class="biz"><h1>${esc(b.name)}</h1><p>${esc(b.address)}</p><p>${join(b.phone && `Tel ${b.phone}`, b.email)}</p>${b.kraPin ? `<p>KRA PIN: ${esc(b.kraPin)}</p>` : ''}</div>
    <div><h2>PROFORMA INVOICE</h2><table class="meta">
      <tr><td>Proforma no.</td><td>${esc(doc.number)}</td></tr>
      <tr><td>Date</td><td>${esc(day(doc.date))}</td></tr>
      <tr><td>Due date</td><td>${esc(day(doc.dueDate))}</td></tr>
      ${doc.quoteRef ? `<tr><td>Quote ref.</td><td>${esc(doc.quoteRef)}</td></tr>` : ''}
    </table></div>
  </div>
  <div class="label">BILLED TO</div>
  <div class="box"><p><b>${esc(c.name)}</b></p>${c.company ? `<p>${esc(c.company)}</p>` : ''}${c.address ? `<p>${esc(c.address)}</p>` : ''}
    ${c.phone || c.email ? `<p>${join(c.phone, c.email)}</p>` : ''}${c.kraPin ? `<p>KRA PIN: ${esc(c.kraPin)}</p>` : ''}</div>
  <div class="label">SUBJECT</div>
  <div class="box"><p>${esc(doc.subject)}</p>${doc.lpo ? `<p>Client order / LPO no.: ${esc(doc.lpo)}</p>` : ''}</div>
  <table class="items"><thead><tr><th class="c">No.</th><th>Description of service / item</th><th class="n">Qty</th><th class="n">Unit price (KES)</th><th class="n">Amount (KES)</th></tr></thead>
    <tbody>${rows}</tbody></table>
  <div class="foot">
    <div><div class="label" style="margin-top:0">TERMS</div><p>${esc(doc.terms)}</p>
      <p class="note">This proforma is not a tax invoice. The KRA eTIMS tax invoice is issued on payment or supply.</p></div>
    <div><table class="sum">
      <tr><td>Subtotal</td><td>${money(t.subtotalMinor)}</td></tr>
      <tr><td>Discount</td><td>${t.discountMinor ? `-${money(t.discountMinor)}` : '0.00'}</td></tr>
      <tr><td>VAT (16%, included)</td><td>${money(t.vatMinor)}</td></tr>
      <tr class="due"><td>Amount due (KES)</td><td>${money(t.dueMinor)}</td></tr>
    </table></div>
  </div>
  <div class="pay" style="margin-top:16px">
    <div><div class="label" style="margin-top:0">BANK TRANSFER</div><p>Bank: ${esc(doc.bank.bank)}</p><p>Branch: ${esc(doc.bank.branch)}</p>
      <p>Account name: ${esc(doc.bank.accountName)}</p><p>Account no.: ${esc(doc.bank.accountNo)}</p></div>
    <div><div class="label" style="margin-top:0">M-PESA</div><p>Paybill: ${esc(doc.paybill)}</p><p>Account no.: ${esc(doc.number)}</p></div>
  </div>
  <div class="label">AUTHORISED BY</div>
  <div class="sign"><div>Name: ${esc(doc.signedBy)}</div><div>Signature</div></div>
</body></html>`;
}
