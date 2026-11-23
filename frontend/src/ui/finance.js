import { db } from '../db/schema.js';
import { createMobileFilters } from './mobile-filters.js';
import { showNotification } from '../context.js';
import { loadFinancialSnapshot } from '../services/financial-data.js';
import { pullStaff } from '../services/staff.js';
import { financialAnswer, timestamp, paymentAttemptLabel } from '../services/financial-snapshot.js';
import { quickFinancialPeriod, tradingRange } from '../services/financial-period.js';
import { pullTradingHours, cachedTradingHours } from '../services/trading-hours.js';
import { ProformaRegister } from './proformas.js';
import { financeLayout, FINANCE_SECTIONS } from './finance-layout.js';

export class FinanceView {
  constructor(container) {
    this.container = container;
    this.currentMetrics = null;
  }

  async load() {
    // The window has to be cut on this business's own hours, not the default.
    // It was computed from the fallback while the snapshot filtered sessions
    // on the tenant's setting, so a business that moved its opening hour got
    // two different days out of one screen.
    this.hours = cachedTradingHours();
    this.render();
    this.bindEvents();
    this.hoursReady = pullTradingHours().then(hours => {
      if (!this.disposed) this.hours = hours;
    }).catch(() => {});
    this.filterSheet = createMobileFilters({
      container: this.container, toolbar: this.container.querySelector('.fin-toolbar'),
      controls: [this.container.querySelector('.fin-date-bar')], title: 'Report filters',
      count: () => Number(this.container.querySelector('[data-fin-range].active')?.dataset.finRange !== 'today') + Number((this.session || 'full') !== 'full'),
      reset: () => { this.container.querySelector('[data-fin-session="full"]').click(); this.container.querySelector('[data-fin-range="today"]').click(); },
    });
    this.selectSection(this.sectionFromLocation(), { updateLocation: false });
    void this.loadMetrics();
  }

  render() {
    this.container.innerHTML = financeLayout();

    // Set default date = today in the business's local calendar.
    const today = quickFinancialPeriod('today', new Date(), this.hours);
    const finStart = document.getElementById('fin-start');
    const finEnd = document.getElementById('fin-end');
    if (finStart) finStart.value = today.start;
    if (finEnd) finEnd.value = today.end;
  }

  dispose() {
    this.disposed = true;
    this.loadRequest = (this.loadRequest || 0) + 1;
    this.proformaRegister?.dispose(); this.filterSheet?.dispose();
    window.removeEventListener('hashchange', this.locationHandler);
    this.container.removeEventListener('click', this.sectionClickHandler);
  }

  sectionFromLocation() {
    const section = window.location.hash.slice(1);
    return FINANCE_SECTIONS.some(([id]) => id === section) ? section : 'overview';
  }

  selectSection(section, { updateLocation = true, focus = false } = {}) {
    if (this.disposed || !FINANCE_SECTIONS.some(([id]) => id === section)) return;
    this.activeSection = section;
    this.container.querySelectorAll('[data-fin-section]').forEach(button => {
      const active = button.dataset.finSection === section;
      button.setAttribute('aria-selected', String(active));
      button.tabIndex = active ? 0 : -1;
      if (active && focus) button.focus();
    });
    this.container.querySelectorAll('[data-fin-panel]').forEach(panel => { panel.hidden = panel.dataset.finPanel !== section; });
    // Report controls belong to financial sections, not invoices or the AI workspace.
    const showReportControls = section !== 'invoices' && section !== 'ai';
    this.container.querySelector('.fin-toolbar').hidden = !showReportControls;
    this.container.querySelector('.fin-coverage').hidden = !showReportControls;
    if (updateLocation && window.location.hash !== `#${section}`) {
      window.history.pushState(null, '', `${window.location.pathname}${window.location.search}#${section}`);
    }
    if (section === 'invoices' && !this.proformaRegister) {
      this.proformaRegister = new ProformaRegister(this.container.querySelector('#fin-proformas'), { onPaid: () => this.loadMetrics() });
      void this.proformaRegister.load();
    }
  }

  bindEvents() {
    this.sectionClickHandler = event => {
      const button = event.target.closest('[data-fin-section], [data-fin-open]');
      if (button && this.container.contains(button)) this.selectSection(button.dataset.finSection || button.dataset.finOpen);
    };
    this.container.addEventListener('click', this.sectionClickHandler);
    this.locationHandler = () => this.selectSection(this.sectionFromLocation(), { updateLocation: false });
    window.addEventListener('hashchange', this.locationHandler);
    this.container.querySelector('.fin-tabs').addEventListener('keydown', event => {
      const tabs = [...this.container.querySelectorAll('[data-fin-section]')];
      const index = tabs.indexOf(event.target);
      if (index < 0 || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1
        : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
      this.selectSection(tabs[next].dataset.finSection, { focus: true });
    });
    const loadBtn = document.getElementById('fin-load-btn');
    if (loadBtn) loadBtn.addEventListener('click', () => this.loadMetrics());

    document.querySelectorAll('[data-fin-range]').forEach((button) => {
      button.addEventListener('click', () => {
        const range = quickFinancialPeriod(button.dataset.finRange, new Date(), this.hours);
        document.getElementById('fin-start').value = range.start;
        document.getElementById('fin-end').value = range.end;
        this.setActiveRange(button.dataset.finRange);
        void this.loadMetrics();
      });
    });
    for (const id of ['fin-start', 'fin-end']) {
      document.getElementById(id)?.addEventListener('change', () => {
        this.setActiveRange(null);
        this.container.querySelector('#fin-source-summary').textContent = 'Dates changed. Load Report to refresh.';
        this.container.querySelector('.fin-coverage').dataset.state = 'warning';
      });
    }

    document.querySelectorAll('[data-fin-session]').forEach((button) => {
      button.addEventListener('click', () => {
        this.session = button.dataset.finSession;
        document.querySelectorAll('[data-fin-session]').forEach((other) => {
          other.classList.toggle('active', other === button);
          other.setAttribute('aria-pressed', String(other === button));
        });
        void this.loadMetrics();
      });
    });

    const sendBtn = document.getElementById('ai-send');
    if (sendBtn) sendBtn.addEventListener('click', () => this.handleChat());

    const inp = document.getElementById('ai-inp');
    if (inp) {
      inp.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') this.handleChat();
      });
    }

    document.querySelectorAll('.chip').forEach(chip => {
      chip.addEventListener('click', () => {
        const q = chip.getAttribute('data-q');
        const input = document.getElementById('ai-inp');
        if (input) input.value = q;
        this.handleChat();
      });
    });
  }

  setActiveRange(range) {
    document.querySelectorAll('[data-fin-range]').forEach((button) => {
      button.classList.toggle('active', button.dataset.finRange === range);
      button.setAttribute('aria-pressed', String(button.dataset.finRange === range));
    });
  }

  async loadMetrics() {
    const request = this.loadRequest = (this.loadRequest || 0) + 1;
    // Paint the filters immediately, but price the report's day on trusted hours.
    await this.hoursReady;
    if (this.disposed || request !== this.loadRequest) return;
    const startEl = document.getElementById('fin-start');
    const endEl = document.getElementById('fin-end');
    if (!startEl || !endEl) return;
    const preset = this.container.querySelector('[data-fin-range].active')?.dataset.finRange;
    if (preset) {
      const period = quickFinancialPeriod(preset, new Date(), this.hours);
      startEl.value = period.start;
      endEl.value = period.end;
    }

    const startStr = startEl.value;
    const endStr = endEl.value;
    this.currentMetrics = null;
    if (!startStr || !endStr || startStr > endStr) {
      showNotification('Choose a valid start and end date.', 'warning');
      return;
    }
    // Trading days, not calendar days: the window runs from the morning
    // opening to the next one, so a night's takings stay on one report.
    const session = this.session || 'full';
    const { from: startTs, to: endTs } = tradingRange(startStr, endStr, session, this.hours);

    document.getElementById('fin-source').textContent = 'Refreshing sales and payment confirmations...';
    this.container.querySelector('#fin-source-summary').textContent = 'Loading report…';
    this.container.querySelector('.fin-coverage').dataset.state = 'loading';
    try {
      // The roster is only pulled by Orders/Users, so a phone that opens
      // Finance directly printed staff ids instead of names.
      void pullStaff().catch(() => null);
      const report = await loadFinancialSnapshot(startTs, endTs, session);
      const { sales, transactions, gross, discounts, net, cash, mpesa, other, collected } = report;
      const [users, shifts] = await Promise.all([db.users.toArray(), db.shifts.toArray()]);
      const userMap = new Map(users.map(u => [u.id, u]));
      const shiftUserMap = new Map(shifts.map(sh => [sh.id, userMap.get(sh.user_id)]));
      const staffName = row => userMap.get(row.staff_id)?.name || shiftUserMap.get(row.shift_id)?.name || row.staff_id || 'Unattributed';
      // The snapshot aggregates by staff id; only the till knows the names, so
      // they are attached here and travel on into the AI answer.
      report.staffRundown = report.staffRundown.map(row => ({ ...row, name: staffName(row) }));
      const fmt = v => 'KES ' + v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

      if (request !== this.loadRequest) return;
      const escape = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
      const set = (id, val) => {
        const el = document.getElementById(id);
        if (el) el.innerText = val;
      };

      this.dataSource = report.dataSource;
      // The session is part of what these figures mean, and money the window
      // excludes is the difference between "there is none" and "you are not
      // looking at it". Both belong on screen, not only in the AI answer.
      // Quoting this business's hours, not a hard-coded pair: a report that
      // says 05:00 while the day opens at 06:00 is worse than saying nothing.
      const hh = (hour) => `${String(hour).padStart(2, '0')}:00`;
      const dayAt = hh(report.dayStartHour);
      const nightAt = hh(report.nightStartHour);
      const sessionNote = session === 'morning' ? ` Morning session only (${dayAt}–${nightAt}).`
        : session === 'night' ? ` Night session only (${nightAt}–${dayAt}).`
          : ` Full trading day (${dayAt} to ${dayAt} next morning).`;
      const missedNote = report.outsideCount
        ? ` ⚠ ${report.outsideCount} confirmed payment(s) worth ${fmt(report.outsideTotal)} fall outside this window — widen the dates or choose Full day.`
        : '';
      set('fin-source', report.dataSource + sessionNote + missedNote);
      const incomplete = report.dataSource.startsWith('Incomplete report');
      set('fin-source-summary', incomplete ? 'Some records could not be refreshed. Open for details.' : 'Report up to date');
      const coverage = this.container.querySelector('.fin-coverage');
      coverage.dataset.state = incomplete ? 'warning' : 'ready';
      if (incomplete) { coverage.open = true; coverage.dataset.errorOpen = 'true'; }
      else if (coverage.dataset.errorOpen) { coverage.open = false; delete coverage.dataset.errorOpen; }
      const dateLabel = value => new Date(`${value}T12:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
      set('fin-period-caption', `${dateLabel(startStr)}${startStr === endStr ? '' : ` to ${dateLabel(endStr)}`} · ${session === 'morning' ? 'Morning' : session === 'night' ? 'Night' : 'Full day'}`);
      set('fin-overview-sales', fmt(net));
      set('fin-overview-unpaid', fmt(report.pending));
      set('fin-overview-payments', report.paymentCount);
      const attention = [
        [report.unmatched > 0, 'Payments without a matching order', report.unmatched],
        [report.heldCount > 0, 'Payments still on a till', report.heldTotal],
        [report.undatedCount > 0, 'Payments missing a date', report.undatedTotal],
      ].filter(([needed]) => needed);
      this.container.querySelector('#fin-attention').innerHTML = attention.length
        ? `<ul>${attention.map(([, label, amount]) => `<li><span>${label}</span><button type="button" class="fin-text-link" data-fin-open="payments">${fmt(amount)} · Review</button></li>`).join('')}</ul>`
        : '<p>No payment issues flagged in this report.</p>';
      const details = document.getElementById('fin-transactions');
      // The order number the customer was given comes before the raw document
      // id, so a row reads as the invoice or table reference somebody can act
      // on rather than an opaque key.
      // A till's internal key is not an order number. Where the sale behind a
      // payment has not reached the server, name that rather than print the key.
      const marriedTo = (p) => {
        if (p.receiptConflict) return `${p.invoice_no || 'Saved sale'} — receipt needs review`;
        if (p.unapplied) return `Received — not applied to ${p.invoice_no || p.order_reference || 'the order'}`;
        // The order number comes first even when the sale is still on a till:
        // that is the thing somebody can actually go and look at.
        if (p.held_on_till && p.order_reference) return `${p.order_reference} · ⚠ still on the till`;
        if (p.unsynced && p.status === 'SUCCESS') return '⚠ Sale still on the till — not synced';
        if (p.status === 'SUCCESS' && !p.linked) return 'Received — invoice not matched';
        const named = p.invoice_no || p.order_reference || p.customer_order_id
          || (p.status === 'SUCCESS' ? 'No matching sale / order' : '-');
        return p.localOnly ? `${named} · ⚠ on this till only` : named;
      };
      // An undated payment would otherwise render as "Invalid Date".
      const when = p => (Number.isFinite(timestamp(p.received_at))
        ? new Date(timestamp(p.received_at)).toLocaleString()
        : '⚠ No date recorded');
      if (details) details.innerHTML = '<table class="fin-table"><thead><tr><th>Received / attempted</th><th>Reference</th><th>Staff</th><th>Method</th><th>Amount</th><th>Payment status</th><th>Sale / order</th></tr></thead><tbody>' + transactions.map(p => '<tr><td>' + escape(when(p)) + '</td><td>' + escape(p.reference || p.id) + (p.verified === false ? '<br><small style="color:var(--text-secondary)">unverified</small>' : '') + '</td><td>' + escape(staffName(p)) + '</td><td>' + escape(p.method) + '</td><td>' + fmt(p.amount) + '</td><td>' + escape(paymentAttemptLabel(p)) + '</td><td>' + escape(marriedTo(p)) + (p.customer_name ? '<br><small>' + escape(p.customer_name) + '</small>' : '') + '</td></tr>').join('') + (transactions.length ? '' : '<tr><td colspan="7">No payment records in this period.</td></tr>') + '</tbody></table>';
      set('fin-payment-count', report.paymentCount);
      set('fin-unmatched', fmt(report.unmatched));
      set('fin-failed', fmt(report.failed));
      // A method card reading zero has to say whether that means "none taken"
      // or "taken, but still sitting on a till". Same figure, different night.
      const heldOn = (bucket, fallback = '') => {
        const amount = report.heldByMethod?.[bucket] || 0;
        return amount ? `+ ${fmt(amount)} held on a till` : fallback;
      };
      set('fin-mpesa-held', heldOn('mpesa'));
      set('fin-cash-held', heldOn('cash'));
      set('fin-bank-held', heldOn('bank', 'Statement references, unverified'));
      set('fin-other-held', heldOn('other'));
      set('fin-held', fmt(report.heldTotal));
      // Held is money already taken that the business has not received a
      // record of. It is not an unpaid tab - that is Unpaid Orders / Proformas.
      set('fin-held-count', report.heldCount
        ? `${report.heldCount} payment(s) already taken at a till whose sale has not reached the server. Not unpaid tabs — money in hand, not yet in the books.`
        : 'Money taken at a till whose sale has not reached the server yet');
      set('fin-undated', fmt(report.undatedTotal));
      set('fin-undated-count', report.undatedCount
        ? `${report.undatedCount} payment(s) missing a date — listed below, uncounted`
        : 'Not counted in any period');
      set('fin-pending', fmt(report.pending));
      set('fin-pending-count', `${report.pendingCount} ${report.pendingCount === 1 ? 'order' : 'orders'} · unreceived`);
      set('fin-gross', fmt(gross));
      set('fin-disc', fmt(discounts));
      set('fin-net', fmt(net));
      set('fin-cash', fmt(cash));
      set('fin-mpesa', fmt(mpesa));
      set('fin-bank', fmt(report.bank));
      set('fin-other', fmt(other));
      set('fin-collected', fmt(collected));
      set('fin-unpaid', fmt(report.unpaid));
      set('fin-count', sales.length);

      const unpaidOrders = document.getElementById('fin-unpaid-orders');
      if (unpaidOrders) unpaidOrders.innerHTML = '<table class="fin-table"><thead><tr><th>Raised</th><th>Order / invoice</th><th>Source</th><th>Staff</th><th>Branch</th><th style="text-align:right">Unreceived</th><th></th></tr></thead><tbody>'
        + report.unpaidOrders.map(order => '<tr><td>' + escape(order.invoice_date || new Date(timestamp(order.placed_at)).toLocaleString()) + '</td><td>' + escape(order.reference) + (order.customer_name ? '<br><small>' + escape(order.customer_name) + '</small>' : '') + '</td><td>' + escape(order.source === 'proforma' ? 'Proforma invoice' : order.source === 'customer_order' ? 'Customer order' : 'Till invoice') + '</td><td>' + escape(order.staff_id ? staffName(order) : 'Unassigned') + '</td><td>' + escape(order.branch_id || '—') + '</td><td style="text-align:right">' + fmt(order.amount) + '</td><td><a class="fin-reconcile" href="/orders?' + (order.source === 'proforma' ? 'proforma=' + encodeURIComponent(order.id) : 'order=' + encodeURIComponent(order.reference)) + '">Reconcile</a></td></tr>').join('')
        + (report.unpaidOrders.length ? '' : '<tr><td colspan="7">No unpaid orders in this period.</td></tr>') + '</tbody></table>';

      // Render the staff rundown
      const reportBody = document.getElementById('cashier-report-body');
      if (reportBody) {
        const rows = report.staffRundown;
        if (rows.length === 0) {
          reportBody.innerHTML = `
            <tr>
              <td colspan="6" style="padding:16px;text-align:center;color:var(--text-secondary);">Nobody recorded a sale, a payment or an open order in this date range.</td>
            </tr>
          `;
        } else {
          reportBody.innerHTML = rows.map(row => `
            <tr>
              <td style="font-weight: 600; color: #fff;">${escape(row.name)}</td>
              <td style="text-align:center; color: var(--text-secondary);">${row.salesCount}</td>
              <td style="text-align:right;">${fmt(row.sales)}</td>
              <td style="text-align:center; color: var(--text-secondary);">${row.receivedCount}</td>
              <td style="text-align:right; font-weight: 700; color: var(--accent-green);">${fmt(row.received)}</td>
              <td style="text-align:right; color:${row.unpaid > 0 ? '#ff9800' : 'var(--text-secondary)'};">${fmt(row.unpaid)}${row.unpaidCount ? ` <small>(${row.unpaidCount})</small>` : ''}</td>
            </tr>
          `).join('');
        }
      }

      this.currentMetrics = { ...report, startStr, endStr, session };
      this.addAIMsg(`${incomplete ? 'Some records could not be refreshed. ' : 'Report ready. '}Payments received: ${fmt(collected)}. Unpaid orders and invoices: ${fmt(report.pending)}. Ask a question for a breakdown.`, { reportContext: true });

    } catch (err) {
      if (request !== this.loadRequest) return;
      this.currentMetrics = null;
      document.getElementById('fin-source').textContent = 'Report failed to load. Reload before using these figures.';
      this.container.querySelector('#fin-source-summary').textContent = 'Report could not be refreshed. Try again.';
      this.container.querySelector('.fin-coverage').dataset.state = 'warning';
      this.container.querySelector('.fin-coverage').open = true;
      this.container.querySelector('.fin-coverage').dataset.errorOpen = 'true';
      console.error('Finance load error:', err);
      showNotification('Error loading financial data', 'error');
    }
  }

  handleChat() {
    const inp = document.getElementById('ai-inp');
    if (!inp) return;
    const msg = inp.value.trim();
    if (!msg) return;
    inp.value = '';
    this.addUserMsg(msg);
    this.showTyping();
    setTimeout(() => {
      this.removeTyping();
      this.generateResponse(msg.toLowerCase());
    }, 700);
  }

  addUserMsg(text) {
    const area = document.getElementById('ai-msgs');
    if (!area) return;
    const d = document.createElement('div');
    d.className = 'user-bubble';
    d.innerText = text;
    area.appendChild(d);
    area.scrollTop = area.scrollHeight;
  }

  addAIMsg(text, { reportContext = false } = {}) {
    const area = document.getElementById('ai-msgs');
    if (!area) return;
    const d = (reportContext && area.querySelector('#ai-report-context')) || document.createElement('div');
    d.className = 'ai-bubble';
    if (reportContext) d.id = 'ai-report-context';
    d.innerText = text;
    area.appendChild(d);
    area.scrollTop = area.scrollHeight;
  }

  showTyping() {
    const area = document.getElementById('ai-msgs');
    if (!area) return;
    const d = document.createElement('div');
    d.className = 'ai-typing';
    d.id = 'ai-typing-indicator';
    d.innerHTML = '<span></span><span></span><span></span>';
    area.appendChild(d);
    area.scrollTop = area.scrollHeight;
  }

  removeTyping() {
    const t = document.getElementById('ai-typing-indicator');
    if (t) t.remove();
  }

  generateResponse(q) {
    const m = this.currentMetrics;
    if (m && (m.startStr !== document.getElementById('fin-start')?.value
      || m.endStr !== document.getElementById('fin-end')?.value
      || m.session !== (this.session || 'full'))) {
      this.addAIMsg('The period changed. Load Report before asking about the new dates.');
      return;
    }
    if (!m) {
      this.addAIMsg('Please select a date range and click "Load Report" first so I can analyze your data.');
      return;
    }

    this.addAIMsg(financialAnswer(m, q));
  }
}
