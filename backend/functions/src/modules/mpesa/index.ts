import type {
  DocumentData,
  DocumentReference,
  DocumentSnapshot,
} from "firebase-admin/firestore";
import { Timestamp } from "firebase-admin/firestore";
import { logger } from "firebase-functions";
import { HttpsError, onCall, onRequest } from "firebase-functions/v2/https";

import { FUNCTION_REGION } from "../../config/runtime";
import { db } from "../../lib/firebase";
import { deterministicId } from "../../shared/identifiers";
import { safeSum } from "../../shared/money";
import {
  asRecord,
  documentId,
  minorUnits,
  optionalText,
} from "../../shared/validation";
import {
  MAX_DISTINCT_LINES,
  MAX_QTY_PER_LINE,
  SELLING_ROLES,
} from "../sales/constants";
import {
  callbackMismatchReason,
  MPESA_SECRETS,
  normalizePhone,
  parseMpesaConfig,
  parseMpesaLifecycle,
  parseStkCallback,
  sanitizeAccountReference,
  stkPush,
  stkQuery,
  type MpesaConfig,
  type MpesaLifecycle,
  type StkAttemptMatch,
  type StkCallback,
} from "./daraja";
import {
  allocateMembershipDiscount,
  applyMembershipDiscount,
  membershipDiscountFromDocuments,
  membershipDiscountId,
  type MembershipLineDiscount,
} from "./membership";

const CONFIGS = "mpesa_configs";
const PAYMENTS = "mpesa_payments";
const CHECKOUT_ALIASES = "mpesa_checkout_requests";
const CALLBACK_EVENTS = "mpesa_callback_events";
const UNMATCHED = "mpesa_unmatched";
const RECEIPTS = "mpesa_receipts";
const INTENTS = "payment_intents";

const IDEMPOTENCY_KEY = /^[A-Za-z0-9:_-]{8,160}$/;
const ORDER_REFERENCE = /^[A-Za-z0-9 _:-]{1,40}$/;

type Caller = {
  tenantId: string;
  staffId: string;
  role: string | null;
};

type RequestLine = {
  productId: string;
  qty: number;
};

type Pricing = {
  cartGrossMinor: number;
  baseAmountMinor: number;
  cashAmountMinor: number;
  membershipDiscountMinor: number;
  membershipDiscountBasisPoints: number;
  amountMinor: number;
  lineDiscounts: MembershipLineDiscount[];
};

type InitiateInput = {
  phone: string;
  branchId: string;
  deviceId: string;
  idempotencyKey: string;
  orderReference: string | null;
  customerId: string;
  lines: RequestLine[];
  pricing: Pricing;
};

/** Claims are the only source of tenant and staff identity. */
function callerClaims(
  auth: { token: Record<string, unknown> } | undefined,
): Caller {
  if (!auth) {
    throw new HttpsError("unauthenticated", "Start a till session first.");
  }

  const tenantId = typeof auth.token.tenant_id === "string"
    ? auth.token.tenant_id
    : null;
  const staffId = typeof auth.token.staff_id === "string"
    ? auth.token.staff_id
    : null;
  if (!tenantId || !staffId) {
    throw new HttpsError("permission-denied", "This session carries no staff claims.");
  }

  return {
    tenantId,
    staffId,
    role: typeof auth.token.staff_role === "string" ? auth.token.staff_role : null,
  };
}

function parseLines(value: unknown): RequestLine[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_DISTINCT_LINES) {
    throw new HttpsError(
      "invalid-argument",
      `lines must contain 1-${MAX_DISTINCT_LINES} entries.`,
    );
  }

  const seen = new Set<string>();
  return value.map((raw, index) => {
    const line = asRecord(raw, `lines[${index}]`);
    const productId = documentId(line.productId, `lines[${index}].productId`);
    if (seen.has(productId)) {
      throw new HttpsError("invalid-argument", "Duplicate products must be combined.");
    }
    seen.add(productId);
    if (
      typeof line.qty !== "number"
      || !Number.isSafeInteger(line.qty)
      || line.qty <= 0
      || line.qty > MAX_QTY_PER_LINE
    ) {
      throw new HttpsError(
        "invalid-argument",
        `lines[${index}].qty must be a positive integer.`,
      );
    }
    return { productId, qty: line.qty };
  });
}

function parseInitiateInput(value: unknown): InitiateInput {
  const input = asRecord(value, "Request data");
  if (
    typeof input.idempotencyKey !== "string"
    || !IDEMPOTENCY_KEY.test(input.idempotencyKey)
  ) {
    throw new HttpsError(
      "invalid-argument",
      "idempotencyKey must contain 8-160 letters, numbers, colons, underscores, or hyphens.",
    );
  }

  const baseAmountMinor = minorUnits(input.amountMinor, "amountMinor", false);
  const cashAmountMinor = input.cashAmountMinor === undefined
    ? 0
    : minorUnits(input.cashAmountMinor, "cashAmountMinor");
  // Membership authorization replaces these identity values before the
  // attempt is reserved. Persisting the complete pricing decision here keeps
  // retries deterministic and gives createSale an auditable authorization.
  const pricing: Pricing = {
    cartGrossMinor: safeSum([baseAmountMinor, cashAmountMinor], "cart total"),
    baseAmountMinor,
    cashAmountMinor,
    membershipDiscountMinor: 0,
    membershipDiscountBasisPoints: 0,
    amountMinor: baseAmountMinor,
    lineDiscounts: [],
  };
  if (pricing.amountMinor % 100 !== 0) {
    throw new HttpsError("invalid-argument", "M-Pesa only charges whole shillings.");
  }

  const orderReference = optionalText(input.orderReference, "orderReference", 40);
  if (orderReference && !ORDER_REFERENCE.test(orderReference)) {
    throw new HttpsError(
      "invalid-argument",
      "orderReference may contain letters, numbers, spaces, colons, underscores, or hyphens.",
    );
  }

  return {
    phone: normalizePhone(input.phone),
    branchId: documentId(input.branchId, "branchId"),
    deviceId: documentId(input.deviceId, "deviceId"),
    idempotencyKey: input.idempotencyKey,
    orderReference,
    customerId: documentId(input.customerId, "customerId"),
    lines: parseLines(input.lines),
    pricing,
  };
}

function requestFingerprint(caller: Caller, input: InitiateInput): string {
  return deterministicId("mpesa-request", JSON.stringify({
    tenantId: caller.tenantId,
    staffId: caller.staffId,
    phone: input.phone,
    branchId: input.branchId,
    deviceId: input.deviceId,
    idempotencyKey: input.idempotencyKey,
    orderReference: input.orderReference,
    customerId: input.customerId,
    lines: input.lines,
    baseAmountMinor: input.pricing.baseAmountMinor,
    cashAmountMinor: input.pricing.cashAmountMinor,
  }));
}

function storedLineDiscounts(value: unknown): MembershipLineDiscount[] {
  if (!Array.isArray(value)) return [];
  const discounts: MembershipLineDiscount[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) return [];
    const line = item as Record<string, unknown>;
    if (
      typeof line.productId !== "string"
      || !Number.isSafeInteger(line.discountMinor)
      || Number(line.discountMinor) < 0
    ) return [];
    discounts.push({
      productId: line.productId,
      discountMinor: Number(line.discountMinor),
    });
  }
  return discounts;
}

function pricingFromRecord(record: DocumentData): Pricing & { discountMinor: number } {
  const amountMinor = Number(record.amountMinor);
  const membershipDiscountMinor = Number.isSafeInteger(record.membershipDiscountMinor)
    ? Number(record.membershipDiscountMinor)
    : 0;
  return {
    cartGrossMinor: Number.isSafeInteger(record.cartGrossMinor)
      ? Number(record.cartGrossMinor)
      : amountMinor,
    baseAmountMinor: Number.isSafeInteger(record.baseAmountMinor)
      ? Number(record.baseAmountMinor)
      : amountMinor,
    cashAmountMinor: Number.isSafeInteger(record.cashAmountMinor)
      ? Number(record.cashAmountMinor)
      : 0,
    // discountMinor is the stable client contract; the longer field keeps the
    // intent self-describing for reconciliation and audits.
    discountMinor: membershipDiscountMinor,
    membershipDiscountMinor,
    membershipDiscountBasisPoints: Number.isSafeInteger(record.membershipDiscountBasisPoints)
      ? Number(record.membershipDiscountBasisPoints)
      : 0,
    amountMinor,
    lineDiscounts: storedLineDiscounts(record.lineDiscounts),
  };
}

function attemptResponse(attemptId: string, record: DocumentData) {
  const status = typeof record.status === "string" ? record.status : "ambiguous";
  const checkoutRequestId = typeof record.checkoutRequestId === "string"
    ? record.checkoutRequestId
    : null;
  const customerMessage = typeof record.customerMessage === "string"
    ? record.customerMessage
    : null;

  return {
    status,
    attemptId,
    ...(checkoutRequestId ? { checkoutRequestId } : {}),
    ...(customerMessage ? { customerMessage } : {}),
    pricing: pricingFromRecord(record),
  };
}

function unavailableMessage(lifecycle: MpesaLifecycle): string {
  return lifecycle === "suspended"
    ? "M-Pesa is temporarily suspended. Take payment another way."
    : "M-Pesa is configured but not active yet.";
}

/**
 * Frontends may use this to render availability, but the initiate callable
 * repeats every check: browser state is never the financial control.
 */
export const getMpesaCapability = onCall(
  { region: FUNCTION_REGION },
  async (request) => {
    const { tenantId, staffId } = callerClaims(request.auth);
    const [configDocument, tenantDocument, settingsDocument, staffDocument] =
      await Promise.all([
        db.collection(CONFIGS).doc(tenantId).get(),
        db.collection("tenants").doc(tenantId).get(),
        db.collection("tenant_settings").doc(tenantId).get(),
        db.collection("staff").doc(staffId).get(),
      ]);

    const rawConfig = configDocument.data();
    const lifecycle = parseMpesaLifecycle(rawConfig?.lifecycle);
    if (lifecycle !== "live") {
      return { status: lifecycle, available: false, message: unavailableMessage(lifecycle) };
    }

    const config = parseMpesaConfig(rawConfig);
    const settings = settingsDocument.data() ?? {};
    const staff = staffDocument.data() ?? {};
    const available = Boolean(
      config
      && tenantDocument.exists
      && tenantDocument.data()?.status === "active"
      && settingsDocument.exists
      && settings.tenantId === tenantId
      && Array.isArray(settings.acceptedPaymentMethods)
      && settings.acceptedPaymentMethods.includes("mpesa")
      && staffDocument.exists
      && staff.tenantId === tenantId
      && staff.status === "active"
      && SELLING_ROLES.has(String(staff.role)),
    );

    return available
      ? { status: lifecycle, available: true }
      : {
          status: lifecycle,
          available: false,
          message: "M-Pesa activation is incomplete for this tenant.",
        };
  },
);

function validateScope(
  caller: Caller,
  input: InitiateInput,
  documents: {
    tenant: FirebaseFirestore.DocumentSnapshot;
    branch: FirebaseFirestore.DocumentSnapshot;
    device: FirebaseFirestore.DocumentSnapshot;
    staff: FirebaseFirestore.DocumentSnapshot;
    settings: FirebaseFirestore.DocumentSnapshot;
    shift: FirebaseFirestore.DocumentSnapshot;
    customer: FirebaseFirestore.DocumentSnapshot;
  },
): void {
  const tenant = documents.tenant.data() ?? {};
  const branch = documents.branch.data() ?? {};
  const device = documents.device.data() ?? {};
  const staff = documents.staff.data() ?? {};
  const settings = documents.settings.data() ?? {};
  const shift = documents.shift.data() ?? {};

  if (!documents.tenant.exists || tenant.status !== "active") {
    throw new HttpsError("failed-precondition", "Tenant is not active.");
  }
  if (
    !documents.branch.exists
    || branch.tenantId !== caller.tenantId
    || branch.status !== "active"
  ) {
    throw new HttpsError("failed-precondition", "Branch is not active for this tenant.");
  }
  if (
    !documents.device.exists
    || device.tenantId !== caller.tenantId
    || device.branchId !== input.branchId
    || device.status !== "active"
  ) {
    throw new HttpsError("failed-precondition", "Device is not active for this branch.");
  }
  if (
    !documents.staff.exists
    || staff.tenantId !== caller.tenantId
    || staff.status !== "active"
    || !SELLING_ROLES.has(String(staff.role))
  ) {
    throw new HttpsError("permission-denied", "Staff member is not allowed to take payments.");
  }
  if (
    !documents.shift.exists
    || shift.tenantId !== caller.tenantId
    || shift.branchId !== input.branchId
    || shift.deviceId !== input.deviceId
    || shift.staffId !== caller.staffId
    || shift.status !== "open"
  ) {
    throw new HttpsError(
      "failed-precondition",
      "Staff member has no matching open shift on this device.",
    );
  }
  if (!documents.settings.exists || settings.tenantId !== caller.tenantId) {
    throw new HttpsError("failed-precondition", "Tenant payment settings are missing.");
  }
  if (
    !Array.isArray(settings.acceptedPaymentMethods)
    || !settings.acceptedPaymentMethods.includes("mpesa")
  ) {
    throw new HttpsError("failed-precondition", "M-Pesa is not enabled in payment policy.");
  }

  const customer = documents.customer.data() ?? {};
  if (
    !documents.customer.exists
    || customer.tenantId !== caller.tenantId
    || customer.isActive !== true
  ) {
    throw new HttpsError("failed-precondition", "Customer is not active for this tenant.");
  }
}

function authoritativeLineGrosses(
  caller: Caller,
  input: InitiateInput,
  documents: readonly DocumentSnapshot<DocumentData>[],
): { productId: string; grossMinor: number }[] {
  if (documents.length !== input.lines.length) {
    throw new HttpsError("internal", "The M-Pesa cart could not be read safely.");
  }

  return documents.map((document, index) => {
    const requested = input.lines[index];
    const product = document.data() ?? {};
    if (
      !document.exists
      || product.tenantId !== caller.tenantId
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
    const grossMinor = unitPriceMinor * requested.qty;
    if (!Number.isSafeInteger(grossMinor)) {
      throw new HttpsError("failed-precondition", "The M-Pesa cart total is too large.");
    }
    return { productId: requested.productId, grossMinor };
  });
}

type Reservation = {
  created: boolean;
  attemptId: string;
  attemptRef: DocumentReference;
  record: DocumentData;
  config: MpesaConfig | null;
};

async function reserveAttempt(caller: Caller, input: InitiateInput): Promise<Reservation> {
  const attemptId = deterministicId(
    "mpesa-attempt",
    `${caller.tenantId}:${input.idempotencyKey}`,
  );
  const attemptRef = db.collection(PAYMENTS).doc(attemptId);
  const configRef = db.collection(CONFIGS).doc(caller.tenantId);
  const tenantRef = db.collection("tenants").doc(caller.tenantId);
  const branchRef = db.collection("branches").doc(input.branchId);
  const deviceRef = db.collection("devices").doc(input.deviceId);
  const staffRef = db.collection("staff").doc(caller.staffId);
  const settingsRef = db.collection("tenant_settings").doc(caller.tenantId);
  const shiftId = deterministicId(
    "shift",
    `${caller.tenantId}:${input.deviceId}:${caller.staffId}`,
  );
  const shiftRef = db.collection("shifts").doc(shiftId);
  const customerRef = db.collection("customers").doc(input.customerId);
  const membershipRef = db.collection("membership_discounts").doc(
    membershipDiscountId(caller.tenantId, input.phone),
  );
  const productRefs = input.lines.map((line) =>
    db.collection("products").doc(line.productId),
  );
  const fingerprint = requestFingerprint(caller, input);

  return db.runTransaction(async (transaction) => {
    const [
      configDocument,
      tenantDocument,
      branchDocument,
      deviceDocument,
      staffDocument,
      settingsDocument,
      shiftDocument,
      attemptDocument,
      customerDocument,
      membershipDocument,
      ...productDocuments
    ] = await transaction.getAll(
      configRef,
      tenantRef,
      branchRef,
      deviceRef,
      staffRef,
      settingsRef,
      shiftRef,
      attemptRef,
      customerRef,
      membershipRef,
      ...productRefs,
    );

    validateScope(caller, input, {
      tenant: tenantDocument,
      branch: branchDocument,
      device: deviceDocument,
      staff: staffDocument,
      settings: settingsDocument,
      shift: shiftDocument,
      customer: customerDocument,
    });

    const existing = attemptDocument.data() ?? {};
    if (attemptDocument.exists) {
      if (existing.requestFingerprint !== fingerprint) {
        throw new HttpsError(
          "already-exists",
          "This idempotency key was already used for different payment details.",
        );
      }
      return {
        created: false,
        attemptId,
        attemptRef,
        record: existing,
        config: null,
      };
    }

    const rawConfig = configDocument.data();
    const lifecycle = parseMpesaLifecycle(rawConfig?.lifecycle);
    if (lifecycle !== "live") {
      throw new HttpsError("failed-precondition", unavailableMessage(lifecycle));
    }
    const config = parseMpesaConfig(rawConfig);
    if (!config) {
      throw new HttpsError("failed-precondition", "The M-Pesa route is incomplete.");
    }
    if (config.allowedBranchIds && !config.allowedBranchIds.includes(input.branchId)) {
      throw new HttpsError("failed-precondition", "M-Pesa is not enabled for this branch.");
    }

    const lineGrosses = authoritativeLineGrosses(caller, input, productDocuments);
    const cartGrossMinor = safeSum(
      lineGrosses.map((line) => line.grossMinor),
      "M-Pesa cart total",
    );
    if (
      safeSum(
        [input.pricing.baseAmountMinor, input.pricing.cashAmountMinor],
        "tender total",
      ) !== cartGrossMinor
    ) {
      throw new HttpsError(
        "failed-precondition",
        "The till total no longer matches the server catalogue. Refresh the cart before payment.",
      );
    }

    const now = Timestamp.now();
    const membership = membershipDiscountFromDocuments({
      tenantId: caller.tenantId,
      normalizedPhone: input.phone,
      member: membershipDocument,
      customer: customerDocument,
      now,
    });
    const orderDiscount = applyMembershipDiscount(
      cartGrossMinor,
      membership?.basisPoints ?? 0,
    );
    const chargedAmountMinor = input.pricing.baseAmountMinor
      - orderDiscount.membershipDiscountMinor;
    if (chargedAmountMinor <= 0) {
      throw new HttpsError(
        "failed-precondition",
        "The M-Pesa portion is too small to carry this membership discount.",
      );
    }
    if (chargedAmountMinor % 100 !== 0) {
      throw new HttpsError(
        "failed-precondition",
        "The final M-Pesa amount must be a whole number of shillings.",
      );
    }
    const pricing: Pricing = {
      cartGrossMinor,
      baseAmountMinor: input.pricing.baseAmountMinor,
      cashAmountMinor: input.pricing.cashAmountMinor,
      membershipDiscountMinor: orderDiscount.membershipDiscountMinor,
      membershipDiscountBasisPoints: orderDiscount.membershipDiscountBasisPoints,
      amountMinor: chargedAmountMinor,
      lineDiscounts: allocateMembershipDiscount(
        lineGrosses,
        orderDiscount.membershipDiscountMinor,
      ),
    };

    const accountReference = config.transactionType === "CustomerBuyGoodsOnline"
      ? sanitizeAccountReference(input.orderReference ?? "", config.accountReference)
      : config.accountReference;
    const record = {
      id: attemptId,
      provider: "mpesa",
      tenantId: caller.tenantId,
      branchId: input.branchId,
      deviceId: input.deviceId,
      staffId: caller.staffId,
      customerId: input.customerId,
      lines: input.lines,
      idempotencyKey: input.idempotencyKey,
      requestFingerprint: fingerprint,
      orderReference: input.orderReference,
      phone: input.phone,
      ...pricing,
      membershipDiscountSource: membership?.source ?? null,
      membershipDiscountSourceId: membership?.sourceId ?? null,
      lifecycleAtInitiation: config.lifecycle,
      transactionType: config.transactionType,
      partyB: config.partyB,
      accountReference,
      status: "initiating",
      checkoutRequestId: null,
      merchantRequestId: null,
      receipt: null,
      resultCode: null,
      resultDesc: null,
      callbackClaim: null,
      customerMessage: null,
      requestedAt: now,
      updatedAt: now,
      completedAt: null,
    };
    transaction.set(attemptRef, record);

    return { created: true, attemptId, attemptRef, record, config };
  });
}

async function markInitiationOutcome(
  reservation: Reservation,
  status: "failed" | "ambiguous",
  message: string,
  providerIds?: { checkoutRequestId: string; merchantRequestId: string },
): Promise<DocumentData> {
  await db.runTransaction(async (transaction) => {
    const current = await transaction.get(reservation.attemptRef);
    if (current.data()?.status !== "initiating") return;
    transaction.update(reservation.attemptRef, {
      status,
      ...(providerIds ?? {}),
      resultDesc: message,
      customerMessage: message,
      updatedAt: Timestamp.now(),
    });
  });
  return (await reservation.attemptRef.get()).data() ?? reservation.record;
}

/** Reserve first; a repeated client request never emits a second STK push. */
export const initiateMpesaStk = onCall(
  { region: FUNCTION_REGION, secrets: MPESA_SECRETS },
  async (request) => {
    const caller = callerClaims(request.auth);
    const input = parseInitiateInput(request.data);
    const reservation = await reserveAttempt(caller, input);
    if (!reservation.created) {
      return attemptResponse(reservation.attemptId, reservation.record);
    }

    const config = reservation.config;
    if (!config) {
      throw new HttpsError("internal", "The M-Pesa route was not reserved.");
    }

    let result;
    try {
      result = await stkPush({
        lifecycle: config.lifecycle,
        environment: config.environment,
        transactionType: config.transactionType,
        partyB: config.partyB,
        phone: input.phone,
        amountKes: Number(reservation.record.amountMinor) / 100,
        accountReference: String(reservation.record.accountReference),
        description: `POS ${String(reservation.record.accountReference)}`,
      });
    } catch (error) {
      const definitelyNotSent = error instanceof HttpsError
        && error.code === "failed-precondition";
      const status = definitelyNotSent ? "failed" : "ambiguous";
      const message = definitelyNotSent
        ? error.message
        : "M-Pesa did not confirm whether the prompt was sent. Do not retry this payment until it is reviewed.";
      logger.error("M-Pesa initiation did not complete", {
        attemptId: reservation.attemptId,
        status,
      });
      const record = await markInitiationOutcome(reservation, status, message);
      return attemptResponse(reservation.attemptId, record);
    }

    const aliasRef = db.collection(CHECKOUT_ALIASES).doc(
      deterministicId("mpesa-checkout", result.checkoutRequestId),
    );
    try {
      await db.runTransaction(async (transaction) => {
        const [attemptDocument, aliasDocument] = await transaction.getAll(
          reservation.attemptRef,
          aliasRef,
        );
        const attempt = attemptDocument.data() ?? {};
        if (!attemptDocument.exists || attempt.status !== "initiating") {
          throw new HttpsError("aborted", "The reserved payment attempt changed unexpectedly.");
        }
        if (
          aliasDocument.exists
          && aliasDocument.data()?.attemptId !== reservation.attemptId
        ) {
          throw new HttpsError("data-loss", "Daraja reused a checkout request identifier.");
        }

        const now = Timestamp.now();
        transaction.set(aliasRef, {
          checkoutRequestId: result.checkoutRequestId,
          attemptId: reservation.attemptId,
          tenantId: caller.tenantId,
          createdAt: now,
        });
        transaction.update(reservation.attemptRef, {
          status: "pending",
          checkoutRequestId: result.checkoutRequestId,
          merchantRequestId: result.merchantRequestId,
          customerMessage: result.customerMessage,
          updatedAt: now,
        });
      });
    } catch {
      logger.error("M-Pesa identifiers could not be persisted", {
        attemptId: reservation.attemptId,
        checkoutRequestId: result.checkoutRequestId,
      });
      const record = await markInitiationOutcome(
        reservation,
        "ambiguous",
        "The prompt may have been sent, but its identifiers were not stored safely. Escalate for review.",
        result,
      );
      return attemptResponse(reservation.attemptId, record);
    }

    // Safaricom does not retry every failed callback. A very fast callback can
    // arrive in the narrow interval between the provider response and our
    // checkout-alias write, so recover any claim quarantined during that race.
    try {
      const recovered = await recoverEarlyCallback(result.checkoutRequestId);
      if (recovered) await verifyAttempt(recovered.attemptId, recovered.reference);
    } catch (error) {
      logger.warn("Early M-Pesa callback recovery remains pending", {
        attemptId: reservation.attemptId,
        message: error instanceof Error ? error.message : String(error),
      });
    }

    return attemptResponse(reservation.attemptId, {
      ...reservation.record,
      status: "pending",
      checkoutRequestId: result.checkoutRequestId,
      merchantRequestId: result.merchantRequestId,
      customerMessage: result.customerMessage,
    });
  },
);

function attemptMatch(record: DocumentData): StkAttemptMatch | null {
  if (
    typeof record.checkoutRequestId !== "string"
    || typeof record.merchantRequestId !== "string"
    || !Number.isSafeInteger(record.amountMinor)
    || typeof record.phone !== "string"
  ) return null;
  return {
    checkoutRequestId: record.checkoutRequestId,
    merchantRequestId: record.merchantRequestId,
    amountMinor: Number(record.amountMinor),
    phone: record.phone,
  };
}

function storedCallback(value: unknown): StkCallback | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const callback = value as Record<string, unknown>;
  if (
    typeof callback.checkoutRequestId !== "string"
    || (typeof callback.merchantRequestId !== "string" && callback.merchantRequestId !== null)
    || typeof callback.resultCode !== "number"
    || !Number.isSafeInteger(callback.resultCode)
    || typeof callback.resultDesc !== "string"
    || (typeof callback.receipt !== "string" && callback.receipt !== null)
    || (typeof callback.amountMinor !== "number" && callback.amountMinor !== null)
    || (typeof callback.phone !== "string" && callback.phone !== null)
  ) return null;

  return callback as unknown as StkCallback;
}

function callbackEventId(callback: StkCallback): string {
  return deterministicId("mpesa-event", JSON.stringify(callback));
}

async function quarantineCallback(
  callback: StkCallback,
  reason: string,
  attemptId: string | null = null,
): Promise<void> {
  const eventId = callbackEventId(callback);
  const eventRef = db.collection(CALLBACK_EVENTS).doc(eventId);
  const unmatchedRef = db.collection(UNMATCHED).doc(eventId);
  await db.runTransaction(async (transaction) => {
    const [eventDocument, unmatchedDocument] = await transaction.getAll(eventRef, unmatchedRef);
    const receivedAt = Timestamp.now();
    if (!eventDocument.exists) {
      transaction.set(eventRef, {
        id: eventId,
        provider: "mpesa",
        attemptId,
        checkoutRequestId: callback.checkoutRequestId,
        callback,
        disposition: "quarantined",
        reason,
        receivedAt,
      });
    }
    if (!unmatchedDocument.exists) {
      transaction.set(unmatchedRef, {
        id: eventId,
        attemptId,
        checkoutRequestId: callback.checkoutRequestId,
        reason,
        callback,
        receivedAt,
      });
    }
  });
}

async function lookupAttemptByCheckout(checkoutRequestId: string): Promise<{
  attemptId: string;
  reference: DocumentReference;
} | null> {
  const alias = await db.collection(CHECKOUT_ALIASES).doc(
    deterministicId("mpesa-checkout", checkoutRequestId),
  ).get();
  const attemptId = alias.data()?.attemptId;
  if (
    !alias.exists
    || typeof attemptId !== "string"
    || alias.data()?.checkoutRequestId !== checkoutRequestId
  ) return null;
  return { attemptId, reference: db.collection(PAYMENTS).doc(attemptId) };
}

async function recordCallbackClaim(callback: StkCallback): Promise<{
  attemptId: string;
  reference: DocumentReference;
} | null> {
  const lookup = await lookupAttemptByCheckout(callback.checkoutRequestId);
  if (!lookup) {
    await quarantineCallback(callback, "unknown_checkout_request");
    // Close the opposite half of the alias/callback race: the alias may have
    // committed while the durable quarantine event was being written.
    if (await lookupAttemptByCheckout(callback.checkoutRequestId)) {
      return recordCallbackClaim(callback);
    }
    return null;
  }

  const eventId = callbackEventId(callback);
  const eventRef = db.collection(CALLBACK_EVENTS).doc(eventId);
  const unmatchedRef = db.collection(UNMATCHED).doc(eventId);
  const result = await db.runTransaction(async (transaction) => {
    const [attemptDocument, eventDocument, unmatchedDocument] = await transaction.getAll(
      lookup.reference,
      eventRef,
      unmatchedRef,
    );
    const record = attemptDocument.data() ?? {};
    const expected = attemptMatch(record);
    const structuralMismatch = expected
      ? callbackMismatchReason(callback, expected)
      : "invalid_attempt_record";
    const terminalMismatch = record.status === "paid"
      && (callback.resultCode !== 0 || callback.receipt !== record.receipt)
      ? "paid_attempt_outcome_conflict"
      : record.status === "failed" && callback.resultCode === 0
        ? "failed_attempt_outcome_conflict"
        : null;
    const mismatch = structuralMismatch ?? terminalMismatch;
    const receivedAt = Timestamp.now();

    if (!eventDocument.exists) {
      transaction.set(eventRef, {
        id: eventId,
        provider: "mpesa",
        attemptId: lookup.attemptId,
        tenantId: record.tenantId ?? null,
        checkoutRequestId: callback.checkoutRequestId,
        callback,
        disposition: mismatch ? "quarantined" : "matched_pending_verification",
        reason: mismatch,
        receivedAt,
      });
    } else if (
      !mismatch
      && eventDocument.data()?.reason === "unknown_checkout_request"
    ) {
      transaction.update(eventRef, {
        attemptId: lookup.attemptId,
        tenantId: record.tenantId ?? null,
        disposition: "recovered_pending_verification",
        reason: null,
        recoveredAt: receivedAt,
      });
    }

    if (!attemptDocument.exists || mismatch) {
      if (!unmatchedDocument.exists) {
        transaction.set(unmatchedRef, {
          id: eventId,
          attemptId: lookup.attemptId,
          checkoutRequestId: callback.checkoutRequestId,
          reason: mismatch ?? "missing_attempt",
          callback,
          receivedAt,
        });
      }
      return false;
    }

    if (record.status === "paid" || record.status === "failed") return true;
    transaction.update(lookup.reference, {
      callbackClaim: callback,
      callbackReceivedAt: receivedAt,
      status: "verification_pending",
      updatedAt: receivedAt,
    });
    return true;
  });

  return result ? lookup : null;
}

async function recoverEarlyCallback(checkoutRequestId: string): Promise<{
  attemptId: string;
  reference: DocumentReference;
} | null> {
  const snapshot = await db.collection(UNMATCHED)
    .where("checkoutRequestId", "==", checkoutRequestId)
    .get();
  for (const document of snapshot.docs) {
    const callback = storedCallback(document.data().callback);
    if (!callback) continue;
    const recovered = await recordCallbackClaim(callback);
    if (recovered) return recovered;
  }
  return null;
}

function intentMatches(
  intent: DocumentData,
  attemptId: string,
  record: DocumentData,
  receipt: string,
): boolean {
  return intent.attemptId === attemptId
    && intent.tenantId === record.tenantId
    && intent.method === "mpesa"
    && intent.amountMinor === record.amountMinor
    && intent.reference === receipt
    && intent.providerTransactionId === receipt;
}

async function verifyAttempt(
  attemptId: string,
  attemptRef: DocumentReference,
): Promise<DocumentData> {
  const snapshot = await attemptRef.get();
  const before = snapshot.data() ?? {};
  if (!snapshot.exists) throw new HttpsError("not-found", "M-Pesa attempt was not found.");
  if (before.status === "paid" || before.status === "failed") return before;
  if (typeof before.checkoutRequestId !== "string") return before;

  const providerResult = await stkQuery(before.checkoutRequestId);
  if (!providerResult) return before;

  return db.runTransaction(async (transaction) => {
    const currentDocument = await transaction.get(attemptRef);
    const current = currentDocument.data() ?? {};
    if (!currentDocument.exists) {
      throw new HttpsError("not-found", "M-Pesa attempt was not found.");
    }
    if (current.status === "paid" || current.status === "failed") return current;

    const callback = storedCallback(current.callbackClaim);
    if (providerResult.resultCode !== 0) {
      if (callback && callback.resultCode !== providerResult.resultCode) {
        transaction.update(attemptRef, {
          status: "ambiguous",
          resultCode: providerResult.resultCode,
          resultDesc: "Callback and STK Query returned different outcomes.",
          verifiedBy: "stk_query",
          updatedAt: Timestamp.now(),
        });
        return {
          ...current,
          status: "ambiguous",
          resultCode: providerResult.resultCode,
          resultDesc: "Callback and STK Query returned different outcomes.",
        };
      }

      const now = Timestamp.now();
      transaction.update(attemptRef, {
        status: "failed",
        resultCode: providerResult.resultCode,
        resultDesc: providerResult.resultDesc,
        verifiedBy: "stk_query",
        updatedAt: now,
        completedAt: now,
      });
      return {
        ...current,
        status: "failed",
        resultCode: providerResult.resultCode,
        resultDesc: providerResult.resultDesc,
      };
    }

    // Query success is provider-side proof, but it carries no receipt, amount,
    // or phone. A strictly matching success callback must supply those before
    // createSale receives a spendable intent.
    const expected = attemptMatch(current);
    const mismatch = callback && expected
      ? callbackMismatchReason(callback, expected)
      : "success_callback_missing";
    if (!callback || !expected || mismatch || callback.resultCode !== 0) {
      const status = callback ? "ambiguous" : "verification_pending";
      transaction.update(attemptRef, {
        status,
        resultCode: providerResult.resultCode,
        resultDesc: mismatch ?? "Success callback and STK Query disagree.",
        verifiedBy: "stk_query",
        updatedAt: Timestamp.now(),
      });
      return {
        ...current,
        status,
        resultCode: providerResult.resultCode,
        resultDesc: mismatch,
      };
    }

    const receipt = callback.receipt as string;
    const receiptRef = db.collection(RECEIPTS).doc(
      deterministicId("mpesa-receipt", receipt),
    );
    const intentRef = db.collection(INTENTS).doc(
      deterministicId("intent", `${String(current.tenantId)}:${receipt}`),
    );
    const [receiptDocument, intentDocument] = await transaction.getAll(
      receiptRef,
      intentRef,
    );
    const receiptOwner = receiptDocument.data()?.attemptId;
    const intent = intentDocument.data() ?? {};
    if (
      (receiptDocument.exists && receiptOwner !== attemptId)
      || (intentDocument.exists && !intentMatches(intent, attemptId, current, receipt))
    ) {
      transaction.update(attemptRef, {
        status: "ambiguous",
        resultCode: providerResult.resultCode,
        resultDesc: "The M-Pesa receipt is already assigned to another payment.",
        verifiedBy: "callback_and_stk_query",
        updatedAt: Timestamp.now(),
      });
      return {
        ...current,
        status: "ambiguous",
        resultDesc: "The M-Pesa receipt is already assigned to another payment.",
      };
    }

    const now = Timestamp.now();
    if (!receiptDocument.exists) {
      transaction.set(receiptRef, {
        provider: "mpesa",
        receipt,
        attemptId,
        tenantId: current.tenantId,
        amountMinor: current.amountMinor,
        createdAt: now,
      });
    }
    if (!intentDocument.exists) {
      transaction.set(intentRef, {
        tenantId: current.tenantId,
        branchId: current.branchId,
        deviceId: current.deviceId,
        authorizedStaffId: current.staffId,
        method: "mpesa",
        amountMinor: current.amountMinor,
        cartGrossMinor: current.cartGrossMinor,
        baseAmountMinor: current.baseAmountMinor,
        cashAmountMinor: current.cashAmountMinor,
        membershipDiscountMinor: current.membershipDiscountMinor,
        membershipDiscountBasisPoints: current.membershipDiscountBasisPoints,
        membershipDiscountSource: current.membershipDiscountSource,
        membershipDiscountSourceId: current.membershipDiscountSourceId,
        customerId: current.customerId,
        lines: current.lines,
        lineDiscounts: current.lineDiscounts,
        orderReference: current.orderReference,
        idempotencyKey: current.idempotencyKey,
        attemptId,
        reference: receipt,
        providerTransactionId: receipt,
        transactionType: current.transactionType,
        partyB: current.partyB,
        accountReference: current.accountReference,
        verificationSource: "callback_and_stk_query",
        status: "verified",
        consumedSaleId: null,
        createdAt: now,
      });
    }
    transaction.update(attemptRef, {
      status: "paid",
      receipt,
      resultCode: providerResult.resultCode,
      resultDesc: providerResult.resultDesc,
      verifiedBy: "callback_and_stk_query",
      verifiedAt: now,
      updatedAt: now,
      completedAt: now,
    });
    return {
      ...current,
      status: "paid",
      receipt,
      resultCode: providerResult.resultCode,
      resultDesc: providerResult.resultDesc,
    };
  });
}

async function attemptFromQueryInput(input: Record<string, unknown>): Promise<{
  attemptId: string;
  reference: DocumentReference;
}> {
  if (input.attemptId !== undefined) {
    const attemptId = documentId(input.attemptId, "attemptId");
    return { attemptId, reference: db.collection(PAYMENTS).doc(attemptId) };
  }

  // Transitional compatibility for a till still holding CheckoutRequestID.
  const checkoutRequestId = optionalText(
    input.checkoutRequestId,
    "checkoutRequestId",
    128,
  );
  if (!checkoutRequestId) {
    throw new HttpsError("invalid-argument", "attemptId is required.");
  }
  const lookup = await lookupAttemptByCheckout(checkoutRequestId);
  if (!lookup) throw new HttpsError("not-found", "M-Pesa attempt was not found.");
  return lookup;
}

export const queryMpesaStatus = onCall(
  { region: FUNCTION_REGION, secrets: MPESA_SECRETS },
  async (request) => {
    const caller = callerClaims(request.auth);
    const input = asRecord(request.data, "Request data");
    const lookup = await attemptFromQueryInput(input);
    const snapshot = await lookup.reference.get();
    const record = snapshot.data() ?? {};
    const manager = caller.role === "owner" || caller.role === "store_manager";
    if (
      !snapshot.exists
      || record.tenantId !== caller.tenantId
      || (record.staffId !== caller.staffId && !manager)
    ) {
      throw new HttpsError("not-found", "No such M-Pesa payment for this session.");
    }

    if (
      record.status === "paid"
      || record.status === "failed"
      || typeof record.checkoutRequestId !== "string"
    ) {
      return attemptResponse(lookup.attemptId, record);
    }

    const verified = await verifyAttempt(lookup.attemptId, lookup.reference);
    return attemptResponse(lookup.attemptId, verified);
  },
);

/**
 * The public callback is only a correlated claim. It is stored first, matched
 * strictly, and checked against STK Query before any verified intent is made.
 */
export const mpesaCallback = onRequest(
  { cors: false, region: FUNCTION_REGION, secrets: MPESA_SECRETS },
  async (request, response) => {
    const accept = () => response.status(200).json({ ResultCode: 0, ResultDesc: "Accepted" });
    if (request.method !== "POST") {
      response.set("Allow", "POST");
      response.status(405).json({ ResultCode: 1, ResultDesc: "Method not allowed" });
      return;
    }

    const callback = parseStkCallback(request.body);
    if (!callback) {
      logger.error("Unreadable M-Pesa callback received");
      accept();
      return;
    }

    try {
      const lookup = await recordCallbackClaim(callback);
      if (!lookup) {
        logger.error("M-Pesa callback quarantined", {
          checkoutRequestId: callback.checkoutRequestId,
        });
        accept();
        return;
      }

      try {
        await verifyAttempt(lookup.attemptId, lookup.reference);
      } catch (error) {
        // The callback claim is already durable. A till query or reconciler can
        // retry provider verification; asking Safaricom to redeliver the same
        // claim does not add evidence.
        logger.warn("M-Pesa callback awaits provider verification", {
          attemptId: lookup.attemptId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      accept();
    } catch (error) {
      logger.error("M-Pesa callback could not be stored", {
        error: error instanceof Error ? error.message : String(error),
      });
      response.status(500).json({ ResultCode: 1, ResultDesc: "Retry" });
    }
  },
);
