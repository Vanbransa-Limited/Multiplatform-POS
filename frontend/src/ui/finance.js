import { db } from '../db/schema.js';
import { createMobileFilters } from './mobile-filters.js';
import { showNotification } from '../context.js';
import { loadFinancialSnapshot } from '../services/financial-data.js';
import { pullStaff } from '../services/staff.js';
import { financialAnswer, timestamp, paymentAttemptLabel } from '../services/financial-snapshot.js';
import { quickFinancialPeriod, tradingRange } from '../services/financial-period.js';
import { pullTradingHours, cachedTradingHours } from '../services/trading-hours.js';
import { ProformaRegister } from './proformas.js';

export class FinanceView {
  constructor(container) {
    this.container = container;
    this.currentMetrics = null;
    this.activeFinTab = 'overview';
    this.consolidateByTable = true;
  }

  async load() {
    // The window has to be cut on this business's own hours, not the default.
    // It was computed from the fallback while the snapshot filtered sessions
    // on the tenant's setting, so a business that moved its opening hour got
    // two different days out of one screen.
    this.hours = cachedTradingHours();
    this.render();
    this.bindEvents();
    this.proformaRegister = new ProformaRegister(this.container.querySelector('#fin-proformas'), { onPaid: () => this.loadMetrics() });
    void this.proformaRegister.load();
    this.hoursReady = pullTradingHours().then(hours => {
      if (!this.disposed) this.hours = hours;
    }).catch(() => {});
    this.filterSheet = createMobileFilters({
      container: this.container, toolbar: this.container.querySelector('#fin-period-toolbar'),
      controls: [this.container.querySelector('.fin-date-bar')], title: 'Report filters',
      count: () => Number(this.container.querySelector('[data-fin-range].active')?.dataset.finRange !== 'today') + Number((this.session || 'full') !== 'full'),
      reset: () => { this.container.querySelector('[data-fin-session="full"]').click(); this.container.querySelector('[data-fin-range="today"]').click(); },
    });
    void this.loadMetrics();
  }

  render() {
    this.container.innerHTML = [
      '<style>',
      '.finance-page { display: flex; flex-direction: column; gap: 16px; padding: 16px; box-sizing: border-box; max-width: 1600px; margin: 0 auto; width: 100%; }',
      '.fin-top-header h1 { margin: 0; font-family: var(--font-display); font-size: 26px; font-weight: 800; color: #fff; }',
      '.fin-top-header p { margin: 4px 0 0; font-size: 13px; color: var(--text-secondary); }',
      '.fin-nav-tabs { display: grid; grid-template-columns: repeat(3, 1fr); border-bottom: 1px solid rgba(255,255,255,0.08); background: rgba(20, 14, 8, 0.6); border-radius: 10px 10px 0 0; overflow: hidden; }',
      '@media(min-width: 900px) { .fin-nav-tabs { grid-template-columns: repeat(6, 1fr); } }',
      '.fin-nav-tab { background: transparent; border: none; border-bottom: 2px solid transparent; color: var(--text-secondary); font-family: var(--font-main); font-size: 13px; font-weight: 600; padding: 12px 8px; cursor: pointer; text-align: center; transition: color 0.2s, border-color 0.2s, background 0.2s; min-height: 44px; }',
      '.fin-nav-tab:hover { color: #fff; background: rgba(255,255,255,0.03); }',
      '.fin-nav-tab.active { color: #e8a535; border-bottom-color: #e8a535; font-weight: 700; background: rgba(232, 165, 53, 0.06); }',
      '.finance-shell { display: flex; gap: 16px; width: 100%; box-sizing: border-box; align-items: flex-start; }',
      '.finance-left { flex: 2; min-width: 0; display: flex; flex-direction: column; gap: 16px; width: 100%; }',
      '.finance-right { flex: 1; min-width: 300px; display: flex; flex-direction: column; background: linear-gradient(180deg, rgba(30,22,14,0.98) 0%, rgba(16,11,7,0.98) 100%); border-radius: 16px; border: 1px solid rgba(232,165,53,0.28); overflow: hidden; min-height: 480px; max-height: 720px; }',
      '.fin-card { background: var(--surface); border: 1px solid var(--border-color); border-radius: 12px; padding: 20px; }',
      '.fin-period-card { background: #221509; border: 1px solid rgba(200,130,42,0.22); border-radius: 12px; padding: 16px; }',
      '.fin-period-summary { display: flex; flex-direction: column; gap: 4px; margin-bottom: 10px; }',
      '.fin-period-summary strong { font-size: 13px; color: #fff; }',
      '.fin-period-summary span { font-size: 13px; color: var(--text-secondary); }',
      '.fin-status-details { font-size: 12px; color: var(--text-secondary); margin: 4px 0; }',
      '.fin-status-details summary { cursor: pointer; font-weight: 600; color: #c7b399; padding: 4px 0; }',
      '.fin-overview-hero { padding: 8px 4px; }',
      '.fin-overview-hero h2 { font-family: var(--font-display); font-size: 22px; font-weight: 800; margin: 0 0 4px; color: #fff; }',
      '.fin-overview-hero > p { font-size: 13px; color: var(--text-secondary); margin: 0 0 18px; }',
      '.fin-hero-label { font-size: 13px; color: var(--text-secondary); margin-bottom: 4px; }',
      '.fin-hero-amount { font-family: var(--font-display); font-size: 36px; font-weight: 800; color: #fff; margin: 0 0 16px; letter-spacing: -0.5px; }',
      '.fin-overview-lines { border-top: 1px solid rgba(255,255,255,0.08); display: flex; flex-direction: column; }',
      '.fin-overview-line { display: flex; justify-content: space-between; align-items: center; padding: 14px 0; border-bottom: 1px solid rgba(255,255,255,0.06); font-size: 14px; color: var(--text-secondary); cursor: pointer; }',
      '.fin-overview-line:hover { color: #fff; }',
      '.fin-overview-line strong { font-family: var(--font-display); font-size: 18px; font-weight: 700; color: #fff; }',
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
      '.ai-logo { width: 32px; height: 32px; border-radius: 50%; background: linear-gradient(135deg, #e8a535, #c8832a); display: flex; align-items: center; justify-content: center; font-size: 16px; color: #1a1008; }',
      '.ai-title { font-size: 15px; font-weight: 700; color: #f5ece0; }',
      '.ai-subtitle { font-size: 11px; color: var(--text-secondary); }',
      '.ai-msgs { flex: 1; overflow-y: auto; padding: 12px; display: flex; flex-direction: column; gap: 10px; }',
      '.ai-bubble { background: rgba(232,165,53,0.12); border-left: 3px solid #e8a535; border-radius: 0 8px 8px 0; padding: 10px 12px; font-size: 13px; color: rgba(255,255,255,0.9); line-height: 1.5; white-space: pre-line; }',
      '.user-bubble { background: rgba(255,255,255,0.08); border-radius: 8px 8px 0 8px; padding: 10px 12px; font-size: 13px; align-self: flex-end; max-width: 85%; }',
      '.ai-typing { display: flex; gap: 4px; padding: 8px 12px; align-items: center; }',
      '.ai-typing span { width: 7px; height: 7px; background: #e8a535; border-radius: 50%; animation: aidot 1.2s infinite; }',
      '.ai-typing span:nth-child(2) { animation-delay: 0.2s; }',
      '.ai-typing span:nth-child(3) { animation-delay: 0.4s; }',
      '@keyframes aidot { 0%,80%,100%{opacity:0.3;transform:scale(0.8)} 40%{opacity:1;transform:scale(1)} }',
      '.ai-input-row { display: flex; gap: 8px; padding: 12px; border-top: 1px solid rgba(255,255,255,0.08); }',
      '.ai-input-row input { flex: 1; background: rgba(255,255,255,0.07); border: 1px solid rgba(255,255,255,0.12); color: #fff; padding: 10px 14px; border-radius: 8px; font-size: 13px; outline: none; }',
      '.ai-input-row button { background: linear-gradient(135deg,#e8a535,#c8832a); color: #1a1008; border: none; padding: 0 16px; border-radius: 8px; cursor: pointer; font-weight: 800; font-size: 13px; }',
      '.ai-suggest-chips { display: flex; gap: 6px; flex-wrap: wrap; padding: 0 12px 8px; }',
      '.chip { background: rgba(232,165,53,0.15); border: 1px solid rgba(232,165,53,0.35); border-radius: 20px; padding: 4px 10px; font-size: 11px; cursor: pointer; color: #f5ece0; white-space: nowrap; }',
      '.chip:hover { background: rgba(232,165,53,0.3); }',
      '@media(max-width:768px){ .finance-shell{flex-direction:column;} .finance-right{min-width:unset;width:100%;height:440px;} .fin-period-card .mobile-filter-trigger { width: 100%; } }',
      '.fin-table th { padding: 10px 12px; border-bottom: 2px solid rgba(255,255,255,0.08); font-size: 11px; text-transform: uppercase; color: var(--text-secondary); }',
      '.fin-table td { padding: 12px; border-bottom: 1px solid rgba(255,255,255,0.05); }',
      '.fin-table tr:hover { background: rgba(255,255,255,0.02); }',
      '</style>',

      '<div class="finance-page">',
      '  <header class="fin-top-header">',
      '    <h1>Financials &amp; AI</h1>',
      '    <p>Review payments, sales and outstanding orders.</p>',
      '  </header>',

      '  <nav class="fin-nav-tabs" role="tablist" aria-label="Financials sections">',
      '    <button type="button" class="fin-nav-tab active" role="tab" aria-selected="true" data-fin-tab="overview">Overview</button>',
      '    <button type="button" class="fin-nav-tab" role="tab" aria-selected="false" data-fin-tab="payments">Payments</button>',
      '    <button type="button" class="fin-nav-tab" role="tab" aria-selected="false" data-fin-tab="sales">Sales &amp; staff</button>',
      '    <button type="button" class="fin-nav-tab" role="tab" aria-selected="false" data-fin-tab="unpaid">Unpaid orders</button>',
      '    <button type="button" class="fin-nav-tab" role="tab" aria-selected="false" data-fin-tab="invoices">Invoices</button>',
      '    <button type="button" class="fin-nav-tab" role="tab" aria-selected="false" data-fin-tab="ai">AI assistant</button>',
      '  </nav>',

      '  <div class="fin-period-card" id="fin-period-toolbar">',
      '    <div class="fin-period-summary">',
      '      <strong>Report period</strong>',
      '      <span id="fin-period-display">Today · Full day</span>',
      '    </div>',
      '    <div class="fin-date-bar">',
      '      <label>From:</label>',
      '      <input type="date" id="fin-start" />',
      '      <label>To:</label>',
      '      <input type="date" id="fin-end" />',
      '      <button class="fin-load-btn" id="fin-load-btn">Load Report</button>',
      '      <div class="fin-quick-ranges" role="group" aria-label="Quick report period">',
      '        <button type="button" class="fin-range-btn active" data-fin-range="today">Today</button>',
      '        <button type="button" class="fin-range-btn" data-fin-range="yesterday">Yesterday</button>',
      '        <button type="button" class="fin-range-btn" data-fin-range="week">Past week</button>',
      '        <button type="button" class="fin-range-btn" data-fin-range="month">Past month</button>',
      '      </div>',
      '      <div class="fin-quick-ranges" role="group" aria-label="Trading session">',
      '        <button type="button" class="fin-range-btn active" data-fin-session="full">Full day</button>',
      '        <button type="button" class="fin-range-btn" data-fin-session="morning">Morning</button>',
      '        <button type="button" class="fin-range-btn" data-fin-session="night">Night</button>',
      '      </div>',
      '    </div>',
      '  </div>',

      '  <details class="fin-status-details">',
      '    <summary id="fin-source-summary">Report up to date</summary>',
      '    <p id="fin-source" role="status" style="margin:6px 0 0;line-height:1.5;">Loading transaction records...</p>',
      '  </details>',

      '  <div class="finance-shell">',
      '    <div class="finance-left" id="fin-main-pane">',

      '      <section class="fin-overview-hero" data-fin-section="overview">',
      '        <h2>Overview</h2>',
      '        <p>The selected period at a glance.</p>',
      '        <div class="fin-hero-label">Payments received</div>',
      '        <div class="fin-hero-amount" id="fin-hero-collected">KES 0.00</div>',
      '        <div class="fin-overview-lines">',
      '          <div class="fin-overview-line" data-jump-tab="sales"><span>Sales after discounts</span><strong id="fin-hero-net">KES 0.00</strong></div>',
      '          <div class="fin-overview-line" data-jump-tab="unpaid"><span>Unpaid orders (tables &amp; tabs)</span><strong id="fin-hero-unpaid-orders" style="color:#ff9800;">KES 0.00</strong></div>',
      '          <div class="fin-overview-line" data-jump-tab="invoices"><span>Proforma invoices (outstanding)</span><strong id="fin-hero-unpaid-invoices">KES 0.00</strong></div>',
      '          <div class="fin-overview-line" data-jump-tab="payments"><span>Confirmed payments</span><strong id="fin-hero-payment-count">0</strong></div>',
      '        </div>',
      '      </section>',

      '      <div class="metrics-row" data-fin-section="overview,payments,sales">',
      '        <div class="m-card" data-fin-card="overview,payments"><h5>Payments Received</h5><p class="m-val" id="fin-collected">KES 0</p></div>',
      '        <div class="m-card green" data-fin-card="overview,payments"><h5>M-Pesa Received</h5><p class="m-val" id="fin-mpesa">KES 0</p><small id="fin-mpesa-held"></small></div>',
      '        <div class="m-card blue" data-fin-card="overview,payments"><h5>Cash Received</h5><p class="m-val" id="fin-cash">KES 0</p><small id="fin-cash-held"></small></div>',
      '        <div class="m-card green" data-fin-card="overview,payments"><h5>Bank Transfers</h5><p class="m-val" id="fin-bank">KES 0</p><small id="fin-bank-held">Statement references, unverified</small></div>',
      '        <div class="m-card" data-fin-card="overview,payments"><h5>Card &amp; Other</h5><p class="m-val" id="fin-other">KES 0</p><small id="fin-other-held"></small></div>',
      '        <div class="m-card blue" data-fin-card="overview,payments"><h5>Confirmed Payments</h5><p class="m-val" id="fin-payment-count">0</p></div>',
      '        <div class="m-card orange" data-fin-card="payments"><h5>Received Without Sale / Order</h5><p class="m-val" id="fin-unmatched">KES 0</p></div>',
      '        <div class="m-card" data-fin-card="payments"><h5>Failed / Cancelled Attempts</h5><p class="m-val" id="fin-failed">KES 0</p></div>',
      '        <div class="m-card orange" data-fin-card="payments"><h5>Received Without A Date</h5><p class="m-val" id="fin-undated">KES 0</p><small id="fin-undated-count">Not counted in any period</small></div>',
      '        <div class="m-card orange" data-fin-card="overview,payments"><h5>Held On A Till</h5><p class="m-val" id="fin-held">KES 0</p><small id="fin-held-count">Settled but not yet reached the business — not counted above</small></div>',
      '        <div class="m-card orange" data-fin-card="overview"><h5>Unpaid Orders (Tables &amp; Counter)</h5><p class="m-val" id="fin-pending">KES 0</p><small id="fin-pending-count">0 orders · unreceived</small></div>',
      '        <div class="m-card" data-fin-card="overview"><h5>Outstanding Proforma Invoices</h5><p class="m-val" id="fin-proforma-total">KES 0</p><small id="fin-proforma-count">0 invoices · locked</small></div>',
      '        <div class="m-card" data-fin-card="overview,sales"><h5>Gross Recorded Sales</h5><p class="m-val" id="fin-gross">KES 0</p></div>',
      '        <div class="m-card" data-fin-card="overview,sales"><h5>Total Discounts</h5><p class="m-val" id="fin-disc">KES 0</p></div>',
      '        <div class="m-card green" data-fin-card="overview,sales"><h5>Recorded Sales After Discounts</h5><p class="m-val" id="fin-net">KES 0</p></div>',
      '        <div class="m-card orange" data-fin-card="sales"><h5>Total Unreceived (Orders + Invoices)</h5><p class="m-val" id="fin-unpaid">KES 0</p><small>Awaiting reconciliation</small></div>',
      '        <div class="m-card orange" data-fin-card="overview,sales"><h5>Completed Sales</h5><p class="m-val" id="fin-count">0</p></div>',
      '      </div>',

      '      <div class="fin-card" data-fin-section="unpaid,overview">',
      '        <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px;margin-bottom:6px;">',
      '          <h3 style="margin:0;font-size:16px;color:#fff;">Unpaid orders (Tables, Tabs &amp; Counter)</h3>',
      '          <label style="display:inline-flex;align-items:center;gap:8px;font-size:12px;color:var(--accent-amber);font-weight:700;cursor:pointer;">',
      '            <input type="checkbox" id="fin-consolidate-tables" checked style="width:18px;height:18px;accent-color:#e8a535;" />',
      '            Consolidate bills by table for 1-payment settlement',
      '          </label>',
      '        </div>',
      '        <p style="margin:0 0 12px;color:var(--text-secondary);font-size:12px;">Active unpaid table tabs, customer orders, and counter bills (separated from formal Proforma Invoices). Consolidating by table groups all rounds under a table into one total bill so the cashier can settle the entire table in one payment.</p>',
      '        <div id="fin-unpaid-orders" style="overflow:auto"></div>',
      '      </div>',

      '      <div class="fin-card" data-fin-section="sales,overview">',
      '        <h3 style="margin:0 0 6px 0;font-size:15px;color:#fff;">👥 Staff rundown</h3>',
      '        <p style="margin:0 0 12px;color:var(--text-secondary);font-size:12px;">Everyone who handled money or an order in the selected period: what they completed, what they took, and what is still open against their name.</p>',
      '        <div style="overflow-x:auto;">',
      '          <table class="fin-table" style="width:100%; border-collapse:collapse; text-align:left; font-size:13px;">',
      '            <thead>',
      '              <tr>',
      '                <th>Staff member</th>',
      '                <th style="text-align:center;">Completed sales</th>',
      '                <th style="text-align:right;">Sales value</th>',
      '                <th style="text-align:center;">Payments</th>',
      '                <th style="text-align:right;">Received</th>',
      '                <th style="text-align:right;">Still unpaid</th>',
      '              </tr>',
      '            </thead>',
      '            <tbody id="cashier-report-body">',
      '              <tr>',
      '                <td colspan="6" style="padding:16px;text-align:center;color:var(--text-secondary);">No data loaded yet.</td>',
      '              </tr>',
      '            </tbody>',
      '          </table>',
      '        </div>',
      '      </div>',

      '      <div class="fin-card" id="fin-proformas" data-fin-section="invoices,overview"></div>',

      '      <div class="fin-card" data-fin-section="payments,overview"><h3>Payments &amp; transactions in selected period</h3><p style="color:var(--text-secondary);font-size:12px;margin:4px 0 12px;">Payments are filtered by receipt date. Failed and pending attempts are excluded from money received.</p><div id="fin-transactions" style="overflow:auto"></div></div>',
      '    </div>',

      '    <div class="finance-right" id="fin-ai-pane" data-fin-section="ai,overview">',
      '      <div class="ai-header">',
      '        <div class="ai-logo">✨</div>',
      '        <div><div class="ai-title">Vanbransa AI</div><div class="ai-subtitle">Financial Analytics Assistant</div></div>',
      '      </div>',
      '      <div class="ai-msgs" id="ai-msgs">',
      '        <div class="ai-bubble">Hello! I\'m your Vanbransa AI assistant. Load a date range and I\'ll analyze your financials. Ask about revenue, tenders, discounts, unpaid orders, or proforma invoices.</div>',
      '      </div>',
      '      <div class="ai-suggest-chips">',
      '        <div class="chip" data-q="performance">Performance</div>',
      '        <div class="chip" data-q="cash vs mpesa">Cash vs M-Pesa</div>',
      '        <div class="chip" data-q="discount">Discounts</div>',
      '        <div class="chip" data-q="unpaid and pending">Unpaid Orders</div>',
      '        <div class="chip" data-q="proforma invoices">Proforma Invoices</div>',
      '        <div class="chip" data-q="staff rundown">Staff</div>',
      '        <div class="chip" data-q="bank transfers">Bank</div>',
      '        <div class="chip" data-q="insight">Insights</div>',
      '      </div>',
      '      <div class="ai-input-row">',
      '        <input type="text" id="ai-inp" placeholder="Ask about your business..." />',
      '        <button id="ai-send">Ask</button>',
      '      </div>',
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
    this.applyFinTab('overview');
  }

  applyFinTab(tabId) {
    this.activeFinTab = tabId;
    this.container.querySelectorAll('[data-fin-tab]').forEach((btn) => {
      const active = btn.dataset.finTab === tabId;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-selected', String(active));
    });
    const mainPane = this.container.querySelector('#fin-main-pane');
    const aiPane = this.container.querySelector('#fin-ai-pane');
    if (mainPane) mainPane.style.display = tabId === 'ai' ? 'none' : 'flex';
    if (aiPane) {
      const isNarrow = typeof window !== 'undefined' && window.innerWidth <= 900;
      aiPane.style.display = (tabId === 'ai' || (!isNarrow && tabId === 'overview')) ? 'flex' : 'none';
      if (tabId === 'ai') aiPane.style.flex = '1 1 100%';
      else aiPane.style.flex = '1';
    }
    this.container.querySelectorAll('#fin-main-pane [data-fin-section]').forEach((sec) => {
      const allowed = sec.dataset.finSection.split(',');
      sec.style.display = allowed.includes(tabId) ? '' : 'none';
    });
    this.container.querySelectorAll('[data-fin-card]').forEach((card) => {
      const allowed = card.dataset.finCard.split(',');
      card.style.display = allowed.includes(tabId) ? '' : 'none';
    });
  }

  dispose() { this.disposed = true; this.loadRequest = (this.loadRequest || 0) + 1; this.proformaRegister?.dispose(); this.filterSheet?.dispose(); }

  bindEvents() {
    this.container.querySelectorAll('[data-fin-tab]').forEach((btn) => {
      btn.addEventListener('click', () => this.applyFinTab(btn.dataset.finTab));
    });
    this.container.querySelectorAll('[data-jump-tab]').forEach((row) => {
      row.addEventListener('click', () => this.applyFinTab(row.dataset.jumpTab));
    });
    const consolidateToggle = document.getElementById('fin-consolidate-tables');
    if (consolidateToggle) {
      consolidateToggle.addEventListener('change', (e) => {
        this.consolidateByTable = e.target.checked;
        this.renderUnpaidOrdersTable();
      });
    }
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
      const sessionLabel = session === 'morning' ? 'Morning' : session === 'night' ? 'Night' : 'Full day';
      const dateLabel = startStr === endStr ? startStr : `${startStr} – ${endStr}`;
      set('fin-period-display', `${dateLabel} · ${sessionLabel}`);
      set('fin-source-summary', report.outsideCount ? `Report up to date · ${report.outsideCount} outside window` : 'Report up to date');

      set('fin-hero-collected', fmt(collected));
      set('fin-hero-net', fmt(net));
      set('fin-hero-unpaid-orders', fmt(report.unpaidOrdersTotal ?? report.pending));
      set('fin-hero-unpaid-invoices', fmt(report.proformaOutstanding ?? 0));
      set('fin-hero-payment-count', report.paymentCount);

      set('fin-pending', fmt(report.unpaidOrdersTotal ?? report.pending));
      const ordersCount = report.unpaidOrdersCount ?? report.pendingCount;
      set('fin-pending-count', `${ordersCount} ${ordersCount === 1 ? 'order' : 'orders'} · unreceived`);
      set('fin-proforma-total', fmt(report.proformaOutstanding ?? 0));
      const pfCount = report.proformaCount ?? 0;
      set('fin-proforma-count', `${pfCount} ${pfCount === 1 ? 'invoice' : 'invoices'} · locked`);
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

      this.staffNameResolver = staffName;
      this.currentMetrics = { ...report, startStr, endStr, session };
      this.renderUnpaidOrdersTable();

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

      this.addAIMsg(financialAnswer(this.currentMetrics));

    } catch (err) {
      if (request !== this.loadRequest) return;
      this.currentMetrics = null;
      document.getElementById('fin-source').textContent = 'Report failed to load. Reload before using these figures.';
      console.error('Finance load error:', err);
      showNotification('Error loading financial data', 'error');
    }
  }

  renderUnpaidOrdersTable() {
    const unpaidOrdersEl = document.getElementById('fin-unpaid-orders');
    if (!unpaidOrdersEl || !this.currentMetrics) return;
    const report = this.currentMetrics;
    const escape = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
    const fmt = v => 'KES ' + Number(v || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const staffName = this.staffNameResolver || (r => r.staff_id || 'Unassigned');

    const rows = this.consolidateByTable
      ? (report.consolidatedUnpaidOrders || report.unpaidOrdersOnly || [])
      : (report.unpaidOrdersOnly || report.unpaidOrders?.filter(o => o.source !== 'proforma') || []);

    unpaidOrdersEl.innerHTML = '<table class="fin-table" style="width:100%;border-collapse:collapse;text-align:left;font-size:13px;">'
      + '<thead><tr><th>Raised</th><th>Table / Order Ref</th><th>Source</th><th>Staff</th><th>Branch</th><th style="text-align:right">Total Due</th><th>Action</th></tr></thead><tbody>'
      + rows.map(order => {
        const isConsolidated = (order.roundCount || 1) > 1;
        const tableBadge = order.table_no
          ? `<span style="display:inline-block;background:rgba(232,165,53,0.18);color:#e8a535;border:1px solid rgba(232,165,53,0.4);padding:2px 8px;border-radius:12px;font-size:11px;font-weight:800;margin-right:6px;">Table ${escape(order.table_no)}</span>`
          : '';
        const refLabel = isConsolidated
          ? `${tableBadge}<b>${order.roundCount} bills consolidated</b><br><small style="color:var(--text-secondary)">${escape((order.references || [order.reference]).join(', '))}</small>`
          : `${tableBadge}${escape(order.reference)}${order.customer_name ? `<br><small style="color:var(--text-secondary)">${escape(order.customer_name)}</small>` : ''}`;
        const sourceLabel = isConsolidated
          ? `Consolidated Table Bill (${order.roundCount} rounds)`
          : (order.source === 'customer_order' ? 'Customer QR order' : 'Till / Tab order');
        const actionHref = `/orders?order=${encodeURIComponent(order.reference)}`;
        const actionText = isConsolidated ? 'Consolidate &amp; Pay Table' : 'Pay / Reconcile';
        return '<tr>'
          + '<td>' + escape(order.invoice_date || new Date(timestamp(order.placed_at)).toLocaleString()) + '</td>'
          + '<td>' + refLabel + '</td>'
          + '<td>' + escape(sourceLabel) + '</td>'
          + '<td>' + escape(order.staff_id ? staffName(order) : 'Unassigned') + '</td>'
          + '<td>' + escape(order.branch_id || '—') + '</td>'
          + '<td style="text-align:right;font-weight:700;color:#ff9800;">' + fmt(order.amount) + '</td>'
          + '<td><a class="fin-reconcile" href="' + actionHref + '">' + actionText + '</a></td>'
          + '</tr>';
      }).join('')
      + (rows.length ? '' : '<tr><td colspan="7" style="text-align:center;color:var(--text-secondary);padding:16px;">No unpaid table or counter orders in this period. Formal proforma invoices are listed separately under the Invoices tab.</td></tr>')
      + '</tbody></table>';
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
