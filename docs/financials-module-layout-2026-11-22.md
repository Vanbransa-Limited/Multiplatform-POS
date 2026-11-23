# Financials and AI navigation

Financials now shows one focused section at a time, inspired by the module
header and tab arrangement in the read-only reference project
`../Final/wt-v04`.

The shared navigation contains Overview, Payments, Sales & staff, Unpaid orders,
Invoices and AI assistant. Overview prioritizes payments received, sales after
discounts, outstanding balances and actionable payment checks. Detailed receipt
tables, staff reports and AI conversation each have their own section.

The existing report period applies across report sections. Invoices retains its
own filters and loads its register only when opened; switching tabs preserves
invoice searches and forms. Report provenance remains available in an expandable
status note. AI refreshes replace the short report context instead of appending
repeated full summaries.

The AI assistant hides the report period controls and report status note so the
conversation starts directly beneath the navigation. Financial report tabs keep
those controls; the assistant continues using the loaded report context.

Tabs support keyboard navigation and browser history. All six choices remain
visible on phones. Tables scroll within their section. This is shared product
code for all tenants; permissions, tenant isolation, financial calculations and
payment reconciliation rules are unchanged.

## Validation

- Node 22 production static build completed.
- All 251 frontend tests passed.
- Finance browser checks passed for report totals, date changes, partial refresh
  failures, keyboard/history navigation, lazy invoice loading and disposal,
  AI context replacement, mobile filters and phone/desktop layouts.
- Two visual passes completed at 390 px and 1500 px; final layout scan had no
  findings.
- Release scope: Firebase Hosting only, project `vanbransa-pos`.
- Deployed Hosting version `02108035b8ca175e` on 22 November 2026.
- Live verification passed: nine routes and 23 JavaScript assets matched the
  production build; ten existing callable authentication gates rejected
  unauthenticated requests.

No production payments or test businesses were created during validation.
