import { db } from '../db/schema';
import { state, showNotification } from '../context';
import { pullStock, changeStock, storeIsEnabled, pullStockMovements, importStock, pullStockRequests, decideStockRequest } from '../services/stock';
import { STOCK_TEMPLATE_CSV, downloadCsvTemplate, parseStockFile } from '../services/csv';
import { escapeHtml as esc } from '../services/print-receipt';
import { compareNames, pullCatalogue } from '../services/catalogue';
import { readWithDeadline } from '../services/read-deadline';
import { createMobileFilters } from './mobile-filters';
import { callFunction } from '../services/firebase';
import { adjustTarget, stockTakeRows, findDuplicate } from '../services/stock-actions.js';

/** How a movement row reads to the person looking at it. */
const MOVEMENT_LABELS = {
  receive: 'Delivery in',
  request: 'Moved to House',
  adjust: 'Count corrected',
};

/**
 * One stock room.
 *
 * The House is where service draws from and always exists. The Store is the
 * optional room in front of it: when it is enabled every delivery lands there
 * and the House fills itself by requesting, so each item has exactly one entry
 * point and the movement trail accounts for everything that arrived.
 *
 * Both rooms get their own screen because their work is different - the Store
 * receives, the House requests - and a single merged form made it easy to book
 * a delivery into the wrong place.
 */
export class StockView {
  constructor(container, location = 'HOUSE') {
    this.container = container;
    this.location = location;
    this.search = '';
    this.openPanel = null;
  }

  /**
   * Who may rewrite a count.
   *
   * Both rooms are the store manager's to run, so corrections and stock takes
   * are theirs as well as the owner's. Mirrors STOCK_ROLES.adjust on the
   * server, which is what actually enforces it.
   */
  get canCount() { return ['Owner', 'Store Manager', 'Supervisor'].includes(state.currentUser?.role); }
  /** Booking a delivery is Storeman's job; requesting stock into House is Barman's job. */
  get canWrite() {
    const role = state.currentUser?.role;
    if (this.action === 'request') return ['Owner', 'Supervisor', 'Bar Staff'].includes(role);
    return ['Owner', 'Store Manager', 'Store Keeper'].includes(role);
  }
  /** Supervisor (or Owner) approves House requests before Storeman can dispatch. */
  get canApprove() { return ['Owner', 'Supervisor', 'Store Manager'].includes(state.currentUser?.role); }
  /** Storeman (or Owner) dispatches stock from Store to House after Supervisor approval. */
  get canDispatch() { return ['Owner', 'Store Keeper', 'Store Manager'].includes(state.currentUser?.role); }
  /** Barman (or Supervisor/Owner) accepts dispatched stock into House Stock. */
  get canAccept() { return ['Owner', 'Bar Staff', 'Supervisor'].includes(state.currentUser?.role); }
  get canReceiveImport() { return this.action === 'receive' && ['Owner', 'Store Manager', 'Store Keeper'].includes(state.currentUser?.role); }
  get canImport() { return this.canReceiveImport || this.canCount; }

  /** What this room can do depends on whether a Store exists at all. */
  get action() {
    if (this.location === 'STORE') return 'receive';
    return storeIsEnabled() ? 'request' : 'receive';
  }

  async load() {
    this.refreshStatus = 'Showing cached stock. Refreshing from server…';
    try {
      await this.render();
      if (!this.disposed) void this.refresh();
    } catch {
      if (!this.disposed) this.container.innerHTML = '<div class="stk-wrap"><p>Stock is unavailable. Check your connection and reopen this screen.</p></div>';
    }
  }

  dispose() { this.disposed = true; this.actionSheet?.dispose(); }

  updateRefreshStatus() {
    if (this.disposed) return;
    const status = this.container.querySelector('#stk-refresh-status');
    if (status) status.textContent = this.refreshStatus;
    const button = this.container.querySelector('#stk-refresh');
    if (button) button.disabled = Boolean(this.refreshing);
  }

  async refresh() {
    if (this.refreshing || this.disposed) return;
    this.refreshing = true;
    this.refreshStatus = 'Showing cached stock. Refreshing from server…';
    this.updateRefreshStatus();
    try {
      // The optional trail must not block quantities, and each network read
      // has a deadline so offline SDK retries cannot trap this screen.
      const [stock, catalogue, movements, requests] = await Promise.allSettled([
        readWithDeadline(() => pullStock()),
        readWithDeadline(() => pullCatalogue()),
        readWithDeadline(() => this.loadMovements()),
        readWithDeadline(() => this.loadRequests()),
      ]);
      if (this.disposed) return;
      if (movements.status === 'rejected') this.movements = null;
      if (requests.status === 'rejected') this.requests = null;
      this.refreshStatus = stock.status === 'fulfilled'
        ? ''
        : 'Showing cached stock. Server refresh failed or timed out. Retry when connected.';
      if (catalogue.status === 'rejected') this.refreshStatus += ' Product details could not refresh.';
      if (movements.status === 'rejected' || this.movements === null) this.refreshStatus += ' Movement history is unavailable.';
      await this.render({ preserveForm: Boolean(this.openPanel) });
    } catch {
      if (!this.disposed) this.refreshStatus = 'Showing cached stock. Refresh could not finish. Please retry.';
    } finally {
      this.refreshing = false;
      this.updateRefreshStatus();
    }
  }

  /** The trail both screens share, resolved against the local name caches. */
  async loadMovements() {
    try {
      const [moves, users, products] = await Promise.all([
        pullStockMovements(state.currentBranch?.id),
        db.users.toArray(),
        db.products.toArray(),
      ]);
      const names = new Map(users.map((user) => [user.id, user.name]));
      const items = new Map(products.map((product) => [product.id, product.name]));
      if (moves && moves.length) {
        this.movements = moves.map((move) => ({
          when: move.createdAt?.toDate?.() || null,
          item: items.get(move.productId) || move.productId,
          location: move.location,
          qty: Number(move.qty || 0),
          type: MOVEMENT_LABELS[move.type] || move.type,
          who: names.get(move.createdByStaffId) || move.createdByStaffId || '—',
        }));
      } else {
        const localMoves = await db.stock_movements.toArray();
        this.movements = localMoves
          .filter((m) => !state.currentBranch?.id || !m.branch_id || m.branch_id === state.currentBranch.id)
          .sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0))
          .slice(0, 60)
          .map((move) => ({
            when: move.created_at ? new Date(move.created_at) : null,
            item: items.get(move.product_id) || move.product_id,
            location: move.location,
            qty: Number(move.qty || 0),
            type: MOVEMENT_LABELS[move.type] || move.type,
            who: names.get(move.created_by) || move.created_by || '—',
          }));
      }
    } catch {
      this.movements = [];
    }
  }

  async rows() {
    const products = await db.products.where('tenant_id').equals(state.currentTenant?.id || '')
      .filter((p) => !p.is_service && !p.retired_at)
      .toArray();
    const balances = await db.stock_balances.where('branchId').equals(state.currentBranch?.id || '').toArray();
    const here = new Map(balances.filter((b) => b.location === this.location).map((b) => [b.productId, Number(b.qty || 0)]));
    const store = new Map(balances.filter((b) => b.location === 'STORE').map((b) => [b.productId, Number(b.qty || 0)]));

    if (balances.length === 0) {
      const branchId = state.currentBranch?.id;
      const movements = await db.stock_movements.toArray();
      for (const m of movements) {
        if (branchId && m.branch_id && String(m.branch_id) !== String(branchId)) continue;
        const pid = String(m.product_id);
        const qty = Number(m.qty || 0);
        if (m.location === this.location) here.set(pid, (here.get(pid) || 0) + qty);
        if (m.location === 'STORE') store.set(pid, (store.get(pid) || 0) + qty);
      }
    }

    return products.map((product) => ({
      product,
      qty: Number(here.get(product.id) || 0),
      storeQty: Number(store.get(product.id) || 0),
    })).sort((a, b) => compareNames(a.product.name, b.product.name));
  }

  copy() {
    const store = storeIsEnabled();
    if (this.location === 'STORE') {
      return {
        title: 'Store Stock',
        blurb: 'The back room. Every delivery is booked in here first, and the House draws from it by requesting.',
        formTitle: 'Receive a delivery',
        formHint: 'Adds to what the Store holds. Reference the delivery note so the movement can be traced back.',
        verb: 'Receive into Store',
      };
    }
    return store
      ? {
        title: 'House Stock',
        blurb: 'What service can actually reach. Sales come out of here. Top it up by requesting from the Store. A request waits for the store manager to approve it, then the stock moves.',
        formTitle: 'Request from the Store',
        formHint: 'Asks the store manager to move stock from the Store into the House. Nothing moves until they approve.',
        verb: 'Request into House',
      }
      : {
        title: 'House Stock',
        blurb: 'What service can actually reach, and this business keeps no separate Store — so the House is also your store room. Deliveries are booked straight in here.',
        formTitle: 'Receive a delivery',
        formHint: 'Adds to what the House holds. Reference the delivery note so the movement can be traced back.',
        verb: 'Receive into House',
      };
  }

  async render({ preserveForm = false } = {}) {
    const rows = await this.rows();
    if (this.canCount) this.categories = await db.categories.toArray().catch(() => []);
    if (this.disposed) return;
    this.currentRows = rows;
    if (preserveForm && this.container.querySelector('#stk-body')) {
      this.container.querySelector('#stk-body').innerHTML = this.rowsHtml(rows);
      const trail = this.container.querySelector('#stk-movements');
      if (trail) trail.innerHTML = this.movementsHtml();
      const queue = this.container.querySelector('#stk-requests');
      if (queue) queue.outerHTML = this.requestsHtml();
      this.updateRefreshStatus();
      return;
    }
    const copy = this.copy();
    const requesting = this.action === 'request';
    this.actionSheet?.dispose();

    this.container.innerHTML = `
      <div class="stk-wrap">
        <div class="stk-head">
          <h2>${copy.title}</h2>
        </div>
        <p id="stk-refresh-status" class="stk-hint" role="status">${esc(this.refreshStatus || '')}</p>
        <div class="stock-search-toolbar phone-sticky-toolbar">
          <input id="stk-search" class="stk-search" type="search" placeholder="Search items" aria-label="Search items" value="${esc(this.search)}">
          <button type="button" id="stk-refresh" class="stk-action" ${this.refreshing ? 'disabled' : ''}>Refresh</button>
        </div>

        <div class="stk-actions" aria-label="Stock actions">
          ${this.canWrite ? `<button type="button" class="stk-action" data-stock-panel="entry" aria-controls="stk-entry-panel" aria-expanded="${this.openPanel === 'entry'}">${copy.formTitle}</button>` : ''}
          ${this.canCount ? `<button type="button" class="stk-action" data-stock-panel="new" aria-controls="stk-new-panel" aria-expanded="${this.openPanel === 'new'}">Add new item</button>
          <button type="button" class="stk-action" data-stock-panel="adjust" aria-controls="stk-adjust-panel" aria-expanded="${this.openPanel === 'adjust'}">Add / Remove stock</button>
          <button type="button" class="stk-action" data-stock-panel="take" aria-controls="stk-take-panel" aria-expanded="${this.openPanel === 'take'}">Stock take</button>` : ''}
          ${this.canImport ? `<button type="button" class="stk-action" data-stock-panel="import" aria-controls="stk-import-panel" aria-expanded="${this.openPanel === 'import'}">${this.canReceiveImport ? `Import stock into ${this.location === 'STORE' ? 'Store' : 'House'}` : 'Import a House stock count'}</button>` : ''}
        </div>
        ${this.canWrite ? `
        <section id="stk-entry-panel" class="stk-card" ${this.openPanel === 'entry' ? '' : 'hidden'}>
          <h3>${copy.formTitle}</h3>
          <p class="stk-hint">${copy.formHint}</p>
          <form id="stk-form" class="stk-form">
            <div class="stk-field grow">
              <label for="stk-product">Item</label>
              <input id="stk-product-search" type="search" placeholder="Search products by name or SKU" aria-label="Search products to add" autocomplete="off" style="margin-bottom:8px">
              <select id="stk-product" name="productId" required>
                ${rows.map((row) => `<option value="${esc(row.product.id)}">${esc(row.product.name)}${requesting ? ` — Store has ${row.storeQty}` : ''}</option>`).join('')}
              </select>
            </div>
            <div class="stk-field">
              <label for="stk-qty">Quantity</label>
              <input id="stk-qty" name="qty" type="number" min="1" max="100000000" step="1" required>
            </div>
            <div class="stk-field grow">
              <label for="stk-reason">${requesting ? 'Note' : 'Delivery reference'}</label>
              <!-- The global input styling keys off an explicit type, so an
                   untyped input renders white against this dark screen. -->
              <input id="stk-reason" name="reason" type="text" maxlength="300" ${requesting ? '' : 'required'}>
            </div>
            <div class="stk-field">
              <button class="primary-btn" type="submit">${copy.verb}</button>
            </div>
          </form>
          <p id="stk-msg" class="stk-msg" role="status"></p>
        </section>` : ''}

        ${this.canImport ? `
        <section id="stk-import-panel" class="stk-card" ${this.openPanel === 'import' ? '' : 'hidden'}>
          <h3>${this.canReceiveImport ? `Import stock into ${this.location === 'STORE' ? 'Store' : 'House'}` : 'Import a House stock count'}</h3>
          <p class="stk-hint">Upload CSV or Excel with SKU or item name and quantity. ${this.canReceiveImport ? 'Deliveries add to the stock in this room.' : 'A count replaces the House quantity and requires a reason. Receive deliveries in Store, then transfer them to House.'} Prices and menu settings are not changed.</p>
          ${this.canReceiveImport ? '<p class="stk-hint">Add new items in Menu Admin first. Stock imports only update existing catalogue items.</p>' : ''}
          <div class="stk-form">
            <div class="stk-field">
              <label for="stk-import-mode">This sheet is</label>
              <select id="stk-import-mode">
                ${this.canReceiveImport ? '<option value="receive">A delivery — add to what is here</option>' : ''}
                ${this.canCount ? '<option value="count">A count — set the figure exactly</option>' : ''}
              </select>
            </div>
            <div class="stk-field grow">
              <label for="stk-import-reason">Reference / reason</label>
              <input id="stk-import-reason" type="text" maxlength="300" placeholder="Delivery note number, or why you are recounting">
            </div>
            <div class="stk-field">
              <button type="button" class="primary-btn" id="stk-import-btn">Choose file…</button>
              <button type="button" class="stk-action" id="stk-template-btn">📄 Download template</button>
              <input id="stk-import-file" type="file" accept=".csv,.xlsx,text/csv" hidden>
            </div>
          </div>
          <div id="stk-import-report"></div>
        </section>` : ''}

        ${this.requestsHtml()}
        ${this.canCount ? this.countPanelsHtml(rows) : ''}

        <div class="stk-table-wrap stock-balances">
          <table class="stk-table">
            <thead>
              <tr>
                <th>Item</th>
                ${requesting ? '<th class="num">In Store</th>' : ''}
                <th class="num">${this.location === 'STORE' ? 'In Store' : 'In House'}</th>
                ${this.canCount ? '<th></th>' : ''}
              </tr>
            </thead>
            <tbody id="stk-body">${this.rowsHtml(rows)}</tbody>
          </table>
        </div>
        ${this.canCount ? '<p class="stk-hint">Fix count corrects one item. To count everything, use Stock take in Actions.</p>' : ''}



        <details class="stk-card stock-movements" style="margin-top:18px" ${window.matchMedia('(max-width: 767px)').matches ? '' : 'open'}>
          <summary>Movement history</summary>
          <p class="stk-hint">Every delivery, request and correction on this branch, newest first — both rooms, so the two screens reconcile against each other.</p>
          <div id="stk-movements">${this.movementsHtml()}</div>
        </details>
      </div>`;

    this.bind(rows);
    this.actionSheet = this.container.querySelector('.stk-actions [data-stock-panel]') ? createMobileFilters({
      container: this.container, toolbar: this.container.querySelector('.stock-search-toolbar'),
      controls: [this.container.querySelector('.stk-actions')], title: 'Stock actions', buttonLabel: 'Actions',
    }) : null;
    this.container.querySelector('.stk-actions').addEventListener('click', event => {
      const button = event.target.closest('[data-stock-panel]');
      if (!button || !window.matchMedia('(max-width: 767px)').matches) return;
      this.actionSheet?.close();
      const panel = this.container.querySelector(`#${button.getAttribute('aria-controls')}`);
      if (!panel.hidden) panel.scrollIntoView({ block: 'start' });
    });
  }

  /**
   * The owner's and store manager's own tools: a brand-new item, a few units
   * in or out, and a full stock take. Each goes through a callable that
   * enforces the same roles, so hiding them is courtesy, not security.
   */
  countPanelsHtml(rows) {
    const room = this.location === 'STORE' ? 'Store' : 'House';
    const options = rows.map((row) => `<option value="${esc(row.product.id)}">${esc(row.product.name)} — ${row.qty} in ${room}</option>`).join('');
    return `
        <section id="stk-new-panel" class="stk-card" ${this.openPanel === 'new' ? '' : 'hidden'}>
          <h3>Add new item</h3>
          <p class="stk-hint">For an item the business has never stocked. It is added to the menu catalogue and its opening stock is booked in. Already stocked? Use Add / Remove stock.</p>
          <form id="stk-new-form" class="stk-form">
            <div class="stk-field grow"><label for="stk-new-name">Name</label><input id="stk-new-name" name="name" type="text" maxlength="300" required></div>
            <div class="stk-field"><label for="stk-new-sku">SKU (optional)</label><input id="stk-new-sku" name="sku" type="text" maxlength="200"></div>
            <div class="stk-field"><label for="stk-new-category">Type</label><select id="stk-new-category" name="categoryId"><option value="">—</option>${(this.categories || []).map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('')}</select></div>
            <div class="stk-field"><label for="stk-new-price">Sell price (KES)</label><input id="stk-new-price" name="price" type="number" min="0" step="0.01" inputmode="decimal" placeholder="0 = not for sale yet"></div>
            <div class="stk-field"><label for="stk-new-qty">Opening quantity</label><input id="stk-new-qty" name="qty" type="number" min="0" step="1" inputmode="numeric" value="0"></div>
            <div class="stk-field grow"><label for="stk-new-ref">Delivery reference</label><input id="stk-new-ref" name="reason" type="text" maxlength="300"></div>
            <div class="stk-field"><button class="primary-btn" type="submit">Add item</button></div>
          </form>
        </section>
        <section id="stk-adjust-panel" class="stk-card" ${this.openPanel === 'adjust' ? '' : 'hidden'}>
          <h3>Add / Remove stock</h3>
          <p class="stk-hint">A few units in or out of the ${room}: breakage, a found crate, a return. Recorded with your reason. To recount everything, use Stock take.</p>
          <form id="stk-adjust-form" class="stk-form">
            <div class="stk-field grow"><label for="stk-adjust-product">Item</label><select id="stk-adjust-product" name="productId" required>${options}</select></div>
            <div class="stk-field"><label for="stk-adjust-dir">Change</label><select id="stk-adjust-dir" name="direction"><option value="add">Add</option><option value="remove">Remove</option></select></div>
            <div class="stk-field"><label for="stk-adjust-qty">Quantity</label><input id="stk-adjust-qty" name="qty" type="number" min="1" step="1" inputmode="numeric" required></div>
            <div class="stk-field grow"><label for="stk-adjust-reason">Reason</label><input id="stk-adjust-reason" name="reason" type="text" maxlength="250" required></div>
            <div class="stk-field"><button class="primary-btn" type="submit">Save change</button></div>
          </form>
        </section>
        <section id="stk-take-panel" class="stk-card" ${this.openPanel === 'take' ? '' : 'hidden'}>
          <h3>Stock take</h3>
          <p class="stk-hint">Count the ${room} and type what is physically there. Each figure replaces the count on file; leave an item blank if you did not count it.</p>
          <form id="stk-take-form">
            <div class="stk-table-wrap"><table class="stk-table"><thead><tr><th>Item</th><th class="num">On file</th><th class="num">Counted</th></tr></thead><tbody>
              ${rows.map((row) => `<tr><td>${esc(row.product.name)}</td><td class="num">${row.qty}</td><td class="num"><input type="text" inputmode="numeric" data-take="${esc(row.product.id)}" aria-label="Counted ${esc(row.product.name)}" style="width:6em"></td></tr>`).join('')}
            </tbody></table></div>
            <div class="stk-form" style="margin-top:12px">
              <div class="stk-field grow"><label for="stk-take-reason">Reason</label><input id="stk-take-reason" type="text" maxlength="300" placeholder="e.g. Month-end stock take" required></div>
              <div class="stk-field"><button class="primary-btn" type="submit">Submit stock take</button></div>
            </div>
          </form>
        </section>`;
  }

  bindCountPanels(rows) {
    const byId = new Map(rows.map((row) => [row.product.id, row]));
    const busy = async (form, work) => {
      const button = form.querySelector('button[type="submit"]');
      button.disabled = true;
      try { await work(); } catch (error) { this.say(error.message || 'That could not be saved.', false); } finally { button.disabled = false; }
    };
    const after = async (message) => {
      await Promise.all([pullCatalogue().catch(() => {}), this.loadMovements()]);
      this.openPanel = null;
      const search = this.search;
      await this.render();
      this.search = search;
      this.say(message, true);
    };

    const create = this.container.querySelector('#stk-new-form');
    if (create) create.onsubmit = (event) => {
      event.preventDefault();
      const data = Object.fromEntries(new FormData(create));
      const name = data.name.trim();
      const qty = Number(data.qty || 0);
      if (!name) { this.say('Give the new item a name.', false); return; }
      if (!Number.isInteger(qty) || qty < 0) { this.say('Opening quantity must be a whole number.', false); return; }
      // upsertProduct keys a product by its SKU, so re-adding an existing item
      // would quietly overwrite its price and details.
      const clash = findDuplicate(rows.map((row) => row.product), name, data.sku);
      if (clash) { this.say(`${clash.name} already exists. Use Add / Remove stock to change its count.`, false); return; }
      const priced = parseFloat(data.price) > 0;
      void busy(create, async () => {
        let product;
        try {
          product = await callFunction('upsertProduct', {
            name, sku: data.sku.trim() || `SKU-${Date.now().toString().slice(-6)}`, categoryId: data.categoryId || null,
            sellPrice: parseFloat(data.price) || 0, trackStock: true, showOnMenu: true,
          });
        } catch (error) {
          if (!String(error?.message || '').includes('Firebase is not configured')) throw error;
          product = {
            id: `prod-${crypto.randomUUID().slice(0, 8)}`,
            tenant_id: state.currentTenant?.id || 'tenant-01',
            name,
            sku: data.sku.trim() || `SKU-${Date.now().toString().slice(-6)}`,
            category_id: data.categoryId || 'cat-beers',
            sell_price: parseFloat(data.price) || 0,
            cost_price: 0,
            uom: 'EACH',
            tax_code: 'A',
            is_service: 0,
            track_stock: true,
            show_on_menu: true,
            is_active: 1,
            version: 1,
          };
          await db.products.put(product);
        }
        if (qty > 0) {
          try {
            await changeStock({ action: 'receive', branchId: state.currentBranch.id, productId: product.id, qty, reason: data.reason.trim() || 'Opening stock', requestId: crypto.randomUUID() });
          } catch (error) {
            await after(`${name} was added, but its opening stock was not booked (${error.message}). Use Add / Remove stock.`);
            return;
          }
        }
        await after(`${name} added${qty ? ` with ${qty} in stock` : ''}.${priced ? '' : ' Set its price in Menu Admin before selling it.'}`);
      });
    };

    const adjust = this.container.querySelector('#stk-adjust-form');
    if (adjust) adjust.onsubmit = (event) => {
      event.preventDefault();
      const data = Object.fromEntries(new FormData(adjust));
      const row = byId.get(data.productId);
      if (!row) return;
      const target = adjustTarget(row.qty, data.direction, data.qty);
      if (target.error) { this.say(target.error, false); return; }
      if (!data.reason.trim()) { this.say('Give a reason; it is recorded against the change.', false); return; }
      this.submit({
        action: 'adjust', productId: row.product.id, qty: target.qty, location: this.location, expectedQty: row.qty,
        reason: `${data.direction === 'add' ? 'Added' : 'Removed'} ${data.qty}: ${data.reason.trim()}`,
      }, adjust.querySelector('button[type="submit"]'));
    };

    const take = this.container.querySelector('#stk-take-form');
    if (take) take.onsubmit = (event) => {
      event.preventDefault();
      const counts = Object.fromEntries([...take.querySelectorAll('[data-take]')].map((input) => [input.dataset.take, input.value]));
      const result = stockTakeRows(rows.map((row) => row.product), counts);
      if (result.error) { this.say(result.error, false); return; }
      const reason = take.querySelector('#stk-take-reason').value.trim();
      if (!reason) { this.say('A stock take needs a reason.', false); return; }
      void busy(take, async () => {
        const batch = crypto.randomUUID().replace(/-/g, '').slice(0, 20);
        let counted = 0;
        const skipped = [];
        for (let start = 0; start < result.rows.length; start += 150) {
          const done = await importStock({ mode: 'count', branchId: state.currentBranch.id, location: this.location, reason, createMissing: false, batchId: `${batch}${start}`, rows: result.rows.slice(start, start + 150) });
          counted += done.imported;
          skipped.push(...done.rejected);
        }
        await after(`Stock take saved: ${counted} item(s) counted.${skipped.length ? ` ${skipped.length} skipped: ${skipped.slice(0, 3).map((r) => `${r.sku} (${r.message})`).join('; ')}` : ''}`);
      });
    };
  }

  /** Pending House requests; nothing is shown without a Store to request from. */
  async loadRequests() {
    if (!storeIsEnabled()) { this.requests = []; return; }
    const [requests, users] = await Promise.all([pullStockRequests(state.currentBranch?.id), db.users.toArray()]);
    const names = new Map(users.map((user) => [user.id, user.name]));
    this.requests = requests.map((r) => ({ ...r, who: names.get(r.requestedByStaffId) || r.requestedByStaffId || '—' }));
  }

  requestsHtml() {
    const list = this.requests;
    if (!storeIsEnabled() || list === undefined || (Array.isArray(list) && !list.length)) return '<section id="stk-requests" hidden></section>';
    if (list === null) return '<section id="stk-requests" class="stk-card"><p class="stk-empty">Pending requests could not be read. Refresh when connected.</p></section>';
    const stageBadge = (status) => {
      if (status === 'approved_for_dispatch') {
        return '<span style="display:inline-block;background:rgba(232,165,53,0.18);color:#e8a535;border:1px solid rgba(232,165,53,0.45);padding:3px 9px;border-radius:999px;font-size:11px;font-weight:800;">2 · Approved by Supervisor · Ready for Storeman Dispatch</span>';
      }
      if (status === 'dispatched') {
        return '<span style="display:inline-block;background:rgba(16,185,129,0.18);color:#6ee7b7;border:1px solid rgba(16,185,129,0.4);padding:3px 9px;border-radius:999px;font-size:11px;font-weight:800;">3 · Dispatched by Storeman · Ready for Barman to Accept</span>';
      }
      return '<span style="display:inline-block;background:rgba(255,255,255,0.07);color:#d1c3b0;border:1px solid rgba(200,130,42,0.28);padding:3px 9px;border-radius:999px;font-size:11px;font-weight:700;">1 · Awaiting Supervisor Approval</span>';
    };
    const actionCell = (r) => {
      const id = esc(r.id);
      if (r.status === 'pending') {
        return this.canApprove
          ? `<button type="button" class="primary-btn" style="padding:6px 12px;font-size:12px;" data-decide="approve" data-request="${id}">✓ Supervisor Approve</button> <button type="button" class="stk-edit" data-decide="reject" data-request="${id}">Reject</button>`
          : '<span style="font-size:12px;color:var(--text-secondary);">Waiting for Supervisor approval</span>';
      }
      if (r.status === 'approved_for_dispatch') {
        return this.canDispatch
          ? `<button type="button" class="primary-btn" style="padding:6px 12px;font-size:12px;" data-decide="dispatch" data-request="${id}">📦 Dispatch to House</button>`
          : '<span style="font-size:12px;color:var(--text-secondary);">Approved — waiting for Storeman to dispatch</span>';
      }
      if (r.status === 'dispatched') {
        return this.canAccept
          ? `<button type="button" class="primary-btn" style="padding:6px 12px;font-size:12px;" data-decide="accept" data-request="${id}">✓ Accept New Stock into House</button>`
          : '<span style="font-size:12px;color:var(--text-secondary);">Dispatched — waiting for Barman to accept in House</span>';
      }
      return '';
    };
    return `<section id="stk-requests" class="stk-card">
      <h3>Stock Transfer Queue — Store → House (${list.length})</h3>
      <p class="stk-hint">Workflow: 1) Barman requests stock → 2) Supervisor approves → 3) Storeman dispatches from Store → 4) Barman accepts new stock into House.</p>
      <div class="stk-table-wrap"><table class="stk-table">
        <thead><tr><th>Item</th><th class="num">Qty</th><th>Requested by</th><th>Stage</th><th>Note</th><th style="text-align:right">Action</th></tr></thead>
        <tbody>${list.map((r) => `<tr>
          <td><strong>${esc(r.productName || r.productId)}</strong></td>
          <td class="num">${Number(r.qty)}</td>
          <td>${esc(r.who)}</td>
          <td>${stageBadge(r.status)}</td>
          <td>${esc(r.note || '—')}</td>
          <td style="text-align:right;white-space:nowrap">${actionCell(r)}</td>
        </tr>`).join('')}</tbody>
      </table></div>
    </section>`;
  }

  /** The trail, or an honest line about why it is not there. */
  movementsHtml() {
    if (this.movements === undefined) return '<p class="stk-empty">Movement history has not refreshed yet.</p>';
    if (this.movements === null) return '<p class="stk-empty">The movement trail could not be read. Check your connection and reopen this screen.</p>';
    if (!this.movements?.length) return '<p class="stk-empty">Nothing has moved on this branch yet.</p>';
    return `<div class="stk-table-wrap">
      <table class="stk-table">
        <thead><tr><th>When</th><th>Item</th><th>What happened</th><th class="num">Change</th><th>Room</th><th>By</th></tr></thead>
        <tbody>${this.movements.map((move) => `
          <tr>
            <td>${esc(move.when ? move.when.toLocaleString() : '—')}</td>
            <td>${esc(move.item)}</td>
            <td>${esc(move.type)}</td>
            <td class="num ${move.qty < 0 ? 'stk-low' : ''}">${move.qty > 0 ? '+' : ''}${move.qty}</td>
            <td>${esc(move.location)}</td>
            <td>${esc(move.who)}</td>
          </tr>`).join('')}</tbody>
      </table>
    </div>`;
  }

  rowsHtml(rows) {
    const requesting = this.action === 'request';
    const needle = this.search.trim().toLowerCase();
    const shown = needle ? rows.filter((row) => row.product.name.toLowerCase().includes(needle)) : rows;
    if (!shown.length) {
      return `<tr><td colspan="4" class="stk-empty">No items match “${esc(this.search)}”.</td></tr>`;
    }
    return shown.map((row) => `
      <tr>
        <td class="stock-item-name">${esc(row.product.name)}</td>
        ${requesting ? `<td data-label="In Store" class="num ${row.storeQty ? '' : 'stk-zero'}">${row.storeQty}</td>` : ''}
        <td data-label="${this.location === 'STORE' ? 'In Store' : 'In House'}" class="num ${row.qty ? '' : 'stk-zero'}">${row.qty}${row.reservedQty ? ` <span class="stk-low">(${row.reservedQty} held)</span>` : ''}</td>
        ${this.canCount ? `<td class="stock-item-action" style="text-align:right"><button type="button" class="stk-edit" aria-label="Fix the count for ${esc(row.product.name)} (one item, not a stock take)" data-correct="${esc(row.product.id)}" data-qty="${row.qty}" data-name="${esc(row.product.name)}">Fix count</button></td>` : ''}
      </tr>`).join('');
  }

  /**
   * Books a spreadsheet in.
   *
   * One batch id per file, so re-sending the same sheet after a lost response
   * replays the same movements rather than doubling the delivery.
   */
  bindImport() {
    const trigger = this.container.querySelector('#stk-import-btn');
    const picker = this.container.querySelector('#stk-import-file');
    const report = this.container.querySelector('#stk-import-report');
    if (!trigger || !picker || !report) return;

    const note = (html, tone) => {
      report.innerHTML = `<p class="stk-msg ${tone}" style="margin-top:12px">${html}</p>`;
    };

    trigger.addEventListener('click', () => picker.click());
    this.container.querySelector('#stk-template-btn')
      ?.addEventListener('click', () => downloadCsvTemplate(STOCK_TEMPLATE_CSV, 'stock-import-template.csv'));
    picker.addEventListener('change', async () => {
      const file = picker.files && picker.files[0];
      if (!file) return;
      picker.value = '';
      const mode = this.container.querySelector('#stk-import-mode').value;
      const reason = this.container.querySelector('#stk-import-reason').value.trim();
      if (mode === 'count' && !reason) { note('A count rewrites the figure, so it needs a reason.', 'bad'); return; }

      note(`Reading ${esc(file.name)}…`, '');
      const parsed = await parseStockFile(file);
      if (parsed.error) { note(esc(parsed.error), 'bad'); return; }
      if (!parsed.rows.length) { note('That sheet had no rows under its header.', 'bad'); return; }

      trigger.disabled = true;
      const batchId = crypto.randomUUID();
      const totals = { imported: 0, created: 0, rejected: [] };
      try {
        // Firestore takes 500 writes to a batch, so a real delivery arrives in
        // chunks; each chunk carries its own id and commits on its own.
        for (let start = 0; start < parsed.rows.length; start += 150) {
          const chunk = parsed.rows.slice(start, start + 150);
          note(`Booking ${Math.min(start + 150, parsed.rows.length)} of ${parsed.rows.length}…`, '');
          const result = await importStock({
            mode, branchId: state.currentBranch.id, location: this.location, reason, createMissing: false,
            batchId: `${batchId.replace(/-/g, '').slice(0, 20)}${start}`,
            rows: chunk.map((row) => ({ sku: row.sku || '', name: row.name || '', qty: Number(row.qty) })),
          });
          totals.imported += result.imported;
          totals.created += result.created || 0;
          totals.rejected.push(...result.rejected);
        }
        await Promise.all([pullCatalogue(), this.loadMovements()]);
        const search = this.search;
        await this.render();
        this.search = search;
        const rejected = totals.rejected.length
          ? `<br><b>${totals.rejected.length} row(s) skipped:</b><br>${totals.rejected.slice(0, 8).map((r) => `${esc(r.sku)}: ${esc(r.message)}`).join('<br>')}${totals.rejected.length > 8 ? `<br>and ${totals.rejected.length - 8} more` : ''}`
          : '';
        this.container.querySelector('#stk-import-report').innerHTML =
          `<p class="stk-msg ${totals.imported ? 'ok' : 'bad'}" style="margin-top:12px"><b>${totals.imported} item(s) ${mode === 'count' ? 'counted' : 'received'} in ${this.location === 'STORE' ? 'Store' : 'House'}.</b>${totals.created ? `<br>${totals.created} new stock-only item(s) created.` : ''}${rejected}</p>`;
      } catch (error) {
        note(esc(error.message || 'That sheet could not be booked in.'), 'bad');
      } finally {
        const button = this.container.querySelector('#stk-import-btn');
        if (button) button.disabled = false;
      }
    });
  }

  bind(rows) {
    this.container.querySelector('#stk-refresh').onclick = () => void this.refresh();
    this.container.querySelectorAll('[data-stock-panel]').forEach((button) => {
      button.onclick = () => {
        this.openPanel = this.openPanel === button.dataset.stockPanel ? null : button.dataset.stockPanel;
        this.container.querySelectorAll('[data-stock-panel]').forEach((toggle) => {
          const open = toggle.dataset.stockPanel === this.openPanel;
          toggle.setAttribute('aria-expanded', String(open));
          this.container.querySelector(`#${toggle.getAttribute('aria-controls')}`).hidden = !open;
        });
      };
    });
    this.bindImport();
    this.bindCountPanels(rows);
    // Delegated, because a refresh swaps the list without re-binding.
    this.container.onclick = async (event) => {
      const button = event.target.closest('[data-decide]');
      if (!button) return;
      const decision = button.dataset.decide;
      const allowed =
        (decision === 'approve' || decision === 'reject') ? this.canApprove
        : decision === 'dispatch' ? this.canDispatch
        : decision === 'accept' ? this.canAccept
        : false;
      if (!allowed) return;
      const reason = decision === 'reject' ? window.prompt('Why is this request rejected? (shown in the audit trail)') : '';
      if (reason === null) return;
      button.disabled = true;
      try {
        const result = await decideStockRequest(button.dataset.request, decision, reason || undefined);
        const refreshes = await Promise.allSettled([this.loadRequests(), this.loadMovements()]);
        const search = this.search;
        await this.render();
        this.search = search;
        const outcome = result.status === 'approved_for_dispatch'
          ? 'Approved by Supervisor. Ready for Storeman to dispatch from Store Stock.'
          : result.status === 'dispatched'
          ? `Dispatched from Store (Store now ${result.storeQty}). Waiting for Barman to accept into House Stock.`
          : result.status === 'accepted'
          ? `Accepted into House Stock. House now ${result.qty}, Store ${result.storeQty}.`
          : result.status === 'approved'
          ? Number.isFinite(result.qty) ? `Approved. House now ${result.qty}, Store ${result.storeQty}.` : 'This request was already approved.'
          : 'Request rejected.';
        const warning = result.refreshWarning || (refreshes.some(read => read.status === 'rejected') ? 'Saved, but some stock details could not refresh. Refresh when connected.' : '');
        this.say([outcome, warning].filter(Boolean).join(' '), true);
      } catch (error) {
        button.disabled = false;
        this.say(error.message || 'That request could not be processed.', false);
      }
    };
    const search = this.container.querySelector('#stk-search');
    search.oninput = (event) => {
      this.search = event.target.value;
      this.container.querySelector('#stk-body').innerHTML = this.rowsHtml(this.currentRows || rows);
    };

    const form = this.container.querySelector('#stk-form');
    const productSearch = this.container.querySelector('#stk-product-search');
    if (productSearch) {
      const select = this.container.querySelector('#stk-product');
      const options = Array.from(select.options);
      productSearch.oninput = () => {
        const needle = productSearch.value.trim().toLowerCase();
        const selected = select.value;
        const matches = options.filter((option, index) => {
          const product = rows[index].product;
          return `${product.name} ${product.sku || ''}`.toLowerCase().includes(needle);
        });
        select.replaceChildren(...matches);
        if (matches.some((option) => option.value === selected)) select.value = selected;
        if (!matches.length) {
          const empty = new Option('No matching products', '');
          empty.disabled = true;
          select.add(empty);
          select.value = '';
        }
        form.querySelector('button[type="submit"]').disabled = matches.length === 0;
      };
    }
    if (form) form.onsubmit = (event) => {
      event.preventDefault();
      const data = Object.fromEntries(new FormData(form));
      this.submit({ action: this.action, productId: data.productId, qty: Number(data.qty), reason: data.reason }, form.querySelector('button'));
    };

    // Correcting a count is a rewrite of history, so it belongs to the two
    // roles that answer for both rooms - the owner and the store manager - and
    // never goes through without a reason recorded against it.
    this.container.querySelector('#stk-body').onclick = (event) => {
      const button = event.target.closest('[data-correct]');
      if (!button) return;
      const counted = window.prompt(`Counted quantity for ${button.dataset.name} in ${this.location.toLowerCase()}:`, button.dataset.qty);
      if (counted === null) return;
      const reason = window.prompt('Reason for this correction (recorded in the audit trail):');
      if (!reason?.trim()) {
        this.say('A correction needs a reason. Nothing was changed.', false);
        return;
      }
      this.submit({
        action: 'adjust', productId: button.dataset.correct, qty: Number(counted),
        location: this.location, expectedQty: Number(button.dataset.qty), reason: reason.trim(),
      }, button);
    };
  }

  say(text, ok) {
    const message = this.container.querySelector('#stk-msg');
    // The line lives in the delivery panel; with that panel shut, say it as a toast instead.
    if (message && !message.closest('[hidden]')) { message.textContent = text; message.className = `stk-msg ${ok ? 'ok' : 'bad'}`; }
    else showNotification(text, ok ? 'success' : 'error');
  }

  /**
   * One request id per distinct attempt, so a retry after a lost response
   * replays the same change rather than applying it twice.
   */
  async submit(payload, button) {
    if (!Number.isInteger(payload.qty) || payload.qty < (payload.action === 'adjust' ? 0 : 1)) {
      this.say('Enter a whole-number quantity.', false);
      return;
    }
    button.disabled = true;
    const body = { ...payload, branchId: state.currentBranch.id, requestedByStaffId: state.currentUser?.id };
    const signature = JSON.stringify(body);
    if (this.attempt?.signature !== signature) this.attempt = { signature, requestId: crypto.randomUUID() };
    try {
      const result = await changeStock({ ...body, requestId: this.attempt.requestId });
      this.attempt = null;
      if (payload.action === 'request') await this.loadRequests().catch(() => { this.requests = null; });
      const search = this.search;
      await this.render();
      this.search = search;
      this.say(
        (payload.action === 'request' && result.status === 'pending'
          ? 'Requested. Waiting for the Supervisor to approve before Storeman dispatches.'
          : payload.action === 'request'
          ? `Moved into the House. House now ${result.qty}, Store ${result.storeQty}.`
          : `Saved. ${this.location === 'STORE' ? 'Store' : 'House'} now ${result.qty}.`)
          + (result.refreshWarning ? ` ${result.refreshWarning}` : ''),
        true,
      );
    } catch (error) {
      this.say(error.message, false);
      button.disabled = false;
    }
  }
}
