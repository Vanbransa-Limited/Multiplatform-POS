const assert = require("node:assert/strict");
const test = require("node:test");

const {
  c2bPayloadFingerprint,
  c2bRoutingFingerprint,
  parseC2bPayload,
  parseC2bPayloadResult,
} = require("../lib/modules/mpesa/c2b-payload.js");
const {
  c2bLifecycleState,
  configMatchesC2bPayload,
  parseC2bRoutingConfig,
  resolveC2bRoute,
} = require("../lib/modules/mpesa/c2b-routing.js");

function callback(overrides = {}) {
  return {
    TransactionType: "Pay Bill",
    TransID: "RKTQDM7W6S",
    TransTime: "20260903123456",
    TransAmount: "1500.25",
    BusinessShortCode: "4567483",
    BillRefNumber: "ARTESANO",
    InvoiceNumber: "INV-42",
    OrgAccountBalance: "9100.50",
    ThirdPartyTransID: "",
    MSISDN: "254712345678",
    FirstName: "Customer",
    ...overrides,
  };
}

function config(tenantId = "tenant-a", overrides = {}) {
  return parseC2bRoutingConfig(tenantId, {
    lifecycle: "staged",
    c2bLifecycle: "staged",
    transactionType: "CustomerPayBillOnline",
    partyB: "4567483",
    accountReference: "ARTESANO",
    branchId: "branch-a",
    ...overrides,
  });
}

test("parseC2bPayload reads a strict C2B envelope into minor units", () => {
  const parsed = parseC2bPayload(callback());

  assert.equal(parsed.transactionId, "RKTQDM7W6S");
  assert.equal(parsed.amountMinor, 150_025);
  assert.equal(parsed.orgAccountBalanceMinor, 910_050);
  assert.equal(parsed.businessShortCode, "4567483");
  assert.equal(parsed.accountReference, "ARTESANO");
  assert.equal(parsed.msisdn, "254712345678");
  assert.equal(Object.hasOwn(parsed, "firstName"), false, "customer names must not be retained");
});

test("parseC2bPayload accepts safe numeric shortcode and MSISDN wire fields", () => {
  const parsed = parseC2bPayload(callback({
    BusinessShortCode: 4567483,
    MSISDN: 254712345678,
  }));

  assert.equal(parsed.businessShortCode, "4567483");
  assert.equal(parsed.msisdn, "254712345678");
});

test("parseC2bPayloadResult rejects malformed routing and money fields", () => {
  const cases = [
    [{ TransAmount: "" }, "C2B00012"],
    [{ TransAmount: "1.001" }, "C2B00012"],
    [{ BillRefNumber: " ARTESANO" }, "C2B00011"],
    [{ BusinessShortCode: "123" }, "C2B00015"],
    [{ MSISDN: "254812345678" }, "C2B00014"],
    [{ TransTime: "not-a-time" }, "C2B00013"],
  ];

  for (const [override, expectedCode] of cases) {
    const result = parseC2bPayloadResult(callback(override));
    assert.equal(result.ok, false, JSON.stringify(override));
    assert.equal(result.code, expectedCode, JSON.stringify(override));
  }
});

test("routing fingerprint ignores non-routing reconciliation metadata", () => {
  const first = parseC2bPayload(callback());
  const second = parseC2bPayload(callback({
    InvoiceNumber: "INV-99",
    OrgAccountBalance: "1.00",
    ThirdPartyTransID: "THIRD-PARTY",
  }));

  assert.notEqual(c2bPayloadFingerprint(first), c2bPayloadFingerprint(second));
  assert.equal(c2bRoutingFingerprint(first), c2bRoutingFingerprint(second));
});

test("routing requires the exact account, shortcode, and transaction type", () => {
  const payload = parseC2bPayload(callback());
  const exact = config();

  assert.equal(configMatchesC2bPayload(exact, payload), true);
  assert.equal(resolveC2bRoute(payload, [exact]).kind, "matched");

  assert.deepEqual(resolveC2bRoute(payload, [config("wrong-account", {
    accountReference: "TITANIUM",
  })]), {
    kind: "unmatched",
    reason: "unknown_account_mapping",
    rejectionCode: "C2B00011",
  });
  assert.equal(resolveC2bRoute(payload, [config("wrong-till", {
    partyB: "4567517",
  })]).reason, "shortcode_mismatch");
  assert.equal(resolveC2bRoute(payload, [config("wrong-rail", {
    transactionType: "CustomerBuyGoodsOnline",
  })]).reason, "transaction_type_mismatch");
});

test("duplicate exact mappings are quarantinable rather than guessed", () => {
  const payload = parseC2bPayload(callback());
  const result = resolveC2bRoute(payload, [config("tenant-a"), config("tenant-b")]);

  assert.deepEqual(result, {
    kind: "unmatched",
    reason: "ambiguous_account_mapping",
    rejectionCode: "C2B00016",
  });
});

test("lifecycle state is fail-closed and requires both switches live", () => {
  assert.equal(c2bLifecycleState(config()), "staged");
  assert.equal(c2bLifecycleState(config("live", {
    lifecycle: "live",
    c2bLifecycle: "live",
  })), "live");
  assert.equal(c2bLifecycleState(config("suspended", {
    lifecycle: "live",
    c2bLifecycle: "suspended",
  })), "suspended");
  assert.equal(c2bLifecycleState(config("invalid", {
    lifecycle: "live",
    c2bLifecycle: undefined,
  })), "invalid");
});
