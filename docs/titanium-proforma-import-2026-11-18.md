# Titanium prepared proformas - 18 November 2026

Status: deployed and all three invoices imported into production on 18 November 2026.

The user supplied three PDFs and requested their addition to Titanium after
deployment, with a Claude check of the combined changes. Each document names
Judith Nandacha as its author. Production account reads confirmed Titanium is
`tenant-01` and Judith's active staff record is
`staff-073f331f9793cae5c133b69f034d593420e102389e798ecd`.

| Proforma | Invoice date | Client | Amount due (KES) | Lines |
| --- | --- | --- | ---: | ---: |
| PF-261118-01 | 18 November 2026 | Kenya National Cultural Centre | 10,360.00 | 2 |
| PF-261116-01 | 16 November 2026 | Kevin Kimani Kahuro / KITFEST | 24,984.00 | 29 |
| PF-261116-02 | 16 November 2026 | Kevin Kimani Kahuro / lunch | 7,500.00 | 1 |
| Total | | | 42,844.00 | 32 |

The KITFEST discount is KES 2,776.00 against a KES 27,760.00 subtotal. All
quantities, prices and totals reconcile to the PDFs. The PDFs' printed due-date
fields and terms are preserved: both Kevin documents say 23 November in their
due-date fields and 20 November in their terms. No correction was inferred.

PF-261116-02 explicitly references `INV-BH001-001694`, an existing unpaid
KES 7,500 credit sale in the main Titanium branch. Import links that original
sale instead of creating a second receivable. The sale's original amounts,
cashier, supply date and stock history remain unchanged. The standalone register
represents its unpaid position; future payment clears the old credit and records
one new receipt atomically. Ordinary till settlement and voiding cannot bypass
the linked locked proforma.

The import creates immutable invoice records, number reservations, provenance
hashes and import audit entries. Judith remains the document preparer; the audit
identifies the operation as an administrative import. All three remain unpaid.
Import creates no sale, payment, tax invoice or stock movement.

`scripts/import-prepared-proformas.cjs` defaults to a read-only transaction and
requires an explicit project and local manifest. Applying the verified manifest
is atomic across all three documents and rejects conflicting numbers or a
changed original bill. Repeating the same import returns the existing records.
Original PDFs and their extracted local manifest are kept outside shipped assets
under ignored `tmp/` paths and the user's original Downloads paths.

The release combines the proforma feature with the previously deployed cached
loading and phone layout work. Existing eTIMS code remains in the combined source.
Uncommitted work and git history are retained; no commit or push is performed.

Local validation: 223 frontend checks, 166 backend checks, 29 browser cases and
the production build pass. Browser coverage includes payment commit/rollback,
safe retry, stock counts, tab/stock phone navigation, searchable dropdowns,
platform isolation and QR invoice issue/lock. The import dry run confirms all
three records and the original bill's unpaid balance.

Claude performed an initial read-only merge review and a final verification of
its five requested fixes, the import plan and regression logs. Both reviews
found no deployment/import blocker. Findings addressed mandatory bill linkage,
duplicate-payment messaging, original invoice dates, navigation disposal and
exclusion of linked bills from running tabs. Claude inspected source and logs;
the operator ran the tests and live checks.

Firebase confirmed successful deployment of the proforma and supporting
settlement/eTIMS Functions, Firestore rules and Hosting. Hosting version:
`483d646619302e1f`. All nine inspected deployed pages and 25 JavaScript assets
match the tested build. All ten callable authentication probes refused
unauthenticated requests without writing money.

Production verification confirms all three invoice bodies exactly match their
validated PDF data, Judith's staff attribution, source hashes, unpaid status and
number reservations. The October original bill is linked correctly. A targeted
financial reconciliation reports KES 42,844 unpaid, zero received, and exactly
three invoice balances. Replaying the import returns `already imported` for each
invoice and creates no duplicates.

An isolated browser authenticated as Judith's existing account opened the live
standalone register and displayed all three invoices at desktop and phone
widths. No payment was taken by these checks. Authenticated startup updates
login metadata and publishes only that isolated browser's own empty open-order
snapshot; it does not change other tills' tables.

Post-deployment and post-import hashes confirm both tenants' business records,
payment settings and M-Pesa routing are unchanged. The import does not mark any
invoice paid. Future full payments are recorded on the receipt trading day.

Detailed review, deployment and verification evidence is retained locally in
ignored `tmp/proforma-release/`. The original PDFs remain unchanged in Downloads.
