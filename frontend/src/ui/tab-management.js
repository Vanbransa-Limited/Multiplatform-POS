import { db } from '../db/schema';
import { state } from '../context';
import { escapeHtml } from '../services/print-receipt';
import { mergeTabLines, tabCustomerId } from '../services/tabs';
import { readOpenTabs } from '../services/tab-edit';
import { pullOpenOrders } from '../services/open-orders';
import { pullSales } from '../services/catalogue';
import { DEVICE_ID, WALK_IN_CUSTOMER_ID } from '../services/firebase';

/**
 * Tab Management: every open table on one screen.
 *
 * The till only needs to know which table it is ringing for, so the floor
 * lives here rather than as a wall of chips over the cart. Nothing is settled
 * or edited on this screen. Pay now and Edit tab open the tab in the Orders
 * Viewer (settle dialog / item editor), and Add items opens the till on that
 * table in tab-only mode, so each job
 * still happens in the one place built for it.
 */
export class TabManagementView {
  constructor(container) {
    this.container = container;
    this.tabs = [];
    this.names = new Map();
    this.customers = new Map();
    this.search = '';
  }

  async load() {
    this.container.innerHTML = `
      <div class="module-page tabs-page" style="padding:24px;width:100%;max-width:1800px;margin:0 auto;color:var(--text-primary);font-family:var(--font-main);">
        <section class="tabs-board" style="background:var(--bg-card);border:1px solid var(--border-color);border-radius:12px;overflow:hidden">
          <div style="padding:16px 16px 14px">
            <h2 style="margin:0;font-family:var(--font-display);font-size:20px;font-weight:800">Tabs</h2>
            <p id="tabs-summary" style="margin:4px 0 0;font-size:12px;color:var(--text-secondary)">Reading open tabs…</p>
          </div>
          <div class="co-toolbar phone-sticky-toolbar" id="tabs-search-toolbar">
            <input id="tabs-search" class="co-search" type="search" placeholder="Search table, customer, order number or who opened it…" aria-label="Search open tabs">
            <button type="button" class="co-print" id="tabs-check-saved" title="Check saved orders on this till">Saved orders</button>
          </div>
          <div id="tabs-saved-results" role="status" style="padding:0 16px 12px"></div>
          <div id="tabs-list"></div>
        </section>
      </div>`;

    this.container.querySelector('#tabs-search').addEventListener('input', (event) => {
      this.search = event.target.value;
      this.renderList();
    });
    this.container.querySelector('#tabs-check-saved').addEventListener('click', () => void this.checkSavedOrders());

    let [tabs, users, customers] = await Promise.all([
      readOpenTabs(state.currentBranch?.id),
      db.users.toArray(),
      db.customers.toArray(),
    ]);
    if (this.disposed) return;
    this.tabs = tabs;
    this.names = new Map(users.map((user) => [user.id, user.name]));
    this.customers = new Map(customers.map((customer) => [customer.id, customer.name]));
    this.renderList();
    // Uploaded rounds leave the shared snapshot; the server copy is what keeps
    // another till's unpaid table on this screen.
    const [remote] = await Promise.all([
      pullOpenOrders(DEVICE_ID).catch(() => []),
      pullSales().catch(() => null),
    ]);
    if (this.disposed) return;
    tabs = await readOpenTabs(state.currentBranch?.id);
    if (this.disposed) return;
    const remoteTabs = remote
      .filter((order) => order.branchId === state.currentBranch?.id
        && (order.kind === 'tab' || (order.tableNumber && order.dueMinor > 0)))
      .map((order) => ({
        id: order.id,
        order_no: order.ref,
        table_no: order.tableNumber,
        table: order.tableNumber,
        opened_by: order.staffId,
        opened_at: order.createdAt,
        dueMinor: order.dueMinor,
        items: (order.lines || []).reduce((total, line) => total + (Number(line.qty) || 0), 0),
        rounds: [{ ...order }],
        customerName: order.customerName && order.customerName !== 'Guest' ? order.customerName : '',
        readOnly: true,
      }));
    const localRefs = new Set(tabs.map((tab) => tab.order_no).filter(Boolean));
    this.tabs = [...tabs, ...remoteTabs.filter((tab) => !localRefs.has(tab.order_no))]
      .sort((a, b) => new Date(a.opened_at).getTime() - new Date(b.opened_at).getTime());
    this.names = new Map(users.map((user) => [user.id, user.name]));
    this.renderList();
  }

  dispose() { this.disposed = true; }

  /** Read-only incident check: includes closed/voided rows hidden by the floor. */
  async checkSavedOrders() {
    const panel = this.container.querySelector('#tabs-saved-results');
    if (!panel) return;
    panel.textContent = 'Checking saved local orders…';
    try {
      const [sales, tabs] = await db.transaction('r', [db.sales, db.tabs], () => Promise.all([
        db.sales.where('branch_id').equals(state.currentBranch?.id || '').toArray(),
        db.tabs.where('branch_id').equals(state.currentBranch?.id || '').toArray(),
      ]));
      if (this.disposed) return;
      const needle = this.search.trim().toLowerCase().replace(/^table\s+/, '');
      const selected = sales.filter(sale => !needle || String(sale.table_no || '').toLowerCase() === needle
        || String(sale.invoice_no || '').toLowerCase().includes(needle));
      const headers = new Map(tabs.map(tab => [tab.id, tab]));
      panel.innerHTML = selected.length ? `<p>${selected.length} saved order(s) found on this till. No records have been changed.</p>`
        + selected.slice(0, 30).map(sale => {
          const ref = sale.invoice_no || sale.id;
          const tab = headers.get(sale.tab_id);
          const details = [sale.status || 'Unknown status', sale.synced_at ? 'Server acknowledged' : 'Still on this till',
            sale.tab_id ? `Tab: ${tab?.status || 'header missing'}` : 'No tab header', sale.sync_error_msg].filter(Boolean).join(' · ');
          return `<p><a href="/orders?order=${encodeURIComponent(ref)}">${escapeHtml(ref)}</a> · Table ${escapeHtml(sale.table_no || '—')}<br>${escapeHtml(details)}</p>`;
        }).join('')
        : '<p>No matching saved order was found in this browser’s local ledger. This does not check another browser or recreate an order.</p>';
    } catch {
      if (!this.disposed) panel.textContent = 'The local ledger could not be read. Keep browser data intact and contact support.';
    }
  }

  /** Whose tab it is, so a returning customer's tab can be found by their name. */
  customerFor(tab) {
    if (tab.customerName) return tab.customerName;
    const id = tabCustomerId(tab, WALK_IN_CUSTOMER_ID);
    return id ? this.customers.get(id) || '' : '';
  }

  /** The Orders Viewer knows a tab card by this, and opens its settle dialog on it. */
  refFor(tab) {
    return tab.order_no || tab.rounds[0]?.ref || '';
  }

  renderList() {
    const list = this.container.querySelector('#tabs-list');
    const summary = this.container.querySelector('#tabs-summary');
    if (!list || !summary) return;

    const owed = this.tabs.reduce((total, tab) => total + tab.dueMinor, 0);
    summary.textContent = this.tabs.length
      ? `${this.tabs.length} open tab${this.tabs.length === 1 ? '' : 's'} · KES ${(owed / 100).toFixed(2)} still owed. Oldest first.`
      : 'No open tabs. Type a table on the till to open one.';

    const needle = this.search.trim().toLowerCase();
    const shown = needle
      ? this.tabs.filter((tab) => [tab.table, this.customerFor(tab), this.refFor(tab), this.names.get(tab.opened_by)]
        .filter(Boolean).join(' ').toLowerCase().includes(needle))
      : this.tabs;

    list.innerHTML = shown.length
      ? `<div class="co-grid">${shown.map((tab) => this.card(tab)).join('')}</div>`
      : `<p class="co-empty">${this.tabs.length ? 'No open tab matches that search.' : ''}</p>`;
  }

  card(tab) {
    const ref = this.refFor(tab);
    const { lines } = mergeTabLines(tab.unpaidRounds || tab.rounds);
    const opened = tab.opened_at ? new Date(tab.opened_at) : null;
    const by = tab.opened_by ? this.names.get(tab.opened_by) || tab.opened_by : '';
    const customer = this.customerFor(tab);
    const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;
    return `<article class="co-card tab-card">
      <div class="co-body" style="padding-left:14px">
        <div class="co-row">
          <span class="co-ref">Table ${escapeHtml(tab.table)}</span>
          <span class="co-unpaid">KES ${(tab.dueMinor / 100).toFixed(2)} due</span>
        </div>
        ${customer ? `<div class="co-meta">Customer: <b>${escapeHtml(customer)}</b></div>` : ''}
        <div class="co-meta">${escapeHtml(ref)} · ${plural(tab.items, 'item')} · ${plural(tab.rounds.length, 'round')}<br>
          Opened ${escapeHtml(opened ? opened.toLocaleTimeString() : '—')}${by ? ` by <b>${escapeHtml(by)}</b>` : ''}</div>
        <div class="co-meta">${lines.slice(0, 8).map(line => `<div>${escapeHtml(line.name)} &times; ${escapeHtml(line.qty)}</div>`).join('')}${lines.length > 8 ? `<div>+${escapeHtml(lines.length - 8)} more</div>` : ''}</div>
        <div class="co-actions">
          ${ref ? `<a class="co-print" style="text-decoration:none" href="/orders?order=${escapeHtml(encodeURIComponent(ref))}&invoice=1">Invoice</a>` : ''}
          ${tab.readOnly ? '' : `<a class="co-print" style="text-decoration:none" href="/till?table=${encodeURIComponent(tab.table)}">Add items</a>`}
          ${ref && !tab.readOnly ? `<a class="co-print" style="text-decoration:none" href="/orders?order=${encodeURIComponent(ref)}&edit=1">Edit tab</a>` : ''}
          ${ref ? `<a class="co-pay" style="text-decoration:none" href="/orders?order=${encodeURIComponent(ref)}">Pay now</a>` : ''}
          ${tab.readOnly ? '<span class="co-meta" style="margin:0">Running on another till · Pay now settles it from here</span>' : ''}
        </div>
      </div>
    </article>`;
  }
}
