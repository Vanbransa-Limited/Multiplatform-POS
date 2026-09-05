import { Timestamp, type DocumentReference } from "firebase-admin/firestore";
import { logger } from "firebase-functions";
import { onRequest } from "firebase-functions/v2/https";

import { FUNCTION_REGION } from "../../config/runtime";
import { db } from "../../lib/firebase";
import { deterministicId } from "../../shared/identifiers";
import {
  c2bPayloadFingerprint,
  c2bRoutingFingerprint,
  malformedC2bFingerprint,
  parseC2bPayloadResult,
  type C2bPayload,
  type C2bRejectionCode,
} from "./c2b-payload";
import {
  c2bLifecycleState,
  configMatchesC2bPayload,
  parseC2bRoutingConfig,
  resolveC2bRoute,
  type C2bLifecycle,
  type C2bRouteResolution,
  type C2bRoutingConfig,
} from "./c2b-routing";

const CONFIGS = "mpesa_configs";
const EVENTS = "mpesa_c2b_events";
const QUARANTINE = "mpesa_c2b_quarantine";

type C2bPhase = "validation" | "confirmation";

interface C2bConfig extends C2bRoutingConfig {
  reference: DocumentReference;
}

type ConfigResolution = C2bRouteResolution<C2bConfig>;

interface EventDecision {
  validationAccepted: boolean;
  disposition: "accepted" | "staged_manual_review" | "manual_review" | "quarantined";
  quarantineReason: string | null;
  tenantId: string | null;
  branchIds: string[];
  lifecycle: C2bLifecycle | null;
  c2bLifecycle: C2bLifecycle | null;
}

function readConfig(
  reference: DocumentReference,
  data: Record<string, unknown> | undefined,
): C2bConfig {
  return {
    ...parseC2bRoutingConfig(reference.id, data ?? {}),
    reference,
  };
}

/**
 * Routes only on the exact server-owned account/till pair. An account label
 * alone is insufficient on a shared shortcode, and a shortcode alone cannot
 * identify a tenant. No normalization is applied to either value.
 */
async function resolveConfig(payload: C2bPayload): Promise<ConfigResolution> {
  const snapshot = await db.collection(CONFIGS)
    .where("accountReference", "==", payload.accountReference)
    .get();
  const accountMatches = snapshot.docs.map((document) =>
    readConfig(document.ref, document.data()),
  );
  return resolveC2bRoute(payload, accountMatches);
}

function lifecycleQuarantineReason(config: C2bConfig): string | null {
  const state = c2bLifecycleState(config);
  return state === "invalid"
    ? "invalid_lifecycle_configuration"
    : state === "suspended"
      ? "lifecycle_suspended"
      : null;
}

function decideValidation(config: C2bConfig): EventDecision {
  const invalidLifecycle = lifecycleQuarantineReason(config);
  if (invalidLifecycle) {
    return {
      validationAccepted: false,
      disposition: "quarantined",
      quarantineReason: invalidLifecycle,
      tenantId: config.tenantId,
      branchIds: config.branchIds,
      lifecycle: config.lifecycle,
      c2bLifecycle: config.c2bLifecycle,
    };
  }

  // Staged means the route may be exercised and observed, but it must not
  // authorize a real customer transfer. Both switches have to be explicitly
  // live before Validation tells Safaricom to proceed.
  const accepted = config.lifecycle === "live" && config.c2bLifecycle === "live";
  return {
    validationAccepted: accepted,
    disposition: accepted ? "accepted" : "quarantined",
    quarantineReason: accepted ? null : "lifecycle_not_live",
    tenantId: config.tenantId,
    branchIds: config.branchIds,
    lifecycle: config.lifecycle,
    c2bLifecycle: config.c2bLifecycle,
  };
}

function decideConfirmation(config: C2bConfig): EventDecision {
  const invalidLifecycle = lifecycleQuarantineReason(config);
  if (invalidLifecycle) {
    return {
      validationAccepted: false,
      disposition: "quarantined",
      quarantineReason: invalidLifecycle,
      tenantId: config.tenantId,
      branchIds: config.branchIds,
      lifecycle: config.lifecycle,
      c2bLifecycle: config.c2bLifecycle,
    };
  }

  const fullyLive = config.lifecycle === "live" && config.c2bLifecycle === "live";
  return {
    validationAccepted: false,
    disposition: fullyLive ? "manual_review" : "staged_manual_review",
    quarantineReason: null,
    tenantId: config.tenantId,
    branchIds: config.branchIds,
    lifecycle: config.lifecycle,
    c2bLifecycle: config.c2bLifecycle,
  };
}

function unmatchedDecision(resolution: Extract<ConfigResolution, { kind: "unmatched" }>): EventDecision {
  return {
    validationAccepted: false,
    disposition: "quarantined",
    quarantineReason: resolution.reason,
    tenantId: null,
    branchIds: [],
    lifecycle: null,
    c2bLifecycle: null,
  };
}

function eventReference(phase: C2bPhase, transactionId: string): DocumentReference {
  return db.collection(EVENTS).doc(deterministicId("c2b", `${phase}:${transactionId}`));
}

function quarantineReference(
  phase: C2bPhase,
  transactionId: string,
  reason: string,
  fingerprint: string,
): DocumentReference {
  return db.collection(QUARANTINE).doc(
    deterministicId("c2b-quarantine", `${phase}:${transactionId}:${reason}:${fingerprint}`),
  );
}

async function persistMalformedEvent(
  phase: C2bPhase,
  body: unknown,
  reason: string,
): Promise<void> {
  const fingerprint = malformedC2bFingerprint(body);
  const reference = eventReference(phase, `malformed:${fingerprint}`);
  const quarantine = quarantineReference(phase, "unknown", reason, fingerprint);
  const receivedAt = Timestamp.now();

  await db.runTransaction(async (transaction) => {
    const [eventSnapshot, quarantineSnapshot] = await transaction.getAll(reference, quarantine);
    if (!eventSnapshot.exists) {
      transaction.create(reference, {
        schemaVersion: 1,
        phase,
        providerTransactionId: null,
        providerClaimStatus: "unverified_callback_claim",
        payloadFingerprint: fingerprint,
        routingFingerprint: null,
        tenantId: null,
        branchIds: [],
        disposition: "quarantined",
        quarantineReason: reason,
        validationAccepted: false,
        settlementStatus: "not_attributable",
        intentCreated: false,
        receivedAt,
      });
    }
    if (!quarantineSnapshot.exists) {
      transaction.create(quarantine, {
        schemaVersion: 1,
        eventId: reference.id,
        phase,
        providerTransactionId: null,
        tenantId: null,
        reason,
        payloadFingerprint: fingerprint,
        createdAt: receivedAt,
      });
    }
  });
}

/**
 * Creates one immutable event per phase/provider transaction. Provider retries
 * are idempotent. A second payload reusing the same TransID cannot overwrite
 * the first claim and is instead given its own immutable quarantine record.
 */
async function persistParsedEvent(
  phase: C2bPhase,
  payload: C2bPayload,
  resolution: ConfigResolution,
): Promise<{ validationAccepted: boolean; rejectionCode: C2bRejectionCode }> {
  const payloadFingerprint = c2bPayloadFingerprint(payload);
  const routingFingerprint = c2bRoutingFingerprint(payload);
  const reference = eventReference(phase, payload.transactionId);
  const validationReference = eventReference("validation", payload.transactionId);
  const receivedAt = Timestamp.now();

  return db.runTransaction(async (transaction) => {
    const eventSnapshot = await transaction.get(reference);
    if (eventSnapshot.exists) {
      const existing = eventSnapshot.data() ?? {};
      if (existing.payloadFingerprint === payloadFingerprint) {
        return {
          validationAccepted: existing.validationAccepted === true,
          rejectionCode: (existing.validationRejectionCode ?? "C2B00016") as C2bRejectionCode,
        };
      }

      const reason = "duplicate_transaction_conflict";
      const quarantine = quarantineReference(
        phase,
        payload.transactionId,
        reason,
        payloadFingerprint,
      );
      const quarantineSnapshot = await transaction.get(quarantine);
      if (!quarantineSnapshot.exists) {
        transaction.create(quarantine, {
          schemaVersion: 1,
          eventId: reference.id,
          phase,
          providerTransactionId: payload.transactionId,
          tenantId: typeof existing.tenantId === "string" ? existing.tenantId : null,
          reason,
          payloadFingerprint,
          conflictsWithPayloadFingerprint: existing.payloadFingerprint ?? null,
          createdAt: receivedAt,
        });
      }
      return { validationAccepted: false, rejectionCode: "C2B00016" };
    }

    let decision: EventDecision;
    let rejectionCode: C2bRejectionCode = "C2B00016";
    if (resolution.kind === "unmatched") {
      decision = unmatchedDecision(resolution);
      rejectionCode = resolution.rejectionCode;
    } else {
      // Re-read in the same transaction that stores the decision. A lifecycle
      // suspension or routing edit racing the callback must fail closed.
      const currentConfigSnapshot = await transaction.get(resolution.config.reference);
      const currentConfig = readConfig(
        resolution.config.reference,
        currentConfigSnapshot.data(),
      );
      if (!currentConfigSnapshot.exists || !configMatchesC2bPayload(currentConfig, payload)) {
        decision = {
          validationAccepted: false,
          disposition: "quarantined",
          quarantineReason: "configuration_changed",
          tenantId: currentConfigSnapshot.exists ? currentConfig.tenantId : null,
          branchIds: currentConfigSnapshot.exists ? currentConfig.branchIds : [],
          lifecycle: currentConfigSnapshot.exists ? currentConfig.lifecycle : null,
          c2bLifecycle: currentConfigSnapshot.exists ? currentConfig.c2bLifecycle : null,
        };
      } else {
        decision = phase === "validation"
          ? decideValidation(currentConfig)
          : decideConfirmation(currentConfig);
      }
    }

    // When external Validation is enabled, Confirmation should repeat the same
    // routing facts and must not resurrect a transfer we explicitly rejected.
    // Absence is allowed because Safaricom can have Validation disabled at the
    // organisation level.
    if (phase === "confirmation") {
      const validationSnapshot = await transaction.get(validationReference);
      if (validationSnapshot.exists) {
        const validation = validationSnapshot.data() ?? {};
        if (validation.routingFingerprint !== routingFingerprint) {
          decision = {
            ...decision,
            validationAccepted: false,
            disposition: "quarantined",
            quarantineReason: "validation_confirmation_mismatch",
          };
        } else if (validation.validationAccepted !== true) {
          decision = {
            ...decision,
            validationAccepted: false,
            disposition: "quarantined",
            quarantineReason: "prior_validation_rejected",
          };
        }
      }
    }

    const quarantine = decision.quarantineReason
      ? quarantineReference(
        phase,
        payload.transactionId,
        decision.quarantineReason,
        payloadFingerprint,
      )
      : null;
    const quarantineSnapshot = quarantine ? await transaction.get(quarantine) : null;

    const validationRejectionCode = decision.validationAccepted ? null : rejectionCode;
    transaction.create(reference, {
      schemaVersion: 1,
      phase,
      providerTransactionId: payload.transactionId,
      providerClaimStatus: "unverified_callback_claim",
      payloadFingerprint,
      routingFingerprint,
      tenantId: decision.tenantId,
      branchIds: decision.branchIds,
      lifecycle: decision.lifecycle,
      c2bLifecycle: decision.c2bLifecycle,
      disposition: decision.disposition,
      quarantineReason: decision.quarantineReason,
      validationAccepted: phase === "validation" ? decision.validationAccepted : null,
      validationRejectionCode: phase === "validation" ? validationRejectionCode : null,
      // A direct C2B account identifies a tenant, not the open till sale it is
      // meant to settle. Keep it outside payment_intents until an authenticated
      // reconciliation workflow binds it to a specific sale and amount.
      settlementStatus: decision.disposition === "quarantined"
        ? "quarantined"
        : phase === "confirmation"
          ? "manual_review_required"
          : "not_applicable",
      intentCreated: false,
      payload: {
        transactionType: payload.transactionType,
        transactionTime: payload.transactionTime,
        amountMinor: payload.amountMinor,
        businessShortCode: payload.businessShortCode,
        accountReference: payload.accountReference,
        invoiceNumber: payload.invoiceNumber,
        orgAccountBalanceMinor: payload.orgAccountBalanceMinor,
        thirdPartyTransactionId: payload.thirdPartyTransactionId,
        msisdn: payload.msisdn,
      },
      receivedAt,
    });

    if (quarantine && quarantineSnapshot && !quarantineSnapshot.exists) {
      transaction.create(quarantine, {
        schemaVersion: 1,
        eventId: reference.id,
        phase,
        providerTransactionId: payload.transactionId,
        tenantId: decision.tenantId,
        reason: decision.quarantineReason,
        payloadFingerprint,
        createdAt: receivedAt,
      });
    }

    return { validationAccepted: decision.validationAccepted, rejectionCode };
  });
}

export const mpesaC2bValidation = onRequest(
  { cors: false, region: FUNCTION_REGION },
  async (request, response) => {
    if (request.method !== "POST") {
      response.set("Allow", "POST");
      response.status(405).json({ ResultCode: "C2B00016", ResultDesc: "Method not allowed" });
      return;
    }

    const parsed = parseC2bPayloadResult(request.body);
    try {
      if (!parsed.ok) {
        await persistMalformedEvent("validation", request.body, parsed.reason);
        response.status(200).json({ ResultCode: parsed.code, ResultDesc: "Rejected" });
        return;
      }

      const result = await persistParsedEvent(
        "validation",
        parsed.payload,
        await resolveConfig(parsed.payload),
      );
      response.status(200).json(result.validationAccepted
        ? { ResultCode: "0", ResultDesc: "Accepted" }
        : { ResultCode: result.rejectionCode, ResultDesc: "Rejected" });
    } catch (error) {
      logger.error("M-Pesa C2B validation persistence failed", {
        message: error instanceof Error ? error.message : String(error),
      });
      response.status(500).json({ ResultCode: "C2B00016", ResultDesc: "Retry" });
    }
  },
);

export const mpesaC2bConfirmation = onRequest(
  { cors: false, region: FUNCTION_REGION },
  async (request, response) => {
    if (request.method !== "POST") {
      response.set("Allow", "POST");
      response.status(405).json({ ResultCode: 1, ResultDesc: "Method not allowed" });
      return;
    }

    const parsed = parseC2bPayloadResult(request.body);
    try {
      if (!parsed.ok) {
        await persistMalformedEvent("confirmation", request.body, parsed.reason);
      } else {
        await persistParsedEvent(
          "confirmation",
          parsed.payload,
          await resolveConfig(parsed.payload),
        );
      }

      // Confirmation is an acknowledgement, not permission to spend the
      // claimed payment. Every accepted response follows a durable immutable
      // event/quarantine write so a provider retry cannot be lost.
      response.status(200).json({ ResultCode: 0, ResultDesc: "Accepted" });
    } catch (error) {
      logger.error("M-Pesa C2B confirmation persistence failed", {
        message: error instanceof Error ? error.message : String(error),
      });
      response.status(500).json({ ResultCode: 1, ResultDesc: "Retry" });
    }
  },
);
