const { chromium } = require('@playwright/test');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

(async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const requests = [];
    const root = path.resolve(__dirname, '..');
    const menu = {
      name: 'Central restaurant',
      products: [
        { id: 'actual-1', name: 'Central Item', sellPriceMinor: 17500, categoryId: 'food', uom: 'PLATE', trackStock: false, soldOut: false },
        // Counted and finished: stays on the menu, but cannot be ordered.
        { id: 'gone-1', name: 'Last Bottle', sellPriceMinor: 30000, categoryId: 'food', uom: 'EACH', trackStock: true, soldOut: true },
      ],
      categories: [{ id: 'food', name: 'Food' }],
      branches: [{ id: 'branch-01', name: 'Main' }],
    };
    const payments = [];
    await page.route('https://menu.test/**', async (route) => {
      const pathname = new URL(route.request().url()).pathname;
      const file = pathname === '/menu.html' ? 'menu.html' : pathname === '/menu.js' ? 'menu.js' : null;
      if (file) return route.fulfill({ contentType: file.endsWith('.js') ? 'application/javascript' : 'text/html', body: readFileSync(path.join(root, 'public', file), 'utf8') });
      if (pathname === '/menu-config.js') return route.fulfill({ contentType: 'application/javascript', body: 'window.MENU_CONFIG={baseUrl:"https://menu.test/api",tenantId:"tenant-01"};' });
      if (pathname === '/api/getPublicMenu') return route.fulfill({ json: { result: menu } });
      if (pathname === '/api/submitCustomerOrder') {
        requests.push(route.request().postDataJSON().data);
        if (requests.length === 1) return route.fulfill({ status: 503, json: { error: { message: 'Temporary connection failure.' } } });
        return route.fulfill({ json: { result: { orderId: 'order-1', ref: 'WEB-123', totalMinor: 17500 } } });
      }
      // Kept as a trap: the menu must never call a payment endpoint again.
      if (pathname === '/api/payCustomerOrder') {
        payments.push(route.request().postDataJSON().data);
        return route.fulfill({ json: { result: { status: 'pending', message: 'Check your phone for the M-Pesa prompt.' } } });
      }
      if (pathname === '/api/queryCustomerOrderPayment') {
        return route.fulfill({ json: { result: { paymentStatus: 'paid', status: 'paid', receipt: 'QGH1234' } } });
      }
      return route.fulfill({ status: 404, body: '' });
    });
    await page.goto('https://menu.test/menu.html');
    assert.equal(await page.locator('.menu-card').count(), 2);

    // A finished item still shows, so the place does not look empty, but it
    // cannot be added to an order.
    assert.equal(await page.locator('.menu-card.sold-out').count(), 1);
    assert.match(await page.locator('.menu-card.sold-out').innerText(), /SOLD OUT/);
    assert.equal(await page.locator('.menu-card.sold-out .card-add-btn').isDisabled(), true);
    await page.locator('.menu-card.sold-out .card-add-btn').click({ force: true });
    assert.equal(await page.locator('#cart-bar.visible').count(), 0);

    // The search bar narrows the menu and says so when nothing matches.
    await page.locator('#menu-search').fill('last');
    assert.equal(await page.locator('.menu-card').count(), 1);
    await page.locator('#menu-search').fill('nothing here');
    assert.equal(await page.locator('.menu-card').count(), 0);
    assert.match(await page.locator('.menu-empty').innerText(), /Nothing on the menu matches/);
    await page.locator('#menu-search').fill('');
    assert.equal(await page.locator('.menu-card').count(), 2);

    await page.locator('.menu-card:not(.sold-out) .card-add-btn').click();
    await page.getByRole('button', { name: 'View Order' }).click();
    await page.locator('#order-name').fill('Guest <script>');

    // Takeaway hides the table field; dine-in cannot be sent without a table.
    await page.locator('#type-takeaway').click();
    assert.equal(await page.locator('#order-table').isVisible(), false);
    await page.locator('#type-dine-in').click();
    assert.equal(await page.locator('#order-table').isVisible(), true);
    await page.locator('#place-order').click();
    await page.waitForFunction(() => document.querySelector('#order-error').textContent.includes('table number'));
    assert.equal(requests.length, 0);

    await page.locator('#order-table').fill('7');
    await page.locator('#place-order').click();
    await page.waitForFunction(() => document.querySelector('#order-error').textContent.includes('not confirmed'));
    assert.equal(await page.locator('#success-modal.open').count(), 0);
    assert.equal(await page.locator('.cart-item').count(), 1);
    await page.locator('#place-order').click();
    await page.locator('#success-modal.open').waitFor();
    assert.equal(requests[0].requestId, requests[1].requestId);
    assert.equal(requests[1].orderType, 'dine_in');
    assert.equal(requests[1].tableNumber, '7');
    assert.equal(requests[1].lines[0].productId, 'actual-1');
    assert.equal(requests[1].lines[0].unitPriceMinor, 17500);

    // The customer leaves with a tracking number and no way to pay from the
    // phone: settlement is the counter's job, so nothing here can move money.
    assert.match(await page.locator('#success-modal').innerText(), /WEB-123/);
    assert.match(await page.locator('#success-modal').innerText(), /Screenshot this or write it down/);
    assert.equal(await page.locator('#pay-panel').count(), 0);
    assert.equal(await page.locator('#pay-now').count(), 0);
    assert.equal(payments.length, 0);
    assert.equal(/payCustomerOrder/.test(readFileSync(path.join(root, 'public/menu.js'), 'utf8')), false);

    // Render the same order data using the production Orders Viewer renderer.
    const renderer = readFileSync(path.join(root, 'src/services/customer-orders.js'), 'utf8').replace(/^import .*;\r?\n/gm, '').replaceAll('export ', '');
    const escaping = readFileSync(path.join(root, 'src/services/print-receipt.js'), 'utf8').replaceAll('export ', '');
    await page.evaluate(escaping + '\n' + renderer + `\n window.board = (orders) => renderOrderGrid(visibleOrders(orders, 'branch-01', {}), new Map());
      window.kitchenTicket = kitchenTicket; window.renderReceiptHtml = renderReceiptHtml; window.orderStats = orderStats; window.visibleOrders = visibleOrders;
      window.saleAsOrder = saleAsOrder; window.renderOrderCard = renderOrderCard;
      document.body.innerHTML = board([{id:'order-1',ref:'WEB-123',branchId:'branch-01',customerName:'Guest <script>',tableNumber:'7',lines:[{name:'Central Item',qty:1}],totalMinor:17500,status:'received'}]);`);
    assert.match(await page.locator('body').innerText(), /Central Item/);
    assert.match(await page.locator('body').innerText(), /UNPAID/);
    assert.match(await page.locator('body').innerText(), /TABLE 7/);
    assert.match(await page.locator('body').innerText(), /Not printed/);
    assert.equal(await page.locator('script').count(), 0);
    // Unpaid: payment leads, and the kitchen ticket is not available yet.
    assert.equal(await page.locator('[data-pay-order="order-1"]').count(), 1);
    assert.equal(await page.locator('[data-print-order="order-1"]').isDisabled(), true);

    // A paid, twice-printed takeaway offers a reprint that says it is one.
    await page.evaluate(`document.body.innerHTML = board([{id:'order-2',ref:'WEB-124',branchId:'branch-01',customerName:'Ann',orderType:'takeaway',printCount:2,paymentStatus:'paid',paymentMethod:'mpesa',lines:[{name:'Central Item',qty:3}],totalMinor:52500,status:'preparing'}]);`);
    const viewer = await page.locator('body').innerText();
    assert.match(viewer, /TAKEAWAY/);
    assert.match(viewer, /PAID/);
    assert.match(viewer, /Printed 2/);
    assert.match(viewer, /Reprint kitchen ticket/);
    // Paid, so the ticket is live and there is nothing left to settle.
    assert.equal(await page.locator('[data-print-order="order-2"]').isDisabled(), false);
    assert.equal(await page.locator('[data-pay-order="order-2"]').count(), 0);

    // Tiles count every state, and a tab narrows the board to just that state.
    const tiles = await page.evaluate(`(() => {
      const orders = [
        { id:'a', branchId:'branch-01', ref:'W1', customerName:'A', tableNumber:'1', status:'received', totalMinor:100, lines:[{name:'Pilau',qty:1}] },
        { id:'b', branchId:'branch-01', ref:'W2', customerName:'B', tableNumber:'2', status:'awaiting_print', paymentStatus:'paid', totalMinor:100, lines:[{name:'Ugali',qty:1}] },
        { id:'c', branchId:'branch-01', ref:'W3', customerName:'C', tableNumber:'3', status:'ready', totalMinor:100, lines:[{name:'Pilau',qty:2}] },
        { id:'d', branchId:'branch-02', ref:'W4', customerName:'D', tableNumber:'4', status:'received', totalMinor:100, lines:[{name:'Pilau',qty:1}] },
      ];
      const tile = (id) => orderStats(orders, 'branch-01').find((t) => t.id === id).count;
      return {
        total: tile('all'), pending: tile('pending'), served: tile('served'), cancelled: tile('cancelled'),
        pendingRefs: visibleOrders(orders, 'branch-01', { tab:'pending' }).map((o) => o.ref),
        searchRefs: visibleOrders(orders, 'branch-01', { search:'ugali' }).map((o) => o.ref),
        tableSearch: visibleOrders(orders, 'branch-01', { search:'table 3' }).map((o) => o.ref),
      };
    })()`);
    // The other branch's order is never counted or listed here.
    assert.equal(tiles.total, 3);
    // Paid-but-unprinted still reads as pending: the kitchen does not have it.
    assert.deepEqual(tiles.pendingRefs, ['W1', 'W2']);
    assert.equal(tiles.pending, 2);
    assert.equal(tiles.served, 1);
    assert.equal(tiles.cancelled, 0);
    assert.deepEqual(tiles.searchRefs, ['W2']);
    assert.deepEqual(tiles.tableSearch, ['W3']);

    // A settled till sale joins the same board as a completed, paid order, so
    // the Completed tab is the whole day's completed work, not half of it.
    const sale = await page.evaluate(`(() => {
      const order = saleAsOrder(
        { id: 's1', branch_id: 'branch-01', invoice_no: 'BH001', table_no: null, sold_at: '2026-09-05T10:27:00Z', grand_total: 70, shift_id: 'sh1', customer_id: null },
        { payment: { amount: 70, method: 'CASH', reference: 'R-9' }, cashierName: 'Vanbransa Owner', customerName: '', lines: [{ productId: 'p1', name: 'Tusker', qty: 2 }] },
      );
      const menu = { id: 'm1', branchId: 'branch-01', ref: 'W9', customerName: 'Zippy', tableNumber: '5', status: 'received', totalMinor: 500, lines: [{ name: 'Chips', qty: 1 }], createdAt: { toDate: () => new Date('2026-09-05T11:00:00Z') } };
      document.body.innerHTML = renderOrderCard(order, new Map());
      return {
        order,
        completedRefs: visibleOrders([order, menu], 'branch-01', { tab: 'completed' }).map((o) => o.ref),
        total: orderStats([order, menu], 'branch-01').find((t) => t.id === 'all').count,
        completedTile: orderStats([order, menu], 'branch-01').find((t) => t.id === 'completed').count,
        cashierSearch: visibleOrders([order, menu], 'branch-01', { search: 'vanbransa' }).map((o) => o.ref),
        html: document.body.innerHTML,
      };
    })()`);
    assert.equal(sale.order.status, 'completed');
    assert.equal(sale.order.paymentStatus, 'paid');
    // Sales are stored in whole shillings; the card renders minor units.
    assert.equal(sale.order.totalMinor, 7000);
    // No table number on the sale means it was a takeaway.
    assert.equal(sale.order.orderType, 'takeaway');
    assert.deepEqual(sale.completedRefs, ['BH001']);
    assert.equal(sale.total, 2);
    assert.equal(sale.completedTile, 1);
    assert.deepEqual(sale.cashierSearch, ['BH001']);
    // History gets an invoice, never a kitchen ticket for a table that has left.
    assert.match(sale.html, /View invoice/);
    assert.equal(/data-print-order/.test(sale.html), false);
    assert.equal(/Update status/.test(sale.html), false);
    assert.match(await page.locator('body').innerText(), /KES 70\.00/);

    // The ticket the counter sends to the kitchen carries no price at all.
    const ticket = await page.evaluate(`renderReceiptHtml(kitchenTicket({id:'order-2',ref:'WEB-124',customerName:'Ann',orderType:'takeaway',printCount:2,paymentStatus:'paid',lines:[{name:'Central Item',qty:3,unitPriceMinor:17500,totalMinor:52500}]}, 3))`);
    assert.match(ticket, /KITCHEN ORDER/);
    assert.match(ticket, /3 x Central Item/);
    assert.match(ticket, /REPRINT - COPY 3/);
    assert.equal(/175|525/.test(ticket), false);

    const shifts = readFileSync(path.join(root, 'src/ui/shifts.js'), 'utf8').replace(/^import .*;\r?\n/gm, '').replace('export class', 'class');
    await page.evaluate(`const cashIsEnabled=()=>false;\n${shifts}\ndocument.body.innerHTML='<main></main>'; new ShiftsView(document.querySelector('main')).renderNoActiveShift();`);
    assert.equal(await page.locator('#opening-float-input').isVisible(), false);
    assert.equal(await page.locator('#open-shift-btn').isVisible(), true);
    console.log('Browser checks passed: central menu, sold-out items, menu search, dine-in vs takeaway, failed-submit recovery, idempotent retry, counter-only settlement, tracking number, viewer rendering with print counts, priceless kitchen tickets, escaped customer text, and cashless shift form.');
  } finally { await browser.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
