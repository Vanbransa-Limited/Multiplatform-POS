/** Drafts survive reloads and navigation in the same browser tab. Restoring a
 * draft never creates a sale or confirms a payment.
 */
export function tillDraftKey({ tenantId, staffId, branchId }) {
  if (!tenantId || !staffId || !branchId) return null;
  return `pos_till_draft_v1:${JSON.stringify([tenantId, staffId, branchId])}`;
}

export function readTillDraft(storage, key) {
  if (!key) return null;
  const raw = storage.getItem(key);
  if (!raw) return null;
  const draft = JSON.parse(raw);
  if (draft.version !== 1 || !Array.isArray(draft.cart) || !Array.isArray(draft.parkedCarts)) {
    throw new Error('The saved till draft could not be read.');
  }
  return draft;
}

export function writeTillDraft(storage, key, draft) {
  if (!key) return;
  const cart = rows => rows.map(row => ({ ...row, product: {
    ...row.product, image_data: String(row.product?.image_data || '').startsWith('data:') ? null : row.product?.image_data,
  } }));
  storage.setItem(key, JSON.stringify({ ...draft, version: 1, cart: cart(draft.cart),
    parkedCarts: draft.parkedCarts.map(parked => ({ ...parked, cart: cart(parked.cart) })),
  }));
}
