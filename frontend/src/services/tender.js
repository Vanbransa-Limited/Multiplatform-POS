/**
 * Pure tender helpers shared by the outbox.
 *
 * Kept free of Dexie and Firebase imports so the money conversion can be
 * exercised in a plain node test.
 */

/** Dexie stores KES as floats; the backend settles in integer minor units. */
export function toMinor(amount) {
  const value = Number(amount);
  if (!Number.isFinite(value)) return 0;
  // Round the scaled value off the string form so 19.99 * 100 does not land
  // on 1998.9999999999998 and truncate a cent away.
  return Math.round(Number((value * 100).toFixed(4)));
}

/** A Safaricom confirmation reference, normalised for storage and lookup. */
export function mpesaConfirmationCode(value) {
  const code = String(value || '').trim().toUpperCase();
  return /^[A-Z0-9]{6,32}$/.test(code) ? code : null;
}

/** Local tender codes -> the methods the backend will accept. */
const PAYMENT_METHOD_MAP = {
  CASH: 'cash',
  CREDIT: 'credit',
  // A proforma is a receivable on the books, which is exactly what the backend
  // means by credit. It rides that path rather than needing a tender of its
  // own; the local ledger keeps the PROFORMA label for the invoice and report.
  PROFORMA: 'credit',
  MPESA: 'mpesa',
  CARD: 'card',
  AIRTEL: 'airtel_money',
  AIRTEL_MONEY: 'airtel_money',
  BANK: 'bank_transfer',
  BANK_TRANSFER: 'bank_transfer'
};

/** Returns null for an unrecognised tender so the caller can hold the sale. */
export function mapPaymentMethod(method) {
  return PAYMENT_METHOD_MAP[String(method || '').toUpperCase()] || null;
}

/** Booked at a rate of zero and carried as a percentage off, never sold. */
const STAFF_DISCOUNT_ID = 'prod-staff-discount';

/**
 * The staff discount, sent as what it actually is.
 *
 * It rides in the cart as a pseudo-product so the till can toggle it, and it
 * is booked at a rate of zero: the money it stands for sits in the sale's
 * header discount, not on any line. Sending it as a line asked the server to
 * price a product most tenants have no document for - the till creates that
 * record locally and nowhere else - so every discounted sale came back
 * "Product prod-staff-discount is not active for this tenant" and stuck in the
 * outbox forever.
 *
 * The line is dropped and its value spread across the real lines, which is
 * both what it means and what makes the server's total match the receipt.
 */
export function staffDiscountAsLineDiscounts(lines, sale) {
  const sellable = lines.filter((line) => line.product_id !== STAFF_DISCOUNT_ID);
  if (sellable.length === 0) return [];

  const gross = sellable.map((line) => toMinor((Number(line.unit_price) || 0) * line.qty));
  const own = sellable.map((line) => toMinor(line.discount));

  // Whatever the header takes off beyond the lines' own is the staff discount.
  let remaining = Math.max(0, toMinor(sale?.discount) - own.reduce((sum, value) => sum + value, 0));
  let remainingGross = gross.reduce((sum, value) => sum + value, 0);

  return sellable.map((line, index) => {
    const room = Math.max(0, gross[index] - own[index]);
    // The last line takes the rounding, so the parts sum to the whole.
    const share = index === sellable.length - 1
      ? Math.min(room, remaining)
      : Math.min(room, remainingGross > 0 ? Math.floor((remaining * gross[index]) / remainingGross) : 0);
    remaining -= share;
    remainingGross -= gross[index];

    return {
      productId: line.product_id,
      qty: line.qty,
      discountMinor: own[index] + share,
    };
  });
}
