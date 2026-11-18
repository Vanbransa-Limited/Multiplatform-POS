/**
 * The arithmetic behind the stock actions sheet, kept free of the DOM so it
 * can be tested. Each returns either a result or an `error` sentence for the
 * person at the screen.
 */

const whole = (value) => {
  const text = String(value ?? '').trim();
  return /^\d+$/.test(text) ? Number(text) : null;
};

/** Add or remove N becomes the exact count the server is asked to set. */
export function adjustTarget(current, direction, amount) {
  const n = whole(amount);
  if (!n) return { error: 'Enter a whole number of 1 or more.' };
  if (direction === 'remove' && n > current) return { error: `Only ${current} on hand, so ${n} cannot be removed.` };
  return { qty: direction === 'remove' ? current - n : current + n };
}

/** Rows for a stock take: blanks were not counted, anything else must be a whole number. */
export function stockTakeRows(items, counted) {
  const rows = [];
  for (const item of items) {
    const raw = String(counted[item.id] ?? '').trim();
    if (!raw) continue;
    const qty = whole(raw);
    if (qty === null) return { error: `"${raw}" for ${item.name} is not a whole number.` };
    rows.push({ productId: item.id, name: item.name, qty });
  }
  return rows.length ? { rows } : { error: 'Enter at least one count.' };
}

/** An existing product with this name or SKU; creating it again would overwrite that one. */
export function findDuplicate(products, name, sku) {
  const key = (value) => String(value ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
  const wantedName = key(name);
  const wantedSku = key(sku);
  return products.find((product) => (wantedName && key(product.name) === wantedName)
    || (wantedSku && key(product.sku) === wantedSku));
}
