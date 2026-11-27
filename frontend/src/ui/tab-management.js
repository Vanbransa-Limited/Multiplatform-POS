import { db } from '../db/schema';
import { state, showNotification } from '../context';
import { escapeHtml } from '../services/print-receipt';
import { canAddToTab, mergeTabLines } from '../services/tabs';
import { freeSettledTab, readOpenTabs } from '../services/tab-edit';
import { pullOpenOrders, collapseOpenOrders } from '../services/open-orders';
import { activeTenantId, pullSales } from '../services/catalogue';
import { DEVICE_ID, callFunction } from '../services/firebase';
import { heldRounds, releaseReason, releaseTarget, releasedUnpaid } from '../services/table-release';

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
            <input id="tabs-search" class="co-search" type="search" placeholder="Search table, order number or who opened it…" aria-label="Search open tabs">
            <button type="button" class="co-print" id="tabs-check-saved" title="Check saved orders on this till">Saved orders</button>
          </div>
          <div id="tabs-saved-results" role="status" style="padding:0 16px 12px"></div>
          <div id="tabs-list"></div>
          <div id="tabs-released" style="padding:0 16px 16px"></div>
        </section>
      </div>`;
    this.container.querySelector('#tabs-list').addEventListener('click', (event) => {
      const button = event.target.closest('[data-release-tab]');
      if (button) void this.releaseTab(this.tabs.find(tab => tab.serverTabId === button.dataset.releaseTab));
    });

    this.onTablesUpdated = () => void this.refreshTabs().catch(() => {});
    window.addEventListener('pos:tables-updated', this.onTablesUpdated);
    this.container.querySelector('#tabs-search').addEventListener('input', (event) => {
      this.search = event.target.value;
      this.renderList();
    });
    this.container.querySelector('#tabs-check-saved').addEventListener('click', () => void this.checkSavedOrders());

    let [tabs, users] = await Promise.all([
      readOpenTabs(state.currentBranch?.id),
      db.users.toArray(),
    ]);
    if (this.disposed) return;
    this.tabs = tabs;
    this.names = new Map(users.map((user) => [user.id, user.name]));
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
    const remoteTabs = collapseOpenOrders(remote)
      .filter((order) => order.branchId === state.currentBranch?.id && !order.held
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
        readOnly: true,
      }));
    const localRefs = new Set(tabs.map((tab) => tab.order_no).filter(Boolean));
    this.remoteTabs = remoteTabs;
    this.tabs = [...tabs, ...remoteTabs.filter((tab) => !localRefs.has(tab.order_no))]
      .sort((a, b) => new Date(a.opened_at).getTime() - new Date(b.opened_at).getTime());
    this.names = new Map(users.map((user) => [user.id, user.name]));
    this.renderList();
    await this.renderReleased();
  }

  /**
   * Frees the table for the next customer; the bill stays owed and payable
   * from Orders. The server checks who is asking and records who, when and why.
   */
  async releaseTab(tab) {
    if (!tab || this.releasing) return;
    const target = releaseTarget(tab, { online: navigator.onLine !== false });
    if (target.blocked) { showNotification(target.blocked, 'warning'); return; }
    const kes = `KES ${(target.dueMinor / 100).toLocaleString('en-KE', { minimumFractionDigits: 2 })}`;
    const answer = window.prompt(`Release Table ${target.tableNumber} for the next customer?\n\n`
      + `${kes} stays owed on ${this.refFor(tab) || 'this bill'}. Nothing is paid or voided; pay it later from Orders.\n\n`
      + 'Reason (3 to 200 characters):', '');
    if (answer === null) return;
    const { reason, error } = releaseReason(answer);
    if (error) { showNotification(error, 'warning'); return; }
    this.releasing = true;
    try {
      const result = await callFunction('releaseTable', { tenantId: await activeTenantId(), branchId: state.currentBranch?.id,
        tableNumber: target.tableNumber, tabId: target.tabId, reason });
      showNotification(`Table ${target.tableNumber} released. ${kes} stays owed on ${this.refFor(tab) || 'the bill'}; pay it from Orders.`, 'success');
      if (result?.replayed) showNotification('It had already been released; nothing was recorded twice.', 'info');
      // Bring the release stamp down so this till frees the table now, not at the next sync.
      await pullSales(undefined, undefined, { tableNumber: target.tableNumber, branchId: state.currentBranch?.id }).catch(() => null);
      await freeSettledTab(tab.id).catch(() => null);
      await this.refreshTabs();
      await this.renderReleased();
    } catch (failure) {
      showNotification(`Table ${target.tableNumber} was not released: ${failure?.message || failure}`, 'error');
    } finally {
      this.releasing = false;
    }
  }

  /** Released bills still owed, and rounds held because their tab was released: for managers to follow up. */
  async renderReleased() {
    const panel = this.container.querySelector('#tabs-released');
    if (!panel) return;
    const branchId = state.currentBranch?.id || '';
    const sales = (await db.sales.where('branch_id').equals(branchId).toArray())
      .filter(sale => sale.table_release || sale.sync_hold);
    if (this.disposed) return;
    const payments = sales.length ? await db.payments.where('sale_id').anyOf(sales.map(sale => sale.id)).toArray() : [];
    const released = releasedUnpaid(sales, payments, branchId);
    const held = heldRounds(sales, branchId);
    const money = minor => `KES ${(minor / 100).toLocaleString('en-KE', { minimumFractionDigits: 2 })}`;
    const when = iso => (iso ? new Date(iso).toLocaleString() : '—');
    panel.innerHTML = (released.length ? `<h3 style="margin:8px 0;font-size:15px">Released · Unpaid (${released.length})</h3>`
      + released.map(bill => `<p class="co-meta" style="margin:0 0 8px">
          <b>Table ${escapeHtml(bill.table || '—')}</b> · <a href="/orders?order=${escapeHtml(encodeURIComponent(bill.ref))}">${escapeHtml(bill.ref)}</a>
          · <span class="co-unpaid">${money(bill.dueMinor)} due</span> · Released · Unpaid<br>
          Released ${escapeHtml(when(bill.releasedAt))} by <b>${escapeHtml(this.names.get(bill.releasedBy) || bill.releasedBy || 'unknown')}</b>: ${escapeHtml(bill.reason)}
          · <a href="/orders?order=${escapeHtml(encodeURIComponent(bill.ref))}&invoice=1">Invoice</a>
          · <a href="/orders?order=${escapeHtml(encodeURIComponent(bill.ref))}">Pay now</a></p>`).join('') : '')
      + (held.length ? `<h3 style="margin:8px 0;font-size:15px">Held for review (${held.length})</h3>`
      + held.map(round => `<p class="co-meta" style="margin:0 0 8px"><b>Table ${escapeHtml(round.table || '—')}</b> · ${escapeHtml(round.ref)}
          · ${money(round.totalMinor)} · on no bill${round.releasedTabRef ? ` (rung for released ${escapeHtml(round.releasedTabRef)})` : ''}<br>${escapeHtml(round.message)}</p>`).join('') : '');
  }

  /** The server's tabs changed (paid or added to elsewhere): redraw from them. */
  async refreshTabs() {
    const tabs = await readOpenTabs(state.currentBranch?.id);
    if (this.disposed) return;
    const localRefs = new Set(tabs.map((tab) => tab.order_no).filter(Boolean));
    this.tabs = [...tabs, ...(this.remoteTabs || []).filter((tab) => !localRefs.has(tab.order_no))]
      .sort((a, b) => new Date(a.opened_at).getTime() - new Date(b.opened_at).getTime());
    this.renderList();
  }

  dispose() {
    this.disposed = true;
    window.removeEventListener('pos:tables-updated', this.onTablesUpdated);
  }

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
      ? this.tabs.filter((tab) => [tab.table, this.refFor(tab), this.names.get(tab.opened_by)]
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
    const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;
    return `<article class="co-card tab-card">
      <div class="co-body" style="padding-left:14px">
        <div class="co-row">
          <span class="co-ref">Table ${escapeHtml(tab.table)}</span>
          <span class="co-unpaid">KES ${(tab.dueMinor / 100).toFixed(2)} due</span>
        </div>
        <div class="co-meta">${escapeHtml(ref)} · ${plural(tab.items, 'item')} · ${plural(tab.rounds.length, 'round')}<br>
          Opened ${escapeHtml(opened ? opened.toLocaleTimeString() : '—')}${by ? ` by <b>${escapeHtml(by)}</b>` : ''}</div>
        <div class="co-meta">${lines.slice(0, 8).map(line => `<div>${escapeHtml(line.name)} &times; ${escapeHtml(line.qty)}</div>`).join('')}${lines.length > 8 ? `<div>+${escapeHtml(lines.length - 8)} more</div>` : ''}</div>
        <div class="co-actions">
          ${ref ? `<a class="co-print" style="text-decoration:none" href="/orders?order=${escapeHtml(encodeURIComponent(ref))}&invoice=1">Invoice</a>` : ''}
          ${canAddToTab(tab) ? `<a class="co-print" style="text-decoration:none" href="/till?table=${encodeURIComponent(tab.table)}">Add items</a>` : ''}
          ${ref && canAddToTab(tab) ? `<a class="co-print" style="text-decoration:none" href="/orders?order=${encodeURIComponent(ref)}&edit=1">Edit tab</a>` : ''}
          ${ref ? `<a class="co-print" style="text-decoration:none" href="/orders?order=${encodeURIComponent(ref)}&discount=1" title="Add the Staff 20% to a round that went out without it">Staff 20%</a>` : ''}
          ${ref ? `<a class="co-pay" style="text-decoration:none" href="/orders?order=${encodeURIComponent(ref)}">Pay now</a>` : ''}
          ${tab.serverTabId && tab.dueMinor > 0 ? `<button type="button" class="co-print" data-release-tab="${escapeHtml(tab.serverTabId)}" title="Free the table for the next customer; the bill stays owed">Release table</button>` : ''}
          ${canAddToTab(tab) ? '' : '<span class="co-meta" style="margin:0">Running on another till · Pay now settles it from here</span>'}
        </div>
      </div>
    </article>`;
  }
}
