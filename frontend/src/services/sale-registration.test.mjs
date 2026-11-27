import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { saleLineRate, recordedSaleTotals } from './service-charges.js';
const source = (await readFile(new URL('../ui/till.js', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
const start = source.indexOf('  async registerOrder(');
const method = source.slice(start, source.indexOf('\n  /** Closes the checkout', start)).replace('async registerOrder(', 'async function registerOrder(');

test('saving a round preserves its item, price and debtor while asynchronous lookups yield to cart changes', async () => {
  for (const clearAt of ['shift', 'table']) {
    const rows = { sales: [], lines: [], movements: [], payments: [] };
    const original = { product: { id: 'tusker', name: 'Tusker Lager', sell_price: 350, tax_code: 'A', cost_price: 200 }, qty: 1 };
    const view = { cart: [original], totals: { total: 350, subtotal: 350, tax: 48.28 }, selectedCustomer: { id: 'guest', price_tier: 'RETAIL' },
      activeTable: 'China', selectedPaymentMethod: 'CREDIT', houseStockByProduct: new Map([['tusker', 100]]),
      async assertTabNameFree() { if (clearAt === 'table') mutate(); }, async resolveTabForRound() { return 'china-tab'; },
      sendRoundToKitchen(_id, items) { rows.kitchen = items; } };
    const mutate = () => { original.qty = 9; original.product.sell_price = 1; view.cart = []; view.totals = { total: 0, subtotal: 0, tax: 0 }; view.selectedCustomer = { id: 'other', price_tier: 'WHOLESALE' }; };
    const db = { shifts: { where: () => ({ equals: () => ({ filter: () => ({ toArray: async () => {
      if (clearAt === 'shift') mutate(); return [{ id: 'shift', status: 'OPEN' }];
    } }) }) }) }, sales: { add: async row => rows.sales.push(row) },
      sale_lines: { bulkAdd: async values => rows.lines.push(...values) }, stock_movements: { bulkAdd: async values => rows.movements.push(...values) },
      payments: { bulkAdd: async values => rows.payments.push(...values) }, tabs: {}, audit_log: {}, customers: {} };
    db.transaction = async (_mode, _tables, run) => run();
    const run = new Function('db', 'state', 'document', 'discountAwaitingCode', 'canSell', 'showNotification',
      'DEVICE_ID', 'HELD_ORDER_MS', 'firebaseConfigured', 'discountApprovalId', 'saleLineRate', 'recordedSaleTotals', 'logAuditEvent',
      `return ${method}`)(db, { currentUser: { id: 'seller' }, currentBranch: { id: 'branch' }, currentTenant: { id: 'tenant' } },
      { getElementById: () => ({ value: '' }) }, () => false, () => true, () => {}, 'device', 1000, false, () => null,
      saleLineRate, recordedSaleTotals, async () => {});
    const result = await run.call(view, [{ method: 'PROFORMA', amount: 350 }], { pending: true });
    assert.equal(result.saleRecord.grand_total, 350);
    assert.equal(result.saleRecord.customer_id, 'guest');
    assert.equal(rows.lines.length, 1); assert.equal(rows.lines[0].product_id, 'tusker');
    assert.equal(rows.lines[0].qty, 1); assert.equal(rows.lines[0].unit_price, 350); assert.equal(rows.lines[0].line_total, 350);
    assert.equal(rows.lines[0].product_name, 'Tusker Lager');
    assert.equal(rows.movements[0].qty, -1); assert.equal(rows.payments[0].amount, 350);
    assert.equal(rows.kitchen[0].qty, 1); assert.equal(view.houseStockByProduct.get('tusker'), 99);
  }
});
