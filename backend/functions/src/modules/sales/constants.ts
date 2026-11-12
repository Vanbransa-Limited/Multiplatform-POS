export const MAX_DISTINCT_LINES = 50;
export const MAX_PAYMENTS = 5;
export const MAX_QTY_PER_LINE = 10_000;

// Every staff role can sell and use the standard staff preset. Custom
// checkout discounts require an owner, manager or provider authorization.
export const SELLING_ROLES = new Set([
  "owner",
  "store_manager",
  "supervisor",
  "cashier",
  "bar_staff",
  "store_keeper",
]);

export const DISCOUNT_ROLES = new Set(["owner", "store_manager"]);

export const PAYMENT_METHODS = new Set([
  "cash",
  "credit",
  "mpesa",
  "card",
  "airtel_money",
  "bank_transfer",
]);

/**
 * Methods this system can actually verify against a provider.
 *
 * A verified payment_intents document only exists where there is an
 * integration to produce one, and M-Pesa is the only one there is: the
 * mpesa module is the sole writer of that collection.
 *
 * This used to be written as "anything but cash and credit", which quietly
 * demanded provider proof for tenders no provider ever touches. A bank
 * transfer is a reference read off a statement and a card payment is a slip
 * from the terminal - both typed in by a person, with nothing on this side
 * able to check them. So every one was refused with "not verified or was
 * already consumed", and the money stayed on the till that took it.
 *
 * Recording them is an act of trust, and it is the only record obtainable;
 * `verified` on the settlement says which kind of record it is, and
 * Financials shows bank and card references as unverified for that reason.
 *
 * dependencies.ts and records.ts both walk the intent documents positionally,
 * so they have to agree on this predicate exactly - it lives here rather than
 * being spelled out twice.
 */
const PROVIDER_VERIFIED_METHODS = new Set(["mpesa"]);

export function needsProviderIntent(method: string, unverified = false): boolean {
  // An M-Pesa code typed when a tab was settled is recorded on the cashier's
  // word, exactly as settleSale records one it cannot match.
  return PROVIDER_VERIFIED_METHODS.has(method) && !unverified;
}

export const TAX_BASIS_POINTS = {
  A: 1_600,
  B: 800,
  C: 0,
  E: 0,
} as const;

export type SupportedTaxCode = keyof typeof TAX_BASIS_POINTS;
