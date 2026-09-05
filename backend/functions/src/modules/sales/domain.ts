import type { DocumentData, DocumentSnapshot } from "firebase-admin/firestore";
import { HttpsError } from "firebase-functions/v2/https";

import { inclusiveTax, safeSum } from "../../shared/money";
import { minorUnits } from "../../shared/validation";
import {
  DISCOUNT_ROLES,
  TAX_BASIS_POINTS,
  type SupportedTaxCode,
} from "./constants";
import type {
  InputLine,
  InputPayment,
  ParsedSaleInput,
  PreparedLine,
  SaleTotals,
} from "./types";

function supportedTaxCode(value: unknown, productId: string): SupportedTaxCode {
  if (
    typeof value !== "string"
    || !Object.prototype.hasOwnProperty.call(TAX_BASIS_POINTS, value)
  ) {
    throw new HttpsError(
      "failed-precondition",
      `Product ${productId} does not have a supported tax code.`,
    );
  }

  return value as SupportedTaxCode;
}

export function prepareSaleLines(
  requestedLines: readonly InputLine[],
  productDocuments: readonly DocumentSnapshot<DocumentData>[],
  tenantId: string,
): PreparedLine[] {
  return productDocuments.map((snapshot, index) => {
    const requested = requestedLines[index];
    const product = snapshot.data() ?? {};
    if (
      !snapshot.exists
      || product.tenantId !== tenantId
      || product.isActive !== true
    ) {
      throw new HttpsError(
        "failed-precondition",
        `Product ${requested.productId} is not active for this tenant.`,
      );
    }

    const unitPriceMinor = minorUnits(
      product.sellPriceMinor,
      `${requested.productId}.sellPriceMinor`,
    );
    const lineSubtotal = unitPriceMinor * requested.qty;
    if (!Number.isSafeInteger(lineSubtotal) || requested.discountMinor > lineSubtotal) {
      throw new HttpsError(
        "invalid-argument",
        `The discount or total for ${requested.productId} is invalid.`,
      );
    }

    const lineTotalMinor = lineSubtotal - requested.discountMinor;
    const taxCode = supportedTaxCode(product.taxCode, requested.productId);
    return {
      productId: requested.productId,
      sku: typeof product.sku === "string" ? product.sku : "",
      productName: typeof product.name === "string" ? product.name : "",
      qty: requested.qty,
      unitPriceMinor,
      discountMinor: requested.discountMinor,
      taxCode,
      taxMinor: inclusiveTax(lineTotalMinor, TAX_BASIS_POINTS[taxCode]),
      lineTotalMinor,
      isService: product.isService === true,
    };
  });
}

export function calculateSaleTotals(
  lines: readonly PreparedLine[],
  payments: readonly InputPayment[],
): SaleTotals {
  const subtotalMinor = safeSum(
    lines.map((line) => line.unitPriceMinor * line.qty),
    "subtotalMinor",
  );
  const discountMinor = safeSum(
    lines.map((line) => line.discountMinor),
    "discountMinor",
  );
  const taxMinor = safeSum(lines.map((line) => line.taxMinor), "taxMinor");
  const totalMinor = subtotalMinor - discountMinor;
  const paymentTotalMinor = safeSum(
    payments.map((payment) => payment.amountMinor),
    "payment total",
  );
  if (paymentTotalMinor !== totalMinor) {
    throw new HttpsError(
      "invalid-argument",
      "Payment amounts must exactly equal the sale total.",
    );
  }

  return { subtotalMinor, discountMinor, taxMinor, totalMinor };
}

export function assertDiscountPermission(
  lines: readonly PreparedLine[],
  staffRole: unknown,
  providerAuthorized = false,
): void {
  if (
    lines.some((line) => line.discountMinor > 0)
    && !DISCOUNT_ROLES.has(String(staffRole))
    && !providerAuthorized
  ) {
    throw new HttpsError(
      "permission-denied",
      "This staff role cannot apply checkout discounts.",
    );
  }
}

function exactIntentLines(
  value: unknown,
  lines: readonly PreparedLine[],
): boolean {
  if (!Array.isArray(value) || value.length !== lines.length) return false;
  const expected = new Map(lines.map((line) => [line.productId, line.qty]));
  const seen = new Set<string>();
  for (const raw of value) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return false;
    const line = raw as Record<string, unknown>;
    if (
      typeof line.productId !== "string"
      || seen.has(line.productId)
      || !Number.isSafeInteger(line.qty)
      || expected.get(line.productId) !== line.qty
    ) return false;
    seen.add(line.productId);
  }
  return seen.size === expected.size;
}

function exactIntentDiscounts(
  value: unknown,
  lines: readonly PreparedLine[],
): boolean {
  if (!Array.isArray(value) || value.length !== lines.length) return false;
  const expected = new Map(lines.map((line) => [line.productId, line.discountMinor]));
  const seen = new Set<string>();
  for (const raw of value) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return false;
    const line = raw as Record<string, unknown>;
    if (
      typeof line.productId !== "string"
      || seen.has(line.productId)
      || !Number.isSafeInteger(line.discountMinor)
      || expected.get(line.productId) !== line.discountMinor
    ) return false;
    seen.add(line.productId);
  }
  return seen.size === expected.size;
}

/**
 * A frontline cashier may submit a discount only when a verified M-Pesa
 * intent authorized this exact cart and tender split. This is deliberately
 * stricter than merely matching the receipt amount: otherwise a membership
 * benefit could be moved to another customer, product, branch, or cashier.
 */
export function hasProviderAuthorizedDiscount(
  input: ParsedSaleInput,
  lines: readonly PreparedLine[],
  paymentIntentDocuments: readonly DocumentSnapshot<DocumentData>[],
): boolean {
  const totalDiscountMinor = lines.reduce(
    (total, line) => total + line.discountMinor,
    0,
  );
  if (!Number.isSafeInteger(totalDiscountMinor) || totalDiscountMinor <= 0) return false;

  const candidates = paymentIntentDocuments
    .map((document) => document.data() ?? {})
    .filter((intent) => Number(intent.membershipDiscountMinor) > 0);
  if (candidates.length !== 1) return false;

  const intent = candidates[0];
  const matchingPayments = input.payments.filter(
    (payment) => payment.method === "mpesa"
      && payment.reference === intent.reference,
  );
  if (matchingPayments.length !== 1) return false;
  return mpesaIntentMatchesSale(input, lines, intent, matchingPayments[0])
    && Number.isSafeInteger(intent.membershipDiscountBasisPoints)
    && intent.membershipDiscountBasisPoints > 0
    && (intent.membershipDiscountSource === "membership"
      || intent.membershipDiscountSource === "customer");
}

/** Every M-Pesa receipt is scoped to the cart that raised its STK prompt. */
export function mpesaIntentMatchesSale(
  input: ParsedSaleInput,
  lines: readonly PreparedLine[],
  intent: DocumentData,
  matchedPayment: InputPayment,
): boolean {
  const totalDiscountMinor = lines.reduce(
    (total, line) => total + line.discountMinor,
    0,
  );
  if (!Number.isSafeInteger(totalDiscountMinor)) return false;

  const otherPayments = input.payments.filter((payment) => payment !== matchedPayment);
  const otherPaymentMinor = otherPayments.reduce(
    (total, payment) => total + payment.amountMinor,
    0,
  );
  const subtotalMinor = lines.reduce(
    (total, line) => total + line.unitPriceMinor * line.qty,
    0,
  );

  return matchedPayment.method === "mpesa"
    && matchedPayment.reference === intent.reference
    && matchedPayment.amountMinor === intent.amountMinor
    && otherPayments.every((payment) => payment.method === "cash")
    && Number.isSafeInteger(otherPaymentMinor)
    && otherPaymentMinor === intent.cashAmountMinor
    && intent.tenantId === input.tenantId
    && intent.branchId === input.branchId
    && intent.deviceId === input.deviceId
    && intent.authorizedStaffId === input.staffId
    && intent.customerId === input.customerId
    && intent.method === "mpesa"
    && intent.status === "verified"
    && !intent.consumedSaleId
    && intent.membershipDiscountMinor === totalDiscountMinor
    && intent.cartGrossMinor === subtotalMinor
    && intent.baseAmountMinor === intent.amountMinor + totalDiscountMinor
    && intent.baseAmountMinor + intent.cashAmountMinor === subtotalMinor
    && exactIntentLines(intent.lines, lines)
    && exactIntentDiscounts(intent.lineDiscounts, lines);
}

export function assertAcceptedPayments(
  payments: readonly InputPayment[],
  settings: DocumentData,
): void {
  const acceptedMethods = Array.isArray(settings.acceptedPaymentMethods)
    ? settings.acceptedPaymentMethods
    : [];

  for (const payment of payments) {
    if (
      !acceptedMethods.includes(payment.method)
      || (payment.method === "cash" && settings.cashEnabled !== true)
    ) {
      throw new HttpsError(
        "failed-precondition",
        `${payment.method} is not enabled for this tenant.`,
      );
    }
  }
}
