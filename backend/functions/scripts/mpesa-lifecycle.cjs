#!/usr/bin/env node
"use strict";

const { applicationDefault, initializeApp } = require("firebase-admin/app");
const { FieldValue, getFirestore } = require("firebase-admin/firestore");

const DOCUMENT_ID = /^[A-Za-z0-9_-]{1,128}$/;
const ROUTING_NUMBER = /^\d{5,12}$/;
const STATES = new Set(["staged", "live", "suspended"]);

function option(name) {
  const args = process.argv.slice(2);
  const inline = args.find((value) => value.startsWith(`--${name}=`));
  if (inline) return inline.slice(name.length + 3);
  const index = args.indexOf(`--${name}`);
  return index === -1 ? null : args[index + 1] ?? null;
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

if (process.argv.includes("--help")) {
  console.log(`Usage:
  npm run mpesa:lifecycle -- --project <id> --tenant <id> \\
    --state <staged|suspended|live>

Live additionally requires --release <git-sha>, --ticket <change-ticket>, and
--approve <project-id>:<tenant-id>:live. Staged and suspended remove M-Pesa
from the tenant's accepted payment methods.`);
  process.exit(0);
}

const projectId = option("project");
const tenantId = option("tenant");
const nextState = option("state");
const release = option("release");
const ticket = option("ticket");
const approval = option("approve");

if (!projectId || !/^[a-z][a-z0-9-]{4,29}$/.test(projectId)) {
  fail("--project must be an explicit Firebase project id.");
}
if (!tenantId || !DOCUMENT_ID.test(tenantId)) fail("--tenant is invalid.");
if (!nextState || !STATES.has(nextState)) {
  fail("--state must be staged, live, or suspended.");
}

if (nextState === "live") {
  if (!release || !/^[A-Fa-f0-9]{7,64}$/.test(release)) {
    fail("Live activation requires --release <deployed-git-sha>.");
  }
  if (!ticket || ticket.length < 3 || ticket.length > 80) {
    fail("Live activation requires --ticket <approved-change-ticket>.");
  }
  if (approval !== `${projectId}:${tenantId}:live`) {
    fail(`Live activation requires --approve ${projectId}:${tenantId}:live`);
  }
}

async function main() {
  initializeApp({ credential: applicationDefault(), projectId });
  const firestore = getFirestore();
  const configRef = firestore.collection("mpesa_configs").doc(tenantId);
  const settingsRef = firestore.collection("tenant_settings").doc(tenantId);
  const auditRef = firestore.collection("audit_logs").doc();

  const result = await firestore.runTransaction(async (transaction) => {
    const [configDocument, settingsDocument] = await transaction.getAll(configRef, settingsRef);
    const config = configDocument.data() ?? {};
    const settings = settingsDocument.data() ?? {};

    if (!configDocument.exists || config.tenantId !== tenantId) {
      throw new Error("The tenant has no server-owned M-Pesa configuration.");
    }
    if (!settingsDocument.exists || settings.tenantId !== tenantId) {
      throw new Error("The tenant settings document is missing.");
    }
    if (
      config.transactionType !== "CustomerBuyGoodsOnline"
      && config.transactionType !== "CustomerPayBillOnline"
    ) {
      throw new Error("The configured M-Pesa transaction type is invalid.");
    }
    if (config.environment !== "sandbox" && config.environment !== "production") {
      throw new Error("The configured M-Pesa environment is invalid.");
    }
    if (typeof config.partyB !== "string" || !ROUTING_NUMBER.test(config.partyB)) {
      throw new Error("The configured M-Pesa PartyB/till route is invalid.");
    }
    if (
      typeof config.accountReference !== "string"
      || config.accountReference.length < 1
      || config.accountReference.length > 12
    ) {
      throw new Error("The configured M-Pesa account reference is invalid.");
    }

    const methods = Array.isArray(settings.acceptedPaymentMethods)
      ? settings.acceptedPaymentMethods.filter((method) => typeof method === "string")
      : [];
    const acceptedPaymentMethods = nextState === "live"
      ? [...new Set([...methods, "mpesa"])]
      : methods.filter((method) => method !== "mpesa");

    transaction.update(configRef, {
      lifecycle: nextState,
      lifecycleRelease: release ?? null,
      lifecycleTicket: ticket ?? null,
      lifecycleChangedAt: FieldValue.serverTimestamp(),
    });
    transaction.update(settingsRef, {
      acceptedPaymentMethods,
      updatedAt: FieldValue.serverTimestamp(),
    });
    transaction.set(auditRef, {
      id: auditRef.id,
      tenantId,
      branchId: null,
      actorStaffId: null,
      action: `mpesa.lifecycle.${nextState}`,
      entityType: "mpesa_config",
      entityId: tenantId,
      metadata: { projectId, release: release ?? null, ticket: ticket ?? null },
      createdAt: FieldValue.serverTimestamp(),
    });

    return { previousState: config.lifecycle ?? "missing", nextState };
  });

  console.log(
    `M-Pesa lifecycle changed for ${tenantId}: ${result.previousState} -> ${result.nextState}.`,
  );
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
