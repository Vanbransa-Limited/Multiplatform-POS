import {
  Timestamp,
  type DocumentData,
  type DocumentSnapshot,
} from "firebase-admin/firestore";

import { db } from "../../lib/firebase";
import { deterministicId } from "../../shared/identifiers";
import { MAX_MINOR_UNITS } from "../../shared/validation";

const CANONICAL_PHONE = /^254[17]\d{8}$/;

export type MembershipDiscount = {
  basisPoints: number;
  source: "membership" | "customer";
  sourceId: string;
};

export type DiscountedAmount = {
  baseAmountMinor: number;
  membershipDiscountMinor: number;
  membershipDiscountBasisPoints: number;
  amountMinor: number;
};

export type MembershipLineDiscount = {
  productId: string;
  discountMinor: number;
};

/**
 * Membership records are addressed by a hash of tenant + normalized phone.
 * The phone number is therefore neither a collection path nor a document id.
 */
export function membershipDiscountId(tenantId: string, normalizedPhone: string): string {
  return deterministicId("membership", `${tenantId}:${normalizedPhone}`);
}

function canonicalPhone(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const digits = value.replace(/[\s+()-]/g, "");
  const normalized = digits.startsWith("0") ? `254${digits.slice(1)}` : digits;
  return CANONICAL_PHONE.test(normalized) ? normalized : null;
}

function activeAt(data: DocumentData, now: Timestamp): boolean {
  const startsAt = data.startsAt;
  const endsAt = data.endsAt;
  if (startsAt instanceof Timestamp && startsAt.toMillis() > now.toMillis()) return false;
  if (endsAt instanceof Timestamp && endsAt.toMillis() <= now.toMillis()) return false;
  return true;
}

type MembershipDocuments = {
  tenantId: string;
  normalizedPhone: string;
  member: DocumentSnapshot<DocumentData>;
  customer: DocumentSnapshot<DocumentData> | null;
  now: Timestamp;
};

/**
 * Resolves the rate from snapshots already read by a transaction. Keeping this
 * decision pure lets STK reservation bind the rate and the payment attempt in
 * one atomic operation instead of racing a membership edit.
 */
export function membershipDiscountFromDocuments(
  input: MembershipDocuments,
): MembershipDiscount | null {
  const memberData = input.member.data() ?? {};
  const memberBasisPoints = membershipBasisPoints(memberData.discountBasisPoints);
  if (
    input.member.exists
    && memberData.tenantId === input.tenantId
    && memberData.status === "active"
    && canonicalPhone(memberData.phone) === input.normalizedPhone
    && memberBasisPoints > 0
    && activeAt(memberData, input.now)
  ) {
    return {
      basisPoints: memberBasisPoints,
      source: "membership",
      sourceId: input.member.id,
    };
  }

  if (!input.customer) return null;
  const customerData = input.customer.data() ?? {};
  const customerBasisPoints = membershipBasisPoints(
    customerData.membershipDiscountBasisPoints,
  );
  if (
    input.customer.exists
    && customerData.tenantId === input.tenantId
    && customerData.isActive === true
    && canonicalPhone(customerData.phone) === input.normalizedPhone
    && customerBasisPoints > 0
  ) {
    return {
      basisPoints: customerBasisPoints,
      source: "customer",
      sourceId: input.customer.id,
    };
  }

  return null;
}

/** Accept only canonical integer basis points (1% = 100). */
export function membershipBasisPoints(value: unknown): number {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value >= 0
    && value <= 10_000
    ? value
    : 0;
}

/**
 * Matches the legacy function's `Math.floor` behaviour while keeping the POS
 * ledger in minor units: the discount is rounded down to a whole shilling.
 */
export function applyMembershipDiscount(
  baseAmountMinor: number,
  basisPoints: number,
): DiscountedAmount {
  if (
    !Number.isSafeInteger(baseAmountMinor)
    || baseAmountMinor <= 0
    || baseAmountMinor > MAX_MINOR_UNITS
  ) {
    throw new Error("baseAmountMinor must be a positive safe integer.");
  }

  const safeBasisPoints = membershipBasisPoints(basisPoints);
  const rawDiscountMinor = Number(
    (BigInt(baseAmountMinor) * BigInt(safeBasisPoints)) / 10_000n,
  );
  const membershipDiscountMinor = Math.floor(rawDiscountMinor / 100) * 100;
  return {
    baseAmountMinor,
    membershipDiscountMinor,
    membershipDiscountBasisPoints: safeBasisPoints,
    amountMinor: baseAmountMinor - membershipDiscountMinor,
  };
}

/**
 * Allocates the already-decided order discount across authoritative line
 * grosses. The rolling denominator keeps rounding deterministic and assigns
 * any final remainder to the last line without changing the order total.
 */
export function allocateMembershipDiscount(
  lines: readonly { productId: string; grossMinor: number }[],
  discountMinor: number,
): MembershipLineDiscount[] {
  // Saved-bill settlement has no cart lines and never carries a discount.
  if (lines.length === 0 && discountMinor === 0) return [];
  const totalGrossMinor = lines.reduce((total, line) => total + line.grossMinor, 0);
  if (
    lines.length === 0
    || !Number.isSafeInteger(totalGrossMinor)
    || totalGrossMinor <= 0
    || !Number.isSafeInteger(discountMinor)
    || discountMinor < 0
    || discountMinor > totalGrossMinor
  ) {
    throw new Error("Membership discount cannot be allocated to these lines.");
  }

  let remainingDiscount = discountMinor;
  let remainingGross = totalGrossMinor;
  return lines.map((line, index) => {
    if (
      !line.productId
      || !Number.isSafeInteger(line.grossMinor)
      || line.grossMinor < 0
    ) {
      throw new Error("Membership line gross is invalid.");
    }
    const allocation = index === lines.length - 1
      ? remainingDiscount
      : remainingGross === 0
        ? 0
      : Math.min(
        line.grossMinor,
        Number(
          (BigInt(remainingDiscount) * BigInt(line.grossMinor))
          / BigInt(remainingGross),
        ),
      );
    remainingDiscount -= allocation;
    remainingGross -= line.grossMinor;
    return { productId: line.productId, discountMinor: allocation };
  });
}

/**
 * Replaces the legacy `find_discount_membership(firestore, phone)` helper.
 *
 * A dedicated server-only membership record takes precedence. For migrations,
 * an active selected customer may also carry `membershipDiscountBasisPoints`;
 * its stored phone must match the number receiving the STK prompt.
 */
export async function findMembershipDiscount(input: {
  tenantId: string;
  normalizedPhone: string;
  customerId?: string | null;
  now?: Timestamp;
}): Promise<MembershipDiscount | null> {
  const now = input.now ?? Timestamp.now();
  const memberId = membershipDiscountId(input.tenantId, input.normalizedPhone);
  const member = await db.collection("membership_discounts").doc(memberId).get();
  const customer = input.customerId
    ? await db.collection("customers").doc(input.customerId).get()
    : null;
  return membershipDiscountFromDocuments({
    tenantId: input.tenantId,
    normalizedPhone: input.normalizedPhone,
    member,
    customer,
    now,
  });
}
