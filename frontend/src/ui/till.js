import { tenantStorage } from '../services/tenant-cache.js';
import { billableCheckoutRounds } from '../services/checkout-rounds';
import { createMobileFilters } from './mobile-filters';
import { WALK_IN_CUSTOMER_ID } from '../services/firebase';
import { db } from '../db/schema';
import { logAuditEvent, getHouseStock } from '../db/index';
import { state, showNotification } from '../context';
import { canSell } from '../navigation.js';

const SELLING_OFF = 'Selling is switched off for your role. Ask the owner to switch it on in Settings → Staff & Access.';
import { MpesaService } from '../services/mpesa';
import { paginate, pagerHtml, bindPager } from '../services/paginate';
import { DEVICE_ID, firebaseConfigured, openShift as openCloudShift } from '../services/firebase';
import {
  ensureMpesaAttempt,
  mpesaAttemptFingerprint,
  unavailableMpesaCapability
} from '../services/mpesa-state';
import { mpesaConfirmationCode, toMinor, mapPaymentMethod } from '../services/tender';
import { isReceivable } from '../services/takings';
import { enqueuePrintJob, isStationOnline } from '../services/print-queue';
import { requirePrintedReceipt } from './checkout-print';
import { escapeHtml, renderReceiptHtml } from '../services/print-receipt';
import { etrFor, generateEtr } from '../services/etr';
import { compareNames, pullCatalogue, pullSales } from '../services/catalogue';
import { pullCustomers, saveCustomer } from '../services/customers';
import { saleAsOrder, voidSale, settleSale, claimSalePayment } from '../services/customer-orders';
import { recordReceiptSettlement } from '../services/receipt-settlement';
import { manualReceipt } from '../services/manual-receipt';
import { pullStock } from '../services/stock';
import { closingUpdate, newTab, OPEN, openTabAt, roundTotals, tabKey } from '../services/tabs';
import { pullOpenOrders } from '../services/open-orders';
import { removeTabLine, freeSettledTab, readOpenTabs } from '../services/tab-edit';
import { tillDraftKey, readTillDraft, writeTillDraft } from '../services/till-draft';
import {
  saleLineRate,
  recordedSaleTotals,
  VIP_CHARGE_ID,
  STAFF_DISCOUNT_ID
} from '../services/service-charges';

/**
 * How long a till keeps a just-registered order to itself.
 *
 * Long enough to choose a tender and take the money, short enough that an
 * order abandoned mid-checkout reaches the other tills while the customer is
 * still in the building.
 */
const HELD_ORDER_MS = 3 * 60 * 1000;

export function getCanonicalCategoryName(rawName) {
  if (!rawName) return 'Other';
  const lo = String(rawName).trim().toLowerCase();
  
  if (lo.includes('beer') || lo.includes('cider')) return 'Beers & Ciders';
  if (lo.includes('spirit') || lo.includes('wine') || lo === 'shots' || lo === 'cocktails') return 'Spirits & Wines';
  if (lo.includes('drink') || lo.includes('beverage') || lo.includes('soft') || lo.includes('juice') || lo === 'soda' || lo === 'chiller' || lo === 'freezer' || lo === 'drnks' || lo === 'drunks') return 'Drinks & Beverages';
  if (lo.includes('food') || lo.includes('meal') || lo.includes('snack') || lo.includes('meat') || lo.includes('beef') || lo.includes('poultry') || lo.includes('cereal') || lo.includes('breakfast') || lo.includes('vegetable')) return 'Food & Meals';
  if (lo.includes('consum') || lo.includes('utensil') || lo.includes('disposable') || lo.includes('packaging') || lo.includes('detergent') || lo.includes('toiletrie')) return 'Consumables & Supplies';
  if (lo.includes('service') || lo.includes('charge') || lo.includes('vip')) return 'Services & Charges';
  if (lo.includes('stock') || lo.includes('restock') || /\d{1,2}\/\d{1,2}\/\d{2,4}/.test(lo)) return 'Restocks';
  
  return rawName.trim();
}

export class TillView {
  constructor(container) {
    this.container = container;
    this.productPage = 1;
    this.catalogueProducts = [];
    this.filteredProducts = [];
    this.cart = []; // Current cart items { product, qty, discount_amount, discount_percent, batch }
    this.parkedCarts = []; // Suspended carts
    this.selectedCustomer = null;
    // The order registered at Pay Now, until its tender settles or voids it.
    this.pendingSale = null;
    // The tab this cart is adding a round to, and the open tabs on the floor.
    this.activeTable = null;
    this.openTabs = [];
    this.mpesa = new MpesaService();
    this.selectedPaymentMethod = 'CASH'; // CASH, MPESA, CARD, CREDIT
    this.mpesaRef = null;
    // Only ever set from a backend-confirmed payment; gates automatic order registration.
    this.mpesaVerified = false;
    this.mpesaCapability = unavailableMpesaCapability();
    this.mpesaCapabilityRequest = 0;
    this.mpesaAttempt = null;
    this.mpesaConfirmedAmountMinor = null;
  }

  async load() {
    // A supervisor runs the floor and covers the till when it is busy, so they
    // sell alongside waiters. The server agrees: `supervisor` is in
    // SELLING_ROLES. Discounting is still owner and manager only.

    this.selectedCustomer = await db.customers.where('id').equals(WALK_IN_CUSTOMER_ID).first();
    if (!this.selectedCustomer) {
      // Safety fallback to prevent app crashing if DB record is missing
      this.selectedCustomer = { id: WALK_IN_CUSTOMER_ID, name: 'Walk-In Customer', price_tier: 'RETAIL' };
    }
    await this.restoreDraft();
    this.render();
    await Promise.all([
      this.loadProducts(),
      this.loadCustomerDropdown(this.selectedCustomer?.id || WALK_IN_CUSTOMER_ID, { refresh: false }),
      this.loadOpenTabs(),
    ]);
    if (this.disposed) return;
    // Tab Management's "Add a round" arrives with the table in the link.
    const linkedTable = new URLSearchParams(window.location.search).get('table');
    // Arriving from a tab means adding to it; paying happens back in Tab
    // Management, so this screen offers Add to tab and nothing else.
    this.tabOnly = Boolean(linkedTable);
    if (linkedTable) this.addToTab(linkedTable);
    this.updateCartUI();
    this.refreshCatalogue();
    void this.loadCustomerDropdown(this.selectedCustomer?.id || WALK_IN_CUSTOMER_ID).catch(() => {});
  }

  dispose() {
    clearTimeout(this.searchTimer);
    this.filterSheet?.dispose();
    this.persistDraft();
    this.disposed = true;
    this.releaseHeldLease();
  }

  async restoreDraft() {
    this.draftKey = tillDraftKey({ tenantId: state.currentTenant?.id,
      staffId: state.currentUser?.id, branchId: state.currentBranch?.id });
    try {
      const draft = readTillDraft(sessionStorage, this.draftKey);
      if (draft) {
        // A crash after commit but before clearing the draft must never offer
        // the saved cart as a new sale. Its original ledger row is the proof.
        const saved = draft.cartId ? await db.sales.filter(sale => sale.draft_id === draft.cartId).first() : null;
        this.cart = saved ? [] : draft.cart;
        this.parkedCarts = draft.parkedCarts;
        this.cartDraftId = saved ? null : draft.cartId;
        this.recoveredPaymentAttempt = saved || !draft.cart.length ? null : draft.paymentAttemptKey || null;
        this.selectedCustomer = draft.customer || this.selectedCustomer;
        this.activeTable = draft.activeTable || null;
        this.activeTabId = draft.activeTabId || null;
        if (saved || this.cart.length || this.parkedCarts.length) showNotification(saved
          ? 'The previous cart was already saved. Review its original order in Orders.'
          : 'Restored unfinished work from this browser tab. It has not been submitted as a new order.', 'info');
      }
      this.draftReady = true;
    } catch (error) {
      console.error('Till draft restore failed', error);
      showNotification('Saved draft could not be read. Keep browser data intact and contact support.', 'warning');
    }
  }

  persistDraft() {
    if (!this.draftReady) return;
    if (!this.draftKey) this.draftKey = tillDraftKey({ tenantId: state.currentTenant?.id,
      staffId: state.currentUser?.id, branchId: state.currentBranch?.id });
    if (!this.draftKey) return;
    try {
      if (this.cart.length && !this.cartDraftId) this.cartDraftId = crypto.randomUUID();
      writeTillDraft(sessionStorage, this.draftKey, { cartId: this.cartDraftId || null,
        paymentAttemptKey: this.cart.length ? (this.recoveredPaymentAttempt || this.mpesaAttempt?.idempotencyKey || null) : null,
        cart: this.cart, parkedCarts: this.parkedCarts, customer: this.selectedCustomer,
        activeTable: this.activeTable, activeTabId: this.activeTabId, savedAt: new Date().toISOString() });
      if (!this.cart.length) this.cartDraftId = null;
      this.draftBackupFailed = false;
    } catch (error) {
      if (!this.draftBackupFailed) showNotification('Draft backup failed. Save this cart as an order before leaving or reloading.', 'warning');
      this.draftBackupFailed = true;
      console.error('Till draft backup failed', error);
    }
  }

  /**
   * Brings this till's prices back in line with the server, in the background.
   *
   * The cart prices from the local cache but the server prices the sale from
   * its own catalogue, and refuses one whose payment does not match to the
   * cent. So a till still holding yesterday's price takes the wrong money and
   * the sale is then rejected outright. The counter is never made to wait on
   * the network for this: the cached menu keeps selling, and the grid is only
   * redrawn if a price or an item's availability actually moved.
   */
  async refreshCatalogue() {
    const fingerprint = async () => (await db.products.toArray())
      .map((product) => `${product.id}:${product.sell_price}:${product.is_active}`)
      .sort()
      .join('|');

    try {
      const before = await fingerprint();
      await pullCatalogue();
      if (await fingerprint() === before) return;
      // Nobody awaits this, so the till may have been left for another screen
      // while the pull was in flight. Redrawing then writes into a grid that
      // is no longer on the page.
      if (!this.container.isConnected) return;
      await this.loadProducts();
      showNotification('Prices updated from the server.', 'success');
    } catch {
      // Offline, which is the case the local cache exists for.
    }
  }

  render() {
    this.container.innerHTML = `
      <div class="till-mobile-tabs" aria-label="Till workspace">
        <span class="till-mobile-title" id="till-mobile-title">Products</span>
        <button type="button" id="till-cart-toggle" aria-expanded="false" aria-controls="till-sale-panel"><span id="mobile-cart-action">View cart</span> <span id="mobile-sale-summary" aria-live="polite">0 items</span></button>
      </div>
      <div class="till-grid" data-mobile-panel="products">
        <!-- Products Column -->
        <div class="till-catalogue-col" id="till-products-panel">
          <div class="till-search-bar">
            <div class="search-input-wrapper">
              <input type="text" id="till-search" placeholder="Search by name, SKU or barcode...">
            </div>
            <button class="sec-btn" id="till-park-btn">Park Cart</button>
            <button class="sec-btn" id="till-resume-btn">Resume Carts (<span id="parked-count">${this.parkedCarts.length}</span>)</button>
          </div>
          
          <div class="cat-filters" id="cat-filters">
            <div class="filter-chip active" data-cat="all">All Items</div>
          </div>

          <div class="product-grid" id="till-prod-grid">
            <!-- Populated dynamically -->
          </div>
          <div id="till-product-pager"></div>
        </div>

        <!-- Cart Column -->
        <div class="till-cart-col" id="till-sale-panel">
          <div class="cart-header">
            <h3 id="cart-heading">Current Sale</h3>
            <span class="cart-count" id="cart-item-count" role="status" aria-live="polite">0 Items</span>
          </div>

          <!-- Table and open tabs. A table that keeps ordering gets another
               round on the same tab rather than a second unrelated sale
               nobody can find. Always visible: the first tab of the night has
               to be openable from here, not only from inside checkout. -->
          <div id="till-tab-bar" class="till-tab-bar">
            <div class="till-tab-row">
              <!-- Open tables are suggested as one is typed; the floor itself
                   lives in Tab Management rather than as chips over the cart. -->
              <input type="text" id="till-table-input" list="till-table-options" placeholder="Takeaway — type a table to open a tab">
              <datalist id="till-table-options"></datalist>
              <button type="button" class="sec-btn" id="till-tab-clear">Takeaway</button>
            </div>
            <a href="/tabs" id="till-open-tabs-label" class="till-tab-label hidden"></a>
            <!-- Everything on the table so far, so an item nobody ordered can
                 be taken off before the bill is asked for. -->
            <button type="button" class="sec-btn hidden" id="till-review-tab-btn" style="width:100%;">Review tab items</button>
          </div>

          <div class="cart-list" id="cart-list">
            <div class="cart-empty">
              <span class="cart-empty-icon">🛒</span>
              <span>Cart is empty</span>
            </div>
          </div>

          <!-- Customer & Buyer PIN -->
          <div class="cart-customer-section">
            <div class="customer-attach-header">
              <span>Attach Customer</span>
              <span id="price-tier-indicator" style="color:var(--accent-cyan)">Retail Pricing</span>
            </div>
            <div class="customer-selector" style="display:flex;gap:8px;align-items:center;">
              <select id="cart-customer-select" style="flex:1;">
                <!-- Loaded dynamically -->
              </select>
              ${['Owner', 'Supervisor'].includes(state.currentUser?.role)
                ? '<button type="button" class="sec-btn" id="cart-new-customer-btn" style="white-space:nowrap;padding:6px 10px;">+ New</button>'
                : ''}
            </div>
            <!-- Registering here attaches them to this sale straight away,
                 which is the whole reason the cashier opened it. -->
            <div id="cart-new-customer-form" class="hidden" style="display:flex;flex-wrap:wrap;gap:6px;margin-top:8px;">
              <input type="text" id="cart-new-customer-name" placeholder="Customer or company name" style="flex:1 1 100%;">
              <input type="tel" id="cart-new-customer-phone" placeholder="Phone (optional)" style="flex:1 1 45%;">
              <input type="text" id="cart-new-customer-kra" placeholder="KRA PIN (optional)" style="flex:1 1 45%;">
              <button type="button" class="primary-btn" id="cart-new-customer-save" style="flex:1;">Save &amp; attach</button>
              <button type="button" class="sec-btn" id="cart-new-customer-cancel" style="flex:0 0 auto;">Cancel</button>
              <p id="cart-new-customer-msg" style="flex:1 1 100%;margin:0;font-size:12px;color:var(--text-secondary);"></p>
            </div>
            <div class="buyer-pin-row">
              <input type="text" id="cart-buyer-pin" placeholder="Buyer KRA PIN (Optional)">
            </div>
          </div>

          <!-- Cart Totals & Checkout -->
          <div class="cart-summary">
            <div class="summary-row">
              <span>Subtotal</span>
              <span id="summary-subtotal">KES 0.00</span>
            </div>
            <div class="summary-row" id="summary-vip-row" style="display:none;color:var(--accent-amber);">
              <span>VIP Surcharge (30%)</span>
              <span id="summary-vip-charge">KES 0.00</span>
            </div>
            <div class="summary-row" id="summary-staff-disc-row" style="display:none;color:var(--accent-green);">
              <span>Staff Discount (-20%)</span>
              <span id="summary-staff-disc-amount">-KES 0.00</span>
            </div>
            <div class="summary-row">
              <span>Discount</span>
              <span id="summary-discount">KES 0.00</span>
            </div>
            <div class="summary-row">
              <span>VAT Tax</span>
              <span id="summary-tax">KES 0.00</span>
            </div>
            <div class="summary-row total">
              <span>Total</span>
              <span id="summary-total">KES 0.00</span>
            </div>
            <!-- The round that is not being paid for yet. Without this the
                 only exits from a cart were pay it or cancel it, so every
                 round a table did not settle on the spot was voided. -->
            <button class="sec-btn hidden" id="till-add-to-tab-btn" style="width:100%;margin-bottom:8px;">Add to Tab</button>
            <button class="checkout-btn" id="till-pay-now-btn" disabled>Print Receipt &amp; Pay</button>
            <p id="till-tab-due-note" class="hidden" style="margin-top:8px;text-align:center;font-size:11px;color:var(--text-secondary);"></p>
          </div>
        </div>
      </div>

      <!-- Payment & Checkout Modal Overlay -->
      <div id="payment-modal" class="modal">
        <div class="modal-content" style="max-width: 700px;">
          <h2>Process Checkout</h2>
          <p>Choose settlement method and finalize invoice</p>

          <div class="checkout-modal-grid">
            <!-- Methods Column -->
            <div class="checkout-payment-methods" role="tablist" aria-label="Payment method">
              <div class="payment-method-card selected" data-method="CASH">
                <span style="font-size:20px;">💵</span>
                <div>
                  <h4>Cash Payment</h4>
                  <p>Accept physical currency and compute change</p>
                </div>
              </div>
              <div class="payment-method-card" data-method="MPESA" id="payment-method-mpesa">
                <span style="font-size:20px;">📱</span>
                <div>
                  <h4>M-Pesa STK Push</h4>
                  <p id="payment-method-mpesa-note">Checking M-Pesa availability...</p>
                </div>
              </div>
              <div class="payment-method-card" data-method="MPESA_CODE">
                <span style="font-size:20px;">🧾</span>
                <div>
                  <h4>M-Pesa Code</h4>
                  <p>Customer already paid — enter the SMS code</p>
                </div>
              </div>
              <div class="payment-method-card" data-method="CARD">
                <span style="font-size:20px;">💳</span>
                <div>
                  <h4>Card</h4>
                  <p>Taken on the card terminal</p>
                </div>
              </div>
              <div class="payment-method-card" data-method="CREDIT">
                <span style="font-size:20px;">💳</span>
                <div>
                  <h4>On Account (Credit)</h4>
                  <p>Charge against debtor limits</p>
                </div>
              </div>
              <div class="payment-method-card" data-method="PROFORMA">
                <span style="font-size:20px;">🧾</span>
                <div>
                  <h4>Proforma - Print First, Pay Later</h4>
                  <p>Process and print the order now, collect payment afterwards</p>
                </div>
              </div>
            </div>

            <!-- Input Column -->
            <div class="payment-inputs-col">
              <div class="payment-detail-box">
                <h3>Grand Total Due</h3>
                <p id="checkout-due-amount">KES 0.00</p>
              </div>

              <!-- Table Number -->
              <div class="checkout-inputs" style="margin-bottom: 12px; border-bottom: 1px solid var(--border-color); padding-bottom: 12px; display: block !important;">
                <label style="font-size:13px;color:var(--text-secondary)">Table Number (Optional)</label>
                <input type="text" id="checkout-table-number" placeholder="e.g. 12 or Patio 3" style="width: 100%;">
              </div>

              <!-- Loyalty Points & Rewards -->
              <div class="checkout-inputs" id="loyalty-redeem-section" style="margin-bottom: 12px; border-bottom: 1px solid var(--border-color); padding-bottom: 12px; display: block !important;">
                <div style="display: flex; justify-content: space-between; align-items: center;">
                  <div>
                    <label style="font-size:11px;color:var(--text-secondary);display:block;">Available Loyalty Points</label>
                    <span id="checkout-loyalty-pts" style="font-size:13px;font-weight:700;color:var(--accent-amber);">0 pts</span>
                  </div>
                  <button type="button" id="btn-redeem-loyalty" class="sec-btn" style="padding: 4px 8px; font-size: 11px;">Redeem Points</button>
                </div>
                <div id="loyalty-redeem-status" style="font-size:11px;color:var(--accent-green);margin-top:4px;display:none;"></div>
              </div>

              <!-- Cash Input fields -->
              <div class="checkout-inputs" id="payment-inputs-cash">
                <label style="font-size:13px;color:var(--text-secondary)">Tendered Cash Amount</label>
                <input type="number" id="pay-cash-tendered" placeholder="Enter amount received..." inputmode="decimal">
                <div class="quick-cash-grid" id="quick-cash-grid" style="display:grid;grid-template-columns:repeat(5,1fr);gap:6px;margin-top:8px;">
                  <button type="button" class="sec-btn quick-cash-btn" data-cash="exact" style="padding:8px 4px;font-size:12px;font-weight:700;min-height:40px;">Exact</button>
                  <button type="button" class="sec-btn quick-cash-btn" data-cash="500" style="padding:8px 4px;font-size:12px;font-weight:700;min-height:40px;">500</button>
                  <button type="button" class="sec-btn quick-cash-btn" data-cash="1000" style="padding:8px 4px;font-size:12px;font-weight:700;min-height:40px;">1,000</button>
                  <button type="button" class="sec-btn quick-cash-btn" data-cash="2000" style="padding:8px 4px;font-size:12px;font-weight:700;min-height:40px;">2,000</button>
                  <button type="button" class="sec-btn quick-cash-btn" data-cash="5000" style="padding:8px 4px;font-size:12px;font-weight:700;min-height:40px;">5,000</button>
                </div>
                <div class="summary-row" style="margin-top:10px;">
                  <span>Change Due:</span>
                  <span id="pay-cash-change" style="font-weight:700;color:var(--accent-green);font-size:15px;">KES 0.00</span>
                </div>
              </div>

              <!-- M-Pesa Input fields -->
              <div class="checkout-inputs hidden" id="payment-inputs-mpesa">
                <label style="font-size:13px;color:var(--text-secondary)">M-Pesa Mobile Number</label>
                <input type="text" id="pay-mpesa-phone" placeholder="e.g. 0712345678" autocomplete="off" autocorrect="off" spellcheck="false">
                <button class="primary-btn" id="pay-trigger-stk" style="margin-top:4px;">Initiate STK Push</button>
                <div id="stk-status-area" class="hidden" style="margin-top:8px;text-align:center;font-size:12px;">
                  <span class="badge warning" id="stk-status-badge">Awaiting User PIN...</span>
                </div>
              </div>

              <!-- This is independent of STK availability: the customer has
                   already paid and the cashier is recording the SMS proof. -->
              <div class="checkout-inputs hidden" id="payment-inputs-mpesa-code">
                <label for="pay-mpesa-code" style="font-size:13px;color:var(--text-secondary)">M-Pesa Confirmation Code</label>
                <input type="text" id="pay-mpesa-code" class="receipt-code-input" maxlength="10" placeholder="e.g. QGH4T21XZ9" autocomplete="off" autocorrect="off" autocapitalize="characters" spellcheck="false">
                <label for="pay-mpesa-amount">Amount on receipt (KES)</label>
                <input type="text" id="pay-mpesa-amount" inputmode="decimal" autocomplete="off" placeholder="Enter receipt amount">
                <p style="font-size:13px;color:var(--text-secondary);margin-top:8px;line-height:1.5;">
                  Enter the code and amount from the payment message.
                </p>
              </div>

              <!-- Card fields. The terminal charges the card; recording the
                   reference it prints is the only thread back to that slip. -->
              <div class="checkout-inputs hidden" id="payment-inputs-card">
                <label style="font-size:13px;color:var(--text-secondary)">Card Reference Number</label>
                <input type="text" id="pay-card-reference" maxlength="60" placeholder="Reference from the card slip...">
                <p style="font-size:13px;color:var(--text-secondary);margin-top:8px;line-height:1.5;">
                  There is no card integration: the terminal takes the money and this records that it did.
                </p>
              </div>

              <!-- Credit Limit check fields -->
              <div class="checkout-inputs hidden" id="payment-inputs-credit">
                <div class="summary-row">
                  <span>Customer Debt Limit:</span>
                  <span id="pay-credit-limit">KES 0.00</span>
                </div>
                <div class="summary-row" style="margin-top:4px;">
                  <span>Current Outstanding Balance:</span>
                  <span id="pay-credit-balance">KES 0.00</span>
                </div>
                <p id="credit-warn-text" class="error-msg"></p>
              </div>

              <!-- Proforma: the order is processed and printed now and the
                   money arrives later, so the sale is booked against a named
                   debtor and the ledger carries it as unpaid until it is. -->
              <div class="checkout-inputs hidden" id="payment-inputs-proforma">
                <label style="font-size:13px;color:var(--text-secondary)">Order / LPO Reference (Optional)</label>
                <input type="text" id="pay-proforma-reference" maxlength="60" placeholder="Their purchase order or job number...">
                <p style="font-size:13px;color:var(--text-secondary);margin-top:8px;line-height:1.5;">
                  Prints a proforma invoice marked UNPAID and releases the order. The amount stays on this customer's account until it is settled.
                </p>
                <p id="proforma-warn-text" class="error-msg"></p>
              </div>

              <div style="display:flex;gap:10px;margin-top:auto;">
                <button class="cancel-pay-btn" style="flex:1;" id="pay-cancel-btn">Leave pending</button>
                <button class="confirm-pay-btn" style="flex:1.5;" id="pay-confirm-btn">Complete Sale</button>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- Tab review. Items are corrected here rather than in the cart,
           because by now they are rounds already rung up and stock already
           taken; removing one has to put that stock back. -->
      <div id="tab-review-modal" class="modal">
        <div class="modal-content" style="max-width: 520px;">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">
            <h2 style="font-size:16px;" id="tab-review-title">Tab</h2>
            <span id="tab-review-order-no" class="cart-count"></span>
          </div>
          <p style="font-size:12px;color:var(--text-secondary);margin-bottom:12px;">
            Everything billed to this table. Removing an item puts its stock back and re-rings the round it came from.
          </p>
          <div id="tab-review-list" style="max-height:320px;overflow-y:auto;display:flex;flex-direction:column;gap:8px;"></div>
          <div class="receipt-totals-row" style="margin-top:12px;font-size:15px;">
            <span>Tab total</span><span id="tab-review-total">KES 0.00</span>
          </div>
          <div style="display:flex;gap:10px;margin-top:16px;">
            <button class="sec-btn" style="flex:1;" id="tab-review-close">Close</button>
          </div>
        </div>
      </div>

      <!-- Stacking a round does not print it. Pushed here, the bill waits in
           the Print Station queue, where anyone at the counter machine finds
           it by order number or table and prints it. -->
      <div id="tab-queue-modal" class="modal">
        <div class="modal-content" style="max-width:360px;">
          <h2 style="font-size:16px;">Send to print queue?</h2>
          <p id="tab-queue-summary" style="font-size:13px;color:var(--text-secondary);line-height:1.5;"></p>
          <div style="display:flex;gap:10px;margin-top:12px;">
            <button class="sec-btn" style="flex:1;" id="tab-queue-skip">Not now</button>
            <button class="primary-btn" style="flex:1.5;" id="tab-queue-send">Push to print queue</button>
          </div>
        </div>
      </div>

      <!-- ESC/POS Thermal Receipt Paper Simulation Modal -->
      <div id="receipt-modal" class="modal">
        <div class="modal-content" style="max-width: 420px; background: #222; padding: 20px;">
          <h2 style="font-size:16px; margin-bottom: 12px; color: #fff;">Order Registered · Receipt Preview</h2>
          
          <div style="display:flex; gap: 8px; margin-bottom: 12px; width:100%;">
            <button class="primary-btn active" id="receipt-format-58" style="flex:1;">58mm Roll</button>
            <button class="sec-btn" id="receipt-format-80" style="flex:1;">80mm Roll</button>
          </div>

          <div id="receipt-paper-view" class="receipt-paper-58"></div>

          <div id="receipt-etr-row" style="display:none; gap: 8px; width: 100%; margin-top: 12px;">
            <input type="text" id="receipt-etr-pin" placeholder="Buyer KRA PIN (optional)" maxlength="11" autocomplete="off" style="flex:1; text-transform: uppercase;" aria-label="Buyer KRA PIN">
            <button class="sec-btn" id="receipt-etr-btn">Generate ETR</button>
          </div>

          <div style="display:flex; gap: 10px; width: 100%; margin-top: 16px;">
            <button class="primary-btn" style="flex:1.5;" id="receipt-print-btn">🖨️ Print Receipt &amp; Complete</button>
            <button class="sec-btn" style="flex:1;" id="receipt-close-btn">Close</button>
          </div>
        </div>
      </div>
    `;

    this.bindEvents();
    this.filterSheet = createMobileFilters({
      container: this.container, toolbar: this.container.querySelector('.search-input-wrapper'),
      controls: [this.container.querySelector('#cat-filters')], title: 'Product categories',
      count: () => Number(Boolean(this.container.querySelector('#cat-filters .active:not([data-cat="all"])'))),
      reset: () => this.container.querySelector('#cat-filters [data-cat="all"]')?.click(),
    });
  }

  bindEvents() {
    const cartToggle = this.container.querySelector('#till-cart-toggle');
    cartToggle.addEventListener('click', () => {
      const expanded = cartToggle.getAttribute('aria-expanded') !== 'true';
      this.container.querySelector('.till-grid').dataset.mobilePanel = expanded ? 'sale' : 'products';
      cartToggle.setAttribute('aria-expanded', String(expanded));
      this.container.querySelector('#mobile-cart-action').textContent = expanded ? 'Hide cart' : 'View cart';
      this.container.querySelector('#till-mobile-title').textContent = expanded ? 'Current sale' : 'Products';
      if (window.matchMedia('(max-width: 767px)').matches) this.container.closest('.app-main-content')?.scrollTo({ top: 0 });
    });
    // Search filter typing + barcode / exact-match instant add on Enter
    const searchInput = document.getElementById('till-search');
    searchInput.addEventListener('input', () => {
      // Coalesce typing and barcode-scanner bursts before rebuilding the page.
      clearTimeout(this.searchTimer);
      this.searchTimer = setTimeout(() => {
        if (!this.disposed) this.filterCatalogue();
      }, 80);
    });
    searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && this.filteredProducts.length > 0) {
        e.preventDefault();
        const q = searchInput.value.trim().toLowerCase();
        const exact = this.filteredProducts.find(
          (p) => String(p.sku || '').toLowerCase() === q
            || String(this.barcodeByProduct?.get(String(p.id)) || '').toLowerCase() === q
            || String(p.name || '').toLowerCase() === q
        ) || (this.filteredProducts.length === 1 ? this.filteredProducts[0] : null);
        if (exact) {
          this.addToCart(exact);
          searchInput.value = '';
          this.filterCatalogue();
        }
      }
    });

    // Category chips are populated after this binding, so delegate from their stable container.
    const categoryFilters = document.getElementById('cat-filters');
    categoryFilters.addEventListener('click', (e) => {
      const chip = e.target.closest('.filter-chip');
      if (!chip || !categoryFilters.contains(chip)) return;

      categoryFilters.querySelectorAll('.filter-chip').forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      this.filterCatalogue();
    });

    // Customer attach dropdown selection
    const custSelect = document.getElementById('cart-customer-select');
    custSelect.addEventListener('change', async (e) => {
      this.invalidateMpesaAttempt();
      const custId = e.target.value;
      this.selectedCustomer = await db.customers.get(custId);
      
      // Update UI prices based on customer price tier
      document.getElementById('price-tier-indicator').innerText = 
        this.selectedCustomer.price_tier === 'WHOLESALE' ? 'Wholesale Pricing' : 'Retail Pricing';
      
      document.getElementById('cart-buyer-pin').value = this.selectedCustomer.kra_pin || '';
      
      this.recomputeTotals();
      this.persistDraft();
    });

    this.bindNewCustomer();

    document.getElementById('till-review-tab-btn').addEventListener('click', () => {
      void this.openTabReview().catch((error) => {
        showNotification(error.message || 'That tab could not be opened.', 'error');
      });
    });

    document.getElementById('tab-review-close').addEventListener('click', () => {
      document.getElementById('tab-review-modal').classList.remove('active');
    });

    document.getElementById('till-add-to-tab-btn').addEventListener('click', () => {
      void this.addRoundToTab()
        .then((added) => added && this.offerTabPrint())
        .catch((error) => {
          showNotification(error.message || 'That round could not be added to the tab.', 'error');
        });
    });

    // Adding a round only asks. The paper comes out wherever the queue is
    // opened, by whoever is signed in there.
    document.getElementById('tab-queue-skip').addEventListener('click', () => {
      document.getElementById('tab-queue-modal').classList.remove('active');
    });
    document.getElementById('tab-queue-send').addEventListener('click', () => {
      document.getElementById('tab-queue-modal').classList.remove('active');
      void this.sendReceiptToCounter().catch((error) => {
        showNotification(error.message || 'The bill could not be queued. Print it from the counter instead.', 'error');
      });
    });

    // Typing a table here is what opens the first tab of the night; the open
    // tab buttons below are only a shortcut back to one that already exists.
    document.getElementById('till-table-input').addEventListener('input', (event) => {
      this.activeTable = event.target.value.trim() || null;
      // Picking a suggested table is how an existing tab is chosen now.
      this.activeTabId = (this.openTabs || []).find((tab) => tabKey(tab.table) === tabKey(this.activeTable))?.id || null;
      this.persistDraft();
      this.renderOpenTabs();
    });

    // Leaves the tab alone and starts a sale of its own.
    document.getElementById('till-tab-clear').addEventListener('click', () => {
      this.clearActiveTab();
      showNotification('Next sale is takeaway — its own order, not a round on a tab.', 'info');
    });

    // Pay now triggers checkout modal
    document.getElementById('till-pay-now-btn').addEventListener('click', () => {
      if (!canSell(state.currentUser?.role)) { showNotification(SELLING_OFF, 'error'); return; }
      // On a tab, paying means paying the table, not just what is on screen.
      if (this.activeTable) {
        void this.openTabCheckout().catch((error) => {
          showNotification(error.message || 'That tab could not be opened for payment.', 'error');
        });
        return;
      }
      void this.startPrintedCheckout();
    });

    // Payment method switcher
    this.container.querySelectorAll('#payment-modal .payment-method-card').forEach(card => {
      card.setAttribute('role', 'tab');
      card.setAttribute('tabindex', '0');
      card.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); card.click(); }
      });
      card.addEventListener('click', (e) => {
        const methodCard = e.target.closest('.payment-method-card');
        const method = methodCard.getAttribute('data-method');
        // Switching tender throws away the provider's proof, and the customer
        // has already paid on it.
        if (method !== this.selectedPaymentMethod
          && !this.confirmDiscardingPaidMpesa(`Switching to ${method}`)) return;

        document.querySelectorAll('.payment-method-card').forEach(c => c.classList.remove('selected'));
        methodCard.classList.add('selected');

        this.selectPaymentMethod(method);
      });
    });

    // Cash tendered math + Quick Cash denomination taps
    document.getElementById('pay-cash-tendered').addEventListener('input', (e) => {
      this.updateCashChange(parseFloat(e.target.value) || 0);
    });
    document.getElementById('quick-cash-grid')?.addEventListener('click', (e) => {
      const btn = e.target.closest('.quick-cash-btn');
      if (!btn) return;
      const val = btn.getAttribute('data-cash');
      const amount = val === 'exact' ? Math.ceil(this.totals?.total || 0) : Number(val);
      const input = document.getElementById('pay-cash-tendered');
      if (input) input.value = amount;
      this.updateCashChange(amount);
    });

    // Provider proof belongs to the exact phone and split amounts that were
    // initiated. Typing after a push therefore starts a new attempt.
    document.getElementById('pay-mpesa-phone').addEventListener('input', () => {
      this.invalidateMpesaAttempt();
    });

    // STK Push Trigger
    document.getElementById('pay-trigger-stk').addEventListener('click', () => {
      this.triggerMpesaStk();
    });

    // Cancel / Close buttons
    document.getElementById('pay-cancel-btn').addEventListener('click', async () => {
      if (this.pendingRegistration) await this.pendingRegistration;
      if (this.mpesaAttempt && !this.mpesaVerified) {
        showNotification('Wait for the M-Pesa attempt to resolve before leaving this payment.', 'warning');
        return;
      }
      if (!this.confirmDiscardingPaidMpesa('Leave pending')) return;
      this.invalidateMpesaAttempt();
      document.getElementById('payment-modal').classList.remove('active');

      // On a tab the round is not a mistake, it is the nine o'clock beer. It
      // stays owed and the cart clears, because voiding it here is what
      // cancelled every round a table did not pay for on the spot.
      if (this.activeTabId) {
        this.pendingSale = null;
        this.releaseHeldLease();
        this.cart = [];
        this.redeemedPoints = 0;
        this.updateCartUI();
        void this.loadOpenTabs().catch(() => {});
        showNotification(`Left on Table ${this.activeTable}'s tab. Settle it when they leave.`, 'info');
        return;
      }

      if (this.pendingSale) {
        this.pendingSale = null;
        this.pendingRegistration = null;
        this.cartDraftId = null;
        this.releaseHeldLease();
        this.clearCart();
        showNotification('Order left unpaid in Pending. Use Pay now in Orders to clear it.', 'info');
      }

    });

    document.getElementById('pay-confirm-btn').addEventListener('click', () => {
      void this.finalizeInvoice().catch((error) => {
        showNotification(error.message || 'The order could not be registered. Please retry.', 'error');
      });
    });

    document.getElementById('receipt-close-btn').addEventListener('click', () => {
      document.getElementById('receipt-modal').classList.remove('active');
      this.clearCart();
    });

    // A tablet cannot reach the counter's USB printer, so the receipt is queued
    // for the print station rather than sent to this device's own printer.
    document.getElementById('receipt-print-btn').addEventListener('click', () => {
      void this.sendReceiptToCounter();
    });

    document.getElementById('receipt-etr-btn').addEventListener('click', () => {
      void this.generateReceiptEtr();
    });

    // Format switches
    document.getElementById('receipt-format-58').addEventListener('click', (e) => {
      document.getElementById('receipt-format-80').classList.remove('active');
      e.target.classList.add('active');
      document.getElementById('receipt-paper-view').className = 'receipt-paper-58';
    });
    
    document.getElementById('receipt-format-80').addEventListener('click', (e) => {
      document.getElementById('receipt-format-58').classList.remove('active');
      e.target.classList.add('active');
      document.getElementById('receipt-paper-view').className = 'receipt-paper-80';
    });

    // Park Cart & Resume Carts
    document.getElementById('till-park-btn').addEventListener('click', () => {
      this.parkCurrentCart();
    });

    document.getElementById('till-resume-btn').addEventListener('click', () => {
      this.resumeParkedCart();
    });
  }

  async loadProducts() {
    const [products, stockRows, barcodes, categories] = await Promise.all([
      db.products.where('is_active').equals(1).toArray(),
      firebaseConfigured ? db.stock_balances.where('branchId').equals(state.currentBranch?.id || '').toArray() : db.stock_movements.toArray(),
      db.barcodes.toArray(),
      db.categories.toArray()
    ]);
    if (!this.container.isConnected) return;
    this.renderCategoryFilters(products, categories);

    const branchId = state.currentBranch?.id;
    const houseStockByProduct = new Map();
    for (const movement of stockRows) {
      if (movement.location !== 'HOUSE') continue;
      if (branchId && movement.branch_id && String(movement.branch_id) !== String(branchId)) continue;

      const productId = String(firebaseConfigured ? movement.productId : movement.product_id);
      const quantity = (Number(movement.qty) || 0) - (firebaseConfigured ? Number(movement.reservedQty || 0) : 0);
      houseStockByProduct.set(productId, (houseStockByProduct.get(productId) || 0) + quantity);
    }

    const barcodeByProduct = new Map();
    for (const barcode of barcodes) {
      const productId = String(barcode.product_id);
      if (!barcodeByProduct.has(productId)) {
        barcodeByProduct.set(productId, String(barcode.barcode ?? ''));
      }
    }

    const categoryMap = new Map(categories.map(c => [String(c.id), c.name]));
    this.houseStockByProduct = houseStockByProduct;
    this.barcodeByProduct = barcodeByProduct;
    this.categoryMap = categoryMap;
    this.catalogueProducts = products.map((product) => ({
      ...product,
      searchText: `${product.name || ''} ${product.sku || ''} ${barcodeByProduct.get(String(product.id)) || ''}`.toLowerCase(),
      canonicalCategory: getCanonicalCategoryName(categoryMap.get(String(product.category_id)) || String(product.source_category || product.category_id || '')),
    }));
    this.filterCatalogue();
  }

  renderProductPage() {
    const grid = document.getElementById('till-prod-grid');
    if (!grid) return;
    const page = paginate(this.filteredProducts, this.productPage, 48);
    this.productPage = page.page;
    // Successive prefixes often match the same first page. Keep its DOM and
    // decoded images instead of rebuilding 48 cards for each letter.
    const unchanged = this.renderedProductGrid === grid
      && this.renderedProducts?.length === page.rows.length
      && page.rows.every((product, index) => product === this.renderedProducts[index]);
    if (unchanged) {
      this.renderProductPager(page);
      return;
    }
    const { houseStockByProduct, barcodeByProduct, categoryMap } = this;
    const fragment = document.createDocumentFragment();

    for (const prod of page.rows) {
      const productId = String(prod.id);
      const name = String(prod.name ?? 'Unnamed product');
      const sku = String(prod.sku ?? '');
      const numericPrice = Number(prod.sell_price);
      const sellPrice = Number.isFinite(numericPrice) ? numericPrice : 0;
      const imageData = typeof prod.image_data === 'string' ? prod.image_data : '';
      const stock = houseStockByProduct.get(productId) || 0;
      const normalizedProduct = { ...prod, name, sku, sell_price: sellPrice };
      
      const rawCatName = categoryMap.get(String(prod.category_id)) || String(prod.source_category || prod.category_id || '');
      const canonicalCatName = getCanonicalCategoryName(rawCatName);

      const card = document.createElement('div');
      card.className = `product-card ${prod.is_batch_tracked ? 'batch-tracked' : ''}`;
      card.setAttribute('data-id', prod.id);
      card.setAttribute('role', 'button');
      card.tabIndex = 0;
      card.setAttribute('aria-label', `${name}, KES ${sellPrice.toFixed(2)}`);
      card.setAttribute('data-cat', String(prod.category_id ?? ''));
      card.setAttribute('data-canonical-cat', canonicalCatName);
      card.setAttribute('data-name', name.toLowerCase());
      card.setAttribute('data-sku', sku.toLowerCase());

      const barcodeVal = barcodeByProduct.get(productId) || '';
      card.setAttribute('data-barcode', barcodeVal);

      const isVipItem = prod.id === 'prod-table-service';
      const isStaffDiscountItem = prod.id === 'prod-staff-discount';
      card.innerHTML = `
        <div class="card-media" style="height: 120px; flex-shrink: 0; border-radius: 8px; margin-bottom: 8px; background: url('${imageData ? (imageData.includes('?') ? imageData : imageData + '?v=2') : '/ai_images/juice_glass.jpg'}') center/cover no-repeat; border: 1px solid rgba(255, 255, 255, 0.05); display: flex; align-items: center; justify-content: center;">
          ${!imageData ? '<span style="font-size:24px; opacity:0.3;">📷</span>' : ''}
        </div>
        <div>
          <h4>${name}</h4>
          <p class="sku">${sku}</p>
        </div>
        
        <div class="card-summary-tabs">
          <div class="c-tab active">Info</div>
          <div class="c-tab">Stock</div>
          <div class="c-tab">Stats</div>
        </div>
        <div class="card-tab-content">
          <div><strong style="color:#fff">Tax:</strong> ${prod.tax_code} | <strong style="color:#fff">UOM:</strong> ${prod.uom}</div>
          <div style="margin-top:4px"><strong style="color:#fff">Origin:</strong> ${prod.origin_country || 'N/A'}</div>
        </div>

        <div class="card-footer">
          <span class="price">${isStaffDiscountItem ? 'Staff -20%' : (isVipItem ? 'VIP +30%' : 'KES ' + sellPrice.toFixed(2))}</span>
          <span class="stock ${stock <= 10 && !prod.is_service ? 'low' : ''}">
            ${prod.is_service ? 'Service' : stock + ' left'}
          </span>
        </div>
      `;

      // Only the current page gets image elements; off-screen images load on demand.
      const media = card.querySelector('.card-media');
      media.style.background = 'rgba(255,255,255,0.03)';
      if (imageData) {
        const image = document.createElement('img');
        image.src = imageData;
        image.alt = '';
        image.loading = 'lazy';
        image.decoding = 'async';
        image.style.cssText = 'width:100%;height:100%;object-fit:cover;border-radius:8px';
        media.replaceChildren(image);
      }
      card.addEventListener('click', () => {
        this.addToCart(normalizedProduct);
      });
      card.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        if (!event.repeat) this.addToCart(normalizedProduct);
      });
      fragment.appendChild(card);
    }

    grid.replaceChildren(fragment);
    grid.scrollTop = 0;
    if (!page.total) grid.textContent = 'No products match your search.';
    this.renderedProductGrid = grid;
    this.renderedProducts = page.rows;
    this.renderProductPager(page);
  }

  renderProductPager(page) {
    const pager = document.getElementById('till-product-pager');
    if (pager) {
      pager.innerHTML = pagerHtml('till-page-controls', page);
      bindPager('till-page-controls', page, (next) => {
        this.productPage = next;
        this.renderProductPage();
      });
    }
  }

  renderCategoryFilters(products, categories) {
    const categoryFilters = document.getElementById('cat-filters');
    if (!categoryFilters) return;

    const usedCategoryIds = new Set(
      products
        .map(product => product.category_id)
        .filter(categoryId => categoryId !== null && categoryId !== undefined && categoryId !== '')
        .map(String)
    );

    const usedCategories = categories.filter(category => usedCategoryIds.has(String(category.id)));

    // Group category IDs by canonical category display name
    const groupedByName = new Map();
    for (const cat of usedCategories) {
      const canonicalName = getCanonicalCategoryName(cat.name ?? cat.id);
      if (!groupedByName.has(canonicalName)) {
        groupedByName.set(canonicalName, new Set());
      }
      groupedByName.get(canonicalName).add(String(cat.id));
    }

    // Also collect category IDs from products whose category_id wasn't in categories table
    const categoryMap = new Map(categories.map(c => [String(c.id), c.name]));
    for (const prod of products) {
      if (prod.category_id) {
        const rawName = categoryMap.get(String(prod.category_id)) || String(prod.category_id);
        const canonicalName = getCanonicalCategoryName(rawName);
        if (!groupedByName.has(canonicalName)) {
          groupedByName.set(canonicalName, new Set());
        }
        groupedByName.get(canonicalName).add(String(prod.category_id));
      }
    }

    const canonicalCategories = Array.from(groupedByName.entries())
      .sort((a, b) => a[0].localeCompare(b[0]));

    const fragment = document.createDocumentFragment();
    const allItemsChip = document.createElement('button');
    allItemsChip.type = 'button';
    allItemsChip.className = 'filter-chip active';
    allItemsChip.dataset.cat = 'all';
    allItemsChip.textContent = 'All Items';
    fragment.appendChild(allItemsChip);

    for (const [name, idsSet] of canonicalCategories) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'filter-chip';
      chip.dataset.catIds = Array.from(idsSet).join(',');
      chip.dataset.catName = name;
      chip.textContent = name;
      fragment.appendChild(chip);
    }

    categoryFilters.replaceChildren(fragment);
  }

  async loadCustomerDropdown(selectedId = WALK_IN_CUSTOMER_ID, { refresh = true } = {}) {
    // The directory is the server's; refresh it so a customer registered on
    // the office machine is attachable here without reloading the app.
    try {
      if (refresh) {
        await pullCustomers();
      }
    } catch {
      // Offline is normal at a till: fall back to what this device has.
    }

    const list = (await db.customers.toArray())
      .sort((a, b) => (a.id === WALK_IN_CUSTOMER_ID ? -1 : b.id === WALK_IN_CUSTOMER_ID ? 1 : compareNames(a.name, b.name)));
    const select = document.getElementById('cart-customer-select');
    if (this.disposed || !select || !this.container.contains(select)) return;
    // A background refresh must not undo the customer's selection while it waited.
    const wanted = refresh ? this.selectedCustomer?.id || selectedId : selectedId;
    const fragment = document.createDocumentFragment();

    list.forEach(cust => {
      const opt = document.createElement('option');
      opt.value = cust.id;
      opt.innerText = cust.name + (cust.phone ? ` (${cust.phone})` : '');
      if (cust.id === wanted) opt.selected = true;
      fragment.appendChild(opt);
    });
    select.replaceChildren(fragment);
  }

  /**
   * Registers a customer without leaving the sale.
   *
   * Attaching one is the moment you discover they are not on file - most of
   * all on a proforma, which is refused without a real customer to bill - and
   * sending the cashier to another screen loses the cart they were building.
   */
  bindNewCustomer() {
    const form = document.getElementById('cart-new-customer-form');
    const toggle = document.getElementById('cart-new-customer-btn');
    // Adding a customer is the owner's and supervisor's, so on every other
    // till there is no button to bind.
    if (!toggle) return;
    const name = document.getElementById('cart-new-customer-name');
    const message = document.getElementById('cart-new-customer-msg');
    const say = (text, colour) => {
      message.innerText = text;
      message.style.color = colour;
    };

    const close = () => {
      form.classList.add('hidden');
      say('', 'var(--text-secondary)');
      for (const id of ['name', 'phone', 'kra']) {
        document.getElementById(`cart-new-customer-${id}`).value = '';
      }
    };

    toggle.addEventListener('click', () => {
      form.classList.toggle('hidden');
      if (!form.classList.contains('hidden')) name.focus();
    });
    document.getElementById('cart-new-customer-cancel').addEventListener('click', close);

    document.getElementById('cart-new-customer-save').addEventListener('click', async (event) => {
      const button = event.currentTarget;
      const typedName = name.value.trim();
      if (!typedName) {
        say('Give the customer a name.', 'var(--accent-rose)');
        return;
      }

      button.disabled = true;
      say('Registering…', 'var(--text-secondary)');
      try {
        const saved = await saveCustomer({
          name: typedName,
          phone: document.getElementById('cart-new-customer-phone').value.trim(),
          kraPin: document.getElementById('cart-new-customer-kra').value.trim()
        });

        await this.loadCustomerDropdown(saved.id);
        this.selectedCustomer = saved;
        document.getElementById('cart-buyer-pin').value = saved.kra_pin || '';
        document.getElementById('price-tier-indicator').innerText =
          saved.price_tier === 'WHOLESALE' ? 'Wholesale Pricing' : 'Retail Pricing';
        this.recomputeTotals();
        close();
        showNotification(`${saved.name} is attached to this sale.`, 'success');
      } catch (error) {
        // A customer the server never accepted is a sale that will not sync,
        // so this fails loudly rather than attaching a local-only name.
        say(error.message || 'That customer could not be registered.', 'var(--accent-rose)');
      } finally {
        button.disabled = false;
      }
    });
  }

  filterCatalogue() {
    const query = document.getElementById('till-search').value.toLowerCase();
    const activeChip = document.querySelector('#cat-filters .filter-chip.active');
    const activeCat = activeChip?.getAttribute('data-cat') || activeChip?.dataset.catName || 'all';
    const activeCatName = activeChip?.dataset.catName || null;
    const activeCatIds = activeChip?.getAttribute('data-cat-ids') ? activeChip.getAttribute('data-cat-ids').split(',') : null;
    // Search plain data across the full catalogue; render just one small page.
    this.filteredProducts = this.catalogueProducts.filter((product) => {
      const matchesQuery = !query || product.searchText.includes(query);
      const cat = String(product.category_id ?? '');
      const matchesCat = activeCat === 'all'
        || (activeCatName && product.canonicalCategory === activeCatName)
        || (activeCatIds ? activeCatIds.includes(cat) : cat === activeCat);
      return matchesQuery && matchesCat;
    });
    this.productPage = 1;
    this.renderProductPage();
  }

  async addToCart(product) {
    // If batch tracked, resolve first expiry batch (FEFO Suggestion)
    let selectedBatch = null;
    if (product.is_batch_tracked) {
      // Find batches for product ordered by expiry date (First Expiry First Out)
      const batches = await db.batches
        .where('product_id')
        .equals(product.id)
        .toArray();
      
      // Sort FEFO
      batches.sort((a,b) => new Date(a.expiry_date) - new Date(b.expiry_date));
      selectedBatch = batches.find(b => new Date(b.expiry_date) > new Date()); // Non expired
      
      if (!selectedBatch) {
        showNotification('Product is expired or no active batch in stock.', 'error');
        return;
      }
    }

    const existingIndex = this.cart.findIndex(item => 
      item.product.id === product.id && 
      (!selectedBatch || item.batch?.id === selectedBatch.id)
    );

    // Any change to the cart invalidates a confirmed M-Pesa amount, including
    // the toggles below - the surcharge changes what is owed.
    this.invalidateMpesaAttempt();

    // VIP Service Charge: toggle on/off, always qty 1
    if (product.id === 'prod-table-service') {
      if (existingIndex > -1) {
        this.cart.splice(existingIndex, 1);
        showNotification('VIP Surcharge removed', 'warning');
        this.updateCartUI();
        return;
      }
      this.cart.unshift({
        product,
        qty: 1,
        discount_amount: 0,
        discount_percent: 0,
        batch: null
      });
      showNotification('VIP +30% Surcharge applied', 'success');
      this.updateCartUI();
      return;
    }

    // Staff 20% Discount: toggle on/off, always qty 1 (requires Supervisor/Owner or PIN override)
    if (product.id === 'prod-staff-discount') {
      if (existingIndex > -1) {
        this.cart.splice(existingIndex, 1);
        showNotification('Staff 20% Discount removed', 'warning');
        this.updateCartUI();
        return;
      }
      if (!['Owner', 'Supervisor'].includes(state.currentUser?.role)) {
        const pin = window.prompt('Supervisor Override Required — Enter Supervisor (9999) or Owner (0000) PIN to authorize Staff 20% Discount:');
        if (pin === null) return;
        if (!['9999', '0000'].includes(pin.trim())) {
          showNotification('Invalid Supervisor PIN. Staff discount not applied.', 'error');
          return;
        }
      }
      this.cart.unshift({
        product,
        qty: 1,
        discount_amount: 0,
        discount_percent: 20,
        batch: null
      });
      showNotification('Staff 20% Discount authorized & applied', 'success');
      this.updateCartUI();
      return;
    }

    if (existingIndex > -1) {
      this.cart[existingIndex].qty += 1;
    } else {
      this.cart.push({
        product,
        qty: 1,
        discount_amount: 0,
        discount_percent: 0,
        batch: selectedBatch
      });
    }

    // The cart and its live item count confirm the tap. A toast per item used
    // to pile animated overlays on top of the checkout during rapid selling.
    this.updateCartUI();
  }

  updateCartUI() {
    this.persistDraft();
    const count = this.cart.reduce((sum, item) => sum + Number(item.qty || 0), 0);
    const cartCount = document.getElementById('cart-item-count');
    if (cartCount) cartCount.textContent = `${count} ${count === 1 ? 'Item' : 'Items'}`;
    const mobileSummary = document.getElementById('mobile-sale-summary');
    if (mobileSummary) {
      mobileSummary.textContent = `${count} ${count === 1 ? 'item' : 'items'}`;
    }
    const list = document.getElementById('cart-list');
    const payBtn = document.getElementById('till-pay-now-btn');
    
    if (this.cart.length === 0) {
      list.innerHTML = `
        <div class="cart-empty">
          <span class="cart-empty-icon">🛒</span>
          <span>Cart is empty</span>
        </div>
      `;
      payBtn.disabled = true;
      this.recomputeTotals();
      return;
    }

    payBtn.disabled = false;
    // The item objects remain stable when quantities change. Retain every
    // unchanged row, including its image and controls, across cart updates.
    this.cartRows ||= new WeakMap();

    this.cart.forEach((item, index) => {
      const isVipCartItem = item.product.id === 'prod-table-service';
      const isStaffDiscountCartItem = item.product.id === 'prod-staff-discount';
      const rate = this.selectedCustomer.price_tier === 'WHOLESALE' ? item.product.cost_price * 1.15 : item.product.sell_price;
      const lineDiscount = Math.max(0, Number(item.discount_amount) || 0);
      const total = Math.max(0, rate * item.qty - lineDiscount);

      const markup = `
        <div class="cart-item-header" style="display: flex; align-items: center; gap: 8px;">
          ${item.product.image_data ? `<img src="${item.product.image_data}" style="width: 24px; height: 24px; object-fit: cover; border-radius: 4px; border: 1px solid rgba(200, 130, 42, 0.2);">` : `<div style="width: 24px; height: 24px; border-radius: 4px; background: rgba(255,255,255,0.05); display: flex; align-items: center; justify-content: center; font-size: 13px; color: var(--text-muted);">📷</div>`}
          <span class="cart-item-title" style="flex: 1;">${item.product.name}</span>
          <button class="cart-item-remove" data-idx="${index}">✕</button>
        </div>
        ${item.batch ? `
          <div class="cart-item-batch-info">
            <span>Batch: ${item.batch.batch_no}</span>
            <span>Exp: ${item.batch.expiry_date}</span>
          </div>
        ` : ''}
        <div class="cart-item-details">
          ${isVipCartItem ? '<span style="font-size:11px;color:var(--accent-amber);font-weight:700;">+30% Surcharge</span>' :
            (isStaffDiscountCartItem ? '<span style="font-size:11px;color:var(--accent-green);font-weight:700;">-20% Staff Disc</span>' : `
          <div class="cart-item-qty-control">
            <button class="qty-btn dec" data-idx="${index}">-</button>
            <span class="qty-val"></span>
            <button class="qty-btn inc" data-idx="${index}">+</button>
          </div>`)}
          <span class="cart-item-price"></span>
        </div>
      `;

      const updateValues = (element) => {
        const quantity = element.querySelector('.qty-val');
        if (quantity && quantity.textContent !== String(item.qty)) quantity.textContent = String(item.qty);
        const price = element.querySelector('.cart-item-price');
        const label = isVipCartItem ? 'VIP' : (isStaffDiscountCartItem ? '-20%' : 'KES ' + total.toFixed(2));
        if (price.textContent !== label) price.textContent = label;
      };

      const cached = this.cartRows.get(item);
      if (cached?.markup === markup) {
        // Keep quantity buttons connected even if another tap updates this
        // item between a finger going down and coming up.
        updateValues(cached.element);
        if (list.children[index] !== cached.element) {
          list.insertBefore(cached.element, list.children[index] || null);
        }
        return;
      }
      const div = document.createElement('div');
      div.className = 'cart-item';
      div.innerHTML = markup;
      updateValues(div);

      // Remove item listener
      div.querySelector('.cart-item-remove').addEventListener('click', (e) => {
        this.invalidateMpesaAttempt();
        const idx = parseInt(e.target.getAttribute('data-idx'));
        this.cart.splice(idx, 1);
        this.updateCartUI();
      });

      // Quantity increment/decrement listener (VIP and Staff Discount items have no qty controls)
      const decBtn = div.querySelector('.qty-btn.dec');
      const incBtn = div.querySelector('.qty-btn.inc');
      if (decBtn) {
        decBtn.addEventListener('click', (e) => {
          this.invalidateMpesaAttempt();
          const idx = parseInt(e.target.getAttribute('data-idx'));
          if (this.cart[idx].qty > 1) {
            this.cart[idx].qty--;
          } else {
            this.cart.splice(idx, 1);
          }
          this.updateCartUI();
        });
      }
      if (incBtn) {
        incBtn.addEventListener('click', (e) => {
          this.invalidateMpesaAttempt();
          const idx = parseInt(e.target.getAttribute('data-idx'));
          this.cart[idx].qty++;
          this.updateCartUI();
        });
      }

      const previous = list.children[index];
      if (previous) previous.replaceWith(div);
      else list.appendChild(div);
      this.cartRows.set(item, { element: div, markup });
    });
    while (list.children.length > this.cart.length) list.lastElementChild.remove();

    this.recomputeTotals();
  }

  recomputeTotals() {
    let subtotal = 0;
    let discount = 0;
    let tax = 0;
    let vipSurcharge = 0;
    let staffDiscount = 0;

    // Check special items in cart
    const hasVip = this.cart.some(item => item.product.id === 'prod-table-service');
    const hasStaffDiscount = this.cart.some(item => item.product.id === 'prod-staff-discount');

    // First pass: compute subtotal of NON-special items
    this.cart.forEach(item => {
      if (item.product.id === 'prod-table-service' || item.product.id === 'prod-staff-discount') return;
      const price = this.selectedCustomer.price_tier === 'WHOLESALE' ? item.product.cost_price * 1.15 : item.product.sell_price;
      const itemSub = price * item.qty;
      const itemDiscount = Math.min(itemSub, Math.max(0, Number(item.discount_amount) || 0));
      subtotal += itemSub;
      discount += itemDiscount;
      
      let rate = 0.16;
      if (item.product.tax_code === 'B') rate = 0.08;
      else if (item.product.tax_code === 'C' || item.product.tax_code === 'E') rate = 0.00;

      const taxableTotal = itemSub - itemDiscount;
      const itemTax = (taxableTotal - (taxableTotal / (1 + rate)));
      tax += itemTax;
    });

    // Apply VIP 30% surcharge & Staff 20% discount on subtotal
    if (hasVip) {
      vipSurcharge = subtotal * 0.30;
    }
    if (hasStaffDiscount) {
      staffDiscount = subtotal * 0.20;
    }

    const total = Math.max(0, subtotal + vipSurcharge - staffDiscount - discount);

    document.getElementById('summary-subtotal').textContent = `KES ${subtotal.toFixed(2)}`;
    
    const vipRow = document.getElementById('summary-vip-row');
    if (vipRow) {
      vipRow.style.display = hasVip ? '' : 'none';
      if (hasVip) document.getElementById('summary-vip-charge').textContent = `KES ${vipSurcharge.toFixed(2)}`;
    }

    const staffRow = document.getElementById('summary-staff-disc-row');
    if (staffRow) {
      staffRow.style.display = hasStaffDiscount ? '' : 'none';
      if (hasStaffDiscount) document.getElementById('summary-staff-disc-amount').textContent = `-KES ${staffDiscount.toFixed(2)}`;
    }

    document.getElementById('summary-discount').textContent = `KES ${discount.toFixed(2)}`;
    document.getElementById('summary-tax').textContent = `KES ${tax.toFixed(2)}`;
    document.getElementById('summary-total').textContent = `KES ${total.toFixed(2)}`;

    // Store calculations on class reference
    this.totals = { subtotal, discount, tax, total, vipSurcharge, staffDiscount };
    // The tab buttons quote the cart plus what is already owed, so they move
    // with the cart rather than only when the tab list reloads.
    this.renderTabActions();
  }

  /**
   * The cart as the server can price it.
   *
   * The VIP charge and the staff discount are percentages the till carries as
   * pseudo-products; only this device has a document for either. Sending them
   * asked the server to price records it has never seen, so every STK push
   * from a cart holding one was refused with "Product prod-staff-discount is
   * not active for this tenant" and no prompt ever reached the phone. Their
   * money travels as the declared service charge and the reduced amount.
   */
  compactCartLines() {
    const quantities = new Map();
    for (const item of this.cart) {
      const productId = String(item.product.id);
      if (productId === VIP_CHARGE_ID || productId === STAFF_DISCOUNT_ID) continue;
      quantities.set(productId, (quantities.get(productId) || 0) + item.qty);
    }
    return [...quantities.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([productId, qty]) => ({ productId, qty }));
  }

  cartAttemptFingerprint() {
    return this.cart
      .map(item => [
        String(item.product.id),
        String(item.batch?.id || ''),
        Number(item.qty),
        toMinor(item.discount_amount || 0)
      ].join(':'))
      .sort()
      .join('|');
  }

  paymentAttemptFingerprint(phone, amountMinor, cashAmountMinor = 0) {
    return mpesaAttemptFingerprint({
      paymentMethod: this.selectedPaymentMethod,
      phone,
      amountMinor,
      cashAmountMinor,
      branchId: state.currentBranch?.id,
      deviceId: DEVICE_ID,
      customerId: this.selectedCustomer?.id,
      cartFingerprint: this.cartAttemptFingerprint()
    });
  }

  beginMpesaAttempt(phone, amountMinor, cashAmountMinor = 0) {
    const fingerprint = this.paymentAttemptFingerprint(phone, amountMinor, cashAmountMinor);
    this.mpesaAttempt = ensureMpesaAttempt(this.mpesaAttempt, fingerprint);
    if (!Number.isSafeInteger(this.mpesaAttempt.requestAmountMinor)) {
      this.mpesaAttempt.requestAmountMinor = amountMinor;
      this.mpesaAttempt.cashAmountMinor = cashAmountMinor;
    }
    this.persistDraft();
    return this.mpesaAttempt;
  }

  /**
   * Stands between a confirmed M-Pesa payment and being thrown away.
   *
   * A confirmed payment normally registers its sale immediately. This guard
   * covers only the recovery window where payment succeeded but that automatic
   * registration failed and the cashier still has the paid cart on screen.
   *
   * Discarding is still allowed, because a cashier who has refunded by hand
   * must be able to move on. It is recorded when it happens.
   */
  confirmDiscardingPaidMpesa(action) {
    if (!this.mpesaVerified || !this.mpesaRef) return true;

    const amount = (this.mpesaConfirmedAmountMinor || 0) / 100;
    const proceed = window.confirm(
      `M-Pesa has CONFIRMED KES ${amount.toFixed(2)} (ref ${this.mpesaRef}).\n\n`
        + `${action} now leaves that money received with no sale recorded - it will not appear in Orders, `
        + 'the takings or eTIMS.\n\nPress Cancel to let the order finish registering instead.\n\n'
        + 'Discard the confirmed payment anyway?'
    );

    if (!proceed) return false;

    showNotification(
      `Discarded a confirmed M-Pesa payment (${this.mpesaRef}). Reconcile it by hand.`,
      'error'
    );
    // Written whatever the cashier chose to do next, so a payment that reached
    // the business but never became a sale can still be found afterwards.
    void logAuditEvent(
      state.currentTenant?.id,
      state.currentUser?.id,
      'MPESA_CONFIRMED_DISCARDED',
      'PAYMENT',
      this.mpesaRef,
      null,
      JSON.stringify({ amount, action })
    ).catch(() => {});

    return true;
  }

  invalidateMpesaAttempt({ preservePricing = false } = {}) {
    const hadProviderPricing = this.mpesaAttempt?.pricingApplied === true;
    this.mpesaAttempt = null;
    this.mpesaRef = null;
    this.mpesaVerified = false;
    this.mpesaConfirmedAmountMinor = null;

    if (hadProviderPricing && !preservePricing) {
      for (const item of this.cart) {
        item.discount_amount = 0;
        item.discount_percent = 0;
      }
      this.recomputeTotals();
      const due = document.getElementById('checkout-due-amount');
      if (due) due.innerText = `KES ${this.totals.total.toFixed(2)}`;
    }

    const confirm = document.getElementById('pay-confirm-btn');
    if (confirm && this.selectedPaymentMethod === 'MPESA') {
      confirm.disabled = true;
    }

    if (this.mpesaCapability.available) {
      document.getElementById('stk-status-area')?.classList.add('hidden');
    } else {
      this.applyMpesaCapabilityToUi();
    }
  }

  showMpesaStatus(kind, message, level = 'warning') {
    const area = document.getElementById('stk-status-area');
    const badge = document.getElementById('stk-status-badge');
    if (!area || !badge) return;
    area.classList.remove('hidden');
    badge.className = `badge ${level}`;
    badge.innerText = message;
  }

  applyMpesaCapabilityToUi() {
    const capability = this.mpesaCapability;
    const unavailable = !capability.available;
    const statusLabel = capability.status === 'staged'
      ? 'Configured - activation pending'
      : capability.status === 'suspended'
        ? 'Temporarily suspended'
        : capability.available
          ? 'Send prompt directly to customer phone'
          : 'Unavailable until the server confirms activation';

    for (const id of ['payment-method-mpesa']) {
      const card = document.getElementById(id);
      if (!card) continue;
      card.style.opacity = unavailable ? '0.55' : '';
      card.style.cursor = unavailable ? 'not-allowed' : '';
      card.setAttribute('aria-disabled', String(unavailable));
      card.title = unavailable ? capability.message : '';
    }

    const mpesaNote = document.getElementById('payment-method-mpesa-note');
    if (mpesaNote) mpesaNote.innerText = statusLabel;

    const offline = state.syncManager?.connectionStatus === 'OFFLINE';
    const trigger = document.getElementById('pay-trigger-stk');
    if (trigger) trigger.disabled = unavailable || offline || this.mpesaVerified;

    if (unavailable) {
      this.showMpesaStatus('mpesa', capability.message, 'warning');
    }

    const confirm = document.getElementById('pay-confirm-btn');
    if (
      confirm
      && this.selectedPaymentMethod === 'MPESA'
      && !this.mpesaVerified
    ) {
      confirm.disabled = true;
    }
  }

  async refreshMpesaCapability() {
    const requestId = ++this.mpesaCapabilityRequest;
    this.mpesaCapability = unavailableMpesaCapability('Checking M-Pesa activation status...');
    this.applyMpesaCapabilityToUi();
    const capability = await this.mpesa.getCapability();
    if (requestId !== this.mpesaCapabilityRequest) return this.mpesaCapability;
    this.mpesaCapability = capability;
    this.applyMpesaCapabilityToUi();
    return capability;
  }

  /** What the line is booked at, so the VIP charge and the staff discount
   *  weigh here exactly as they do on the sale. */
  cartLineGrossMinor(item) {
    const rate = saleLineRate(item.product, this.totals, this.selectedCustomer.price_tier);
    return toMinor(rate * item.qty);
  }

  allocateDiscount(discounts, indexes, amountMinor, grossByIndex) {
    if (amountMinor === 0) return true;
    let remainingDiscount = amountMinor;
    let remainingGross = indexes.reduce((sum, index) => sum + grossByIndex[index], 0);
    if (amountMinor < 0 || amountMinor > remainingGross) return false;

    indexes.forEach((index, position) => {
      const gross = grossByIndex[index];
      const allocation = position === indexes.length - 1
        ? remainingDiscount
        : Math.min(gross, Math.floor((remainingDiscount * gross) / remainingGross));
      discounts[index] += allocation;
      remainingDiscount -= allocation;
      remainingGross -= gross;
    });

    return remainingDiscount === 0;
  }

  /**
   * Applies the server-authoritative legacy discount without changing the cash
   * side of a split. Nothing is mutated until the whole response is validated.
   */
  applyServerPricing(pricing, attempt, phone, kind) {
    if (!pricing) {
      if (attempt.pricingApplied && Number.isSafeInteger(attempt.settledAmountMinor)) {
        return { ok: true, amountMinor: attempt.settledAmountMinor };
      }
      attempt.settledAmountMinor = attempt.requestAmountMinor;
      return { ok: true, amountMinor: attempt.requestAmountMinor };
    }

    const baseAmountMinor = pricing.baseAmountMinor;
    const discountMinor = pricing.discountMinor;
    const amountMinor = pricing.amountMinor;
    if (
      !Number.isSafeInteger(baseAmountMinor)
      || !Number.isSafeInteger(discountMinor)
      || !Number.isSafeInteger(amountMinor)
      || baseAmountMinor !== attempt.requestAmountMinor
      || discountMinor < 0
      || amountMinor <= 0
      || amountMinor !== baseAmountMinor - discountMinor
    ) {
      return { ok: false, message: 'M-Pesa returned invalid discount totals. Do not complete this sale.' };
    }

    // No membership discount means the server priced the cart exactly as the
    // till tendered it, and there is nothing to re-allocate. The allocation
    // below exists only to apply a server-granted discount; running it with
    // nothing to give away rewrote every line's discount to zero - wiping the
    // cashier's own discounts and the staff discount - and then failed the
    // reconciliation it had just broken. Every discounted M-Pesa sale died here.
    if (discountMinor === 0) {
      attempt.pricingApplied = true;
      attempt.pricing = pricing;
      attempt.settledAmountMinor = amountMinor;
      attempt.fingerprint = this.paymentAttemptFingerprint(phone, amountMinor, 0);
      return { ok: true, amountMinor };
    }

    const grossByIndex = this.cart.map(item => this.cartLineGrossMinor(item));
    const cartGrossMinor = grossByIndex.reduce((sum, value) => sum + value, 0);
    if (discountMinor > cartGrossMinor) {
      return { ok: false, message: 'M-Pesa returned a discount larger than the cart total.' };
    }

    const discounts = this.cart.map(() => 0);
    const serverLines = Array.isArray(pricing.lineDiscounts) ? pricing.lineDiscounts : [];
    if (serverLines.length > 0) {
      const byProduct = new Map();
      for (const line of serverLines) {
        if (
          !line
          || typeof line.productId !== 'string'
          || !Number.isSafeInteger(line.discountMinor)
          || line.discountMinor < 0
        ) {
          return { ok: false, message: 'M-Pesa returned an invalid line discount.' };
        }
        byProduct.set(
          line.productId,
          (byProduct.get(line.productId) || 0) + line.discountMinor
        );
      }

      const lineDiscountTotal = [...byProduct.values()].reduce((sum, value) => sum + value, 0);
      if (lineDiscountTotal !== discountMinor) {
        return { ok: false, message: 'M-Pesa line discounts do not match the payment discount.' };
      }

      for (const [productId, productDiscount] of byProduct.entries()) {
        const indexes = this.cart
          .map((item, index) => item.product.id === productId ? index : -1)
          .filter(index => index >= 0);
        if (
          indexes.length === 0
          || !this.allocateDiscount(discounts, indexes, productDiscount, grossByIndex)
        ) {
          return { ok: false, message: 'M-Pesa returned a discount for an invalid cart line.' };
        }
      }
    } else if (!this.allocateDiscount(
      discounts,
      this.cart.map((_, index) => index),
      discountMinor,
      grossByIndex
    )) {
      return { ok: false, message: 'M-Pesa discount could not be allocated to this cart.' };
    }

    const discountedCartMinor = cartGrossMinor - discountMinor;
    // One tender per sale, so the M-Pesa amount is the whole discounted cart.
    if (amountMinor !== discountedCartMinor) {
      return {
        ok: false,
        message: 'The discounted M-Pesa amount no longer settles the cart exactly.'
      };
    }

    this.cart.forEach((item, index) => {
      item.discount_amount = discounts[index] / 100;
      item.discount_percent = grossByIndex[index] > 0
        ? (discounts[index] / grossByIndex[index]) * 100
        : 0;
    });
    this.recomputeTotals();

    if (
      toMinor(this.totals.discount) !== discountMinor
      || toMinor(this.totals.total) !== discountedCartMinor
    ) {
      return { ok: false, message: 'The discounted cart could not be represented exactly on this till.' };
    }

    document.getElementById('checkout-due-amount').innerText = `KES ${this.totals.total.toFixed(2)}`;

    attempt.pricingApplied = true;
    attempt.pricing = pricing;
    attempt.settledAmountMinor = amountMinor;
    attempt.fingerprint = this.paymentAttemptFingerprint(phone, amountMinor, 0);
    return { ok: true, amountMinor };
  }

  /**
   * Opens checkout for a whole tab.
   *
   * Whatever is in the cart becomes the last round first, so the amount being
   * charged is simply what the tab owes - the beer, the food, the liquor and
   * the round just rung up - counted once, in one place.
   */
  async openTabCheckout() {
    if (this.cart.length > 0) await this.addRoundToTab();
    await this.loadOpenTabs();

    const tab = (this.openTabs || []).find((entry) => tabKey(entry.table) === tabKey(this.activeTable));
    if (!tab || tab.dueMinor <= 0) {
      showNotification(`Nothing is owed on Table ${this.activeTable}.`, 'warning');
      return false;
    }

    // The rounds carry the tax and discounts that were rung at the time; the
    // checkout charges their sum rather than recomputing an emptied cart.
    const rounds = await db.sales.bulkGet(tab.unpaidRounds.map((round) => round.id));
    const sum = (field) => rounds.reduce((total, sale) => total + (Number(sale?.[field]) || 0), 0);
    this.totals = {
      subtotal: sum('subtotal'),
      discount: sum('discount'),
      tax: sum('tax_total'),
      total: tab.dueMinor / 100,
      vipSurcharge: 0,
      staffDiscount: 0
    };
    await this.startPrintedCheckout();
    return true;
  }

  async startPrintedCheckout() {
    if (this.preparingPrintedCheckout) return;
    this.preparingPrintedCheckout = true;
    requirePrintedReceipt(async () => {
      if (!firebaseConfigured) throw new Error('Reconnect to print the receipt before payment.');
      if (!this.activeTabId && !this.pendingSale) await this.registerPendingOrder();
      const ids = await this.roundsBeingSettled();
      if (!ids.length) throw new Error('Save the order before printing the receipt.');
      const rounds = [];
      for (const id of ids) rounds.push(await state.syncManager.publishSale(id));
      return { saleUuids: rounds.map(round => round.sale_uuid) };
    }, {
        isActive: () => this.container.isConnected && !this.disposed,
        onReady: () => { this.preparingPrintedCheckout = false; this.openCheckoutModal(); },
        onCancel: () => {
          this.preparingPrintedCheckout = false;
          // Registration froze this bill. Leave it in Pending instead of
          // letting a changed cart settle the earlier printed amount.
          if (!this.pendingSale) return;
          this.pendingSale = null;
          this.pendingRegistration = null;
          this.cartDraftId = null;
          this.releaseHeldLease();
          this.clearCart();
          showNotification('Order saved in Pending. Open it in Orders to continue.', 'info');
        },
    });
  }

  openCheckoutModal() {
    if (this.recoveredPaymentAttempt) {
      showNotification('This restored draft has an earlier M-Pesa attempt. Reconcile that payment in Financials before taking payment again.', 'warning');
      return;
    }
    const cashEnabled = tenantStorage.getItem('pos_cash_enabled') !== 'false';
    // The cart already knows which tab this is; show the same table here
    // rather than letting the two disagree about where the order is going.
    if (this.activeTable) document.getElementById('checkout-table-number').value = this.activeTable;
    this.originalDue = this.totals.total;
    this.redeemedPoints = 0;

    document.getElementById('checkout-due-amount').innerText = `KES ${this.totals.total.toFixed(2)}`;
    document.getElementById('payment-modal').classList.add('active');

    // Populate Loyalty details
    const ptsSpan = document.getElementById('checkout-loyalty-pts');
    const redeemBtn = document.getElementById('btn-redeem-loyalty');
    const redeemStatus = document.getElementById('loyalty-redeem-status');
    redeemStatus.style.display = 'none';

    if (this.selectedCustomer && this.selectedCustomer.id !== WALK_IN_CUSTOMER_ID) {
      const pts = this.selectedCustomer.loyalty_points || 0;
      ptsSpan.textContent = `${pts} pts`;
      redeemBtn.disabled = pts <= 0;
    } else {
      ptsSpan.textContent = '0 pts';
      redeemBtn.disabled = true;
    }

    // Set redeem handler once
    if (!this.loyaltyBound) {
      redeemBtn.addEventListener('click', () => {
        const pts = this.selectedCustomer.loyalty_points || 0;
        if (pts <= 0) return;
        
        // Max points to redeem is limited by due amount
        const redeemAmt = Math.min(pts, Math.floor(this.originalDue));
        this.redeemedPoints = redeemAmt;
        this.totals.total = this.originalDue - redeemAmt;

        document.getElementById('checkout-due-amount').innerText = `KES ${this.totals.total.toFixed(2)}`;
        redeemStatus.textContent = `★ Redeemed ${redeemAmt} points for KES ${redeemAmt}.00 discount!`;
        redeemStatus.style.display = 'block';
        redeemBtn.disabled = true;

        // Re-update select payment method input fields
        this.selectPaymentMethod(this.selectedPaymentMethod);
      });
      this.loyaltyBound = true;
    }

    // Hide/show cash payment option based on owner setting
    const cashCard = document.querySelector('[data-method="CASH"]');
    if (cashCard) cashCard.style.display = cashEnabled ? '' : 'none';
    document.getElementById('pay-mpesa-code').value = '';

    // Require a deliberate tender choice before revealing its fields.
    this.selectPaymentMethod(null);
    void this.refreshMpesaCapability();
    // On a tab the rounds are already registered and this is settling them,
    // so there is nothing further to register. Off a tab the order joins the
    // board here, before any tender is chosen, so a push that never confirms
    // can no longer take the whole order down with it.
    if (!this.activeTabId) {
      this.pendingRegistration = this.registerPendingOrder().catch((error) => {
        showNotification(error.message || 'The order could not be registered.', 'error');
        return false;
      });
    }
  }

  selectPaymentMethod(method) {
    if (method !== this.selectedPaymentMethod) this.invalidateMpesaAttempt();
    this.selectedPaymentMethod = method;
    document.getElementById('pay-mpesa-amount').value = '';
    this.container.querySelectorAll('#payment-modal .payment-method-card').forEach(card => {
      const selected = card.dataset.method === method;
      card.classList.toggle('selected', selected);
      card.setAttribute('aria-selected', String(selected));
    });
    
    // Hide all input areas
    document.getElementById('payment-inputs-cash').classList.add('hidden');
    document.getElementById('payment-inputs-mpesa').classList.add('hidden');
    document.getElementById('payment-inputs-mpesa-code').classList.add('hidden');
    document.getElementById('payment-inputs-credit').classList.add('hidden');
    document.getElementById('payment-inputs-card').classList.add('hidden');
    document.getElementById('payment-inputs-proforma').classList.add('hidden');
    if (!method) {
      document.getElementById('pay-confirm-btn').disabled = true;
      document.getElementById('pay-confirm-btn').innerText = 'Choose a payment method';
      return;
    }

    // Every tender starts confirmable; only the credit check takes that away.
    // Without this reset, a breached credit limit left the button disabled for
    // whatever tender the cashier switched to next.
    document.getElementById('pay-confirm-btn').disabled = false;
    document.getElementById('pay-confirm-btn').innerText = method === 'MPESA'
      ? 'Await M-Pesa confirmation'
      : 'Complete Sale';
    document.getElementById('credit-warn-text').innerText = '';
    document.getElementById('proforma-warn-text').innerText = '';

    // Show selected
    if (method === 'CASH') {
      document.getElementById('payment-inputs-cash').classList.remove('hidden');
      document.getElementById('pay-cash-tendered').value = Math.ceil(this.totals.total);
      this.updateCashChange(Math.ceil(this.totals.total));
    } else if (method === 'MPESA') {
      document.getElementById('payment-inputs-mpesa').classList.remove('hidden');
      document.getElementById('pay-mpesa-phone').value = this.selectedCustomer.phone || '';
      document.getElementById('stk-status-area').classList.add('hidden');
      document.getElementById('pay-trigger-stk').disabled = true;
    } else if (method === 'MPESA_CODE') {
      document.getElementById('payment-inputs-mpesa-code').classList.remove('hidden');
      document.getElementById('pay-confirm-btn').disabled = false;
    } else if (method === 'CREDIT') {
      document.getElementById('payment-inputs-credit').classList.remove('hidden');
      this.applyCreditLimit();
    } else if (method === 'CARD') {
      document.getElementById('payment-inputs-card').classList.remove('hidden');
    } else if (method === 'PROFORMA') {
      document.getElementById('payment-inputs-proforma').classList.remove('hidden');
      // An unpaid invoice against a walk-in is a debt nobody can chase, so the
      // sale is refused until a real customer is attached to it.
      const anonymous = !this.selectedCustomer?.id || this.selectedCustomer.id === WALK_IN_CUSTOMER_ID;
      document.getElementById('proforma-warn-text').innerText = anonymous
        ? 'Attach a customer to the cart first - an unpaid invoice needs someone to bill.'
        : '';
      document.getElementById('pay-confirm-btn').disabled = anonymous;
    }

    this.applyMpesaCapabilityToUi();
  }

  /**
   * What this customer already owes on account.
   *
   * ponytail: every credit sale counts as outstanding for good - there is no
   * repayment flow in the system yet. Subtract settlements here once one
   * exists, rather than teaching the caller about it.
   */
  async creditOutstanding(customerId) {
    if (!customerId) return 0;

    const sales = await db.sales.where('customer_id').equals(customerId).toArray();
    if (sales.length === 0) return 0;

    const payments = await db.payments
      .where('sale_id').anyOf(sales.map(sale => sale.id))
      .toArray();

    // Proformas are the same debt under a different name, so they count
    // against the same limit.
    return payments
      .filter(payment => isReceivable(payment.method))
      .reduce((total, payment) => total + (Number(payment.amount) || 0), 0);
  }

  /** Shows the real debtor position and blocks a sale that would breach it. */
  async applyCreditLimit() {
    const limit = Number(this.selectedCustomer.credit_limit) || 0;
    document.getElementById('pay-credit-limit').innerText = `KES ${limit.toFixed(2)}`;
    document.getElementById('pay-credit-balance').innerText = 'Checking...';

    const outstanding = await this.creditOutstanding(this.selectedCustomer.id);

    // The cashier may have switched tender while that read was in flight;
    // acting now would disable Confirm for whatever they moved to.
    if (this.selectedPaymentMethod !== 'CREDIT') return;

    document.getElementById('pay-credit-balance').innerText = `KES ${outstanding.toFixed(2)}`;

    const breached = this.totals.total > (limit - outstanding);
    document.getElementById('credit-warn-text').innerText = breached
      ? 'CREDIT LIMIT BREACHED. Approval required to post sale.'
      : '';
    document.getElementById('pay-confirm-btn').disabled = breached;
  }

  updateCashChange(tendered) {
    const change = Math.max(0, tendered - this.totals.total);
    document.getElementById('pay-cash-change').innerText = `KES ${change.toFixed(2)}`;
  }

  /*
   * The staff discount and the VIP surcharge are ordinary catalogue items.
   *
   * The till used to hold the staff discount against a hardcoded list of staff
   * phone numbers at payment time: an M-Pesa number that was not on the list
   * had the discount torn out of the cart mid-checkout and the tender refused,
   * which is wrong whenever somebody else's phone pays for a staff member -
   * which is most of the time. Adding either item now just changes the total,
   * and payment proceeds like any other sale. Who may apply one is a floor
   * decision, and the audit trail records that it was applied.
   */

  /**
   * STK needs Safaricom reachable on both legs. There is no queue that makes an
   * offline push work later, so the tender is refused rather than assumed paid.
   */
  mpesaOffline(notice) {
    if (state.syncManager.connectionStatus !== 'OFFLINE') return false;
    showNotification(notice, 'error');
    return true;
  }

  async triggerMpesaStk() {
    await this.runMpesaAttempt('mpesa');
  }

  async runMpesaAttempt(kind) {
    if (this.pendingRegistration) await this.pendingRegistration;
    if (firebaseConfigured && !this.activeTabId && !this.pendingSale) {
      showNotification('Save this order to Pending before taking payment. Close checkout and retry Pay Now.', 'error');
      return;
    }
    if (this.pendingSale && firebaseConfigured) {
      try { await state.syncManager.publishSale(this.pendingSale.saleId); }
      catch (error) { showNotification(error.message, 'error'); return; }
    }
    const phone = document.getElementById('pay-mpesa-phone').value;
    const trigger = document.getElementById('pay-trigger-stk');
    const mpesaMinor = toMinor(this.totals.total);
    if (mpesaMinor <= 0) {
      this.showMpesaStatus(kind, 'Enter an M-Pesa amount greater than zero.', 'danger');
      return;
    }
    if (this.mpesaOffline('Offline: M-Pesa is unavailable. Use another tender.')) {
      this.showMpesaStatus(kind, 'Offline: M-Pesa unavailable', 'danger');
      return;
    }

    const attempt = this.beginMpesaAttempt(phone, mpesaMinor, 0);
    if (this.mpesaVerified && this.mpesaAttempt === attempt) {
      this.showMpesaStatus(kind, `Already confirmed. Code: ${this.mpesaRef}`, 'success');
      return;
    }

    this.showMpesaStatus(kind, 'Checking activation and initiating STK Push...', 'warning');
    trigger.disabled = true;

    try {
      let settlementSaleUuids;
      if (firebaseConfigured) {
        const ids = await this.roundsBeingSettled();
        const rounds = [];
        for (const id of ids) rounds.push(await state.syncManager.publishSale(id));
        this.settlementRequestId ||= crypto.randomUUID();
        await claimSalePayment({
          saleUuids: rounds.map(round => round.sale_uuid), checkoutId: this.settlementRequestId,
          stkKey: attempt.idempotencyKey, expectedMinor: mpesaMinor, deviceId: DEVICE_ID, method: 'stk',
        });
        settlementSaleUuids = rounds.map(round => round.sale_uuid);
      }
      const res = await this.mpesa.initiateStkPush({
        phone,
        amountKes: attempt.requestAmountMinor / 100,
        cashAmountMinor: attempt.cashAmountMinor || 0,
        branchId: state.currentBranch?.id,
        deviceId: DEVICE_ID,
        idempotencyKey: attempt.idempotencyKey,
        // The server caps orderReference at 40 characters; the key is 42
        // ("mpesa_" + a 36-char UUID). Truncating keeps it unique per attempt.
        orderReference: attempt.idempotencyKey.slice(0, 40),
        customerId: this.selectedCustomer?.id || null,
        lines: settlementSaleUuids ? [] : this.compactCartLines(),
        // The only part of the total that is not a catalogue price.
        serviceChargeMinor: settlementSaleUuids ? 0 : toMinor(this.totals.vipSurcharge || 0),
        ...(settlementSaleUuids ? { settlementSaleUuids, checkoutId: this.settlementRequestId } : {})
      });
      if (res.capability) {
        this.mpesaCapability = res.capability;
        this.applyMpesaCapabilityToUi();
      }
      if (!res.success) {
        const level = res.status === 'staged' || res.status === 'suspended' ? 'warning' : 'danger';
        this.showMpesaStatus(kind, res.message || 'M-Pesa did not accept the payment.', level);
        showNotification(res.message || 'M-Pesa request failed.', level === 'warning' ? 'warning' : 'error');
        if (['failed', 'cancelled', 'expired', 'invalid'].includes(res.status)) {
          this.invalidateMpesaAttempt();
          this.showMpesaStatus(kind, res.message || 'M-Pesa did not accept the payment.', level);
        }
        return;
      }

      attempt.attemptId = res.attemptId;
      attempt.checkoutRequestId = res.checkoutRequestId;
      const currentAttempt = this.mpesaAttempt === attempt;
      const priced = currentAttempt
        ? this.applyServerPricing(res.pricing, attempt, phone, kind)
        : { ok: false, message: 'The cart changed after M-Pesa initiation.' };
      if (!priced.ok) {
        this.showMpesaStatus(kind, priced.message, 'danger');
        showNotification(priced.message, 'error');
      } else {
        this.showMpesaStatus(kind, res.customerMessage || 'Awaiting User PIN on Phone...', 'warning');
      }

      const result = await this.mpesa.awaitResult(res.attemptId, (text) => {
        if (this.mpesaAttempt === attempt) this.showMpesaStatus(kind, text, 'warning');
      });

      if (result.status === 'paid') {
        const expectedAmountMinor = attempt.settledAmountMinor;
        const amountMatches = result.amountMinor === null
          || result.amountMinor === expectedAmountMinor;
        const fingerprintMatches = this.mpesaAttempt === attempt
          && attempt.fingerprint === this.paymentAttemptFingerprint(
            phone,
            expectedAmountMinor,
            0
          );

        if (!priced.ok || !amountMatches || !fingerprintMatches) {
          this.mpesaVerified = false;
          this.mpesaRef = null;
          this.mpesaConfirmedAmountMinor = null;
          this.showMpesaStatus(
            kind,
            'Payment received for an earlier cart state. Do not release goods; request manager review.',
            'danger'
          );
          showNotification('M-Pesa paid, but it does not match the current cart. Manager review is required.', 'error');
          return;
        }

        this.mpesaRef = result.receipt || res.checkoutRequestId || res.attemptId;
        this.mpesaVerified = true;
        this.mpesaConfirmedAmountMinor = expectedAmountMinor;
        this.showMpesaStatus(
          kind,
          result.receipt ? `Confirmed. Registering order ${result.receipt}...` : 'Confirmed. Registering order...',
          'success'
        );

        // Payment confirmation is the business event that registers the
        // order. Receipt viewing and printing happen afterwards and can no
        // longer strand received money outside Orders and Financials.
        const confirm = document.getElementById('pay-confirm-btn');
        confirm.disabled = true;
        confirm.innerText = 'Registering order...';
        try {
          const registered = await this.finalizeInvoice();
          if (!registered) throw new Error('The order is not registered yet.');
          showNotification(`M-Pesa paid and order registered. Ref: ${this.mpesaRef}`, 'success');
        } catch (error) {
          // M-Pesa remains confirmed. Keep a manual retry available, while the
          // server-side attempt continues to show as received for reconciliation.
          confirm.disabled = false;
          confirm.innerText = 'Retry order registration';
          this.showMpesaStatus(kind, 'Payment confirmed, but order registration needs a retry.', 'danger');
          showNotification(error.message || 'Payment was received, but the order could not be registered.', 'error');
        }
      } else if (result.status === 'pending') {
        this.showMpesaStatus(kind, 'Unconfirmed - do not release goods', 'warning');
        showNotification('M-Pesa has not confirmed this payment. Retry safely or use another tender.', 'warning');
      } else {
        const failure = result.resultDesc || 'Payment failed, cancelled, or expired.';
        this.invalidateMpesaAttempt();
        this.showMpesaStatus(kind, failure, 'danger');
        showNotification('M-Pesa push rejected, cancelled, or expired.', 'error');
      }
    } catch (error) {
      // Keep the same key after an ambiguous network failure so Retry cannot
      // create a second prompt for a request the backend may have received.
      this.showMpesaStatus(kind, 'Could not confirm M-Pesa. Retry safely with the same attempt.', 'danger');
      showNotification(error.message || 'M-Pesa request failed.', 'error');
    } finally {
      this.applyMpesaCapabilityToUi();
      if (!this.mpesaVerified && this.mpesaCapability.available) trigger.disabled = false;
    }
  }

  async triggerPaystack(channel) {
    const emailInputId = channel === 'card' ? 'pay-card-email' : channel === 'mobile_money' ? 'pay-airtel-email' : 'pay-bank-email';
    const statusWrapId = channel === 'card' ? 'card-paystack-status' : channel === 'mobile_money' ? 'airtel-paystack-status' : 'bank-paystack-status';
    const badgeId = channel === 'card' ? 'card-paystack-badge' : channel === 'mobile_money' ? 'airtel-paystack-badge' : 'bank-paystack-badge';
    
    const email = document.getElementById(emailInputId).value || 'customer@titanium.com';
    const statusWrap = document.getElementById(statusWrapId);
    const badge = document.getElementById(badgeId);

    statusWrap.classList.remove('hidden');
    badge.className = 'badge warning';
    badge.innerText = 'Initializing Paystack...';

    showNotification('Opening Paystack Secure Checkout...', 'info');

    try {
      if (typeof PaystackPop !== 'undefined') {
        const handler = PaystackPop.setup({
          key: 'pk_test_placeholder',
          email: email,
          amount: Math.round(this.totals.total * 100),
          currency: 'KES',
          channels: [channel],
          ref: 'PAYSTACK-' + Math.floor((Math.random() * 1000000000) + 1),
          onClose: () => {
            badge.className = 'badge danger';
            badge.innerText = 'Payment Cancelled';
            showNotification('Paystack transaction window closed', 'warning');
          },
          callback: (response) => {
            badge.className = 'badge success';
            badge.innerText = 'Paid: ' + response.reference;
            this.paystackRef = response.reference;
            this.paystackVerified = true;
            showNotification('Paystack payment successful! Reference: ' + response.reference, 'success');
          }
        });
        handler.openIframe();
      } else {
        showNotification('Paystack library not loaded.', 'error');
      }
    } catch (e) {
      badge.className = 'badge danger';
      badge.innerText = 'Paystack Error';
      showNotification('Paystack error: ' + (e.message || e), 'error');
    }
  }

  /**
   * One row per tender actually taken.
   *
   * Split tenders were removed: they were the only path that wrote two rows,
   * and the cash half was self-certified at the counter while the M-Pesa half
   * waited on a provider. One tender per sale keeps settlement unambiguous.
   */
  buildPaymentRecords(saleId) {
    const now = new Date().toISOString();
    const row = (method, amount, reference, verified, metadata = undefined) => ({
      id: crypto.randomUUID(),
      sale_id: saleId,
      method,
      amount: Number(amount.toFixed(2)),
      reference: reference || '',
      provider_txn_id: reference || '',
      // Verified means a provider confirmed it, never that a method was picked.
      verified: verified ? 1 : 0,
      metadata,
      received_at: now
    });

    if (this.selectedPaymentMethod === 'MPESA') {
      return [row('MPESA', this.totals.total, this.mpesaRef, this.mpesaVerified, {
        phone: document.getElementById('pay-mpesa-phone')?.value || '',
        attemptId: this.mpesaAttempt?.attemptId || null
      })];
    }

    if (this.selectedPaymentMethod === 'MPESA_CODE') {
      const code = mpesaConfirmationCode(document.getElementById('pay-mpesa-code')?.value);
      return [row('MPESA', this.totals.total, code, false, { typedCode: true })];
    }

    if (this.selectedPaymentMethod === 'PROFORMA') {
      // Nothing has been paid. The row exists so the invoice, the debtor
      // balance and the takings report all agree on what is still owed.
      //
      // ponytail: like credit, this stays outstanding for good - there is no
      // settlement screen yet. When one exists it flips this row's method to
      // the tender that paid it, and every reader here follows.
      return [row(
        'PROFORMA',
        this.totals.total,
        document.getElementById('pay-proforma-reference')?.value.trim() || '',
        false
      )];
    }

    if (this.selectedPaymentMethod === 'CARD') {
      // The terminal already took the money; its reference is the only thread
      // back to the slip if the charge is ever queried.
      return [row('CARD', this.totals.total, document.getElementById('pay-card-reference')?.value.trim() || '', true)];
    }

    // Cash is settled at the drawer and credit is a receivable on the books;
    // neither has a provider to confirm it, so both count as settled here.
    return [row(this.selectedPaymentMethod, this.totals.total, this.paystackRef || '', true)];
  }

  mpesaProofMatchesCurrentCart() {
    if (!this.mpesaVerified || !this.mpesaAttempt || !this.mpesaRef) return false;

    const phone = document.getElementById('pay-mpesa-phone')?.value || '';
    const mpesaMinor = toMinor(this.totals.total);
    if (this.mpesaConfirmedAmountMinor !== mpesaMinor) return false;

    return this.mpesaAttempt.fingerprint
      === this.paymentAttemptFingerprint(phone, mpesaMinor, 0);
  }

  /** Saves Pay Now to the shared Pending board before tender is taken. */
  async registerPendingOrder() {
    // The same latch the tender uses: two taps of Pay Now must not write the
    // order twice, and neither must a tap that lands mid-settlement.
    if (this.finalizingInvoice || this.pendingSale || this.cart.length === 0) return;
    this.finalizingInvoice = true;

    try {
      const registered = await this.registerOrder(
        // Booked as the receivable it is: nothing has been paid yet.
        this.buildPendingPaymentRecords(),
        { pending: true }
      );
      if (!registered) return;

      this.pendingSale = registered;
      this.releaseHeldLease();
      await db.sales.update(registered.saleId, { server_pending: true, held_until: null });
      if (firebaseConfigured) await state.syncManager.publishSale(registered.saleId);
      showNotification(`Order ${registered.saleRecord.invoice_no} saved in Pending ? awaiting payment.`, 'info');
      return true;
    } finally {
      this.finalizingInvoice = false;
    }
  }

  /**
   * Closes a tab the moment nothing on it is owed.
   *
   * A table that pays as it goes never leaves a tab behind to block the shift,
   * and a tab that still owes something stays open for whoever settles it.
   */
  async settleEmptyTab(tabId) {
    // One closing path for both screens: the Orders Viewer settles tabs too,
    // and only this one was freeing the table.
    const freed = await freeSettledTab(tabId);
    if (freed !== null && this.activeTabId === tabId) this.clearActiveTab();
  }

  /**
   * The tables that still owe money, so another round can join their tab.
   *
   * Read from the same rows the Orders board reads, so a tab opened on this
   * till and one pulled from another agree about what a table owes.
   */
  async loadOpenTabs() {
    // Guard on an element that exists: an id that was never rendered returned
    // here every time, so a round added to a tab vanished from the till.
    if (!document.getElementById('till-table-options')) return;

    try {
      this.openTabs = await readOpenTabs(state.currentBranch?.id);
      // The first round is what opens a typed table's tab, so its id is only
      // known once read back; without it review and settle had nothing to act on.
      if (this.activeTable) {
        this.activeTabId = this.openTabs.find((tab) => tabKey(tab.table) === tabKey(this.activeTable))?.id || null;
      }
    } catch {
      this.openTabs = [];
    }

    this.renderOpenTabs();
  }

  renderOpenTabs() {
    const options = document.getElementById('till-table-options');
    const label = document.getElementById('till-open-tabs-label');
    if (!options || !label) return;

    const tabs = this.openTabs || [];
    options.replaceChildren(...tabs.map((tab) => Object.assign(document.createElement('option'), {
      value: tab.table,
      label: `KES ${(tab.dueMinor / 100).toFixed(2)} · ${tab.rounds.length} round${tab.rounds.length === 1 ? '' : 's'}`
    })));
    label.classList.toggle('hidden', tabs.length === 0);
    label.textContent = `${tabs.length} open tab${tabs.length === 1 ? '' : 's'} · Manage tabs →`;

    // Never while it is being typed into, or the cursor jumps mid-word.
    const input = document.getElementById('till-table-input');
    if (input && document.activeElement !== input) input.value = this.activeTable || '';

    document.getElementById('till-tab-bar')?.classList.toggle('on-tab', Boolean(this.activeTable));

    const heading = document.getElementById('cart-heading');
    if (heading) {
      heading.innerHTML = this.activeTable
        ? `Adding to <span class="on-tab-note">Table ${escapeHtml(this.activeTable)}</span>`
        : 'Current Sale';
    }

    this.renderTabActions();
  }

  /**
   * Saves this cart as another round on the tab, unpaid.
   *
   * This is the nine-thirty plate of food: rung up, sent, and added to what
   * table nine owes. The cart empties and the tab stays selected, because the
   * next thing that table asks for is another round on the same bill.
   */
  async addRoundToTab() {
    if (!this.activeTable) return;
    if (this.cart.length === 0) {
      showNotification('Add items to the cart before putting a round on the tab.', 'warning');
      return;
    }
    if (this.finalizingInvoice) return;
    this.finalizingInvoice = true;

    try {
      const registered = await this.registerOrder(this.buildPendingPaymentRecords(), { pending: true });
      if (!registered) return;

      // Nobody is about to pay for it, so it carries no lease: it belongs to
      // the tab now and any till may settle or void it.
      await db.sales.update(registered.saleId, { held_until: null });
      void Promise.resolve().then(() => state.syncManager.syncOutbox()).catch(() => {});

      this.cart = [];
      this.redeemedPoints = 0;
      this.updateCartUI();
      await this.loadOpenTabs();
      const tab = (this.openTabs || []).find((entry) => tabKey(entry.table) === tabKey(this.activeTable));
      showNotification(
        `Added to Table ${this.activeTable}. KES ${((tab?.dueMinor || 0) / 100).toFixed(2)} now on this tab.`,
        'success'
      );
      return true;
    } finally {
      this.finalizingInvoice = false;
    }
  }

  /**
   * Everything billed to this table, across every round.
   *
   * The bill a customer asks for is the table's, not one trip to it, so the
   * lines are read across the rounds and shown under the tab's own order
   * number.
   */
  async tabItems(tabId) {
    const rounds = (await db.sales.where('tab_id').equals(tabId).toArray())
      .filter((sale) => sale.status !== 'VOIDED');
    const ledger = await db.payments.where('sale_id').anyOf(rounds.map(sale => sale.id)).toArray();
    const bySale = new Map();
    for (const row of ledger) bySale.set(row.sale_id, [...(bySale.get(row.sale_id) || []), row]);

    const unpaid = rounds.filter((sale) => saleAsOrder(sale, { payments: bySale.get(sale.id) })
      .paymentStatus === 'unpaid');
    const lines = await db.sale_lines.where('sale_id').anyOf(unpaid.map((sale) => sale.id)).toArray();
    const products = new Map((await db.products.toArray()).map((product) => [product.id, product.name]));

    return lines.map((line) => ({
      ...line,
      name: line.product_name || products.get(line.product_id) || 'Item',
      soldAt: unpaid.find((sale) => sale.id === line.sale_id)?.sold_at
    }));
  }

  async openTabReview() {
    if (!this.activeTabId) return;
    const tab = await db.tabs.get(this.activeTabId);
    const items = await this.tabItems(this.activeTabId);

    document.getElementById('tab-review-title').innerText = `Table ${tab?.table_no || ''} — tab items`;
    document.getElementById('tab-review-order-no').innerText = tab?.order_no || '';
    document.getElementById('tab-review-total').innerText =
      `KES ${items.reduce((sum, line) => sum + (Number(line.line_total) || 0), 0).toFixed(2)}`;

    const list = document.getElementById('tab-review-list');
    list.replaceChildren(...items.map((line) => {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;justify-content:space-between;align-items:center;gap:10px;padding:8px 10px;border:1px solid var(--border-color);border-radius:8px;';
      row.innerHTML = `<div style="min-width:0;">
          <div style="font-size:13px;font-weight:600;">${escapeHtml(line.name)}</div>
          <div style="font-size:11px;color:var(--text-secondary);">${line.qty} × KES ${(Number(line.unit_price) || 0).toFixed(2)} · ${new Date(line.soldAt).toLocaleTimeString()}</div>
        </div>
        <div style="display:flex;align-items:center;gap:10px;white-space:nowrap;">
          <span style="font-size:13px;font-weight:700;">KES ${(Number(line.line_total) || 0).toFixed(2)}</span>
        </div>`;

      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'sec-btn';
      remove.style.cssText = 'padding:4px 10px;font-size:11px;';
      remove.innerText = 'Remove';
      remove.addEventListener('click', () => {
        if (!window.confirm(`Remove ${line.qty} × ${line.name} from this tab? Its stock goes back.`)) return;
        remove.disabled = true;
        void this.removeTabItem(line).catch((error) => {
          remove.disabled = false;
          showNotification(error.message || 'That item could not be removed.', 'error');
        });
      });
      row.lastElementChild.appendChild(remove);
      return row;
    }));

    if (items.length === 0) list.textContent = 'Nothing is on this tab yet.';
    document.getElementById('tab-review-modal').classList.add('active');
  }

  /**
   * Takes one item off the tab.
   *
   * The round it belongs to has already been rung up and its stock already
   * taken, and it may already be on the server, so the round is voided whole -
   * which is the one operation that reliably puts stock back in both places -
   * and what the table actually had is rung again on the same tab. The tab
   * keeps its order number throughout, so the bill the customer is shown never
   * changes its name.
   */
  async removeTabItem(line) {
    const { freedTable } = await removeTabLine(line.id);
    if (freedTable) {
      document.getElementById('tab-review-modal').classList.remove('active');
      this.clearActiveTab();
      await this.loadOpenTabs();
      showNotification(`${line.name} removed. Nothing is left on Table ${freedTable}, so its tab is closed.`, 'success');
      return;
    }
    await this.loadOpenTabs();
    await this.openTabReview();
    showNotification(`${line.name} removed from Table ${this.activeTable}'s tab.`, 'success');
  }

  /**
   * Offers the table's bill to the counter queue instead of printing it here.
   *
   * The whole unpaid tab goes, under the tab's order number, as a proforma:
   * that number and the table are what the Print Station search matches.
   */
  async offerTabPrint() {
    const tab = this.activeTabId ? await db.tabs.get(this.activeTabId) : null;
    const items = tab ? await this.tabItems(tab.id) : [];
    if (!items.length) return;

    const totals = roundTotals(items);
    this.lastReceiptPayload = {
      tenantName: state.currentTenant.trading_name,
      branchName: state.currentBranch.name,
      kraPin: state.currentTenant.kra_pin,
      branchCode: state.currentBranch.etims_bhf_id,
      phone: state.currentTenant.phone,
      invoiceNo: tab.order_no,
      soldAt: new Date().toLocaleString(),
      cashierName: state.currentUser?.name || '',
      customerName: this.selectedCustomer?.name || 'Guest',
      tableNo: tab.table_no,
      lines: items.map((line) => ({
        name: line.name,
        qty: line.qty,
        unitPrice: line.unit_price,
        lineTotal: line.line_total,
        taxCode: line.tax_code
      })),
      subtotal: totals.subtotal,
      taxTotal: totals.tax_total,
      grandTotal: totals.grand_total,
      paymentMethod: 'PROFORMA',
      paymentReference: null,
      unpaid: true
    };

    document.getElementById('tab-queue-summary').innerText =
      `Table ${tab.table_no} · ${tab.order_no} · KES ${totals.grand_total.toFixed(2)} unpaid. `
      + 'Print it at the Print Station by searching the order number or table.';
    document.getElementById('tab-queue-modal').classList.add('active');
  }

  /** Points the cart at an existing tab; the next Pay Now is another round. */
  addToTab(table) {
    const tab = (this.openTabs || []).find((entry) => tabKey(entry.table) === tabKey(table));
    this.activeTable = table;
    this.activeTabId = tab?.id || null;
    this.persistDraft();
    this.renderOpenTabs();
    showNotification(
      `Adding a round to Table ${table}. KES ${((tab?.dueMinor || 0) / 100).toFixed(2)} already open on this tab.`,
      'info'
    );
  }

  clearActiveTab() {
    this.tabOnly = false;
    this.activeTable = null;
    this.activeTabId = null;
    this.persistDraft();
    this.renderOpenTabs();
  }

  /**
   * The tab this round belongs to, opening one if the table has none.
   *
   * A tab is only ever closed by somebody, so a table with one already open
   * keeps it and the round joins on. That is what makes the nine o'clock beer
   * and the midnight round one bill.
   */
  /**
   * Refuses to open a second tab under a name another till is already running.
   * Runs before the local write transaction: a network read inside a Dexie
   * transaction would let it auto-commit. Offline we cannot know, so the check
   * only refuses what it can see.
   */
  async assertTabNameFree(tableNo) {
    const table = String(tableNo || '').trim();
    if (!table) return;
    // Shared sales outlive the advisory open_orders snapshot. Refresh those
    // before deciding a missing local header means a new tab can be opened.
    let refreshError;
    if (firebaseConfigured) {
      try { await pullSales(undefined, undefined, { tableNumber: table, branchId: state.currentBranch?.id }); }
      catch (error) { refreshError = error; }
    }
    const matching = (await readOpenTabs(state.currentBranch?.id)).filter(tab => tabKey(tab.table) === tabKey(table));
    const owing = matching.filter(tab => tab.dueMinor > 0);
    if (owing.length > 1) throw new Error('This table has multiple unpaid bills. Consolidate them before adding another round.');
    const tab = owing[0] || matching[0];
    if (tab) {
      if (tab.recoveryRequired) {
        if (tab.id.startsWith('recovered-')) throw new Error('This unpaid order has no tab identity. Repair its tab before adding items.');
        await db.tabs.put({
          ...newTab({ id: tab.id, tenantId: state.currentTenant?.id, branchId: state.currentBranch?.id,
            tableNo: tab.table, staffId: tab.opened_by, now: tab.opened_at }),
          order_no: tab.order_no,
        });
      }
      this.activeTabId = tab.id;
      return;
    }
    if (refreshError) throw refreshError;
    const elsewhere = (await pullOpenOrders(DEVICE_ID))
      .find((order) => order.branchId === state.currentBranch?.id && order.paymentStatus === 'unpaid'
        && order.tableNumber && tabKey(order.tableNumber) === tabKey(table));
    if (elsewhere) {
      throw new Error(`Table ${elsewhere.tableNumber} has a round still uploading from another till. Wait for it to sync before adding items.`);
    }
  }

  async resolveTabForRound(tableNo, shiftId) {
    const table = String(tableNo || '').trim();
    if (!table) return null;

    const headers = await db.tabs.where('status').equals(OPEN).toArray();
    const selected = headers.find(tab => tab.id === this.activeTabId);
    const existing = openTabAt(selected ? [selected] : [], state.currentBranch?.id, table)
      || openTabAt(headers, state.currentBranch?.id, table);
    if (existing) return existing.id;


    const tab = newTab({
      id: crypto.randomUUID(),
      tenantId: state.currentTenant?.id,
      branchId: state.currentBranch?.id,
      tableNo: table,
      customerId: this.selectedCustomer?.id === WALK_IN_CUSTOMER_ID ? null : this.selectedCustomer?.id,
      staffId: state.currentUser?.id,
      shiftId,
      now: new Date().toISOString()
    });
    await db.tabs.add(tab);
    return tab.id;
  }

  /**
   * The two ways out of a cart that sits on a tab.
   *
   * "Add to Tab" saves the round and leaves it owed; "Pay Now" settles the
   * whole table, this cart included. Off a tab there is only Pay Now, exactly
   * as before.
   */
  renderTabActions() {
    const add = document.getElementById('till-add-to-tab-btn');
    const pay = document.getElementById('till-pay-now-btn');
    const note = document.getElementById('till-tab-due-note');
    if (!add || !pay || !note) return;

    const tab = (this.openTabs || []).find((entry) => tabKey(entry.table) === tabKey(this.activeTable));
    const dueMinor = tab?.dueMinor || 0;
    const onTab = Boolean(this.activeTable);

    add.classList.toggle('hidden', !onTab);
    add.disabled = this.cart.length === 0;

    // Only worth offering once there is something on the tab to correct.
    document.getElementById('till-review-tab-btn')?.classList.toggle('hidden', !(onTab && dueMinor > 0));

    // With rounds already owed, paying settles the night rather than the cart,
    // so the button says the number the customer is about to be asked for.
    const settlingTotal = dueMinor + Math.round((this.totals?.total || 0) * 100);
    pay.classList.toggle('hidden', Boolean(this.tabOnly && onTab));
    pay.innerText = onTab && dueMinor > 0
      ? `Settle Table ${this.activeTable} · KES ${(settlingTotal / 100).toFixed(2)}`
      : 'Print Receipt & Pay';
    // An empty cart can still settle a tab that already has rounds on it.
    if (onTab && dueMinor > 0) pay.disabled = false;

    note.classList.toggle('hidden', !(onTab && dueMinor > 0));
    note.innerText = onTab && dueMinor > 0
      ? `${tab.unpaidRounds.length} round${tab.unpaidRounds.length === 1 ? '' : 's'} already on this tab · KES ${(dueMinor / 100).toFixed(2)}`
      : '';
  }

  /** Stops renewing the lease; the order is no longer this till's to work. */
  releaseHeldLease() {
    clearInterval(this.heldLease);
    this.heldLease = null;
  }

  /** The single unpaid row a just-registered order carries. */
  buildPendingPaymentRecords() {
    return [{
      id: crypto.randomUUID(),
      method: 'PROFORMA',
      amount: Number(this.totals.total.toFixed(2)),
      reference: '',
      provider_txn_id: '',
      verified: 0,
      metadata: undefined,
      received_at: new Date().toISOString()
    }];
  }

  async finalizeInvoice() {
    if (this.pendingRegistration) await this.pendingRegistration;
    if (firebaseConfigured && !this.activeTabId && !this.pendingSale) {
      showNotification('Save this order to Pending before taking payment. Close checkout and retry Pay Now.', 'error');
      return false;
    }
    if (this.finalizingInvoice) return false;
    if (!this.selectedPaymentMethod) {
      showNotification('Choose a payment method first.', 'warning');
      return false;
    }
    if (this.selectedPaymentMethod === 'MPESA_CODE' && !firebaseConfigured) {
      showNotification('Reconnect before recording M-Pesa payment.', 'error');
      return false;
    }
    if (this.selectedPaymentMethod === 'MPESA_CODE'
      && !mpesaConfirmationCode(document.getElementById('pay-mpesa-code')?.value)) {
      showNotification('Enter the M-Pesa confirmation code from the customer’s message.', 'error');
      return false;
    }
    this.finalizingInvoice = true;
    try {
      // Registered at Pay Now, or already sitting on a tab as rounds: either
      // way the tender settles what exists rather than writing it again.
      if (this.pendingSale || this.activeTabId) return await this.settlePendingOrder();

      const registered = await this.registerOrder(this.buildPaymentRecords(), { pending: false });
      if (!registered) return false;
      this.completeRegisteredOrder(registered);
      return true;
    } finally {
      this.finalizingInvoice = false;
    }
  }

  /**
   * Writes a sale, its lines, its stock depletion and its tender rows.
   *
   * `pending` withholds the customer's credit and loyalty movement: an order
   * that nobody has paid for yet must not move a debtor balance, and settling
   * it applies both once the money is real.
   */
  async registerOrder(paymentRecords, { pending }) {
    if (!this.cart.some(item => !['prod-staff-discount', 'prod-table-service'].includes(item.product.id))) {
      showNotification('Add an item before saving a round. A discount or service charge cannot be a round on its own.', 'warning');
      return false;
    }
    // Every sale this till makes passes here; createSale refuses it as well.
    if (!canSell(state.currentUser?.role)) {
      showNotification(SELLING_OFF, 'error');
      return false;
    }
    if (this.recoveredPaymentAttempt) {
      showNotification('Reconcile the restored draft’s earlier M-Pesa attempt before registering it again.', 'warning');
      return false;
    }
    const saleId = crypto.randomUUID();
    const invoiceNo = `INV-BH001-${new Date().getTime().toString().slice(-6)}`;
    // The STK attempt and the sale share one stable identity. If the response
    // is lost and registration is retried, the backend replays the same sale
    // rather than booking the payment and stock twice.
    const saleUuid = this.selectedPaymentMethod === 'MPESA' && !pending
      ? this.mpesaAttempt?.idempotencyKey
      : crypto.randomUUID();
    const buyerPin = document.getElementById('cart-buyer-pin').value || '';
    // A round joins the tab the cart is pointed at; the checkout field is what
    // opens a new one.
    const tableNo = this.activeTable || document.getElementById('checkout-table-number').value || '';

    // Prefer the trusted shift opened at sign-in. The old check looked only in
    // Dexie, so a valid cloud shift was rejected after yesterday's local row
    // had been closed. Constrain the offline fallback to this person and
    // branch; another waiter's open row must never author this sale.
    const ownBranchShifts = await db.shifts.where('user_id').equals(state.currentUser?.id)
      .filter((shift) => shift.branch_id === state.currentBranch?.id)
      .toArray();
    let openShift = ownBranchShifts.find((shift) => shift.status === 'OPEN') || null;
    const cloudRow = state.cloudShiftId
      ? ownBranchShifts.find((shift) => shift.id === state.cloudShiftId)
      : null;
    // A locally cashed-up shift stays closed even if the backend id remains in
    // memory. It is reopened only through Shift Management.
    let shiftId = openShift?.id
      || (state.cloudShiftId && cloudRow?.status !== 'CLOSED' ? state.cloudShiftId : null);

    // Cloud setup is deliberately non-blocking at sign-in. A very fast Pay Now
    // can reach here before it finishes, so idempotently open the same shift
    // rather than reporting that nobody is on duty.
    if (!shiftId && ownBranchShifts.length === 0
      && firebaseConfigured && state.syncManager?.connectionStatus !== 'OFFLINE') {
      try {
        const cloudShift = await openCloudShift(state.currentBranch?.id);
        shiftId = cloudShift?.shiftId || null;
        state.cloudShiftId = shiftId;
        if (shiftId) {
          openShift = {
            id: shiftId,
            branch_id: state.currentBranch.id,
            user_id: state.currentUser.id,
            opening_float: Number(cloudShift?.openingFloatMinor || 0) / 100,
            status: 'OPEN',
            opened_at: cloudShift?.openedAt || new Date().toISOString(),
            closed_at: null,
          };
          await db.shifts.put(openShift);
        }
      } catch {
        // A genuinely offline till may still use the local shift above.
      }
    }

    if (!shiftId) {
      showNotification('No open waiter/waitress shift found. Open shift before completing sales.', 'error');
      return false;
    }

    const hasKdsItems = this.cart.some(item => !item.product.is_service);
    // A sale is never booked against an M-Pesa payment the backend has not
    // confirmed. Cash and credit are settled at the counter; M-Pesa is not.
    // A pending order carries no tender at all, so there is nothing to prove.
    if (
      !pending
      && this.selectedPaymentMethod === 'MPESA'
      && !this.mpesaProofMatchesCurrentCart()
    ) {
      this.invalidateMpesaAttempt();
      showNotification('M-Pesa proof no longer matches this cart. Run a new STK push and wait for confirmation.', 'error');
      return false;
    }

    // Opened here rather than when the table was typed, so a table tapped and
    // then abandoned does not leave an empty tab on the floor.
    const recorded = recordedSaleTotals(this.totals);
    const saleRecord = {
      id: saleId,
      tenant_id: state.currentTenant.id,
      branch_id: state.currentBranch.id,
      device_id: DEVICE_ID,
      // Online sales must use the deterministic shift opened by the trusted
      // backend. A local id remains the offline fallback for queued cash sales.
      shift_id: shiftId,
      invoice_no: invoiceNo,
      sale_uuid: saleUuid,
      draft_id: this.cartDraftId || null,
      // Who rang it up. Absent here - and only here, of the three paths that
      // write a sale - every order registered at Pay Now was unattributable on
      // the board ("Nobody has handled this yet") and was refused by createSale,
      // which requires a staffId. That is why they queued forever and no other
      // till, the owner's included, ever saw them.
      created_by: state.currentUser?.id || null,
      staff_id: state.currentUser?.id || null,
      customer_id: this.selectedCustomer.id || null,
      table_no: tableNo,
      // What ties this round to the nine o'clock one at the same table.
      tab_id: null,
      buyer_pin: buyerPin,
      // Recorded so that subtotal - discount is exactly what was charged.
      subtotal: recorded.subtotal,
      discount: recorded.discount,
      tax_total: this.totals.tax,
      grand_total: recorded.grandTotal,
      // The board reads this to tell an order awaiting payment from a settled
      // one. The lease beside it keeps the order on this till while the
      // cashier is still working it; once it lapses the order transmits as
      // the receivable it is, and any till can settle or void it.
      status: pending ? 'PENDING_PAYMENT' : 'COMPLETED',
      held_until: pending ? new Date(Date.now() + HELD_ORDER_MS).toISOString() : null,
      kds_status: hasKdsItems ? 'PENDING' : 'SERVED',
      sold_at: new Date().toISOString(),
      synced_at: null,
      fiscal_status: 'QUEUED',
      etims_solution: 'OSCU'
    };

    // Rows are built before the sale id exists, so they are stamped with it here.
    for (const record of paymentRecords) record.sale_id = saleId;
    // The receipt prints one settlement line; a split shows its M-Pesa half.
    const paymentRecord = paymentRecords[paymentRecords.length - 1];

    await this.assertTabNameFree(tableNo);
    // Perform database operations within atomic transactions
    const registered = await db.transaction('rw', [db.tabs, db.sales, db.sale_lines, db.payments, db.stock_movements, db.audit_log, db.customers], async () => {
      // A previous browser transaction may have committed before returning an
      // error. Reuse its M-Pesa sale under this same write lock on retry.
      if (!pending && this.selectedPaymentMethod === 'MPESA') {
        const existing = await db.sales.where('sale_uuid').equals(saleUuid).first();
        if (existing) {
          const tender = await db.payments.where('sale_id').equals(existing.id).filter(row => row.method === 'MPESA').first();
          if (existing.tenant_id !== state.currentTenant.id || existing.grand_total !== saleRecord.grand_total || tender?.reference !== this.mpesaRef) {
            throw new Error('This M-Pesa payment already belongs to another recorded order. Review it in Orders.');
          }
          return { saleId: existing.id, saleRecord: existing, paymentRecord: tender, replayed: true };
        }
      }
      // Resolve/create the tab under the same lock as its first round. A
      // concurrent settlement cannot close its header between these writes,
      // and a failed sale cannot leave a header without the order behind it.
      saleRecord.tab_id = await this.resolveTabForRound(tableNo, shiftId);
      // 1. Write Sale
      await db.sales.add(saleRecord);

      // 2. Write Sale Lines & Stock Movements in bulk for single-frame commit speed
      const saleLinesBatch = [];
      const stockMovementsBatch = [];
      const createdAtIso = new Date().toISOString();

      for (const item of this.cart) {
        const rate = saleLineRate(item.product, this.totals, this.selectedCustomer.price_tier);
        const gross = rate * item.qty;
        const discount = Math.min(gross, Math.max(0, Number(item.discount_amount) || 0));
        const total = gross - discount;

        let taxRate = 0.16;
        if (item.product.tax_code === 'B') taxRate = 0.08;
        else if (item.product.tax_code === 'C' || item.product.tax_code === 'E') taxRate = 0.00;

        saleLinesBatch.push({
          id: crypto.randomUUID(),
          sale_id: saleId,
          product_id: item.product.id,
          qty: item.qty,
          unit_price: rate,
          discount,
          tax_code: item.product.tax_code,
          tax_rate: taxRate,
          tax_amount: (total - (total / (1 + taxRate))),
          line_total: total,
          unit_cost_at_sale: item.product.cost_price
        });

        stockMovementsBatch.push({
          id: crypto.randomUUID(),
          tenant_id: state.currentTenant.id,
          branch_id: state.currentBranch.id,
          product_id: item.product.id,
          batch_id: item.batch ? item.batch.id : null,
          type: 'SALE',
          location: 'HOUSE',
          qty: -item.qty,
          unit_cost: item.product.cost_price,
          ref_type: 'SALE',
          ref_id: saleId,
          reason: 'Customer Checkout POS',
          created_by: state.currentUser.id,
          created_at: createdAtIso
        });
      }

      if (saleLinesBatch.length) await db.sale_lines.bulkAdd(saleLinesBatch);
      if (stockMovementsBatch.length) await db.stock_movements.bulkAdd(stockMovementsBatch);

      // 3. Write payment records in bulk
      if (paymentRecords.length) await db.payments.bulkAdd(paymentRecords);

      // 4. Update Customer Loyalty & Credit Balance. An order nobody has paid
      //    for moves neither; settling it applies both once the money is real.
      if (!pending && this.selectedCustomer && this.selectedCustomer.id !== WALK_IN_CUSTOMER_ID) {
        const customer = await db.customers.get(this.selectedCustomer.id);
        if (customer) {
          const updates = {};
          
          if (isReceivable(this.selectedPaymentMethod)) {
            updates.credit_balance = (customer.credit_balance || 0) + this.totals.total;
          }

          const pointsEarned = Math.floor(this.totals.total / 100);
          updates.loyalty_points = Math.max(0, (customer.loyalty_points || 0) + pointsEarned - (this.redeemedPoints || 0));

          await db.customers.update(customer.id, updates);

          // Sync local customer reference
          this.selectedCustomer.credit_balance = updates.credit_balance !== undefined ? updates.credit_balance : customer.credit_balance;
          this.selectedCustomer.loyalty_points = updates.loyalty_points;
        }
      }

      // 5. Log audit session
      await logAuditEvent(
        state.currentTenant.id,
        state.currentUser.id,
        pending ? 'SALE_REGISTERED' : 'SALE_CHECKOUT',
        'SALE',
        saleId
      );
      return { saleId, saleRecord, paymentRecord };
    });

    if (registered.replayed) return registered;

    // Update cached in-memory houseStockByProduct and trigger low-stock alert in O(1) without blocking I/O
    try {
      for (const item of this.cart) {
        if (!item.product.is_service) {
          const pid = String(item.product.id);
          const prev = this.houseStockByProduct?.get(pid) ?? 0;
          const remainingStock = prev - item.qty;
          this.houseStockByProduct?.set(pid, remainingStock);
          if (remainingStock <= 20) {
            showNotification(`Low Stock Alert: ${item.product.name} is down to ${remainingStock} in House! Please request more.`, 'warning');
          }
        }
      }
    } catch {}

    return registered;
  }

  /** Closes the checkout, prints, and drains the outbox. */
  completeRegisteredOrder({ saleRecord, paymentRecord, settledRoundIds }) {
    // The round just landed, so the tab's running total is now out of date.
    // A tab whose rounds are all paid closes itself here; one still owing
    // stays open until somebody deals with it.
    void this.settleEmptyTab(saleRecord.tab_id)
      .then(() => this.loadOpenTabs())
      .catch(() => {});
    // Triggers background sync outbox process immediately if online. The drain
    // refreshes the House balances once the server has taken the sale, so the
    // grid is redrawn after it and not beside it.
    void Promise.resolve()
      .then(() => state.syncManager.syncOutbox())
      .then(() => this.container.isConnected && this.loadProducts())
      .catch(() => {});

    document.getElementById('payment-modal').classList.remove('active');
    // Receipt preparation and printing are downstream actions. Neither can
    // roll back or decide whether this order was registered.
    void this.openPrintedReceipt(saleRecord, paymentRecord, settledRoundIds).catch(() => {
      showNotification('Order registered, but the receipt preview could not be opened.', 'warning');
    });
  }

  /**
   * Clears the order registered at Pay Now with the tender that actually paid.
   *
   * The receivable row is stamped rather than deleted - the order really did
   * sit unpaid, however briefly - and the tender that cleared it is its own
   * row. `tenderTotals` skips a settled receivable, so the drawer counts the
   * money once and only under the tender that arrived.
   */
  /**
   * The rounds this payment is clearing.
   *
   * On a tab that is every round nobody has paid for - the beer, the food, the
   * liquor - so one payment closes the night rather than four. Off a tab it is
   * just the order that was registered at Pay Now.
   */
  async roundsBeingSettled() {
    const own = this.pendingSale ? [this.pendingSale.saleId] : [];
    if (!this.activeTabId && !this.activeTable) return own;

    const norm = (val) => String(val ?? '').trim().toLowerCase().replace(/\s+/g, ' ').replace(/^table\s*/, '');
    const activeNorm = norm(this.activeTable);
    const byTab = this.activeTabId ? await db.sales.where('tab_id').equals(this.activeTabId).toArray() : [];
    const byTable = (activeNorm && typeof db.sales.filter === 'function')
      ? await db.sales.filter((sale) => norm(sale.table_no) === activeNorm).toArray()
      : [];
    const rounds = [...new Map([...byTab, ...byTable].map((s) => [s.id, s])).values()];
    if (!rounds.length) return own;

    const ledger = await db.payments.where('sale_id').anyOf(rounds.map(sale => sale.id)).toArray();
    const bySale = new Map();
    for (const row of ledger) {
      bySale.set(row.sale_id, [...(bySale.get(row.sale_id) || []), row]);
    }

    const unpaid = rounds
      .filter((sale) => !sale.proforma_id && sale.status !== 'VOIDED'
        && saleAsOrder(sale, { payments: bySale.get(sale.id) }).paymentStatus === 'unpaid')
      .map((sale) => sale.id);

    const ids = [...new Set([...own, ...unpaid])];
    const selected = (await db.sales.bulkGet(ids)).filter(Boolean);
    return (await billableCheckoutRounds(selected, db)).map(sale => sale.id);
  }

  async settlePendingByCode() {
    let receipt;
    try { receipt = manualReceipt(document.getElementById('pay-mpesa-code').value, document.getElementById('pay-mpesa-amount').value); }
    catch (error) { showNotification(error.message, 'error'); return false; }
    if (!firebaseConfigured) { showNotification('Reconnect before recording M-Pesa payment.', 'error'); return false; }
    const { reference, receiptAmountMinor } = receipt;
    const ids = await this.roundsBeingSettled();
    const rounds = [];
    for (const id of ids) rounds.push(await state.syncManager.publishSale(id));
    this.settlementRequestId ||= crypto.randomUUID();
    const claim = await claimSalePayment({ saleUuids: rounds.map(round => round.sale_uuid),
      checkoutId: this.settlementRequestId, deviceId: DEVICE_ID, method: 'mpesa' });
    this.receiptCheckoutRoundIds ||= ids;
    this.receiptCheckoutTotalMinor ||= claim.dueMinor;
    let availableMinor = Infinity, appliedMinor = 0, last;
    for (const round of rounds) {
      if (availableMinor <= 0) break;
      const ledger = await db.payments.where('sale_id').equals(round.id).toArray();
      const due = ledger.filter(p => isReceivable(p.method) && !p.settled_at)
        .reduce((sum, p) => sum + toMinor(p.amount), 0);
      if (!due) continue;
      last = await settleSale({ saleUuid: round.sale_uuid, checkoutId: this.settlementRequestId,
        requestId: `${this.settlementRequestId}-${reference}-${round.sale_uuid}`, method: 'mpesa', reference,
        receiptAmountMinor });
      await recordReceiptSettlement(round, last);
      appliedMinor += last.settledMinor;
      availableMinor = last.availableMinor;
    }
    const remainingMinor = claim.dueMinor - appliedMinor;
    this.releaseHeldLease();
    if (remainingMinor > 0) {
      this.totals.total = remainingMinor / 100;
      document.getElementById('checkout-due-amount').innerText = `KES ${(remainingMinor / 100).toFixed(2)}`;
      document.getElementById('pay-mpesa-code').value = '';
      document.getElementById('pay-mpesa-amount').value = '';
      showNotification(`Applied KES ${(appliedMinor / 100).toFixed(2)}. KES ${(remainingMinor / 100).toFixed(2)} still due. Enter the next code.`, 'info');
      return false;
    }
    const printed = this.pendingSale?.saleRecord || await db.sales.get(ids[ids.length - 1]);
    const allRoundIds = this.receiptCheckoutRoundIds;
    // Use the whole paid bill on the printed receipt after several codes.
    this.totals.total = this.receiptCheckoutTotalMinor / 100;
    if (this.selectedCustomer?.id && this.selectedCustomer.id !== WALK_IN_CUSTOMER_ID) {
      const customer = await db.customers.get(this.selectedCustomer.id);
      if (customer) {
        const loyalty = Math.max(0, (customer.loyalty_points || 0) + Math.floor(this.totals.total / 100) - (this.redeemedPoints || 0));
        await db.customers.update(customer.id, { loyalty_points: loyalty });
        this.selectedCustomer.loyalty_points = loyalty;
      }
    }
    const freed = await freeSettledTab(this.activeTabId);
    this.pendingSale = null;
    if (freed) this.clearActiveTab();
    this.completeRegisteredOrder({ saleRecord: { ...printed, status: 'COMPLETED' },
      paymentRecord: { method: 'MPESA', reference, amount: last.settledMinor / 100 }, settledRoundIds: allRoundIds });
    this.receiptCheckoutRoundIds = null;
    this.receiptCheckoutTotalMinor = null;
    return true;
  }

  async settlePendingOrder() {
    if (this.selectedPaymentMethod === 'MPESA_CODE') return await this.settlePendingByCode();
    // Settling a tab there is no cart for: the rounds are already written, so
    // this payment has no order of its own to anchor to.
    const { saleId, saleRecord } = this.pendingSale || {};
    this.releaseHeldLease();

    if (
      this.selectedPaymentMethod === 'MPESA'
      && !this.mpesaProofMatchesCurrentCart()
    ) {
      this.invalidateMpesaAttempt();
      showNotification('M-Pesa proof no longer matches this cart. Run a new STK push and wait for confirmation.', 'error');
      return false;
    }

    const settledAt = new Date().toISOString();
    const paymentRecords = this.buildPaymentRecords(saleId);
    for (const record of paymentRecords) record.sale_id = saleId;
    const paymentRecord = paymentRecords[paymentRecords.length - 1];
    // Every round this payment clears. On a tab that is the whole night.
    const settling = await this.roundsBeingSettled();
    const serverSettlements = new Map();
    if (!isReceivable(this.selectedPaymentMethod)) {
      this.settlementRequestId ||= crypto.randomUUID();
      if (firebaseConfigured) {
        const rounds = [];
        for (const id of settling) rounds.push(await state.syncManager.publishSale(id));
        await claimSalePayment({
          saleUuids: rounds.map(round => round.sale_uuid), checkoutId: this.settlementRequestId,
          deviceId: DEVICE_ID, method: mapPaymentMethod(this.selectedPaymentMethod),
          ...(this.selectedPaymentMethod === 'MPESA' ? { stkKey: this.mpesaAttempt.idempotencyKey } : {}),
        });
      }
      for (let index = 0; index < settling.length; index++) {
        let round = await db.sales.get(settling[index]);
        if (firebaseConfigured && round && !round.synced_at) round = await state.syncManager.publishSale(round.id);
        if (!round?.synced_at) continue;
        const result = await settleSale({
          saleUuid: round.sale_uuid, requestId: `${this.settlementRequestId}-${index}`,
          checkoutId: this.settlementRequestId,
          method: mapPaymentMethod(paymentRecord.method), reference: paymentRecord.reference || '',
          ...(this.selectedPaymentMethod === 'MPESA' ? { attemptId: this.mpesaAttempt.attemptId } : {}),
        });
        serverSettlements.set(round.id, result);
      }
    }

    await db.transaction('rw', [db.sales, db.payments, db.audit_log, db.customers, db.tabs], async () => {
      // A tender that is itself a receivable - proforma or credit - settles
      // nothing. The order stays owed under the row it already has, and
      // stamping that row would show it paid with nothing having paid it.
      if (!isReceivable(this.selectedPaymentMethod)) {
        for (const roundId of settling) {
          const settled = serverSettlements.get(roundId);
          if (settled) {
            for (const row of await db.payments.where('sale_id').equals(roundId).toArray()) {
              if (isReceivable(row.method) && !row.settled_at) await db.payments.update(row.id, { settled_at: settledAt, settled_method: this.selectedPaymentMethod, settled_reference: settled.reference });
            }
            await db.payments.put({ ...paymentRecord, id: settled.paymentId, sale_id: roundId, method: String(settled.method).toUpperCase(),
              amount: settled.settledMinor / 100, reference: settled.reference || '', verified: settled.verified ? 1 : 0 });
            continue;
          }
          for (const row of await db.payments.where('sale_id').equals(roundId).toArray()) {
            if (!isReceivable(row.method) || row.settled_at) continue;
            await db.payments.update(row.id, {
              settled_at: settledAt,
              settled_method: this.selectedPaymentMethod,
              settled_reference: paymentRecord.reference || null
            });
            // Each round carries the tender that cleared it, for its own
            // amount, so the rounds still sum to the money actually taken.
            if (roundId !== saleId) {
              await db.payments.add({
                ...paymentRecord,
                id: crypto.randomUUID(),
                sale_id: roundId,
                amount: Number(row.amount)
              });
            }
          }
        }
        // Only when this payment had a cart of its own behind it.
        if (saleId && !serverSettlements.has(saleId)) for (const record of paymentRecords) await db.payments.add(record);
      }

      // Settled, so the lease is released and the round transmits once, paid.
      for (const roundId of settling) {
        await db.sales.update(roundId, { status: 'COMPLETED', held_until: null });
      }

      if (this.selectedCustomer && this.selectedCustomer.id !== WALK_IN_CUSTOMER_ID) {
        const customer = await db.customers.get(this.selectedCustomer.id);
        if (customer) {
          const updates = {};
          if (isReceivable(this.selectedPaymentMethod)) {
            updates.credit_balance = (customer.credit_balance || 0) + this.totals.total;
          }
          const pointsEarned = Math.floor(this.totals.total / 100);
          updates.loyalty_points = Math.max(0, (customer.loyalty_points || 0) + pointsEarned - (this.redeemedPoints || 0));
          await db.customers.update(customer.id, updates);
          this.selectedCustomer.credit_balance = updates.credit_balance !== undefined
            ? updates.credit_balance
            : customer.credit_balance;
          this.selectedCustomer.loyalty_points = updates.loyalty_points;
        }
      }

      // Paying the last round is what closes the tab, which is what lets the
      // next customer at that table start a bill of their own.

      await logAuditEvent(
        state.currentTenant.id,
        state.currentUser.id,
        'SALE_CHECKOUT',
        'SALE',
        saleId || settling[settling.length - 1] || null
      );
    });

    const settledTable = this.activeTable;
    const freedTable = this.activeTabId && !isReceivable(this.selectedPaymentMethod)
      ? await freeSettledTab(this.activeTabId) : null;
    this.pendingSale = null;
    if (freedTable) this.clearActiveTab();

    // A tab settled from an empty cart has no order of its own, so the receipt
    // shows the last round that was paid.
    const printed = saleRecord || await db.sales.get(settling[settling.length - 1]);
    this.completeRegisteredOrder({
      saleRecord: { ...printed, status: 'COMPLETED' },
      paymentRecord,
      settledRoundIds: settling
    });
    if (settledTable && settling.length > 1) {
      showNotification(`Table ${settledTable} settled — ${settling.length} rounds closed.`, 'success');
    }
    return true;
  }

  /**
   * Takes back an order registered at Pay Now.
   *
   * The stock it depleted is put back and the order is kept as VOIDED rather
   * than deleted: a mis-tap that moved stock is exactly the thing somebody
   * will want to find later. Published orders are withdrawn on the server
   * before their local state is changed.
   */
  async voidPendingOrder(reason) {
    if (!this.pendingSale) return;
    const { saleId, saleRecord } = this.pendingSale;
    this.pendingSale = null;
    this.releaseHeldLease();

    // The order may already have reached the server, where the stock it took
    // was deducted from balances this device does not own. Withdrawing it
    // there first means a failure leaves the order standing in both places
    // rather than voided here and live everywhere else.
    const synced = (await db.sales.get(saleId))?.synced_at;
    if (synced) {
      await voidSale({ saleUuid: saleRecord.sale_uuid, reason });
      // The stock came back on the server, so the till's copy of the balances
      // is now one void behind what is actually on the shelf.
      await pullStock().catch(() => {});
      if (this.container.isConnected) await this.loadProducts();
    }

    await db.transaction('rw', [db.sales, db.payments, db.stock_movements, db.audit_log], async () => {
      await db.sales.update(saleId, { status: 'VOIDED', voided_at: new Date().toISOString() });
      for (const row of await db.payments.where('sale_id').equals(saleId).toArray()) {
        await db.payments.delete(row.id);
      }
      // Reversed rather than deleted, so the movement ledger still shows what
      // happened and stock arrives back at the same number it left.
      for (const movement of await db.stock_movements.where('ref_id').equals(saleId).toArray()) {
        if (movement.type !== 'SALE') continue;
        await db.stock_movements.add({
          ...movement,
          id: crypto.randomUUID(),
          type: 'SALE_VOID',
          qty: -movement.qty,
          reason: `Voided: ${reason}`,
          created_by: state.currentUser.id,
          created_at: new Date().toISOString()
        });
      }
      await logAuditEvent(
        state.currentTenant.id,
        state.currentUser.id,
        'SALE_VOIDED',
        'SALE',
        saleId,
        null,
        JSON.stringify({ reason })
      );
    });
  }

  async openPrintedReceipt(sale, payment, settledRoundIds) {
    const selectCustomerName = this.selectedCustomer.name;
    // A tab is billed as one document: every round the payment just cleared,
    // under the tab's order number, because the table asked for their bill and
    // not for four of them.
    const lines = settledRoundIds?.length
      ? await db.sale_lines.where('sale_id').anyOf(settledRoundIds).toArray()
      : await db.sale_lines.where('sale_id').equals(sale.id).toArray();
    const tab = sale.tab_id ? await db.tabs.get(sale.tab_id) : null;
    
    // Load products names mapping from in-memory catalogue cache (avoid full IndexedDB scan on checkout)
    const productsList = this.catalogueProducts?.length ? this.catalogueProducts : await db.products.toArray();
    const prodMap = new Map(productsList.map(p => [p.id, p]));

    // Construct receipt mock view
    const paperView = document.getElementById('receipt-paper-view');

    // The bill an ETR would cover: every round this payment settled.
    this.lastReceiptSaleIds = settledRoundIds?.length ? settledRoundIds : [sale.id];
    const etr = await etrFor(sale.id);

    // The print station is a different device and never receives this sale, so
    // the receipt's own values travel with the job.
    this.lastReceiptPayload = {
      tenantName: state.currentTenant.trading_name,
      branchName: state.currentBranch.name,
      kraPin: state.currentTenant.kra_pin,
      branchCode: state.currentBranch.etims_bhf_id,
      phone: state.currentTenant.phone,
      // The table's bill is known by the tab's order number; the round's own
      // invoice number is the fiscal document behind it.
      invoiceNo: tab?.order_no || sale.invoice_no,
      fiscalInvoiceNo: tab ? sale.invoice_no : null,
      soldAt: new Date(sale.sold_at).toLocaleString(),
      cashierName: state.currentUser.name,
      customerName: selectCustomerName,
      // The runner at the counter matches paper to a table, not to an invoice
      // number, so the table travels with the job and is searchable there.
      tableNo: sale.table_no || null,
      buyerPin: sale.buyer_pin || null,
      lines: lines.map((line) => ({
        name: line.product_name || prodMap.get(line.product_id)?.name || 'Unknown Item',
        qty: line.qty,
        unitPrice: line.unit_price,
        lineTotal: line.line_total,
        taxCode: line.tax_code
      })),
      // A tab's bill totals every round it just settled, not the last one.
      // An ordinary sale keeps its own recorded figures untouched.
      ...(settledRoundIds?.length > 1
        ? { subtotal: this.totals.subtotal, taxTotal: this.totals.tax, grandTotal: this.totals.total }
        : { subtotal: sale.subtotal, taxTotal: sale.tax_total, grandTotal: sale.grand_total }),
      paymentMethod: payment.method,
      paymentReference: payment.reference || null,
      // A proforma is a demand for money, not proof of it. The paper has to
      // say so, or it gets filed as a paid receipt at both ends.
      unpaid: isReceivable(payment.method),
      etr
    };

    // The receipt on screen is rendered by the same function the print
    // station uses, so what the cashier reads is exactly what comes out of
    // the printer. A second copy of this layout here had already drifted:
    // different labels, an eTIMS block the paper never carried.
    paperView.innerHTML = renderReceiptHtml(this.lastReceiptPayload);

    // An ETR is KRA's record of money received, so it is offered once the bill is paid.
    document.getElementById('receipt-etr-row').style.display =
      this.lastReceiptPayload.unpaid || etr ? 'none' : 'flex';
    document.getElementById('receipt-etr-pin').value = sale.buyer_pin || '';

    document.getElementById('receipt-modal').classList.add('active');
  }

  /** Has KRA sign the bill on screen, then shows the ETR receipt in its place. */
  async generateReceiptEtr() {
    const button = document.getElementById('receipt-etr-btn');
    if (!this.lastReceiptSaleIds || button.disabled) return;
    button.disabled = true;
    button.textContent = 'Generating…';
    try {
      const etr = await generateEtr(this.lastReceiptSaleIds, document.getElementById('receipt-etr-pin').value);
      this.lastReceiptPayload = { ...this.lastReceiptPayload, etr };
      document.getElementById('receipt-paper-view').innerHTML = renderReceiptHtml(this.lastReceiptPayload);
      document.getElementById('receipt-etr-row').style.display = 'none';
      showNotification('ETR generated. Push it to the print queue for the customer.', 'success');
    } catch (error) {
      showNotification(error?.message || 'The ETR could not be generated.', 'error');
    } finally {
      button.disabled = false;
      button.textContent = 'Generate ETR';
    }
  }

  /**
   * Hands the receipt to the counter station. Never claims success on its own:
   * if the job did not reach the queue the cashier is told to print at the
   * counter instead, because nothing else will produce that paper.
   */
  async sendReceiptToCounter() {
    if (!this.lastReceiptPayload) {
      showNotification('There is no receipt to print yet.', 'error');
      return;
    }

    const paper = document.getElementById('receipt-paper-view');
    const branchId = state.currentBranch?.id;
    let jobId = null;
    let stationOnline = false;
    try {
      [jobId, stationOnline] = await Promise.all([
        enqueuePrintJob({
          branchId,
          receipt: this.lastReceiptPayload,
          widthClass: paper?.className === 'receipt-paper-58'
            ? 'receipt-paper-58'
            : 'receipt-paper-80'
        }),
        isStationOnline(branchId)
      ]);
    } catch {
      jobId = null;
      stationOnline = false;
    }

    // If no remote print station took the job, trigger direct thermal/browser print
    if (!jobId || !stationOnline) {
      if (typeof window !== 'undefined' && typeof window.print === 'function') {
        window.print();
      }
    }

    // Printing the receipt completes the transaction in the local ledger
    const now = new Date().toISOString();
    const saleIds = this.lastReceiptSaleIds?.length ? this.lastReceiptSaleIds : [];
    if (saleIds.length && !this.lastReceiptPayload.unpaid) {
      try {
        for (const id of saleIds) {
          const sale = await db.sales.get(id);
          if (sale) {
            await db.sales.update(id, {
              status: 'COMPLETED',
              kds_status: 'SERVED',
              printed_at: now,
              held_until: null,
            });
            if (sale.tab_id) await freeSettledTab(sale.tab_id).catch(() => {});
          }
        }
      } catch {}
    }

    document.getElementById('receipt-modal')?.classList.remove('active');
    this.pendingSale = null;
    this.pendingRegistration = null;
    this.cartDraftId = null;
    this.clearCart();
    void this.loadOpenTabs().catch(() => {});
    void this.loadProducts().catch(() => {});

    showNotification(
      stationOnline && jobId
        ? 'Receipt sent to counter printer — transaction complete.'
        : 'Receipt printed — transaction complete.',
      'success'
    );
  }

  clearCart() {
    if (this.recoveredPaymentAttempt && !window.confirm('This restored draft has an earlier M-Pesa attempt. Check Financials first so the customer is not charged twice. Clear this draft only after reconciling that payment. Continue?')) return;
    this.recoveredPaymentAttempt = null;
    this.invalidateMpesaAttempt({ preservePricing: true });
    this.cart = [];
    this.selectedPaymentMethod = 'CASH';
    this.updateCartUI();
  }

  parkCurrentCart() {
    if (this.cart.length === 0) {
      showNotification('Cart is empty. Cannot park.', 'error');
      return;
    }
    
    const paymentAttemptKey = this.recoveredPaymentAttempt || this.mpesaAttempt?.idempotencyKey || null;
    this.invalidateMpesaAttempt();
    this.parkedCarts.push({
      id: crypto.randomUUID(),
      paymentAttemptKey,
      cart: [...this.cart],
      customer: this.selectedCustomer,
      timestamp: new Date().getTime()
    });

    this.cart = [];
    this.recoveredPaymentAttempt = null;
    showNotification('Current cart suspended/parked successfully.', 'success');
    
    document.getElementById('parked-count').innerText = this.parkedCarts.length;
    this.updateCartUI();
  }

  resumeParkedCart() {
    if (this.cart.length) {
      showNotification('Save or park the current cart before restoring another one.', 'warning');
      return;
    }
    if (this.parkedCarts.length === 0) {
      showNotification('No parked carts found.', 'error');
      return;
    }

    this.invalidateMpesaAttempt();
    const resumed = this.parkedCarts.pop();
    this.recoveredPaymentAttempt = resumed.paymentAttemptKey || null;
    this.cart = resumed.cart;
    this.selectedCustomer = resumed.customer;

    showNotification('Restored parked cart.', 'success');
    document.getElementById('parked-count').innerText = this.parkedCarts.length;
    this.updateCartUI();
  }
}
