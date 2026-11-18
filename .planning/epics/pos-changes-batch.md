# Epic: pos-changes-batch

**Created**: 2026-11-16
**Status**: implemented; consolidated release prepared on 18 November 2026
**Owner**: Lloyd

---

Release note (18 November): the source from this batch has been combined with
the standalone immutable proforma register, imported prepared invoices and
payment/checkout corrections. The feature-status wording below records the
original implementation handoff. Current release verification and production
results are maintained in `docs/checkout-zero-round-fix-2026-11-18.md`,
`docs/payment-stock-fixes-2026-11-18.md` and `docs/proforma-invoices.md`.

## Why

Make stock control trustworthy: only the store manager puts stock into the Store and approves anything moving into House, while service staff request instead of moving. Alongside that, give the owner per-role control over each module (including selling), add proforma invoices for pre-planned events, and make tabs one-per-name, edited and paid through the normal POS/order screens.

---

## Success Criteria

- [ ] Store manager can add stock to the Store, add new items and do a stock take. Other staff can only *request* stock into House, and nothing moves until the store manager approves. Typing "080" works.
- [ ] Owner can switch each module (selling included) on or off per role from Settings, and it applies straight away.
- [ ] Each tab name has only one open tab. Adding items, editing and paying a tab go through the POS and order screens, and the tab's items appear on its invoice.
- [ ] A proforma invoice matching the Savahope A4 layout can be made for a planned event and printed.
- [ ] Error banners can be swiped away. A login QR code and a print-ready Titanium logo are delivered.

---

## Features

| # | Feature | Status | Spec | Plan | Depends On |
|---|---------|--------|------|------|------------|
| 1 | Quick fixes: negative-balance stock lockout, swipeable error banners | built (uncommitted, not deployed) | [quick-fixes](../specs/quick-fixes.md) | [plan](../plans/quick-fixes.md) | — |
| 2 | Module access per role (owner switches, selling included) | built (uncommitted, not deployed) | [module-access](../specs/module-access.md) | [plan](../plans/module-access.md) | — |
| 3 | Store stock: add stock, new item, stock take, add/remove; "Correct" = count fix | built (uncommitted, not deployed) | [store-stock-actions](../specs/store-stock-actions.md) | [plan](../plans/store-stock-actions.md) | #2 |
| 4 | House requests with store-manager approval (owner fallback) | built (uncommitted, not deployed) | [house-request-approval](../specs/house-request-approval.md) | [plan](../plans/house-request-approval.md) | #3 |
| 5 | Tabs: unique name, add via POS, Pay now/Edit open the order, invoice-linked | built, invoice-linking needs clarification | [tab-management-flow](../specs/tab-management-flow.md) | — | — |
| 6 | Proforma invoice template for events | built (uncommitted, not deployed) | [event-proforma](../specs/event-proforma.md) | — | — |
| 7 | Login QR code + print-ready Titanium logo | delivered to Downloads/titanium-print; logo needs source artwork for large print | — | — | — |

---

## Feature Briefs

### Feature 1: Quick fixes
"Request into House" rejects "080" with `[400] Enter a valid whole-number quantity`: the form is likely sending the text "080" instead of the number 80, and `quantity()` in `backend/functions/src/modules/stock/index.ts` only accepts a real number. Change the client to send a number. Error banners get swipe-to-dismiss plus a close button.

### Feature 2: Module access per role
The owner sets which modules (Till/selling, Orders, Tabs, House, Store, Reports, Settings, …) each role can use. The access rules are stored in tenant settings and checked on both the screen and the server. If a module is hidden on screen but its server-side check is missed, that role can still reach it.

### Feature 3: Store stock
The Stock actions sheet gets:
- **Add new item**, for items brought into stock for the first time.
- **Stock take**, a full count that sets the stock levels.
- **Add / Remove stock** on an existing item, with a reason.

"Correct" is relabelled as a single-item count fix. These actions are limited to the store manager and owner. They also fix items that are already wrong, e.g. WHITECAP LAGER at Store 150 / House −85.

### Feature 4: House requests with approval
Today `changeStock` with action `request` moves stock at once. Change it so managers, waiters and bar staff create a *pending* request that doesn't move anything. The store manager (or the owner, as a fallback) approves or rejects it, and only on approval does stock move from Store to House. Pending requests show as a queue.

### Feature 5: Tab management
- Only one open tab per name.
- "Add new item to tab" opens the POS in tab mode, so items show "Add to tab" and Pay now is hidden.
- "Pay now" opens that tab's order at payment.
- "Edit tab" opens the tab in the order viewer.
- The tab's items carry through to its invoice.

### Feature 6: Proforma invoice
Build an A4 proforma invoice template from `Savahope Ltd - Proforma invoice (A4).docx` for pre-planned events. It is created from selected items and a customer, is printable, and is separate from sales, so it doesn't count toward revenue or stock until it's converted.

### Feature 7: Login QR + logo
A printable QR code pointing to the app's login screen, and a print-ready expanded version of the Titanium logo (needs a source file).

---

## Risks

- Existing negative House counts (WHITECAP −85): fix them in the first stock take, and block counts from going negative from now on.
- Approval bottleneck when the store manager is off shift: let the owner approve as a fallback.
- Module access per role touches the sign-in permissions on every module, so each module needs a test.
- Duplicate tabs that already exist need a one-off merge or cleanup, with Lloyd's sign-off.
- The Titanium logo source file is needed; otherwise the logo has to be redrawn.

---

## Notes

- The working tree has uncommitted eTIMS/ETR changes on `main`. Build this epic on a feature branch.
