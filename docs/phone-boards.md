# Sticky search and phone boards

Orders, Tabs and House/Store Stock keep their search toolbar visible while the
phone page scrolls. Orders' containing section permits sticky positioning;
search and the existing filter sheet remain usable above long result lists.

Routine Orders/Stock success messages are removed. Empty status areas collapse;
failed refreshes, connection warnings and incomplete optional reads remain
visible.

Tabs uses the phone gutter, a compact search toolbar and readable table cards
with Add a round and Pay now links. Saved-order recovery remains available.

House and Store Stock have a compact search/Refresh/Actions row. Stock actions
open in the same native bottom-sheet pattern as filters. Choosing an action
closes the sheet and reveals the existing form without submitting it. Stock
instructions have been removed, and movement history collapses on phones. Balances render as
labelled item cards instead of a wide table. Quantities and the Correct button
share a row; long item names wrap above them. Desktop retains the table layout.

Validation: production build, 176 frontend tests and 12 browser tests, including
scrolling Orders through a long fixture, tab search, labelled House balances,
Actions selection, filter sheets, payments and login routing. A local
integration check used the Artesano account without submitting forms or changing
stock. Deployed to production Hosting on 10 November 2026 after explicit user
approval. The live phone integration check passed for sticky searches, Tabs
search and House Actions without submitting forms or changing stock.

The subsequent help-section removal and compact-card refinement were deployed
on 10 November 2026 with the mobile action sheets. Build, 176 frontend tests and four focused phone browser
checks pass, including two stock locations, long names and button alignment.
