import { tenantStorage } from '../services/tenant-cache.js';
import { db } from '../db/schema.js';
import { getStockOnHand } from '../db/index.js';
import { state, showNotification } from '../context.js';
import { proformaHtml, proformaTotals } from '../services/event-proforma.js';
import { escapeHtml as esc } from '../services/print-receipt.js';
import { issueProforma } from '../services/proformas.js';
import { ProformaRegister } from './proformas.js';
import { ApprovalCodesPane } from './approval-codes.js';

const isOwner = () => state.currentUser?.role === 'Owner';

/**
 * Customer menu lives beside the app, so derive it from wherever the till is
 * actually served. A hardcoded localhost URL prints QR codes nobody can scan.
 */
function defaultMenuUrl() {
  const saved = tenantStorage.getItem('pos_menu_url');
    const url = new URL(saved || 'menu.html', window.location.origin);
    if (url.origin === window.location.origin && url.pathname === '/menu.html') {
      if (state.currentTenant?.id) url.searchParams.set('tenant', state.currentTenant.id);
      if (state.currentBranch?.id) url.searchParams.set('branch', state.currentBranch.id);
    }
    return url.href;
}

export class QrToolsView {
  constructor(container) {
    this.container = container;
    this.activeTab = 'qr';
  }

  async load() {
    this.render();
    this.bindEvents();
    if (this.activeTab === 'alerts') await this.runAlertCheck();
    if (this.activeTab === 'proforma') await this.loadProforma();
    if (this.activeTab === 'codes') await this.loadCodes();
  }

  async loadCodes() {
    const host = document.getElementById('qt-codes');
    if (host) await new ApprovalCodesPane(host).load();
  }

  dispose() { this.proformaRegister?.dispose(); }

  render() {
    const t = this.activeTab;
    const rows = [
      '<div class="settings-shell" style="display:flex;flex-direction:column;height:calc(100vh - 130px);gap:0;overflow:hidden;">',
      '<div class="qt-pills" role="tablist" aria-label="QR and tools">',
      ...[['qr', 'QR Menu'], ['export', 'Export Reports'], ['alerts', 'Stock Alerts'], ['proforma', 'Event Proforma'],
        ...(isOwner() ? [['codes', 'Approval codes']] : [])]
        .map(([id, label]) => '<button type="button" role="tab" class="qt-pill' + (t === id ? ' active' : '') + '" aria-selected="' + (t === id) + '" data-qtab="' + id + '">' + label + '</button>'),
      '</div>',
      '<div class="settings-content" style="flex:1;min-width:0;overflow-y:auto;padding:20px;">',

      // QR TAB
      '<div id="qt-qr" style="display:' + (t === 'qr' ? 'block' : 'none') + '">',
      '<div class="discount-section">',
      '<h3>\uD83D\uDCF1 Online Menu QR Code</h3>',
      '<p style="color:var(--text-secondary);font-size:13px;margin-bottom:20px;">Print and display this QR code on each table. Customers scan it to browse the full menu and place orders from their smartphone.</p>',
      '<div style="display:flex;gap:32px;flex-wrap:wrap;align-items:flex-start;">',
      '<div>',
      '<div id="qr-canvas-wrap" style="background:#fff;padding:20px;border-radius:16px;display:inline-block;box-shadow:0 4px 24px rgba(0,0,0,0.5);min-width:200px;min-height:200px;display:flex;align-items:center;justify-content:center;">',
      '<div id="qr-actual"></div>',
      '</div>',
      '<div style="margin-top:12px;display:flex;gap:8px;">',
      '<button class="discount-save-btn" id="qr-download-btn">\u2B07\uFE0F Download PNG</button>',
      '<button class="sec-btn" id="qr-print-btn">\uD83D\uDDA8\uFE0F Print QR</button>',
      '</div>',
      '</div>',
      '<div style="flex:1;min-width:220px;">',
      '<div class="discount-field"><label>Menu URL</label><input type="text" id="qr-url-input" value="' + defaultMenuUrl() + '" style="font-size:12px;"></div>',
      '<div class="discount-field"><label>QR Size</label><select id="qr-size-sel"><option value="160">Small</option><option value="220" selected>Medium</option><option value="300">Large</option></select></div>',
      '<button class="discount-save-btn" id="qr-regen-btn" style="width:100%;">\u21BB Regenerate</button>',
      '<div style="margin-top:20px;background:rgba(200,130,42,0.08);border:1px solid rgba(200,130,42,0.2);border-radius:10px;padding:16px;">',
      '<div style="font-size:11px;font-weight:700;color:var(--accent-amber);text-transform:uppercase;margin-bottom:8px;">How it works</div>',
      '<ul style="font-size:13px;color:var(--text-secondary);line-height:2;padding-left:18px;">',
      '<li>Print & display the QR at each table</li>',
      '<li>Customers scan with their phone camera</li>',
      '<li>They see full menu with images & prices</li>',
      '<li>They place orders directly from their phone</li>',
      '<li>Orders appear in your Orders tab</li>',
      '</ul>',
      '</div>',
      '</div>',
      '</div>',
      '</div>',
      '</div>',

      // EXPORT TAB
      '<div id="qt-export" style="display:' + (t === 'export' ? 'block' : 'none') + '">',
      '<div class="discount-section">',
      '<h3>\uD83D\uDCCA Export Reports</h3>',
      '<p style="color:var(--text-secondary);font-size:13px;margin-bottom:20px;">Download your business data for accounting, tax filing, or external analysis.</p>',
      '<div class="discount-form-grid">',
      '<div><label>Report Type</label><select id="exp-type"><option value="sales">Sales / Orders</option><option value="inventory">Stock Ledger</option><option value="discounts">Discount Rules</option></select></div>',
      '<div><label>Date Range</label><select id="exp-range"><option value="today">Today</option><option value="week">This Week</option><option value="month" selected>This Month</option><option value="all">All Time</option></select></div>',
      '</div>',
      '<div style="display:flex;gap:12px;flex-wrap:wrap;margin-top:8px;">',
      '<button class="discount-save-btn" id="exp-csv-btn">\uD83D\uDCC4 Export CSV</button>',
      '<button class="sec-btn" id="exp-json-btn">\uD83D\uDCC1 Export JSON</button>',
      '<button class="sec-btn" id="exp-preview-btn">\uD83D\uDC41 Preview</button>',
      '</div>',
      '</div>',
      '<div class="discount-section" id="exp-preview-box" style="display:none;">',
      '<h3>Report Preview</h3>',
      '<div id="exp-preview-inner" style="overflow-x:auto;"></div>',
      '</div>',
      '</div>',

      '<div id="qt-proforma" style="display:' + (t === 'proforma' ? 'block' : 'none') + '"></div>',
      '<div id="qt-codes" style="display:' + (t === 'codes' ? 'block' : 'none') + '"></div>',
      // ALERTS TAB
      '<div id="qt-alerts" style="display:' + (t === 'alerts' ? 'block' : 'none') + '">',
      '<div class="discount-section">',
      '<h3>\u2699\uFE0F Alert Configuration</h3>',
      '<div class="discount-form-grid">',
      '<div><label>Low Stock Threshold (units)</label><input type="number" id="alert-threshold" value="' + (tenantStorage.getItem('pos_alert_threshold') || '10') + '" min="1"></div>',
      '<div><label>Alert On</label><select id="alert-freq"><option value="always" selected>Every Tab Visit</option><option value="login">Login Only</option></select></div>',
      '</div>',
      '<button class="discount-save-btn" id="save-alert-settings">Save & Check Now</button>',
      '</div>',
      '<div class="discount-section">',
      '<h3>\uD83D\uDD14 Current Stock Alerts</h3>',
      '<div id="alerts-list"><div style="text-align:center;padding:30px;color:var(--text-secondary);">Checking stock levels...</div></div>',
      '</div>',
      '</div>',

      '</div>',
      '</div>'
    ];
    this.container.innerHTML = rows.join('');
  }

  bindEvents() {
    this.container.querySelectorAll('[data-qtab]').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        this.proformaRegister?.dispose();
        this.activeTab = e.currentTarget.getAttribute('data-qtab');
        this.render();
        this.bindEvents();
        if (this.activeTab === 'qr') this.generateQR();
        if (this.activeTab === 'alerts') await this.runAlertCheck();
        if (this.activeTab === 'proforma') await this.loadProforma();
        if (this.activeTab === 'codes') await this.loadCodes();
      });
    });

    if (this.activeTab === 'qr') {
      this.generateQR();
      const regen = document.getElementById('qr-regen-btn');
      if (regen) regen.addEventListener('click', () => this.generateQR());
      const dl = document.getElementById('qr-download-btn');
      if (dl) dl.addEventListener('click', () => this.downloadQR());
      const pr = document.getElementById('qr-print-btn');
      if (pr) pr.addEventListener('click', () => this.printQR());
    }

    if (this.activeTab === 'export') {
      const csv = document.getElementById('exp-csv-btn');
      if (csv) csv.addEventListener('click', () => this.exportData('csv'));
      const json = document.getElementById('exp-json-btn');
      if (json) json.addEventListener('click', () => this.exportData('json'));
      const prev = document.getElementById('exp-preview-btn');
      if (prev) prev.addEventListener('click', () => this.exportData('preview'));
    }

    if (this.activeTab === 'alerts') {
      const save = document.getElementById('save-alert-settings');
      if (save) save.addEventListener('click', async () => {
        const val = document.getElementById('alert-threshold').value;
        tenantStorage.setItem('pos_alert_threshold', val);
        showNotification('Alert threshold: ' + val + ' units saved.', 'success');
        await this.runAlertCheck();
      });
    }
  }

  // ── EVENT PROFORMA ──
  // A priced offer for a planned event, printed to A4. Not a sale: nothing is
  // booked and no stock moves until the event is rung up at the till.

  /** Business, bank and M-Pesa details, remembered on this device after the first print. */
  proformaProfile() {
    let saved = {};
    try { saved = JSON.parse(tenantStorage.getItem('pos_proforma_profile') || '{}') || {}; } catch { /* corrupt cache */ }
    const tenant = state.currentTenant || {};
    return {
      name: tenant.trading_name || '', address: '', phone: tenant.phone || '', email: '', kraPin: tenant.kra_pin || '',
      bank: '', branch: '', accountName: tenant.trading_name || '', accountNo: '', paybill: '', terms: '50% deposit to confirm the booking; balance due on the event date.',
      ...saved,
    };
  }

  nextProformaNumber() {
    const today = new Date().toISOString().slice(2, 10).replace(/-/g, '');
    let n = 1;
    try { const last = JSON.parse(tenantStorage.getItem('pos_proforma_seq') || '{}'); if (last.day === today) n = last.n + 1; } catch { /* first one */ }
    return { number: `PF-${today}-${String(n).padStart(2, '0')}`, day: today, n };
  }

  async loadProforma() {
    const host = document.getElementById('qt-proforma');
    if (!host) return;
    this.proformaProducts = (await db.products.where('tenant_id').equals(state.currentTenant?.id || '').toArray())
      .filter((p) => !p.retired_at && Number(p.sell_price) > 0)
      .sort((a, b) => String(a.name).localeCompare(String(b.name)));
    this.proformaLines = this.proformaLines || [];
    const pf = this.proformaProfile();
    const today = new Date().toISOString().slice(0, 10);
    const week = new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10);
    const field = (id, label, value = '', type = 'text') => `<div class="discount-field"><label for="${id}">${label}</label><input type="${type}" id="${id}" value="${esc(value)}"></div>`;
    host.innerHTML = `<div class="discount-section">
      <h3>📄 Proforma invoice for an event</h3>
      <p style="color:var(--text-secondary);font-size:13px;margin:0 0 16px;">Prepare an event invoice, then save and lock it before sending it to the client. Issued invoices stay in Proforma invoices, outside Running orders. Nothing is sold and no stock moves on issue. Payments enter daily totals when received.</p>
      <div class="pf-fields">
        ${field('pf-number', 'Proforma no.', this.nextProformaNumber().number)}
        ${field('pf-date', 'Date', today, 'date')}
        ${field('pf-due', 'Due date', week, 'date')}
        ${field('pf-quote', 'Quote ref. (optional)')}
        ${field('pf-lpo', 'Client order / LPO no. (optional)')}
      </div>
      <h4 style="margin:12px 0 4px;">Billed to</h4>
      <div class="pf-fields">
        ${field('pf-client-name', 'Client name')}${field('pf-client-company', 'Company / organisation')}
        ${field('pf-client-address', 'Address')}${field('pf-client-phone', 'Phone', '', 'tel')}
        ${field('pf-client-email', 'Email', '', 'email')}${field('pf-client-pin', 'Client KRA PIN')}
      </div>
      ${field('pf-subject', 'Subject (the event)', '')}
      <h4 style="margin:12px 0 4px;">Items</h4>
      <div class="pf-item-picker">
        <div class="discount-field"><label for="pf-pick">From the menu</label><select id="pf-pick"><option value="">Choose an item…</option>${this.proformaProducts.map((p) => `<option value="${esc(p.id)}">${esc(p.name)} — KES ${Number(p.sell_price).toFixed(2)}</option>`).join('')}</select></div>
        <button type="button" class="sec-btn" id="pf-add-item">Add item</button>
        <button type="button" class="sec-btn" id="pf-add-custom">Add a service line</button>
      </div>
      <div id="pf-lines"></div>
      <div class="pf-fields">
        ${field('pf-discount', 'Discount (KES)', '0', 'number')}
        <div class="discount-field pf-terms"><label for="pf-terms">Payment terms</label><textarea id="pf-terms" rows="3">${esc(pf.terms)}</textarea></div>
        ${field('pf-signed', 'Authorised by', state.currentUser?.name || '')}
      </div>
      <details class="pf-business"><summary>Business, bank and M-Pesa details (remembered on this device)</summary>
        <div class="pf-fields">
          ${field('pf-biz-name', 'Business name', pf.name)}${field('pf-biz-address', 'Address', pf.address)}
          ${field('pf-biz-phone', 'Phone', pf.phone)}${field('pf-biz-email', 'Email', pf.email)}
          ${field('pf-biz-pin', 'KRA PIN', pf.kraPin)}${field('pf-bank', 'Bank', pf.bank)}
          ${field('pf-bank-branch', 'Branch', pf.branch)}${field('pf-acc-name', 'Account name', pf.accountName)}
          ${field('pf-acc-no', 'Account no.', pf.accountNo)}${field('pf-paybill', 'M-Pesa paybill', pf.paybill)}
        </div>
      </details>
      <div id="pf-total" aria-live="polite"></div>
      <button class="sec-btn" id="pf-print">Preview draft &amp; print</button>
      <button class="discount-save-btn" id="pf-issue">Save &amp; lock invoice</button>
      <p id="pf-issue-message" role="status">Check the details before issuing. Saved invoices cannot be edited.</p>
    </div><div class="discount-section" id="pf-register"></div>`;
    this.proformaRegister?.dispose();
    this.proformaRegister = new ProformaRegister(host.querySelector('#pf-register'));
    void this.proformaRegister.load();

    const val = (id) => (document.getElementById(id)?.value || '').trim();
    const renderTotals = () => {
      const t = proformaTotals(this.proformaLines, Math.round(Number(val('pf-discount')) * 100));
      document.getElementById('pf-total').textContent = `Amount due: KES ${(t.dueMinor / 100).toFixed(2)} (VAT included: KES ${(t.vatMinor / 100).toFixed(2)})`;
    };
    const renderLines = () => {
      const wrap = document.getElementById('pf-lines');
      wrap.innerHTML = this.proformaLines.length ? this.proformaLines.map((line, i) => `<div class="pf-line">
          <div class="discount-field pf-description"><label for="pf-description-${i}">Description</label><input id="pf-description-${i}" type="text" data-pf="${i}" data-key="description" value="${esc(line.description)}" aria-label="Description, line ${i + 1}"></div>
          <div class="discount-field"><label for="pf-qty-${i}">Qty</label><input id="pf-qty-${i}" type="number" min="1" step="1" data-pf="${i}" data-key="qty" value="${line.qty}" aria-label="Quantity, line ${i + 1}"></div>
          <div class="discount-field"><label for="pf-unit-${i}">Unit price (KES)</label><input id="pf-unit-${i}" type="number" min="0" step="0.01" data-pf="${i}" data-key="unit" value="${(line.unitMinor / 100).toFixed(2)}" aria-label="Unit price, line ${i + 1}"></div>
          <button type="button" class="sec-btn" data-pf-remove="${i}" aria-label="Remove line ${i + 1}">✕</button>
        </div>`).join('')
        : '<p style="color:var(--text-secondary);font-size:13px;">No items yet.</p>';
      renderTotals();
    };
    renderLines();

    document.getElementById('pf-add-item').onclick = () => {
      const product = this.proformaProducts.find((p) => p.id === val('pf-pick'));
      if (!product) { showNotification('Choose an item from the menu first.', 'warning'); return; }
      this.proformaLines.push({ description: product.name, qty: 1, unitMinor: Math.round(Number(product.sell_price) * 100) });
      renderLines();
    };
    document.getElementById('pf-add-custom').onclick = () => {
      this.proformaLines.push({ description: '', qty: 1, unitMinor: 0 });
      renderLines();
    };
    document.getElementById('pf-discount').oninput = renderTotals;
    const lines = document.getElementById('pf-lines');
    lines.oninput = (event) => {
      const input = event.target.closest('[data-pf]');
      if (!input) return;
      const line = this.proformaLines[Number(input.dataset.pf)];
      if (input.dataset.key === 'description') line.description = input.value;
      if (input.dataset.key === 'qty') line.qty = Math.max(1, Math.round(Number(input.value) || 1));
      if (input.dataset.key === 'unit') line.unitMinor = Math.max(0, Math.round(Number(input.value) * 100) || 0);
      // Replacing the row during blur removes the next field before it can
      // receive focus. Keep the fields in place while the operator types.
      renderTotals();
    };
    lines.onclick = (event) => {
      const remove = event.target.closest('[data-pf-remove]');
      if (!remove) return;
      this.proformaLines.splice(Number(remove.dataset.pfRemove), 1);
      renderLines();
    };

    const invoiceDocument = () => {
      if (!val('pf-client-name')) { showNotification('Enter the client name.', 'warning'); return; }
      if (!this.proformaLines.length || this.proformaLines.some((line) => !line.description.trim())) {
        showNotification('Add at least one item, and describe every line.', 'warning'); return;
      }
      const profile = {
        name: val('pf-biz-name'), address: val('pf-biz-address'), phone: val('pf-biz-phone'), email: val('pf-biz-email'), kraPin: val('pf-biz-pin'),
        bank: val('pf-bank'), branch: val('pf-bank-branch'), accountName: val('pf-acc-name'), accountNo: val('pf-acc-no'), paybill: val('pf-paybill'), terms: val('pf-terms'),
      };
      try { tenantStorage.setItem('pos_proforma_profile', JSON.stringify(profile)); } catch { /* private window */ }
      return {
        business: profile, number: val('pf-number'), date: val('pf-date'), dueDate: val('pf-due'), quoteRef: val('pf-quote'), lpo: val('pf-lpo'),
        client: { name: val('pf-client-name'), company: val('pf-client-company'), address: val('pf-client-address'), phone: val('pf-client-phone'), email: val('pf-client-email'), kraPin: val('pf-client-pin') },
        subject: val('pf-subject'), lines: this.proformaLines.map(line => ({ ...line })), discountMinor: Math.round(Number(val('pf-discount')) * 100) || 0,
        terms: profile.terms, bank: profile, paybill: profile.paybill, signedBy: val('pf-signed'),
      };
    };
    document.getElementById('pf-print').onclick = () => {
      const invoice = invoiceDocument();
      if (!invoice) return;
      const html = proformaHtml(invoice);
      const win = window.open('', '_blank');
      if (!win) { showNotification('Allow pop-ups to print the proforma.', 'error'); return; }
      win.document.write(html);
      win.document.close();
      setTimeout(() => win.print(), 400);
    };
    document.getElementById('pf-issue').onclick = async (event) => {
      const invoice = invoiceDocument();
      if (!invoice) return;
      const message = document.getElementById('pf-issue-message');
      const controls = [...host.querySelector('.discount-section').querySelectorAll('input, textarea, select, button')];
      controls.forEach(control => { control.disabled = true; });
      message.textContent = 'Saving and locking invoice…';
      this.proformaRequestId = this.proformaRequestId || crypto.randomUUID();
      try {
        const saved = await issueProforma({ requestId: this.proformaRequestId, branchId: state.currentBranch?.id, invoice });
        this.proformaLines = [];
        this.proformaRequestId = null;
        host.querySelector('.discount-section').innerHTML = `<h3>${esc(saved.number)} saved and locked</h3><p>The original invoice is available below and in Orders Viewer → Proforma invoices and Financials &amp; AI. Record payment there when it arrives.</p><button type="button" class="discount-save-btn" id="pf-new">Prepare another invoice</button>`;
        host.querySelector('#pf-new').onclick = () => this.loadProforma();
        this.proformaRegister.select(saved.id);
        showNotification('Proforma invoice saved and locked.', 'success');
      } catch (error) {
        message.textContent = `Invoice could not be saved: ${error.message}`;
        controls.forEach(control => { control.disabled = false; });
        return;
      }
      // Reserve the local suggestion only after the server issues the invoice.
      const next = this.nextProformaNumber();
      if (invoice.number === next.number) {
        try { tenantStorage.setItem('pos_proforma_seq', JSON.stringify({ day: next.day, n: next.n })); } catch { /* private window */ }
      }
    };
  }


  async generateQR() {
    const urlEl = document.getElementById('qr-url-input');
    const sizeEl = document.getElementById('qr-size-sel');
    const encodedUrl = (urlEl && urlEl.value.trim()) || defaultMenuUrl();
    if (urlEl) tenantStorage.setItem('pos_menu_url', encodedUrl);
    const size = parseInt(sizeEl ? sizeEl.value : '220');

    const renderQR = () => {
      const wrap = document.getElementById('qr-actual');
      if (!wrap) return;
      wrap.innerHTML = '';
      try {
        new QRCode(wrap, {
          text: encodedUrl, width: size, height: size,
          colorDark: '#1a0c04', colorLight: '#ffffff',
          correctLevel: QRCode.CorrectLevel.L // Low error correction to allow larger payloads in the same size
        });
      } catch (e) {
        wrap.innerHTML = '<div style="width:' + size + 'px;height:' + size + 'px;display:flex;align-items:center;justify-content:center;background:#f5f0e8;border-radius:8px;font-size:13px;color:#666;text-align:center;padding:20px;">QR library loading...</div>';
      }
    };

    if (window.QRCode) {
      renderQR();
    } else {
      const s = document.createElement('script');
      s.src = 'https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js';
      s.onload = renderQR;
      s.onerror = () => showNotification('QR library failed to load. Check internet connection.', 'error');
      document.head.appendChild(s);
    }
  }

  downloadQR() {
    const img = document.querySelector('#qr-actual img');
    const canvas = document.querySelector('#qr-actual canvas');
    let src = '';
    if (img && img.src) {
      src = img.src;
    } else if (canvas) {
      try { src = canvas.toDataURL('image/png'); } catch (e) {}
    }

    if (!src) { showNotification('QR not ready yet — wait a moment.', 'error'); return; }
    const a = document.createElement('a');
    a.download = 'vanbransa-menu-qr.png';
    a.href = src;
    a.click();
    showNotification('QR Code downloaded!', 'success');
  }

  printQR() {
    const wrap = document.getElementById('qr-canvas-wrap');
    if (!wrap) return;
    const win = window.open('', '_blank');
    win.document.write('<!DOCTYPE html><html><head><title>Business Menu QR</title></head>');
    win.document.write('<body style="text-align:center;padding:60px;font-family:sans-serif;background:#fff;">');
    win.document.write('<h2 style="margin-bottom:8px;color:#1a0c04;">Scan to View Our Menu</h2>');
    win.document.write('<p style="color:#666;margin-bottom:28px;font-size:14px;">Vanbransa Lounge — Browse &amp; Order from your phone</p>');
    win.document.write(wrap.outerHTML);
    win.document.write('<p style="margin-top:28px;color:#999;font-size:11px;">Powered by Vanbransa POS</p>');
    win.document.write('</body></html>');
    win.document.close();
    setTimeout(() => win.print(), 600);
  }

  // ── EXPORT ──
  async exportData(format) {
    const type = document.getElementById('exp-type') ? document.getElementById('exp-type').value : 'sales';
    const range = document.getElementById('exp-range') ? document.getElementById('exp-range').value : 'month';
    let rows = [], headers = [];
    const now = Date.now();
    const DAY = 86400000;
    const fromTs = range === 'today' ? now - DAY : range === 'week' ? now - 7 * DAY : range === 'month' ? now - 30 * DAY : 0;

    try {
      if (type === 'sales') {
        headers = ['Invoice No', 'Table', 'Total (KES)', 'Payment', 'Status', 'Date'];
        // sold_at is an indexed ISO-8601 string, so it compares lexicographically.
        const orders = await db.sales.where('sold_at').above(new Date(fromTs).toISOString()).toArray();
        const methodBySale = new Map((await db.payments.toArray()).map(p => [p.sale_id, p.method]));
        rows = orders.map(o => [o.invoice_no || o.id || '-', o.table_no || '-', Number(o.grand_total || 0).toFixed(2), methodBySale.get(o.id) || '-', o.status || '-', new Date(o.sold_at).toLocaleString()]);
      } else if (type === 'inventory') {
        headers = ['SKU', 'Product Name', 'Category', 'UOM', 'Sell Price (KES)', 'Active'];
        const prods = await db.products.toArray();
        const cats = new Map((await db.categories.toArray()).map(c => [c.id, c.name]));
        rows = prods.map(p => [p.sku, p.name, cats.get(p.category_id) || 'General', p.uom, Number(p.sell_price).toFixed(2), p.is_active ? 'Yes' : 'No']);
      } else if (type === 'discounts') {
        headers = ['Name', 'Applies To', 'Target', 'Value', 'Type', 'Status'];
        const discs = JSON.parse(tenantStorage.getItem('pos_discounts') || '[]');
        rows = discs.map(d => [d.name, d.type, d.target || '-', d.value, d.kind === 'percent' ? '%' : 'KES Fixed', d.status]);
      }
    } catch (e) {
      showNotification('Export error: ' + e.message, 'error');
      return;
    }

    if (format === 'csv') {
      const csv = [headers.join(','), ...rows.map(r => r.map(v => '"' + String(v).replace(/"/g, '""') + '"').join(','))].join('\r\n');
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'vanbransa_' + type + '_' + new Date().toISOString().slice(0, 10) + '.csv';
      a.click();
      showNotification('CSV exported: ' + rows.length + ' rows.', 'success');
    } else if (format === 'json') {
      const data = rows.map(r => Object.fromEntries(headers.map((h, i) => [h, r[i]])));
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'vanbransa_' + type + '_' + new Date().toISOString().slice(0, 10) + '.json';
      a.click();
      showNotification('JSON exported: ' + rows.length + ' records.', 'success');
    } else {
      // Preview
      const box = document.getElementById('exp-preview-box');
      const inner = document.getElementById('exp-preview-inner');
      if (!box || !inner) return;
      box.style.display = 'block';
      let tbl = '<table style="width:100%;border-collapse:collapse;font-size:12px;"><thead><tr>';
      headers.forEach(h => {
        tbl += '<th style="text-align:left;padding:8px 10px;background:rgba(200,130,42,0.1);border-bottom:1px solid var(--border-color);font-size:11px;text-transform:uppercase;color:var(--text-secondary);">' + h + '</th>';
      });
      tbl += '</tr></thead><tbody>';
      if (!rows.length) {
        tbl += '<tr><td colspan="' + headers.length + '" style="text-align:center;padding:24px;color:var(--text-secondary);">No data for selected range.</td></tr>';
      } else {
        rows.slice(0, 50).forEach(r => {
          tbl += '<tr>';
          r.forEach(v => { tbl += '<td style="padding:8px 10px;border-bottom:1px solid rgba(255,255,255,0.04);">' + v + '</td>'; });
          tbl += '</tr>';
        });
      }
      tbl += '</tbody></table>';
      if (rows.length > 50) tbl += '<div style="padding:8px 10px;font-size:12px;color:var(--text-secondary);">Showing 50 of ' + rows.length + ' rows. Export CSV/JSON for full data.</div>';
      inner.innerHTML = tbl;
      showNotification('Preview: ' + rows.length + ' rows found.', 'success');
    }
  }

  // ── STOCK ALERTS ──
  async runAlertCheck() {
    const threshold = parseInt(tenantStorage.getItem('pos_alert_threshold') || '10');
    const list = document.getElementById('alerts-list');
    if (!list) return;
    list.innerHTML = '<div style="text-align:center;padding:20px;color:var(--text-secondary);">Scanning all stock levels...</div>';

    try {
      const products = await db.products.where('is_active').equals(1).toArray();
      const branchId = state.currentBranch ? state.currentBranch.id : 1;
      const alerts = [];

      for (const prod of products) {
        if (prod.is_service) continue;
        const stock = await getStockOnHand(prod.id, branchId);
        if (stock <= threshold) alerts.push({ prod, stock, critical: stock <= 0 });
      }

      if (alerts.length === 0) {
        list.innerHTML = [
          '<div style="text-align:center;padding:40px;">',
          '<div style="font-size:48px;margin-bottom:12px;">\u2705</div>',
          '<div style="font-weight:700;font-size:16px;color:var(--accent-green);">All stock levels are healthy!</div>',
          '<div style="color:var(--text-secondary);font-size:13px;margin-top:8px;">No items below ' + threshold + ' units threshold.</div>',
          '</div>'
        ].join('');
        return;
      }

      const rows2 = alerts.sort((a, b) => a.stock - b.stock).map(({ prod, stock, critical }) => {
        const color = critical ? 'var(--accent-rose)' : 'var(--accent-amber)';
        const label = critical ? '\uD83D\uDED1 OUT OF STOCK' : '\u26A0\uFE0F LOW STOCK';
        const bg = critical ? 'rgba(192,74,53,0.08)' : 'rgba(232,165,53,0.06)';
        return '<tr style="background:' + bg + ';">' +
          '<td style="font-weight:700;">' + prod.name + '</td>' +
          '<td style="font-family:monospace;font-size:12px;">' + prod.sku + '</td>' +
          '<td style="font-weight:800;font-size:18px;color:' + color + ';">' + stock + '</td>' +
          '<td><span style="font-size:12px;font-weight:700;color:' + color + ';">' + label + '</span></td>' +
          '</tr>';
      });

      list.innerHTML = [
        '<div style="margin-bottom:14px;padding:12px 14px;background:rgba(192,74,53,0.08);border:1px solid rgba(192,74,53,0.2);border-radius:10px;font-size:13px;color:var(--accent-rose);">',
        '\uD83D\uDD14 <strong>' + alerts.length + ' item(s)</strong> need restocking (threshold: ' + threshold + ' units)',
        '</div>',
        '<table class="discount-table">',
        '<thead><tr><th>Product</th><th>SKU</th><th>On Hand</th><th>Status</th></tr></thead>',
        '<tbody>' + rows2.join('') + '</tbody>',
        '</table>'
      ].join('');

      const criticals = alerts.filter(a => a.critical);
      if (criticals.length > 0) {
        showNotification('URGENT: ' + criticals.length + ' item(s) are OUT OF STOCK!', 'error');
      } else {
        showNotification(alerts.length + ' items are running low on stock.', 'warning');
      }
    } catch (e) {
      list.innerHTML = '<div style="color:var(--accent-rose);padding:20px;">Error: ' + e.message + '</div>';
    }
  }
}
