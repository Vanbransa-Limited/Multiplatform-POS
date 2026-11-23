"use strict";

const EXPECTED_PROJECT_ID = "demo-tokgut-pos";
const EXPECTED_TENANT_ID = "demo-tenant";

function parseLoopbackEndpoint(variableName, environment = process.env) {
  const value = environment[variableName]?.trim();
  if (!value || value.includes("://")) {
    throw new Error(`${variableName} must be set to a local host:port value.`);
  }

  let endpoint;
  try {
    endpoint = new URL(`http://${value}`);
  } catch {
    throw new Error(`${variableName} is not a valid host:port value.`);
  }

  const hostname = endpoint.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const isLoopback = hostname === "localhost"
    || hostname === "::1"
    || /^127(?:\.\d{1,3}){3}$/.test(hostname);
  if (!isLoopback || !endpoint.port || endpoint.pathname !== "/"
    || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error(`${variableName} must point to a loopback host and explicit port.`);
  }

  return value;
}

function configuredProjectIds(environment = process.env) {
  const candidates = [
    ["GCLOUD_PROJECT", environment.GCLOUD_PROJECT],
    ["GOOGLE_CLOUD_PROJECT", environment.GOOGLE_CLOUD_PROJECT],
    ["FIREBASE_PROJECT", environment.FIREBASE_PROJECT],
  ];

  if (environment.FIREBASE_CONFIG) {
    try {
      const config = JSON.parse(environment.FIREBASE_CONFIG);
      candidates.push(["FIREBASE_CONFIG.projectId", config.projectId]);
    } catch {
      throw new Error("FIREBASE_CONFIG must be valid JSON when it is set.");
    }
  }

  return candidates.filter(([, value]) => typeof value === "string" && value.trim());
}

function assertSafeEmulatorTarget(environment = process.env) {
  const firestoreHost = parseLoopbackEndpoint("FIRESTORE_EMULATOR_HOST", environment);
  const authHost = parseLoopbackEndpoint("FIREBASE_AUTH_EMULATOR_HOST", environment);
  const projects = configuredProjectIds(environment);

  if (projects.length === 0) {
    throw new Error("GCLOUD_PROJECT must identify the demo emulator project.");
  }

  for (const [source, projectId] of projects) {
    if (projectId.trim() !== EXPECTED_PROJECT_ID) {
      throw new Error(
        `Refusing to seed project ${JSON.stringify(projectId)} from ${source}; expected ${EXPECTED_PROJECT_ID}.`,
      );
    }
  }

  return {
    authHost,
    firestoreHost,
    projectId: EXPECTED_PROJECT_ID,
    tenantId: EXPECTED_TENANT_ID,
  };
}

module.exports = {
  EXPECTED_PROJECT_ID,
  EXPECTED_TENANT_ID,
  assertSafeEmulatorTarget,
  parseLoopbackEndpoint,
};
