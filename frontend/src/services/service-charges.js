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
