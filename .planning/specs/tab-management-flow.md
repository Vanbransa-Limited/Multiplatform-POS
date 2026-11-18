# Spec: tab-management-flow

**Created**: 2026-11-16
**Status**: built (one open question)
**Author**: Lloyd
**Epic**: pos-changes-batch (Feature 5)

## Problem
- Adding to a tab from Tab Management landed on a till that still offered Pay Now.
- Editing a tab meant finding it again in Orders.
- The same tab name could be open twice: names were compared exactly ("VIP" vs "vip ") and only against this till's own tabs.

## Built
- Tab card: **Add items** opens `/till?table=X` in tab-only mode, where Pay Now is hidden and Add to tab is the action. Clearing the tab leaves that mode.
- Tab card: **Edit tab** opens `/orders?order=REF&edit=1`, and the order viewer opens its item editor straight away.
- Tab card: **Pay now** is unchanged and opens the settle dialog for that order.
- `tabKey()` normalises names (case, spacing, leading "Table"). `openTabAt` and every till comparison use it.
- Before a till opens a *new* tab, it checks the open orders shared from other tills and refuses a name already running elsewhere. The check runs outside the local write transaction. Offline it can't see other tills, so it allows the tab.

## Edge cases
1. "vip " typed while "VIP" is open → joins VIP's tab (unit-tested).
2. "Table 5" open on till A, till B types "5" → refused with a pointer to Tab Management.
3. Offline till → can't see other tills; a duplicate across tills is still possible until it syncs.
4. Duplicates that already exist are left as they are (needs Lloyd's sign-off to merge).

## Open question
"Items in tab management are to be married to the invoice." Pay now already settles every unpaid round on the tab in one payment. Which one is wanted:
- (A) the tab card lists its items;
- (B) one combined invoice/receipt for all rounds;
- (C) both?
