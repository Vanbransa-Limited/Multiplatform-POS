import { randomBytes, randomInt, scrypt, timingSafeEqual } from "node:crypto";
import { HttpsError } from "firebase-functions/v2/https";

/**
 * Manager approval codes.
 *
 * A manager types their own six-digit code on a waiter's till to approve the
 * fixed staff discount. The digits never reach a browser or a readable
 * document: only a salted scrypt hash is stored, so a code that leaks is
 * rotated, never looked up.
 */

export const CODE_PATTERN = /^\d{6}$/;
export const MAX_FAILURES = 5;
export const PAUSE_MS = 15 * 60_000;
/** Long enough for a round queued on a weak connection to still reach the server. */
export const APPROVAL_TTL_MS = 12 * 60 * 60_000;
export const CODE_HOLDER_ROLES = new Set(["owner", "manager"]);

const KEY_LENGTH = 32;
const SCRYPT_OPTIONS = { N: 16_384, r: 8, p: 1 };

export type StoredCode = { salt?: string; hash?: string };
export type ThrottleState = { failures?: number; pausedUntilMs?: number };
export type ApprovalRecord = {
  tenantId?: string;
  requestedByStaffId?: string;
  expiresAtMs?: number;
  consumedSaleId?: string | null;
};

/** Repeats and straight runs are the first things anyone tries. */
export function isWeakCode(code: string): boolean {
  return /^(\d)\1+$/.test(code) || "0123456789".includes(code) || "9876543210".includes(code);
}

export function assertCodeShape(value: unknown): string {
  if (typeof value !== "string" || !CODE_PATTERN.test(value)) {
    throw new HttpsError("invalid-argument", "A code is exactly 6 digits.");
  }
  if (isWeakCode(value)) {
    throw new HttpsError("invalid-argument", "That code is too easy to guess. Avoid repeats and runs like 123456.");
  }
  return value;
}

export function generateCode(): string {
  for (;;) {
    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    if (!isWeakCode(code)) return code;
  }
}

function derive(code: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(code, salt, KEY_LENGTH, SCRYPT_OPTIONS, (error, key) => (error ? reject(error) : resolve(key)));
  });
}

export async function hashCode(code: string): Promise<{ salt: string; hash: string }> {
  const salt = randomBytes(16);
  return { salt: salt.toString("base64"), hash: (await derive(code, salt)).toString("base64") };
}

export async function codeMatches(code: string, stored: StoredCode): Promise<boolean> {
  if (!stored?.salt || !stored.hash) return false;
  const expected = Buffer.from(stored.hash, "base64");
  const actual = await derive(code, Buffer.from(stored.salt, "base64"));
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/** The fifth miss pauses entry and starts the count again. */
export function afterFailure(state: ThrottleState, nowMs: number): Required<ThrottleState> {
  const failures = (Number(state?.failures) || 0) + 1;
  return failures >= MAX_FAILURES
    ? { failures: 0, pausedUntilMs: nowMs + PAUSE_MS }
    : { failures, pausedUntilMs: Number(state?.pausedUntilMs) || 0 };
}

export function pausedForMs(state: ThrottleState | undefined, nowMs: number): number {
  return Math.max(0, (Number(state?.pausedUntilMs) || 0) - nowMs);
}

export function approvalUsable(
  approval: ApprovalRecord | undefined,
  sale: { tenantId: string; staffId: string },
  nowMs: number,
): boolean {
  return Boolean(approval)
    && approval!.tenantId === sale.tenantId
    && approval!.requestedByStaffId === sale.staffId
    && !approval!.consumedSaleId
    && Number(approval!.expiresAtMs) > nowMs;
}
