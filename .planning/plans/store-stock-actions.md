# Plan: store-stock-actions

**Spec**: .planning/specs/store-stock-actions.md
**Epic**: pos-changes-batch (Feature 3)
**Created**: 2026-11-16
**Status**: draft

| File | Change |
|------|--------|
| `frontend/src/services/stock-actions.js` (new) | Pure helpers: `adjustTarget`, `stockTakeRows`, `findDuplicate` |
| `frontend/src/services/stock-actions.test.mjs` (new) | Tests for the three helpers |
| `frontend/src/ui/stock.js` | Three panels plus buttons in `.stk-actions`; "Fix count" label and hint; handlers |

Tasks: 1) helpers red → green; 2) panels + handlers in `stock.js`; 3) `npm test` + `next build`.
No backend change.

Gate 2: [x] reuses the existing callables and panel/sheet pattern; [x] files listed; [x] spec edge cases 1, 2, 4 and 5 unit-tested, 3 covered by the Feature 1 tests, 6 and 7 are message paths.
