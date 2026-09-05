import { db } from '../db/schema';
import { logAuditEvent, getHouseStock } from '../db/index';
import { state, showNotification } from '../context';
import { MpesaService } from '../services/mpesa';
import { DEVICE_ID } from '../services/firebase';
import {
  ensureMpesaAttempt,
  mpesaAttemptFingerprint,
  unavailableMpesaCapability
} from '../services/mpesa-state';
import { toMinor } from '../services/tender';
import { enqueuePrintJob, isStationOnline } from '../services/print-queue';

export class TillView {
  constructor(container) {
    this.container = container;
    this.cart = []; // Current cart items { product, qty, discount_amount, discount_percent, batch }
    this.parkedCarts = []; // Suspended carts
    this.selectedCustomer = null;
    this.mpesa = new MpesaService();
    this.selectedPaymentMethod = 'CASH'; // CASH, MPESA, CREDIT, SPLIT
    this.splitDetails = { cash: 0, mpesa: 0 };
    this.mpesaRef = null;
    // Only ever set from a backend-confirmed payment; gates finalizeInvoice.
    this.mpesaVerified = false;
    this.mpesaCapability = unavailableMpesaCapability();
    this.mpesaCapabilityRequest = 0;
    this.mpesaAttempt = null;
    this.mpesaConfirmedAmountMinor = null;
  }

  async load() {
    if (state.currentUser?.role === 'Supervisor') {
      this.container.innerHTML = `
        <div style="padding: 48px; text-align: center; color: var(--text-primary); max-width: 500px; margin: 100px auto; background: #140e08; border: 1px solid var(--border-color); border-radius: 16px; box-shadow: var(--glass-shadow); font-family: var(--font-main);">
          <span style="font-size: 60px;">🚫</span>
          <h2 style="margin: 24px 0 12px 0; font-weight: 800; color: #fff; font-size: 22px;">Sales Terminal Restricted</h2>
          <p style="color: var(--text-secondary); line-height: 1.6; font-size: 14px; margin-bottom: 24px;">Supervisors are restricted from performing till sales. Please log in with a Cashier, Bar Staff, Manager, or Owner account to register sales.</p>
        </div>
      `;
      return;
    }
    
    this.selectedCustomer = await db.customers.where('id').equals('cust-walkin').first();
    if (!this.selectedCustomer) {
      // Safety fallback to prevent app crashing if DB record is missing
      this.selectedCustomer = { id: 'cust-walkin', name: 'Walk-In Customer', price_tier: 'RETAIL' };
    }
    this.render();
    await this.loadProducts();
    await this.loadCustomerDropdown();
    this.updateCartUI();
  }

  render() {
    this.container.innerHTML = `
      <div class="till-grid">
        <!-- Products Column -->
        <div class="till-catalogue-col">
          <div class="till-search-bar">
            <div class="search-input-wrapper">
              <input type="text" id="till-search" placeholder="Search by name, SKU or barcode...">
            </div>
            <button class="barcode-scanner-btn" id="till-scan-sim">
              <span>📷</span> Simulate Barcode
            </button>
            <button class="sec-btn" id="till-park-btn">Park Cart</button>
            <button class="sec-btn" id="till-resume-btn">Resume Carts (<span id="parked-count">0</span>)</button>
          </div>
          
          <div class="cat-filters" id="cat-filters">
            <div class="filter-chip active" data-cat="all">All Items</div>
            <div class="filter-chip" data-cat="cat-beers">🍺 Beers & Ciders</div>
            <div class="filter-chip" data-cat="cat-spirits">🥃 Spirits & Wines</div>
            <div class="filter-chip" data-cat="cat-softdrinks">🥤 Soft Drinks</div>
            <div class="filter-chip" data-cat="cat-food">🍽️ Food & Meals</div>
            <div class="filter-chip" data-cat="cat-services">🧾 Services</div>
          </div>

          <div class="product-grid" id="till-prod-grid">
            <!-- Populated dynamically -->
          </div>
        </div>

        <!-- Cart Column -->
        <div class="till-cart-col">
          <div class="cart-header">
            <h3>Current Sale</h3>
            <span class="cart-count" id="cart-item-count">0 Items</span>
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
            <div class="customer-selector">
              <select id="cart-customer-select">
                <!-- Loaded dynamically -->
              </select>
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
            <button class="checkout-btn" id="till-pay-now-btn" disabled>Pay Now</button>
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
            <div class="checkout-payment-methods">
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
              <div class="payment-method-card" data-method="CREDIT">
                <span style="font-size:20px;">💳</span>
                <div>
                  <h4>On Account (Credit)</h4>
                  <p>Charge against debtor limits</p>
                </div>
              </div>
              <div class="payment-method-card" data-method="SPLIT" id="payment-method-split">
                <span style="font-size:20px;">⚖️</span>
                <div>
                  <h4>Split Payment</h4>
                  <p id="payment-method-split-note">Combine Cash and M-Pesa</p>
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
                <label style="font-size:11px;color:var(--text-secondary)">Table Number (Optional)</label>
                <input type="text" id="checkout-table-number" placeholder="e.g. 12 or Patio 3" style="width: 100%;">
              </div>

              <!-- Cash Input fields -->
              <div class="checkout-inputs" id="payment-inputs-cash">
                <label style="font-size:11px;color:var(--text-secondary)">Tendered Cash Amount</label>
                <input type="number" id="pay-cash-tendered" placeholder="Enter amount received...">
                <div class="summary-row" style="margin-top:8px;">
                  <span>Change Due:</span>
                  <span id="pay-cash-change" style="font-weight:700;color:var(--accent-green)">KES 0.00</span>
                </div>
              </div>

              <!-- M-Pesa Input fields -->
              <div class="checkout-inputs hidden" id="payment-inputs-mpesa">
                <label style="font-size:11px;color:var(--text-secondary)">M-Pesa Mobile Number</label>
                <input type="text" id="pay-mpesa-phone" placeholder="e.g. 0712345678">
                <button class="primary-btn" id="pay-trigger-stk" style="margin-top:4px;">Initiate STK Push</button>
                <div id="stk-status-area" class="hidden" style="margin-top:8px;text-align:center;font-size:12px;">
                  <span class="badge warning" id="stk-status-badge">Awaiting User PIN...</span>
                </div>
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

              <!-- Split payment inputs -->
              <div class="checkout-inputs hidden" id="payment-inputs-split">
                <label style="font-size:11px;color:var(--text-secondary)">Amount Cash</label>
                <input type="number" id="pay-split-cash" placeholder="Cash portion...">
                <label style="font-size:11px;color:var(--text-secondary)">Amount M-Pesa (Send STK)</label>
                <input type="number" id="pay-split-mpesa" placeholder="M-Pesa portion...">
                <input type="text" id="pay-split-phone" placeholder="M-Pesa Phone Number" style="margin-top:4px;">
                <button class="primary-btn" id="pay-split-trigger-stk">Trigger M-Pesa STK</button>
                <div id="split-stk-status-area" class="hidden" style="margin-top:8px;text-align:center;font-size:12px;">
                  <span class="badge warning" id="split-stk-status-badge">Awaiting User PIN...</span>
                </div>
              </div>

              <div style="display:flex;gap:10px;margin-top:auto;">
                <button class="cancel-pay-btn" style="flex:1;" id="pay-cancel-btn">Back to Cart</button>
                <button class="confirm-pay-btn" style="flex:1.5;" id="pay-confirm-btn">Confirm & Print</button>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- ESC/POS Thermal Receipt Paper Simulation Modal -->
      <div id="receipt-modal" class="modal">
        <div class="modal-content" style="max-width: 420px; background: #222; padding: 20px;">
          <h2 style="font-size:16px; margin-bottom: 12px; color: #fff;">Simulated Printed Receipt</h2>
          
          <div style="display:flex; gap: 8px; margin-bottom: 12px; width:100%;">
            <button class="primary-btn active" id="receipt-format-58" style="flex:1;">58mm Roll</button>
            <button class="sec-btn" id="receipt-format-80" style="flex:1;">80mm Roll</button>
          </div>

          <div id="receipt-paper-view" class="receipt-paper-58">
            <!-- Simulated thermal receipt content -->
          </div>

          <div style="display:flex; gap: 10px; width: 100%; margin-top: 16px;">
            <button class="sec-btn" style="flex:1;" id="receipt-print-btn">Print</button>
            <button class="primary-btn" style="flex:1;" id="receipt-close-btn">Done (New Sale)</button>
          </div>
        </div>
      </div>
    `;

    this.bindEvents();
  }

  bindEvents() {
    // Search filter typing
    const searchInput = document.getElementById('till-search');
    searchInput.addEventListener('input', () => {
      this.filterCatalogue();
    });

    // Category filter chips
    document.querySelectorAll('.filter-chip').forEach(chip => {
      chip.addEventListener('click', (e) => {
        document.querySelectorAll('.filter-chip').forEach(c => c.classList.remove('active'));
        e.target.classList.add('active');
        this.filterCatalogue();
      });
    });

    // Simulate Barcode Scanner action
    document.getElementById('till-scan-sim').addEventListener('click', () => {
      this.simulateBarcodeScan();
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
    });

    // Pay now triggers checkout modal
    document.getElementById('till-pay-now-btn').addEventListener('click', () => {
      this.openCheckoutModal();
    });

    // Payment method switcher
    document.querySelectorAll('.payment-method-card').forEach(card => {
      card.addEventListener('click', (e) => {
        const methodCard = e.target.closest('.payment-method-card');
        document.querySelectorAll('.payment-method-card').forEach(c => c.classList.remove('selected'));
        methodCard.classList.add('selected');
        
        const method = methodCard.getAttribute('data-method');
        this.selectPaymentMethod(method);
      });
    });

    // Cash tendered math
    document.getElementById('pay-cash-tendered').addEventListener('input', (e) => {
      this.updateCashChange(parseFloat(e.target.value) || 0);
    });

    // Provider proof belongs to the exact phone and split amounts that were
    // initiated. Typing after a push therefore starts a new attempt.
    document.getElementById('pay-mpesa-phone').addEventListener('input', () => {
      this.invalidateMpesaAttempt();
    });
    document.getElementById('pay-split-phone').addEventListener('input', () => {
      this.invalidateMpesaAttempt();
    });
    document.getElementById('pay-split-cash').addEventListener('input', (e) => {
      this.balanceSplitFrom('cash', parseFloat(e.target.value) || 0);
      this.invalidateMpesaAttempt();
    });
    document.getElementById('pay-split-mpesa').addEventListener('input', (e) => {
      this.balanceSplitFrom('mpesa', parseFloat(e.target.value) || 0);
      this.invalidateMpesaAttempt();
    });

    // STK Push Trigger
    document.getElementById('pay-trigger-stk').addEventListener('click', () => {
      this.triggerMpesaStk();
    });

    // Split STK Trigger
    document.getElementById('pay-split-trigger-stk').addEventListener('click', () => {
      this.triggerSplitMpesaStk();
    });

    // Cancel / Close buttons
    document.getElementById('pay-cancel-btn').addEventListener('click', () => {
      this.invalidateMpesaAttempt();
      document.getElementById('payment-modal').classList.remove('active');
    });

    document.getElementById('pay-confirm-btn').addEventListener('click', () => {
      this.finalizeInvoice();
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
    const products = await db.products.where('is_active').equals(1).toArray();
    const grid = document.getElementById('till-prod-grid');
    grid.innerHTML = '';
    
    for (const prod of products) {
      const stock = await getHouseStock(prod.id, state.currentBranch.id);
      
      const card = document.createElement('div');
      card.className = `product-card ${prod.is_batch_tracked ? 'batch-tracked' : ''}`;
      card.setAttribute('data-id', prod.id);
      card.setAttribute('data-cat', prod.category_id);
      card.setAttribute('data-name', prod.name.toLowerCase());
      card.setAttribute('data-sku', prod.sku.toLowerCase());

      // Fetch barcode
      const barRec = await db.barcodes.where('product_id').equals(prod.id).first();
      const barcodeVal = barRec ? barRec.barcode : '';
      card.setAttribute('data-barcode', barcodeVal);

      card.innerHTML = `
        <div class="card-media" style="height: 120px; border-radius: 8px; margin-bottom: 8px; background: url('${prod.image_data ? (prod.image_data.includes('?') ? prod.image_data : prod.image_data + '?v=2') : '/ai_images/juice_glass.jpg'}') center/cover no-repeat; border: 1px solid rgba(255, 255, 255, 0.05); display: flex; align-items: center; justify-content: center;">
          ${!prod.image_data ? '<span style="font-size:24px; opacity:0.3;">📷</span>' : ''}
        </div>
        <div>
          <h4>${prod.name}</h4>
          <p class="sku">${prod.sku}</p>
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
          <span class="price">KES ${prod.sell_price.toFixed(2)}</span>
          <span class="stock ${stock <= 10 && !prod.is_service ? 'low' : ''}">
            ${prod.is_service ? 'Service' : stock + ' left'}
          </span>
        </div>
      `;

      card.addEventListener('click', () => {
        this.addToCart(prod);
      });
      grid.appendChild(card);
    }
  }

  async loadCustomerDropdown() {
    const list = await db.customers.toArray();
    const select = document.getElementById('cart-customer-select');
    select.innerHTML = '';
    
    list.forEach(cust => {
      const opt = document.createElement('option');
      opt.value = cust.id;
      opt.innerText = cust.name + (cust.phone ? ` (${cust.phone})` : '');
      if (cust.id === 'cust-walkin') opt.selected = true;
      select.appendChild(opt);
    });
  }

  filterCatalogue() {
    const query = document.getElementById('till-search').value.toLowerCase();
    const activeCat = document.querySelector('.filter-chip.active').getAttribute('data-cat');
    const cards = document.querySelectorAll('.product-card');

    cards.forEach(card => {
      const name = card.getAttribute('data-name');
      const sku = card.getAttribute('data-sku');
      const bar = card.getAttribute('data-barcode');
      const cat = card.getAttribute('data-cat');

      const matchesQuery = !query || name.includes(query) || sku.includes(query) || bar.includes(query);
      const matchesCat = activeCat === 'all' || cat === activeCat;

      if (matchesQuery && matchesCat) {
        card.classList.remove('hidden');
      } else {
        card.classList.add('hidden');
      }
    });
  }

  async simulateBarcodeScan() {
    // Mock simple scanner inputting a barcode
    const barcodes = ['6161234567890', '6161234567891', '6161234567892', '6161234567893'];
    const randomBarcode = barcodes[Math.floor(Math.random() * barcodes.length)];
    
    showNotification(`Scanned Barcode: ${randomBarcode}`, 'success');

    const barcodeRecord = await db.barcodes.where('barcode').equals(randomBarcode).first();
    if (barcodeRecord) {
      const prod = await db.products.get(barcodeRecord.product_id);
      if (prod) {
        this.addToCart(prod);
      }
    } else {
      showNotification('Barcode not found in catalogue.', 'error');
    }
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

    this.invalidateMpesaAttempt();
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

    showNotification(`${product.name} added to cart`, 'success');
    this.updateCartUI();
  }

  updateCartUI() {
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

    list.innerHTML = '';
    payBtn.disabled = false;

    this.cart.forEach((item, index) => {
      const div = document.createElement('div');
      div.className = 'cart-item';
      
      const rate = this.selectedCustomer.price_tier === 'WHOLESALE' ? item.product.cost_price * 1.15 : item.product.sell_price;
      const lineDiscount = Math.max(0, Number(item.discount_amount) || 0);
      const total = Math.max(0, rate * item.qty - lineDiscount);

      div.innerHTML = `
        <div class="cart-item-header" style="display: flex; align-items: center; gap: 8px;">
          ${item.product.image_data ? `<img src="${item.product.image_data}" style="width: 24px; height: 24px; object-fit: cover; border-radius: 4px; border: 1px solid rgba(200, 130, 42, 0.2);">` : `<div style="width: 24px; height: 24px; border-radius: 4px; background: rgba(255,255,255,0.05); display: flex; align-items: center; justify-content: center; font-size: 11px; color: var(--text-muted);">📷</div>`}
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
          <div class="cart-item-qty-control">
            <button class="qty-btn dec" data-idx="${index}">-</button>
            <span class="qty-val">${item.qty}</span>
            <button class="qty-btn inc" data-idx="${index}">+</button>
          </div>
          <span class="cart-item-price">KES ${total.toFixed(2)}</span>
        </div>
      `;

      // Remove item listener
      div.querySelector('.cart-item-remove').addEventListener('click', (e) => {
        this.invalidateMpesaAttempt();
        const idx = parseInt(e.target.getAttribute('data-idx'));
        this.cart.splice(idx, 1);
        this.updateCartUI();
      });

      // Quantity increment/decrement listener
      div.querySelector('.qty-btn.dec').addEventListener('click', (e) => {
        this.invalidateMpesaAttempt();
        const idx = parseInt(e.target.getAttribute('data-idx'));
        if (this.cart[idx].qty > 1) {
          this.cart[idx].qty--;
        } else {
          this.cart.splice(idx, 1);
        }
        this.updateCartUI();
      });

      div.querySelector('.qty-btn.inc').addEventListener('click', (e) => {
        this.invalidateMpesaAttempt();
        const idx = parseInt(e.target.getAttribute('data-idx'));
        this.cart[idx].qty++;
        this.updateCartUI();
      });

      list.appendChild(div);
    });

    this.recomputeTotals();
  }

  recomputeTotals() {
    let subtotal = 0;
    let discount = 0;
    let tax = 0;

    this.cart.forEach(item => {
      const price = this.selectedCustomer.price_tier === 'WHOLESALE' ? item.product.cost_price * 1.15 : item.product.sell_price;
      const itemSub = price * item.qty;
      const itemDiscount = Math.min(itemSub, Math.max(0, Number(item.discount_amount) || 0));
      subtotal += itemSub;
      discount += itemDiscount;
      
      // Calculate tax components based on tax band settings
      let rate = 0.16; // Standard Standard (A)
      if (item.product.tax_code === 'B') rate = 0.08;
      else if (item.product.tax_code === 'C' || item.product.tax_code === 'E') rate = 0.00;

      const taxableTotal = itemSub - itemDiscount;
      const itemTax = (taxableTotal - (taxableTotal / (1 + rate)));
      tax += itemTax;
    });

    const total = subtotal - discount;

    document.getElementById('summary-subtotal').innerText = `KES ${subtotal.toFixed(2)}`;
    document.getElementById('summary-discount').innerText = `KES ${discount.toFixed(2)}`;
    document.getElementById('summary-tax').innerText = `KES ${tax.toFixed(2)}`;
    document.getElementById('summary-total').innerText = `KES ${total.toFixed(2)}`;

    // Store calculations on class reference
    this.totals = { subtotal, discount, tax, total };
  }

  compactCartLines() {
    const quantities = new Map();
    for (const item of this.cart) {
      const productId = String(item.product.id);
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
    return this.mpesaAttempt;
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
    if (confirm && (this.selectedPaymentMethod === 'MPESA' || this.selectedPaymentMethod === 'SPLIT')) {
      confirm.disabled = true;
    }

    if (this.mpesaCapability.available) {
      document.getElementById('stk-status-area')?.classList.add('hidden');
      document.getElementById('split-stk-status-area')?.classList.add('hidden');
    } else {
      this.applyMpesaCapabilityToUi();
    }
  }

  showMpesaStatus(kind, message, level = 'warning') {
    const split = kind === 'split';
    const area = document.getElementById(split ? 'split-stk-status-area' : 'stk-status-area');
    const badge = document.getElementById(split ? 'split-stk-status-badge' : 'stk-status-badge');
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

    for (const id of ['payment-method-mpesa', 'payment-method-split']) {
      const card = document.getElementById(id);
      if (!card) continue;
      card.style.opacity = unavailable ? '0.55' : '';
      card.style.cursor = unavailable ? 'not-allowed' : '';
      card.setAttribute('aria-disabled', String(unavailable));
      card.title = unavailable ? capability.message : '';
    }

    const mpesaNote = document.getElementById('payment-method-mpesa-note');
    const splitNote = document.getElementById('payment-method-split-note');
    if (mpesaNote) mpesaNote.innerText = statusLabel;
    if (splitNote) splitNote.innerText = unavailable ? statusLabel : 'Combine Cash and M-Pesa';

    const offline = state.syncManager?.connectionStatus === 'OFFLINE';
    const trigger = document.getElementById('pay-trigger-stk');
    const splitTrigger = document.getElementById('pay-split-trigger-stk');
    if (trigger) trigger.disabled = unavailable || offline || this.mpesaVerified;
    if (splitTrigger) splitTrigger.disabled = unavailable || offline || this.mpesaVerified;

    if (unavailable) {
      this.showMpesaStatus('mpesa', capability.message, 'warning');
      this.showMpesaStatus('split', capability.message, 'warning');
    }

    const confirm = document.getElementById('pay-confirm-btn');
    if (
      confirm
      && (this.selectedPaymentMethod === 'MPESA' || this.selectedPaymentMethod === 'SPLIT')
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

  balanceSplitFrom(source, amountKes) {
    const bounded = Math.min(this.totals.total, Math.max(0, amountKes));
    const other = Math.max(0, this.totals.total - bounded);
    const target = document.getElementById(
      source === 'cash' ? 'pay-split-mpesa' : 'pay-split-cash'
    );
    if (target) target.value = other.toFixed(2);
  }

  splitAmountsMinor() {
    return {
      cashMinor: toMinor(parseFloat(document.getElementById('pay-split-cash')?.value) || 0),
      mpesaMinor: toMinor(parseFloat(document.getElementById('pay-split-mpesa')?.value) || 0)
    };
  }

  cartLineGrossMinor(item) {
    const price = this.selectedCustomer.price_tier === 'WHOLESALE'
      ? item.product.cost_price * 1.15
      : item.product.sell_price;
    return toMinor(price * item.qty);
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
    const cashMinor = kind === 'split' ? attempt.cashAmountMinor : 0;
    if (
      (kind === 'split' && cashMinor + amountMinor !== discountedCartMinor)
      || (kind !== 'split' && amountMinor !== discountedCartMinor)
    ) {
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

    if (kind === 'split') {
      document.getElementById('pay-split-cash').value = (cashMinor / 100).toFixed(2);
      document.getElementById('pay-split-mpesa').value = (amountMinor / 100).toFixed(2);
    }
    document.getElementById('checkout-due-amount').innerText = `KES ${this.totals.total.toFixed(2)}`;

    attempt.pricingApplied = true;
    attempt.pricing = pricing;
    attempt.settledAmountMinor = amountMinor;
    attempt.fingerprint = this.paymentAttemptFingerprint(phone, amountMinor, cashMinor);
    return { ok: true, amountMinor };
  }

  openCheckoutModal() {
    const cashEnabled = localStorage.getItem('pos_cash_enabled') !== 'false';
    document.getElementById('checkout-due-amount').innerText = `KES ${this.totals.total.toFixed(2)}`;
    document.getElementById('payment-modal').classList.add('active');

    // Hide/show cash payment option based on owner setting
    const cashCard = document.querySelector('[data-method="CASH"]');
    if (cashCard) cashCard.style.display = cashEnabled ? '' : 'none';

    // Default to cash if enabled, otherwise M-Pesa
    this.selectPaymentMethod(cashEnabled ? 'CASH' : 'MPESA');
    void this.refreshMpesaCapability();
  }

  selectPaymentMethod(method) {
    if (method !== this.selectedPaymentMethod) this.invalidateMpesaAttempt();
    this.selectedPaymentMethod = method;
    
    // Hide all input areas
    document.getElementById('payment-inputs-cash').classList.add('hidden');
    document.getElementById('payment-inputs-mpesa').classList.add('hidden');
    document.getElementById('payment-inputs-credit').classList.add('hidden');
    document.getElementById('payment-inputs-split').classList.add('hidden');

    // Every tender starts confirmable; only the credit check takes that away.
    // Without this reset, a breached credit limit left the button disabled for
    // whatever tender the cashier switched to next.
    document.getElementById('pay-confirm-btn').disabled = false;
    document.getElementById('credit-warn-text').innerText = '';

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
    } else if (method === 'CREDIT') {
      document.getElementById('payment-inputs-credit').classList.remove('hidden');
      this.applyCreditLimit();
    } else if (method === 'SPLIT') {
      document.getElementById('payment-inputs-split').classList.remove('hidden');
      document.getElementById('pay-split-cash').value = (this.totals.total / 2).toFixed(2);
      document.getElementById('pay-split-mpesa').value = (this.totals.total / 2).toFixed(2);
      document.getElementById('pay-split-phone').value = this.selectedCustomer.phone || '';
      document.getElementById('pay-split-trigger-stk').disabled = true;
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

    return payments
      .filter(payment => String(payment.method).toUpperCase() === 'CREDIT')
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

  async triggerSplitMpesaStk() {
    await this.runMpesaAttempt('split');
  }

  async runMpesaAttempt(kind) {
    const split = kind === 'split';
    const phone = document.getElementById(split ? 'pay-split-phone' : 'pay-mpesa-phone').value;
    const trigger = document.getElementById(split ? 'pay-split-trigger-stk' : 'pay-trigger-stk');
    const { cashMinor, mpesaMinor } = split
      ? this.splitAmountsMinor()
      : { cashMinor: 0, mpesaMinor: toMinor(this.totals.total) };

    if (split && cashMinor + mpesaMinor !== toMinor(this.totals.total)) {
      this.showMpesaStatus(kind, 'Cash and M-Pesa must exactly equal the sale total.', 'danger');
      showNotification('Split tender amounts must exactly equal the sale total.', 'error');
      return;
    }
    if (mpesaMinor <= 0) {
      this.showMpesaStatus(kind, 'Enter an M-Pesa amount greater than zero.', 'danger');
      return;
    }
    if (this.mpesaOffline('Offline: M-Pesa is unavailable. Use another tender.')) {
      this.showMpesaStatus(kind, 'Offline: M-Pesa unavailable', 'danger');
      return;
    }

    const attempt = this.beginMpesaAttempt(phone, mpesaMinor, cashMinor);
    if (this.mpesaVerified && this.mpesaAttempt === attempt) {
      this.showMpesaStatus(kind, `Already confirmed. Code: ${this.mpesaRef}`, 'success');
      return;
    }

    this.showMpesaStatus(kind, 'Checking activation and initiating STK Push...', 'warning');
    trigger.disabled = true;

    try {
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
        lines: this.compactCartLines()
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
            split ? attempt.cashAmountMinor : 0
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
          result.receipt ? `Confirmed. Code: ${result.receipt}` : 'Confirmed by M-Pesa.',
          'success'
        );
        document.getElementById('pay-confirm-btn').disabled = false;
        showNotification(`M-Pesa payment received. Ref: ${this.mpesaRef}`, 'success');
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

  /**
   * One row per tender actually taken.
   *
   * A split used to be written as a single 'SPLIT' row carrying the whole
   * total, which the backend has no method for and which lost the cash/M-Pesa
   * breakdown the drawer count and the M-Pesa ledger both need. Splits now
   * settle as the two payments they really are.
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

    if (this.selectedPaymentMethod === 'SPLIT') {
      const { cashMinor, mpesaMinor } = this.splitAmountsMinor();
      const rows = [];
      if (cashMinor > 0) rows.push(row('CASH', cashMinor / 100, '', true));
      rows.push(row('MPESA', mpesaMinor / 100, this.mpesaRef, this.mpesaVerified, {
        phone: document.getElementById('pay-split-phone')?.value || '',
        attemptId: this.mpesaAttempt?.attemptId || null
      }));
      return rows;
    }

    if (this.selectedPaymentMethod === 'MPESA') {
      return [row('MPESA', this.totals.total, this.mpesaRef, this.mpesaVerified, {
        phone: document.getElementById('pay-mpesa-phone')?.value || '',
        attemptId: this.mpesaAttempt?.attemptId || null
      })];
    }

    // Cash is settled at the drawer and credit is a receivable on the books;
    // neither has a provider to confirm it, so both count as settled here.
    return [row(this.selectedPaymentMethod, this.totals.total, '', true)];
  }

  mpesaProofMatchesCurrentCart() {
    if (!this.mpesaVerified || !this.mpesaAttempt || !this.mpesaRef) return false;

    const split = this.selectedPaymentMethod === 'SPLIT';
    const phone = document.getElementById(split ? 'pay-split-phone' : 'pay-mpesa-phone')?.value || '';
    const { cashMinor, mpesaMinor } = split
      ? this.splitAmountsMinor()
      : { cashMinor: 0, mpesaMinor: toMinor(this.totals.total) };
    if (cashMinor + mpesaMinor !== toMinor(this.totals.total)) return false;
    if (this.mpesaConfirmedAmountMinor !== mpesaMinor) return false;

    return this.mpesaAttempt.fingerprint
      === this.paymentAttemptFingerprint(phone, mpesaMinor, cashMinor);
  }

  async finalizeInvoice() {
    const saleId = crypto.randomUUID();
    const invoiceNo = `INV-BH001-${new Date().getTime().toString().slice(-6)}`;
    const saleUuid = crypto.randomUUID();
    const buyerPin = document.getElementById('cart-buyer-pin').value || '';
    const tableNo = document.getElementById('checkout-table-number').value || '';

    // Verify cashier shift is open
    const openShift = await db.shifts.where('status').equals('OPEN').first();
    if (!openShift) {
      showNotification('No open cashier shift found. Open shift before completing sales.', 'error');
      return;
    }

    // A sale is never booked against an M-Pesa payment the backend has not
    // confirmed. Cash and credit are settled at the counter; M-Pesa is not.
    if (
      (this.selectedPaymentMethod === 'MPESA' || this.selectedPaymentMethod === 'SPLIT')
      && !this.mpesaProofMatchesCurrentCart()
    ) {
      this.invalidateMpesaAttempt();
      showNotification('M-Pesa proof no longer matches this cart. Run a new STK push and wait for confirmation.', 'error');
      return;
    }

    const saleRecord = {
      id: saleId,
      tenant_id: state.currentTenant.id,
      branch_id: state.currentBranch.id,
      device_id: DEVICE_ID,
      // Online sales must use the deterministic shift opened by the trusted
      // backend. A local id remains the offline fallback for queued cash sales.
      shift_id: state.cloudShiftId || openShift.id,
      invoice_no: invoiceNo,
      sale_uuid: saleUuid,
      customer_id: this.selectedCustomer.id || null,
      table_no: tableNo,
      buyer_pin: buyerPin,
      subtotal: this.totals.subtotal,
      discount: this.totals.discount,
      tax_total: this.totals.tax,
      grand_total: this.totals.total,
      status: 'COMPLETED',
      sold_at: new Date().toISOString(),
      synced_at: null,
      fiscal_status: 'QUEUED',
      etims_solution: 'OSCU'
    };

    const paymentRecords = this.buildPaymentRecords(saleId);
    // The receipt prints one settlement line; a split shows its M-Pesa half.
    const paymentRecord = paymentRecords[paymentRecords.length - 1];

    // Perform database operations within atomic transactions
    await db.transaction('rw', [db.sales, db.sale_lines, db.payments, db.stock_movements, db.audit_log], async () => {
      // 1. Write Sale
      await db.sales.add(saleRecord);

      // 2. Write Sale Lines & Stock Movements
      for (const item of this.cart) {
        const rate = this.selectedCustomer.price_tier === 'WHOLESALE' ? item.product.cost_price * 1.15 : item.product.sell_price;
        const gross = rate * item.qty;
        const discount = Math.min(gross, Math.max(0, Number(item.discount_amount) || 0));
        const total = gross - discount;

        let taxRate = 0.16;
        if (item.product.tax_code === 'B') taxRate = 0.08;
        else if (item.product.tax_code === 'C' || item.product.tax_code === 'E') taxRate = 0.00;

        await db.sale_lines.add({
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

        // Write Stock movement depletion record (Negative stock blocked checks enforced if needed)
        await db.stock_movements.add({
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
          created_at: new Date().toISOString()
        });
      }

      // 3. Write payment records
      for (const record of paymentRecords) {
        await db.payments.add(record);
      }

      // 4. Log audit session
      await logAuditEvent(state.currentTenant.id, state.currentUser.id, 'SALE_CHECKOUT', 'SALE', saleId);
    });

    // Check low stock
    for (const item of this.cart) {
      if (!item.product.is_service) {
        const remainingStock = await getHouseStock(item.product.id, state.currentBranch.id);
        if (remainingStock <= 20) {
          showNotification(`Low Stock Alert: ${item.product.name} is down to ${remainingStock} in House! Please request more.`, 'warning');
        }
      }
    }

    // Triggers background sync outbox process immediately if online
    state.syncManager.syncOutbox();

    document.getElementById('payment-modal').classList.remove('active');
    this.openPrintedReceipt(saleRecord, paymentRecord);
  }

  async openPrintedReceipt(sale, payment) {
    const selectCustomerName = this.selectedCustomer.name;
    const lines = await db.sale_lines.where('sale_id').equals(sale.id).toArray();
    
    // Load products names mapping
    const productsList = await db.products.toArray();
    const prodMap = new Map(productsList.map(p => [p.id, p]));

    // Construct receipt mock view
    const paperView = document.getElementById('receipt-paper-view');

    // Simulate eTIMS records return, if background sync processed quickly.
    const fiscal = await db.fiscal_records.where('sale_id').equals(sale.id).first();
    const hasFiscal = !!fiscal;

    // The print station is a different device and never receives this sale, so
    // the receipt's own values travel with the job.
    this.lastReceiptPayload = {
      tenantName: state.currentTenant.trading_name,
      branchName: state.currentBranch.name,
      kraPin: state.currentTenant.kra_pin,
      branchCode: state.currentBranch.etims_bhf_id,
      invoiceNo: sale.invoice_no,
      soldAt: new Date(sale.sold_at).toLocaleString(),
      cashierName: state.currentUser.name,
      customerName: selectCustomerName,
      buyerPin: sale.buyer_pin || null,
      lines: lines.map((line) => ({
        name: prodMap.get(line.product_id)?.name || 'Unknown Item',
        qty: line.qty,
        unitPrice: line.unit_price,
        lineTotal: line.line_total,
        taxCode: line.tax_code
      })),
      subtotal: sale.subtotal,
      taxTotal: sale.tax_total,
      grandTotal: sale.grand_total,
      paymentMethod: payment.method,
      paymentReference: payment.reference || null,
      fiscal: hasFiscal
        ? {
            cuSerial: fiscal.cu_serial,
            signature: fiscal.receipt_signature,
            invoiceNo: fiscal.cu_invoice_no
          }
        : null
    };

    paperView.innerHTML = `
      <div class="receipt-header">
        <h2>${state.currentTenant.trading_name}</h2>
        <p>${state.currentBranch.name}</p>
        <p>PIN: ${state.currentTenant.kra_pin}</p>
        <p>Branch ID: ${state.currentBranch.etims_bhf_id}</p>
        <p>Tel: +254 712 345678</p>
      </div>
      <div class="receipt-divider"></div>
      <div style="font-size:10px; margin-bottom: 8px;">
        <div><b>Invoice:</b> ${sale.invoice_no}</div>
        <div><b>Date:</b> ${new Date(sale.sold_at).toLocaleString()}</div>
        <div><b>Cashier:</b> ${state.currentUser.name}</div>
        <div><b>Customer:</b> ${selectCustomerName}</div>
        ${sale.buyer_pin ? `<div><b>Buyer PIN:</b> ${sale.buyer_pin}</div>` : ''}
      </div>
      <div class="receipt-divider"></div>
      <div class="receipt-items">
        ${lines.map(line => {
          const prod = prodMap.get(line.product_id);
          return `
            <div class="receipt-item-details">
              <div class="receipt-item-row">
                <span>${prod ? prod.name : 'Unknown Item'}</span>
                <span>${line.line_total.toFixed(2)}</span>
              </div>
              <div style="font-size:9px; color:#555;">
                ${line.qty} x ${line.unit_price.toFixed(2)} (Tax: ${line.tax_code})
              </div>
            </div>
          `;
        }).join('')}
      </div>
      <div class="receipt-divider"></div>
      <div class="receipt-totals-row">
        <span>Subtotal</span>
        <span>${sale.subtotal.toFixed(2)}</span>
      </div>
      <div class="receipt-totals-row">
        <span>VAT Tax</span>
        <span>${sale.tax_total.toFixed(2)}</span>
      </div>
      <div class="receipt-totals-row" style="font-size:13px;">
        <span>TOTAL DUE</span>
        <span>KES ${sale.grand_total.toFixed(2)}</span>
      </div>
      <div class="receipt-divider"></div>
      <div style="font-size:10px; margin-bottom: 8px;">
        <div><b>Settlement:</b> ${payment.method}</div>
        ${payment.reference ? `<div><b>Ref:</b> ${payment.reference}</div>` : ''}
      </div>
      <div class="receipt-divider"></div>
      
      <!-- eTIMS block -->
      <div class="receipt-header" style="font-size:9px;">
        <p><b>*** KRA eTIMS FISCAL RECORD ***</b></p>
        ${hasFiscal ? `
          <p>CU Serial: ${fiscal.cu_serial}</p>
          <p style="word-break: break-all;">Signature: ${fiscal.receipt_signature}</p>
          <p>Invoice No: ${fiscal.cu_invoice_no}</p>
          <div class="receipt-qr-container">
            <div class="receipt-qr-mock">
              [ SCAN TO VERIFY KRA ]
            </div>
            <p style="font-size:8px; color:#555;">Verification QR Code</p>
          </div>
        ` : `
          <p style="color:#e11d48;font-weight:bold;">AWAITING FISCAL SIGNATURE</p>
          <p>Invoice queued offline and will transmit on link reconnection.</p>
        `}
      </div>
      <div class="receipt-divider"></div>
      <div class="receipt-header" style="font-size:9px; margin-top:8px;">
        <p>Thank you for shopping with us!</p>
        <p>Powered by KPOS Pro Systems</p>
      </div>
    `;

    document.getElementById('receipt-modal').classList.add('active');
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
    const [jobId, stationOnline] = await Promise.all([
      enqueuePrintJob({
        branchId,
        receipt: this.lastReceiptPayload,
        widthClass: paper?.className === 'receipt-paper-58'
          ? 'receipt-paper-58'
          : 'receipt-paper-80'
      }),
      isStationOnline(branchId)
    ]);

    if (!jobId) {
      showNotification(
        'The receipt could not be queued. Print it from the counter instead.',
        'error'
      );
      return;
    }

    // Queued is not printed. With no station running the job waits indefinitely,
    // and a server would stand at the counter waiting for paper that never came.
    showNotification(
      stationOnline
        ? 'Sent to the counter printer.'
        : 'Queued, but no print station is running. Start it at the counter.',
      stationOnline ? 'success' : 'warning'
    );
  }

  clearCart() {
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
    
    this.invalidateMpesaAttempt();
    this.parkedCarts.push({
      id: crypto.randomUUID(),
      cart: [...this.cart],
      customer: this.selectedCustomer,
      timestamp: new Date().getTime()
    });

    this.cart = [];
    showNotification('Current cart suspended/parked successfully.', 'success');
    
    document.getElementById('parked-count').innerText = this.parkedCarts.length;
    this.updateCartUI();
  }

  resumeParkedCart() {
    if (this.parkedCarts.length === 0) {
      showNotification('No parked carts found.', 'error');
      return;
    }

    this.invalidateMpesaAttempt();
    const resumed = this.parkedCarts.pop();
    this.cart = resumed.cart;
    this.selectedCustomer = resumed.customer;

    showNotification('Restored parked cart.', 'success');
    document.getElementById('parked-count').innerText = this.parkedCarts.length;
    this.updateCartUI();
  }
}
