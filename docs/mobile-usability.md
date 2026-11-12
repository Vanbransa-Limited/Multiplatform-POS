# Phone usability improvements

The phone layout previously combined several desktop gutters, fixed 185px
section navigation, multi-column forms and fixed-width dialogs. At 390px,
customer management rendered over 1,000px wide and Settings left roughly
100px for its content.

The phone shell now uses one 12px gutter and one page scroller. Settings,
inventory and QR tools use horizontal section tabs. Customer and shift forms
stack vertically. Form controls use 16px text and touch targets of at least
44px; dialogs fit and scroll inside the dynamic viewport. Wide data tables
retain their own horizontal scroll instead of expanding the page.

On phones the till has a floating View cart / Hide cart button at the bottom
right, above the navigation, preserving the cart while switching. Search
occupies its own row, and the cart button shows item count.
Desktop retains both columns. The More menu uses compact rows, has an explicit
close control, supports Escape, traps keyboard focus and makes background
content inert while open. Stock-location help is collapsed on mobile.

Till and tab checkout require an explicit payment-method choice. Method fields
stay hidden until selected; selecting another method hides the previous inputs.
Cash tab settlement has no unnecessary reference field. Payment choices support
keyboard activation, and confirmation is disabled until a method is chosen.

Staff actions now bind before the roster refresh completes, so Add User works
immediately even with a slow or offline connection.

Validation: production build and TypeScript, 176 frontend tests, and eight browser
tests covering 360px, 390px, 430px, tablet and desktop layouts plus central
login routing. Form tests type into customer, staff and product fields and
cancel without saving. Backend data and account credentials are unchanged.

Deployed to production Hosting on 10 November 2026 after the user explicitly
approved the mobile changes and requested a bottom-right floating cart. The
live phone check verifies cart visibility, navigation and forms without saving
test forms or creating sales.

```powershell
npm --prefix frontend run build
npm --prefix frontend test
cd frontend
npx playwright test visual/mobile.spec.ts visual/platform.spec.ts --reporter=line
npx playwright test visual/payment-choice.spec.ts --reporter=line
```
