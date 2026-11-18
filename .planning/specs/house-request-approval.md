# Spec: house-request-approval

**Created**: 2026-11-16
**Status**: draft
**Author**: Lloyd
**Epic**: pos-changes-batch (Feature 4)

## Problem

"Request into House" moves stock from the Store to the House immediately (`changeStock` with action `request`). Only stock staff and bar staff can use it, and no one signs off on what leaves the Store. The business wants waiters, bar staff and managers to *ask* for stock, and the store manager to approve each move.

## Goal

A House request creates a pending request and moves nothing. The store manager (or the owner, as a fallback) approves it, which moves the stock, or rejects it. Requests made by the store manager or owner move at once.

## User Stories

- As a **waiter or bar staff member**, I want to request 24 Tusker into the House and see that it is waiting for approval.
- As a **store manager**, I want a list of pending requests to approve or reject, so nothing leaves the Store without me.
- As an **owner**, I can approve when the store manager is off shift.

## Requirements

### Must-have
- Request roles: owner, store_manager, supervisor, cashier, bar_staff, store_keeper.
- `changeStock` with `request` from a non-approver creates `stock_requests/{id}` (`id = deterministicId('stock-request', tenant:requestId)`): `{ tenantId, branchId, productId, productName, qty, note, status: 'pending', requestedByStaffId, createdAt }`. Returns `{ status: 'pending', requestId }`. It is idempotent on `requestId`. Nothing moves.
- `changeStock` with `request` from an owner or store manager moves the stock immediately (today's behaviour).
- New callable `decideStockRequest({ requestId, decision: 'approve' | 'reject', reason? })`, owner or store manager only:
  - approve → in one transaction: re-check the Store has enough, debit the Store, credit the House, write movements and an audit entry, set `status: 'approved'`, `decidedByStaffId`, `decidedAt`;
  - reject → `status: 'rejected'` with the reason;
  - a request that is no longer pending → `failed-precondition` "already approved/rejected".
- Rules: `stock_requests` readable by the tenant, never client-writable.
- UI: the House request form says "Requested — waiting for the store manager". A **Pending requests** list shows on the House and Store screens, with Approve and Reject buttons for the owner and store manager.

### Out of scope
- Notifications or push alerts to the store manager.
- Partial approval (approving fewer than were requested). Reject it and ask for the right amount.

## Edge Cases
1. The Store has only 10 when a request for 24 is approved → refused "The Store holds only 10"; the request stays pending.
2. Two managers approve at once → the transaction lets one through; the other gets "already approved".
3. A cashier calls `decideStockRequest` → `permission-denied`.
4. The same `requestId` is replayed → the same pending request is returned, not a duplicate.
5. The Store is switched off while requests are pending → approval refused "There is no Store"; reject still works.
6. House is negative (−85) and a request for 80 is approved → House −5 (Feature 1).

## Testing Criteria
Backend: a cashier's request is pending and moves nothing; the manager approves and the stock moves with movements and an audit entry; double approve is refused; insufficient Store is refused and stays pending; reject; a cashier can't decide; a manager's own request moves at once; replay is idempotent.

## Dependencies
Feature 1.
