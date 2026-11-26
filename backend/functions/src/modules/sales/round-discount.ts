import { inclusiveTax } from "../../shared/money";
import { TAX_BASIS_POINTS } from "./constants";

/**
 * The Staff 20% added to a round after it went out.
 *
 * A tab is billed round by round, and the 20% rung with one round never
 * covered the next, so a guest owed 20% on the whole tab was billed in full
 * for every round after the first. This puts the same 20% createSale accepts
 * (gross, without the table service charge) onto one existing round.
 */
type RoundLine = { productId: string; qty: number; unitPriceMinor: number; discountMinor: number; taxCode?: string };

const TABLE_SERVICE = "prod-table-service";

export function roundStaffDiscount(lines: readonly RoundLine[]) {
  const gross = (line: RoundLine) => line.unitPriceMinor * line.qty;
  const eligible = lines.filter((line) => line.productId !== TABLE_SERVICE);
  const eligibleMinor = eligible.reduce((sum, line) => sum + gross(line), 0);
  const discountMinor = Math.round(eligibleMinor * 0.20);

  // Each line's share, rounded down; the pennies left go to the largest lines.
  const shares = lines.map((line) => (line.productId === TABLE_SERVICE || eligibleMinor === 0
    ? 0 : Math.floor((discountMinor * gross(line)) / eligibleMinor)));
  let left = discountMinor - shares.reduce((sum, share) => sum + share, 0);
  const byGross = lines.map((line, index) => index)
    .filter((index) => lines[index].productId !== TABLE_SERVICE)
    .sort((a, b) => gross(lines[b]) - gross(lines[a]));
  for (let i = 0; left > 0 && byGross.length; i = (i + 1) % byGross.length, left -= 1) shares[byGross[i]] += 1;

  const result = lines.map((line, index) => {
    const lineTotalMinor = gross(line) - shares[index];
    const basisPoints = TAX_BASIS_POINTS[String(line.taxCode || "A") as keyof typeof TAX_BASIS_POINTS] ?? 0;
    return { ...line, discountMinor: shares[index], lineTotalMinor, taxMinor: inclusiveTax(lineTotalMinor, basisPoints) };
  });
  return {
    lines: result,
    discountMinor,
    totalMinor: result.reduce((sum, line) => sum + line.lineTotalMinor, 0),
    taxMinor: result.reduce((sum, line) => sum + line.taxMinor, 0),
  };
}

type SaleRecord = Record<string, unknown> & { checkoutExpiresAt?: { toMillis?: () => number } };
type PaymentRecord = { method?: unknown; amountMinor?: unknown; settledAt?: unknown; status?: unknown };

/** Why this round cannot take the 20% now, or null when it can. */
export function roundDiscountRefusal(sale: SaleRecord | undefined, payments: readonly PaymentRecord[], tenantId: string, nowMs: number): string | null {
  if (!sale || sale.tenantId !== tenantId) return "That round was not found.";
  if (sale.status === "VOIDED") return "That round was voided.";
  if (Number(sale.discountMinor || 0) > 0) return "That round already has a discount.";
  if (["signed", "fiscalized"].includes(String(sale.fiscalStatus || "").toLowerCase())) {
    return "That round is already signed with KRA; it needs a credit note instead.";
  }
  if (Number(sale.checkoutExpiresAt?.toMillis?.() || 0) > nowMs) return "Payment is in progress on this round. Finish or cancel it first.";
  const live = payments.filter((payment) => payment.status === undefined || ["completed", "paid", "success"].includes(String(payment.status)));
  if (!live.length || live.some((payment) => String(payment.method) !== "credit" || payment.settledAt)) {
    return "That round has already been paid, in part or in full. Add the discount before taking payment.";
  }
  return null;
}
