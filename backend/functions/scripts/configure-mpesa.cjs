#!/usr/bin/env node
"use strict";

const { applicationDefault, initializeApp } = require("firebase-admin/app");
const { FieldValue, getFirestore } = require("firebase-admin/firestore");

const DOCUMENT_ID = /^[A-Za-z0-9_-]{1,128}$/;
const ROUTING_NUMBER = /^\d{5,12}$/;
const TRANSACTION_TYPES = new Set([
  "CustomerBuyGoodsOnline",
  "CustomerPayBillOnline",
]);

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
  npm run mpesa:configure -- --project <id> --tenant <id> \\
    --environment <sandbox|production> \\
    --transaction-type <CustomerBuyGoodsOnline|CustomerPayBillOnline> \\
    --party-b <till-or-paybill> --account-reference <label> \\
    [--branches <id,id>] --ticket <change-ticket>

Always writes lifecycle=staged and never initiates or registers a payment.`);
  process.exit(0);
}

const projectId = option("project");
const tenantId = option("tenant");
const environment = option("environment");
const transactionType = option("transaction-type");
const partyB = option("party-b");
const accountReference = option("account-reference");
const branchList = option("branches");
const changeTicket = option("ticket");

if (!projectId || !/^[a-z][a-z0-9-]{4,29}$/.test(projectId)) {
  fail("--project must be an explicit Firebase project id.");
}
if (!tenantId || !DOCUMENT_ID.test(tenantId)) fail("--tenant is invalid.");
if (environment !== "sandbox" && environment !== "production") {
  fail("--environment must be sandbox or production.");
}
if (!transactionType || !TRANSACTION_TYPES.has(transactionType)) {
  fail("--transaction-type must be CustomerBuyGoodsOnline or CustomerPayBillOnline.");
}
if (!partyB || !ROUTING_NUMBER.test(partyB)) fail("--party-b/till is invalid.");
if (!accountReference || accountReference.length > 12 || !/^[A-Za-z0-9_-]+$/.test(accountReference)) {
  fail("--account-reference must contain 1-12 letters, numbers, underscores, or hyphens.");
}
if (!changeTicket || changeTicket.length < 3 || changeTicket.length > 80) {
  fail("--ticket is required for an audited configuration change.");
}

const allowedBranchIds = branchList
  ? [...new Set(branchList.split(",").map((value) => value.trim()).filter(Boolean))]
  : null;
if (allowedBranchIds?.some((value) => !DOCUMENT_ID.test(value))) {
  fail("--branches contains an invalid branch id.");
}

async function main() {
  initializeApp({ credential: applicationDefault(), projectId });
  const firestore = getFirestore();
  const tenantRef = firestore.collection("tenants").doc(tenantId);
  const configRef = firestore.collection("mpesa_configs").doc(tenantId);
  const auditRef = firestore.collection("audit_logs").doc();

  await firestore.runTransaction(async (transaction) => {
    const [tenantDocument, existingConfig] = await transaction.getAll(tenantRef, configRef);
    if (!tenantDocument.exists || tenantDocument.data()?.status !== "active") {
      throw new Error("The target tenant does not exist or is not active.");
    }
    if (existingConfig.data()?.lifecycle === "live") {
      throw new Error("Refusing to rewrite a live M-Pesa route. Suspend it first.");
    }

    transaction.set(configRef, {
      tenantId,
      lifecycle: "staged",
      c2bLifecycle: "staged",
      environment,
      transactionType,
      partyB,
      accountReference,
      allowedBranchIds,
      configuredAt: FieldValue.serverTimestamp(),
      lifecycleChangedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    transaction.set(auditRef, {
      id: auditRef.id,
      tenantId,
      branchId: null,
      actorStaffId: null,
      action: "mpesa.config.staged",
      entityType: "mpesa_config",
      entityId: tenantId,
      metadata: { projectId, environment, transactionType, changeTicket },
      createdAt: FieldValue.serverTimestamp(),
    });
  });

  console.log(`Staged M-Pesa routing saved for ${tenantId}; payment initiation remains disabled.`);
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
