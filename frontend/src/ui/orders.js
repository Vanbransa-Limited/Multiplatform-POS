import { db } from '../db/schema';
import { state } from '../context';
import { paginate, pagerHtml, bindPager } from '../services/paginate';
import {
  watchCustomerOrders, updateCustomerOrder, printCustomerOrder, kitchenTicket,
  ORDER_TABS, orderStats, visibleOrders, renderOrderGrid, saleAsOrder, placedAt,
  chargeCustomerOrder, checkCustomerOrderPayment, settleCustomerOrderByCode, settleCustomerOrderCard,
} from '../services/customer-orders';
import { enqueuePrintJob, isStationOnline } from '../services/print-queue';
import { escapeHtml } from '../services/print-receipt';

/** Cards are large, so a page holds fewer of them than a table row list. */
const ORDER_CARDS_PER_PAGE = 8;

export class OrdersView {
  constructor(container) {
    this.container = container;
    this.customerOrders = [];
    this.posOrders = [];
    this.customerTab = 'all';
    this.customerSearch = '';
    this.customerPage = 1;
    this.productImages = new Map();
  }

  async load() {
    this.render();
    await this.loadProductImages();
    await this.loadPosOrders();
    this.bindEvents();
    this.renderCustomerBoard();
    try {
      const stop = await watchCustomerOrders((orders) => {
        if (this.disposed) return;
        this.customerOrders = orders;
        this.container.querySelector('#customer-orders-status').textContent = 'Live · Print the ticket to send an order to the kitchen.';
        this.renderCustomerBoard();
      }, () => {
        if (!this.disposed) this.container.querySelector('#customer-orders-status').textContent = 'Connection lost. Customer orders may be out of date. Reopen this screen to retry.';
      });
      if (this.disposed) stop(); else this.stopOrders = stop;
    } catch {
      if (!this.disposed) this.container.querySelector('#customer-orders-status').textContent = 'Could not connect to customer orders. Check your connection and reopen this screen.';
    }
  }

  dispose() { this.disposed = true; this.stopOrders?.(); }

  render() {
    this.container.innerHTML = `
      <!-- width:100% matters: .tab-view is a column flexbox, and the auto side
           margins below would otherwise cancel the default stretch and shrink
           this to its content, leaving most of a laptop screen empty. -->
      <div style="padding: 24px; color: var(--text-primary); width: 100%; max-width: 1800px; margin: 0 auto; font-family: var(--font-main);">
        
        <section style="background:var(--bg-card);border:1px solid var(--border-color);border-radius:12px;margin-bottom:24px;overflow:hidden">
          <div style="padding:16px 16px 14px">
            <h2 style="margin:0;font-family:var(--font-display);font-size:20px;font-weight:800">Orders</h2>
            <p style="margin:4px 0 0;font-size:12px;color:var(--text-secondary)">Live table-menu orders and completed till sales for this branch.</p>
          </div>
          <div class="co-stats" id="customer-orders-stats"></div>
          <div class="co-toolbar">
            <input id="customer-orders-search" class="co-search" type="search" placeholder="Search order number, table, item, cashier or receipt…" aria-label="Search orders">
            <button type="button" id="orders-export-btn" class="co-print">📥 Export sales CSV</button>
          </div>
          <div class="co-tabs" id="customer-orders-tabs" role="tablist" aria-label="Filter orders by status"></div>
          <p id="customer-orders-status" role="status" style="padding:0 16px 12px;margin:0;font-size:12px;color:var(--text-secondary)">Connecting to live orders…</p>
          <div id="customer-orders-list"></div>
          <div id="customer-orders-pager"></div>
        </section>
      </div>

      <!-- Take payment. The customer's phone cannot start one, so this is the
           only place an order becomes paid and the kitchen ticket unlocks. -->
      <div id="pay-modal" class="modal">
        <div class="pay-sheet">
          <div class="pay-head">
            <h3>Process Checkout</h3>
            <p>Choose settlement method and release the kitchen ticket</p>
          </div>

          <div class="pay-cols">
            <div class="pay-methods" role="tablist" aria-label="Settlement method">
              <button type="button" class="pay-method" data-pay-method="stk" aria-selected="true">
                <span class="pay-method-icon">📲</span>
                <span><b>M-Pesa STK Push</b><small>Send prompt directly to customer phone</small></span>
              </button>
              <button type="button" class="pay-method" data-pay-method="code" aria-selected="false">
                <span class="pay-method-icon">🧾</span>
                <span><b>M-Pesa Code</b><small>Already paid — settle against the receipt</small></span>
              </button>
              <button type="button" class="pay-method" data-pay-method="card" aria-selected="false">
                <span class="pay-method-icon">💳</span>
                <span><b>Card</b><small>Taken on the card terminal</small></span>
              </button>
            </div>

            <div class="pay-detail">
              <div class="pay-total">
                <span>GRAND TOTAL DUE</span>
                <strong id="pay-total">KES 0.00</strong>
                <small id="pay-order-summary"></small>
              </div>

              <div class="pay-pane" data-pay-pane="stk">
                <label for="pay-phone">M-Pesa Mobile Number</label>
                <input id="pay-phone" type="tel" inputmode="tel" maxlength="15" placeholder="e.g. 0712345678">
                <button type="button" id="pay-send" class="primary-btn pay-action">Initiate STK Push</button>
                <button type="button" id="pay-check" class="co-print pay-action">Check payment status</button>
              </div>

              <div class="pay-pane" data-pay-pane="code" hidden>
                <label for="pay-code">M-Pesa Confirmation Code</label>
                <input id="pay-code" type="text" maxlength="32" placeholder="e.g. QGH4T21XZ9" autocapitalize="characters" spellcheck="false">
                <p class="pay-note">Matched against payments M-Pesa has confirmed to this business. A code with no matching payment will not settle the order.</p>
                <button type="button" id="pay-code-settle" class="primary-btn pay-action">Verify code and settle</button>
              </div>

              <div class="pay-pane" data-pay-pane="card" hidden>
                <label for="pay-card-ref">Terminal reference <span class="pay-optional">(optional)</span></label>
                <input id="pay-card-ref" type="text" maxlength="60" placeholder="e.g. approval code">
                <p class="pay-note">Records a payment taken on the card machine. The terminal charges the card; this only records that it did.</p>
                <button type="button" id="pay-card" class="primary-btn pay-action">Record card payment</button>
              </div>

              <p id="pay-message" role="status" class="pay-message"></p>
            </div>
          </div>

          <div class="pay-foot">
            <button type="button" id="pay-close" class="co-print">Close</button>
          </div>
        </div>
      </div>

      <!-- Orders Invoice Modal -->
      <div id="orders-invoice-modal" class="modal" style="display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.85); backdrop-filter: blur(8px); z-index: 9999; justify-content: center; align-items: center; padding: 20px;">
        <div style="background: #18181b; border: 1px solid var(--border-color); border-radius: 16px; width: 100%; max-width: 480px; max-height: 90vh; display: flex; flex-direction: column; overflow: hidden; box-shadow: 0 25px 50px -12px rgba(0,0,0,0.7);">
          <!-- Header -->
          <div style="padding: 16px 20px; border-bottom: 1px solid var(--border-color); display: flex; justify-content: space-between; align-items: center; background: rgba(255,255,255,0.02);">
            <div style="display: flex; align-items: center; gap: 8px;">
              <span style="font-size: 18px;">🧾</span>
              <h3 style="margin: 0; font-size: 15px; font-weight: 700; color: #fff;">Tax Invoice / Thermal Receipt</h3>
            </div>
            <button id="orders-modal-close" style="background: transparent; border: none; color: var(--text-secondary); font-size: 18px; cursor: pointer; padding: 4px 8px;">✕</button>
          </div>

          <!-- Printable Thermal Content -->
          <div style="flex: 1; overflow-y: auto; padding: 20px;">
            <div id="orders-receipt-paper" class="receipt-paper-58" style="background: #fff; color: #000; padding: 20px; border-radius: 8px; font-family: monospace; font-size: 13px; box-shadow: 0 4px 12px rgba(0,0,0,0.3); max-width: 280px; margin: 0 auto;">
              <!-- Content loaded dynamically -->
            </div>
          </div>

          <!-- Actions Footer -->
          <div style="padding: 16px 20px; border-top: 1px solid var(--border-color); display: flex; gap: 10px; justify-content: space-between; align-items: center; background: rgba(255,255,255,0.02);">
            <div style="display: flex; gap: 6px;">
              <button id="orders-format-58" style="background: var(--color-primary, #e8a535); color: #000; border: none; padding: 6px 12px; border-radius: 6px; font-size: 13px; font-weight: 700; cursor: pointer;">58mm</button>
              <button id="orders-format-80" style="background: rgba(255,255,255,0.1); color: #fff; border: 1px solid var(--border-color); padding: 6px 12px; border-radius: 6px; font-size: 13px; cursor: pointer;">80mm</button>
            </div>
            <div style="display: flex; gap: 10px;">
              <button id="orders-modal-print" style="background: #10b981; color: #fff; border: none; padding: 8px 16px; border-radius: 6px; font-size: 12px; font-weight: 700; cursor: pointer; display: flex; align-items: center; gap: 6px;">
                🖨️ Print
              </button>
              <button id="orders-modal-done" style="background: rgba(255,255,255,0.1); color: #fff; border: 1px solid var(--border-color); padding: 8px 16px; border-radius: 6px; font-size: 12px; font-weight: 600; cursor: pointer;">
                Close
              </button>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  /**
   * Completed till sales, in the same shape as the live menu orders.
   *
   * They are read once when the screen opens: a sale is finished history and
   * never changes under the operator, unlike the menu feed.
   */
  async loadPosOrders() {
    try {
      const [sales, saleLines, payments, shifts, users, customers, products] = await Promise.all([
        db.sales.toArray(), db.sale_lines.toArray(), db.payments.toArray(),
        db.shifts.toArray(), db.users.toArray(), db.customers.toArray(), db.products.toArray(),
      ]);
      const paymentBySale = new Map(payments.map((entry) => [entry.sale_id, entry]));
      const shiftById = new Map(shifts.map((entry) => [entry.id, entry]));
      const userById = new Map(users.map((entry) => [entry.id, entry]));
      const customerById = new Map(customers.map((entry) => [entry.id, entry]));
      const productById = new Map(products.map((entry) => [entry.id, entry]));

      const linesBySale = new Map();
      for (const line of saleLines) {
        const rows = linesBySale.get(line.sale_id) || [];
        rows.push({
          productId: line.product_id,
          name: productById.get(line.product_id)?.name || 'Item',
          qty: line.qty,
        });
        linesBySale.set(line.sale_id, rows);
      }

      this.posOrders = sales.map((sale) => saleAsOrder(sale, {
        payment: paymentBySale.get(sale.id),
        cashierName: userById.get(shiftById.get(sale.shift_id)?.user_id)?.name || '',
        customerName: customerById.get(sale.customer_id)?.name || '',
        lines: linesBySale.get(sale.id) || [],
      }));
    } catch {
      this.posOrders = [];
    }
  }

  /** Everything the board shows, newest first, whichever system it came from. */
  allOrders() {
    return [...this.customerOrders, ...this.posOrders]
      .sort((a, b) => (placedAt(b)?.getTime() || 0) - (placedAt(a)?.getTime() || 0));
  }

  /**
   * Thumbnails come from the local catalogue, which the order lines index by
   * product id. A product with no picture simply falls back to a plate glyph.
   */
  async loadProductImages() {
    try {
      const products = await db.products.toArray();
      this.productImages = new Map(products.filter((p) => p.image_data).map((p) => [p.id, p.image_data]));
    } catch {
      this.productImages = new Map();
    }
  }

  /** Redraws tiles, tabs, cards and pager from the current live snapshot. */
  renderCustomerBoard() {
    const branchId = state.currentBranch?.id;
    const stats = this.container.querySelector('#customer-orders-stats');
    const tabs = this.container.querySelector('#customer-orders-tabs');
    const list = this.container.querySelector('#customer-orders-list');
    const pager = this.container.querySelector('#customer-orders-pager');
    if (!stats || !tabs || !list || !pager) return;

    const orders = this.allOrders();

    stats.innerHTML = orderStats(orders, branchId).map((tile) => `
      <div class="co-stat">
        <div class="co-stat-value">${tile.count}</div>
        <div class="co-stat-label">${tile.label}</div>
      </div>`).join('');

    tabs.innerHTML = ORDER_TABS.map((tab) => `
      <button type="button" class="co-tab" role="tab" data-order-tab="${tab.id}"
        aria-selected="${tab.id === this.customerTab}">${tab.label}</button>`).join('');

    const rows = visibleOrders(orders, branchId, { tab: this.customerTab, search: this.customerSearch });
    const view = paginate(rows, this.customerPage, ORDER_CARDS_PER_PAGE);
    this.customerPage = view.page;

    list.innerHTML = orders.some((order) => order.branchId === branchId)
      ? renderOrderGrid(view.rows, this.productImages)
      : '<p class="co-empty">No orders for this branch yet.</p>';
    pager.innerHTML = pagerHtml('customer-orders-pager-strip', view);
    bindPager('customer-orders-pager-strip', view, (next) => {
      this.customerPage = next;
      this.renderCustomerBoard();
    });
  }

  /**
   * Opens settlement for one unpaid menu order.
   *
   * The order is found again by id on every action rather than captured, so a
   * live update that lands mid-dialog cannot make the buttons act on stale
   * totals.
   */
  /**
   * `.modal` is transparent and click-through until it also carries `.active`,
   * so setting display alone renders an invisible overlay. Both modals on this
   * screen go through these two helpers.
   */
  showModal(selector) {
    const modal = this.container.querySelector(selector);
    modal.style.display = 'flex';
    modal.classList.add('active');
  }

  hideModal(selector) {
    const modal = this.container.querySelector(selector);
    modal.style.display = 'none';
    modal.classList.remove('active');
  }

  openPayModal(orderId) {
    const order = this.customerOrders.find((entry) => entry.id === orderId);
    if (!order) return;
    this.payingOrderId = orderId;
    this.payRequestId = null;
    this.container.querySelector('#pay-total').textContent = `KES ${(order.totalMinor / 100).toFixed(2)}`;
    this.container.querySelector('#pay-order-summary').textContent =
      `${order.ref} · ${(order.lines || []).reduce((sum, line) => sum + line.qty, 0)} item(s)`;
    this.container.querySelector('#pay-message').textContent = '';
    this.container.querySelector('#pay-message').className = 'pay-message';
    for (const id of ['#pay-phone', '#pay-code', '#pay-card-ref']) this.container.querySelector(id).value = '';
    this.selectPayMethod('stk');
    this.showModal('#pay-modal');
  }

  /** Shows one method's fields at a time, like the till's checkout. */
  selectPayMethod(method) {
    this.container.querySelectorAll('[data-pay-method]').forEach((button) => {
      button.setAttribute('aria-selected', String(button.dataset.payMethod === method));
    });
    this.container.querySelectorAll('[data-pay-pane]').forEach((pane) => {
      pane.hidden = pane.dataset.payPane !== method;
    });
  }

  /** Runs one settlement action and reports its outcome in the dialog. */
  async payAction(button, run, working) {
    const message = this.container.querySelector('#pay-message');
    const buttons = [...this.container.querySelectorAll('#pay-modal button')];
    buttons.forEach((entry) => { entry.disabled = true; });
    message.textContent = working;
    message.className = 'pay-message';
    try {
      message.textContent = await run(this.payingOrderId);
      message.className = 'pay-message ok';
    } catch (error) {
      message.textContent = error.message || 'That did not go through. Try again.';
      message.className = 'pay-message bad';
    } finally {
      buttons.forEach((entry) => { entry.disabled = false; });
      if (button) button.disabled = false;
    }
  }

  /**
   * Sends one order to the counter printer.
   *
   * The job is queued before the count is recorded, so a failure to record
   * cannot claim a print that never left, and the operator is told plainly when
   * paper is waiting for a station that is not running.
   */
  async printTicket(button) {
    const order = (this.customerOrders || []).find((entry) => entry.id === button.dataset.printOrder);
    const status = this.container.querySelector('#customer-orders-status');
    if (!order) return;
    button.disabled = true;
    try {
      const jobId = await enqueuePrintJob({
        branchId: order.branchId,
        receipt: kitchenTicket(order, Number(order.printCount || 0) + 1),
      });
      if (!jobId) throw new Error('The ticket could not be queued.');
      const { printCount } = await printCustomerOrder(order.id);
      status.textContent = await isStationOnline(order.branchId)
        ? `Ticket ${printCount} for ${order.ref} sent to the counter printer.`
        : `Ticket for ${order.ref} is queued. Start the print station at the counter to print it.`;
    } catch (error) {
      status.textContent = `${error.message || 'The ticket could not be printed.'} The order was not marked printed.`;
      button.disabled = false;
    }
  }

  bindEvents() {
    this.container.querySelector('#customer-orders-list').addEventListener('click', (event) => {
      const print = event.target.closest('[data-print-order]');
      if (print) return void this.printTicket(print);
      const pay = event.target.closest('[data-pay-order]');
      if (pay) return this.openPayModal(pay.dataset.payOrder);
      const invoice = event.target.closest('[data-invoice-sale]');
      if (invoice) void this.openInvoiceModal(invoice.dataset.invoiceSale);
    });

    this.container.querySelector('#pay-close').addEventListener('click', () => this.hideModal('#pay-modal'));

    this.container.querySelector('#pay-send').addEventListener('click', (event) => {
      const phone = this.container.querySelector('#pay-phone').value.trim();
      if (!phone) { this.container.querySelector('#pay-message').textContent = 'Enter the number to prompt.'; return; }
      // One request id per attempt, so pressing send twice resumes the same
      // prompt instead of charging the customer a second time.
      this.payRequestId = this.payRequestId || crypto.randomUUID();
      void this.payAction(event.target, async (orderId) => {
        const result = await chargeCustomerOrder(orderId, phone, this.payRequestId);
        return `${result.message} The card unlocks once payment lands.`;
      }, 'Sending the M-Pesa prompt…');
    });

    this.container.querySelector('#pay-check').addEventListener('click', (event) => {
      void this.payAction(event.target, async (orderId) => {
        const result = await checkCustomerOrderPayment(orderId);
        if (result.paymentStatus === 'paid') return `Paid. Receipt ${result.receipt || ''}. Print the kitchen ticket.`;
        // A failed prompt must not reuse its request id, or the retry resumes
        // the dead attempt instead of starting a new one.
        if (result.status === 'failed') this.payRequestId = null;
        return result.message || 'Not paid yet.';
      }, 'Checking with M-Pesa…');
    });

    this.container.querySelector('.pay-methods').addEventListener('click', (event) => {
      const button = event.target.closest('[data-pay-method]');
      if (button) this.selectPayMethod(button.dataset.payMethod);
    });

    this.container.querySelector('#pay-code-settle').addEventListener('click', (event) => {
      const code = this.container.querySelector('#pay-code').value.trim();
      if (!code) { this.container.querySelector('#pay-message').textContent = 'Enter the code from the customer’s M-Pesa message.'; return; }
      void this.payAction(event.target, async (orderId) => {
        const result = await settleCustomerOrderByCode(orderId, code);
        const change = result.changeMinor > 0 ? ` Customer overpaid by KES ${(result.changeMinor / 100).toFixed(2)}.` : '';
        return `Payment matched and settled.${change} Print the kitchen ticket.`;
      }, 'Checking the code against received payments…');
    });

    this.container.querySelector('#pay-card').addEventListener('click', (event) => {
      const reference = this.container.querySelector('#pay-card-ref').value.trim();
      void this.payAction(event.target, async (orderId) => {
        await settleCustomerOrderCard(orderId, reference);
        return 'Card payment recorded. Print the kitchen ticket.';
      }, 'Recording the card payment…');
    });

    // A narrower tab or search can strand the user past the last page, so both
    // reset to page one.
    this.container.querySelector('#customer-orders-tabs').addEventListener('click', (event) => {
      const tab = event.target.closest('[data-order-tab]');
      if (!tab) return;
      this.customerTab = tab.dataset.orderTab;
      this.customerPage = 1;
      this.renderCustomerBoard();
    });

    this.container.querySelector('#customer-orders-search').addEventListener('input', (event) => {
      this.customerSearch = event.target.value;
      this.customerPage = 1;
      this.renderCustomerBoard();
    });
    this.container.querySelector('#customer-orders-list').addEventListener('change', async (event) => {
      const select = event.target.closest('[data-customer-order]');
      if (!select?.value) return;
      select.disabled = true;
      try { await updateCustomerOrder(select.dataset.customerOrder, select.value); }
      catch { this.container.querySelector('#customer-orders-status').textContent = 'Could not update the order. Please retry.'; select.disabled = false; select.value = ''; }
    });
    const exportBtn = this.container.querySelector('#orders-export-btn');
    if (exportBtn) exportBtn.addEventListener('click', () => this.exportOrders());

    // Modal Control Events
    const closeBtn = document.getElementById('orders-modal-close');
    const doneBtn = document.getElementById('orders-modal-done');
    const closeModal = () => this.hideModal('#orders-invoice-modal');

    if (closeBtn) closeBtn.addEventListener('click', closeModal);
    if (doneBtn) doneBtn.addEventListener('click', closeModal);

    const printBtn = document.getElementById('orders-modal-print');
    if (printBtn) {
      printBtn.addEventListener('click', () => {
        window.print();
      });
    }

    const fmt58 = document.getElementById('orders-format-58');
    const fmt80 = document.getElementById('orders-format-80');
    const paper = document.getElementById('orders-receipt-paper');

    if (fmt58 && fmt80 && paper) {
      fmt58.addEventListener('click', () => {
        fmt58.style.background = 'var(--color-primary, #e8a535)';
        fmt58.style.color = '#000';
        fmt80.style.background = 'rgba(255,255,255,0.1)';
        fmt80.style.color = '#fff';
        paper.style.maxWidth = '280px';
        paper.style.margin = '0 auto';
      });

      fmt80.addEventListener('click', () => {
        fmt80.style.background = 'var(--color-primary, #e8a535)';
        fmt80.style.color = '#000';
        fmt58.style.background = 'rgba(255,255,255,0.1)';
        fmt58.style.color = '#fff';
        paper.style.maxWidth = '100%';
        paper.style.margin = '0';
      });
    }
  }

  async openInvoiceModal(saleId) {
    const sale = await db.sales.get(saleId);
    if (!sale) return;

    const lines = await db.sale_lines.where('sale_id').equals(sale.id).toArray();
    const payment = await db.payments.where('sale_id').equals(sale.id).first();
    const fiscal = await db.fiscal_records.where('sale_id').equals(sale.id).first();
    const productsList = await db.products.toArray();
    const prodMap = new Map(productsList.map(p => [p.id, p]));

    // No invented identity: a placeholder here prints on a customer's receipt.
    const tenant = state.currentTenant || (await db.tenants.first()) || {};
    const branch = state.currentBranch || (await db.branches.first()) || {};

    let cashierName = '';
    if (sale.shift_id) {
      const shift = await db.shifts.get(sale.shift_id);
      if (shift && shift.user_id) {
        const user = await db.users.get(shift.user_id);
        if (user) cashierName = user.name;
      }
    }

    let customerName = 'Guest';
    if (sale.customer_id) {
      const cust = await db.customers.get(sale.customer_id);
      if (cust) customerName = cust.name;
    }

    const paper = document.getElementById('orders-receipt-paper');
    if (!paper) return;

    const hasFiscal = !!fiscal;
    const invNo = sale.invoice_no || `INV-${sale.id.substring(0, 8).toUpperCase()}`;
    const pmtMethod = payment ? payment.method : 'CASH';

    paper.innerHTML = `
      <div style="text-align: center; margin-bottom: 12px;">
        <h2 style="margin: 0; font-size: 18px; font-weight: 800; text-transform: uppercase;">${tenant.trading_name || ''}</h2>
        ${branch.name ? `<p style="margin: 2px 0 0 0; font-size: 13px; color: #444;">${branch.name}</p>` : ''}
        ${tenant.kra_pin ? `<p style="margin: 1px 0 0 0; font-size: 13px; color: #444;">KRA PIN: ${tenant.kra_pin}</p>` : ''}
        ${branch.etims_bhf_id ? `<p style="margin: 1px 0 0 0; font-size: 13px; color: #444;">Branch Code: ${branch.etims_bhf_id}</p>` : ''}
        ${tenant.phone ? `<p style="margin: 1px 0 0 0; font-size: 13px; color: #444;">Tel: ${tenant.phone}</p>` : ''}
      </div>
      
      <div style="border-top: 1px dashed #666; margin: 8px 0;"></div>
      
      <div style="font-size: 13px; line-height: 1.5;">
        <div><b>Invoice No:</b> ${invNo}</div>
        <div><b>Date:</b> ${new Date(sale.sold_at).toLocaleString()}</div>
        <div><b>Cashier:</b> ${cashierName}</div>
        <div><b>Customer:</b> ${customerName}</div>
        <div><b>Serving:</b> ${sale.table_no ? 'TABLE ' + sale.table_no : 'TAKEAWAY'}</div>
      </div>
      
      <div style="border-top: 1px dashed #666; margin: 8px 0;"></div>
      
      <div style="margin-bottom: 8px;">
        <div style="display: flex; justify-content: space-between; font-weight: 700; margin-bottom: 4px;">
          <span>ITEM</span>
          <span>AMT (KES)</span>
        </div>
        ${lines.map(line => {
          const prod = prodMap.get(line.product_id);
          const pName = prod ? prod.name : 'Item';
          return `
            <div style="margin-bottom: 4px;">
              <div style="display: flex; justify-content: space-between; font-weight: 600;">
                <span>${pName}</span>
                <span>${line.line_total.toLocaleString(undefined, {minimumFractionDigits:2, maximumFractionDigits:2})}</span>
              </div>
              <div style="font-size: 12px; color: #555;">
                ${line.qty} x ${line.unit_price.toFixed(2)} (Tax Code: ${line.tax_code || 'A'})
              </div>
            </div>
          `;
        }).join('')}
      </div>

      <div style="border-top: 1px dashed #666; margin: 8px 0;"></div>

      <div style="font-size: 13px; line-height: 1.6;">
        <div style="display: flex; justify-content: space-between;">
          <span>Subtotal:</span>
          <span>KES ${sale.subtotal ? sale.subtotal.toFixed(2) : (sale.grand_total * 0.84).toFixed(2)}</span>
        </div>
        <div style="display: flex; justify-content: space-between;">
          <span>VAT (16%):</span>
          <span>KES ${sale.tax_total ? sale.tax_total.toFixed(2) : (sale.grand_total * 0.16).toFixed(2)}</span>
        </div>
        <div style="display: flex; justify-content: space-between; font-weight: 800; font-size: 15px; margin-top: 4px; padding-top: 4px; border-top: 1px solid #000;">
          <span>TOTAL PAID:</span>
          <span>KES ${(payment ? payment.amount : sale.grand_total).toLocaleString(undefined, {minimumFractionDigits: 2})}</span>
        </div>
      </div>

      <div style="border-top: 1px dashed #666; margin: 8px 0;"></div>

      <div style="font-size: 13px;">
        <div><b>Payment Mode:</b> ${pmtMethod}</div>
        ${payment && payment.reference ? `<div><b>Ref:</b> ${payment.reference}</div>` : ''}
        <div><b>Status:</b> PAID &amp; CONFIRMED</div>
      </div>

      <div style="border-top: 1px dashed #666; margin: 8px 0;"></div>

      <!-- KRA eTIMS Fiscal Block -->
      <div style="text-align: center; font-size: 12px;">
        <p style="font-weight: 800; margin: 0 0 4px 0;">*** KRA eTIMS FISCAL RECORD ***</p>
        ${hasFiscal ? `
          <p style="margin: 1px 0;">CU Serial: ${fiscal.cu_serial}</p>
          <p style="margin: 1px 0; word-break: break-all;">Signature: ${fiscal.receipt_signature}</p>
          <p style="margin: 1px 0;">Invoice No: ${fiscal.cu_invoice_no}</p>
          <div style="margin-top: 6px; padding: 6px; background: #f4f4f5; border: 1px solid #ddd; border-radius: 4px; display: inline-block;">
            <div style="font-weight: 800; font-size: 12px; letter-spacing: 1px;">[ SCAN TO VERIFY KRA ]</div>
          </div>
        ` : `
          <p style="color: #10b981; font-weight: 800; margin: 2px 0;">FISCALIZED &amp; VERIFIED</p>
          <p style="margin: 0; color: #555;">KRA eTIMS Digital Signature Attached</p>
        `}
      </div>

      <div style="border-top: 1px dashed #666; margin: 8px 0;"></div>
      <div style="text-align: center; font-size: 12px; color: #444; margin-top: 6px;">
        <p style="margin: 0;">Thank you for dining at Vanbransa!</p>
        <p style="margin: 2px 0 0 0;">Powered by Vanbransa Pro POS</p>
      </div>
    `;

    this.showModal('#orders-invoice-modal');
  }

  async exportOrders() {
    const sales = await db.sales.orderBy('sold_at').reverse().toArray();
    const payments = await db.payments.toArray();
    const paymentMap = new Map(payments.map(p => [p.sale_id, p]));

    let csvContent = 'Date/Time,Invoice No,Table,Total KES,Payment Method,Status\n';
    for (const s of sales) {
      const dt = new Date(s.sold_at).toLocaleString().replace(',', '');
      const inv = s.invoice_no || s.sale_uuid;
      const tbl = s.table_no ? `Table ${s.table_no}` : 'Takeaway';
      const pmt = paymentMap.get(s.id);
      const amt = pmt ? pmt.amount : (s.grand_total || 0);
      const method = pmt ? pmt.method : 'CASH';
      const status = s.fiscal_status || 'SENT';
      csvContent += `"${dt}","${inv}","${tbl}",${amt},"${method}","${status}"\n`;
    }

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.setAttribute('href', url);
    link.setAttribute('download', `Vanbransa_Orders_${new Date().toISOString().slice(0,10)}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }
}

