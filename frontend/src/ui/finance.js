import { db } from '../db/schema.js';
import { createMobileFilters } from './mobile-filters.js';
import { showNotification } from '../context.js';
import { loadFinancialSnapshot } from '../services/financial-data.js';
import { pullStaff } from '../services/staff.js';
import { financialAnswer, timestamp } from '../services/financial-snapshot.js';
import { quickFinancialPeriod, tradingRange } from '../services/financial-period.js';
import { pullTradingHours, cachedTradingHours } from '../services/trading-hours.js';

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
    this.hours = await pullTradingHours().catch(() => cachedTradingHours());
    this.render();
    this.bindEvents();
    this.filterSheet = createMobileFilters({
      container: this.container, toolbar: this.container.querySelector('.fin-card'),
      controls: [this.container.querySelector('.fin-date-bar')], title: 'Report filters',
      count: () => Number(this.container.querySelector('[data-fin-range].active')?.dataset.finRange !== 'today') + Number((this.session || 'full') !== 'full'),
      reset: () => { this.container.querySelector('[data-fin-session="full"]').click(); this.container.querySelector('[data-fin-range="today"]').click(); },
    });
    await this.loadMetrics();
  }

  render() {
    this.container.innerHTML = [
      '<style>',
      '.finance-shell { display: flex; gap: 16px; height: 100%; padding: 16px; box-sizing: border-box; overflow: hidden; }',
      '.finance-left { flex: 2; min-width: 0; display: flex; flex-direction: column; gap: 16px; overflow-y: auto; }',
      '.finance-right { flex: 1; min-width: 280px; display: flex; flex-direction: column; background: linear-gradient(180deg, rgba(30,30,60,0.98) 0%, rgba(15,15,35,0.98) 100%); border-radius: 16px; border: 1px solid rgba(120,100,255,0.3); overflow: hidden; }',
      '.fin-card { background: var(--surface); border-radius: 12px; padding: 20px; }',
      '.fin-date-bar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }',
      '.fin-date-bar label { font-size: 13px; color: var(--text-secondary); }',
      '.fin-date-bar input[type=date] { background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.15); color: #fff; padding: 8px 12px; border-radius: 8px; font-size: 13px; }',
      '.fin-load-btn { background: var(--accent); color: #000; border: none; padding: 9px 20px; border-radius: 8px; cursor: pointer; font-weight: 700; font-size: 13px; }',
      '.fin-quick-ranges { display:flex; gap:6px; flex-wrap:wrap; margin-left:2px; }',
      '.fin-range-btn { background:rgba(255,255,255,.06); color:var(--text-secondary); border:1px solid rgba(255,255,255,.13); padding:8px 11px; border-radius:8px; cursor:pointer; font-size:12px; font-weight:700; }',
      '.fin-range-btn:hover,.fin-range-btn.active { color:#111; background:#f1b23c; border-color:#f1b23c; }',
      '.fin-reconcile { color:#111; background:var(--accent); padding:6px 10px; border-radius:7px; text-decoration:none; font-size:11px; font-weight:800; white-space:nowrap; display:inline-block; }',
      '.metrics-row { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; }',
      '.m-card { background: rgba(255,255,255,0.05); border-radius: 10px; padding: 16px; border-left: 4px solid var(--accent); }',
      '.m-card.green { border-left-color: #4caf50; }',
      '.m-card.blue { border-left-color: #2196f3; }',
      '.m-card.orange { border-left-color: #ff9800; }',
      '.m-card h5 { margin: 0 0 6px 0; font-size: 12px; color: var(--text-secondary); text-transform: uppercase; letter-spacing: 0.5px; }',
      '.m-card .m-val { margin: 0; font-size: 22px; font-weight: 700; }',
      /* AI Panel */
      '.ai-header { display: flex; align-items: center; gap: 10px; padding: 16px; border-bottom: 1px solid rgba(255,255,255,0.08); }',
      '.ai-logo { width: 32px; height: 32px; border-radius: 50%; background: linear-gradient(135deg, #6060ff, #a040ff); display: flex; align-items: center; justify-content: center; font-size: 16px; }',
      '.ai-title { font-size: 15px; font-weight: 700; color: #c0b0ff; }',
      '.ai-subtitle { font-size: 11px; color: rgba(255,255,255,0.4); }',
      '.ai-msgs { flex: 1; overflow-y: auto; padding: 12px; display: flex; flex-direction: column; gap: 10px; }',
      '.ai-bubble { background: rgba(100,80,255,0.15); border-left: 3px solid #8060ff; border-radius: 0 8px 8px 0; padding: 10px 12px; font-size: 13px; color: rgba(255,255,255,0.85); line-height: 1.5; }',
      '.user-bubble { background: rgba(255,255,255,0.08); border-radius: 8px 8px 0 8px; padding: 10px 12px; font-size: 13px; align-self: flex-end; max-width: 85%; }',
      '.ai-typing { display: flex; gap: 4px; padding: 8px 12px; align-items: center; }',
      '.ai-typing span { width: 7px; height: 7px; background: #8060ff; border-radius: 50%; animation: aidot 1.2s infinite; }',
      '.ai-typing span:nth-child(2) { animation-delay: 0.2s; }',
      '.ai-typing span:nth-child(3) { animation-delay: 0.4s; }',
      '@keyframes aidot { 0%,80%,100%{opacity:0.3;transform:scale(0.8)} 40%{opacity:1;transform:scale(1)} }',
      '.ai-input-row { display: flex; gap: 8px; padding: 12px; border-top: 1px solid rgba(255,255,255,0.08); }',
      '.ai-input-row input { flex: 1; background: rgba(255,255,255,0.07); border: 1px solid rgba(255,255,255,0.12); color: #fff; padding: 10px 14px; border-radius: 8px; font-size: 13px; outline: none; }',
      '.ai-input-row button { background: linear-gradient(135deg,#6060ff,#a040ff); color: #fff; border: none; padding: 0 16px; border-radius: 8px; cursor: pointer; font-weight: 700; font-size: 13px; }',
      '.ai-suggest-chips { display: flex; gap: 6px; flex-wrap: wrap; padding: 0 12px 8px; }',
      '.chip { background: rgba(120,80,255,0.2); border: 1px solid rgba(120,80,255,0.35); border-radius: 20px; padding: 4px 10px; font-size: 11px; cursor: pointer; color: #c0a0ff; white-space: nowrap; }',
      '.chip:hover { background: rgba(120,80,255,0.4); }',
      '@media(max-width:768px){ .finance-shell{flex-direction:column;} .finance-right{min-width:unset;height:400px;} }',
      '.fin-table th { padding: 10px 12px; border-bottom: 2px solid rgba(255,255,255,0.08); font-size: 11px; text-transform: uppercase; color: var(--text-secondary); }',
      '.fin-table td { padding: 12px; border-bottom: 1px solid rgba(255,255,255,0.05); }',
      '.fin-table tr:hover { background: rgba(255,255,255,0.02); }',
      '</style>',

      '<div class="finance-shell">',

      '  <div class="finance-left">',
      '    <div class="fin-card">',
      '      <h2 style="margin:0 0 14px 0;font-size:18px;">📊 Financial Report</h2>',
      '      <div class="fin-date-bar">',
      '        <label>From:</label>',
      '        <input type="date" id="fin-start" />',
      '        <label>To:</label>',
      '        <input type="date" id="fin-end" />',
      '        <button class="fin-load-btn" id="fin-load-btn">Load Report</button>',
      '        <div class="fin-quick-ranges" role="group" aria-label="Quick report period">',
      '          <button type="button" class="fin-range-btn active" data-fin-range="today">Today</button>',
      '          <button type="button" class="fin-range-btn" data-fin-range="yesterday">Yesterday</button>',
      '          <button type="button" class="fin-range-btn" data-fin-range="week">Past week</button>',
      '          <button type="button" class="fin-range-btn" data-fin-range="month">Past month</button>',
      '        </div>',
      '        <div class="fin-quick-ranges" role="group" aria-label="Trading session">',
      '          <button type="button" class="fin-range-btn active" data-fin-session="full">Full day</button>',
      '          <button type="button" class="fin-range-btn" data-fin-session="morning">Morning</button>',
      '          <button type="button" class="fin-range-btn" data-fin-session="night">Night</button>',
      '        </div>',
      '      </div>',
      '      <p style="margin:10px 0 0;color:var(--text-secondary);font-size:12px;">A trading day runs from the morning opening to the next morning, so a night that crosses midnight stays on the day it started.</p>',
      '    </div>',
      '    <p id="fin-source" role="status">Loading transaction records...</p>',
      '    <div class="metrics-row">',
      '      <div class="m-card"><h5>Payments Received</h5><p class="m-val" id="fin-collected">KES 0</p></div>',
      '      <div class="m-card green"><h5>M-Pesa Received</h5><p class="m-val" id="fin-mpesa">KES 0</p><small id="fin-mpesa-held"></small></div>',
      '      <div class="m-card blue"><h5>Cash Received</h5><p class="m-val" id="fin-cash">KES 0</p><small id="fin-cash-held"></small></div>',
      '      <div class="m-card green"><h5>Bank Transfers</h5><p class="m-val" id="fin-bank">KES 0</p><small id="fin-bank-held">Statement references, unverified</small></div>',
      '      <div class="m-card"><h5>Card &amp; Other</h5><p class="m-val" id="fin-other">KES 0</p><small id="fin-other-held"></small></div>',
      '      <div class="m-card blue"><h5>Confirmed Payments</h5><p class="m-val" id="fin-payment-count">0</p></div>',
      '      <div class="m-card orange"><h5>Received Without Sale / Order</h5><p class="m-val" id="fin-unmatched">KES 0</p></div>',
      '      <div class="m-card"><h5>Failed / Cancelled Attempts</h5><p class="m-val" id="fin-failed">KES 0</p></div>',
      '      <div class="m-card orange"><h5>Received Without A Date</h5><p class="m-val" id="fin-undated">KES 0</p><small id="fin-undated-count">Not counted in any period</small></div>',
      '      <div class="m-card orange"><h5>Held On A Till</h5><p class="m-val" id="fin-held">KES 0</p><small id="fin-held-count">Settled but not yet reached the business — not counted above</small></div>',
      '      <div class="m-card"><h5>Pending / Unpaid Orders</h5><p class="m-val" id="fin-pending">KES 0</p><small id="fin-pending-count">0 orders · unreceived</small></div>',
      '      <div class="m-card"><h5>Gross Recorded Sales</h5><p class="m-val" id="fin-gross">KES 0</p></div>',
      '      <div class="m-card"><h5>Total Discounts</h5><p class="m-val" id="fin-disc">KES 0</p></div>',
      '      <div class="m-card green"><h5>Recorded Sales After Discounts</h5><p class="m-val" id="fin-net">KES 0</p></div>',
      '      <div class="m-card orange"><h5>Unreceived Cash</h5><p class="m-val" id="fin-unpaid">KES 0</p><small>Awaiting reconciliation to an order</small></div>',
      '      <div class="m-card orange"><h5>Completed Sales</h5><p class="m-val" id="fin-count">0</p></div>',
      '    </div>',
      '    <div class="fin-card">',
      '      <h3 style="margin:0 0 6px;font-size:15px;color:#fff;">Pending orders to reconcile</h3>',
      '      <p style="margin:0 0 12px;color:var(--text-secondary);font-size:12px;">Every unpaid order in this organization for the selected period. Match one to a received M-Pesa code, bank reference, card reference, or cash where this organization accepts cash.</p>',
      '      <div id="fin-unpaid-orders" style="overflow:auto"></div>',
      '    </div>',
      '    <div class="fin-card">',
      '      <h3 style="margin:0 0 6px 0;font-size:15px;color:#fff;">👥 Staff rundown</h3>',
      '      <p style="margin:0 0 12px;color:var(--text-secondary);font-size:12px;">Everyone who handled money or an order in the selected period: what they completed, what they took, and what is still open against their name.</p>',
      '      <div style="overflow-x:auto;">',
      '        <table class="fin-table" style="width:100%; border-collapse:collapse; text-align:left; font-size:13px;">',
      '          <thead>',
      '            <tr>',
      '              <th>Staff member</th>',
      '              <th style="text-align:center;">Completed sales</th>',
      '              <th style="text-align:right;">Sales value</th>',
      '              <th style="text-align:center;">Payments</th>',
      '              <th style="text-align:right;">Received</th>',
      '              <th style="text-align:right;">Still unpaid</th>',
      '            </tr>',
      '          </thead>',
      '          <tbody id="cashier-report-body">',
      '            <tr>',
      '              <td colspan="6" style="padding:16px;text-align:center;color:var(--text-secondary);">No data loaded yet.</td>',
      '            </tr>',
      '          </tbody>',
      '        </table>',
      '      </div>',
      '    </div>',
      '    <div class="fin-card"><h3>Transactions in selected period</h3><p>Payments are filtered by receipt date. Sales are filtered by sale date. Failed and pending attempts are excluded from money received. Unmatched payments are received money awaiting a sale/order record.</p><div id="fin-transactions" style="overflow:auto"></div></div>',
      '  </div>',

      '  <div class="finance-right">',
      '    <div class="ai-header">',
      '      <div class="ai-logo">✨</div>',
      '      <div><div class="ai-title">Vanbransa AI</div><div class="ai-subtitle">Offline Analytics Assistant</div></div>',
      '    </div>',
      '    <div class="ai-msgs" id="ai-msgs">',
      '      <div class="ai-bubble">Hello! I\'m your Vanbransa AI assistant. Load a date range and I\'ll analyze your financials. Ask about revenue, tenders, discounts, or order counts.</div>',
      '    </div>',
      '    <div class="ai-suggest-chips">',
      '      <div class="chip" data-q="performance">Performance</div>',
      '      <div class="chip" data-q="cash vs mpesa">Cash vs M-Pesa</div>',
      '      <div class="chip" data-q="discount">Discounts</div>',
      '      <div class="chip" data-q="unpaid and pending">Unpaid</div>',
      '      <div class="chip" data-q="staff rundown">Staff</div>',
      '      <div class="chip" data-q="bank transfers">Bank</div>',
      '      <div class="chip" data-q="insight">Insights</div>',
      '    </div>',
      '    <div class="ai-input-row">',
      '      <input type="text" id="ai-inp" placeholder="Ask about your business..." />',
      '      <button id="ai-send">Ask</button>',
      '    </div>',
      '  </div>',

      '</div>'
    ].join('\n');

    // Set default date = today in the business's local calendar.
    const today = quickFinancialPeriod('today', new Date(), this.hours);
    const finStart = document.getElementById('fin-start');
    const finEnd = document.getElementById('fin-end');
    if (finStart) finStart.value = today.start;
    if (finEnd) finEnd.value = today.end;
  }

  dispose() { this.filterSheet?.dispose(); }

  bindEvents() {
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
      document.getElementById(id)?.addEventListener('change', () => this.setActiveRange(null));
    }

    document.querySelectorAll('[data-fin-session]').forEach((button) => {
      button.addEventListener('click', () => {
        this.session = button.dataset.finSession;
        document.querySelectorAll('[data-fin-session]').forEach((other) => {
          other.classList.toggle('active', other === button);
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
    });
  }

  async loadMetrics() {
    const startEl = document.getElementById('fin-start');
    const endEl = document.getElementById('fin-end');
    if (!startEl || !endEl) return;

    const startStr = startEl.value;
    const endStr = endEl.value;
    this.currentMetrics = null;
    const request = this.loadRequest = (this.loadRequest || 0) + 1;
    if (!startStr || !endStr || startStr > endStr) {
      showNotification('Choose a valid start and end date.', 'warning');
      return;
    }
    // Trading days, not calendar days: the window runs from the morning
    // opening to the next one, so a night's takings stay on one report.
    const session = this.session || 'full';
    const { from: startTs, to: endTs } = tradingRange(startStr, endStr, session, this.hours);

    document.getElementById('fin-source').textContent = 'Refreshing sales and payment confirmations...';
    try {
      // The roster is only pulled by Orders/Users, so a phone that opens
      // Finance directly printed staff ids instead of names.
      const [report] = await Promise.all([
        loadFinancialSnapshot(startTs, endTs, session),
        pullStaff().catch(() => null),
      ]);
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
      const details = document.getElementById('fin-transactions');
      // The order number the customer was given comes before the raw document
      // id, so a row reads as the invoice or table reference somebody can act
      // on rather than an opaque key.
      // A till's internal key is not an order number. Where the sale behind a
      // payment has not reached the server, name that rather than print the key.
      const marriedTo = (p) => {
        // The order number comes first even when the sale is still on a till:
        // that is the thing somebody can actually go and look at.
        if (p.held_on_till && p.order_reference) return `${p.order_reference} · ⚠ still on the till`;
        if (p.unsynced && p.status === 'SUCCESS') return '⚠ Sale still on the till — not synced';
        const named = p.invoice_no || p.order_reference || p.customer_order_id
          || (p.status === 'SUCCESS' ? 'No matching sale / order' : '-');
        return p.localOnly ? `${named} · ⚠ on this till only` : named;
      };
      // An undated payment would otherwise render as "Invalid Date".
      const when = p => (Number.isFinite(timestamp(p.received_at))
        ? new Date(timestamp(p.received_at)).toLocaleString()
        : '⚠ No date recorded');
      if (details) details.innerHTML = '<table class="fin-table"><thead><tr><th>Received / attempted</th><th>Reference</th><th>Staff</th><th>Method</th><th>Amount</th><th>Payment status</th><th>Sale / order</th></tr></thead><tbody>' + transactions.map(p => '<tr><td>' + escape(when(p)) + '</td><td>' + escape(p.reference || p.id) + (p.verified === false ? '<br><small style="color:var(--text-secondary)">unverified</small>' : '') + '</td><td>' + escape(staffName(p)) + '</td><td>' + escape(p.method) + '</td><td>' + fmt(p.amount) + '</td><td>' + escape(p.status === 'PENDING' ? 'PENDING / UNPAID' : p.status) + '</td><td>' + escape(marriedTo(p)) + (p.customer_name ? '<br><small>' + escape(p.customer_name) + '</small>' : '') + '</td></tr>').join('') + (transactions.length ? '' : '<tr><td colspan="7">No payment records in this period.</td></tr>') + '</tbody></table>';
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
      // record of. It is not an unpaid tab - that is Pending / Unpaid Orders.
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
        + report.unpaidOrders.map(order => '<tr><td>' + escape(new Date(timestamp(order.placed_at)).toLocaleString()) + '</td><td>' + escape(order.reference) + (order.customer_name ? '<br><small>' + escape(order.customer_name) + '</small>' : '') + '</td><td>' + escape(order.source === 'customer_order' ? 'Customer order' : 'Till invoice') + '</td><td>' + escape(order.staff_id ? staffName(order) : 'Unassigned') + '</td><td>' + escape(order.branch_id || '—') + '</td><td style="text-align:right">' + fmt(order.amount) + '</td><td><a class="fin-reconcile" href="/orders?order=' + encodeURIComponent(order.reference) + '">Reconcile</a></td></tr>').join('')
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
      this.addAIMsg(financialAnswer(this.currentMetrics));

    } catch (err) {
      if (request !== this.loadRequest) return;
      this.currentMetrics = null;
      document.getElementById('fin-source').textContent = 'Report failed to load. Reload before using these figures.';
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

  addAIMsg(text) {
    const area = document.getElementById('ai-msgs');
    if (!area) return;
    const d = document.createElement('div');
    d.className = 'ai-bubble';
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
