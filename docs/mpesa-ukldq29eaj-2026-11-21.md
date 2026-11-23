# UKLDQ29EAJ: one KES 62,650 receipt across seven bills

The user supplied an SMS showing KES 62,650 paid to SAVAHOPE LIMITED 1 on
21 November 2026 at 01:20 EAT, a calculator breakdown and the affected table
screens. Live inspection matched the breakdown exactly:

| Table | Order | KES | Before correction |
| --- | --- | ---: | --- |
| 50 | ORD-50-276837 | 34,430 | Already allocated over ten rounds |
| 200 | ORD-200-102537 | 2,050 | Outstanding |
| 2 | ORD-2-694504 | 18,150 | Outstanding over five rounds |
| 54 | ORD-54-525048 | 1,100 | Outstanding |
| 980 | ORD-980-369673 | 2,200 | Outstanding over two rounds |
| 988 | ORD-988-404996 | 3,680 | Outstanding |
| 6 | ORD-6-734680 | 1,040 | Outstanding |
| Total | | 62,650 | 34,430 applied; 28,220 remaining |

The original receipt claim was limited to KES 34,430, which caused the repeated
code rejection. The exact reconciliation retains that money and its timestamps
and allocates KES 28,220 to the eleven remaining sale rounds. It archives the
source records and stamps the new settlement and receipt allocation with one
reconciliation ID. It changes no sale items, stock movements, voided rounds or
provider status. No provider confirmation or intent exists for this code, so all
portions remain explicitly manually reconciled and unverified.

Table 54 has a reviewed unconfirmed prompt from 14 November. Its exact ID,
amount, status and timestamp are checked; the reconciliation preserves it
unchanged, without recording it as failed or paid. New or changed provider
evidence, changed table membership, paid targets, extra receipt use, active
checkouts or a changed source fingerprint refuse the correction.

Implementation: `scripts/reconcile-ukldq29eaj-split-receipt.cjs` and the exact
manifest `scripts/incidents/ukldq29eaj-plan.json`. Default execution is read-only;
apply requires the explicit production project and reviewed source fingerprint.
Archive: `multi-bill-UKLDQ29EAJ-20261121`.

Reviewed fingerprint:
`73d9a9e6b345ad07a81c1ca004dcdf5a9afa5c36e3cda8dea748fe1f707133d5`.

Four focused tests cover full application and replay, unchanged stock and voids,
all-or-nothing refusal on drift, conflicting evidence and the exact historical
prompt exception. The verification command checks zero outstanding, KES 62,650
counted once, original receipt money and attribution unchanged, no stock changes,
and no new collection on the correction's trading day.

Production result: applied with the reviewed fingerprint. Read-only verification
confirmed seven settled bills across 21 rounds, zero outstanding, one KES 62,650
receipt, zero new collection on the correction's trading day, unchanged stock,
unchanged excluded voids and the historical prompt unchanged. Repeat apply returned
`already reconciled` without another write. All 15 repository tooling tests passed,
including the four focused correction tests.

The receipt correction does not activate the C2B feed. The checkout changes were
subsequently deployed with explicit user approval on 21 November 2026, Hosting
version `e7fdb165e5fa937c`; C2B remains staged. Release checks are recorded in
`docs/mpesa-receipt-balances-2026-11-21.md`.
