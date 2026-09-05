const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildStkPayload,
  callbackMismatchReason,
  darajaTimestamp,
  normalizePhone,
  parseMpesaConfig,
  parseResultCode,
  parseStkCallback,
  stkPassword,
} = require("../lib/modules/mpesa/daraja.js");
const {
  allocateMembershipDiscount,
  applyMembershipDiscount,
  membershipBasisPoints,
} = require("../lib/modules/mpesa/membership.js");

function callback(overrides = {}) {
  return {
    Body: {
      stkCallback: {
        MerchantRequestID: "29115-34620561-1",
        CheckoutRequestID: "ws_CO_191220191020363925",
        ResultCode: 0,
        ResultDesc: "The service request is processed successfully.",
        CallbackMetadata: {
          Item: [
            { Name: "Amount", Value: 1500 },
            { Name: "MpesaReceiptNumber", Value: "NLJ7RT61SV" },
            { Name: "TransactionDate", Value: 20191219102115 },
            { Name: "PhoneNumber", Value: 254708374149 },
          ],
        },
        ...overrides,
      },
    },
  };
}

test("normalizePhone accepts every format a cashier types", () => {
  for (const raw of ["0712345678", "254712345678", "+254 712 345 678", "712345678"]) {
    assert.equal(normalizePhone(raw), "254712345678");
  }

  assert.equal(normalizePhone("0112345678"), "254112345678");
});

test("normalizePhone rejects anything Safaricom would not route", () => {
  for (const raw of ["", "0812345678", "07123456789", "0712345", "not a phone", 712345678]) {
    assert.throws(() => normalizePhone(raw), /07XXXXXXXX/);
  }
});

test("darajaTimestamp stamps Nairobi time in Daraja's format", () => {
  assert.equal(darajaTimestamp(new Date("2026-09-01T09:34:56.000Z")), "20260901123456");
});

test("stkPassword is base64 of shortcode + passkey + timestamp", () => {
  const password = stkPassword("174379", "bfb279f9aa9b", "20260901123456");
  assert.equal(
    Buffer.from(password, "base64").toString("utf8"),
    "174379bfb279f9aa9b20260901123456",
  );
});

test("parseStkCallback reads a paid push into minor units", () => {
  const parsed = parseStkCallback(callback());

  assert.equal(parsed.checkoutRequestId, "ws_CO_191220191020363925");
  assert.equal(parsed.resultCode, 0);
  assert.equal(parsed.receipt, "NLJ7RT61SV");
  assert.equal(parsed.amountMinor, 150_000);
  assert.equal(parsed.phone, "254708374149");
});

test("parseStkCallback survives a cancelled push carrying no metadata", () => {
  const cancelled = callback({
    ResultCode: 1032,
    ResultDesc: "Request cancelled by user",
    CallbackMetadata: undefined,
  });

  const parsed = parseStkCallback(cancelled);

  assert.equal(parsed.resultCode, 1032);
  assert.equal(parsed.receipt, null);
  assert.equal(parsed.amountMinor, null);
  assert.equal(parsed.phone, null);
});

test("parseStkCallback returns null for anything that is not a callback", () => {
  for (const body of [null, undefined, "", {}, { Body: {} }, { Body: { stkCallback: {} } }]) {
    assert.equal(parseStkCallback(body), null);
  }
});

test("parseResultCode reads both wire formats", () => {
  assert.equal(parseResultCode(0), 0);
  assert.equal(parseResultCode(1032), 1032);
  assert.equal(parseResultCode("0"), 0);
  assert.equal(parseResultCode("1032"), 1032);
});

test("parseResultCode never turns an unreadable code into a paid sale", () => {
  // Number("") and Number(null) are both 0, and 0 means paid. Anything that
  // is not an actual code must come back null so the payment stays pending.
  for (const value of ["", "   ", null, undefined, {}, [], "abc", NaN, Infinity]) {
    assert.equal(parseResultCode(value), null, `${JSON.stringify(value)} must not read as a result code`);
  }
});

test("tenant M-Pesa routing is explicit and missing lifecycle stays staged", () => {
  assert.deepEqual(parseMpesaConfig({
    environment: "sandbox",
    transactionType: "CustomerBuyGoodsOnline",
    partyB: "1234567",
    accountReference: "ARTESANO",
    allowedBranchIds: ["branch-a", "branch-a"],
  }), {
    lifecycle: "staged",
    environment: "sandbox",
    transactionType: "CustomerBuyGoodsOnline",
    partyB: "1234567",
    accountReference: "ARTESANO",
    allowedBranchIds: ["branch-a"],
  });
  assert.equal(parseMpesaConfig({ environment: "sandbox", transactionType: "wrong", partyB: "12345" }), null);
  assert.equal(parseMpesaConfig({ transactionType: "CustomerBuyGoodsOnline", partyB: "12345" }), null);
});

test("the final wire helper refuses staged pushes and maps a Buy Goods till", () => {
  const common = {
    environment: "sandbox",
    transactionType: "CustomerBuyGoodsOnline",
    partyB: "1234567",
    phone: "254712345678",
    amountKes: 1500,
    accountReference: "INV_42",
    description: "POS INV_42",
    businessShortCode: "7654321",
    passkey: "test-passkey",
    timestamp: "20260901123456",
    callbackUrl: "https://example.test/mpesaCallback",
  };
  assert.throws(
    () => buildStkPayload({ ...common, lifecycle: "staged" }),
    (error) => error.code === "failed-precondition",
  );
  const payload = buildStkPayload({ ...common, lifecycle: "live" });
  assert.equal(payload.TransactionType, "CustomerBuyGoodsOnline");
  assert.equal(payload.BusinessShortCode, "7654321");
  assert.equal(payload.PartyB, "1234567");
  assert.equal(payload.AccountReference, "INV_42");
});

test("a callback must match every available identifier on the reserved attempt", () => {
  const parsed = parseStkCallback(callback());
  const expected = {
    checkoutRequestId: parsed.checkoutRequestId,
    merchantRequestId: parsed.merchantRequestId,
    amountMinor: 150_000,
    phone: "254708374149",
  };
  assert.equal(callbackMismatchReason(parsed, expected), null);
  assert.equal(callbackMismatchReason({ ...parsed, amountMinor: 149_900 }, expected), "amount_mismatch");
  assert.equal(callbackMismatchReason({ ...parsed, receipt: null }, expected), "success_missing_receipt");
});

test("legacy membership discounts floor to a whole shilling and allocate exactly", () => {
  assert.equal(membershipBasisPoints(500), 500);
  assert.equal(membershipBasisPoints(10_001), 0);
  assert.deepEqual(applyMembershipDiscount(9_900, 500), {
    baseAmountMinor: 9_900,
    membershipDiscountMinor: 400,
    membershipDiscountBasisPoints: 500,
    amountMinor: 9_500,
  });
  const allocated = allocateMembershipDiscount([
    { productId: "food", grossMinor: 6_000 },
    { productId: "drink", grossMinor: 3_900 },
  ], 400);
  assert.equal(allocated.reduce((sum, line) => sum + line.discountMinor, 0), 400);
  assert.deepEqual(allocated.map((line) => line.productId), ["food", "drink"]);
});
