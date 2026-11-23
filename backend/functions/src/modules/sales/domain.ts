import type { DocumentData, DocumentSnapshot } from "firebase-admin/firestore";
import { HttpsError } from "firebase-functions/v2/https";

import { inclusiveTax, safeSum } from "../../shared/money";
import { minorUnits } from "../../shared/validation";
import {
  DISCOUNT_ROLES,
  STAFF_PRESET_ROLES,
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
  // The till's VIP row represents 30% of the goods subtotal. Its catalogue
  // price is only a placeholder; using it changes an already prepared bill.
  const hasServiceCharge = requestedLines.some(line => line.productId === 'prod-table-service');
  const goodsSubtotal = hasServiceCharge ? safeSum(requestedLines.map((line, index) => {
    if (line.productId === 'prod-table-service' || line.productId === 'prod-staff-discount') return 0;
    const product = productDocuments[index]?.data() ?? {};
    return minorUnits(product.sellPriceMinor, `${line.productId}.sellPriceMinor`) * line.qty;
  }), 'service charge base') : 0;
  const serviceChargeMinor = Math.round(goodsSubtotal * 0.30);
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

    if (requested.productId === 'prod-table-service' && (requested.qty !== 1 || product.isService !== true)) {
      throw new HttpsError('invalid-argument', 'The table service charge must be a single service line.');
    }
    const unitPriceMinor = requested.productId === 'prod-table-service' ? serviceChargeMinor : minorUnits(
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

function standardStaffDiscountMinor(lines: readonly PreparedLine[]): number {
  const subtotalMinor = lines
    .filter(line => line.productId !== 'prod-table-service')
    .reduce((total, line) => total + line.unitPriceMinor * line.qty, 0);
  return Math.round(subtotalMinor * 0.20);
}

export function assertDiscountPermission(
  lines: readonly PreparedLine[],
  staffRole: unknown,
  providerAuthorized = false,
): void {
  // The till exposes the fixed staff preset to owners and managers. It is saved as
  // line discounts before a receivable can be paid, including by STK. Validate
  // that preset against server prices without requiring a payment intent.
  const discountMinor = lines.reduce((total, line) => total + line.discountMinor, 0);
  const standardStaffDiscount = STAFF_PRESET_ROLES.has(String(staffRole))
    && discountMinor > 0
    && discountMinor === standardStaffDiscountMinor(lines);
  if (
    lines.some((line) => line.discountMinor > 0)
    && !DISCOUNT_ROLES.has(String(staffRole))
    && !providerAuthorized
    && !standardStaffDiscount
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
  const membershipOnly = intent.membershipDiscountMinor === totalDiscountMinor
    && intent.baseAmountMinor === intent.amountMinor + totalDiscountMinor
    && intent.baseAmountMinor + intent.cashAmountMinor === subtotalMinor
    && exactIntentDiscounts(intent.lineDiscounts, lines);
  // A staff preset is already included in the amount sent to STK. Provider
  // membership discounts are applied afterwards and have separate line data.
  const staffPresetOnly = totalDiscountMinor > 0
    && totalDiscountMinor === standardStaffDiscountMinor(lines)
    && intent.membershipDiscountMinor === 0
    && intent.baseAmountMinor === intent.amountMinor
    && intent.baseAmountMinor + intent.cashAmountMinor === subtotalMinor - totalDiscountMinor
    && exactIntentDiscounts(intent.lineDiscounts, lines.map(line => ({ ...line, discountMinor: 0 })));

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
    && intent.cartGrossMinor === subtotalMinor
    && exactIntentLines(intent.lines, lines)
    && (membershipOnly || staffPresetOnly);
}

/**
 * Credit is not a tender a business accepts; it is the absence of one.
 *
 * A proforma books what is owed so the goods can leave and the money be
 * collected afterwards, and gating it on acceptedPaymentMethods made every
 * unpaid order permanently unsendable: provisioning seeds ["cash"], and the
 * settings screen cannot add "credit" because the rules do not allow that key.
 * So createSale refused every Pay Now order with failed-precondition - which
 * the till treats as permanent - and they queued on the device forever, unseen
 * by any other till and absent from every financial report.
 *
 * Who may hand out credit is a role question, answered before this point.
 */
const RECEIVABLE_METHODS = new Set(["credit"]);

export function assertAcceptedPayments(
  payments: readonly InputPayment[],
  settings: DocumentData,
): void {
  const acceptedMethods = Array.isArray(settings.acceptedPaymentMethods)
    ? settings.acceptedPaymentMethods
    : [];

  for (const payment of payments) {
    if (RECEIVABLE_METHODS.has(payment.method)) continue;
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
