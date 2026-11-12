# Artesano stock and M-Pesa release

Requested on 10 November 2026. Artesano is The Private Lounge in Syokimau,
tenant `tenant-artesano`, branch `tenant-artesano-main`.

## Stock counts

Save Counts now reads the physical balance within the same IndexedDB transaction
as the saved lines. Counts are whole quantities, zero is valid, and failed saves
keep the form usable with an error. Reopening restores saved quantities. Expected
stock is scoped to the selected House or Store and branch, including reserved
units because this is a physical count.

Phone count rows keep the name, quantity and variance within the viewport.
Draft count sheets remain on the device. Approval by an Owner or Store Manager
posts absolute quantities through the existing authenticated `importStock`
callable and refreshes server balances. A failed approval leaves the sheet open;
retry uses the same import reference so a lost response cannot double-post.

## Catalogue ownership

Only Menu Admin's owner/manager product editor and menu import create catalogue
items. Store/House imports reject unknown items even when an older client sends
`createMissing: true`. Stock screens no longer expose an Add New Item form.
Menu Admin includes unpriced and hidden products, while retired entries remain
hidden. Editing/importing a retired product restores it to the managed catalogue.

Delete entirely is owner/manager-only, requires the exact product confirmation,
and rejects nonzero stock, reservations and open orders. It deletes the catalogue
document and zero balances, retains an audit archive in `deleted_products`, and
leaves sales and movement history intact. Cache refresh hides missing server
items while retaining local names for historical receipts; downloaded sale-line
names also take precedence in history views.

The user confirmed removal of Artesano's stock-created duplicate
`product-7ab470aeca3ff53f29937f0e4bf95d203adcc8b9ca61769a`, SKU `PM-SR-750`,
with zero stock. The Menu Admin item
`product-4f52c83984c8f43630df6f3c0b2b39ec91a06720519b1543` is retained.
Titanium's historical Pierre Marcel variants are outside this cleanup.

## M-Pesa

The existing Secret Manager credentials match the supplied legacy handover.
Safaricom production OAuth returned HTTP 200 with a token. No credentials were
copied into browser configuration or repository source, and no shared secret was
changed. Artesano uses Buy Goods, its supplied Till ending 517, and only its own
main branch. Titanium keeps its existing route and accepted payment settings.
STK uses the existing callback endpoint and server verification; persistent C2B
URL registration is outside this change.

Change reference: `ARTESANO-MPESA-20261110`. Routing was staged, then activated
after the selected backend functions deployed. The deployed owner capability
callable returned `{status: 'live', available: true}`. No customer prompt or
real-money charge was sent as an automated test.

## Validation

- Production frontend build.
- 178 frontend and 137 backend tests.
- 18 relevant browser cases, including real IndexedDB count saving, reopening,
  validation, room/branch isolation, approval retry and mobile regressions.
- Deployed `importStock`, `importProducts`, `upsertProduct`, `deleteProduct` and
  Hosting. The confirmed duplicate was deleted through the deployed owner-only
  callable, with its archive verified. The canonical Menu Admin item remains.
- Live owner capability checks passed. Baseline hashes confirm Titanium's route,
  settings and catalogue, and Artesano's canonical item, are unchanged.
- Phone checks cover Menu Admin deletion controls, count save/reopen and removal
  of stock-screen item creation. The count test uses an isolated browser database
  and does not approve counts or mutate production stock.
- Final Firebase Hosting release and the production phone checks passed on
  10 November 2026, followed by another successful owner M-Pesa capability check
  and unchanged protected-record comparison.
