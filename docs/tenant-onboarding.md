# Business onboarding

Everyone signs in at `/till/`. Authenticated platform administrators are routed
to `/platform/`; business staff enter their own POS. Opening `/platform/`
without an appropriate session returns to the central sign-in page.
Sign in as `tech@vanbransa2.com`. Its generated password is stored locally in
the ignored `.emulator/platform-login.txt` file.

The administrator account was created in `vanbransa-pos` on 10 November 2026.
It has the `platform_admin` claim and an active `platform_admins` registry
entry. It has no tenant/staff claims. Both destinations use the same Firebase
session; claims choose the destination and backend checks enforce access.

## Add a business

Enter its name, unique identifier, first branch, owner name/email and initial
password. Optionally upload a PNG, JPEG or WebP logo up to 130 KB. The logo
appears above that business's POS left menu. Businesses without a logo show
their name; Titanium retains its existing logo.

**Create business and owner** creates a new tenant, settings, branch, till
device, walk-in customer and owner. The catalogue starts empty and cash is the
initial payment method. Share the initial owner password securely. The owner
uses the same `/till/` sign-in page to add staff and products. No per-business
build, environment variable, database console edit or deployment is needed.
Payment-provider activation remains separate from creating the workspace.

An email already attached to an account is refused. An existing business
identifier cannot be overwritten. Retrying the same request does not create
another business. Failed email collisions release the unused identifier.

## Isolation and validation

- Server authorization requires a platform-admin claim, the exact allowed
  email and an active registry entry. Tenant owners cannot onboard businesses.
- Tenant creation uses create-only database transactions and unique tenant
  IDs. Existing authentication identities are never adopted.
- Titanium keeps its existing `POS_DB`, cached settings and unsynced sales.
  Other businesses use separate IndexedDB databases and preference keys.
- Authentication claims select the cache, branch, device and walk-in customer.
  A tenant change reloads the page; sync checks the cache against the claims.
- Staff management and bootstrap recovery reject identities belonging to
  another tenant, including platform-admin identities.

Validation commands:

```powershell
npm --prefix frontend test
npm --prefix backend/functions test
npm --prefix frontend run build
node frontend/visual/tenant-cache-check.cjs
cd frontend
npx playwright test visual/platform.spec.ts --reporter=line
```

The browser cache check uses a local origin with actual Chromium and Dexie. It
preserves a legacy pending sale, product and discounts while exercising a new
tenant cache. The onboarding browser tests mock authentication and callable
responses; backend tests cover authorization, retries, collision handling and
unchanged existing tenant records. These are not live production sale tests.

Claude CLI was attempted for independent review but returned an expired OAuth
token (401). A separate Codex review agent reviewed the implementation and
added staff-identity regression tests. Claude review remains outstanding.

## Production release

The application was deployed to `https://vanbransa-pos.web.app/platform/` on
10 November 2026 after explicit user approval. Hosting and the five selected
functions below were released successfully. A live Chromium check verified
password sign-in, the onboarding form, business listing, sign-out and the POS
sign-in screen. Existing tenant document hashes matched the pre-release
snapshot. No business or test sale was created during verification.

The production deploy guard in `scripts/safe-deploy.cjs` requires explicit
production approval for future releases.

After approval, publish hosting plus `createPlatformTenant`,
`listPlatformTenants`, `createStaffUser`, `importStaff` and `bootstrapOwner`.
Avoid a blanket functions/rules deployment: this workspace also contains
pre-existing unrelated changes. Run the checks above immediately before
release, then smoke-test administrator sign-in and the legacy Titanium
sign-in. Do not create test sales in Titanium.

The one-time account bootstrap is `scripts/bootstrap-platform-admin.mjs` with
an explicit `--project`. It refuses existing emails and must not be rerun to
reset an account. Password changes must use the existing identity.
