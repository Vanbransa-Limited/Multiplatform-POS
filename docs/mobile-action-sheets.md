# Mobile action sheets

Menu Admin's search toolbar shows search and one Actions button on phones.
Add Product, Import CSV / Excel, Full template and Names-only template are in
the native bottom sheet. Staff Management uses the same pattern for Add User,
Import Users, template download and import guidance. Desktop retains the
original visible controls.

Action sheets dismiss before the original button handler runs, preserving
editor visibility and native file-picker activation. The actual controls and
listeners move between their desktop homes and sheet, with cleanup when a
screen re-renders or navigation changes.

Validation: production build, 176 frontend tests and 14 browser tests. Coverage
includes three phone widths, desktop/tablet, native dialog focus and dismissal,
editor opening, file-picker access, template download after search re-render,
payment selection, central login and compact stock cards. No production form
was submitted during verification.

Deployed to production Hosting on 10 November 2026 with explicit user approval,
together with the pending stock-help removal and compact stock-card refinement.
Live phone checks passed for menu/staff actions, editor entry, cart/navigation,
sticky search and House actions without submitting forms or changing stock.
