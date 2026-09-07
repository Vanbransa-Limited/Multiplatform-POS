'use strict';
let cart = [], products = [], categories = {}, branches = [];
let busy = false, attempt = null, orderType = 'dine_in', category = 'all', search = '';
const query = new URLSearchParams(location.search);
const tenantId = query.get('tenant') || window.MENU_CONFIG?.tenantId;
const $ = (id) => document.getElementById(id);
const money = (minor) => `KES ${(minor / 100).toFixed(2)}`;
const escapeText = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function callMenu(name, data) {
  if (!tenantId || !window.MENU_CONFIG?.baseUrl) throw new Error('Menu is not configured. Please contact staff.');
  const response = await fetch(`${window.MENU_CONFIG.baseUrl}/${name}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data }),
    signal: AbortSignal.timeout(30000),
  });
  const body = await response.json();
  if (!response.ok || body.error) throw new Error(body.error?.message || 'Could not contact the restaurant. Please retry.');
  return body.result ?? body.data;
}

/**
 * Loads the menu for one branch.
 *
 * Availability is per branch, so the branch has to go with the request: a
 * counted item that the chosen branch has run out of comes back flagged, and
 * changing the branch reloads rather than showing another branch's shelf.
 */
async function loadMenu(branchId) {
  try {
    const menu = await callMenu('getPublicMenu', { tenantId, branchId: branchId || query.get('branch') || undefined });
    products = menu.products;
    categories = Object.fromEntries(menu.categories.map((c) => [c.id, c.name]));
    branches = menu.branches;
    document.querySelector('.hero h1').textContent = menu.name;
    document.querySelector('.hero-badge').textContent = 'Order at your table';
    document.querySelector('.hero-badge').classList.remove('warn');
    const chosen = branchId || $('order-branch').value;
    $('order-branch').innerHTML = branches.map((b) => `<option value="${escapeText(b.id)}">${escapeText(b.name)}</option>`).join('');
    if (query.get('branch')) {
      if (!branches.some((b) => b.id === query.get('branch'))) throw new Error('This branch is unavailable. Please ask staff for the current menu link.');
      $('order-branch').value = query.get('branch');
      $('order-branch').disabled = true;
    } else if (chosen && branches.some((b) => b.id === chosen)) {
      $('order-branch').value = chosen;
    }
    if (!branchId) {
      $('order-table').value = query.get('table') || '';
      setOrderType(query.get('type') === 'takeaway' ? 'takeaway' : 'dine_in');
      $('order-branch').onchange = (event) => loadMenu(event.target.value);
      $('menu-search').oninput = (event) => { search = event.target.value; renderGrid(); };
    }
    renderCategories();
    renderGrid();
    if (!branches.length) throw new Error('No branch is currently accepting orders.');
  } catch (error) {
    products = [];
    $('menu-grid').textContent = `${error.message} Reload this page to try again.`;
    document.querySelector('.hero-badge').textContent = 'Menu unavailable';
    document.querySelector('.hero-badge').classList.add('warn');
  }
}

function renderCategories() {
  const bar = $('cat-bar');
  bar.replaceChildren();
  for (const id of ['all', ...new Set(products.map((p) => p.categoryId))]) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = `cat-chip${id === category ? ' active' : ''}`;
    chip.textContent = id === 'all' ? 'All' : categories[id] || 'General';
    chip.onclick = () => {
      bar.querySelectorAll('.cat-chip').forEach((c) => c.classList.remove('active'));
      chip.classList.add('active'); category = id; renderGrid();
    };
    bar.appendChild(chip);
  }
}

/** Higher means further down the results; this one means it does not match. */
const NO_MATCH = 99;

// Case-insensitive, because the menu mixes "WHITE CAP" with "White Cap" and a
// plain sort files those pages apart. Numeric, so 500ML follows 330ML.
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/**
 * How well a product answers what was typed.
 *
 * Name before category, and within the name, the start of a word before the
 * middle of one: somebody typing "water" wants Mineral Water, not the cola
 * that happens to be filed under "Soft Drinks & Water".
 */
function matchRank(product, needle) {
  const name = String(product.name || '').toLowerCase();
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (name === needle) return 0;
  // The whole word, wherever it sits: "Mineral Water" and "Sparkling Water"
  // both answer "water", and both beat "Watermelon Juice", which only happens
  // to start with those letters.
  if (new RegExp(`\\b${escaped}\\b`).test(name)) return 1;
  if (name.startsWith(needle)) return 2;
  if (new RegExp(`\\b${escaped}`).test(name)) return 3;
  if (name.includes(needle)) return 4;
  if (String(categories[product.categoryId] || '').toLowerCase().includes(needle)) return 5;
  return NO_MATCH;
}

function renderGrid() {
  const grid = $('menu-grid'); grid.replaceChildren();
  const needle = search.trim().toLowerCase();
  const shown = products
    .filter((p) => (category === 'all' || p.categoryId === category)
      && (!needle || matchRank(p, needle) < NO_MATCH))
    // Alphabetical, so a customer can find a name by scanning; the server hands
    // these over in no order a reader would guess.
    //
    // A search sorts by how well each answers what was typed first - "water"
    // matched Coca-Cola through its "Soft Drinks & Water" category and put it
    // above the actual water - and alphabetically within each tier.
    .sort((a, b) =>
      (needle ? matchRank(a, needle) - matchRank(b, needle) : 0)
      || collator.compare(String(a.name || ''), String(b.name || '')));
  if (!shown.length) {
    const empty = document.createElement('div');
    empty.className = 'menu-empty';
    empty.textContent = needle ? `Nothing on the menu matches “${search.trim()}”.` : 'No items available.';
    grid.appendChild(empty);
    return;
  }
  for (const p of shown) {
    const card = document.createElement('article');
    card.className = `menu-card${p.soldOut ? ' sold-out' : ''}`;
    // The picture, its category tag and the add button are one unit, so the
    // button can sit on the corner of the image the way the design has it.
    card.innerHTML = `
      <div class="card-thumb">
        ${p.imagePath ? `<img src="${escapeText(p.imagePath)}" alt="" loading="lazy">` : '<div class="no-img" aria-hidden="true">🍽️</div>'}
        <span class="thumb-cat">${escapeText(categories[p.categoryId] || 'General')}</span>
        <button class="card-add-btn" ${p.soldOut ? 'disabled' : ''} aria-label="${p.soldOut ? 'Unavailable' : `Add ${escapeText(p.name)} to your order`}">${p.soldOut ? '×' : '+'}</button>
      </div>
      <div class="card-body">
        ${p.soldOut ? '<div class="sold-out-badge">SOLD OUT</div>' : ''}
        <div class="card-name">${escapeText(p.name)}</div>
        <div class="card-price">${money(p.sellPriceMinor)}<span class="card-uom">/ ${escapeText(p.uom)}</span></div>
      </div>`;
    card.querySelector('.card-add-btn').onclick = () => {
      if (busy || p.soldOut) return;
      const existing = cart.find((c) => c.id === p.id);
      if (existing && existing.qty < 99) existing.qty++;
      else if (!existing) cart.push({ ...p, qty: 1 });
      updateCartBar();
    };
    grid.appendChild(card);
  }
}

function updateCartBar() {
  $('cart-count-txt').textContent = `${cart.reduce((sum, item) => sum + item.qty, 0)} items`;
  $('cart-total-txt').textContent = money(cart.reduce((sum, item) => sum + item.sellPriceMinor * item.qty, 0));
  $('cart-bar').classList.toggle('visible', cart.length > 0);
}
function openCart() {
  $('cart-items-list').innerHTML = cart.map((item, i) => `<div class="cart-item"><div class="cart-item-name">${escapeText(item.name)}</div><div class="qty-ctrl"><button onclick="changeQty(${i},-1)">−</button><span>${item.qty}</span><button onclick="changeQty(${i},1)">+</button></div><div class="cart-item-price">${money(item.sellPriceMinor * item.qty)}</div></div>`).join('');
  $('cart-modal-total').textContent = money(cart.reduce((sum, item) => sum + item.sellPriceMinor * item.qty, 0));
  $('cart-modal').classList.add('open');
}
function closeCart() { if (!busy) $('cart-modal').classList.remove('open'); }
function changeQty(index, delta) {
  if (busy) return;
  cart[index].qty = Math.min(99, cart[index].qty + delta);
  if (cart[index].qty <= 0) cart.splice(index, 1);
  updateCartBar(); if (cart.length) openCart(); else closeCart();
}
/** Dine-in is served to a table; takeaway is collected, so its table field is hidden. */
function setOrderType(type) {
  if (busy) return;
  orderType = type === 'takeaway' ? 'takeaway' : 'dine_in';
  $('type-dine-in').setAttribute('aria-pressed', String(orderType === 'dine_in'));
  $('type-takeaway').setAttribute('aria-pressed', String(orderType === 'takeaway'));
  $('order-table').hidden = orderType === 'takeaway';
}

async function placeOrder() {
  if (busy || !cart.length) return;
  const payload = {
    tenantId, branchId: $('order-branch').value, orderType,
    customerName: $('order-name').value.trim(), tableNumber: orderType === 'takeaway' ? '' : $('order-table').value.trim(), note: $('order-note').value.trim(),
    lines: cart.map((item) => ({ productId: item.id, qty: item.qty, unitPriceMinor: item.sellPriceMinor })),
  };
  if (orderType === 'dine_in' && !payload.tableNumber) { $('order-error').textContent = 'Enter your table number, or choose Takeaway.'; return; }
  if (orderType === 'takeaway' && !payload.customerName) { $('order-error').textContent = 'Enter your name so staff can call your takeaway.'; return; }
  const signature = JSON.stringify(payload);
  // Retain the same request after a lost response, including a browser reload.
  try { attempt = JSON.parse(sessionStorage.getItem('menu-order-attempt')) || attempt; } catch {}
  if (attempt?.signature !== signature) attempt = { signature, requestId: crypto.randomUUID() };
  try { sessionStorage.setItem('menu-order-attempt', JSON.stringify(attempt)); } catch {}
  busy = true; $('place-order').disabled = true; $('place-order').textContent = 'Sending order…'; $('order-error').textContent = '';
  try {
    const result = await callMenu('submitCustomerOrder', { ...payload, requestId: attempt.requestId });
    cart = []; attempt = null;
    try { sessionStorage.removeItem('menu-order-attempt'); } catch {}
    updateCartBar(); $('cart-modal').classList.remove('open');
    $('order-ref').textContent = `#${result.ref}`;
    $('success-modal').classList.add('open');
  } catch (error) {
    $('order-error').textContent = `${error.message} Your order is not confirmed. Retry to check or send the same order.`;
  } finally {
    busy = false; $('place-order').disabled = false; $('place-order').textContent = 'Place Order';
  }
}
/**
 * The tracking number is all the customer leaves with.
 *
 * Payment is taken at the counter, so this page never sees money: it cannot
 * start a charge and cannot mark anything paid. Its one job is to make the
 * reference impossible to lose.
 */
function closeSuccess() {
  $('success-modal').classList.remove('open');
}

loadMenu();
