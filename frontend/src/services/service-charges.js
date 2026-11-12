/**
 * The VIP charge and the staff discount are percentages of the cart, not things
 * with a price of their own. They ride in the cart as two pseudo-products so
 * the till can toggle them, which means the sale has to be written carefully:
 * booking them at their catalogue price leaves the recorded lines summing to
 * something other than the money that was actually taken.
 *
 * Kept free of Dexie and DOM imports so the arithmetic is testable in Node.
 */

export const VIP_CHARGE_ID = 'prod-table-service';
export const STAFF_DISCOUNT_ID = 'prod-staff-discount';

/**
 * Recorded sale lines, as the cart the M-Pesa server will price.
 *
 * `initiateMpesaStk` refuses an empty cart and caps the charge at what the
 * catalogue says those items cost, so settling a proforma by STK has to name
 * the items behind it - one entry per product, quantities summed across every
 * round on the tab, because the server refuses a repeated product too.
 *
 * The two pseudo-products are stripped for the reason the till strips them from
 * a live cart: only this device has a row for either, so pricing them
 * server-side fails with "not active for this tenant" and no prompt is raised.
 */
export function catalogueCartLines(saleLines) {
  const quantities = new Map();
  for (const line of saleLines || []) {
    const productId = String(line?.product_id ?? '');
    if (!productId || productId === VIP_CHARGE_ID || productId === STAFF_DISCOUNT_ID) continue;
    const qty = Number(line?.qty) || 0;
    if (qty <= 0) continue;
    quantities.set(productId, (quantities.get(productId) || 0) + qty);
  }
  return [...quantities.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([productId, qty]) => ({ productId, qty: Math.max(1, Math.round(qty)) }));
}

/**
 * What one cart line is booked at.
 *
 * The VIP line carries the computed surcharge; the staff discount is not a sale
 * at all and is booked at zero, then taken off the order as a discount below.
 */
export function saleLineRate(product, totals, priceTier) {
  if (product.id === VIP_CHARGE_ID) return totals.vipSurcharge || 0;
  if (product.id === STAFF_DISCOUNT_ID) return 0;
  return priceTier === 'WHOLESALE' ? product.cost_price * 1.15 : product.sell_price;
}

/**
 * The sale header, written so `subtotal - discount` is exactly what was
 * charged. Finance reports and receipts both read the sale back this way, so a
 * header that does not reconcile shows a customer a total its own lines do not
 * add up to.
 */
export function recordedSaleTotals(totals) {
  return {
    subtotal: (totals.subtotal || 0) + (totals.vipSurcharge || 0),
    discount: (totals.discount || 0) + (totals.staffDiscount || 0),
    grandTotal: totals.total || 0
  };
}
