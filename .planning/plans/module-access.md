# Plan: module-access

**Spec**: .planning/specs/module-access.md
**Epic**: pos-changes-batch (Feature 2)
**Created**: 2026-11-16
**Status**: draft

## Files to Change

| File | What Changes |
|------|-------------|
| `backend/functions/src/shared/roles.ts` | `MODULE_KEYS`, `canSell(settings, role)`, `normaliseModuleAccess(input)` |
| `backend/functions/src/modules/staff-admin/index.ts` | `setModuleAccess` callable (owner only, audited) |
| `backend/functions/src/index.ts` | export `setModuleAccess` |
| `backend/functions/src/modules/sales/base-context.ts` | refuse when `!canSell(settings, staff.role)` |
| `backend/functions/test/roles.test.cjs` | normalise and `canSell` tests; callable tests |
| `frontend/src/navigation.js` | `DEFAULT_ACCESS` in role codes; `canViewTab` and `canSell` read the cached `pos_module_access` |
| `frontend/src/services/stock.js` | `pullStock` also caches `moduleAccess` (it already reads `tenant_settings` and fires the nav refresh event) |
| `frontend/src/services/module-access.js` (new) | `saveModuleAccess` → callable, then refresh the cache |
| `frontend/src/navigation.test.mjs` (new) | `canViewTab` / `canSell` tests |
| `frontend/src/ui/settings.js` | Module access card |
| `frontend/src/ui/till.js` | `registerOrder` guard |

## Phases

1. Backend helpers + tests (red → green) → callable → `createSale` guard.
2. Frontend `navigation.js` + test → cache in `pullStock` → service → Settings card → till guard.

The two phases are independent except for the callable name.

## Gate 2
- [x] Matches existing patterns: callable + audit (like `configureStock`), tenantStorage cache (like `pos_store_enabled`), the existing nav refresh event.
- [x] All files listed; tasks small; tests mapped to edge cases 1–5 and 7 (edge case 6 relies on the existing rules allowlist).
