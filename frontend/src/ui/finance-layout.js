export const FINANCE_SECTIONS = [
  ['overview', 'Overview'], ['payments', 'Payments'], ['sales', 'Sales & staff'],
  ['unpaid', 'Unpaid orders'], ['invoices', 'Invoices'], ['ai', 'AI assistant'],
];

/** One task per panel, following the module-header/tab pattern in Final. */
export function financeLayout() {
  const metric = (label, id, note = '', noteId = '') => `<div class="m-card"><h3>${label}</h3><p class="m-val" id="${id}">—</p>${note || noteId ? `<small${noteId ? ` id="${noteId}"` : ''}>${note}</small>` : ''}</div>`;
  return `<style>
    .finance-shell { --fin-muted:#cbb79f; display:block; width:100%; max-width:1480px; min-height:100%; height:auto; margin:0 auto; padding:24px; color:var(--text-primary); }
    .finance-shell [hidden] { display:none !important; }
    .finance-header { margin-bottom:20px; }
    .finance-header h1 { font-family:var(--font-display); font-size:26px; font-weight:700; line-height:1.25; margin:0 0 6px; }
    .finance-header p,.fin-section-head p { color:var(--fin-muted); font-size:13px; line-height:1.6; margin:0; }
    .fin-tabs { display:flex; gap:24px; border-bottom:1px solid var(--border-color); margin-bottom:24px; overflow-x:auto; scrollbar-width:thin; scrollbar-color:var(--border-hover) transparent; }
    .fin-tab { flex:none; padding:12px 0; min-height:46px; border:0; border-bottom:2px solid transparent; border-radius:0; background:transparent; color:var(--fin-muted); font:600 14px var(--font-main); white-space:nowrap; cursor:pointer; }
    .fin-tab:hover { color:var(--text-primary); }
    .fin-tab[aria-selected=true] { color:var(--accent-amber); border-bottom-color:var(--accent-amber); }
    .finance-shell :is(button,input):focus-visible { outline:2px solid var(--accent-amber); outline-offset:3px; }
    .fin-toolbar { display:flex; flex-direction:column; gap:16px; padding:16px 20px; background:var(--surface); border-radius:12px; margin-bottom:12px; }
    .fin-filter-heading { display:flex; justify-content:space-between; gap:16px; align-items:center; }
    .fin-filter-heading h2 { font-size:13px; font-weight:600; margin:0; }
    .fin-filter-heading p { font-size:12px; color:var(--fin-muted); margin:4px 0 0; }
    .fin-date-bar { display:flex; align-items:flex-end; gap:16px; flex-wrap:wrap; }
    .fin-date-bar label { display:grid; gap:6px; font-size:12px; color:var(--fin-muted); }
    .fin-date-bar input[type=date] { min-height:40px; background:var(--bg-main); border:1px solid var(--border-hover); color:var(--text-primary); padding:8px 10px; border-radius:6px; font:13px var(--font-main); color-scheme:dark; }
    .fin-load-btn { background:var(--accent); color:#140e08; border:0; min-height:40px; padding:10px 18px; border-radius:6px; cursor:pointer; font:700 13px var(--font-main); }
    .fin-quick-ranges { display:flex; gap:6px; flex-wrap:wrap; }
    .fin-range-btn { border:1px solid var(--border-hover); border-radius:6px; padding:9px 10px; min-height:40px; background:transparent; color:var(--fin-muted); font:600 12px var(--font-main); cursor:pointer; }
    .fin-range-btn.active,.fin-range-btn:hover { color:var(--accent-amber); background:rgba(200,131,42,.12); border-color:var(--accent); }
    .fin-coverage { color:var(--fin-muted); font-size:12px; line-height:1.6; margin:0 0 28px; }
    .fin-coverage summary { padding:4px 0; cursor:pointer; width:fit-content; }
    .fin-coverage[data-state=warning] summary { color:var(--accent-amber); }
    .fin-coverage p { margin:8px 0 0; max-width:90ch; }
    .fin-panel { min-width:0; outline-offset:4px; }
    .fin-section-head { display:flex; align-items:flex-start; justify-content:space-between; gap:16px; margin:0 0 20px; }
    .fin-section-head h2 { font-family:var(--font-display); font-size:21px; margin:0 0 6px; }
    .fin-section-head p { max-width:75ch; }
    .fin-overview-total { display:flex; flex-direction:column; align-items:flex-start; padding:28px 0 24px; border-bottom:1px solid var(--border-color); }
    .fin-overview-total h3 { color:var(--fin-muted); font-size:14px; font-weight:500; margin:0 0 8px; }
    .finance-shell .fin-overview-total .m-val { font-family:var(--font-display); font-size:clamp(28px,4vw,44px); line-height:1.2; font-weight:600; font-variant-numeric:tabular-nums; }
    .fin-overview-stats { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:32px; padding:24px 0; }
    .fin-overview-stats h3 { font-size:13px; color:var(--fin-muted); font-weight:500; margin:0 0 10px; }
    .fin-overview-stats p { font-size:23px; font-weight:600; font-variant-numeric:tabular-nums; }
    .fin-overview-links { display:flex; flex-wrap:wrap; gap:12px 24px; padding:4px 0 28px; }
    .fin-text-link { border:0; background:none; color:var(--accent-amber); font:600 13px var(--font-main); text-decoration:underline; text-underline-offset:4px; cursor:pointer; min-height:36px; }
    .fin-attention { border-top:1px solid var(--border-color); padding:24px 0; max-width:900px; }
    .fin-attention h3 { font-size:15px; margin:0 0 12px; }
    .fin-attention p { color:var(--fin-muted); font-size:13px; }
    .fin-attention ul { list-style:none; padding:0; margin:0; }
    .fin-attention li { display:flex; justify-content:space-between; align-items:center; gap:16px; padding:12px 0; border-bottom:1px solid var(--border-color); font-size:13px; }
    .finance-shell .metrics-row { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:24px; margin-bottom:28px; }
    .finance-shell .m-card { min-width:0; background:none; border:0; border-bottom:1px solid var(--border-color); border-radius:0; padding:0 0 20px; }
    .finance-shell .m-card h3 { font-size:12px; font-weight:500; color:var(--fin-muted); margin:0 0 10px; }
    .finance-shell .m-val { font-size:24px; font-weight:600; font-variant-numeric:tabular-nums; overflow-wrap:anywhere; }
    .finance-shell .m-card small { display:block; color:var(--fin-muted); font-size:11px; line-height:1.6; margin-top:8px; }
    .finance-shell .fin-card { background:var(--surface); border-radius:12px; padding:20px; margin-bottom:24px; }
    .finance-shell .fin-card h3 { font-size:16px; margin:0 0 8px; }
    .finance-shell .fin-card > p { color:var(--fin-muted); line-height:1.6; font-size:12px; margin-bottom:16px; max-width:80ch; }
    .fin-table-wrap { max-width:100%; overflow-x:auto; }
    .finance-shell .fin-table { width:100%; border-collapse:collapse; text-align:left; font-size:13px; font-variant-numeric:tabular-nums; }
    .finance-shell .fin-table th { padding:12px; border-bottom:1px solid var(--border-hover); color:var(--fin-muted); font-weight:500; white-space:nowrap; }
    .finance-shell .fin-table td { padding:14px 12px; border-bottom:1px solid var(--border-color); vertical-align:top; }
    .finance-shell .fin-table tr:hover { background:rgba(255,255,255,.025); }
    .fin-reconcile { color:var(--accent-amber); font-size:12px; font-weight:600; white-space:nowrap; text-underline-offset:4px; }
    .fin-review { margin-bottom:28px; }
    .fin-review > summary { color:var(--fin-muted); cursor:pointer; font-size:13px; padding:8px 0 16px; }
    .fin-review .metrics-row { margin:12px 0 0; }
    .finance-shell .finance-right { display:flex; flex-direction:column; width:100%; max-width:1040px; min-width:0; height:560px; max-height:75dvh; min-height:380px; background:var(--surface); border:1px solid var(--border-color); border-radius:12px; overflow:hidden; }
    .ai-header { padding:16px 20px; border-bottom:1px solid var(--border-color); }
    .ai-title { font-size:16px; font-weight:600; }
    .ai-subtitle { color:var(--fin-muted); font-size:12px; margin-top:4px; }
    .ai-msgs { flex:1; min-height:140px; overflow-y:auto; padding:20px; display:flex; flex-direction:column; gap:16px; }
    .ai-bubble { max-width:90%; background:var(--bg-main); border:1px solid var(--border-color); border-radius:8px; padding:12px 16px; font-size:13px; line-height:1.7; white-space:pre-wrap; }
    .user-bubble { max-width:85%; align-self:flex-end; background:rgba(200,131,42,.12); border-radius:8px; padding:12px 16px; font-size:13px; line-height:1.6; }
    .ai-suggest-chips { display:flex; gap:8px; padding:0 20px 16px; flex-wrap:wrap; }
    .finance-shell .chip { border:1px solid var(--border-hover); border-radius:6px; background:transparent; color:var(--fin-muted); min-height:36px; padding:8px 10px; font:12px var(--font-main); cursor:pointer; }
    .finance-shell .chip:hover { color:var(--accent-amber); border-color:var(--accent); }
    .ai-input-row { display:flex; gap:12px; padding:16px 20px; border-top:1px solid var(--border-color); }
    .ai-input-row input { flex:1; min-width:0; border:1px solid var(--border-hover); border-radius:6px; padding:12px; background:var(--bg-main); color:var(--text-primary); font:13px var(--font-main); }
    .ai-input-row input::placeholder { color:var(--fin-muted); }
    .ai-input-row button { background:var(--accent); color:#140e08; border:0; border-radius:6px; padding:12px 20px; font:700 13px var(--font-main); cursor:pointer; }
    .ai-typing { color:var(--fin-muted); padding:8px; font-size:12px; }
    .ai-typing::before { content:'Preparing answer…'; }
    .ai-typing span { display:none; }
    .fin-visually-hidden { position:absolute; width:1px; height:1px; padding:0; margin:-1px; overflow:hidden; clip:rect(0,0,0,0); white-space:nowrap; border:0; }
    @media(max-width:1050px) { .fin-tabs { gap:20px; } .fin-date-bar { gap:12px; } .finance-shell .metrics-row { gap:16px; } }
    @media(max-width:767px) { .finance-shell { padding:0; } .finance-header h1 { font-size:23px; } .fin-tabs { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:0 12px; overflow:visible; margin-bottom:20px; } .fin-tab { font-size:12px; padding:12px 0; } .fin-toolbar { padding:16px; } .fin-overview-stats { grid-template-columns:minmax(0,1fr); gap:0; padding:16px 0; } .fin-overview-stats > div { display:flex; align-items:center; justify-content:space-between; gap:16px; padding:12px 0; } .fin-overview-stats h3 { max-width:52%; margin:0; } .fin-overview-total { padding-top:12px; } .finance-shell .fin-overview-total .m-val { font-size:36px; } .fin-overview-stats p { font-size:20px; text-align:right; } .fin-attention li { align-items:flex-start; } .finance-shell .fin-card { padding:16px; } .finance-shell .m-val { font-size:21px; } .ai-msgs { padding:16px; } .ai-bubble { max-width:100%; } .ai-suggest-chips { padding:0 16px 12px; gap:6px; } .finance-shell .chip { min-height:40px; } .ai-input-row { padding:12px 16px; } }
  </style>
  <div class="finance-shell">
    <header class="finance-header"><h1>Financials &amp; AI</h1><p>Review payments, sales and outstanding orders.</p></header>
    <nav class="fin-tabs" role="tablist" aria-label="Financial sections">
      ${FINANCE_SECTIONS.map(([id, label], index) => `<button type="button" class="fin-tab" id="fin-tab-${id}" role="tab" data-fin-section="${id}" aria-controls="fin-panel-${id}" aria-selected="${index === 0}" tabindex="${index === 0 ? 0 : -1}">${label}</button>`).join('')}
    </nav>
    <section class="fin-toolbar" aria-label="Report period">
      <div class="fin-filter-heading"><div><h2>Report period</h2><p id="fin-period-caption">Today · Full day</p></div></div>
      <div class="fin-date-bar">
        <label>From<input type="date" id="fin-start"></label><label>To<input type="date" id="fin-end"></label>
        <button type="button" class="fin-load-btn" id="fin-load-btn">Load Report</button>
        <div class="fin-quick-ranges" role="group" aria-label="Quick report period">${[['today','Today'],['yesterday','Yesterday'],['week','Past week'],['month','Past month']].map(([id,label]) => `<button type="button" class="fin-range-btn${id === 'today' ? ' active' : ''}" data-fin-range="${id}" aria-pressed="${id === 'today'}">${label}</button>`).join('')}</div>
        <div class="fin-quick-ranges" role="group" aria-label="Trading session">${[['full','Full day'],['morning','Morning'],['night','Night']].map(([id,label]) => `<button type="button" class="fin-range-btn${id === 'full' ? ' active' : ''}" data-fin-session="${id}" aria-pressed="${id === 'full'}">${label}</button>`).join('')}</div>
      </div>
    </section>
    <details class="fin-coverage"><summary id="fin-source-summary" role="status" aria-live="polite">Loading report…</summary><p id="fin-source">Loading transaction records…</p></details>
    <div class="finance-content">
      <section class="fin-panel" id="fin-panel-overview" data-fin-panel="overview" role="tabpanel" aria-labelledby="fin-tab-overview" tabindex="0">
        <div class="fin-section-head"><div><h2>Overview</h2><p>The selected period at a glance.</p></div></div>
        <div class="fin-overview-total"><h3>Payments received</h3><p class="m-val" id="fin-collected">—</p></div>
        <div class="fin-overview-stats"><div><h3>Sales after discounts</h3><p id="fin-overview-sales">—</p></div><div><h3>Unpaid orders &amp; invoices</h3><p id="fin-overview-unpaid">—</p></div><div><h3>Payments</h3><p id="fin-overview-payments">—</p></div></div>
        <div class="fin-overview-links"><button class="fin-text-link" data-fin-open="payments">View payments</button><button class="fin-text-link" data-fin-open="unpaid">Review unpaid orders</button><button class="fin-text-link" data-fin-open="ai">Ask AI</button></div>
        <section class="fin-attention"><h3>Payment checks</h3><div id="fin-attention"><p>Loading payment checks…</p></div></section>
      </section>
      <section class="fin-panel" id="fin-panel-payments" data-fin-panel="payments" role="tabpanel" aria-labelledby="fin-tab-payments" tabindex="0" hidden>
        <div class="fin-section-head"><div><h2>Payments</h2><p><span id="fin-payment-count">0</span> payments received in this period.</p></div></div>
        <div class="metrics-row">${metric('M-Pesa received','fin-mpesa','','fin-mpesa-held')}${metric('Cash received','fin-cash','','fin-cash-held')}${metric('Bank transfers','fin-bank','Statement references, unverified','fin-bank-held')}${metric('Card & other','fin-other','','fin-other-held')}</div>
        <details class="fin-review"><summary>Payment checks &amp; failed attempts</summary><div class="metrics-row">${metric('Without a matching sale','fin-unmatched')}${metric('Failed / cancelled attempts','fin-failed')}${metric('Missing payment dates','fin-undated','Not counted in a period','fin-undated-count')}${metric('Held on a till','fin-held','Not yet included in received totals','fin-held-count')}</div></details>
        <div class="fin-card"><h3>Transactions</h3><p>Received payments and payment attempts for the selected period. Failed and pending attempts are excluded from money received.</p><div id="fin-transactions" class="fin-table-wrap"></div></div>
      </section>
      <section class="fin-panel" id="fin-panel-sales" data-fin-panel="sales" role="tabpanel" aria-labelledby="fin-tab-sales" tabindex="0" hidden>
        <div class="fin-section-head"><div><h2>Sales &amp; staff</h2><p>Recorded sales and the staff who handled them.</p></div></div>
        <div class="metrics-row">${metric('Gross recorded sales','fin-gross')}${metric('Total discounts','fin-disc')}${metric('Sales after discounts','fin-net')}${metric('Completed sales','fin-count')}</div>
        <div class="fin-card"><h3>Staff rundown</h3><p>Completed sales, payments received and unpaid orders for each staff member.</p><div class="fin-table-wrap"><table class="fin-table"><thead><tr><th>Staff member</th><th>Completed sales</th><th>Sales value</th><th>Payments</th><th>Received</th><th>Still unpaid</th></tr></thead><tbody id="cashier-report-body"><tr><td colspan="6">No data loaded yet.</td></tr></tbody></table></div></div>
      </section>
      <section class="fin-panel" id="fin-panel-unpaid" data-fin-panel="unpaid" role="tabpanel" aria-labelledby="fin-tab-unpaid" tabindex="0" hidden>
        <div class="fin-section-head"><div><h2>Unpaid orders</h2><p>Orders in this period, plus all outstanding proforma invoices.</p></div></div>
        <div class="metrics-row">${metric('Unpaid orders & invoices','fin-pending','0 orders · unreceived','fin-pending-count')}${metric('Unreceived cash','fin-unpaid','Awaiting reconciliation to an order')}</div>
        <div class="fin-card"><h3>Outstanding balances</h3><p>Open the original order or invoice to record its payment. Proforma payments count on the day they are recorded.</p><div id="fin-unpaid-orders" class="fin-table-wrap"></div></div>
      </section>
      <section class="fin-panel" id="fin-panel-invoices" data-fin-panel="invoices" role="tabpanel" aria-labelledby="fin-tab-invoices" tabindex="0" hidden><div class="fin-card" id="fin-proformas"></div></section>
      <section class="fin-panel" id="fin-panel-ai" data-fin-panel="ai" role="tabpanel" aria-labelledby="fin-tab-ai" tabindex="0" hidden>
        <div class="fin-section-head"><div><h2>AI assistant</h2><p>Ask about the figures in the selected report.</p></div></div>
        <div class="finance-right"><div class="ai-header"><div class="ai-title">Vanbransa AI</div><div class="ai-subtitle">Answers from your financial report</div></div>
          <div class="ai-msgs" id="ai-msgs" role="log" aria-label="Report conversation" aria-live="polite"><div class="ai-bubble" id="ai-report-context">Load a report to ask about payments, sales or staff.</div></div>
          <div class="ai-suggest-chips">${[['performance','Summary'],['cash vs mpesa','Payment methods'],['unpaid and pending','Unpaid orders'],['staff rundown','Staff']].map(([q,label]) => `<button type="button" class="chip" data-q="${q}">${label}</button>`).join('')}</div>
          <div class="ai-input-row"><label for="ai-inp" class="fin-visually-hidden">Ask about this report</label><input type="text" id="ai-inp" placeholder="Ask about this report…"><button type="button" id="ai-send">Ask</button></div>
        </div>
      </section>
    </div>
  </div>`;
}
