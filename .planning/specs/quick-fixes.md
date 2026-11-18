# Spec: quick-fixes

**Created**: 2026-11-16
**Status**: draft
**Author**: Lloyd
**Epic**: pos-changes-batch (Feature 1)

---

## Problem

1. **Stuck stock items.** Every stock action on an item with a negative balance fails with `Enter a valid whole-number quantity. [400]`, whatever quantity is typed. Sales are allowed to push House below zero on purpose (offline sales that already happened can't be refused; see `sales/dependencies.ts:85`). But `changeStock` and `importStock` read the stored balance through `quantity()`, the check meant for typed input, which rejects negatives. WHITECAP LAGER (House −85) therefore can't be requested into, corrected or imported, which is the report "Whitecap can't be removed nor added". The "080" input was a red herring: the client turns it into 80.
2. **Toasts block the nav.** `showNotification` (`frontend/src/context.js`) shows a fixed toast at the bottom-right for 4 s, with no way to dismiss it. On a phone it covers the bottom nav (Till/Orders/Tabs/House/More).

## Goal

- Any stock item can be requested, received, corrected or imported whatever its current balance, including a negative one.
- Any toast can be swiped or tapped away at once.

## User Stories

- As a **bar or service staff member**, I want to request 80 WHITECAP into House even though House reads −85, so the count recovers instead of staying stuck.
- As a **store manager or owner**, I want to correct a negative count to the real number, so stock matches the shelf.
- As **anyone on a phone**, I want to swipe an error message away, so it stops covering the nav I need to tap.

## Requirements

### Must-have
- A stored balance is read as any safe integer, negatives included. The typed-input check `quantity()` stays strict (1 or more, or 0 or more for corrections).
- Moves that *add* stock (receive, request into House, import) are allowed even if the result is still negative.
- Moves that *take* stock out (the Store side of a request) still refuse to go below zero. The existing "The Store holds only N" message is kept.
- A correction ("adjust") still requires `expectedQty` to equal the stored balance. Negatives now match, so the user can correct −85 to the real count.
- Toasts close with a horizontal swipe (more than 60 px) or a tap, and are announced to screen readers (`role="status"`, or `role="alert"` for errors).

### Nice-to-have
- Error toasts stay up for 8 s instead of 4 s, since they can now be dismissed.

### Out of scope
- Stopping sales from pushing House negative (by design).
- The approval workflow for requests (Feature 4) and new stock-action buttons (Feature 3).
- Inline form messages (`.stk-msg`, `.error-msg`). They aren't overlays.

## Data Model

No schema change. `stock_balances.qty` may already be negative; the code now accepts that.

## API Changes

None to the request or response shapes of `changeStock` / `importStock`. Behaviour change: an item with a negative balance no longer returns `invalid-argument`.

## UI Changes

- `showNotification`: swipe or tap to dismiss, plus an ARIA role. All 75+ call sites get this unchanged.

## Edge Cases

1. House −85, request 80 → House −5, Store 150 → 70. Allowed.
2. House −85, correct to 12 with `expectedQty` −85 → House 12, logged in the audit.
3. Store −3, request 1 → refused: "The Store holds only -3".
4. A House import adds to a negative balance (−10 + 50 = 40) → allowed.
5. A balance that isn't a whole number (corrupt document) → still `invalid-argument`.
6. The toast is swiped while its auto-hide timer is running → removed once, no error.
7. A request with `reservedQty` greater than the result → the existing "Insufficient available stock" check still applies.

## Testing Criteria

**Happy path**
- `changeStock` request on House −85 with qty 80 succeeds and returns `{ qty: -5, storeQty: 70 }`.
- `changeStock` adjust from −85 to 12 succeeds.

**Edge cases**
- `quantity()` still rejects −1, 1.5 and "80" (a string) as typed input.
- The stored-balance reader accepts −85 and rejects 1.5 and NaN.
- A Store debit below zero is refused.
- Toast: a tap removes it; after a timer fire plus a manual dismiss, it is gone and nothing throws.

## Dependencies

- None. Ships on its own, ahead of Features 3–4.
