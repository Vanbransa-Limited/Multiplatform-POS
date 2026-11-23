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
      '.finance-page { display: flex; flex-direction: column; gap: 18px; padding: 20px 24px 32px; box-sizing: border-box; max-width: 1680px; margin: 0 auto; width: 100%; background: #070807; color: #f3f4f6; font-family: var(--font-main, -apple-system, BlinkMacSystemFont, sans-serif); min-height: calc(100vh - 60px); }',
      /* Top Header Bar matching Image 1 */
      '.fin-topbar { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 14px; padding-bottom: 4px; }',
      '.fin-brand-row { display: flex; align-items: center; gap: 12px; }',
      '.fin-brand-row h1 { margin: 0; font-size: 26px; font-weight: 800; color: #ffffff; letter-spacing: -0.5px; }',
      '.fin-live-pill { background: #53b74c; color: #041606; font-size: 11px; font-weight: 800; padding: 3px 11px; border-radius: 999px; letter-spacing: 0.2px; display: inline-flex; align-items: center; gap: 5px; }',
      '.fin-live-pill::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: #041606; display: inline-block; }',
      '.fin-topbar-controls { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }',
      '.fin-pill-box { background: #141514; border: 1px solid rgba(255,255,255,0.08); border-radius: 12px; padding: 6px 12px; display: inline-flex; align-items: center; gap: 8px; font-size: 13px; color: #e5e7eb; }',
      '.fin-pill-box input[type=date] { background: transparent; border: none; color: #fff; font-size: 12px; font-weight: 600; outline: none; cursor: pointer; padding: 2px 4px; }',
      '.fin-pill-box select { background: transparent; border: none; color: #fff; font-size: 12px; font-weight: 600; outline: none; cursor: pointer; }',
      /* Clean Pill Navigation Tabs */
      '.fin-nav-row { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 12px; border-bottom: 1px solid rgba(255,255,255,0.07); padding-bottom: 12px; }',
      '.fin-nav-tabs { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }',
      '.fin-nav-tab { background: #121312; border: 1px solid rgba(255,255,255,0.06); color: #9ca3af; font-size: 13px; font-weight: 600; padding: 9px 16px; border-radius: 999px; cursor: pointer; transition: all 0.18s ease; display: inline-flex; align-items: center; gap: 6px; min-height: 38px; }',
      '.fin-nav-tab:hover { color: #ffffff; background: #1a1c1a; border-color: rgba(255,255,255,0.14); }',
      '.fin-nav-tab.active { background: #134e32; color: #ffffff; border-color: rgba(83,183,76,0.45); font-weight: 700; box-shadow: 0 4px 16px rgba(19,78,50,0.35); }',
      '.fin-nav-tab[data-fin-tab="ai"].active { background: linear-gradient(135deg, #134e32 0%, #1d6b44 100%); }',
      '.fin-quick-ranges { display: inline-flex; align-items: center; gap: 4px; background: #121312; padding: 4px; border-radius: 999px; border: 1px solid rgba(255,255,255,0.06); }',
      '.fin-range-btn { background: transparent; color: #9ca3af; border: none; padding: 6px 12px; border-radius: 999px; cursor: pointer; font-size: 12px; font-weight: 600; transition: all 0.15s; }',
      '.fin-range-btn:hover { color: #fff; }',
      '.fin-range-btn.active { background: #262826; color: #fff; font-weight: 700; }',
      /* Bento KPI Row matching Image 2 */
      '.fin-bento-grid { display: grid; grid-template-columns: repeat(4, minmax(170px, 1fr)) minmax(280px, 1.3fr); gap: 14px; align-items: stretch; }',
      '@media(max-width: 1280px) { .fin-bento-grid { grid-template-columns: repeat(2, 1fr); } .fin-bento-side { grid-column: span 2; } }',
      '@media(max-width: 640px) { .fin-bento-grid { grid-template-columns: 1fr; } .fin-bento-side { grid-column: span 1; } }',
      '.fin-kpi-card { background: #121312; border: 1px solid rgba(255,255,255,0.05); border-radius: 22px; padding: 22px 24px; display: flex; flex-direction: column; justify-content: space-between; min-height: 148px; cursor: pointer; transition: transform 0.15s ease, border-color 0.15s ease; }',
      '.fin-kpi-card:hover { transform: translateY(-2px); border-color: rgba(255,255,255,0.14); }',
      '.fin-kpi-card.emerald { background: linear-gradient(145deg, #134e32 0%, #0d3622 100%); border-color: rgba(83,183,76,0.22); }',
      '.fin-kpi-top { display: flex; align-items: center; justify-content: space-between; gap: 8px; }',
      '.fin-kpi-label { font-size: 14px; font-weight: 500; color: rgba(255,255,255,0.72); }',
      '.fin-kpi-icon { width: 34px; height: 34px; border-radius: 50%; background: rgba(0,0,0,0.32); display: inline-flex; align-items: center; justify-content: center; font-size: 14px; color: rgba(255,255,255,0.85); flex-shrink: 0; }',
      '.fin-kpi-value { font-size: 34px; font-weight: 800; color: #ffffff; letter-spacing: -1px; margin: 14px 0 2px; line-height: 1.05; }',
      '.fin-kpi-sub { font-size: 12px; color: rgba(255,255,255,0.55); font-weight: 500; }',
      /* Right Bento Card: Latest Unpaid / Sessions with green View All pill */
      '.fin-bento-side { background: #121312; border: 1px solid rgba(255,255,255,0.05); border-radius: 22px; padding: 18px 20px; display: flex; flex-direction: column; justify-content: space-between; gap: 12px; }',
      '.fin-side-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }',
      '.fin-side-head h3 { margin: 0; font-size: 16px; font-weight: 700; color: #ffffff; }',
      '.fin-view-all-btn { background: #65a34e; color: #071908; border: none; border-radius: 999px; padding: 6px 14px; font-size: 12px; font-weight: 800; cursor: pointer; transition: filter 0.15s; }',
      '.fin-view-all-btn:hover { filter: brightness(1.1); }',
      '.fin-side-list { background: #0a0b0a; border-radius: 16px; padding: 6px 14px; display: flex; flex-direction: column; flex: 1; justify-content: center; }',
      '.fin-side-item { display: grid; grid-template-columns: 1.2fr 0.9fr auto; align-items: center; gap: 8px; padding: 9px 0; border-bottom: 1px solid rgba(255,255,255,0.05); font-size: 12px; }',
      '.fin-side-item:last-child { border-bottom: none; }',
      '.fin-side-ref { font-weight: 700; color: #ffffff; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }',
      '.fin-side-time { color: #9ca3af; font-size: 11px; text-align: center; }',
      '.fin-side-amt { color: #e5e7eb; font-weight: 600; text-align: right; text-decoration: none; }',
      /* Main Table Card matching Image 1 */
      '.fin-surface-card { background: #101110; border: 1px solid rgba(255,255,255,0.06); border-radius: 22px; padding: 24px 26px; display: flex; flex-direction: column; gap: 16px; }',
      '.fin-surface-header { display: flex; align-items: flex-start; justify-content: space-between; flex-wrap: wrap; gap: 16px; }',
      '.fin-surface-title h2 { margin: 0; font-size: 20px; font-weight: 700; color: #ffffff; letter-spacing: -0.3px; }',
      '.fin-surface-title p { margin: 5px 0 0; font-size: 12px; color: #8a8f8c; }',
      '.fin-surface-actions { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }',
      '.fin-search-box { background: #171817; border: 1px solid rgba(255,255,255,0.08); border-radius: 12px; padding: 8px 14px; display: inline-flex; align-items: center; gap: 8px; min-width: 230px; }',
      '.fin-search-box input { background: transparent; border: none; color: #fff; font-size: 13px; outline: none; width: 100%; }',
      '.fin-search-box input::placeholder { color: #6b7280; }',
      '.fin-dark-btn { background: #1c1e1c; border: 1px solid rgba(255,255,255,0.09); color: #e5e7eb; border-radius: 10px; padding: 9px 15px; font-size: 12px; font-weight: 600; cursor: pointer; transition: background 0.15s; }',
      '.fin-dark-btn:hover { background: #272a27; color: #fff; }',
      '.fin-tender-summary { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; font-size: 13px; color: #d1d5db; font-weight: 600; }',
      '.fin-tender-pill { background: #171817; border: 1px solid rgba(255,255,255,0.06); padding: 7px 12px; border-radius: 10px; display: inline-flex; align-items: center; gap: 6px; }',
      /* Clean Minimalist Table matching Image 1 */
      '.fin-clean-table { width: 100%; border-collapse: collapse; text-align: left; font-size: 13px; }',
      '.fin-clean-table thead tr { background: #1c1d1c; }',
      '.fin-clean-table th { padding: 12px 16px; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.6px; color: #9ca3af; border: none; }',
      '.fin-clean-table th:first-child { border-radius: 8px 0 0 8px; }',
      '.fin-clean-table th:last-child { border-radius: 0 8px 8px 0; }',
      '.fin-clean-table td { padding: 15px 16px; border-bottom: 1px solid rgba(255,255,255,0.05); color: #d1d5db; vertical-align: middle; }',
      '.fin-clean-table tbody tr:hover { background: rgba(255,255,255,0.025); }',
      '.fin-ref-code { font-weight: 700; color: #ffffff; letter-spacing: 0.2px; }',
      '.fin-mode-label { font-size: 12px; color: #d1d5db; text-transform: lowercase; font-weight: 600; }',
      '.fin-reconcile { color: #051b07; background: #53b74c; padding: 7px 13px; border-radius: 999px; text-decoration: none; font-size: 12px; font-weight: 800; white-space: nowrap; display: inline-block; transition: filter 0.15s; }',
      '.fin-reconcile:hover { filter: brightness(1.1); }',
      /* Simple & Easy-to-Use AI Assistant Bar & Panel */
      '.fin-ai-strip { background: linear-gradient(145deg, #111914 0%, #0e120f 100%); border: 1px solid rgba(83,183,76,0.22); border-radius: 20px; padding: 16px 20px; display: flex; flex-direction: column; gap: 12px; }',
      '.fin-ai-strip-top { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 12px; }',
      '.fin-ai-badge { display: inline-flex; align-items: center; gap: 10px; }',
      '.fin-ai-icon { width: 34px; height: 34px; border-radius: 50%; background: #134e32; color: #53b74c; display: inline-flex; align-items: center; justify-content: center; font-size: 16px; font-weight: 800; }',
      '.fin-ai-chips { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }',
      '.chip { background: #18221b; border: 1px solid rgba(83,183,76,0.28); border-radius: 999px; padding: 6px 13px; font-size: 12px; font-weight: 600; cursor: pointer; color: #d1fae5; white-space: nowrap; transition: all 0.15s; }',
      '.chip:hover { background: #134e32; color: #fff; }',
      '.fin-ai-prompt-row { display: flex; gap: 10px; align-items: center; }',
      '.fin-ai-prompt-row input { flex: 1; background: #0a0c0a; border: 1px solid rgba(255,255,255,0.09); color: #fff; padding: 11px 16px; border-radius: 12px; font-size: 13px; outline: none; }',
      '.fin-ai-prompt-row input:focus { border-color: #53b74c; }',
      '.fin-ai-prompt-row button { background: #53b74c; color: #041606; border: none; padding: 11px 20px; border-radius: 12px; cursor: pointer; font-weight: 800; font-size: 13px; }',
      '.ai-msgs { max-height: 280px; overflow-y: auto; display: flex; flex-direction: column; gap: 10px; padding-right: 4px; }',
      '.ai-bubble { background: rgba(19,78,50,0.28); border-left: 3px solid #53b74c; border-radius: 0 12px 12px 0; padding: 12px 14px; font-size: 13px; color: #ecfdf5; line-height: 1.55; white-space: pre-line; }',
      '.user-bubble { background: #1f2421; border-radius: 12px 12px 0 12px; padding: 10px 14px; font-size: 13px; color: #fff; align-self: flex-end; max-width: 85%; }',
      '.ai-typing { display: flex; gap: 4px; padding: 8px 12px; align-items: center; }',
      '.ai-typing span { width: 7px; height: 7px; background: #53b74c; border-radius: 50%; animation: aidot 1.2s infinite; }',
      '.ai-typing span:nth-child(2) { animation-delay: 0.2s; }',
      '.ai-typing span:nth-child(3) { animation-delay: 0.4s; }',
      '@keyframes aidot { 0%,80%,100%{opacity:0.3;transform:scale(0.8)} 40%{opacity:1;transform:scale(1)} }',
      '</style>',

      '<div class="finance-page">',
      /* Top Bar matching Image 1 */
      '  <header class="fin-topbar">',
      '    <div class="fin-brand-row">',
      '      <h1 id="fin-page-heading">Payments &amp; Finance</h1>',
      '      <span class="fin-live-pill">Live</span>',
      '    </div>',
      '    <div class="fin-topbar-controls" id="fin-period-toolbar">',
      '      <div class="fin-date-bar" style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">',
      '        <div class="fin-pill-box">',
      '          <span>📅</span>',
      '          <input type="date" id="fin-start" aria-label="Start date" />',
      '          <span style="color:#6b7280;">—</span>',
      '          <input type="date" id="fin-end" aria-label="End date" />',
      '        </div>',
      '        <div class="fin-pill-box">',
      '          <select id="fin-session-select" aria-label="Trading session">',
      '            <option value="full">All Hours (Full Day)</option>',
      '            <option value="morning">Day Session</option>',
      '            <option value="night">Night Session</option>',
      '          </select>',
      '        </div>',
      '        <button type="button" class="fin-dark-btn" id="fin-load-btn">Refresh</button>',
      '        <div style="display:none;">',
      '          <button type="button" data-fin-session="full" class="active">Full</button>',
      '          <button type="button" data-fin-session="morning">Morning</button>',
      '          <button type="button" data-fin-session="night">Night</button>',
      '        </div>',
      '      </div>',
      '    </div>',
      '  </header>',

      /* Navigation Tabs + Quick Date Pills */
      '  <div class="fin-nav-row">',
      '    <nav class="fin-nav-tabs" role="tablist" aria-label="Finance & AI views">',
      '      <button type="button" class="fin-nav-tab active" role="tab" aria-selected="true" data-fin-tab="overview">Overview</button>',
      '      <button type="button" class="fin-nav-tab" role="tab" aria-selected="false" data-fin-tab="payments">Payments</button>',
      '      <button type="button" class="fin-nav-tab" role="tab" aria-selected="false" data-fin-tab="unpaid">Unpaid Table Bills</button>',
      '      <button type="button" class="fin-nav-tab" role="tab" aria-selected="false" data-fin-tab="invoices">Proforma Invoices</button>',
      '      <button type="button" class="fin-nav-tab" role="tab" aria-selected="false" data-fin-tab="sales">Sales &amp; Staff</button>',
      '      <button type="button" class="fin-nav-tab" role="tab" aria-selected="false" data-fin-tab="ai">✨ AI Assistant</button>',
      '    </nav>',
      '    <div class="fin-quick-ranges" role="group" aria-label="Quick report period">',
      '      <button type="button" class="fin-range-btn active" data-fin-range="today">Today</button>',
      '      <button type="button" class="fin-range-btn" data-fin-range="yesterday">Yesterday</button>',
      '      <button type="button" class="fin-range-btn" data-fin-range="week">Past Week</button>',
      '      <button type="button" class="fin-range-btn" data-fin-range="month">Past Month</button>',
      '    </div>',
      '  </div>',

      /* Top Bento KPI Cards Row matching Image 2 */
      '  <section class="fin-bento-grid" data-fin-section="overview,payments,sales,unpaid">',
      '    <div class="fin-kpi-card emerald" data-jump-tab="payments">',
      '      <div class="fin-kpi-top"><span class="fin-kpi-label">Collected</span><span class="fin-kpi-icon">↗</span></div>',
      '      <div>',
      '        <div class="fin-kpi-value" id="fin-hero-collected">0</div>',
      '        <div class="fin-kpi-sub"><span id="fin-payment-count">0</span> confirmed payments (KES)</div>',
      '      </div>',
      '    </div>',
      '    <div class="fin-kpi-card" data-jump-tab="sales">',
      '      <div class="fin-kpi-top"><span class="fin-kpi-label">Net Sales</span><span class="fin-kpi-icon">↗</span></div>',
      '      <div>',
      '        <div class="fin-kpi-value" id="fin-hero-net">0</div>',
      '        <div class="fin-kpi-sub"><span id="fin-count">0</span> completed orders · disc <span id="fin-disc">KES 0</span></div>',
      '      </div>',
      '    </div>',
      '    <div class="fin-kpi-card" data-jump-tab="unpaid">',
      '      <div class="fin-kpi-top"><span class="fin-kpi-label">Unpaid Bills</span><span class="fin-kpi-icon">🍽️</span></div>',
      '      <div>',
      '        <div class="fin-kpi-value" id="fin-hero-unpaid-orders">0</div>',
      '        <div class="fin-kpi-sub" id="fin-pending-count">0 table / counter bills</div>',
      '      </div>',
      '    </div>',
      '    <div class="fin-kpi-card" data-jump-tab="invoices">',
      '      <div class="fin-kpi-top"><span class="fin-kpi-label">Invoices</span><span class="fin-kpi-icon">📄</span></div>',
      '      <div>',
      '        <div class="fin-kpi-value" id="fin-hero-unpaid-invoices">0</div>',
      '        <div class="fin-kpi-sub" id="fin-proforma-count">0 proforma invoices</div>',
      '      </div>',
      '    </div>',
      '    <div class="fin-bento-side">',
      '      <div class="fin-side-head">',
      '        <h3>Latest Unpaid Bills</h3>',
      '        <button type="button" class="fin-view-all-btn" data-jump-tab="unpaid">View All</button>',
      '      </div>',
      '      <div class="fin-side-list" id="fin-latest-unpaid-list">',
      '        <div style="color:#6b7280;font-size:12px;text-align:center;padding:14px 0;">No unpaid table bills right now.</div>',
      '      </div>',
      '    </div>',
      '  </section>',

      /* Simple & Easy-to-Use AI Assistant Section */
      '  <section class="fin-ai-strip" id="fin-ai-pane" data-fin-section="overview,ai">',
      '    <div class="fin-ai-strip-top">',
      '      <div class="fin-ai-badge">',
      '        <span class="fin-ai-icon">✨</span>',
      '        <div>',
      '          <div style="font-weight:700;font-size:15px;color:#fff;">Finance &amp; AI Assistant</div>',
      '          <div style="font-size:12px;color:#8a8f8c;" id="fin-source">Instant summary of collections, M-Pesa vs cash, unpaid table tabs, and staff performance.</div>',
      '        </div>',
      '      </div>',
      '      <div class="fin-ai-chips">',
      '        <button type="button" class="chip" data-q="performance">📊 Summary</button>',
      '        <button type="button" class="chip" data-q="cash vs mpesa">💳 Cash vs M-Pesa</button>',
      '        <button type="button" class="chip" data-q="unpaid and pending">🍽️ Unpaid Tables</button>',
      '        <button type="button" class="chip" data-q="proforma invoices">📄 Invoices</button>',
      '        <button type="button" class="chip" data-q="staff rundown">👥 Staff</button>',
      '        <button type="button" class="chip" data-q="discount">🏷️ Discounts</button>',
      '      </div>',
      '    </div>',
      '    <div class="ai-msgs" id="ai-msgs">',
      '      <div class="ai-bubble">Loading your live financial snapshot…</div>',
      '    </div>',
      '    <div class="fin-ai-prompt-row">',
      '      <input type="text" id="ai-inp" placeholder="Ask anything about today\'s collections, M-Pesa, unpaid tables, or staff..." />',
      '      <button type="button" id="ai-send">Ask AI</button>',
      '    </div>',
      '  </section>',

      /* Main Content Stack */
      '  <div id="fin-main-pane" style="display:flex;flex-direction:column;gap:18px;">',

      /* Payment Transactions Card matching Image 1 */
      '    <section class="fin-surface-card" data-fin-section="overview,payments">',
      '      <div class="fin-surface-header">',
      '        <div class="fin-surface-title">',
      '          <h2>Payment Transactions (<span id="fin-collected">0 KES</span>)</h2>',
      '          <p>Date-range totals · <span id="fin-period-display">Today</span></p>',
      '        </div>',
      '        <div class="fin-surface-actions">',
      '          <div class="fin-search-box">',
      '            <span>🔍</span>',
      '            <input type="search" id="fin-tx-search" placeholder="Search reference, customer or mode" aria-label="Search payment transactions" />',
      '          </div>',
      '          <button type="button" class="fin-dark-btn" id="fin-tx-refresh">Refresh</button>',
      '          <div class="fin-tender-summary">',
      '            <span class="fin-tender-pill">M-Pesa: <strong id="fin-mpesa" style="color:#53b74c;">0 KES</strong></span>',
      '            <span class="fin-tender-pill">Cash: <strong id="fin-cash" style="color:#fff;">0 KES</strong></span>',
      '            <span class="fin-tender-pill">Bank: <strong id="fin-bank" style="color:#fff;">0 KES</strong></span>',
      '            <span class="fin-tender-pill">Card: <strong id="fin-other" style="color:#fff;">0 KES</strong></span>',
      '          </div>',
      '        </div>',
      '      </div>',
      '      <div id="fin-transactions" style="overflow-x:auto;"></div>',
      '    </section>',

      /* Unpaid Table Bills Card (Consolidated by Table, separated from Invoices) */
      '    <section class="fin-surface-card" data-fin-section="overview,unpaid">',
      '      <div class="fin-surface-header">',
      '        <div class="fin-surface-title">',
      '          <h2>Unpaid Orders &amp; Table Bills (<span id="fin-pending">0 KES</span>)</h2>',
      '          <p>Active table tabs and counter orders (separated from Proforma Invoices). All bills under a table consolidate into one payment.</p>',
      '        </div>',
      '        <div class="fin-surface-actions">',
      '          <label class="fin-tender-pill" style="cursor:pointer;">',
      '            <input type="checkbox" id="fin-consolidate-tables" checked style="width:16px;height:16px;accent-color:#53b74c;" />',
      '            <span>Consolidate bills under each table into 1 bill</span>',
      '          </label>',
      '        </div>',
      '      </div>',
      '      <div id="fin-unpaid-orders" style="overflow-x:auto;"></div>',
      '    </section>',

      /* Proforma Invoices Card (Separated from Unpaid Table Orders) */
      '    <section class="fin-surface-card" id="fin-proformas" data-fin-section="invoices"></section>',

      /* Staff & Sales Card */
      '    <section class="fin-surface-card" data-fin-section="sales">',
      '      <div class="fin-surface-header">',
      '        <div class="fin-surface-title">',
      '          <h2>Sales &amp; Staff Performance (<span id="fin-net">0 KES</span>)</h2>',
      '          <p>Gross sales: <strong id="fin-gross">0 KES</strong> · Unreceived total: <strong id="fin-unpaid">0 KES</strong></p>',
      '        </div>',
      '      </div>',
      '      <div style="overflow-x:auto;">',
      '        <table class="fin-clean-table">',
      '          <thead>',
      '            <tr>',
      '              <th>STAFF MEMBER</th>',
      '              <th>COMPLETED ORDERS</th>',
      '              <th>SALES VALUE</th>',
      '              <th>PAYMENTS TAKEN</th>',
      '              <th>COLLECTED</th>',
      '              <th>UNPAID TABS</th>',
      '            </tr>',
      '          </thead>',
      '          <tbody id="cashier-report-body">',
      '            <tr><td colspan="6" style="text-align:center;color:#6b7280;padding:20px;">No staff activity in this date range.</td></tr>',
      '          </tbody>',
      '        </table>',
      '      </div>',
      '    </section>',

      /* Hidden diagnostic hooks preserved for compatibility */
      '    <div style="display:none;">',
      '      <span id="fin-source-summary"></span><span id="fin-hero-payment-count"></span>',
      '      <span id="fin-unmatched"></span><span id="fin-failed"></span><span id="fin-undated"></span><span id="fin-undated-count"></span>',
      '      <span id="fin-held"></span><span id="fin-held-count"></span><span id="fin-proforma-total"></span>',
      '      <span id="fin-mpesa-held"></span><span id="fin-cash-held"></span><span id="fin-bank-held"></span><span id="fin-other-held"></span>',
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
    const titles = {
      overview: 'Payments & Finance',
      payments: 'Payments',
      unpaid: 'Unpaid Table Bills',
      invoices: 'Proforma Invoices',
      sales: 'Sales & Staff',
      ai: 'Finance & AI Assistant',
    };
    const heading = this.container.querySelector('#fin-page-heading');
    if (heading) heading.textContent = titles[tabId] || 'Payments & Finance';

    this.container.querySelectorAll('[data-fin-tab]').forEach((btn) => {
      const active = btn.dataset.finTab === tabId;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-selected', String(active));
    });
    const mainPane = this.container.querySelector('#fin-main-pane');
    if (mainPane) mainPane.style.display = tabId === 'ai' ? 'none' : 'flex';

    this.container.querySelectorAll('[data-fin-section]').forEach((sec) => {
      const allowed = sec.dataset.finSection.split(',');
      sec.style.display = allowed.includes(tabId) ? '' : 'none';
    });
    const aiMsgs = this.container.querySelector('#ai-msgs');
    if (aiMsgs) {
      aiMsgs.style.maxHeight = tabId === 'ai' ? '520px' : '180px';
    }
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
    const txSearch = document.getElementById('fin-tx-search');
    if (txSearch) {
      txSearch.addEventListener('input', (e) => {
        this.txSearchQuery = e.target.value.trim().toLowerCase();
        this.renderTransactionsTable();
      });
    }
    const loadBtn = document.getElementById('fin-load-btn');
    if (loadBtn) loadBtn.addEventListener('click', () => this.loadMetrics());
    const txRefresh = document.getElementById('fin-tx-refresh');
    if (txRefresh) txRefresh.addEventListener('click', () => this.loadMetrics());

    const sessionSelect = document.getElementById('fin-session-select');
    if (sessionSelect) {
      sessionSelect.addEventListener('change', (e) => {
        this.session = e.target.value;
        void this.loadMetrics();
      });
    }

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
        void this.loadMetrics();
      });
    }

    document.querySelectorAll('[data-fin-session]').forEach((button) => {
      button.addEventListener('click', () => {
        this.session = button.dataset.finSession;
        if (sessionSelect) sessionSelect.value = this.session;
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
    const session = this.session || 'full';
    const { from: startTs, to: endTs } = tradingRange(startStr, endStr, session, this.hours);

    try {
      void pullStaff().catch(() => null);
      const report = await loadFinancialSnapshot(startTs, endTs, session);
      const { sales, transactions, gross, discounts, net, cash, mpesa, other, collected } = report;
      const [users, shifts] = await Promise.all([db.users.toArray(), db.shifts.toArray()]);
      const userMap = new Map(users.map(u => [u.id, u]));
      const shiftUserMap = new Map(shifts.map(sh => [sh.id, userMap.get(sh.user_id)]));
      const staffName = row => userMap.get(row.staff_id)?.name || shiftUserMap.get(row.shift_id)?.name || row.staff_id || 'Staff';
      report.staffRundown = report.staffRundown.map(row => ({ ...row, name: staffName(row) }));
      const fmtInt = v => Math.round(Number(v || 0)).toLocaleString();
      const fmtKes = v => `${Math.round(Number(v || 0)).toLocaleString()} KES`;

      if (request !== this.loadRequest) return;
      const escape = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
      const set = (id, val) => {
        const el = document.getElementById(id);
        if (el) el.innerText = val;
      };

      this.dataSource = report.dataSource;
      const hh = (hour) => `${String(hour).padStart(2, '0')}:00`;
      const dayAt = hh(report.dayStartHour);
      const nightAt = hh(report.nightStartHour);
      const sessionNote = session === 'morning' ? ` · Day (${dayAt}–${nightAt})`
        : session === 'night' ? ` · Night (${nightAt}–${dayAt})`
          : ` · Trading day (${dayAt}–${dayAt})`;
      set('fin-source', `${report.dataSource}${sessionNote}`);

      set('fin-payment-count', report.paymentCount);
      set('fin-period-display', `${startStr} — ${endStr}`);

      /* Bento KPI numbers matching Image 2 */
      set('fin-hero-collected', fmtInt(collected));
      set('fin-hero-net', fmtInt(net));
      set('fin-hero-unpaid-orders', fmtInt(report.unpaidOrdersTotal ?? report.pending));
      set('fin-hero-unpaid-invoices', fmtInt(report.proformaOutstanding ?? 0));
      set('fin-hero-payment-count', report.paymentCount);

      set('fin-pending', fmtKes(report.unpaidOrdersTotal ?? report.pending));
      const ordersCount = report.unpaidOrdersCount ?? report.pendingCount;
      set('fin-pending-count', `${ordersCount} ${ordersCount === 1 ? 'bill' : 'bills'} · tap to consolidate & pay`);
      set('fin-proforma-total', fmtKes(report.proformaOutstanding ?? 0));
      const pfCount = report.proformaCount ?? 0;
      set('fin-proforma-count', `${pfCount} ${pfCount === 1 ? 'invoice' : 'invoices'} · event proformas`);
      set('fin-gross', fmtKes(gross));
      set('fin-disc', fmtKes(discounts));
      set('fin-net', fmtKes(net));
      set('fin-cash', fmtKes(cash));
      set('fin-mpesa', fmtKes(mpesa));
      set('fin-bank', fmtKes(report.bank));
      set('fin-other', fmtKes(other));
      set('fin-collected', fmtKes(collected));
      set('fin-unpaid', fmtKes(report.unpaid));
      set('fin-count', sales.length);

      this.staffNameResolver = staffName;
      this.currentMetrics = { ...report, startStr, endStr, session };
      this.renderTransactionsTable();
      this.renderUnpaidOrdersTable();
      this.renderLatestUnpaidSideCard();

      // Render the staff rundown
      const reportBody = document.getElementById('cashier-report-body');
      if (reportBody) {
        const rows = report.staffRundown;
        if (rows.length === 0) {
          reportBody.innerHTML = '<tr><td colspan="6" style="padding:20px;text-align:center;color:#6b7280;">No staff sales or payments recorded in this date range.</td></tr>';
        } else {
          reportBody.innerHTML = rows.map(row => `
            <tr>
              <td class="fin-ref-code">${escape(row.name)}</td>
              <td>${row.salesCount}</td>
              <td>${fmtKes(row.sales)}</td>
              <td>${row.receivedCount}</td>
              <td style="font-weight:700;color:#53b74c;">${fmtKes(row.received)}</td>
              <td style="color:${row.unpaid > 0 ? '#f59e0b' : '#9ca3af'};">${fmtKes(row.unpaid)}${row.unpaidCount ? ` (${row.unpaidCount})` : ''}</td>
            </tr>
          `).join('');
        }
      }

      const aiMsgs = document.getElementById('ai-msgs');
      if (aiMsgs) aiMsgs.innerHTML = '';
      this.addAIMsg(financialAnswer(this.currentMetrics));

    } catch (err) {
      if (request !== this.loadRequest) return;
      this.currentMetrics = null;
      document.getElementById('fin-source').textContent = 'Report failed to load. Click Refresh to retry.';
      console.error('Finance load error:', err);
      showNotification('Error loading financial data', 'error');
    }
  }

  formatCleanTime(ts) {
    const ms = timestamp(ts);
    if (!Number.isFinite(ms)) return '—';
    const d = new Date(ms);
    const timePart = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true }).replace(/\s+/g, '');
    const monthPart = d.toLocaleDateString('en-US', { month: 'short' });
    const day = d.getDate();
    const suffix = (day % 10 === 1 && day !== 11) ? 'st' : (day % 10 === 2 && day !== 12) ? 'nd' : (day % 10 === 3 && day !== 13) ? 'rd' : 'th';
    return `${timePart}, ${monthPart} ${day}${suffix}`;
  }

  renderTransactionsTable() {
    const details = document.getElementById('fin-transactions');
    if (!details || !this.currentMetrics) return;
    const escape = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
    const staffName = this.staffNameResolver || (r => r.staff_id || 'Staff');
    const query = this.txSearchQuery || '';
    const transactions = (this.currentMetrics.transactions || []).filter((p) => {
      if (!query) return true;
      const hay = [p.reference, p.id, p.customer_name, p.invoice_no, p.order_reference, p.method, staffName(p)].filter(Boolean).join(' ').toLowerCase();
      return hay.includes(query);
    });

    details.innerHTML = '<table class="fin-clean-table">'
      + '<thead><tr><th>TIME</th><th>REFERENCE</th><th>NAME / ORDER</th><th>STAFF</th><th>AMOUNT</th><th>MODE</th></tr></thead>'
      + '<tbody>'
      + transactions.map((p) => {
        const ref = p.reference || p.invoice_no || p.order_reference || p.id || '—';
        const customerOrOrder = p.customer_name || p.invoice_no || p.order_reference || 'Walk-in Guest';
        const mode = String(p.method || 'cash').toLowerCase().replace(/_/g, ' ');
        return '<tr>'
          + '<td>' + escape(this.formatCleanTime(p.received_at)) + '</td>'
          + '<td class="fin-ref-code">' + escape(ref) + '</td>'
          + '<td>' + escape(customerOrOrder) + '</td>'
          + '<td>' + escape(staffName(p)) + '</td>'
          + '<td style="font-weight:700;color:#fff;">' + Math.round(Number(p.amount || 0)).toLocaleString() + '</td>'
          + '<td class="fin-mode-label">' + escape(mode) + (p.status && p.status !== 'SUCCESS' ? ` (${escape(paymentAttemptLabel(p))})` : '') + '</td>'
          + '</tr>';
      }).join('')
      + (transactions.length ? '' : '<tr><td colspan="6" style="text-align:center;color:#6b7280;padding:24px;">No payment transactions match this filter.</td></tr>')
      + '</tbody></table>';
  }

  renderLatestUnpaidSideCard() {
    const listEl = document.getElementById('fin-latest-unpaid-list');
    if (!listEl || !this.currentMetrics) return;
    const escape = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
    const rows = (this.currentMetrics.consolidatedUnpaidOrders || this.currentMetrics.unpaidOrdersOnly || []).slice(0, 4);
    if (!rows.length) {
      listEl.innerHTML = '<div style="color:#6b7280;font-size:12px;text-align:center;padding:14px 0;">All table bills settled</div>';
      return;
    }
    listEl.innerHTML = rows.map((order) => {
      const label = order.table_no
        ? `Table ${order.table_no}${(order.roundCount || 1) > 1 ? ` (${order.roundCount})` : ''}`
        : (order.reference || 'Order');
      const timeStr = order.placed_at
        ? new Date(timestamp(order.placed_at)).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true }).replace(/\s+/g, '')
        : 'Open';
      const href = `/orders?order=${encodeURIComponent(order.reference)}`;
      return `<div class="fin-side-item">
        <span class="fin-side-ref">${escape(label)}</span>
        <span class="fin-side-time">${escape(timeStr)}</span>
        <a class="fin-side-amt" href="${href}" style="color:#53b74c;">${Math.round(Number(order.amount || 0)).toLocaleString()} KES →</a>
      </div>`;
    }).join('');
  }

  renderUnpaidOrdersTable() {
    const unpaidOrdersEl = document.getElementById('fin-unpaid-orders');
    if (!unpaidOrdersEl || !this.currentMetrics) return;
    const report = this.currentMetrics;
    const escape = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
    const staffName = this.staffNameResolver || (r => r.staff_id || 'Unassigned');

    const rows = this.consolidateByTable
      ? (report.consolidatedUnpaidOrders || report.unpaidOrdersOnly || [])
      : (report.unpaidOrdersOnly || report.unpaidOrders?.filter(o => o.source !== 'proforma') || []);

    unpaidOrdersEl.innerHTML = '<table class="fin-clean-table">'
      + '<thead><tr><th>TIME</th><th>TABLE / REFERENCE</th><th>BILLS CONSOLIDATED</th><th>STAFF</th><th>AMOUNT (KES)</th><th>ACTION</th></tr></thead><tbody>'
      + rows.map(order => {
        const isConsolidated = (order.roundCount || 1) > 1;
        const tableBadge = order.table_no
          ? `<span style="display:inline-block;background:#134e32;color:#86efac;border:1px solid rgba(83,183,76,0.35);padding:3px 10px;border-radius:999px;font-size:11px;font-weight:800;margin-right:8px;">Table ${escape(order.table_no)}</span>`
          : '';
        const refLabel = `${tableBadge}<span class="fin-ref-code">${escape(order.reference)}</span>${order.customer_name ? ` · <span style="color:#9ca3af;">${escape(order.customer_name)}</span>` : ''}`;
        const billsInfo = isConsolidated
          ? `<strong style="color:#86efac;">${order.roundCount} bills combined</strong> <span style="color:#8a8f8c;font-size:11px;">(${escape((order.references || [order.reference]).join(', '))})</span>`
          : 'Single bill';
        const actionHref = `/orders?order=${encodeURIComponent(order.reference)}`;
        const actionText = isConsolidated ? `Pay Combined Bill (${order.roundCount})` : 'Pay Bill';
        return '<tr>'
          + '<td>' + escape(this.formatCleanTime(order.placed_at || order.invoice_date)) + '</td>'
          + '<td>' + refLabel + '</td>'
          + '<td>' + billsInfo + '</td>'
          + '<td>' + escape(order.staff_id ? staffName(order) : 'Unassigned') + '</td>'
          + '<td style="font-weight:800;color:#fff;">' + Math.round(Number(order.amount || 0)).toLocaleString() + '</td>'
          + '<td><a class="fin-reconcile" href="' + actionHref + '">' + actionText + '</a></td>'
          + '</tr>';
      }).join('')
      + (rows.length ? '' : '<tr><td colspan="6" style="text-align:center;color:#6b7280;padding:24px;">No unpaid table or counter bills in this period. Formal Proforma Invoices are under the Proforma Invoices tab.</td></tr>')
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
    }, 350);
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
    if (!m) {
      this.addAIMsg('Click "Refresh" first so I can analyze your live transactions.');
      return;
    }
    this.addAIMsg(financialAnswer(m, q));
  }
}

