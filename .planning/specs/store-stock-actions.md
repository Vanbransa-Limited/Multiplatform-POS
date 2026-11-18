# Spec: store-stock-actions

**Created**: 2026-11-16
**Status**: draft
**Author**: Lloyd
**Epic**: pos-changes-batch (Feature 3)

## Problem

The Stock actions sheet only offers "Receive a delivery" and "Import". A store manager can't bring a brand-new item in without leaving for Menu Admin. They can't add or remove a few units from an existing item (breakage, a found crate) without rewriting the count. And the per-row "Correct" button reads like a stock take when it is a single-item count fix.

## Goal

From the Stock actions sheet, the owner or store manager can: add a new item with its opening stock, add or remove units from an existing item, and run a stock take over many items at once. The per-row button reads "Fix count" and says it's not a stock take.

## User Stories

- As a **store manager**, I want to add a newly introduced item and its opening quantity in one step from the stock screen.
- As a **store manager**, I want to remove 3 broken bottles, or add 2 found ones, with a reason, without retyping the whole count.
- As a **store manager**, I want a stock take that lists every item, so I can type the counts and submit once.

## Requirements

### Must-have
- Stock actions gain three buttons, visible only to the owner and store manager (the server enforces this too): **Add new item**, **Add / Remove stock**, **Stock take**.
- **Add new item**: name (required), SKU (optional), product type, sell price (KES, ≥ 0), opening quantity (≥ 0), delivery reference. It refuses a name or SKU that already exists (case-insensitive), so an existing product is never overwritten. It calls `upsertProduct` with `trackStock: true`, then `changeStock` `receive` if the quantity is > 0, then refreshes. Price 0 creates the item unpriced (unsellable until it's priced), as Menu Admin does.
- **Add / Remove stock**: item, Add or Remove, quantity ≥ 1, reason (required). Sent as `adjust` to current ± qty, with `expectedQty` set to the current count. Remove refuses to go below 0 on the client and names what is there.
- **Stock take**: every item with a "Counted" input (blank means not counted) plus a reason (required). Only filled rows are sent, via `importStock` `count` mode for this room, in chunks of 150. The result is reported (counted / skipped).
- The per-row button is relabelled **Fix count**. A hint under the table reads: "Fix count corrects one item. To count everything, use Stock take."

### Out of scope
- The approval workflow for House requests (Feature 4).
- Editing existing product details (Menu Admin).

## Data Model / API
No change. Reuses `upsertProduct`, `changeStock` (`receive`, `adjust`) and `importStock` (`count`).

## Edge Cases
1. A new item's name matches an existing item ("Whitecap Lager Bottle 500ml" in different case) → refused: "already exists, use Add / Remove stock".
2. Remove 5 when 3 are on hand → refused client-side: "Only 3 in Store".
3. Add 80 when the count is −85 → allowed (result −5); Feature 1 made this work on the server.
4. Stock take with nothing filled → "Enter at least one count".
5. Stock take entry "abc" or −1 → the row is refused by name before sending.
6. Someone else changed the count since loading → the server returns `aborted` "Stock changed. Refresh…" and that message is shown.
7. The new item is created but receiving its opening stock fails → the item exists; the message says so and points to Add / Remove stock.

## Testing Criteria
- Pure helpers (`services/stock-actions.js`): `adjustTarget` (add, remove, remove below 0, invalid qty), `stockTakeRows` (blank skipped, invalid named, valid mapped), `findDuplicate` (name or SKU, case-insensitive).
- `npm test` and `next build` green.

## Dependencies
Feature 1 (negative balances accepted on the server).
