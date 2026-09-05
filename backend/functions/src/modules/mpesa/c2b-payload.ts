import { deterministicId } from "../../shared/identifiers";
import { MAX_MINOR_UNITS } from "../../shared/validation";

const TRANSACTION_ID = /^[A-Za-z0-9_-]{1,64}$/;
const TRANSACTION_TIME = /^\d{14}$/;
const SHORTCODE = /^\d{5,12}$/;
const ACCOUNT_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const KENYAN_MSISDN = /^254[17]\d{8}$/;

const WIRE_FIELDS = [
  "TransactionType",
  "TransID",
  "TransTime",
  "TransAmount",
  "BusinessShortCode",
  "BillRefNumber",
  "InvoiceNumber",
  "OrgAccountBalance",
  "ThirdPartyTransID",
  "MSISDN",
] as const;

export type C2bRejectionCode =
  | "C2B00011"
  | "C2B00012"
  | "C2B00013"
  | "C2B00014"
  | "C2B00015"
  | "C2B00016";

export interface C2bPayload {
  transactionType: string;
  transactionId: string;
  transactionTime: string;
  amountMinor: number;
  businessShortCode: string;
  accountReference: string;
  invoiceNumber: string | null;
  orgAccountBalanceMinor: number | null;
  thirdPartyTransactionId: string | null;
  msisdn: string;
}

export type C2bPayloadParseResult =
  | { ok: true; payload: C2bPayload }
  | { ok: false; code: C2bRejectionCode; reason: string };

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/**
 * Daraja sometimes serializes digit-only fields as JSON numbers. They remain
 * safe at these lengths, but no trimming or punctuation normalization is done:
 * routing fields must match the server-owned configuration exactly.
 */
function wireString(value: unknown): string | null {
  if (typeof value === "string") {
    return value === value.trim() ? value : null;
  }
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? String(value)
    : null;
}

function optionalWireString(value: unknown, maxLength: number): string | null | undefined {
  if (value === undefined || value === null || value === "") return null;
  const parsed = wireString(value);
  if (parsed === null || parsed.length > maxLength || /[\u0000-\u001f\u007f]/.test(parsed)) {
    return undefined;
  }
  return parsed;
}

/** Parse a decimal KES amount without letting Number("") become zero. */
function decimalMinor(value: unknown, allowZero: boolean): number | null {
  const serialized = typeof value === "number" && Number.isFinite(value)
    ? String(value)
    : typeof value === "string" && value === value.trim()
      ? value
      : "";
  const match = /^(0|[1-9]\d{0,10})(?:\.(\d{1,2}))?$/.exec(serialized);
  if (!match) return null;

  const whole = Number(match[1]);
  const fraction = Number((match[2] ?? "").padEnd(2, "0"));
  const amountMinor = whole * 100 + fraction;
  if (
    !Number.isSafeInteger(amountMinor)
    || amountMinor > MAX_MINOR_UNITS
    || (allowZero ? amountMinor < 0 : amountMinor <= 0)
  ) {
    return null;
  }
  return amountMinor;
}

/**
 * Strictly parses the common Validation/Confirmation C2B envelope.
 *
 * Names are intentionally not retained: they are unnecessary for routing and
 * would add customer PII to an immutable event. Unknown fields are ignored.
 */
export function parseC2bPayloadResult(body: unknown): C2bPayloadParseResult {
  const input = record(body);
  if (!input) {
    return { ok: false, code: "C2B00013", reason: "malformed_payload" };
  }

  const transactionId = wireString(input.TransID);
  const transactionTime = wireString(input.TransTime);
  const transactionType = wireString(input.TransactionType);
  if (
    transactionId === null
    || !TRANSACTION_ID.test(transactionId)
    || transactionTime === null
    || !TRANSACTION_TIME.test(transactionTime)
    || transactionType === null
    || transactionType.length === 0
    || transactionType.length > 32
  ) {
    return { ok: false, code: "C2B00013", reason: "invalid_transaction" };
  }

  const amountMinor = decimalMinor(input.TransAmount, false);
  if (amountMinor === null) {
    return { ok: false, code: "C2B00012", reason: "invalid_amount" };
  }

  const businessShortCode = wireString(input.BusinessShortCode);
  if (businessShortCode === null || !SHORTCODE.test(businessShortCode)) {
    return { ok: false, code: "C2B00015", reason: "invalid_shortcode" };
  }

  const accountReference = wireString(input.BillRefNumber);
  if (accountReference === null || !ACCOUNT_REFERENCE.test(accountReference)) {
    return { ok: false, code: "C2B00011", reason: "invalid_account_reference" };
  }

  const msisdn = wireString(input.MSISDN);
  if (msisdn === null || !KENYAN_MSISDN.test(msisdn)) {
    return { ok: false, code: "C2B00014", reason: "invalid_msisdn" };
  }

  const invoiceNumber = optionalWireString(input.InvoiceNumber, 128);
  const thirdPartyTransactionId = optionalWireString(input.ThirdPartyTransID, 128);
  if (invoiceNumber === undefined || thirdPartyTransactionId === undefined) {
    return { ok: false, code: "C2B00013", reason: "invalid_transaction" };
  }

  const orgAccountBalanceMinor = input.OrgAccountBalance === undefined
    || input.OrgAccountBalance === null
    || input.OrgAccountBalance === ""
    ? null
    : decimalMinor(input.OrgAccountBalance, true);

  return {
    ok: true,
    payload: {
      transactionType,
      transactionId,
      transactionTime,
      amountMinor,
      businessShortCode,
      accountReference,
      invoiceNumber,
      // The balance is informational and is never used to accept a payment.
      // If Safaricom changes its formatting, preserve the useful transaction
      // while omitting this non-routing value.
      orgAccountBalanceMinor,
      thirdPartyTransactionId,
      msisdn,
    },
  };
}

/** Mirrors parseStkCallback's convenient nullable form for pure unit tests. */
export function parseC2bPayload(body: unknown): C2bPayload | null {
  const result = parseC2bPayloadResult(body);
  return result.ok ? result.payload : null;
}

export function c2bPayloadFingerprint(payload: C2bPayload): string {
  return deterministicId("payload", JSON.stringify(payload));
}

/** Fields that must agree between Validation and Confirmation callbacks. */
export function c2bRoutingFingerprint(payload: C2bPayload): string {
  return deterministicId("route", JSON.stringify({
    transactionType: payload.transactionType,
    transactionId: payload.transactionId,
    transactionTime: payload.transactionTime,
    amountMinor: payload.amountMinor,
    businessShortCode: payload.businessShortCode,
    accountReference: payload.accountReference,
    msisdn: payload.msisdn,
  }));
}

/** A bounded, PII-free identity for an envelope too malformed to parse. */
export function malformedC2bFingerprint(body: unknown): string {
  const input = record(body);
  const values = WIRE_FIELDS.map((field) => {
    const value = input?.[field];
    if (value === null || ["string", "number", "boolean"].includes(typeof value)) {
      return [field, String(value).slice(0, 128)];
    }
    return [field, typeof value];
  });
  return deterministicId("payload", JSON.stringify(values));
}
