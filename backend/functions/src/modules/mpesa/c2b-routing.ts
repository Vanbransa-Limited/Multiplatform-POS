import type { C2bPayload, C2bRejectionCode } from "./c2b-payload";

export type C2bLifecycle = "staged" | "live" | "suspended";

export interface C2bRoutingConfig {
  tenantId: string;
  lifecycle: C2bLifecycle | null;
  c2bLifecycle: C2bLifecycle | null;
  partyB: string | null;
  accountReference: string | null;
  expectedTransactionType: string | null;
  branchIds: string[];
}

export type C2bRouteResolution<Config extends C2bRoutingConfig = C2bRoutingConfig> =
  | { kind: "matched"; config: Config }
  | {
    kind: "unmatched";
    reason:
      | "unknown_account_mapping"
      | "shortcode_mismatch"
      | "transaction_type_mismatch"
      | "ambiguous_account_mapping";
    rejectionCode: C2bRejectionCode;
  };

function lifecycle(value: unknown): C2bLifecycle | null {
  return value === "staged" || value === "live" || value === "suspended"
    ? value
    : null;
}

function configWireString(value: unknown): string | null {
  if (typeof value === "string" && value.length > 0 && value === value.trim()) return value;
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? String(value)
    : null;
}

export function expectedC2bTransactionType(value: unknown): string | null {
  // mpesa_configs uses the Daraja online-payment transaction type. C2B
  // callbacks express the same rail with a different documented wire label.
  if (value === "CustomerPayBillOnline" || value === "Pay Bill") return "Pay Bill";
  if (value === "CustomerBuyGoodsOnline" || value === "Buy Goods") return "Buy Goods";
  return null;
}

function configuredBranchIds(data: Record<string, unknown>): string[] {
  const candidates: unknown[] = [
    data.branchId,
    ...(Array.isArray(data.branchIds) ? data.branchIds : []),
  ];
  return [...new Set(candidates.filter(
    (value): value is string => typeof value === "string"
      && /^[A-Za-z0-9_-]{1,128}$/.test(value),
  ))];
}

export function parseC2bRoutingConfig(
  tenantId: string,
  data: Record<string, unknown>,
): C2bRoutingConfig {
  return {
    tenantId,
    lifecycle: lifecycle(data.lifecycle),
    c2bLifecycle: lifecycle(data.c2bLifecycle),
    partyB: configWireString(data.partyB),
    accountReference: typeof data.accountReference === "string"
      ? data.accountReference
      : null,
    expectedTransactionType: expectedC2bTransactionType(data.transactionType),
    branchIds: configuredBranchIds(data),
  };
}

export function configMatchesC2bPayload(
  config: C2bRoutingConfig,
  payload: C2bPayload,
): boolean {
  return config.accountReference === payload.accountReference
    && config.partyB === payload.businessShortCode
    && config.expectedTransactionType === payload.transactionType;
}

/** Pure exact-match routing used after Firestore returns account candidates. */
export function resolveC2bRoute<Config extends C2bRoutingConfig>(
  payload: C2bPayload,
  accountMatches: readonly Config[],
): C2bRouteResolution<Config> {
  const referenceMatches = accountMatches.filter(
    (config) => config.accountReference === payload.accountReference,
  );
  if (referenceMatches.length === 0) {
    return {
      kind: "unmatched",
      reason: "unknown_account_mapping",
      rejectionCode: "C2B00011",
    };
  }

  const shortcodeMatches = referenceMatches.filter(
    (config) => config.partyB === payload.businessShortCode,
  );
  if (shortcodeMatches.length === 0) {
    return {
      kind: "unmatched",
      reason: "shortcode_mismatch",
      rejectionCode: "C2B00015",
    };
  }

  const exactMatches = shortcodeMatches.filter(
    (config) => config.expectedTransactionType === payload.transactionType,
  );
  if (exactMatches.length === 0) {
    return {
      kind: "unmatched",
      reason: "transaction_type_mismatch",
      rejectionCode: "C2B00013",
    };
  }
  if (exactMatches.length !== 1) {
    return {
      kind: "unmatched",
      reason: "ambiguous_account_mapping",
      rejectionCode: "C2B00016",
    };
  }

  return { kind: "matched", config: exactMatches[0] };
}

export function c2bLifecycleState(
  config: C2bRoutingConfig,
): "invalid" | "suspended" | "staged" | "live" {
  if (config.lifecycle === null || config.c2bLifecycle === null) return "invalid";
  if (config.lifecycle === "suspended" || config.c2bLifecycle === "suspended") {
    return "suspended";
  }
  return config.lifecycle === "live" && config.c2bLifecycle === "live"
    ? "live"
    : "staged";
}
