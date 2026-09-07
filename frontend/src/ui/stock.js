import { db } from '../db/schema';
import { state } from '../context';
import { pullStock, changeStock, storeIsEnabled, pullStockMovements, importStock } from '../services/stock';
import { parseStockFile } from '../services/csv';
import { escapeHtml as esc } from '../services/print-receipt';

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
  }

  get isOwner() { return state.currentUser?.role === 'Owner'; }
  /** Booking a delivery is a goods-received decision; pulling stock is service. */
  get canWrite() {
    const role = state.currentUser?.role;
    if (this.action === 'request') return ['Owner', 'Store Manager', 'Store Keeper', 'Bar Staff'].includes(role);
    return ['Owner', 'Store Manager', 'Store Keeper'].includes(role);
  }
  get canImport() { return ['Owner', 'Store Manager', 'Store Keeper'].includes(state.currentUser?.role); }

  /** What this room can do depends on whether a Store exists at all. */
  get action() {
    if (this.location === 'STORE') return 'receive';
    return storeIsEnabled() ? 'request' : 'receive';
  }

  async load() {
    this.container.innerHTML = '<div class="stk-wrap"><p>Loading stock…</p></div>';
    try {
      await pullStock();
      await this.loadMovements();
      await this.render();
    } catch {
      this.container.innerHTML = '<div class="stk-wrap"><p>Stock is unavailable. Check your connection and reopen this screen.</p></div>';
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
      this.movements = moves.map((move) => ({
        when: move.createdAt?.toDate?.() || null,
        item: items.get(move.productId) || move.productId,
        location: move.location,
        qty: Number(move.qty || 0),
        type: MOVEMENT_LABELS[move.type] || move.type,
        who: names.get(move.createdByStaffId) || move.createdByStaffId || '—',
      }));
    } catch {
      this.movements = null;
    }
  }

  async rows() {
    const products = await db.products
      .filter((p) => !p.is_service && p.is_active !== 0 && p.tenant_id === state.currentTenant?.id)
      .toArray();
    const balances = await db.stock_balances.where('branchId').equals(state.currentBranch.id).toArray();
    const here = new Map(balances.filter((b) => b.location === this.location).map((b) => [b.productId, b]));
    const store = new Map(balances.filter((b) => b.location === 'STORE').map((b) => [b.productId, b]));
    return products.map((product) => ({
      product,
      qty: Number(here.get(product.id)?.qty || 0),
      storeQty: Number(store.get(product.id)?.qty || 0),
    })).sort((a, b) => a.product.name.localeCompare(b.product.name));
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
        blurb: 'What service can actually reach. Sales come out of here. Top it up by requesting from the Store — the stock moves immediately, with no approval step.',
        formTitle: 'Request from the Store',
        formHint: 'Moves stock out of the Store and into the House in one step. Both sides are recorded.',
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

  async render() {
    const rows = await this.rows();
    const copy = this.copy();
    const requesting = this.action === 'request';

    this.container.innerHTML = `
      <div class="stk-wrap">
        <div class="stk-head">
          <h2>${copy.title}</h2>
          <p>${copy.blurb}</p>
        </div>

        ${this.canWrite ? `
        <section class="stk-card">
          <h3>${copy.formTitle}</h3>
          <p class="stk-hint">${copy.formHint}</p>
          <form id="stk-form" class="stk-form">
            <div class="stk-field grow">
              <label for="stk-product">Item</label>
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

        <input id="stk-search" class="stk-search stk-field" type="search" placeholder="Search items" aria-label="Search items" value="${esc(this.search)}">

        <div class="stk-table-wrap">
          <table class="stk-table">
            <thead>
              <tr>
                <th>Item</th>
                ${requesting ? '<th class="num">In Store</th>' : ''}
                <th class="num">${this.location === 'STORE' ? 'In Store' : 'In House'}</th>
                ${this.isOwner ? '<th></th>' : ''}
              </tr>
            </thead>
            <tbody id="stk-body">${this.rowsHtml(rows)}</tbody>
          </table>
        </div>

        ${this.canImport ? `
        <section class="stk-card" style="margin-top:18px">
          <h3>Import from a spreadsheet</h3>
          <p class="stk-hint">A delivery note or a stock take, as CSV or Excel. It needs an item column (SKU or name) and a quantity column; anything else is ignored.</p>
          <div class="stk-form">
            <div class="stk-field">
              <label for="stk-import-mode">This sheet is</label>
              <select id="stk-import-mode">
                <option value="receive">A delivery — add to what is here</option>
                ${this.isOwner ? '<option value="count">A count — set the figure exactly</option>' : ''}
              </select>
            </div>
            <div class="stk-field grow">
              <label for="stk-import-reason">Reference / reason</label>
              <input id="stk-import-reason" type="text" maxlength="300" placeholder="Delivery note number, or why you are recounting">
            </div>
            <div class="stk-field">
              <button type="button" class="primary-btn" id="stk-import-btn">Choose file…</button>
              <input id="stk-import-file" type="file" accept=".csv,.xlsx,text/csv" hidden>
            </div>
          </div>
          <div id="stk-import-report"></div>
        </section>` : ''}

        <section class="stk-card" style="margin-top:18px">
          <h3>Movements</h3>
          <p class="stk-hint">Every delivery, request and correction on this branch, newest first — both rooms, so the two screens reconcile against each other.</p>
          ${this.movementsHtml()}
        </section>
      </div>`;

    this.bind(rows);
  }

  /** The trail, or an honest line about why it is not there. */
  movementsHtml() {
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
        <td>${esc(row.product.name)}</td>
        ${requesting ? `<td class="num ${row.storeQty ? '' : 'stk-zero'}">${row.storeQty}</td>` : ''}
        <td class="num ${row.qty ? '' : 'stk-zero'}">${row.qty}${row.reservedQty ? ` <span class="stk-low">(${row.reservedQty} held)</span>` : ''}</td>
        ${this.isOwner ? `<td style="text-align:right"><button type="button" class="stk-edit" data-correct="${esc(row.product.id)}" data-qty="${row.qty}" data-name="${esc(row.product.name)}">Correct</button></td>` : ''}
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
      const totals = { imported: 0, rejected: [] };
      try {
        // Firestore takes 500 writes to a batch, so a real delivery arrives in
        // chunks; each chunk carries its own id and commits on its own.
        for (let start = 0; start < parsed.rows.length; start += 250) {
          const chunk = parsed.rows.slice(start, start + 250);
          note(`Booking ${Math.min(start + 250, parsed.rows.length)} of ${parsed.rows.length}…`, '');
          const result = await importStock({
            mode, branchId: state.currentBranch.id, location: this.location, reason,
            batchId: `${batchId.replace(/-/g, '').slice(0, 20)}${start}`,
            rows: chunk.map((row) => ({ sku: row.sku || row.name, qty: Number(row.qty) })),
          });
          totals.imported += result.imported;
          totals.rejected.push(...result.rejected);
        }
        await this.loadMovements();
        const search = this.search;
        await this.render();
        this.search = search;
        const rejected = totals.rejected.length
          ? `<br><b>${totals.rejected.length} row(s) skipped:</b><br>${totals.rejected.slice(0, 8).map((r) => `${esc(r.sku)}: ${esc(r.message)}`).join('<br>')}${totals.rejected.length > 8 ? `<br>and ${totals.rejected.length - 8} more` : ''}`
          : '';
        this.container.querySelector('#stk-import-report').innerHTML =
          `<p class="stk-msg ${totals.imported ? 'ok' : 'bad'}" style="margin-top:12px"><b>${totals.imported} item(s) ${mode === 'count' ? 'counted' : 'received'}.</b>${rejected}</p>`;
      } catch (error) {
        note(esc(error.message || 'That sheet could not be booked in.'), 'bad');
      } finally {
        const button = this.container.querySelector('#stk-import-btn');
        if (button) button.disabled = false;
      }
    });
  }

  bind(rows) {
    this.bindImport();
    const search = this.container.querySelector('#stk-search');
    search.oninput = (event) => {
      this.search = event.target.value;
      this.container.querySelector('#stk-body').innerHTML = this.rowsHtml(rows);
    };

    const form = this.container.querySelector('#stk-form');
    if (form) form.onsubmit = (event) => {
      event.preventDefault();
      const data = Object.fromEntries(new FormData(form));
      this.submit({ action: this.action, productId: data.productId, qty: Number(data.qty), reason: data.reason }, form.querySelector('button'));
    };

    // Correcting a count is a rewrite of history, so it is the owner's alone
    // and never goes through without a reason recorded against it.
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
    if (message) { message.textContent = text; message.className = `stk-msg ${ok ? 'ok' : 'bad'}`; }
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
    const body = { ...payload, branchId: state.currentBranch.id };
    const signature = JSON.stringify(body);
    if (this.attempt?.signature !== signature) this.attempt = { signature, requestId: crypto.randomUUID() };
    try {
      const result = await changeStock({ ...body, requestId: this.attempt.requestId });
      this.attempt = null;
      const search = this.search;
      await this.render();
      this.search = search;
      this.say(
        payload.action === 'request'
          ? `Moved into the House. House now ${result.qty}, Store ${result.storeQty}.`
          : `Saved. ${this.location === 'STORE' ? 'Store' : 'House'} now ${result.qty}.`,
        true,
      );
    } catch (error) {
      this.say(error.message, false);
      button.disabled = false;
    }
  }
}
