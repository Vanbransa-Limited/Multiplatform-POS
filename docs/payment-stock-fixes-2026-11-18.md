# Payment and stock investigation — 18 November 2026

## Confirmed evidence

The user confirmed invoices INV-BH001-000537, 000538 and 000540 were duplicate attempts for one KES 1,050 purchase, and that today's rejected STK/code concerned KES 1,050. Provider confirmation UIPMJ8EEBT arrived on 25 September at 15:27:58.337 UTC. Its verified STK intent remained unused while three manual settlements recorded the same receipt on 18 November. The basket's saved value was KES 1,050; current menu prices total KES 850, which caused the original bill's STK amount to fail catalogue validation.

Invoice INV-BH001-000865 (KES 800) has no successful payment proof in the inspected records. It must not be cleared as part of this correction.

## Changes

- Saved invoice STK initiation uses the authoritative outstanding credit ledger, bound to a staff checkout, instead of current menu prices or a new membership discount.
- Typed STK receipt codes resolve and consume their verified provider intent. Shared receipt claims guard ordinary sales, settlements, proformas and customer orders, including receipts already recorded before claims existed.
- One server-reserved table checkout can allocate a receipt across its rounds within the original amount. Separate checkouts cannot reuse it. Financials sums those explicitly allocated portions once, preserving legacy receipt deduplication.
- Legacy offline sales with conflicting unverified codes still upload their goods and stock history. Their conflicting payment is marked for receipt review, excluded from received money, and shown in Financials/M-Pesa and the AI coverage note. Verified provider-intent conflicts remain refused. Interactive M-Pesa settlement requires all rounds saved on the server first.
- A bill's checkout reference survives reopening and reloads, scoped to tenant, staff, branch and order, so a partially settled table can continue using its receipt allocation.
- Definitively failed/cancelled/expired prompts receive a fresh request key on retry. Unknown responses retain their key. The same staff/device can reclaim its reservation; unresolved prompt references survive a change of payment method.
- Ambiguous and stale prompts are labelled “NO CONFIRMATION — PROMPT ONLY”, independently of unpaid invoice balances. Receipt rows link through actual settlement IDs and checkout keys. “Still on till” requires a published held order.
- Store/House policy remains: selling staff can request, non-approvers wait for approval, owner/store manager may move their own requests directly, and only owner/store manager approves. Decisions are atomic, repeatable without moving stock twice, and recheck active branch/item. A refresh failure after a committed stock operation now reports saved with a refresh warning.

## Historical correction

`scripts/reconcile-kester-duplicate-checkout.cjs` defaults to read-only. Apply requires the explicit project, user-confirmed duplicate flag and the reviewed source fingerprint. It validates the exact receipt, intent, basket, three invoices and ledger entries, and refuses tracked stock movements or a concurrent payment reservation. One transaction archives originals, retains invoice 000537, voids duplicate invoices 000538/000540 and their duplicate ledger entries, consumes the provider proof, and creates a shared receipt claim and audit entry. This records no new payment or refund. Receipt date stays 25 September; 18 November is retained as correction/audit time.

`scripts/verify-kester-reconciliation.cjs` checks one completed invoice, one verified KES 1,050 receipt on 25 September, no duplicate receivable or 18 November collection for this purchase, no stock movement, and the consumed proof/claim. The reconciliation archive makes applying the correction replay-safe.

## Validation status

Local checks: 174 backend tests, 230 frontend tests, and 29 browser checks pass. Backend TypeScript and frontend production builds pass. Browser coverage includes standalone proformas, running orders, payment commit, payment choice, stock counts, mobile controls, catalogue and platform screens. Settlement test doubles enforce Firestore's read-before-write rule and reject undefined write fields.

Claude completed the independent final review of anonymized source following explicit user approval. It approved the guarded correction, with deployment conditional on checking createSale replay ordering. The existing transaction already replays before loading dependencies; an added integration test confirms replay and one stock deduction. Other findings were addressed: legacy offline receipt conflicts, persistent partial-table checkout reference, saved-bill customer/line validation, proforma target priority and retired stock requests. A requested follow-up review returned the Claude account's five-hour usage limit; no second approval is claimed.

## Production result

Released Hosting version `71196c722c3edcca`. All eleven updated functions were independently listed as ACTIVE: createSale, settleSale, claimSalePayment, initiateMpesaStk, queryMpesaStatus, mpesaCallback, checkCustomerOrderPayment, settleCustomerOrderByCode, payProforma, changeStock and decideStockRequest. A transient Firebase HTTP 503 during the first preflight required a retry; the first attempt changed no functions. The metadata service account could not list functions (403), so the successful final ACTIVE check used the existing deployment CLI login.

Live artifact verification matched twelve HTML routes and twenty-eight JavaScript assets to the tested build. Fourteen callable probes rejected unauthenticated requests. Authenticated browser reads confirmed the original receipt displays once as SUCCESS against invoice 000537, the historical unresolved prompt says NO CONFIRMATION rather than unpaid, House and Store load, and the three standalone Judith proformas remain available on desktop and phone. No payment prompts or stock submissions were used for these checks.

The guarded reconciliation was applied with source fingerprint `f3404f02ff8f811e3da04db4856a7ed9269c49b74e33da8f7beaf1c049f1feb5`. Read-only ledger verification confirmed one completed invoice, two cancelled duplicates, one verified KES 1,050 receipt on 25 September, zero unpaid for this purchase, zero receipt money for this purchase on 18 November, zero stock movements and an audit archive. A repeat apply returns already reconciled. Original business settings and M-Pesa configurations in both tenants retain their protected hashes. The three imported unpaid proformas still total KES 42,844 with their original content, author and PDF provenance intact.
