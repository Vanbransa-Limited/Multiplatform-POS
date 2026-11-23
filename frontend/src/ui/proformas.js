import { watchProformas, payProforma } from '../services/proformas.js';
import { proformaHtml } from '../services/event-proforma.js';
import { escapeHtml as esc } from '../services/print-receipt.js';
import { timestamp } from '../services/financial-snapshot.js';
import { paginate, pagerHtml, bindPager } from '../services/paginate.js';
import { manualReceipt } from '../services/manual-receipt.js';

const money = minor => `KES ${(Number(minor || 0) / 100).toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** The same standalone register is reachable from Orders, Financials and QR & Tools. */
export class ProformaRegister {
  constructor(host, { selectedId = '', onPaid = () => {} } = {}) {
    this.host = host;
    this.selectedId = selectedId;
    this.onPaid = onPaid;
    this.records = [];
    this.page = 1;
    this.pagerId = `proforma-pager-${crypto.randomUUID()}`;
  }

  async load() {
    this.host.innerHTML = `<div class="proforma-register">
      <h3>Proforma invoices</h3>
      <p>Issued invoices are locked and kept outside Running orders. Payments count towards the day they are recorded. Amounts below cover all invoice dates.</p>
      <div class="proforma-filters"><label>Search invoices <input type="search" data-pf-search placeholder="Invoice number or client"></label>
        <label>Payment status <select data-pf-status><option value="all">All invoices</option><option value="unpaid">Unpaid</option><option value="paid">Paid</option></select></label></div>
      <p data-pf-message role="status">Loading invoices…</p>
      <div data-pf-list></div><div data-pf-pager></div><div data-pf-detail></div>
    </div>`;
    this.host.querySelector('[data-pf-search]').oninput = () => { this.page = 1; this.renderList(); };
    this.host.querySelector('[data-pf-status]').onchange = () => { this.page = 1; this.renderList(); };
    this.host.onclick = event => {
      const view = event.target.closest('[data-pf-view]');
      if (view) { this.selectedId = view.dataset.pfView; this.renderDetail(); }
      if (event.target.closest('[data-pf-print]')) this.print();
    };
    this.host.onsubmit = event => {
      if (!event.target.matches('[data-pf-payment]')) return;
      event.preventDefault();
      void this.pay(event.target);
    };
    this.host.onchange = event => {
      if (event.target.matches('[data-pf-payment] select[name="method"]')) {
        event.target.form.querySelector('[data-pf-receipt-amount]').hidden = event.target.value !== 'mpesa';
      }
    };
    try {
      const stop = await watchProformas(records => {
        if (this.disposed) return;
        this.records = records.sort((a, b) => String(b.invoice.date).localeCompare(String(a.invoice.date)) || timestamp(b.createdAt) - timestamp(a.createdAt));
        this.message('');
        this.renderList();
        // Keep a payment form being filled in during unrelated live updates.
        const selected = this.records.find(row => row.id === this.selectedId);
        if (!this.detailStatus || selected?.paymentStatus !== this.detailStatus) this.renderDetail();
      }, error => { if (!this.disposed) this.message(`Could not refresh invoices: ${error.message}. Reopen this section to retry.`); });
      if (this.disposed) stop(); else this.stop = stop;
    } catch (error) { if (!this.disposed) this.message(error.message); }
  }

  message(text) { const el = this.host.querySelector('[data-pf-message]'); if (el) el.textContent = text; }
  dispose() { this.disposed = true; this.stop?.(); }

  renderList() {
    const needle = this.host.querySelector('[data-pf-search]').value.trim().toLowerCase();
    const status = this.host.querySelector('[data-pf-status]').value;
    const rows = this.records.filter(row => (status === 'all' || row.paymentStatus === status)
      && `${row.invoice.number} ${row.invoice.client.name} ${row.invoice.subject}`.toLowerCase().includes(needle));
    const page = paginate(rows, this.page, 10);
    this.page = page.page;
    this.host.querySelector('[data-pf-list]').innerHTML = `<div class="proforma-table-wrap"><table class="fin-table"><thead><tr><th>Invoice / client</th><th>Invoice date</th><th>Due date</th><th>Amount</th><th>Status</th><th></th></tr></thead><tbody>${page.rows.map(row => `<tr>
      <td>${esc(row.invoice.number)}<br><small>${esc(row.invoice.client.name)}</small></td>
      <td>${esc(row.invoice.date)}</td><td>${esc(row.invoice.dueDate)}</td><td>${money(row.invoice.dueMinor)}</td>
      <td>${row.paymentStatus === 'paid' ? 'Paid' : 'Unpaid'}</td>
      <td><button type="button" class="sec-btn" data-pf-view="${esc(row.id)}" aria-label="View invoice ${esc(row.invoice.number)}">View</button></td></tr>`).join('')
      || '<tr><td colspan="6">No proforma invoices match this view.</td></tr>'}</tbody></table></div>`;
    this.host.querySelector('[data-pf-pager]').innerHTML = pagerHtml(this.pagerId, page);
    bindPager(this.pagerId, page, next => { this.page = next; this.renderList(); });
  }

  select(id) { this.selectedId = id; this.renderDetail(); }

  renderDetail() {
    const host = this.host.querySelector('[data-pf-detail]');
    if (!host) return;
    const row = this.records.find(row => row.id === this.selectedId);
    if (!row) { host.innerHTML = ''; this.detailStatus = ''; return; }
    this.detailStatus = row.paymentStatus;
    const invoice = row.invoice;
    const paid = row.paymentStatus === 'paid';
    host.innerHTML = `<section class="proforma-detail" aria-label="Invoice ${esc(invoice.number)}">
      <h4>${esc(invoice.number)} · ${esc(invoice.client.name)}</h4>
      <p>Prepared by: ${esc(invoice.signedBy || 'Not recorded')}${row.linkedSaleId ? `<br>Original bill: ${esc(invoice.quoteRef || row.linkedSaleId)} · same outstanding balance` : ''}</p>
      <p>${esc(invoice.subject)}<br>Locked on issue · ${money(invoice.dueMinor)} · ${paid ? 'Paid' : 'Unpaid'}<br>Invoice date: ${esc(invoice.date)} · Due date: ${esc(invoice.dueDate)}</p>
      <div class="proforma-table-wrap"><table class="fin-table"><thead><tr><th>Description</th><th>Quantity</th><th>Unit price</th></tr></thead><tbody>${invoice.lines.map(line => `<tr><td>${esc(line.description)}</td><td>${line.qty}</td><td>${money(line.unitMinor)}</td></tr>`).join('')}</tbody></table></div>
      <p>Discount: ${money(invoice.discountMinor)} · Amount due: ${money(invoice.dueMinor)}</p>
      <p>${esc(invoice.terms)}</p>
      <button type="button" class="sec-btn" data-pf-print>View / print original invoice</button>
      ${paid ? `<p>Payment recorded ${esc(new Date(timestamp(row.paidAt)).toLocaleString())} · ${esc(row.paymentMethod)} · ${esc(row.paymentReference || '')}</p>`
        : `<form data-pf-payment class="proforma-payment"><h4>Record full payment received</h4>
          <p>Record this after the money arrives. For M-Pesa, enter the code and amount from the payment message.</p>
          <label>Payment method <select name="method" required><option value="bank_transfer">Bank transfer</option><option value="mpesa">M-Pesa code</option><option value="card">Card</option><option value="cash">Cash</option></select></label>
          <label>Payment reference <input name="reference" maxlength="120" placeholder="Statement reference or M-Pesa code" autocomplete="off" autocorrect="off" spellcheck="false"></label>
          <label data-pf-receipt-amount hidden>Amount on receipt (KES) <input name="receiptAmount" type="text" inputmode="decimal" autocomplete="off" placeholder="Enter receipt amount"></label>
          <button type="submit" class="discount-save-btn">Record ${money(invoice.dueMinor)} received</button>
          <p data-pf-payment-message role="status"></p></form>`}
    </section>`;
  }

  print() {
    const row = this.records.find(row => row.id === this.selectedId);
    if (!row) return;
    const win = window.open('', '_blank');
    if (!win) return this.message('Allow pop-ups to view or print the original invoice.');
    win.document.write(proformaHtml(row.invoice));
    win.document.close();
    setTimeout(() => win.print(), 300);
  }

  async pay(form) {
    const id = this.selectedId;
    const button = form.querySelector('button[type="submit"]');
    const status = form.querySelector('[data-pf-payment-message]');
    button.disabled = true;
    status.textContent = 'Recording payment…';
    try {
      const fields = new FormData(form);
      const receipt = fields.get('method') === 'mpesa' ? manualReceipt(fields.get('reference'), fields.get('receiptAmount')) : null;
      const result = await payProforma({ proformaId: id, method: fields.get('method'), reference: fields.get('reference'),
        ...(receipt ? { reference: receipt.reference, receiptAmountMinor: receipt.receiptAmountMinor } : {}) });
      this.message(result.alreadyPaid
        ? 'This invoice was already paid. No new payment was recorded. Reconcile any money just received before taking another payment.'
        : 'Payment recorded. Included in the received total for today’s trading day.');
      await this.onPaid();
    } catch (error) {
      status.textContent = `Payment could not be recorded: ${error.message}`;
      button.disabled = false;
    }
  }
}
