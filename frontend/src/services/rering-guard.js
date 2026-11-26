import { isReceivable } from './takings.js';

/**
 * An unpaid walk-in bill this waiter already rang with exactly these items.
 *
 * Pay Now saves the bill unpaid first. Close checkout and it waits in Orders;
 * on 25 Nov 2026 three of those were rung a second time when the customer
 * paid (003402/003404, 003403/003405, 003423/003425), leaving a phantom
 * unpaid copy and, once, one M-Pesa payment counted on both.
 *
 * `candidates`: [{ sale, lines, payments }] from this till. Newest match wins.
 */
const NOT_ITEMS = new Set(['prod-staff-discount', 'prod-table-service']);
const signature = (rows) => rows.filter((row) => !NOT_ITEMS.has(row.id))
  .map((row) => `${row.id}:${Number(row.qty)}`).sort().join('|');

export function unpaidTwin(cart, candidates, staffId) {
  const want = signature(cart.map((item) => ({ id: item.product.id, qty: item.qty })));
  if (!want || !staffId) return null;
  return candidates
    .filter(({ sale, lines, payments }) => sale.staff_id === staffId && sale.status !== 'VOIDED' && !sale.table_no
      && payments.some((row) => isReceivable(row.method) && !row.settled_at)
      && !payments.some((row) => isReceivable(row.method) && row.settled_at)
      && signature(lines.map((line) => ({ id: line.product_id, qty: line.qty }))) === want)
    .map(({ sale }) => sale)
    .sort((a, b) => String(b.sold_at).localeCompare(String(a.sold_at)))[0] || null;
}
