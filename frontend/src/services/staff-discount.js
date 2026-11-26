/**
 * The Staff 20% Discount and the manager approval it needs.
 *
 * An owner or manager ringing the sale is their own approval. Anyone else adds
 * the discount as waiting, and a manager's code on the same screen approves it.
 * The server checks the approval again when the sale is created.
 */
export const STAFF_DISCOUNT_ID = 'prod-staff-discount';

export const selfApproves = (role) => role === 'Owner' || role === 'Manager';

export const staffDiscountItem = (cart) =>
  (cart || []).find((item) => item?.product?.id === STAFF_DISCOUNT_ID) || null;

/** True while the cart holds the discount and nobody has approved it yet. */
export function discountAwaitingCode(cart, role) {
  const item = staffDiscountItem(cart);
  return Boolean(item) && !selfApproves(role) && !item.approval?.id;
}

/** The approval a sale carries to the server, if its discount needed one. */
export const discountApprovalId = (cart) => staffDiscountItem(cart)?.approval?.id || null;

/**
 * The rounds of a bill that can still take the Staff 20% after they went out:
 * not voided, no discount yet, and nothing paid against them. `outstandingMinor`
 * maps each round's id to what it still owes.
 */
export function discountableRounds(rounds, outstandingMinor) {
  return (rounds || []).filter((round) => round.status !== 'VOIDED'
    && !(Number(round.discount) > 0)
    && (outstandingMinor.get(round.id) || 0) > 0
    && outstandingMinor.get(round.id) === Math.round((Number(round.grand_total) || 0) * 100));
}
