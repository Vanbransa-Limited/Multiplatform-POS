const assert = require("node:assert/strict");
const test = require("node:test");

const {
  assertDiscountPermission,
  calculateSaleTotals,
  hasProviderAuthorizedDiscount,
  mpesaIntentMatchesSale,
  prepareSaleLines,
} = require("../lib/modules/sales/domain.js");
const {
  saleRequestFingerprint,
} = require("../lib/modules/sales/fingerprint.js");
const { parseSaleInput } = require("../lib/modules/sales/input.js");

function request(overrides = {}) {
  return {
    tenantId: "tenant-1",
    branchId: "branch-1",
    deviceId: "device-1",
    shiftId: "shift-1",
    staffId: "staff-1",
    customerId: "customer-1",
    idempotencyKey: "checkout-0001",
    tableNumber: "A4",
    buyerKraPin: "P051234567A",
    lines: [{ productId: "product-1", qty: 2 }],
    payments: [{ method: "cash", amountMinor: 2_000 }],
    ...overrides,
  };
}

function productDocument(overrides = {}) {
  return {
    exists: true,
    data: () => ({
      tenantId: "tenant-1",
      isActive: true,
      sellPriceMinor: 1_000,
      taxCode: "A",
      sku: "SKU-1",
      name: "Test product",
      isService: false,
      ...overrides,
    }),
  };
}

test("sale input normalizes optional values and keeps server DTO limits", () => {
  const parsed = parseSaleInput(request());

  assert.equal(parsed.buyerKraPin, "P051234567A");
  assert.equal(parsed.lines[0].discountMinor, 0);
  assert.equal(parsed.payments[0].reference, null);
});

test("one digital provider reference cannot fund multiple payment entries", () => {
  assert.throws(
    () => parseSaleInput(request({
      payments: [
        { method: "mpesa", amountMinor: 1_000, reference: "QK-123" },
        { method: "mpesa", amountMinor: 1_000, reference: "qk-123" },
      ],
    })),
    (error) => error.code === "invalid-argument"
      && error.message.includes("only settle one payment entry"),
  );
});

test("buyer KRA PIN is validated before the transaction starts", () => {
  assert.throws(
    () => parseSaleInput(request({ buyerKraPin: "not-a-pin" })),
    (error) => error.code === "invalid-argument"
      && error.message.includes("KRA PIN format"),
  );
});

test("pricing uses authoritative products and inclusive tax", () => {
  const parsed = parseSaleInput(request());
  const lines = prepareSaleLines(parsed.lines, [productDocument()], parsed.tenantId);
  const totals = calculateSaleTotals(lines, parsed.payments);

  assert.equal(lines[0].taxMinor, 276);
  assert.deepEqual(totals, {
    subtotalMinor: 2_000,
    discountMinor: 0,
    taxMinor: 276,
    totalMinor: 2_000,
  });
});

test("unknown product tax codes fail closed", () => {
  const parsed = parseSaleInput(request());
  assert.throws(
    () => prepareSaleLines(
      parsed.lines,
      [productDocument({ taxCode: "UNKNOWN" })],
      parsed.tenantId,
    ),
    (error) => error.code === "failed-precondition"
      && error.message.includes("supported tax code"),
  );
});

test('table service is30% of goods before discounts, independent of its placeholder catalogue price or row order', () => {
  const requestLines = [{ productId: 'prod-table-service', qty: 1, discountMinor: 0 }, { productId: 'food', qty: 1, discountMinor: 0 }];
  const service = productDocument({ sellPriceMinor: 10000, isService: true });
  const food = productDocument({ sellPriceMinor: 75000 });
  const lines = prepareSaleLines(requestLines, [service, food], 'tenant-1');
  assert.equal(lines[0].unitPriceMinor, 22500);
  assert.equal(calculateSaleTotals(lines, [{ amountMinor: 97500 }]).totalMinor, 97500);
  assert.throws(() => prepareSaleLines([{ ...requestLines[0], qty: 2 }, requestLines[1]], [service, food], 'tenant-1'), /single service line/);
  assert.throws(() => prepareSaleLines(requestLines, [productDocument({ isService: false }), food], 'tenant-1'), /single service line/);
});

test("frontline staff cannot submit client-selected discounts", () => {
  const parsed = parseSaleInput(request({
    lines: [{ productId: "product-1", qty: 2, discountMinor: 100 }],
    payments: [{ method: "cash", amountMinor: 1_900 }],
  }));
  const lines = prepareSaleLines(parsed.lines, [productDocument()], parsed.tenantId);

  assert.throws(
    () => assertDiscountPermission(lines, "cashier"),
    (error) => error.code === "permission-denied",
  );
  assert.doesNotThrow(() => assertDiscountPermission(lines, "owner"));
});

test('the fixed 20 percent staff preset can be registered before a payment exists', () => {
  const parsed = parseSaleInput(request({
    lines: [{ productId: 'product-1', qty: 1, discountMinor: 34000 }],
    payments: [{ method: 'credit', amountMinor: 136000 }],
  }));
  const lines = prepareSaleLines(parsed.lines, [productDocument({ sellPriceMinor: 170000 })], parsed.tenantId);
  assert.equal(calculateSaleTotals(lines, parsed.payments).totalMinor, 136000);
  // The preset is a management decision: only an owner or a manager gives it.
  for (const role of ['owner', 'manager']) {
    assert.doesNotThrow(() => assertDiscountPermission(lines, role));
  }
  for (const role of ['supervisor', 'cashier', 'bar_staff', 'store_keeper', 'store_manager']) {
    assert.throws(() => assertDiscountPermission(lines, role), (error) => error.code === 'permission-denied', role);
  }
  assert.throws(() => assertDiscountPermission(lines, 'customer'));
  assert.throws(() => assertDiscountPermission([{ ...lines[0], discountMinor: 35000 }], 'cashier'));
});

test("idempotency fingerprints bind a key to the complete normalized request", () => {
  const original = parseSaleInput(request());
  const changed = parseSaleInput(request({ tableNumber: "B7" }));

  assert.equal(saleRequestFingerprint(original), saleRequestFingerprint(original));
  assert.notEqual(saleRequestFingerprint(original), saleRequestFingerprint(changed));
});

test("a verified M-Pesa membership discount is bound to the exact sale scope", () => {
  const parsed = parseSaleInput(request({
    lines: [{ productId: "product-1", qty: 2, discountMinor: 100 }],
    payments: [
      { method: "cash", amountMinor: 1_000 },
      { method: "mpesa", amountMinor: 900, reference: "RKTQDM7W6S" },
    ],
  }));
  const lines = prepareSaleLines(parsed.lines, [productDocument()], parsed.tenantId);
  const intent = {
    tenantId: parsed.tenantId,
    branchId: parsed.branchId,
    deviceId: parsed.deviceId,
    authorizedStaffId: parsed.staffId,
    customerId: parsed.customerId,
    method: "mpesa",
    status: "verified",
    consumedSaleId: null,
    reference: "RKTQDM7W6S",
    amountMinor: 900,
    cartGrossMinor: 2_000,
    baseAmountMinor: 1_000,
    cashAmountMinor: 1_000,
    membershipDiscountMinor: 100,
    membershipDiscountBasisPoints: 500,
    membershipDiscountSource: "customer",
    lines: [{ productId: "product-1", qty: 2 }],
    lineDiscounts: [{ productId: "product-1", discountMinor: 100 }],
  };
  const document = { data: () => intent };
  const mpesaPayment = parsed.payments[1];

  assert.equal(mpesaIntentMatchesSale(parsed, lines, intent, mpesaPayment), true);
  assert.equal(hasProviderAuthorizedDiscount(parsed, lines, [document]), true);
  assert.doesNotThrow(() => assertDiscountPermission(lines, "cashier", true));

  assert.equal(mpesaIntentMatchesSale(
    { ...parsed, customerId: "another-customer" },
    lines,
    intent,
    mpesaPayment,
  ), false);
  assert.equal(mpesaIntentMatchesSale(
    parsed,
    lines.map((line) => ({ ...line, discountMinor: 99 })),
    intent,
    mpesaPayment,
  ), false);
});

const { assertAcceptedPayments } = require("../lib/modules/sales/domain");

test("an unpaid order is never gated on the tenant's accepted tenders", () => {
  // Provisioning seeds ["cash"], and the settings rules have no 'credit' key,
  // so credit can never appear in this list. Gating it here refused every Pay
  // Now proforma with failed-precondition - permanent, to the till - and left
  // the orders queued on the device, invisible to every other till and to
  // every financial report. Credit is a receivable, not a tender.
  const cashOnly = { acceptedPaymentMethods: ["cash"], cashEnabled: true };
  assert.doesNotThrow(() => assertAcceptedPayments([{ method: "credit", amountMinor: 800000 }], cashOnly));

  // Everything that really is a tender is still gated.
  assert.throws(
    () => assertAcceptedPayments([{ method: "bank_transfer", amountMinor: 100 }], cashOnly),
    /bank_transfer is not enabled/,
  );
  assert.throws(
    () => assertAcceptedPayments([{ method: "cash", amountMinor: 100 }], { acceptedPaymentMethods: ["cash"], cashEnabled: false }),
    /cash is not enabled/,
  );
  // A mixed cart is still refused on the tender it actually contains.
  assert.throws(
    () => assertAcceptedPayments([{ method: "credit", amountMinor: 100 }, { method: "mpesa", amountMinor: 100 }], cashOnly),
    /mpesa is not enabled/,
  );
});

const { needsProviderIntent } = require("../lib/modules/sales/constants");

test("only a tender with a real provider integration must prove itself", () => {
  // M-Pesa is the only one: the mpesa module is the sole writer of
  // payment_intents, so it is the only reference this system can check.
  assert.equal(needsProviderIntent("mpesa"), true);
  // A code typed when settling a tab is recorded unverified, never refused.
  assert.equal(needsProviderIntent("mpesa", true), false);

  // Everything else is a person recording money taken elsewhere. A bank
  // reference comes off a statement and a card slip off the terminal, and
  // nothing here can verify either. Demanding provider proof for them made
  // createSale refuse every one - "not verified or was already consumed" -
  // so the takings stayed on the till that accepted them.
  for (const method of ["bank_transfer", "card", "airtel_money", "cash", "credit"]) {
    assert.equal(needsProviderIntent(method), false, `${method} has no provider to verify against`);
  }
});

const { loadSaleDependencies } = require("../lib/modules/sales/dependencies");
const { db: salesDb } = require("../lib/lib/firebase");

test("a sale the till already took is never refused over stock", async () => {
  const docs = new Map([
    // Counted, and already at zero: sold, never refused, and House stays at zero (26 Nov 2026).
    ["stock_balances/b1_tusker_HOUSE", { tenantId: "t1", branchId: "b1", productId: "tusker", location: "HOUSE", qty: 0 }],
  ]);
  const original = salesDb.collection;
  salesDb.collection = (name) => ({ doc: (id) => ({ id, path: `${name}/${id}` }) });
  try {
    const tx = { getAll: async (...refs) => refs.map((ref) => ({ id: ref.id, exists: docs.has(ref.path), data: () => docs.get(ref.path) })) };
    const lines = [
      { productId: "tusker", productName: "Tusker", qty: 2, isService: false },
      // No balance at all: sold, and moves no stock.
      { productId: "chicken", productName: "Chicken Quarter", qty: 1, isService: false },
      { productId: "corkage", productName: "Corkage", qty: 1, isService: true },
    ];
    const deps = await loadSaleDependencies(tx, { tenantId: "t1", branchId: "b1", payments: [{ method: "card", amountMinor: 100 }] }, lines, "now");
    assert.deepEqual(deps.physicalLines.map((line) => line.productId), ["tusker"]);
    assert.equal(deps.balanceRefs.length, 1);
    assert.equal(deps.updatedBalances[0].qty, 0, "House never goes below zero");
    assert.equal(deps.updatedBalances[0].deductedQty, 0, "nothing left House, so a void puts nothing back");
  } finally { salesDb.collection = original; }
});

test("House stock is taken down to zero and no further; only what left is recorded as taken", async () => {
  const docs = new Map([["stock_balances/b1_coke_HOUSE", { tenantId: "t1", branchId: "b1", productId: "coke", location: "HOUSE", qty: 3 }]]);
  const original = salesDb.collection;
  salesDb.collection = (name) => ({ doc: (id) => ({ id, path: `${name}/${id}` }) });
  try {
    const tx = { getAll: async (...refs) => refs.map((ref) => ({ id: ref.id, exists: docs.has(ref.path), data: () => docs.get(ref.path) })) };
    const deps = await loadSaleDependencies(tx, { tenantId: "t1", branchId: "b1", payments: [{ method: "card", amountMinor: 100 }] },
      [{ productId: "coke", productName: "Coke", qty: 5, isService: false }], "now");
    assert.equal(deps.updatedBalances[0].qty, 0);
    assert.equal(deps.updatedBalances[0].deductedQty, 3);
  } finally { salesDb.collection = original; }
});
