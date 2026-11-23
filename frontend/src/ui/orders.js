import { db } from '../db/schema';
import { state, showNotification } from '../context';
import { paginate, pagerHtml, bindPager } from '../services/paginate';
import {
  watchCustomerOrders, updateCustomerOrder, printCustomerOrder, kitchenTicket,
  ORDER_TABS, orderStats, visibleOrders, renderOrderGrid, saleAsOrder, placedAt, handledBy, mergeTabRounds, sortOrders,
  chargeCustomerOrder, checkCustomerOrderPayment, settleCustomerOrderByCode, settleCustomerOrderCard,
  settleCustomerOrderBank, settleCustomerOrderCash, settleSale, claimSalePayment,
} from '../services/customer-orders';
import { pullSales } from '../services/catalogue';
import { pullOpenOrders } from '../services/open-orders';
import { quickFinancialPeriod, tradingRange } from '../services/financial-period';
import { pullTradingHours, cachedTradingHours } from '../services/trading-hours';
import { pullStaff } from '../services/staff';
import { isReceivable } from '../services/takings';
import { mergeTabLines } from '../services/tabs';
import { removeTabLine, freeSettledTab } from '../services/tab-edit';
import { MpesaService } from '../services/mpesa';
import { recordReceiptSettlement } from '../services/receipt-settlement';
import { manualReceipt } from '../services/manual-receipt';
import { DEVICE_ID } from '../services/firebase';
import { enqueuePrintJob, isStationOnline } from '../services/print-queue';
import { requirePrintedReceipt } from './checkout-print';
import { escapeHtml, renderEtrBlock } from '../services/print-receipt';
import { etrFor, generateEtr } from '../services/etr';
import { cashIsEnabled } from '../services/payment-settings';
import { createMobileFilters } from './mobile-filters';
import { catalogueCartLines } from '../services/service-charges';
import { ProformaRegister } from './proformas';
import { billableCheckoutRounds, isNonBillableAdjustment } from '../services/checkout-rounds';

/** Cards are large, so a page holds fewer of them than a table row list. */
const ORDER_CARDS_PER_PAGE = 8;

export class OrdersView {
  constructor(container) {
    this.container = container;
    this.customerOrders = [];
    this.posOrders = [];
    this.proformaId = new URLSearchParams(window.location.search).get('proforma') || '';
    this.customerTab = this.proformaId ? 'proformas' : 'running';
    this.orderSort = 'table';
    // Financials can deep-link an exact unpaid order into this organization
    // viewer, where its existing payment controls perform the reconciliation.
    this.reconcileReference = new URLSearchParams(window.location.search).get('order') || '';
    // Tab Management's Edit tab: open the item editor rather than payment.
    this.invoiceLinked = new URLSearchParams(window.location.search).get('invoice') === '1';
    this.editLinked = new URLSearchParams(window.location.search).get('edit') === '1';
    this.customerSearch = this.reconcileReference;
    this.customerPage = 1;
    this.productImages = new Map();
    this.staffNames = new Map();
    // Money roles answer for the whole business, not only the branch attached
    // to the device on which they opened an organization-wide finance link.
    this.allBranches = ['Owner', 'Store Manager'].includes(state.currentUser?.role);
    // The same client the till pushes with, so both screens obey one lifecycle.
    this.mpesa = new MpesaService();
  }

  async load() {
    this.hours = cachedTradingHours();
    this.render();
    await this.loadProductImages();
    await this.loadPosOrders({ refresh: false });
    if (this.disposed) return;
    this.bindEvents();
    this.refreshTimer = setInterval(() => { void this.refreshBoard(); }, 60_000);
    this.renderCustomerBoard();
    this.proformaRegister = new ProformaRegister(this.container.querySelector('#orders-proformas'), { selectedId: this.proformaId });
    void this.proformaRegister.load();
    this.openLinkedReconciliation();
    this.container.querySelector('#customer-orders-status').textContent = this.syncWarning;
    void pullTradingHours().then(hours => {
      if (this.disposed) return;
      this.hours = hours;
      this.renderCustomerBoard();
    }).catch(() => {});
    // Cached rows make the board usable immediately. Refreshing history must
    // not hold up the floor or the live menu-order subscription.
    void this.loadPosOrders().then(() => {
      if (this.disposed) return;
      this.renderCustomerBoard();
      this.openLinkedReconciliation();
      const status = this.container.querySelector('#customer-orders-status');
      if (status) status.textContent = [this.syncWarning, this.localOnlyNote].filter(Boolean).join(' ')
        || '';
    }).catch(() => {
      if (this.disposed) return;
      const status = this.container.querySelector('#customer-orders-status');
      if (status) status.textContent = 'Showing cached orders. Server refresh failed; reopen this screen to retry.';
    });
    try {
      const stop = await watchCustomerOrders((orders) => {
        if (this.disposed) return;
        this.customerOrders = orders;
        this.container.querySelector('#customer-orders-status').textContent = [
          this.syncWarning,
          this.localOnlyNote,
        ].filter(Boolean).join(' ');
        this.renderCustomerBoard();
        this.openLinkedReconciliation();
      }, () => {
        if (!this.disposed) this.container.querySelector('#customer-orders-status').textContent = 'Connection lost. Customer orders may be out of date. Reopen this screen to retry.';
      });
      if (this.disposed) stop(); else this.stopOrders = stop;
    } catch {
      if (!this.disposed) this.container.querySelector('#customer-orders-status').textContent = 'Could not connect to customer orders. Check your connection and reopen this screen.';
    }
  }

  dispose() { this.disposed = true; clearInterval(this.refreshTimer); this.stopOrders?.(); this.proformaRegister?.dispose(); this.filterSheet?.dispose(); }

  async refreshBoard() {
    if (this.refreshing || this.disposed) return;
    this.refreshing = true;
    try {
      await this.loadPosOrders();
      if (this.disposed) return;
      this.renderCustomerBoard();
      this.container.querySelector('#customer-orders-status').textContent = [this.syncWarning, this.localOnlyNote].filter(Boolean).join(' ');
    } catch {
      if (!this.disposed) this.container.querySelector('#customer-orders-status').textContent = 'Refresh failed. Keeping displayed orders; use Refresh orders to retry.';
    } finally { this.refreshing = false; }
  }

  render() {
    this.container.innerHTML = `
      <!-- width:100% matters: .tab-view is a column flexbox, and the auto side
           margins below would otherwise cancel the default stretch and shrink
           this to its content, leaving most of a laptop screen empty. -->
      <div class="module-page" style="padding: 24px; color: var(--text-primary); width: 100%; max-width: 1800px; margin: 0 auto; font-family: var(--font-main);">
        
        <section class="orders-board" style="background:var(--bg-card);border:1px solid var(--border-color);border-radius:12px;margin-bottom:24px;overflow:hidden">
          <div style="padding:16px 16px 14px">
            <h2 style="margin:0;font-family:var(--font-display);font-size:20px;font-weight:800">Orders</h2>
            <p style="margin:4px 0 0;font-size:12px;color:var(--text-secondary)">${this.allBranches
              ? 'Every order in the organization, in every state — table-menu orders and till sales from all devices — with the person answerable for each.'
              : 'Every order on this branch, in every state — table-menu orders and till sales from all devices — with the person answerable for each.'}</p>
          </div>
          <div class="co-stats" id="customer-orders-stats"></div>
          <div class="co-toolbar phone-sticky-toolbar" id="orders-search-toolbar">
            <input id="customer-orders-search" class="co-search" type="search" value="${escapeHtml(this.customerSearch)}" placeholder="Search order number, table, item, status, receipt, or who billed it…" aria-label="Search orders">
            <!-- The owner answers for the whole business, so they can drop the
                 branch filter rather than wonder where an order went. -->
            <label id="orders-scope-wrap" class="co-meta" style="display:none;align-items:center;gap:6px;margin:0">
              <input type="checkbox" id="orders-all-branches"> All branches
            </label>
            <button type="button" id="orders-export-btn" class="co-print">📥 Export sales CSV</button>
            <button type="button" id="orders-refresh" class="co-print">Refresh orders</button>
            <label id="orders-sort-wrap" class="co-meta" style="display:flex;align-items:center;gap:6px;margin:0">Sort by
              <select id="orders-sort" class="co-search" style="width:auto;min-width:140px">
                <option value="table">Table number</option>
                <option value="staff">Staff member</option>
                <option value="oldest">Oldest first</option>
                <option value="newest">Newest first</option>
                <option value="amount">Amount due</option>
              </select>
            </label>
          </div>
          <!-- Orders by the night they belong to. A trading day runs to the
               next morning, so a table opened at 11pm stays on its own day. -->
          <div class="co-toolbar" id="orders-date-bar">
            <button type="button" class="co-print" data-orders-range="today">Today</button>
            <button type="button" class="co-print" data-orders-range="yesterday">Yesterday</button>
            <button type="button" class="co-print" data-orders-range="week">Past week</button>
            <button type="button" class="co-print" data-orders-range="all">All dates</button>
            <label class="co-meta" style="display:flex;align-items:center;gap:6px;margin:0">From
              <input type="date" id="orders-date-from" class="co-search" style="max-width:170px">
            </label>
            <label class="co-meta" style="display:flex;align-items:center;gap:6px;margin:0">To
              <input type="date" id="orders-date-to" class="co-search" style="max-width:170px">
            </label>
          </div>
          <div class="co-tabs" id="customer-orders-tabs" role="tablist" aria-label="Filter orders by status"></div>
          <p id="orders-running-note" class="co-meta" style="padding:0 16px 12px;margin:0">Running shows unpaid orders from all dates. Confirmed payments move to history.</p>
          <p id="customer-orders-status" role="status" style="padding:0 16px 12px;margin:0;font-size:12px;color:var(--text-secondary)">Connecting to live orders…</p>
          <div id="customer-orders-list"></div>
          <div id="customer-orders-pager"></div>
        </section>
      </div>

      <!-- Take payment. The customer's phone cannot start one, so this is the
           only place an order becomes paid and the kitchen ticket unlocks. -->
      <!-- Same shape as the till's checkout: method cards down the left, the
           amount and that method's fields down the right. A cashier moves
           between the two screens all night and should not have to learn a
           second checkout. -->
      <div id="pay-modal" class="modal">
        <div class="modal-content" style="max-width: 700px;">
          <h2>Process Checkout</h2>
          <p>Choose settlement method and release the kitchen ticket</p>

          <div class="checkout-modal-grid">
            <div class="checkout-payment-methods" role="tablist" aria-label="Settlement method">
              <div class="payment-method-card selected" data-pay-method="stk" role="tab" aria-selected="true">
                <span style="font-size:20px;">📲</span>
                <div>
                  <h4>M-Pesa STK Push</h4>
                  <p>Send prompt directly to customer phone</p>
                </div>
              </div>
              <div class="payment-method-card" data-pay-method="code" role="tab" aria-selected="false">
                <span style="font-size:20px;">🧾</span>
                <div>
                  <h4>M-Pesa Code</h4>
                  <p>Already paid — settle against the receipt</p>
                </div>
              </div>
              <div class="payment-method-card" data-pay-method="bank" role="tab" aria-selected="false">
                <span style="font-size:20px;">🏦</span>
                <div>
                  <h4>Bank Transfer</h4>
                  <p>Match the statement reference</p>
                </div>
              </div>
              <div class="payment-method-card" data-pay-method="cash" role="tab" aria-selected="false" ${cashIsEnabled() ? '' : 'hidden'}>
                <span style="font-size:20px;">💵</span>
                <div>
                  <h4>Cash Payment</h4>
                  <p>Taken at the counter</p>
                </div>
              </div>
              <div class="payment-method-card" data-pay-method="card" role="tab" aria-selected="false">
                <span style="font-size:20px;">💳</span>
                <div>
                  <h4>Card</h4>
                  <p>Taken on the card terminal</p>
                </div>
              </div>
            </div>

            <div class="payment-inputs-col">
              <div class="payment-detail-box">
                <h3>Grand Total Due</h3>
                <p id="pay-total">KES 0.00</p>
                <small id="pay-order-summary" style="font-size:11px;color:var(--text-muted)"></small>
              </div>

              <div class="checkout-inputs" data-pay-pane="stk">
                <label for="pay-phone" style="font-size:13px;color:var(--text-secondary)">M-Pesa Mobile Number</label>
                <input id="pay-phone" type="tel" inputmode="tel" maxlength="15" placeholder="e.g. 0712345678">
                <button type="button" id="pay-send" class="primary-btn">Initiate STK Push</button>
                <button type="button" id="pay-check" class="sec-btn">Check payment status</button>
              </div>

              <div class="checkout-inputs" data-pay-pane="code" hidden>
                <label for="pay-code" style="font-size:13px;color:var(--text-secondary)">M-Pesa Confirmation Code</label>
                <input id="pay-code" type="text" maxlength="10" placeholder="e.g. QGH4T21XZ9" autocomplete="off" autocorrect="off" autocapitalize="characters" spellcheck="false">
                <label for="pay-code-amount">Amount on receipt (KES)</label>
                <input id="pay-code-amount" type="text" inputmode="decimal" autocomplete="off" placeholder="Enter receipt amount">
                <p style="font-size:13px;color:var(--text-secondary);line-height:1.5;margin:0;">
                  Enter the code and amount from the payment message.
                </p>
                <button type="button" id="pay-code-settle" class="primary-btn">Record payment</button>
              </div>

              <div class="checkout-inputs" data-pay-pane="card" hidden>
                <label for="pay-card-ref" style="font-size:13px;color:var(--text-secondary)">Terminal reference (optional)</label>
                <input id="pay-card-ref" type="text" maxlength="60" placeholder="e.g. approval code">
                <p style="font-size:13px;color:var(--text-secondary);line-height:1.5;margin:0;">
                  Records a payment taken on the card machine. The terminal charges the card; this only records that it did.
                </p>
                <button type="button" id="pay-card" class="primary-btn">Record card payment</button>
              </div>

              <div class="checkout-inputs" data-pay-pane="bank" hidden>
                <label for="pay-bank-ref" style="font-size:13px;color:var(--text-secondary)">Bank Statement Reference (optional)</label>
                <input id="pay-bank-ref" type="text" maxlength="60" placeholder="e.g. transfer reference">
                <p style="font-size:13px;color:var(--text-secondary);line-height:1.5;margin:0;">Recorded exactly as typed, to marry the received transfer to this order. It also records who reconciled it.</p>
                <button type="button" id="pay-bank" class="primary-btn">Reconcile bank transfer</button>
              </div>

              <div class="checkout-inputs" data-pay-pane="cash" hidden>
                <p style="font-size:13px;color:var(--text-secondary);line-height:1.5;margin:0;">Records cash received at the counter. This is only available to organizations that accept cash.</p>
                <button type="button" id="pay-cash" class="primary-btn">Record cash received</button>
              </div>

              <p id="pay-message" role="status" class="pay-message"></p>

              <div style="display:flex;gap:10px;margin-top:auto;">
                <button type="button" class="cancel-pay-btn" style="flex:1;" id="pay-close">Close</button>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- Records money that arrived after the goods left: a proforma settled
           by transfer, by M-Pesa, or in cash at the counter. -->
      <div id="settle-modal" class="modal">
        <div class="modal-content" style="max-width: 700px;">
          <h2>Process Checkout</h2>
          <p>Record the money that settles this invoice</p>

          <div class="checkout-modal-grid">
            <div class="checkout-payment-methods" role="tablist" aria-label="How the money arrived">
              <!-- Taking the money now, rather than recording money that has
                   already arrived. One prompt covers the whole tab. -->
              <div class="payment-method-card selected" data-settle-method="stk" role="tab" aria-selected="true">
                <span style="font-size:20px;">📲</span>
                <div>
                  <h4>M-Pesa STK Push</h4>
                  <p id="settle-stk-note">Send the prompt to the customer's phone</p>
                </div>
              </div>
              <div class="payment-method-card" data-settle-method="mpesa" role="tab" aria-selected="false">
                <span style="font-size:20px;">📱</span>
                <div>
                  <h4>M-Pesa Code</h4>
                  <p>Already paid — enter the code from the SMS</p>
                </div>
              </div>
              <div class="payment-method-card" data-settle-method="bank_transfer" role="tab" aria-selected="false">
                <span style="font-size:20px;">🏦</span>
                <div>
                  <h4>Bank Transfer</h4>
                  <p>Reference from the statement</p>
                </div>
              </div>
              <div class="payment-method-card" data-settle-method="cash" role="tab" aria-selected="false" ${cashIsEnabled() ? '' : 'hidden'}>
                <span style="font-size:20px;">💵</span>
                <div>
                  <h4>Cash Payment</h4>
                  <p>Taken at the counter</p>
                </div>
              </div>
              <div class="payment-method-card" data-settle-method="card" role="tab" aria-selected="false">
                <span style="font-size:20px;">💳</span>
                <div>
                  <h4>Card</h4>
                  <p>Taken on the card terminal</p>
                </div>
              </div>
            </div>

            <div class="payment-inputs-col">
              <div class="payment-detail-box">
                <h3>Outstanding</h3>
                <p id="settle-due">KES 0.00</p>
                <small id="settle-summary" style="font-size:11px;color:var(--text-muted)"></small>
              </div>

              <div class="checkout-inputs" id="settle-stk-inputs">
                <label for="settle-phone" style="font-size:13px;color:var(--text-secondary)">Customer phone</label>
                <input id="settle-phone" type="tel" maxlength="15" placeholder="07XX XXX XXX" autocomplete="off" autocorrect="off" spellcheck="false">
                <p style="font-size:13px;color:var(--text-secondary);line-height:1.5;margin:0;">
                  Sends an M-Pesa prompt for the full outstanding amount. The invoice settles only when M-Pesa confirms it.
                </p>
                <div id="settle-stk-status" class="hidden" style="margin-top:8px;">
                  <span id="settle-stk-badge" class="badge warning"></span>
                </div>
              </div>

              <div class="checkout-inputs hidden" id="settle-reference-inputs">
                <label for="settle-reference" style="font-size:13px;color:var(--text-secondary)">Reference</label>
                <input id="settle-reference" class="receipt-code-input" type="text" maxlength="60" placeholder="M-Pesa code, e.g. QGH4T21XZ9" autocomplete="off" autocorrect="off" autocapitalize="characters" spellcheck="false" aria-describedby="settle-note">
                <div id="settle-receipt-amount-wrap" class="hidden">
                  <label for="settle-receipt-amount">Amount on receipt (KES)</label>
                  <input id="settle-receipt-amount" type="text" inputmode="decimal" autocomplete="off" placeholder="Enter receipt amount">
                </div>
                <p id="settle-note" style="font-size:13px;color:var(--text-secondary);line-height:1.5;margin:0;">
                  Enter the code from the payment message.
                </p>
              </div>

              <p id="settle-message" role="status" class="pay-message"></p>

              <div style="display:flex;gap:10px;margin-top:auto;">
                <button type="button" class="cancel-pay-btn" style="flex:1;" id="settle-close">Close</button>
                <button type="button" class="confirm-pay-btn" style="flex:1.5;" id="settle-confirm">Record payment</button>
              </div>
            </div>
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

          <div id="orders-etr-row" style="display: none; gap: 8px; padding: 12px 20px 0;">
            <input type="text" id="orders-etr-pin" placeholder="Buyer KRA PIN (optional)" maxlength="11" autocomplete="off" aria-label="Buyer KRA PIN" style="flex: 1; text-transform: uppercase; padding: 8px; border-radius: 6px; background: rgba(0,0,0,0.2); border: 1px solid var(--border-color); color: #fff;">
            <button id="orders-etr-btn" style="background: var(--color-primary, #e8a535); color: #000; border: none; padding: 8px 16px; border-radius: 6px; font-size: 12px; font-weight: 700; cursor: pointer;">Generate ETR</button>
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
  async loadPosOrders({ refresh = true } = {}) {
    const generation = this.posReadGeneration = (this.posReadGeneration || 0) + 1;
    // Sales are pushed to the server and, until now, never pulled back: this
    // board only ever listed what this one device had rung up. An owner asking
    // who billed a table was looking at a third of the night.
    // Read the snapshot first, then history. A snapshot removed during upload
    // must already have its canonical sale when history is read afterwards.
    // One server read at a time. The 60s timer, settlements and item edits all
    // call this; each used to start its own 90-day download and discard the
    // one before it, so on a busy till the board could stop updating at all.
    // After the first full read, only what can have changed is fetched: sales
    // since the last read, plus every bill still unpaid here (payments taken
    // on another till land on old sales). pullSales only adds and updates.
    if (refresh) {
      this.serverPull ||= (async () => {
        const [remote] = await Promise.allSettled([pullOpenOrders(DEVICE_ID)]);
        const startedAt = Date.now();
        const last = this.lastServerPullAt;
        const unpaid = last ? [...new Set((this.posOrders || []).filter(order => order.paymentStatus === 'unpaid')
          .flatMap(order => order.roundUuids || [order.saleUuid]).filter(Boolean))] : [];
        const [sync] = await Promise.allSettled([last ? (async () => {
          const count = await pullSales(new Date(last - 15 * 60_000).toISOString());
          // pullSales reads children by id up to 120 sales; past that it reads whole collections.
          for (let at = 0; count !== null && at < unpaid.length; at += 120) await pullSales(undefined, unpaid.slice(at, at + 120));
          return count;
        })() : pullSales(), pullStaff()]);
        if (sync.status === 'fulfilled' && sync.value !== null) this.lastServerPullAt = startedAt;
        return [remote, sync];
      })().finally(() => { this.serverPull = null; });
    }
    const [remote, sync] = refresh ? await this.serverPull : [];
    if (this.disposed || generation !== this.posReadGeneration) return;
    // A board silently missing every other till is exactly the complaint this
    // was meant to answer, so a failed read says so instead of looking empty.
    // A null return is the same failure wearing a different coat: no backend,
    // or no tenant to read one with. Treating it as success is what let this
    // board show a single iPad's orders and look perfectly healthy.
    this.syncWarning = !refresh ? 'Showing cached orders while the server refreshes.'
      : sync.status === 'rejected'
      ? `Showing this device only — the other tills’ sales could not be read. ${sync.reason?.message || ''}`.trim()
      : sync.value === null
        ? 'Showing this device only — this till is not connected to the business server.'
        : '';

    try {
      const [sales, saleLines, payments, shifts, users, customers, products, tabs] = await db.transaction(
        'r', [db.sales, db.sale_lines, db.payments, db.shifts, db.users, db.customers, db.products, db.tabs],
        async () => {
          const sales = this.allBranches ? await db.sales.toArray()
            : await db.sales.where('branch_id').equals(state.currentBranch?.id || '').toArray();
          const ids = sales.map(sale => sale.id);
          const [lines, payments, shifts, users, customers, tabs] = await Promise.all([
            ids.length ? db.sale_lines.where('sale_id').anyOf(ids).toArray() : [],
            ids.length ? db.payments.where('sale_id').anyOf(ids).toArray() : [],
            db.shifts.toArray(), db.users.toArray(),
            db.customers.bulkGet([...new Set(sales.map(sale => sale.customer_id).filter(Boolean))]),
            db.tabs.toArray(),
          ]);
          const products = await db.products.bulkGet([...new Set(lines.map(line => line.product_id).filter(Boolean))]);
          return [sales, lines, payments, shifts, users, customers.filter(Boolean), products.filter(Boolean), tabs];
        });
      if (this.disposed || generation !== this.posReadGeneration) return;
      const paymentBySale = new Map(payments.map((entry) => [entry.sale_id, entry]));
      // Every row, not just one: a settled proforma has the receivable and the
      // money that cleared it, and the card has to tell them apart.
      const ledgerBySale = new Map();
      for (const entry of payments) {
        ledgerBySale.set(entry.sale_id, [...(ledgerBySale.get(entry.sale_id) || []), entry]);
      }
      const shiftById = new Map(shifts.map((entry) => [entry.id, entry]));
      const userById = new Map(users.map((entry) => [entry.id, entry]));
      const customerById = new Map(customers.map((entry) => [entry.id, entry]));
      const productById = new Map(products.map((entry) => [entry.id, entry]));

      const linesBySale = new Map();
      // Raw rows per sale. Filtering every line for every sale was 3,000 sales
      // x 7,000 lines on each refresh - seconds of frozen screen on a tablet.
      const rawLinesBySale = new Map();
      for (const line of saleLines) {
        rawLinesBySale.set(line.sale_id, [...(rawLinesBySale.get(line.sale_id) || []), line]);
      }
      for (const line of saleLines) {
        const rows = linesBySale.get(line.sale_id) || [];
        rows.push({
          productId: line.product_id,
          name: line.product_name || productById.get(line.product_id)?.name || 'Item',
          qty: line.qty,
        });
        linesBySale.set(line.sale_id, rows);
      }

      // Names for every staff id the board may have to show, whichever system
      // the order came from.
      this.staffNames = new Map(users.map((entry) => [entry.id, entry.name]));

      // What this device is still holding. A round on an open tab is kept off
      // the server on purpose so it can still be corrected here, which means
      // no other device - the owner's included - can see it until the tab
      // settles. Said out loud, because otherwise it reads as data loss.
      // The count alone said something was wrong without saying what, which is
      // most of the way to useless: the reason is the whole diagnosis.
      const stuck = sales.filter((sale) => sale.sync_error_msg);
      const reasons = [...new Set(stuck.map((sale) => sale.sync_error_msg))].slice(0, 2);
      this.localOnlyNote = stuck.length
        ? `${stuck.length} sale(s) failed to reach the server: ${reasons.join(' | ')}`
        : '';
      const queued = sales.filter(sale => !sale.synced_at && sale.status !== 'VOIDED');
      if (queued.length) this.localOnlyNote = `${queued.length} order(s) are still held on this device and are not yet included in server sales totals. ${this.localOnlyNote}`.trim();

      // Every other till's open tables. They are published for watching only,
      // so they arrive flagged read-only and carry no settle or edit controls:
      // the tab is still corrected on the device that is running it.
      if (remote?.status === 'fulfilled') this.remoteOpenOrders = remote.value;
      if (remote?.status === 'rejected') this.syncWarning += ' Running tables from other tills could not refresh; showing the last available list.';

      this.posOrders = mergeTabRounds(sales.filter(sale => !sale.proforma_id
        && !isNonBillableAdjustment(sale, rawLinesBySale.get(sale.id) || [], ledgerBySale.get(sale.id) || [])).map((sale) => {
        const order = saleAsOrder(sale, {
          payment: paymentBySale.get(sale.id),
          payments: ledgerBySale.get(sale.id),
          customerName: customerById.get(sale.customer_id)?.name || '',
          lines: linesBySale.get(sale.id) || [],
        });
        // The sale's own staff id first; the shift is the fallback for rows
        // written before sales carried one.
        return {
          ...order,
          // What ties this round to the rest of its table's bill.
          tabId: sale.tab_id || null,
          cashierName: handledBy(order, this.staffNames)
            || userById.get(shiftById.get(sale.shift_id)?.user_id)?.name
            || '',
        };
      }), tabs);
    } catch (error) {
      if (this.disposed || generation !== this.posReadGeneration) return;
      // A failed read is not an empty floor. Keep the last complete snapshot.
      this.syncWarning = 'Orders could not refresh. Keeping the last displayed orders; the list may be out of date.';
      console.error('Order snapshot read failed', error);
    }
  }

  /** Everything the board shows, newest first, whichever system it came from. */
  allOrders() {
    // A menu order is placed by the customer, so its name comes from whoever
    // has acted on it since - settled it, printed it, or moved its status.
    const menu = this.customerOrders.map((order) => ({
      ...order,
      cashierName: order.cashierName || handledBy(order, this.staffNames),
    }));
    // Other tills' open tables, named the same way as everything else so the
    // board reads as one floor rather than as this device plus a footnote.
    const knownRounds = new Set(this.posOrders.flatMap(order => order.roundUuids || [order.saleUuid]).filter(Boolean));
    const remote = (this.remoteOpenOrders || [])
      .filter(order => !order.saleUuids?.length || !order.saleUuids.every(uuid => knownRounds.has(uuid)))
      .map((order) => ({
      ...order,
      cashierName: order.cashierName || handledBy(order, this.staffNames),
    }));
    return [...menu, ...this.posOrders, ...remote]
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

  /**
   * Orders belonging to the chosen trading days.
   *
   * An order with no readable date is kept rather than hidden: a card that
   * exists and cannot be found is worse than one sitting outside its night.
   */
  withinDates(orders) {
    // Running bills remain findable until settled, even across trading days.
    if (this.customerTab === 'running') return orders;
    if (!this.dateFrom || !this.dateTo) return orders;
    let window;
    try {
      window = tradingRange(this.dateFrom, this.dateTo, 'full', this.hours);
    } catch {
      return orders;
    }
    return orders.filter((order) => {
      const at = placedAt(order);
      if (!at) return true;
      return at.getTime() >= window.from && at.getTime() <= window.to;
    });
  }

  /** Redraws tiles, tabs, cards and pager from the current live snapshot. */
  renderCustomerBoard() {
    const branchId = state.currentBranch?.id;
    const stats = this.container.querySelector('#customer-orders-stats');
    const tabs = this.container.querySelector('#customer-orders-tabs');
    const list = this.container.querySelector('#customer-orders-list');
    const pager = this.container.querySelector('#customer-orders-pager');
    if (!stats || !tabs || !list || !pager) return;

    // Narrowed once, before anything is counted or drawn. Filtering only the
    // cards left the tiles totalling every order ever taken, so picking Today
    // showed "18 Total Orders" above an empty board - the tiles disagreeing
    // with the list underneath them, which is worse than no tiles at all.
    const orders = this.withinDates(this.allOrders());
    const runningNote = this.container.querySelector('#orders-running-note');
    if (runningNote) runningNote.hidden = this.customerTab !== 'running';

    stats.innerHTML = orderStats(orders, branchId, this.allBranches).map((tile) => `
      <div class="co-stat">
        <div class="co-stat-value">${tile.count}</div>
        <div class="co-stat-label">${tile.label}</div>
      </div>`).join('');

    tabs.innerHTML = [...ORDER_TABS, { id: 'proformas', label: 'Proforma invoices' }].map((tab) => `
      <button type="button" class="co-tab" role="tab" data-order-tab="${tab.id}"
        aria-selected="${tab.id === this.customerTab}">${tab.label}</button>`).join('');

    const rows = sortOrders(visibleOrders(orders, branchId, {
      tab: this.customerTab,
      search: this.customerSearch,
      allBranches: this.allBranches,
    }), this.orderSort);
    const view = paginate(rows, this.customerPage, ORDER_CARDS_PER_PAGE);
    this.customerPage = view.page;

    // An empty page used to be reported as "no orders for this branch yet"
    // even when the branch had plenty and the tab or search had hidden them.
    list.innerHTML = view.rows.length
      ? renderOrderGrid(view.rows, this.productImages)
      : `<p class="co-empty">${orders.length
        ? 'No orders match this view. Clear the search, or try another tab.'
        : 'No orders yet.'}</p>`;
    pager.innerHTML = pagerHtml('customer-orders-pager-strip', view);
    bindPager('customer-orders-pager-strip', view, (next) => {
      this.customerPage = next;
      this.renderCustomerBoard();
    });
    let proformas = this.container.querySelector('#orders-proformas');
    if (!proformas) {
      proformas = document.createElement('div');
      proformas.id = 'orders-proformas';
      list.after(proformas);
    }
    const standalone = this.customerTab === 'proformas';
    proformas.hidden = !standalone;
    list.hidden = standalone;
    pager.hidden = standalone;
    stats.hidden = standalone;
    stats.style.display = standalone ? 'none' : '';
    // On phones the status tabs live in the filter sheet. Keep its trigger
    // reachable so opening this register cannot strand someone outside Running.
    this.container.querySelector('#orders-search-toolbar').classList.toggle('proforma-view', standalone);
    this.container.querySelector('#orders-date-bar').style.display = standalone ? 'none' : '';
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
    // Read on every open: the board is rendered before payment settings are
    // pulled, so a render-time check kept offering cash to cash-off businesses.
    modal.querySelectorAll('[data-pay-method="cash"], [data-settle-method="cash"]')
      .forEach((card) => { card.hidden = !cashIsEnabled(); });
    modal.style.display = 'flex';
    modal.classList.add('active');
  }

  hideModal(selector) {
    const modal = this.container.querySelector(selector);
    modal.style.display = 'none';
    modal.classList.remove('active');
  }

  /** A Finance Reconcile link opens the matching unpaid order in one step. */
  openLinkedReconciliation() {
    if (!this.reconcileReference || this.reconciliationOpened) return;
    // Tab Management links a tab by one round's invoice; the card may carry the tab's name.
    const order = this.allOrders().find((entry) => entry.ref === this.reconcileReference
      || entry.roundRefs?.includes(this.reconcileReference));
    if (!order) return;
    this.reconciliationOpened = true;
    if (order.source === 'pos' && this.invoiceLinked) {
      void this.openInvoiceModal(order.id);
      return;
    }
    if (order.paymentStatus === 'paid') {
      this.container.querySelector('#customer-orders-status').textContent = `${order.ref} has already been reconciled.`;
      return;
    }
    if (order.source === 'pos' && this.editLinked) void this.openTabEditor(order.id);
    else if (order.source === 'pos') void this.startPrintedSettlement(order.id);
    else this.startPrintedCustomerPayment(order.id);
  }

  startPrintedCustomerPayment(orderId) {
    requirePrintedReceipt({ customerOrderId: orderId }, {
      isActive: () => this.container.isConnected && !this.disposed,
      onReady: () => this.openPayModal(orderId),
    });
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
    for (const id of ['#pay-phone', '#pay-code', '#pay-code-amount', '#pay-card-ref', '#pay-bank-ref']) this.container.querySelector(id).value = '';
    this.selectPayMethod(null);
    this.showModal('#pay-modal');
  }

  /** Shows one method's fields at a time, exactly as the till's checkout does. */
  selectPayMethod(method) {
    this.container.querySelectorAll('[data-pay-method]').forEach((card) => {
      const chosen = card.dataset.payMethod === method;
      card.classList.toggle('selected', chosen);
      card.setAttribute('aria-selected', String(chosen));
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
    this.filterSheet = createMobileFilters({
      container: this.container, toolbar: this.container.querySelector('.co-toolbar'),
      controls: ['#orders-scope-wrap', '#orders-date-bar', '#customer-orders-tabs', '#orders-sort-wrap', '#orders-export-btn'].map(selector => this.container.querySelector(selector)),
      title: 'Order filters',
      count: () => Number(this.customerTab !== 'all') + Number(Boolean(this.dateFrom || this.dateTo)) + Number(!this.allBranches && ['Owner', 'Store Manager'].includes(state.currentUser?.role)),
      reset: () => {
        this.customerTab = 'all'; this.dateFrom = ''; this.dateTo = ''; this.customerPage = 1;
        this.allBranches = ['Owner', 'Store Manager'].includes(state.currentUser?.role);
        this.container.querySelector('#orders-all-branches').checked = this.allBranches;
        this.container.querySelector('#orders-date-from').value = ''; this.container.querySelector('#orders-date-to').value = '';
        this.renderCustomerBoard();
      },
    });
    this.container.querySelectorAll('.payment-method-card').forEach(card => {
      card.setAttribute('tabindex', '0');
      card.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); card.click(); }
      });
    });
    this.container.querySelector('#customer-orders-list').addEventListener('click', (event) => {
      const print = event.target.closest('[data-print-order]');
      if (print) return void this.printTicket(print);
      const pay = event.target.closest('[data-pay-order]');
      if (pay) return this.startPrintedCustomerPayment(pay.dataset.payOrder);
      const settle = event.target.closest('[data-settle-sale]');
      if (settle) return void this.startPrintedSettlement(settle.dataset.settleSale);

      const edit = event.target.closest('[data-edit-tab]');
      if (edit) return void this.openTabEditor(edit.dataset.editTab);
      const invoice = event.target.closest('[data-invoice-sale]');
      if (invoice) void this.openInvoiceModal(invoice.dataset.invoiceSale);
    });

    this.container.querySelector('#settle-close').addEventListener('click', () => this.hideModal('#settle-modal'));
    this.container.querySelector('#settle-confirm').addEventListener('click', (event) => void this.settle(event.target));

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

    this.container.querySelector('#pay-modal .checkout-payment-methods').addEventListener('click', (event) => {
      const card = event.target.closest('[data-pay-method]');
      if (card) this.selectPayMethod(card.dataset.payMethod);
    });

    this.container.querySelector('#settle-modal .checkout-payment-methods').addEventListener('click', (event) => {
      const card = event.target.closest('[data-settle-method]');
      if (card) this.selectSettleMethod(card.dataset.settleMethod);
    });

    this.container.querySelector('#pay-code-settle').addEventListener('click', (event) => {
      let receipt;
      try { receipt = manualReceipt(this.container.querySelector('#pay-code').value, this.container.querySelector('#pay-code-amount').value); }
      catch (error) { this.container.querySelector('#pay-message').textContent = error.message; return; }
      void this.payAction(event.target, async (orderId) => {
        const result = await settleCustomerOrderByCode(orderId, receipt.reference, receipt.receiptAmountMinor);
        const balance = result.availableMinor > 0 ? ` KES ${(result.availableMinor / 100).toFixed(2)} remains on this code.` : '';
        return `Payment recorded.${balance} Print the kitchen ticket.`;
      }, 'Recording payment…');
    });

    this.container.querySelector('#pay-card').addEventListener('click', (event) => {
      const reference = this.container.querySelector('#pay-card-ref').value.trim();
      void this.payAction(event.target, async (orderId) => {
        await settleCustomerOrderCard(orderId, reference);
        return 'Card payment recorded. Print the kitchen ticket.';
      }, 'Recording the card payment…');
    });

    this.container.querySelector('#pay-bank').addEventListener('click', (event) => {
      const reference = this.container.querySelector('#pay-bank-ref').value.trim();
      void this.payAction(event.target, async (orderId) => {
        await settleCustomerOrderBank(orderId, reference);
        return 'Bank transfer reconciled. Print the kitchen ticket.';
      }, 'Recording the bank transfer…');
    });

    this.container.querySelector('#pay-cash').addEventListener('click', (event) => {
      void this.payAction(event.target, async (orderId) => {
        await settleCustomerOrderCash(orderId);
        return 'Cash received and reconciled. Print the kitchen ticket.';
      }, 'Recording cash received…');
    });

    // A narrower tab or search can strand the user past the last page, so both
    // reset to page one.
    // Dates narrow the board without touching the status tabs, so "pending,
    // last night" is one question rather than two screens.
    this.container.querySelector('#orders-date-bar').addEventListener('click', (event) => {
      const button = event.target.closest('[data-orders-range]');
      if (!button) return;
      const range = button.dataset.ordersRange;
      if (range === 'all') {
        this.dateFrom = '';
        this.dateTo = '';
      } else {
        const period = quickFinancialPeriod(range, new Date(), this.hours);
        this.dateFrom = period.start;
        this.dateTo = period.end;
      }
      this.container.querySelector('#orders-date-from').value = this.dateFrom;
      this.container.querySelector('#orders-date-to').value = this.dateTo;
      this.customerPage = 1;
      this.renderCustomerBoard();
    });

    for (const id of ['orders-date-from', 'orders-date-to']) {
      this.container.querySelector(`#${id}`).addEventListener('change', () => {
        this.dateFrom = this.container.querySelector('#orders-date-from').value;
        this.dateTo = this.container.querySelector('#orders-date-to').value;
        this.customerPage = 1;
        this.renderCustomerBoard();
      });
    }

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
    this.container.querySelector('#orders-sort').addEventListener('change', (event) => {
      this.orderSort = event.target.value;
      this.customerPage = 1;
      this.renderCustomerBoard();
    });
    this.container.querySelector('#orders-refresh').addEventListener('click', () => { void this.refreshBoard(); });
    this.container.querySelector('#customer-orders-list').addEventListener('change', async (event) => {
      const select = event.target.closest('[data-customer-order]');
      if (!select?.value) return;
      select.disabled = true;
      try { await updateCustomerOrder(select.dataset.customerOrder, select.value); }
      catch { this.container.querySelector('#customer-orders-status').textContent = 'Could not update the order. Please retry.'; select.disabled = false; select.value = ''; }
    });
    // Organization money roles can move between whole-business and local views.
    const scope = this.container.querySelector('#orders-all-branches');
    if (['Owner', 'Store Manager'].includes(state.currentUser?.role)) {
      this.container.querySelector('#orders-scope-wrap').style.display = 'flex';
      scope.checked = this.allBranches;
      scope.addEventListener('change', (event) => {
        this.allBranches = event.target.checked;
        this.customerPage = 1;
        this.renderCustomerBoard();
      });
    }

    const exportBtn = this.container.querySelector('#orders-export-btn');
    if (exportBtn) exportBtn.addEventListener('click', () => this.exportOrders());

    // Modal Control Events
    const closeBtn = document.getElementById('orders-modal-close');
    const doneBtn = document.getElementById('orders-modal-done');
    const closeModal = () => this.hideModal('#orders-invoice-modal');

    if (closeBtn) closeBtn.addEventListener('click', closeModal);
    if (doneBtn) doneBtn.addEventListener('click', closeModal);

    const etrBtn = document.getElementById('orders-etr-btn');
    if (etrBtn) etrBtn.addEventListener('click', () => { void this.generateInvoiceEtr(); });

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

  /** The invoice being settled, found again by id so nothing goes stale. */
  settleTarget() {
    return this.allOrders().find((order) => order.id === this.settlingSaleId) || null;
  }

  async startPrintedSettlement(saleId) {
    if (this.preparingPrintedCheckout) return;
    this.preparingPrintedCheckout = true;
    try {
      this.settlingSaleId = saleId;
      const order = this.settleTarget();
      if (!order) return;
      const rounds = await this.settleRounds(order, { forPayment: true });
      if (!rounds.length) throw new Error('Refresh orders before printing the receipt.');
      requirePrintedReceipt({ saleUuids: rounds.map(round => round.sale_uuid) }, {
        isActive: () => this.container.isConnected && !this.disposed,
        onReady: () => this.openSettleModal(saleId),
      });
    } catch (error) {
      showNotification(error.message || 'The receipt could not be prepared.', 'error');
    } finally {
      this.preparingPrintedCheckout = false;
    }
  }

  openSettleModal(saleId) {
    this.settlingSaleId = saleId;
    const order = this.settleTarget();
    if (!order) return;
    // Keep the checkout reference through a partial settlement and reopening.
    // Tenant, staff and branch scope prevents another account inheriting it.
    const key = `pos_bill_checkout:${JSON.stringify([state.currentTenant?.id, state.currentUser?.id, order.branchId || state.currentBranch?.id, saleId])}`;
    this.settleRequestIds ||= new Map();
    this.settleRequestId = this.settleRequestIds.get(saleId);
    try { this.settleRequestId ||= globalThis.localStorage?.getItem(key); } catch {}
    this.settleRequestId ||= crypto.randomUUID();
    this.settleRequestIds.set(saleId, this.settleRequestId);
    try { globalThis.localStorage?.setItem(key, this.settleRequestId); } catch {}

    this.container.querySelector('#settle-due').textContent = `KES ${((order.dueMinor || order.totalMinor) / 100).toFixed(2)}`;
    this.container.querySelector('#settle-summary').textContent =
      `Invoice ${order.ref} · ${order.customerName}${order.cashierName ? ` · billed by ${order.cashierName}` : ''}`;
    this.container.querySelector('#settle-message').textContent = '';
    this.container.querySelector('#settle-reference').value = '';
    this.container.querySelector('#settle-receipt-amount').value = '';
    // One key per opening of this modal: a retried push must not raise a
    // second prompt for a payment the backend may already have taken.
    this.settleStkKey = `mpesa_${crypto.randomUUID()}`;
    this.container.querySelector('#settle-stk-status').classList.add('hidden');
    this.container.querySelector('#settle-phone').value = order.customerPhone || '';
    this.container.querySelector('#settle-stk-note').textContent = order.roundIds?.length > 1
      ? `Charges all ${order.roundIds.length} rounds at once`
      : "Send the prompt to the customer's phone";
    this.selectSettleMethod(null);
    this.showModal('#settle-modal');
  }

  /**
   * Picks how the money arrived.
   *
   * Only M-Pesa can be proven; the rest are records of money taken elsewhere,
   * and the note under the field says which of the two you are doing.
   */
  selectSettleMethod(method) {
    this.settleMethod = method;
    this.container.querySelector('#settle-receipt-amount-wrap').classList.toggle('hidden', method !== 'mpesa');
    this.container.querySelectorAll('[data-settle-method]').forEach((card) => {
      const chosen = card.dataset.settleMethod === method;
      card.classList.toggle('selected', chosen);
      card.setAttribute('aria-selected', String(chosen));
    });

    // STK takes the money now and needs a phone; every other method records
    // money taken elsewhere and needs a reference.
    const pushing = method === 'stk';
    this.container.querySelector('#settle-stk-inputs').classList.toggle('hidden', !pushing);
    this.container.querySelector('#settle-reference-inputs').classList.toggle('hidden', !method || pushing);
    this.container.querySelector('#settle-confirm').disabled = !method;
    if (!method) {
      this.container.querySelector('#settle-confirm').innerText = 'Choose a payment method';
      return;
    }
    this.container.querySelector('#settle-confirm').innerText = pushing
      ? 'Send STK push'
      : 'Record payment';
    if (pushing) return;

    const reference = this.container.querySelector('#settle-reference');
    const note = this.container.querySelector('#settle-note');

    const copy = {
      mpesa: ['M-Pesa code, e.g. QGH4T21XZ9', 'Enter the code and amount from the payment message.'],
      bank_transfer: ['Bank reference on the transfer (optional)', 'Recorded exactly as typed, so the transfer on the statement can be matched back to this invoice. Nothing verifies it here.'],
      cash: ['Who received it, or a note (optional)', 'Recorded as cash taken at the counter, on the word of whoever is signed in.'],
      card: ['Terminal approval code (optional)', 'Records money the card terminal already took. There is no card integration.'],
    }[method];

    reference.placeholder = copy[0];
    reference.hidden = method === 'cash';
    const label = this.container.querySelector('label[for="settle-reference"]');
    label.hidden = method === 'cash';
    label.textContent = { mpesa: 'M-Pesa confirmation code', bank_transfer: 'Bank reference (optional)', card: 'Card terminal reference (optional)' }[method] || 'Reference';
    note.textContent = copy[1];
  }

  /**
   * Takes the money now, from the board.
   *
   * The same prompt the till sends, for whoever is holding the order screen
   * when the customer asks to pay. One push covers the whole outstanding
   * amount; the invoice settles only on what M-Pesa confirms, and the attempt
   * itself is the proof the server checks.
   */
  async settleByStk(button, order, rounds) {
    const message = this.container.querySelector('#settle-message');
    const phone = this.container.querySelector('#settle-phone').value.trim();
    if (!phone) {
      message.textContent = 'Enter the phone number to send the prompt to.';
      return;
    }

    // The rounds' own items are the cart this push is priced against. Sending
    // none is why settling a proforma by STK never raised a prompt.
    const lines = catalogueCartLines(
      await db.sale_lines.where('sale_id').anyOf(rounds.map((round) => round.id)).toArray(),
    );
    const savedBill = rounds.every(round => round.synced_at);
    if (lines.length === 0 && !savedBill) {
      message.textContent = 'This order has no items the catalogue can price, so M-Pesa cannot be charged for it. Record the payment under another method.';
      return;
    }
    // The prompt is raised against a customer, so a walk-in proforma is refused
    // by the server with a validation message no cashier can act on.
    if (!order.customerId && !savedBill) {
      message.textContent = 'This order is not on a customer, and an M-Pesa prompt is raised against one. Put it on a customer, or record the payment under another method.';
      return;
    }

    const status = this.container.querySelector('#settle-stk-status');
    const badge = this.container.querySelector('#settle-stk-badge');
    const say = (text, level) => {
      status.classList.remove('hidden');
      badge.className = `badge ${level}`;
      badge.innerText = text;
    };

    button.disabled = true;
    say('Checking activation and sending the prompt…', 'warning');
    message.textContent = '';

    try {
      const push = await this.mpesa.initiateStkPush({
        phone,
        amountKes: order.dueMinor / 100,
        branchId: order.branchId || state.currentBranch?.id,
        deviceId: DEVICE_ID,
        idempotencyKey: this.settleStkKey,
        orderReference: this.settleStkKey.slice(0, 40),
        customerId: order.customerId || null,
        lines: savedBill ? [] : lines,
        ...(savedBill ? { settlementSaleUuids: rounds.map(round => round.sale_uuid), checkoutId: this.settleRequestId } : {})
      });

      if (!push.success) {
        say(push.message || 'M-Pesa did not accept this payment.', 'danger');
        if (['failed', 'cancelled', 'expired'].includes(push.status)) this.settleStkKey = `mpesa_${crypto.randomUUID()}`;
        return;
      }

      say(push.customerMessage || 'Awaiting the customer’s PIN…', 'warning');
      const result = await this.mpesa.awaitResult(push.attemptId, (text) => say(text, 'warning'));

      if (result.status !== 'paid') {
        if (['failed', 'cancelled', 'expired'].includes(result.status)) this.settleStkKey = `mpesa_${crypto.randomUUID()}`;
        say(result.resultDesc || 'M-Pesa did not confirm this payment. Do not release goods.', 'danger');
        return;
      }

      say(`Confirmed${result.receipt ? ` · ${result.receipt}` : ''}. Settling…`, 'success');
      let settled = null;
      for (const [index, round] of rounds.entries()) {
        if (await this.roundOutstandingMinor(round) <= 0) continue;
        settled = round.synced_at
          ? await settleSale({
            saleUuid: round.sale_uuid,
            checkoutId: this.settleRequestId,
            requestId: `${this.settleRequestId}-stk-${index}`,
            method: 'mpesa',
            // The attempt is the proof; the server reads the receipt off it.
            attemptId: push.attemptId,
          })
          // A round the server has never seen cannot be settled on it. M-Pesa
          // did confirm this money, so the receipt rides up with the sale when
          // the outbox transmits it.
          : await this.settleRoundLocally(round, {
            method: 'mpesa', reference: result.receipt || push.attemptId, verified: true,
          });
        await this.recordSettlementLocally(round, settled, index);
      }
      // Confirmed money, so it goes up now, and the table it was holding is
      // released - by whichever means the table paid, the outcome is the same.
      const reached = await this.pushSettledRounds(rounds);
      const freedTable = await freeSettledTab(rounds.map((round) => round.tab_id).find(Boolean));
      await this.loadPosOrders();
      this.renderCustomerBoard();
      message.textContent = (settled ? `Paid. M-Pesa confirmed KES ${(settled.receivedMinor / 100).toFixed(2)}.` : 'This bill was already settled on another device; no second settlement was recorded.')
        + (reached.ok ? '' : ` Not on the server yet: ${reached.reason}`)
        + (freedTable ? ` Table ${freedTable} is now free.` : '');
      say('Settled.', 'success');
    } catch (error) {
      say(error.message || 'That payment could not be taken.', 'danger');
    } finally {
      button.disabled = false;
    }
  }

  /**
   * Takes items off a tab from the board.
   *
   * The same correction the till offers, for whoever is looking at the order
   * rather than standing at the till that rang it.
   */
  async openTabEditor(tabId) {
    const order = this.posOrders.find((entry) => entry.id === tabId);
    if (!order) return;

    // Any unpaid round can lose an item; one already on the server is voided
    // there and re-sent without it (removeTabLine handles both).
    let rounds;
    try { rounds = await this.settleRounds(order); } catch (error) {
      showNotification(error.message || 'This order could not be loaded for editing.', 'error');
      return;
    }
    const editable = rounds.filter((round) => round.status === 'PENDING_PAYMENT').map((round) => round.id);
    const lines = await db.sale_lines.where('sale_id').anyOf(editable).toArray();
    if (lines.length === 0) {
      showNotification('Nothing on this order can be edited: it has been paid.', 'warning');
      return;
    }
    const products = new Map((await db.products.toArray()).map((product) => [product.id, product.name]));

    const names = lines
      .map((line, index) => `${index + 1}. ${line.qty} × ${products.get(line.product_id) || 'Item'} — KES ${(Number(line.line_total) || 0).toFixed(2)}`)
      .join('\n');
    const answer = window.prompt(
      `${order.ref} · Table ${order.tableNumber}\n\n${names}\n\nType the number of the item to remove, or Cancel.`,
    );
    const choice = Number(answer);
    if (!Number.isInteger(choice) || choice < 1 || choice > lines.length) return;

    const line = lines[choice - 1];
    try {
      const { freedTable } = await removeTabLine(line.id);
      await this.loadPosOrders();
      this.renderCustomerBoard();
      // A notification, not the status line: that sits at the top of the board,
      // off screen from the card being edited, so a failure looked like nothing.
      showNotification(`${products.get(line.product_id) || 'Item'} removed from ${order.ref}. Its stock is back.`
        + (freedTable ? ` Nothing is left on Table ${freedTable}, so its tab is closed.` : ''), 'success');
    } catch (error) {
      showNotification(error.message || 'That item could not be removed.', 'error');
    }
  }

  /**
   * The local sale rows behind the card, whether it is one round or a tab.
   *
   * A merged tab card carries the tab's id, not a sale's, so the rounds have to
   * be fetched to know their uuids and - the part that matters here - whether
   * the server has ever heard of them.
   */
  async settleRounds(order, { forPayment = false } = {}) {
    if (order.readOnly) {
      if (!order.saleUuids?.length || (order.roundCount && order.roundCount !== order.saleUuids.length)) {
        throw new Error('This shared order has incomplete details. Refresh orders before taking payment.');
      }
      await pullSales(undefined, order.saleUuids);
      const rounds = await db.sales.where('sale_uuid').anyOf(order.saleUuids).toArray();
      if (rounds.length !== order.saleUuids.length || rounds.some(round => !round.synced_at)) {
        throw new Error('This order is still syncing from the device where it was entered. Retry shortly before taking payment.');
      }
      return rounds;
    }
    const ids = order.roundIds?.length ? order.roundIds : [order.id];
    const rounds = await billableCheckoutRounds((await Promise.all(ids.map((id) => db.sales.get(id)))).filter(Boolean), db);
    if (!forPayment) return rounds;
    const { firebaseConfigured } = await import('../services/firebase');
    if (firebaseConfigured) {
      for (const round of rounds) if (!round.synced_at) await state.syncManager.publishSale(round.id);
      await pullSales(undefined, rounds.map(round => round.sale_uuid));
      return (await Promise.all(rounds.map(round => db.sales.get(round.id)))).filter(Boolean);
    }
    return rounds;
  }

  async settle(button) {
    if (this.settlingInFlight) return;
    this.settlingInFlight = true;
    button.disabled = true;
    try { return await this.performSettlement(button); }
    finally { this.settlingInFlight = false; button.disabled = !this.settleMethod; }
  }

  async performSettlement(button) {
    const order = this.settleTarget();
    if (!order) return;
    let rounds;
    try { rounds = await this.settleRounds(order, { forPayment: true }); }
    catch (error) { this.container.querySelector('#settle-message').textContent = error.message; return; }
    if (rounds.length === 0) {
      this.container.querySelector('#settle-message').textContent =
        'This order is no longer on this device. Refresh the board and try again.';
      return;
    }

    const method = this.settleMethod;
    if (!method) return;
    if (['mpesa', 'stk'].includes(method) && rounds.some(round => !round.synced_at)) {
      this.container.querySelector('#settle-message').textContent = 'Reconnect and save every round to the server before taking M-Pesa payment.';
      return;
    }
    const reference = this.container.querySelector('#settle-reference').value.trim().toUpperCase();
    const message = this.container.querySelector('#settle-message');
    let receipt;
    if (method === 'mpesa') {
      try { receipt = manualReceipt(reference, this.container.querySelector('#settle-receipt-amount').value); }
      catch (error) { message.textContent = error.message; return; }
    }
    if (method === 'cash' && !cashIsEnabled()) return;

    // Claim the authoritative bill before sending a prompt or recording money.
    // A second device cannot start another checkout against the same rounds.
    if (rounds.some(round => round.synced_at)) {
      try {
        const claim = await claimSalePayment({
          saleUuids: rounds.map(round => round.sale_uuid), checkoutId: this.settleRequestId,
          deviceId: DEVICE_ID,
          method: method === 'stk' ? 'stk' : method,
          expectedMinor: (await Promise.all(rounds.map(round => this.roundOutstandingMinor(round)))).reduce((sum, amount) => sum + amount, 0),
          ...(method === 'stk' ? { stkKey: this.settleStkKey } : {}),
        });
        order.dueMinor = claim.dueMinor;
        order.customerId ||= rounds[0]?.customer_id;
        this.container.querySelector('#settle-due').textContent = `KES ${(claim.dueMinor / 100).toFixed(2)}`;
      } catch (error) { message.textContent = error.message; return; }
    }

    // Taking the money now rather than recording money already taken.
    if (method === 'stk') return await this.settleByStk(button, order, rounds);

    button.disabled = true;
    message.textContent = 'Recording the payment…';

    try {
      // One request id per attempt, per round: a retry after a lost response
      // records the same money once, not twice. Every round is settled under
      // the tender that actually paid - never quietly relabelled - so the
      // rounds still sum to the money that arrived.
      let result = null;
      let appliedMinor = 0;
      let availableMinor = Infinity;
      for (const [index, round] of rounds.entries()) {
        // A round on this tab that owes nothing is already paid for. Settling
        // it again wrote a zero-amount payment, and a zero is not money: the
        // server refused the whole sale on it, so a part-paid tab could never
        // be finished off and the takings stayed on the till.
        const roundDue = await this.roundOutstandingMinor(round);
        if (roundDue <= 0) continue;
        if (availableMinor <= 0) break;
        result = round.synced_at
          ? await settleSale({
            saleUuid: round.sale_uuid, checkoutId: this.settleRequestId,
            requestId: method === 'mpesa' ? `${this.settleRequestId}-${reference}-${round.sale_uuid}` : `${this.settleRequestId}-${index}`,
            method, reference,
            ...(receipt ? { receiptAmountMinor: receipt.receiptAmountMinor } : {}),
          })
          : await this.settleRoundLocally(round, { method, reference });
        await this.recordSettlementLocally(round, result, index);
        appliedMinor += result.settledMinor;
        availableMinor = result.availableMinor ?? Infinity;
      }
      if (!result) {
        message.textContent = 'Nothing on this order is outstanding — it has already been paid for.';
        return;
      }
      // A confirmed payment belongs on the server now, not at the next tick.
      // Settling releases the round - it stops being a tab the till is still
      // working - so this is the first moment it can go, and waiting for the
      // scheduler left confirmed money sitting on the device for no reason.
      const reached = await this.pushSettledRounds(rounds);
      // Paid in full means the table is free: the tab is what was holding it.
      const freedTable = await freeSettledTab(rounds.map((round) => round.tab_id).find(Boolean));
      await this.loadPosOrders();
      this.renderCustomerBoard();
      const freed = freedTable ? ` Table ${freedTable} is now free.` : '';
      const remainingMinor = Math.max(0, order.dueMinor - appliedMinor);
      this.container.querySelector('#settle-due').textContent = `KES ${(remainingMinor / 100).toFixed(2)}`;
      message.textContent = `Applied KES ${(appliedMinor / 100).toFixed(2)}. `
        + (remainingMinor > 0 ? `KES ${(remainingMinor / 100).toFixed(2)} still due. Enter the next code or choose another payment method.` : 'Bill fully paid.')
        + (reached.ok ? '' : ` Sync warning: ${reached.reason}`) + freed;
      this.container.querySelector('#settle-reference').value = '';
      this.container.querySelector('#settle-receipt-amount').value = '';
    } catch (error) {
      message.textContent = error.message || 'That payment could not be recorded.';
    } finally {
      button.disabled = !this.settleMethod;
    }
  }

  /**
   * Settles a round the server has never seen.
   *
   * A round on an open tab is deliberately held back from the server until it
   * settles - see `awaitingTransmission` - so asking the server to settle it
   * only ever produced "Sale not found". The till records the tender itself and
   * marks the round complete; the outbox then transmits it once, already paid,
   * exactly as a sale rung straight through goes up.
   *
   * Nothing here is verified. Cash, card and bank transfers are money taken
   * elsewhere and recorded on the word of whoever is signed in, which is what
   * they are on the server too.
   */
  /**
   * Sends the rounds a settlement just released, and says whether they landed.
   *
   * A payment confirmed at the counter has to become a payment the business
   * holds. Until it does it is money only one iPad knows about, so the answer
   * here is reported to the cashier rather than assumed.
   */
  async pushSettledRounds(rounds) {
    const sync = state.syncManager;
    if (!sync) return { ok: false, reason: 'this till is not connected to the business server.' };
    try {
      await sync.syncOutbox();
    } catch (error) {
      return { ok: false, reason: error?.message || 'the server could not be reached.' };
    }
    const after = (await Promise.all(rounds.map((round) => db.sales.get(round.id)))).filter(Boolean);
    const stuck = after.filter((sale) => !sale.synced_at);
    if (!stuck.length) return { ok: true };
    const reason = stuck[0].sync_error_msg || 'it is still queued to be sent.';
    // The one refusal a cashier can actually act on, so say where to act.
    const disabled = /(\w+) is not enabled for this tenant/.exec(reason);
    return {
      ok: false,
      reason: disabled
        ? `this business has not enabled ${disabled[1].replace(/_/g, ' ')} payments. An owner or store manager turns it on in Settings → Payments → "Other accepted tenders", then this will send on its own.`
        : reason,
    };
  }

  /** What this one round still owes, in minor units. */
  async roundOutstandingMinor(round) {
    const owing = await db.payments.where('sale_id').equals(round.id).toArray();
    return owing.reduce((total, row) => (
      isReceivable(row.method) && !row.settled_at
        ? total + Math.round((Number(row.amount) || 0) * 100)
        : total
    ), 0);
  }

  async settleRoundLocally(round, { method, reference, verified = false }) {
    const settledMinor = await this.roundOutstandingMinor(round);
    // Withheld only while it was unpaid, and the lease only mattered while this
    // till was still working it. Paid, it belongs on the server.
    await db.sales.update(round.id, { status: 'COMPLETED', held_until: null });
    return {
      saleId: round.id,
      saleUuid: round.sale_uuid,
      method,
      reference: reference || null,
      settledMinor,
      receivedMinor: settledMinor,
      verified,
    };
  }

  /**
   * Mirrors the settlement into this device's ledger.
   *
   * The money screens read Dexie, and a settlement recorded on the server is
   * not money that arrived until the till agrees - otherwise the proforma keeps
   * reporting itself outstanding here until the next pull.
   */
  async recordSettlementLocally(round, result, index = 0) {
    if (result.paymentId) return await recordReceiptSettlement(round, result, { reduceCustomerBalance: true });
    const now = new Date().toISOString();
    // Keyed on the round, never on the card: a merged tab card carries the tab's
    // id, and no payment row is filed under that, so the receivable rows stayed
    // outstanding and the tab kept reappearing as unpaid.
    const owing = await db.payments.where('sale_id').equals(round.id).toArray();
    let toApply = result.settledMinor || 0;
    for (const row of owing) {
      if (row.settled_at || !isReceivable(row.method) || toApply <= 0) continue;
      const minor = Math.round(Number(row.amount) * 100);
      const applied = Math.min(toApply, minor);
      toApply -= applied;
      await db.payments.update(row.id, applied < minor
        ? { amount: (minor - applied) / 100 }
        : { settled_at: now, settled_reference: result.reference || '' });
    }

    // Never a zero row: it is not a payment, and the server refuses a sale
    // that carries one, which strands every real tender on the same invoice.
    if ((result.settledMinor || 0) <= 0) return;

    await db.payments.put({
      id: result.paymentId || `settle-${round.id}-${this.settleRequestId}-${index}`,
      sale_id: round.id,
      method: String(result.method || '').toUpperCase(),
      amount: (result.settledMinor || 0) / 100,
      reference: result.reference || '',
      provider_txn_id: result.reference || '',
      verified: result.verified ? 1 : 0,
      // Tells the outbox not to demand provider proof for a code typed at settlement.
      metadata: String(result.method) === 'mpesa' && !result.verified ? { typedCode: true } : undefined,
      received_at: now,
    });

    // The debt is cleared, so the customer's tab has to come down with it.
    if (round.customer_id) {
      const customer = await db.customers.get(round.customer_id);
      if (customer) {
        await db.customers.update(customer.id, {
          credit_balance: Math.max(0, (customer.credit_balance || 0) - (result.settledMinor || 0) / 100),
        });
      }
    }
  }

  async openInvoiceModal(saleId) {
    // An open tab's card carries the tab's id, not a sale's, so looking it up
    // as a sale found nothing and the button silently did nothing. The invoice
    // is every round on the tab.
    const order = this.allOrders().find((entry) => entry.id === saleId);
    const isTab = Boolean(order && (order.roundIds?.length || order.kind === 'tab' || order.tabId));
    let rounds = order ? await this.settleRounds(order) : [];
    if (isTab && rounds.length) {
      const ledger = await db.payments.where('sale_id').anyOf(rounds.map(round => round.id)).toArray();
      rounds = rounds.filter(round => saleAsOrder(round, {
        payments: ledger.filter(payment => payment.sale_id === round.id),
      }).paymentStatus === 'unpaid');
    }
    const sum = (field) => rounds.reduce((total, round) => total + (Number(round[field]) || 0), 0);
    const sale = rounds.length > 1
      ? { ...rounds[0], subtotal: sum('subtotal'), tax_total: sum('tax_total'), grand_total: sum('grand_total') }
      : rounds[0];
    if (!sale) {
      if (isTab) {
        showNotification('This tab has no unpaid rounds to invoice.', 'warning');
        return;
      }
      showNotification('This order is on another till. Open the invoice on the till running it.', 'warning');
      return;
    }

    let lines = await db.sale_lines.where('sale_id').anyOf(rounds.map((round) => round.id)).toArray();
    const payment = await db.payments.where('sale_id').equals(sale.id).first();
    const etr = await etrFor(sale.id);
    this.invoiceOrderId = saleId;
    this.invoiceSaleIds = rounds.map((round) => round.id);
    const paid = rounds.every((round) => round.status !== 'PENDING_PAYMENT' && round.status !== 'VOIDED');
    const productsList = await db.products.toArray();
    const prodMap = new Map(productsList.map(p => [p.id, p]));

    if (isTab) {
      const combined = mergeTabLines(rounds.map(round => ({
        ...round, paymentStatus: 'unpaid',
        lines: lines.filter(line => line.sale_id === round.id).map(line => ({
          ...line, name: line.product_name || line.name || prodMap.get(line.product_id)?.name || 'Item',
        })),
      })));
      lines = combined.lines;
      Object.assign(sale, { subtotal: combined.subtotal, tax_total: combined.tax_total, grand_total: combined.grand_total });
    }

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
        ${isTab ? `<div><b>Tab invoice:</b> ${escapeHtml(order.ref)} &middot; Table ${escapeHtml(order.tableNumber || sale.table_no || '')}</div>
        <div><b>Round invoices:</b> ${rounds.map(round => escapeHtml(round.invoice_no || `INV-${round.id.substring(0, 8).toUpperCase()}`)).join(', ')}</div>` : `<div><b>Invoice No:</b> ${invNo}</div>`}
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
          const pName = isTab ? escapeHtml(line.name) : prod ? prod.name : 'Item';
          return `
            <div style="margin-bottom: 4px;">
              <div style="display: flex; justify-content: space-between; font-weight: 600;">
                <span>${pName}</span>
                <span>${(Number(line.line_total) || 0).toLocaleString(undefined, {minimumFractionDigits:2, maximumFractionDigits:2})}</span>
              </div>
              <div style="font-size: 12px; color: #555;">
                ${isTab ? `${escapeHtml(line.qty)} items` : `${line.qty} x ${(Number(line.unit_price) || 0).toFixed(2)} (Tax Code: ${line.tax_code || 'A'})`}
              </div>
            </div>
          `;
        }).join('')}
      </div>

      <div style="border-top: 1px dashed #666; margin: 8px 0;"></div>

      <div style="font-size: 13px; line-height: 1.6;">
        <div style="display: flex; justify-content: space-between;">
          <span>Subtotal:</span>
          <span>KES ${isTab ? Number(sale.subtotal).toFixed(2) : sale.subtotal ? sale.subtotal.toFixed(2) : (sale.grand_total * 0.84).toFixed(2)}</span>
        </div>
        <div style="display: flex; justify-content: space-between;">
          <span>VAT (16%):</span>
          <span>KES ${isTab ? Number(sale.tax_total).toFixed(2) : sale.tax_total ? sale.tax_total.toFixed(2) : (sale.grand_total * 0.16).toFixed(2)}</span>
        </div>
        <div style="display: flex; justify-content: space-between; font-weight: 800; font-size: 15px; margin-top: 4px; padding-top: 4px; border-top: 1px solid #000;">
          <span>${isTab ? 'TOTAL DUE:' : 'TOTAL PAID:'}</span>
          <span>KES ${(Number(!isTab && rounds.length === 1 && payment ? payment.amount : sale.grand_total) || 0).toLocaleString(undefined, {minimumFractionDigits: 2})}</span>
        </div>
      </div>

      <div style="border-top: 1px dashed #666; margin: 8px 0;"></div>

      <div style="font-size: 13px;">
        <div><b>Payment Mode:</b> ${isTab ? 'UNPAID' : pmtMethod}</div>
        ${!isTab && payment && payment.reference ? `<div><b>Ref:</b> ${payment.reference}</div>` : ''}
        <div><b>Status:</b> ${isTab ? 'UNPAID' : 'PAID &amp; CONFIRMED'}</div>
      </div>

      <div style="border-top: 1px dashed #666; margin: 8px 0;"></div>

      ${isTab ? '' : renderEtrBlock(etr)}

      <div style="border-top: 1px dashed #666; margin: 8px 0;"></div>
      <div style="text-align: center; font-size: 12px; color: #444; margin-top: 6px;">
        <p style="margin: 0;">Thank you for dining at Vanbransa!</p>
        <p style="margin: 2px 0 0 0;">Powered by Vanbransa Pro POS</p>
      </div>
    `;

    // An ETR is KRA's record of money received, so it is offered once the bill is paid.
    document.getElementById('orders-etr-row').style.display = paid && !etr ? 'flex' : 'none';
    document.getElementById('orders-etr-pin').value = sale.buyer_pin || '';

    this.showModal('#orders-invoice-modal');
  }

  /** Has KRA sign the open invoice, then redraws it as the ETR receipt. */
  async generateInvoiceEtr() {
    const button = document.getElementById('orders-etr-btn');
    if (!this.invoiceSaleIds || button.disabled) return;
    button.disabled = true;
    button.textContent = 'Generating…';
    try {
      await generateEtr(this.invoiceSaleIds, document.getElementById('orders-etr-pin').value);
      await this.openInvoiceModal(this.invoiceOrderId);
      showNotification('ETR generated. Print it for the customer.', 'success');
    } catch (error) {
      showNotification(error?.message || 'The ETR could not be generated.', 'error');
    } finally {
      button.disabled = false;
      button.textContent = 'Generate ETR';
    }
  }

  async exportOrders() {
    const sales = await db.sales.orderBy('sold_at').reverse().toArray();
    const payments = await db.payments.toArray();
    const paymentMap = new Map(payments.map(p => [p.sale_id, p]));

    let csvContent = 'Date/Time,Invoice No,Table,Total KES,Payment Method,Status,Billed By\n';
    for (const s of sales) {
      const dt = new Date(s.sold_at).toLocaleString().replace(',', '');
      const inv = s.invoice_no || s.sale_uuid;
      const tbl = s.table_no ? `Table ${s.table_no}` : 'Takeaway';
      const pmt = paymentMap.get(s.id);
      const amt = pmt ? pmt.amount : (s.grand_total || 0);
      const method = pmt ? pmt.method : 'CASH';
      const status = s.fiscal_status || 'SENT';
      // The export is what gets taken away and argued over, so it names the
      // person too rather than leaving the trail on screen only.
      const by = this.staffNames.get(s.staff_id) || s.staff_id || '';
      csvContent += `"${dt}","${inv}","${tbl}",${amt},"${method}","${status}","${by}"\n`;
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

