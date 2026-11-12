/**
 * Safaricom Daraja wire helpers.
 *
 * Everything that speaks to Safaricom lives here so the triggers in index.ts
 * stay about auth, storage, and idempotency. The pure helpers take their inputs
 * as arguments (never off a secret) so they can be tested without a runtime.
 */

import { logger } from "firebase-functions";
import { defineSecret } from "firebase-functions/params";
import { HttpsError } from "firebase-functions/v2/https";

// Sandbox is https://sandbox.safaricom.co.ke, production is
// https://api.safaricom.co.ke. Held as a secret purely so one mechanism sets
// every M-Pesa value; flipping sandbox to live is a set + redeploy, not a diff.
export const MPESA_BASE_URL = defineSecret("MPESA_BASE_URL");
export const MPESA_CONSUMER_KEY = defineSecret("MPESA_CONSUMER_KEY");
export const MPESA_CONSUMER_SECRET = defineSecret("MPESA_CONSUMER_SECRET");
export const MPESA_SHORTCODE = defineSecret("MPESA_SHORTCODE");
export const MPESA_PASSKEY = defineSecret("MPESA_PASSKEY");
export const MPESA_CALLBACK_URL = defineSecret("MPESA_CALLBACK_URL");

export const MPESA_SECRETS = [
  MPESA_BASE_URL,
  MPESA_CONSUMER_KEY,
  MPESA_CONSUMER_SECRET,
  MPESA_SHORTCODE,
  MPESA_PASSKEY,
  MPESA_CALLBACK_URL,
];

const KENYAN_MSISDN = /^(?:254|0)?([17]\d{8})$/;
const ROUTING_NUMBER = /^\d{5,12}$/;
const DOCUMENT_ID = /^[A-Za-z0-9_-]{1,128}$/;
const RECEIPT_NUMBER = /^[A-Za-z0-9]{6,32}$/;

export type MpesaLifecycle = "staged" | "live" | "suspended";
export type MpesaEnvironment = "sandbox" | "production";
export type StkTransactionType =
  | "CustomerBuyGoodsOnline"
  | "CustomerPayBillOnline";

export interface MpesaConfig {
  lifecycle: MpesaLifecycle;
  environment: MpesaEnvironment;
  transactionType: StkTransactionType;
  partyB: string;
  accountReference: string;
  allowedBranchIds: string[] | null;
}

export interface StkAttemptMatch {
  checkoutRequestId: string;
  merchantRequestId: string;
  amountMinor: number;
  phone: string;
}

export interface StkCallback {
  checkoutRequestId: string;
  merchantRequestId: string | null;
  resultCode: number;
  resultDesc: string;
  receipt: string | null;
  amountMinor: number | null;
  phone: string | null;
}

/** Missing or malformed configuration is deliberately non-live. */
export function parseMpesaLifecycle(value: unknown): MpesaLifecycle {
  return value === "live" || value === "suspended" ? value : "staged";
}

/**
 * Reads the non-secret routing document stored at mpesa_configs/{tenantId}.
 * Secrets and the parent BusinessShortCode remain in Secret Manager.
 */
export function parseMpesaConfig(value: unknown): MpesaConfig | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const config = value as Record<string, unknown>;
  const transactionType = config.transactionType;
  const environment = config.environment;
  if (environment !== "sandbox" && environment !== "production") return null;
  if (
    transactionType !== "CustomerBuyGoodsOnline"
    && transactionType !== "CustomerPayBillOnline"
  ) {
    return null;
  }

  const partyB = typeof config.partyB === "string" ? config.partyB.trim() : "";
  const accountReference = typeof config.accountReference === "string"
    ? config.accountReference.trim()
    : "";
  if (!ROUTING_NUMBER.test(partyB) || accountReference.length < 1 || accountReference.length > 12) {
    return null;
  }

  let allowedBranchIds: string[] | null = null;
  if (config.allowedBranchIds !== undefined && config.allowedBranchIds !== null) {
    if (
      !Array.isArray(config.allowedBranchIds)
      || config.allowedBranchIds.some((id) => typeof id !== "string" || !DOCUMENT_ID.test(id))
    ) {
      return null;
    }
    allowedBranchIds = [...new Set(config.allowedBranchIds as string[])];
  }

  return {
    lifecycle: parseMpesaLifecycle(config.lifecycle),
    environment,
    transactionType,
    partyB,
    accountReference,
    allowedBranchIds,
  };
}

/** Safaricom only accepts 2547XXXXXXXX / 2541XXXXXXXX on the wire. */
export function normalizePhone(raw: unknown): string {
  const digits = typeof raw === "string" ? raw.replace(/[\s+()-]/g, "") : "";
  const match = KENYAN_MSISDN.exec(digits);
  if (!match) {
    throw new HttpsError(
      "invalid-argument",
      "Enter the number as 07XXXXXXXX, 01XXXXXXXX, or 2547XXXXXXXX.",
    );
  }

  return `254${match[1]}`;
}

/** Daraja caps AccountReference at 12 characters. */
export function sanitizeAccountReference(raw: string, fallback: string): string {
  const sanitized = raw
    .trim()
    .replace(/\s+/g, "_")
    .replace(/[^A-Za-z0-9_-]/g, "")
    .slice(0, 12);
  return sanitized || fallback.slice(0, 12);
}

/**
 * Daraja stamps are Nairobi local time (UTC+3, no DST). The STK password is
 * built from this exact string, so both must come from one call or Safaricom
 * rejects the request as a bad password rather than a bad clock.
 */
export function darajaTimestamp(now: Date): string {
  const nairobi = new Date(now.getTime() + 3 * 60 * 60 * 1_000);
  return nairobi.toISOString().slice(0, 19).replace(/[-:T]/g, "");
}

export function stkPassword(
  shortcode: string,
  passkey: string,
  timestamp: string,
): string {
  return Buffer.from(`${shortcode}${passkey}${timestamp}`).toString("base64");
}

/**
 * Reads the STK result Safaricom POSTs to the callback URL.
 *
 * A cancelled or failed push carries no CallbackMetadata at all, so anything
 * that reaches for the receipt before checking ResultCode crashes on every
 * declined payment. Returns null when the body is not an STK callback.
 */
export function parseStkCallback(body: unknown): StkCallback | null {
  const callback = (body as Record<string, any>)?.Body?.stkCallback;
  if (typeof callback !== "object" || callback === null) return null;
  if (
    typeof callback.CheckoutRequestID !== "string"
    || callback.CheckoutRequestID.length < 1
    || callback.CheckoutRequestID.length > 128
  ) return null;
  if (
    typeof callback.ResultCode !== "number"
    || !Number.isSafeInteger(callback.ResultCode)
    || callback.ResultCode < 0
  ) return null;

  const items: unknown[] = Array.isArray(callback.CallbackMetadata?.Item)
    ? callback.CallbackMetadata.Item
    : [];
  const item = (name: string): unknown =>
    (items as Record<string, unknown>[]).find((entry) => entry?.Name === name)?.Value;

  const amount = item("Amount");
  const phone = item("PhoneNumber");
  const receipt = item("MpesaReceiptNumber");

  return {
    checkoutRequestId: callback.CheckoutRequestID,
    merchantRequestId: typeof callback.MerchantRequestID === "string"
      ? callback.MerchantRequestID
      : null,
    resultCode: callback.ResultCode,
    resultDesc: typeof callback.ResultDesc === "string" ? callback.ResultDesc : "",
    receipt: typeof receipt === "string" && receipt.trim()
      ? receipt.trim().toUpperCase()
      : null,
    // Daraja quotes whole shillings; the ledger is in cents throughout.
    amountMinor: typeof amount === "number" ? Math.round(amount * 100) : null,
    phone: phone === undefined || phone === null ? null : String(phone),
  };
}

/**
 * A callback is an unauthenticated claim. It may only trigger verification
 * when every identifier Safaricom supplied agrees with the attempt we sent.
 */
export function callbackMismatchReason(
  callback: StkCallback,
  attempt: StkAttemptMatch,
): string | null {
  if (callback.checkoutRequestId !== attempt.checkoutRequestId) {
    return "checkout_request_mismatch";
  }
  if (
    callback.merchantRequestId === null
    || callback.merchantRequestId !== attempt.merchantRequestId
  ) {
    return "merchant_request_mismatch";
  }

  if (callback.amountMinor !== null && callback.amountMinor !== attempt.amountMinor) {
    return "amount_mismatch";
  }
  if (callback.phone !== null) {
    try {
      if (normalizePhone(callback.phone) !== attempt.phone) return "phone_mismatch";
    } catch {
      return "phone_mismatch";
    }
  }

  if (callback.resultCode === 0) {
    if (callback.amountMinor === null) return "success_missing_amount";
    if (callback.phone === null) return "success_missing_phone";
    if (callback.receipt === null || !RECEIPT_NUMBER.test(callback.receipt)) {
      return "success_missing_receipt";
    }
  }

  return null;
}

async function darajaFetch(
  path: string,
  init: RequestInit,
): Promise<Record<string, unknown>> {
  const url = `${darajaBaseUrl()}${path}`;
  // Without a deadline a stalled Safaricom connection holds the instance until
  // the function times out, and the cashier is left staring at a spinner.
  // A rejected fetch - DNS, a refused connection, a timed-out deadline - never
  // reached the check below, so nothing was logged and the only trace left was
  // "initiation did not complete". The cause is the one thing worth keeping.
  let response;
  try {
    response = await fetch(url, { ...init, signal: AbortSignal.timeout(15_000) });
  } catch (error) {
    logger.error("Daraja could not be reached", {
      path,
      // The message and name only: never the body, which carries credentials.
      cause: error instanceof Error ? `${error.name}: ${error.message}` : "unknown",
    });
    throw new HttpsError("unavailable", "M-Pesa is not responding. Take the payment another way.");
  }
  const text = await response.text();

  let payload: unknown = null;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = null;
  }

  if (!response.ok || typeof payload !== "object" || payload === null) {
    logger.error("Daraja call failed", { path, status: response.status });
    throw new HttpsError("unavailable", "M-Pesa is not responding. Take the payment another way.");
  }

  return payload as Record<string, unknown>;
}

function darajaBaseUrl(): string {
  const baseUrl = MPESA_BASE_URL.value().replace(/\/$/, "");
  if (
    baseUrl === "https://sandbox.safaricom.co.ke"
    || baseUrl === "https://api.safaricom.co.ke"
  ) {
    return baseUrl;
  }

  const emulatorLoopback = process.env.FUNCTIONS_EMULATOR === "true"
    && /^http:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?$/.test(baseUrl);
  if (emulatorLoopback) return baseUrl;

  throw new HttpsError("failed-precondition", "The M-Pesa API endpoint is not approved.");
}

function darajaEnvironment(): MpesaEnvironment {
  const baseUrl = darajaBaseUrl();
  if (baseUrl === "https://api.safaricom.co.ke") return "production";
  // The official sandbox and an emulator-only loopback are non-money
  // environments for the purpose of this tenant route gate.
  return "sandbox";
}

function businessShortcode(): string {
  const shortcode = MPESA_SHORTCODE.value().trim();
  if (!ROUTING_NUMBER.test(shortcode)) {
    throw new HttpsError("failed-precondition", "The M-Pesa BusinessShortCode is invalid.");
  }
  return shortcode;
}

// Daraja tokens live 3599s. Caching per warm instance keeps the customer from
// waiting on two round trips instead of one.
let cachedToken: { value: string; expiresAt: number } | null = null;

export async function darajaToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now()) return cachedToken.value;

  const basic = Buffer.from(
    `${MPESA_CONSUMER_KEY.value()}:${MPESA_CONSUMER_SECRET.value()}`,
  ).toString("base64");
  const payload = await darajaFetch("/oauth/v1/generate?grant_type=client_credentials", {
    headers: { Authorization: `Basic ${basic}` },
  });

  const token = payload.access_token;
  if (typeof token !== "string" || token.length === 0) {
    throw new HttpsError("unavailable", "M-Pesa returned no access token.");
  }

  const ttlSeconds = Number(payload.expires_in);
  cachedToken = {
    value: token,
    expiresAt: Date.now()
      + (Number.isFinite(ttlSeconds) ? ttlSeconds : 3_599) * 1_000
      - 60_000,
  };

  return token;
}

/**
 * Reads a ResultCode, which the callback sends as a number and the query
 * endpoint as a string.
 *
 * Returns null for anything unreadable. This must never fall back to a bare
 * Number() cast: Number("") and Number(null) are both 0, and 0 is the code for
 * a successful payment, so an empty field would settle an unpaid sale as paid.
 */
export function parseResultCode(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  }
  if (typeof value !== "string" || value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

/**
 * Asks Safaricom what actually happened to a push.
 *
 * This is the reconciliation path for a callback that never arrived. Returns
 * null while Safaricom still reports the transaction as in flight, so a slow
 * customer is never recorded as a failure.
 */
export async function stkQuery(checkoutRequestId: string): Promise<{
  resultCode: number;
  resultDesc: string;
} | null> {
  const shortcode = businessShortcode();
  const timestamp = darajaTimestamp(new Date());

  const response = await fetch(`${darajaBaseUrl()}/mpesa/stkpushquery/v1/query`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${await darajaToken()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      BusinessShortCode: shortcode,
      Password: stkPassword(shortcode, MPESA_PASSKEY.value(), timestamp),
      Timestamp: timestamp,
      CheckoutRequestID: checkoutRequestId,
    }),
    signal: AbortSignal.timeout(15_000),
  });

  const text = await response.text();
  let payload: Record<string, unknown> | null = null;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = null;
  }

  // Safaricom answers 500 with errorCode 500.001.1001 while the customer still
  // has the PIN prompt open. That is "not yet", not a failure.
  if (!response.ok || payload === null) {
    logger.info("STK query still in flight", {
      checkoutRequestId,
      status: response.status,
    });
    return null;
  }

  const resultCode = parseResultCode(payload.ResultCode);
  if (resultCode === null) return null;

  return { resultCode, resultDesc: String(payload.ResultDesc ?? "") };
}

export interface StkPushResult {
  checkoutRequestId: string;
  merchantRequestId: string;
  customerMessage: string;
}

export interface StkPayloadInput {
  lifecycle: MpesaLifecycle;
  environment: MpesaEnvironment;
  transactionType: StkTransactionType;
  partyB: string;
  phone: string;
  amountKes: number;
  accountReference: string;
  description: string;
}

export function buildStkPayload(input: StkPayloadInput & {
  businessShortCode: string;
  passkey: string;
  timestamp: string;
  callbackUrl: string;
}): Record<string, unknown> {
  if (input.lifecycle !== "live") {
    throw new HttpsError("failed-precondition", "M-Pesa is configured but not active.");
  }
  if (!ROUTING_NUMBER.test(input.businessShortCode) || !ROUTING_NUMBER.test(input.partyB)) {
    throw new HttpsError("failed-precondition", "The M-Pesa route is invalid.");
  }
  if (
    input.accountReference.length < 1
    || input.accountReference.length > 12
    || !/^[A-Za-z0-9_-]+$/.test(input.accountReference)
  ) {
    throw new HttpsError("failed-precondition", "The M-Pesa account reference is invalid.");
  }
  if (
    input.transactionType === "CustomerPayBillOnline"
    && input.partyB !== input.businessShortCode
  ) {
    throw new HttpsError(
      "failed-precondition",
      "A Paybill route must use the BusinessShortCode as PartyB.",
    );
  }

  return {
    BusinessShortCode: input.businessShortCode,
    Password: stkPassword(input.businessShortCode, input.passkey, input.timestamp),
    Timestamp: input.timestamp,
    TransactionType: input.transactionType,
    Amount: input.amountKes,
    PartyA: input.phone,
    PartyB: input.partyB,
    PhoneNumber: input.phone,
    CallBackURL: input.callbackUrl,
    AccountReference: input.accountReference,
    TransactionDesc: input.description,
  };
}

export async function stkPush(input: StkPayloadInput): Promise<StkPushResult> {
  // Keep the final release gate in the wire helper as well as the callable. A
  // future caller must not accidentally bypass it and send a production push.
  if (input.lifecycle !== "live") {
    throw new HttpsError("failed-precondition", "M-Pesa is configured but not active.");
  }
  if (darajaEnvironment() !== input.environment) {
    throw new HttpsError(
      "failed-precondition",
      "The tenant M-Pesa environment does not match the configured Daraja endpoint.",
    );
  }

  const shortcode = businessShortcode();
  const timestamp = darajaTimestamp(new Date());
  const callbackUrl = MPESA_CALLBACK_URL.value().trim();
  if (!/^https:\/\//.test(callbackUrl)) {
    throw new HttpsError("failed-precondition", "The M-Pesa callback URL must use HTTPS.");
  }

  const requestPayload = buildStkPayload({
    ...input,
    businessShortCode: shortcode,
    passkey: MPESA_PASSKEY.value(),
    timestamp,
    callbackUrl,
  });

  // The token is fetched before anything reaches Safaricom's push endpoint, so
  // failing here means no prompt was sent. Reported as "ambiguous" it locked
  // the order against every further prompt for a request that never left.
  let token: string;
  try {
    token = await darajaToken().catch(() => darajaToken());
  } catch {
    throw new HttpsError(
      "failed-precondition",
      "M-Pesa could not be reached, so no prompt was sent. Try again, or take the code from the customer's message.",
    );
  }

  const payload = await darajaFetch("/mpesa/stkpush/v1/processrequest", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(requestPayload),
  });

  if (
    payload.ResponseCode !== "0"
    || typeof payload.CheckoutRequestID !== "string"
    || payload.CheckoutRequestID.length < 1
    || payload.CheckoutRequestID.length > 128
    || typeof payload.MerchantRequestID !== "string"
    || payload.MerchantRequestID.length < 1
    || payload.MerchantRequestID.length > 128
  ) {
    logger.error("STK push refused or returned incomplete identifiers", {
      responseCode: typeof payload.ResponseCode === "string"
        ? payload.ResponseCode
        : "unreadable",
    });
    throw new HttpsError(
      "unavailable",
      typeof payload.errorMessage === "string"
        ? payload.errorMessage
        : "M-Pesa refused the payment request.",
    );
  }

  return {
    checkoutRequestId: payload.CheckoutRequestID,
    merchantRequestId: payload.MerchantRequestID,
    customerMessage: String(payload.CustomerMessage ?? "Enter your M-Pesa PIN on the phone."),
  };
}
