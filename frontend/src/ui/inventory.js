import { db } from '../db/schema';
import { getStockOnHand, getHouseStock, logAuditEvent } from '../db/index';
import { pullStock, importStock, stockLocations } from '../services/stock';
import { saveStockCount } from '../services/stock-counts';
import { state, showNotification } from '../context';
import { bindPager, pagerHtml, paginate } from '../services/paginate';
import {
  PRODUCT_NAMES_TEMPLATE_CSV,
  PRODUCT_TEMPLATE_CSV,
  downloadCsvTemplate,
  ensureUniqueSkus,
  parseProductFile
} from '../services/csv';
import { callFunction } from '../services/firebase';
import { pullCatalogue, pullIdentity, compareNames } from '../services/catalogue';
import { escapeHtml } from '../services/print-receipt';
import { createMobileFilters } from './mobile-filters';

export class InventoryView {
  constructor(container) {
    this.container = container;
    this.activeSubTab = 'ledger'; // ledger, takes, expiries
    this.ledgerPage = 1;
    this.ledgerSearch = '';
  }

  async load() {
    this.render();
    this.bindEvents();
    // The ledger reads this device's cache while the customer menu is served
    // from the server, so without pulling first this screen can show one price
    // and the QR menu another - and this is the screen people trust.
    const reads = await Promise.allSettled([pullCatalogue(), pullStock(), pullIdentity()]);
    if (reads.some(result => result.status === 'rejected')) {
      showNotification('Showing this till\'s cached menu - the server catalogue could not be read.', 'warning');
    }
    if (!this.disposed) await this.loadSubTab();
  }

  dispose() { this.disposed = true; this.actionSheet?.dispose(); }

  render() {
    this.container.innerHTML = `
      <div class="view-header">
        <h2>Inventory & Stock Control</h2>
      </div>

      <div class="split-pane">
        <!-- Sidebar Navigation -->
        <div class="pane-nav">
          <button class="pane-nav-btn active" data-sub="ledger">Stock Ledger</button>
          <button class="pane-nav-btn" data-sub="takes">Stock Takes (Counts)</button>
          <button class="pane-nav-btn" data-sub="expiries">Batch & Expiries</button>
        </div>

        <!-- Working Area -->
        <div class="pane-content" id="inventory-pane-content">
          <!-- Loaded dynamically -->
        </div>
      </div>
    `;
  }

  bindEvents() {
    this.container.querySelectorAll('.pane-nav-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        this.container.querySelectorAll('.pane-nav-btn').forEach(b => b.classList.remove('active'));
        e.target.classList.add('active');
        this.activeSubTab = e.target.getAttribute('data-sub');
        this.loadSubTab();
      });
    });
  }

  /**
   * Menu Admin is readable by supervisors and store keepers, but the catalogue
   * callables are owner and manager only. Without this the form filled in, the
   * save was pressed, and only then did the server say no.
   */
  get canEditCatalogue() {
    return ['Owner', 'Store Manager'].includes(state.currentUser?.role);
  }

  /** Counted and on-menu are stock decisions, so a keeper may flip them. */
  get canFlagProducts() {
    return ['Owner', 'Store Manager', 'Store Keeper'].includes(state.currentUser?.role);
  }

  async loadSubTab() {
    if (this.disposed) return;
    this.actionSheet?.dispose(); this.actionSheet = null;
    const pane = document.getElementById('inventory-pane-content');
    
    if (this.activeSubTab === 'ledger') {
      await this.renderLedger(pane);
    } else if (this.activeSubTab === 'takes') {
      await this.renderTakes(pane);
    } else if (this.activeSubTab === 'expiries') {
      await this.renderExpiries(pane);
    }
  }

  /**
   * Quantity columns the menu import does not read.
   *
   * A stock export carries these next to the prices, so the same sheet looks
   * like it should set counts too. It does not - counts are booked in the stock
   * screens - and saying so beats leaving somebody to find every count still
   * at zero afterwards.
   */
  static IGNORED_QTY = new Set([
    'qty', 'quantity', 'count', 'counted', 'onhand', 'stock',
    'storestock', 'housestock', 'instock', 'balance', 'units', 'pieces'
  ]);

  /**
   * Catalogue import from whatever spreadsheet the restaurant already keeps.
   *
   * The mapping it guessed is reported back alongside the result, because a
   * column read as the wrong field is the failure that looks like a success.
   */
  bindImportEvents(pane) {
    const trigger = document.getElementById('ledg-import-btn');
    const picker = document.getElementById('ledg-import-file');
    const report = document.getElementById('ledg-import-report');
    if (!trigger || !picker || !report) return;

    trigger.addEventListener('click', () => picker.click());

    document.getElementById('ledg-template-btn')
      ?.addEventListener('click', () => downloadCsvTemplate(PRODUCT_TEMPLATE_CSV, 'menu-import-template.csv'));
    // Names only: for bringing a list of items onto the till before anyone has
    // decided what they cost. They land unpriced and off the menu.
    document.getElementById('ledg-names-template-btn')
      ?.addEventListener('click', () => downloadCsvTemplate(PRODUCT_NAMES_TEMPLATE_CSV, 'item-names-template.csv'));

    picker.addEventListener('change', async () => {
      const file = picker.files && picker.files[0];
      if (!file) return;
      picker.value = '';

      const note = (html, colour) => {
        report.innerHTML = `<div style="margin:12px 0;padding:14px 16px;border:1px solid ${colour};border-radius:8px;font-size:13px;line-height:1.6;">${html}</div>`;
      };

      note(`Reading ${file.name}...`, 'var(--border-color)');

      const parsed = await parseProductFile(file);
      if (parsed.error) {
        note(`<b style="color:var(--accent-rose)">Could not read that file.</b><br>${parsed.error}`, 'var(--accent-rose)');
        return;
      }
      if (parsed.rows.length === 0) {
        note('<b style="color:var(--accent-rose)">That file had no product rows.</b>', 'var(--accent-rose)');
        return;
      }

      // Products are stored under their SKU, so a column that repeats would
      // collapse hundreds of different items onto one record.
      const { rows, generated, duplicates } = ensureUniqueSkus(parsed.rows);
      const mapping = parsed.mapping;

      const columns = Object.entries(mapping)
        .map(([field, header]) => `${field} &larr; <b>${header}</b>`)
        .join(' &middot; ');

      // A file whose price column is not recognised imports every row and
      // changes no price, which reads at a glance as a successful reprice.
      const warnings = [];
      if (!mapping.sellPrice) {
        warnings.push(
          '<b style="color:var(--accent-amber)">No price column was recognised, so no prices will change.</b><br>'
            + `Headers read: <b>${parsed.headers.join(', ')}</b>. `
            + 'Name the column Price, Sell Price or Menu Price and import again.'
        );
      }
      // Quantities belong to the stock screens; a delivery sheet sent here
      // would otherwise appear to import and leave every count untouched.
      const qtyHeader = parsed.headers.find((header) => InventoryView.IGNORED_QTY.has(
        String(header || '').toLowerCase().replace(/[^a-z]/g, '')
      ));
      if (qtyHeader) {
        warnings.push(
          `<b style="color:var(--accent-amber)">The "${qtyHeader}" column is ignored here.</b> `
            + 'This screen imports the menu - names, prices, categories. '
            + 'Stock counts are booked in Store Stock or House Stock, so quantities stay as they are.'
        );
      }

      // A Firestore batch holds 500 writes, so a real menu arrives in chunks.
      // Each one commits on its own: a failure part way through keeps whatever
      // already landed, and re-running the file is an upsert either way.
      const CHUNK = 500;
      const totals = { imported: 0, created: 0, updated: 0, illustrated: 0, repriced: [], unpriced: [], rejected: [] };
      let failure = null;
      // Stamped on everything this file writes, so afterwards the server can
      // tell the menu this sheet describes from whatever else is sitting there.
      const batchId = crypto.randomUUID();

      for (let start = 0; start < rows.length; start += CHUNK) {
        const chunk = rows.slice(start, start + CHUNK);
        note(
          `Importing ${Math.min(start + CHUNK, rows.length)} of ${rows.length}...`
            + `<br><span style="color:var(--text-muted)">${columns}</span>`,
          'var(--border-color)',
        );

        try {
          const result = await callFunction('importProducts', { rows: chunk, batchId });
          totals.imported += result.imported;
          totals.created += result.created || 0;
          totals.updated += result.updated || 0;
          totals.illustrated += result.illustrated || 0;
          for (const change of (result.repriced || [])) totals.repriced.push(change);
          // Row numbers come back relative to the chunk; restate them against
          // the file the person is actually looking at.
          for (const issue of result.unpriced) totals.unpriced.push({ ...issue, row: issue.row + start });
          for (const issue of result.rejected) totals.rejected.push({ ...issue, row: issue.row + start });
        } catch (err) {
          failure = err.message || String(err);
          break;
        }
      }

      const money = (minor) => `KES ${(minor / 100).toFixed(2)}`;
      const lines = [
        `<b style="color:${totals.imported ? 'var(--accent-green)' : 'var(--accent-rose)'}">`
          + `Imported ${totals.imported} of ${rows.length} products`
          + ` &mdash; ${totals.updated} updated, ${totals.created} new.</b>`,
        `<span style="color:var(--text-muted)">${columns}</span>`,
        ...warnings
      ];

      if (totals.illustrated) {
        lines.push(
          `<span style="color:var(--text-muted)">${totals.illustrated} products were given a picture from their name. `
            + 'The rest show a placeholder until one is set on the product.</span>'
        );
      }

      // Every row landing as new, on a till that already has a menu, means the
      // sheet is not lining up with what is here rather than that the menu is
      // genuinely all new.
      if (totals.created > 0 && totals.updated === 0 && totals.created === totals.imported) {
        lines.push(
          '<span style="color:var(--text-muted)">Nothing in this file matched a product already on this till, '
            + 'so every row came in as a new item. If it was meant to update the existing menu, '
            + 'the names in the file do not match the names here.</span>'
        );
      }

      // The point of re-importing a sheet is usually the prices, so say which
      // ones actually moved rather than only that the file went through.
      if (totals.repriced.length) {
        lines.push(
          `<b style="color:var(--accent-cyan)">${totals.repriced.length} price${totals.repriced.length === 1 ? '' : 's'} changed:</b><br>`
            + totals.repriced.slice(0, 15).map((change) =>
              `${change.name}: ${money(change.fromMinor)} &rarr; <b>${money(change.toMinor)}</b>`).join('<br>')
            + (totals.repriced.length > 15 ? `<br>and ${totals.repriced.length - 15} more` : '')
        );
      } else if (totals.updated) {
        lines.push('<span style="color:var(--text-muted)">No prices changed - the sheet matched what is already on the till.</span>');
      }

      if (failure) {
        lines.push(`<b style="color:var(--accent-rose)">Stopped early:</b> ${failure}. Anything already imported was kept - re-run the file to continue.`);
      }
      if (generated) {
        lines.push(
          `<b style="color:var(--accent-amber)">The ${mapping.sku ? `"${mapping.sku}"` : 'SKU'} column is not unique per product.</b> `
            + `${generated} products were given a numbered code so they were not merged into one another. `
            + 'Give the file real product codes if you want tidier SKUs.'
        );
      }
      if (duplicates) {
        lines.push(`<span style="color:var(--text-muted)">${duplicates} rows were exact repeats of another line and were skipped.</span>`);
      }
      if (totals.unpriced.length) {
        lines.push(
          `<b style="color:var(--accent-amber)">${totals.unpriced.length} came in with no price</b> and are held inactive until priced: `
            + totals.unpriced.slice(0, 20).map((issue) => issue.sku).join(', ')
            + (totals.unpriced.length > 20 ? ` and ${totals.unpriced.length - 20} more` : '')
        );
      }
      if (totals.rejected.length) {
        lines.push(
          `<b style="color:var(--accent-rose)">${totals.rejected.length} rows were skipped:</b><br>`
            + totals.rejected.slice(0, 10).map((issue) => `row ${issue.row}: ${issue.message}`).join('<br>')
            + (totals.rejected.length > 10 ? `<br>and ${totals.rejected.length - 10} more` : '')
        );
      }

      if (totals.imported) {
        // The import writes to the server; the ledger reads Dexie. Without
        // pulling the catalogue back down the products are invisible here.
        try {
          const cached = await pullCatalogue();
          lines.push(`<span style="color:var(--text-muted)">Catalogue refreshed: ${cached} products now on this till.</span>`);
        } catch (err) {
          lines.push(`<b style="color:var(--accent-amber)">Imported, but this till could not refresh its catalogue:</b> ${err.message || err}`);
        }

        // An import has never removed anything, so a menu loaded twice keeps
        // both copies and the products a tenant was provisioned with sit there
        // beside them - all of it on the customer menu. Offer to clear out what
        // this sheet did not mention, but never do it unasked.
        try {
          const preview = await callFunction('retireMissingProducts', { batchId, dryRun: true });
          if (preview.candidates > 0) {
            lines.push(
              `<b style="color:var(--accent-amber)">${preview.candidates} products on the server were not in this file.</b><br>`
                + '<span style="color:var(--text-muted)">'
                + preview.names.slice(0, 8).map((n) => escapeHtml(n)).join(', ')
                + (preview.candidates > 8 ? `, and ${preview.candidates - 8} more` : '')
                + '</span><br><span style="color:var(--text-muted)">Retiring takes them off the customer menu and the till. '
                + 'Their sales history stays readable.</span><br>'
                + `<button id="ledg-retire-btn" class="sec-btn" style="margin-top:10px;">Retire these ${preview.candidates} products</button>`
            );
          }
        } catch {
          // Advisory: an import that worked must not read as a failure.
        }
      }

      note(lines.join('<br>'), failure ? 'var(--accent-rose)' : 'var(--border-color)');

      const retireBtn = document.getElementById('ledg-retire-btn');
      if (retireBtn) {
        retireBtn.addEventListener('click', async () => {
          retireBtn.disabled = true;
          retireBtn.textContent = 'Retiring...';
          try {
            const done = await callFunction('retireMissingProducts', { batchId });
            await pullCatalogue();
            showNotification(`${done.retired} products retired.`, 'success');
            retireBtn.replaceWith(Object.assign(document.createElement('span'), {
              style: 'color:var(--accent-green);font-weight:700;',
              textContent: `${done.retired} products retired.`
            }));
            this.ledgerPage = 1;
            await this.renderLedger(pane);
          } catch (err) {
            showNotification(err.message || 'Could not retire those products.', 'error');
            retireBtn.disabled = false;
            retireBtn.textContent = 'Retire';
          }
        });
      }
      if (totals.imported) {
        showNotification(`Imported ${totals.imported} products.`, 'success');
        this.ledgerPage = 1;
        await this.renderLedger(pane);
      }
    });
  }

  async renderLedger(pane) {
    const all = await db.products.toArray();
    if (this.disposed || !pane?.isConnected) return;
    // Retired products keep their row for history but leave the ledger.
    const live = all.filter((product) => !product.retired_at);
    const needle = this.ledgerSearch.trim().toLowerCase();
    const products = (needle
      ? live.filter((product) => `${product.name} ${product.sku}`.toLowerCase().includes(needle))
      : live
    ).sort((a, b) => compareNames(a.name, b.name));
    // Page before the per-row stock lookups: each one is another Dexie read.
    const view = paginate(products, this.ledgerPage);
    this.ledgerPage = view.page;

    this.actionSheet?.dispose(); this.actionSheet = null;
    pane.innerHTML = `
      <div class="control-bar inventory-search-toolbar phone-sticky-toolbar">
        <input type="text" id="ledg-search" placeholder="Search ledger by SKU or name..." value="${this.ledgerSearch.replace(/"/g, '&quot;')}">
        ${this.canEditCatalogue ? `
        <button class="primary-btn" id="ledg-add-prod-btn">Add Product</button>
        <button class="sec-btn" id="ledg-import-btn">📥 Import CSV / Excel</button>
        <button class="sec-btn" id="ledg-template-btn">📄 Full template</button>
        <button class="sec-btn" id="ledg-names-template-btn">📄 Names-only template</button>` : `
        <span class="muted" style="font-size:12px;">Viewing only — an owner or store manager changes the catalogue.</span>`}
        <input type="file" id="ledg-import-file" accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" style="display:none;">
      </div>
      <div id="ledg-import-report"></div>

      <div class="table-wrapper">
        <table class="pos-table">
          <thead>
            <tr>
              <th>SKU</th>
              <th>Product Name</th>
              <th>UOM</th>
              <th>Category</th>
              <th>Batch</th>
              <th>Counted</th>
              <th>On menu</th>
              <th>Available in House</th>
              <th>Sell Price</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody id="ledg-table-body">
            <!-- Loaded dynamically -->
          </tbody>
        </table>
      </div>
      <div id="ledg-pager"></div>
    `;

    const tbody = document.getElementById('ledg-table-body');
    const categories = new Map((await db.categories.toArray()).map(c => [c.id, c.name]));
    if (this.disposed || !pane.isConnected || !tbody?.isConnected) return;

    for (const prod of view.rows) {
      const stock = state.currentBranch?.id ? await getHouseStock(prod.id, state.currentBranch.id) : 0;
      if (this.disposed || !pane.isConnected || !tbody.isConnected) return;
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td style="font-family:monospace;font-weight:600;">${prod.sku}</td>
        <td>
          <div style="display: flex; align-items: center; gap: 10px;">
            ${prod.image_data ? `<img src="${prod.image_data}" style="width: 32px; height: 32px; object-fit: cover; border-radius: 6px; border: 1px solid rgba(200, 130, 42, 0.25);">` : `<div style="width: 32px; height: 32px; border-radius: 6px; background: rgba(255,255,255,0.05); display: flex; align-items: center; justify-content: center; font-size: 14px; color: var(--text-muted);">📷</div>`}
            <span style="font-weight: 500;">${prod.name}</span>
          </div>
        </td>
        <td>${prod.uom}</td>
        <td>${categories.get(prod.category_id) || 'General'}</td>
        <td>
          <span class="badge ${prod.is_batch_tracked ? 'warning' : 'success'}">
            ${prod.is_batch_tracked ? 'Batch' : 'Standard'}
          </span>
        </td>
        <td>
          ${prod.is_service
            ? '<span class="badge">Service</span>'
            : this.canFlagProducts
              ? `<button type="button" class="stk-edit track-stock-btn" data-id="${prod.id}" data-tracked="${prod.track_stock ? '1' : ''}">
                 ${prod.track_stock ? '✓ Counted' : 'Not counted'}
               </button>`
              : `<span class="muted">${prod.track_stock ? 'Counted' : 'Not counted'}</span>`}
        </td>
        <td>
          ${this.canFlagProducts
            ? `<button type="button" class="stk-edit menu-visible-btn" data-id="${prod.id}" data-shown="${prod.show_on_menu === 0 ? '' : '1'}">
            ${prod.show_on_menu === 0 ? 'Store only' : '✓ On menu'}
          </button>`
            : `<span class="muted">${prod.show_on_menu === 0 ? 'Store only' : 'On menu'}</span>`}
        </td>
        <td style="font-weight:700; color:${stock <= 10 && !prod.is_service ? 'var(--accent-rose)' : 'var(--text-primary)'}">
          ${prod.is_service ? 'N/A (Service)' : stock}
        </td>
        <td style="font-family:var(--font-display);font-weight:600;">KES ${prod.sell_price.toFixed(2)}</td>
        <td>
          ${this.canEditCatalogue ? `
          <button class="primary-btn edit-prod-btn" data-id="${prod.id}" style="padding:4px 8px;font-size:10px;">Edit</button>
          <button class="stk-edit remove-prod-btn" data-id="${prod.id}" data-name="${prod.name.replace(/"/g, '&quot;')}" style="padding:4px 8px;font-size:10px;margin-left:6px;">Remove</button>
          <button class="stk-edit delete-prod-btn" data-id="${prod.id}" data-name="${escapeHtml(prod.name)}" style="padding:4px 8px;font-size:10px;margin-left:6px;">Delete entirely</button>` : ''}
        </td>
      `;
      tbody.appendChild(tr);
    }

    const pager = document.getElementById('ledg-pager');
    if (pager) {
      pager.innerHTML = pagerHtml('ledg-pager-strip', view);
      bindPager('ledg-pager-strip', view, (next) => {
        this.ledgerPage = next;
        this.renderLedger(pane);
      });
    }

    // The box existed but nothing listened to it. Re-rendering on every
    // keystroke would take the focus with it, so the caret is put back.
    const search = document.getElementById('ledg-search');
    if (search) {
      search.addEventListener('input', async (event) => {
        this.ledgerSearch = event.target.value;
        this.ledgerPage = 1;
        await this.renderLedger(pane);
        const again = document.getElementById('ledg-search');
        if (again) {
          again.focus();
          again.setSelectionRange(again.value.length, again.value.length);
        }
      });
    }

    // Removing keeps the row and marks it retired: sale lines and stock
    // movements point at it, so deleting the record would strand them.
    //
    // Bound once. This runs inside renderLedger, which re-renders after every
    // removal, so re-binding here stacked a fresh listener on each pass: the
    // second delete asked twice, the third three times, and every copy fired
    // its own call.
    if (!this.ledgerRemovalBound) {
      this.ledgerRemovalBound = true;
      pane.addEventListener('click', async (event) => {
        const button = event.target.closest('.remove-prod-btn, .delete-prod-btn');
        if (!button) return;
        const productId = button.getAttribute('data-id');
        const name = button.getAttribute('data-name');
        const permanently = button.classList.contains('delete-prod-btn');
        if (permanently) {
          if (!window.confirm(`Delete "${name}" entirely from the catalogue? Past sales and audit records will remain. Items with stock or open orders must be reconciled first.`)) return;
          button.disabled = true;
          try {
            await callFunction('deleteProduct', { productId, confirmProductId: productId });
            await pullCatalogue();
            showNotification(`"${name}" deleted from the catalogue.`, 'success');
            await this.renderLedger(pane);
          } catch (error) {
            showNotification(error.message || 'Could not delete this item.', 'error');
            button.disabled = false;
          }
          return;
        }
        if (!window.confirm(`Remove "${name}" from the menu and the till?

Past sales keep it. You can add it again later.`)) return;
        button.disabled = true;
        try {
          await callFunction('retireProduct', { productId });
          await pullCatalogue();
          showNotification(`"${name}" removed.`, 'success');
        } catch (error) {
          // Seeded and demo rows live only in this browser - the local cache is
          // only ever added to, never pruned - so the server has no document to
          // retire and answers not-found. The item is real on screen, so it has
          // to be removable: retire the local row instead of refusing forever.
          const missing = error?.code === 'functions/not-found'
            || /not[- ]found/i.test(error?.code || '')
            || /product not found/i.test(error?.message || '');
          if (!missing) {
            showNotification(error.message || 'Could not remove that product.', 'error');
            button.disabled = false;
            return;
          }
          await db.products.update(productId, { is_active: 0, show_on_menu: 0, retired_at: new Date().toISOString() });
          showNotification(`"${name}" removed from this till. It was never on the server.`, 'success');
        }
        await this.renderLedger(pane);
      });
    }

    if (this.canEditCatalogue) {
      this.bindImportEvents(pane);
      await this.bindProductEditorEvents(pane);
      if (this.disposed || !pane.isConnected) return;
      this.actionSheet = createMobileFilters({
        container: this.container, toolbar: pane.querySelector('.control-bar'),
        controls: ['#ledg-add-prod-btn', '#ledg-import-btn', '#ledg-template-btn', '#ledg-names-template-btn'].map(selector => pane.querySelector(selector)),
        title: 'Menu actions', buttonLabel: 'Actions', closeOnSelect: true, doneLabel: 'Done',
      });
    }


  }

  async bindProductEditorEvents(pane) {
    const categories = await db.categories.toArray();
    const escapeAttribute = (value) => String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    
    const openEditor = async (prodId = null) => {
      let prod = { 
        id: '', name: '', sku: '', category_id: categories[0]?.id, 
        sell_price: 0, cost_price: 0, uom: 'EA', tax_code: 'A', 
        is_service: 0, is_batch_tracked: 0 
      };
      
      if (prodId) {
        prod = await db.products.get(prodId) || prod;
      }

      // One editor at a time. A second copy on top of the first is a form whose
      // Save writes the record underneath it.
      document.querySelectorAll('[data-product-editor]').forEach((open) => open.remove());

      const modal = document.createElement('div');
      modal.className = 'modal active';
      modal.dataset.productEditor = prodId || 'new';
      modal.innerHTML = `
        <div class="modal-content" style="max-width: 500px; background: #1e293b;">
          <h2>${prodId ? 'Edit Product' : 'Add New Product'}</h2>
          <div class="product-editor-fields" style="display:grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-top:16px;">
            <div style="grid-column: span 2;">
              <label>Product Name</label>
              <input type="text" id="pe-name" value="${escapeAttribute(prod.name)}" class="pe-input">
            </div>
            <div>
              <label>SKU</label>
              <input type="text" id="pe-sku" value="${escapeAttribute(prod.sku)}" class="pe-input">
            </div>
            <div>
              <label>Category</label>
              <div style="display:flex;gap:8px;align-items:center;">
                <select id="pe-category" class="pe-input" style="flex:1;">
                  ${categories.map(c => `<option value="${escapeAttribute(c.id)}" ${c.id === prod.category_id ? 'selected' : ''}>${escapeAttribute(c.name)}</option>`).join('')}
                </select>
                <button type="button" id="pe-new-category" class="stk-edit" title="Create a new product type">+ New type</button>
              </div>
            </div>
            <div>
              <label>Sell Price (KES)</label>
              <input type="number" id="pe-sell" value="${prod.sell_price}" class="pe-input">
            </div>
            <div>
              <label>Cost Price (KES)</label>
              <input type="number" id="pe-cost" value="${prod.cost_price}" class="pe-input">
            </div>
            <div>
              <label>UOM (Unit of Measure)</label>
              <input type="text" id="pe-uom" value="${escapeAttribute(prod.uom)}" class="pe-input">
            </div>
            <div>
              <label>Tax Code</label>
              <select id="pe-tax" class="pe-input">
                <option value="A" ${prod.tax_code === 'A' ? 'selected' : ''}>A (16%)</option>
                <option value="B" ${prod.tax_code === 'B' ? 'selected' : ''}>B (8%)</option>
                <option value="C" ${prod.tax_code === 'C' ? 'selected' : ''}>C (0%)</option>
                <option value="E" ${prod.tax_code === 'E' ? 'selected' : ''}>E (Exempt)</option>
              </select>
            </div>
            <div style="display:flex; align-items:center; gap:8px; margin-top:8px;">
              <input type="checkbox" id="pe-service" ${prod.is_service ? 'checked' : ''}>
              <label for="pe-service" style="margin:0;">Is Service?</label>
            </div>
            <div style="display:flex; align-items:center; gap:8px; margin-top:8px;">
              <input type="checkbox" id="pe-batch" ${prod.is_batch_tracked ? 'checked' : ''}>
              <label for="pe-batch" style="margin:0;">Batch Tracked?</label>
            </div>
            <!-- Store-only stock is sold at the till but never advertised.
                 Absent means shown, so existing items keep their place. -->
            <div style="display:flex; align-items:center; gap:8px; margin-top:8px;">
              <input type="checkbox" id="pe-on-menu" ${prod.show_on_menu === 0 ? '' : 'checked'}>
              <label for="pe-on-menu" style="margin:0;">Show on customer menu?</label>
            </div>
            <div style="display:flex; align-items:center; gap:8px; margin-top:8px;">
              <input type="checkbox" id="pe-counted" ${prod.track_stock ? 'checked' : ''}>
              <label for="pe-counted" style="margin:0;">Counted stock?</label>
            </div>
            <div style="grid-column: span 2; margin-top: 8px;">
              <label>Product Image</label>
              <div style="display:flex; align-items:center; gap: 12px; margin-top:4px;">
                <img id="pe-image-preview" src="${escapeAttribute(prod.image_data)}" style="width: 60px; height: 60px; object-fit: cover; border-radius: 6px; background: rgba(0,0,0,0.2); display: ${prod.image_data ? 'block' : 'none'};">
                <div id="pe-image-placeholder" style="width: 60px; height: 60px; border-radius: 6px; background: rgba(0,0,0,0.2); display: ${prod.image_data ? 'none' : 'flex'}; align-items:center; justify-content:center; color: var(--text-muted); font-size: 20px;">📷</div>
                <div style="flex:1;">
                  <input type="text" id="pe-image-path" class="pe-input" value="${escapeAttribute(prod.image_data)}"
                    placeholder="/ai_images/chapati_beans.jpg or https://...">
                  <p style="font-size:11px;color:var(--text-secondary);margin:6px 0 0 0;line-height:1.5;">
                    The path to a picture this site serves, or a link to one. This is what the customer menu shows.
                  </p>
                </div>
              </div>
            </div>
          </div>
          
          <div style="display:flex; gap:10px; margin-top:20px;">
            <button class="primary-btn" id="pe-save-btn" style="flex:1;">Save Product</button>
            <button class="cancel-pay-btn" id="pe-cancel-btn" style="flex:1;">Cancel</button>
          </div>
        </div>
      `;
      document.body.appendChild(modal);

      modal.querySelector('#pe-cancel-btn').addEventListener('click', () => modal.remove());
      
      // The image is a path this site serves, not a file baked into the record.
      // The old control read a photo into a data URL, showed it, and sent
      // nothing: upsertProduct only accepts an https:// or /-relative path, so
      // a pasted-in photo was dropped on arrival and the upload was theatre.
      const pathInput = modal.querySelector('#pe-image-path');
      const previewImg = modal.querySelector('#pe-image-preview');
      const placeholder = modal.querySelector('#pe-image-placeholder');

      const showPreview = () => {
        const value = pathInput.value.trim();
        previewImg.src = value;
        previewImg.style.display = value ? 'block' : 'none';
        placeholder.style.display = value ? 'none' : 'flex';
      };
      // A path that 404s would otherwise leave a broken frame on the form.
      previewImg.addEventListener('error', () => {
        previewImg.style.display = 'none';
        placeholder.style.display = 'flex';
      });
      pathInput.addEventListener('input', showPreview);

      // A type nobody can create is a fixed list; the menu groups by these, so
      // a new section of the menu starts here.
      modal.querySelector('#pe-new-category').addEventListener('click', async () => {
        const name = window.prompt('Name the new product type (it becomes a heading on the customer menu):');
        if (!name?.trim()) return;
        const button = modal.querySelector('#pe-new-category');
        button.disabled = true;
        try {
          const created = await callFunction('upsertCategory', { name: name.trim() });
          await pullCatalogue();
          const select = modal.querySelector('#pe-category');
          if (![...select.options].some((option) => option.value === created.id)) {
            select.add(new Option(created.name, created.id));
          }
          select.value = created.id;
          showNotification(created.created ? `"${created.name}" added.` : `"${created.name}" already exists.`, 'success');
        } catch (error) {
          showNotification(error.message || 'Could not add that product type.', 'error');
        } finally {
          button.disabled = false;
        }
      });

      modal.querySelector('#pe-save-btn').addEventListener('click', async () => {
        const name = modal.querySelector('#pe-name').value;
        const sku = modal.querySelector('#pe-sku').value || `SKU-${Date.now().toString().slice(-6)}`;
        if (!name) return showNotification('Name is required', 'error');

        const isService = modal.querySelector('#pe-service').checked;
        const saveBtn = modal.querySelector('#pe-save-btn');
        saveBtn.disabled = true;
        try {
          // Products live in the central catalogue. Saving locally only meant an
          // item existed on one device and never reached the menu or the tills.
          await callFunction('upsertProduct', {
            id: prod.id || undefined,
            name,
            sku,
            categoryId: modal.querySelector('#pe-category').value,
            sellPrice: parseFloat(modal.querySelector('#pe-sell').value) || 0,
            costPrice: parseFloat(modal.querySelector('#pe-cost').value) || 0,
            uom: modal.querySelector('#pe-uom').value || 'EACH',
            taxCode: modal.querySelector('#pe-tax').value,
            isService,
            trackStock: !isService && modal.querySelector('#pe-counted').checked,
            showOnMenu: modal.querySelector('#pe-on-menu').checked,
            // The field the customer menu actually reads. Without it the
            // picture only ever existed in this device's cache.
            imagePath: modal.querySelector('#pe-image-path').value.trim() || null,
          });
          await pullCatalogue();
          showNotification('Product saved to the catalogue.', 'success');
          modal.remove();
          this.loadSubTab(); // refresh ledger
        } catch (error) {
          saveBtn.disabled = false;
          showNotification(error.message || 'Could not save the product.', 'error');
        }
      });
    };

    const addBtn = document.getElementById('ledg-add-prod-btn');
    if (addBtn) addBtn.addEventListener('click', () => openEditor(null));

    /**
     * One handler, assigned rather than added.
     *
     * This runs again on every render, but the pane itself survives them - only
     * its contents are replaced. addEventListener therefore stacked a new
     * listener each time, so after a few refreshes one click on Edit opened
     * several copies of the editor at once, and the one on top was the one
     * whose buttons did nothing.
     */
    pane.onclick = (e) => {
      const edit = e.target.closest('.edit-prod-btn');
      if (edit) return void openEditor(edit.getAttribute('data-id'));

      // Counted items are the ones the public menu holds to their House
      // balance, so this writes to the server catalogue, not the local cache.
      const btn = e.target.closest('.track-stock-btn, .menu-visible-btn');
      if (!btn) return;
      void this.toggleProductFlag(btn);
    };
  }

  async toggleProductFlag(btn) {
    const menu = btn.classList.contains('menu-visible-btn');
    const change = menu
      ? { showOnMenu: !btn.getAttribute('data-shown') }
      : { trackStock: !btn.getAttribute('data-tracked') };
    btn.disabled = true;
    try {
      await callFunction('setProductTracking', { productId: btn.getAttribute('data-id'), ...change });
      await pullCatalogue();
      showNotification(
        menu
          ? (change.showOnMenu ? 'Item now shows on the customer menu.' : 'Item is store only; it stays sellable at the till.')
          : (change.trackStock ? 'Item is now counted; the menu will hide it when it runs out.' : 'Item is no longer counted; it always shows on the menu.'),
        'success',
      );
      this.loadSubTab();
    } catch (error) {
      showNotification(error.message || 'Could not change this item.', 'error');
      btn.disabled = false;
    }
  }

  async renderTakes(pane) {
    const takes = await db.stock_takes.where('branch_id').equals(state.currentBranch.id).toArray();

    pane.innerHTML = `
      <div class="control-bar">
        <label for="take-location">Count location</label>
        <select id="take-location">${stockLocations().map(location => `<option value="${location}" ${location === 'HOUSE' ? 'selected' : ''}>${location === 'HOUSE' ? 'House' : 'Store'}</option>`).join('')}</select>
        <button class="primary-btn" id="new-take-btn">+ New Stock Count</button>
      </div>

      <div class="table-wrapper">
        <table class="pos-table">
          <thead>
            <tr>
              <th>Date</th>
              <th>Branch</th>
              <th>Status</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody id="takes-tbody">
            ${takes.map(tk => `
              <tr>
                <td>${new Date(tk.started_at).toLocaleDateString()}</td>
                <td>${escapeHtml(state.currentBranch.name || state.currentBranch.id)} ? ${escapeHtml(tk.location || 'HOUSE')}</td>
                <td>
                  <span class="badge ${tk.status === 'COMPLETED' ? 'success' : 'warning'}">${tk.status}</span>
                </td>
                <td>
                  ${tk.status === 'DRAFT' ? `
                    <button class="primary-btn enter-count-btn" data-id="${tk.id}" style="padding:4px 8px;font-size:10px;">Enter Count</button>
                    <button class="confirm-pay-btn approve-take-btn" data-id="${tk.id}" style="padding:4px 8px;font-size:10px;">Approve</button>
                  ` : `<span style="color:var(--text-muted)">Closed</span>`}
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `;

    document.getElementById('new-take-btn').addEventListener('click', async () => {
      const id = crypto.randomUUID();
      await db.stock_takes.add({
        id,
        branch_id: state.currentBranch.id,
        status: 'DRAFT',
        location: pane.querySelector('#take-location').value,
        started_at: new Date().toISOString()
      });
      showNotification('Stock count sheet created.', 'success');
      this.loadSubTab();
    });

    pane.querySelectorAll('.enter-count-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const takeId = e.target.getAttribute('data-id');
        this.openCountSheetModal(takeId);
      });
    });

    pane.querySelectorAll('.approve-take-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        const takeId = e.target.getAttribute('data-id');
        
        if (!this.canEditCatalogue) {
          showNotification('Only an Owner or Store Manager can approve stock counts.', 'error');
          return;
        }

        const lines = await db.stock_take_lines.where('stock_take_id').equals(takeId).toArray();
        if (lines.length === 0) {
          showNotification('Count sheet has no entries. Add entries before approving.', 'warning');
          return;
        }

        e.target.disabled = true;
        try {
          const take = await db.stock_takes.get(takeId);
          for (let offset = 0; offset < lines.length; offset += 150) {
            const chunk = lines.slice(offset, offset + 150);
            const rows = await Promise.all(chunk.map(async line => ({
              productId: line.product_id, sku: (await db.products.get(line.product_id))?.sku || line.product_id,
              qty: line.counted_qty,
            })));
            const result = await importStock({ mode: 'count', branchId: take.branch_id, location: take.location || 'HOUSE',
              reason: `Approved stock count ${takeId}`, batchId: `take-${takeId}-${offset}`, rows });
            if (result.rejected?.length) throw new Error(result.rejected.map(row => `${row.sku}: ${row.message}`).join('; '));
          }
          await db.stock_takes.update(takeId, { status: 'COMPLETED', approved_by: state.currentUser.id, approved_at: new Date().toISOString() });
        } catch (error) {
          showNotification(error.message || 'Could not approve the count. Saved counts are retained.', 'error');
          e.target.disabled = false;
          return;
        }

        showNotification('Stock take variances approved and posted to ledger.', 'success');
        this.loadSubTab();
      });
    });
  }

  async openCountSheetModal(takeId) {
    const take = await db.stock_takes.get(takeId);
    if (!take || take.status !== 'DRAFT') return;
    const products = (await db.products.where('is_service').equals(0).toArray()).filter(product => !product.retired_at);
    const saved = new Map((await db.stock_take_lines.where('stock_take_id').equals(takeId).toArray()).map(line => [line.product_id, line]));
    
    const countDiv = document.createElement('div');
    countDiv.className = 'modal active';
    countDiv.innerHTML = `
      <div class="modal-content stock-count-sheet" style="max-width: 680px; max-height: 80vh; overflow-y:auto;">
        <h2>Stock Count Entry Sheet</h2>
        <p>Blind Count Mode: Expected quantities are hidden until you enter your count.</p>
        
        <table class="pos-table">
          <thead>
            <tr>
              <th>SKU</th>
              <th>Product</th>
              <th>Counter Entry</th>
              <th>Variance</th>
            </tr>
          </thead>
          <tbody>
            ${products.map(p => `
              <tr data-prod-id="${p.id}">
                <td>${escapeHtml(p.sku)}</td>
                <td>${escapeHtml(p.name)}</td>
                <td>
                  <input type="number" class="counted-qty-input" min="0" max="100000000" step="1" value="${saved.get(p.id)?.counted_qty ?? ''}" aria-label="Count for ${escapeHtml(p.name)}" placeholder="Counted qty" style="width:100px;background:#333;border:1px solid #444;color:#fff;padding:4px;">
                </td>
                <td class="variance-result" style="font-weight:bold;">
                  ---
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
        
        <div class="stock-count-actions" style="display:flex;gap:12px;margin-top:20px;width:100%;">
          <button class="primary-btn" id="save-count-sheet" style="flex:1;">Save Counts</button>
          <button class="cancel-pay-btn" id="close-count-sheet" style="flex:1;">Close</button>
        </div>
      </div>
    `;
    
    document.body.appendChild(countDiv);

    // Save Counts Action
    document.getElementById('save-count-sheet').addEventListener('click', async () => {
      const rows = countDiv.querySelectorAll('tbody tr');
      
      const button = countDiv.querySelector('#save-count-sheet');
      button.disabled = true;
      try {
        const entries = [...rows].map(row => ({ productId: row.dataset.prodId, value: row.querySelector('.counted-qty-input').value }));
        const results = await saveStockCount({ db, takeId, branchId: state.currentBranch.id, staffId: state.currentUser.id, entries });
        for (const row of rows) {
          const line = results.find(line => line.product_id === row.dataset.prodId);
          if (line) row.querySelector('.variance-result').textContent = line.variance_qty === 0 ? 'OK' : `${line.variance_qty > 0 ? '+' : ''}${line.variance_qty}`;
        }
      } catch (error) {
        showNotification(error.message || 'Counts could not be saved. Your entries are still here; try again.', 'error');
        return;
      } finally { button.disabled = false; }

      showNotification('Counts saved and variances calculated.', 'success');
      // Intentionally NOT closing the modal so the user can review the variances
      this.loadSubTab();
    });

    document.getElementById('close-count-sheet').addEventListener('click', () => {
      countDiv.remove();
    });
  }

  async renderExpiries(pane) {
    const batches = await db.batches.toArray();
    const productsMap = new Map((await db.products.toArray()).map(p => [p.id, p]));

    const now = new Date();
    const alert30 = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
    const alert90 = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000);

    pane.innerHTML = `
      <h3>Batch Expiry Exposure</h3>
      <p style="font-size:11px;color:var(--text-secondary);margin-bottom:20px;">Displays batch tracked products expiring within the next 30/60/90 days.</p>

      <div class="table-wrapper">
        <table class="pos-table">
          <thead>
            <tr>
              <th>Product</th>
              <th>Batch Number</th>
              <th>Expiry Date</th>
              <th>Days Remaining</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            ${batches.map(bt => {
              const prod = productsMap.get(bt.product_id);
              if (!prod) return '';
              
              const exp = new Date(bt.expiry_date);
              const diffTime = exp - now;
              const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
              
              let statusBadge = '';
              if (diffDays <= 0) {
                statusBadge = '<span class="badge danger">Expired</span>';
              } else if (diffDays <= 30) {
                statusBadge = '<span class="badge danger">Critical (&lt;30d)</span>';
              } else if (diffDays <= 90) {
                statusBadge = '<span class="badge warning">Warning (&lt;90d)</span>';
              } else {
                statusBadge = '<span class="badge success">Healthy</span>';
              }

              return `
                <tr>
                  <td>${prod.name}</td>
                  <td style="font-family:monospace;">${bt.batch_no}</td>
                  <td>${bt.expiry_date}</td>
                  <td style="font-weight:bold; color:${diffDays <= 30 ? 'var(--accent-rose)' : 'inherit'}">
                    ${diffDays <= 0 ? 'Expired' : diffDays + ' days'}
                  </td>
                  <td>${statusBadge}</td>
                </tr>
              `;
            }).join('')}
          </tbody>
        </table>
      </div>
    `;
  }
}
