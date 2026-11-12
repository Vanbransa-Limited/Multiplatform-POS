# Mobile filter sheets

The reference is Mamazone's catalog `FilterSheet.tsx`: a sliders icon trigger,
native bottom dialog, active count, Reset, Close and Show results. Only the
reference source was read; Mamazone was not modified.

At phone widths, the POS uses this pattern for:

- Orders: status buttons, date ranges, branch scope and export.
- Financial Report: dates, quick periods and trading sessions.
- Till: product category buttons.

Search stays on the main screen. Desktop retains its original controls. A
shared helper moves the existing controls rather than duplicating them, keeping
their values and listeners intact. Filter changes apply using the existing
screen behaviour; Show results dismisses the sheet. Escape and the close button
dismiss it, and native dialog behaviour traps focus and makes the background
inert. Resizing to desktop restores the controls to their original positions.

Validation includes the production build, frontend tests, browser tests for
open/close/reset/preserved values and desktop resizing, and a local integration
check with the existing Artesano account. No records were changed by the
integration check. Deployed to production Hosting on 10 November 2026 after
explicit approval. A live mobile integration check verified the category,
order and financial filter sheets, selections, Reset and Show results.

```powershell
npm --prefix frontend run build
npm --prefix frontend test
cd frontend
npx playwright test visual/mobile-filters.spec.ts visual/mobile.spec.ts visual/payment-choice.spec.ts visual/platform.spec.ts --reporter=line
```
