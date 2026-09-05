/**
 * Registers the C2B Validation and Confirmation URLs for a shortcode.
 *
 * This is for customers who pay the Paybill/Till directly from their own phone
 * instead of being sent an STK push. It is a one-shot per shortcode in
 * effect: it changes provider-side routing, so never point it at a temporary
 * tunnel or run it as part of an ordinary deploy.
 *
 * ValidationURL is only ever called if Safaricom has enabled external
 * validation on the shortcode. Registering it does nothing on its own.
 *
 * Usage (PowerShell):
 *   $env:MPESA_BASE_URL = "https://sandbox.safaricom.co.ke"
 *   $env:MPESA_CONSUMER_KEY = "..."
 *   $env:MPESA_CONSUMER_SECRET = "..."
 *   $env:MPESA_SHORTCODE = "..."
 *   $env:MPESA_C2B_VALIDATION_URL = "https://<validation endpoint>"
 *   $env:MPESA_C2B_CONFIRMATION_URL = "https://<confirmation endpoint>"
 *   node scripts/register-mpesa-c2b.mjs --acknowledge-registration
 *
 * Production is intentionally harder:
 *   $env:MPESA_C2B_PRODUCTION_ACK = "REGISTER_LIVE_C2B_URLS"
 *   node scripts/register-mpesa-c2b.mjs --acknowledge-registration --allow-production
 */

const args = new Set(process.argv.slice(2));
const allowedArgs = new Set([
  "--acknowledge-registration",
  "--allow-completed-response",
  "--allow-production",
  "--help",
]);

function usage() {
  console.log(`Usage:
  node scripts/register-mpesa-c2b.mjs --acknowledge-registration [options]

Options:
  --acknowledge-registration  Required acknowledgement that URL registration is persistent
  --allow-production          Required in addition to MPESA_C2B_PRODUCTION_ACK for production
  --allow-completed-response  Permit ResponseType=Completed (unsafe if Validation is unavailable)
  --help                      Show this help`);
}

if (args.has("--help")) {
  usage();
  process.exit(0);
}

const unknownArgs = [...args].filter((arg) => !allowedArgs.has(arg));
if (unknownArgs.length > 0) {
  console.error(`Unknown option(s): ${unknownArgs.join(", ")}`);
  usage();
  process.exit(1);
}

if (!args.has("--acknowledge-registration")) {
  console.error(
    "Refusing to register persistent C2B URLs without --acknowledge-registration.",
  );
  process.exit(1);
}

const required = [
  "MPESA_BASE_URL",
  "MPESA_CONSUMER_KEY",
  "MPESA_CONSUMER_SECRET",
  "MPESA_SHORTCODE",
  "MPESA_C2B_VALIDATION_URL",
  "MPESA_C2B_CONFIRMATION_URL",
];

const missing = required.filter((name) => !process.env[name]?.trim());
if (missing.length > 0) {
  console.error(`Set these first: ${missing.join(", ")}`);
  process.exit(1);
}

function parseHttpsUrl(name) {
  let value;
  try {
    value = new URL(process.env[name]);
  } catch {
    console.error(`${name} must be an absolute HTTPS URL.`);
    process.exit(1);
  }
  if (
    value.protocol !== "https:"
    || value.username
    || value.password
    || value.hash
    || value.search
  ) {
    console.error(`${name} must be a plain HTTPS URL without credentials, query, or fragment.`);
    process.exit(1);
  }
  return value;
}

const baseUrl = parseHttpsUrl("MPESA_BASE_URL");
const validationUrl = parseHttpsUrl("MPESA_C2B_VALIDATION_URL");
const confirmationUrl = parseHttpsUrl("MPESA_C2B_CONFIRMATION_URL");
const normalizedEndpoint = (url) =>
  `${url.origin}${url.pathname.replace(/\/+$/, "") || "/"}`;

if (normalizedEndpoint(validationUrl) === normalizedEndpoint(confirmationUrl)) {
  console.error("Validation and Confirmation must be distinct endpoint URLs.");
  process.exit(1);
}

const sandboxHost = "sandbox.safaricom.co.ke";
const productionHost = "api.safaricom.co.ke";
if (baseUrl.hostname !== sandboxHost && baseUrl.hostname !== productionHost) {
  console.error("MPESA_BASE_URL must be an official Safaricom sandbox or production URL.");
  process.exit(1);
}
if (baseUrl.pathname !== "/" || baseUrl.port) {
  console.error("MPESA_BASE_URL must be the official Safaricom origin without a path or port.");
  process.exit(1);
}

if (!/^\d{5,12}$/.test(process.env.MPESA_SHORTCODE)) {
  console.error("MPESA_SHORTCODE must contain 5-12 digits.");
  process.exit(1);
}

const production = baseUrl.hostname === productionHost;
if (production) {
  if (!args.has("--allow-production")) {
    console.error("Refusing production registration without --allow-production.");
    process.exit(1);
  }
  if (process.env.MPESA_C2B_PRODUCTION_ACK !== "REGISTER_LIVE_C2B_URLS") {
    console.error(
      "Set MPESA_C2B_PRODUCTION_ACK=REGISTER_LIVE_C2B_URLS for production registration.",
    );
    process.exit(1);
  }
}

const responseType = process.env.MPESA_C2B_RESPONSE_TYPE?.trim() || "Cancelled";
if (responseType !== "Cancelled" && responseType !== "Completed") {
  console.error("MPESA_C2B_RESPONSE_TYPE must be Cancelled or Completed.");
  process.exit(1);
}
if (responseType === "Completed" && !args.has("--allow-completed-response")) {
  console.error(
    "ResponseType=Completed can accept a transfer when Validation is unavailable; "
      + "pass --allow-completed-response to acknowledge that behavior.",
  );
  process.exit(1);
}

const base = baseUrl.href.replace(/\/$/, "");

async function darajaJson(url, init) {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(20_000) });
  const text = await response.text();
  if (!response.ok) {
    console.error(`${response.status} from ${new URL(url).pathname}. Response body omitted.`);
    process.exit(1);
  }

  try {
    return JSON.parse(text);
  } catch {
    console.error(`Safaricom returned a non-JSON response from ${url}.`);
    process.exit(1);
  }
}

const basic = Buffer.from(
  `${process.env.MPESA_CONSUMER_KEY}:${process.env.MPESA_CONSUMER_SECRET}`,
).toString("base64");

const { access_token: token } = await darajaJson(
  `${base}/oauth/v1/generate?grant_type=client_credentials`,
  { headers: { Authorization: `Basic ${basic}` } },
);
if (typeof token !== "string" || token.length === 0) {
  console.error("Safaricom returned no access token.");
  process.exit(1);
}

console.log(
  `Registering ${production ? "PRODUCTION" : "sandbox"} C2B URLs for shortcode `
    + `${process.env.MPESA_SHORTCODE} with ResponseType=${responseType}.`,
);

const result = await darajaJson(`${base}/mpesa/c2b/v1/registerurl`, {
  method: "POST",
  headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  body: JSON.stringify({
    ShortCode: process.env.MPESA_SHORTCODE,
    // Default fail-closed: "Completed" requires a second explicit CLI guard.
    ResponseType: responseType,
    ConfirmationURL: confirmationUrl.href,
    ValidationURL: validationUrl.href,
  }),
});

console.log(JSON.stringify(result, null, 2));
