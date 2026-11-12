/**
 * What was actually taken, read from the payments ledger.
 *
 * The reports screen split tenders on `sale.payment_method` and filtered on
 * `sale.created_at` - neither field is written by the till, so every payment
 * breakdown read zero over an empty period. The ledger is the only place a
 * tender is recorded, so both money screens now read it through here.
 *
 * Kept free of Dexie so the arithmetic can be exercised in a plain node test.
 */

/** Booked as a sale but not yet money: proforma invoices and on-account credit. */
export const RECEIVABLE_METHODS = new Set(['CREDIT', 'PROFORMA']);

export function isReceivable(method) {
  return RECEIVABLE_METHODS.has(String(method || '').toUpperCase());
}

/** Sales are stamped sold_at; server-pulled rows may only carry created_at. */
export function saleTimestamp(sale) {
  return new Date(sale?.sold_at || sale?.created_at || 0).getTime() || 0;
}

/**
 * Splits a set of payment rows by tender.
 *
 * A receivable is deliberately kept out of `collected`: a proforma prints and
 * the goods leave, but nobody has paid yet, and counting it as cash in hand is
 * how a drawer reconciles short.
 */
export function tenderTotals(payments) {
  const totals = { cash: 0, mpesa: 0, other: 0, receivable: 0, collected: 0 };

  for (const payment of payments || []) {
    const method = String(payment?.method || '').toUpperCase();
    const amount = Number(payment?.amount) || 0;

    // A receivable that has been settled is not still owed, and the money that
    // cleared it is its own row under the tender that actually arrived. Kept
    // out of both buckets here so settling a proforma cannot count twice.
    if (isReceivable(method) && payment?.settled_at) continue;
    if (isReceivable(method)) totals.receivable += amount;
    else if (method === 'CASH') totals.cash += amount;
    else if (method.includes('MPESA')) totals.mpesa += amount;
    // Card, bank and anything added later. Dropping these made the split
    // quietly disagree with what was taken.
    else totals.other += amount;
  }

  totals.collected = totals.cash + totals.mpesa + totals.other;
  return totals;
}
