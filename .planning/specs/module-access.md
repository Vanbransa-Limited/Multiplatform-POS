# Spec: module-access

**Created**: 2026-11-16
**Status**: draft
**Author**: Lloyd
**Epic**: pos-changes-batch (Feature 2)

---

## Problem

Who can open each module is a fixed table in code (`RESTRICTED_TABS`, `frontend/src/navigation.js`). The owner can't take Tabs away from cashiers or give House Stock to a supervisor without a code change. Selling is open to every role (`SELLING_ROLES`), with no way to switch it off.

## Goal

The owner decides in Settings which roles can open each module and which roles can sell. The change applies on each till the next time it loads settings: at sign-in, when Settings or a stock screen opens, or after a sync.

## User Stories

- As an **owner**, I want to switch Tabs off for cashiers, so only bar staff open tabs.
- As an **owner**, I want to switch selling off for the store keeper, so stock staff can't ring up sales.
- As a **store manager**, I can see the access matrix but can't change it, so I can't grant myself more.

## Requirements

### Must-have
- `tenant_settings.moduleAccess`: `{ [moduleKey]: roleCode[] }`. A key that is absent means the built-in default (today's table). The modules are every nav tab plus `sell`.
- The owner always has every module and can sell. This can't be switched off, so the owner can never lock themselves out.
- A new owner-only callable, `setModuleAccess({ moduleAccess })`, validates the keys and roles, writes the map and records it in the audit log. Firestore rules keep refusing direct client writes to `moduleAccess` (it is not on the allowlist).
- Frontend: `canViewTab` and a new `canSell` read the cached map, falling back to the defaults. The sidebar and mobile nav refresh when it changes.
- `sell` is enforced in the till's `registerOrder` (with a sentence explaining why) **and** server-side in `createSale` (`permission-denied`).
- Settings has a "Module access" matrix (modules × roles, without the owner). Only the owner can edit it; others see it read-only.

### Nice-to-have
- "Reset to defaults" button.

### Out of scope
- Per-action permissions inside a module (discounts, stock corrections keep their own rules).
- Per-user overrides; this is per role only.
- Gating settlement and M-Pesa callables on `sell`. They stay on `SELLING_ROLES`, so a till already holding a sale can still be paid.

## Data Model

`tenant_settings/{tenantId}.moduleAccess: map<string, string[]>`, plus `updatedAt` and `updatedByStaffId`. No migration: an absent map means defaults.

## API Changes

`setModuleAccess` (callable, europe region like the others)
- Request: `{ moduleAccess: { "tabs": ["store_manager","bar_staff"], "sell": ["store_manager","supervisor","cashier","bar_staff"] } }`
- Response: `{ moduleAccess }`, normalised (sorted, owner removed, unknown keys refused).
- Errors: `permission-denied` (not the owner); `invalid-argument` (unknown module or role).

## UI Changes

- Settings → "Module access" card: rows for each module including "Sell (ring up sales)", a column per role, checkboxes, and a Save button.
- Till: when selling is off for the role, Pay now and Add to tab show "Selling is switched off for your role."

## Edge Cases

1. The owner unticks every role for Settings → only the owner keeps Settings.
2. An offline sale queued before selling was switched off is refused on replay → it stays in the outbox (`TERMINAL_ERROR`, retried later), not lost, and goes through if selling is switched back on.
3. A store manager calls `setModuleAccess` directly → `permission-denied`.
4. An unknown key (`"hack": [...]`) or role (`"root"`) → `invalid-argument`.
5. The map is cached but the device is offline → the cached copy is used. A device that has never synced → defaults.
6. A store manager tries to write `moduleAccess` to Firestore directly → rule refuses (the key isn't on the allowlist).
7. Store disabled → `store-stock` stays hidden, whatever the map says.

## Testing Criteria

- Backend: owner sets the map and it is normalised and audited; the store manager is refused; an unknown key or role is refused; `createSale` with selling off for the seller's role → `permission-denied`; the default (no map) still sells.
- Frontend: `canViewTab` honours the map and falls back to the defaults; the owner is always allowed; `canSell` defaults to true for every role.

## Dependencies

None.
