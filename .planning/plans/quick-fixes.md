# Plan: quick-fixes

**Spec**: .planning/specs/quick-fixes.md
**Epic**: pos-changes-batch (Feature 1)
**Created**: 2026-11-16
**Status**: draft

Stack: Firebase Functions (TypeScript, `node --test` on compiled `lib/`) + plain-JavaScript frontend (`node --test src/**/*.test.mjs`).

---

## Architecture

| Component | Type | Purpose |
|-----------|------|---------|
| `storedQty()` | helper in `modules/stock/index.ts` | Reads a stored balance as any safe integer, negatives included. `quantity()` stays the check for typed input. |
| `changeStock` | callable (existing) | Reads `before` and the Store `available` with `storedQty`. Checks the result: only a *debit* (Store side) may not go below 0; a credit is always allowed. |
| `configureStock` | callable (existing) | Merges Store into House with `storedQty`, so a negative House doesn't block switching the Store off. |
| `showNotification` | `frontend/src/context.js` (existing) | Tap or horizontal swipe to dismiss; `role` status/alert; error toasts stay 8 s. |

## Files to Change

| File | What Changes | Why |
|------|-------------|-----|
| `backend/functions/src/modules/stock/index.ts` | Add `storedQty`; use it at lines 110, 127, 206; replace `quantity(after, true)` with an upper-bound check | Spec must-haves 1–4 |
| `backend/functions/test/stock.test.cjs` | Tests for negative House request, negative correction, Store debit refusal, `storedQty` rejecting non-integers | Spec testing criteria |
| `frontend/src/context.js` | Dismiss handler, ARIA role, 8 s for errors | Spec UI must-have |
| `frontend/src/context.test.mjs` (new) | Stubbed-`document` test: a tap removes the toast; a timer firing plus a manual dismiss doesn't throw | Spec edge case 6 |

No new files beyond the test. No schema or API change.

## Tasks

### Phase 1: Backend (TDD)

| # | Task | Files |
|---|------|-------|
| 1 | Red: add failing tests (House −85 request 80 → −5/70; adjust −85 → 12; Store −3 request 1 refused; corrupt 1.5 balance still rejected) | `test/stock.test.cjs` |
| 2 | Green: `storedQty` plus the call sites; the result is checked only against `0 ≤` on the debited side, with an upper bound of 1e8 | `src/modules/stock/index.ts` |

### Phase 2: Frontend (independent of Phase 1)

| # | Task | Files |
|---|------|-------|
| 3 | Red: toast dismiss test with a stub `document` | `src/context.test.mjs` |
| 4 | Green: pointerdown/pointerup swipe (dx > 60) or tap removes it once; `role`; error duration 8 s | `src/context.js` |

| Parallel Group | Tasks | Why |
|---------------|-------|-----|
| A | 1–2 and 3–4 | Separate files and packages |

| Sequential | Depends On | Why |
|-----------|-----------|-----|
| 2 | 1 | TDD |
| 4 | 3 | TDD |

## Testing Plan

| Test | Spec ref |
|------|----------|
| Request into a negative House succeeds; Store debited | Edge case 1, story 1 |
| Correction from −85 to 12 with `expectedQty` −85 succeeds | Edge case 2, story 2 |
| Store −3, request 1 → `failed-precondition` | Edge case 3 |
| `quantity("80")`, `quantity(-1)`, `quantity(1.5)` still throw | Must-have 1 |
| Stored balance of 1.5 → `invalid-argument` | Edge case 5 |
| Existing reserved-quantity test still passes | Edge case 7 |
| Toast: tap removes; double removal is safe | Edge case 6 |

Verification: `npm test` in `backend/functions` and in `frontend`, both fully green.

## Gate 2

- [x] Matches existing patterns (in-file helpers, `node:test` with the existing harness)
- [x] All changed and new files listed; tasks are ≤ 2 files each
- [x] Dependencies and parallel tasks marked
- [x] Business logic, callable and UI tests planned; every spec edge case is mapped (edge case 4, import, already uses `Number()` and works)
