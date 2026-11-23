# Shared product standard

Titanium, Artesano and future businesses use one product. Implement general
workflow, reliability and interface improvements in shared code so they apply to
all tenants. Keep new-business defaults in platform onboarding and provide an
audited rollout for existing businesses when a policy needs stored configuration.
Avoid introducing tenant-name or tenant-ID exceptions into shared workflows.

Keep business data, users, branches, stock, prices, tax settings, accepted tenders
and merchant credentials tenant-scoped. A shared improvement does not authorize
copying one business's configuration or records into another. Branch inheritance
must verify branch ownership and active status on the server.

Direct M-Pesa checkout records the code and receipt amount entered by staff,
without a provider lookup step. Save a new receipt total once and audit who
recorded it; subsequent entries cannot change that total. Apply only unused
balances and permanently protect exhausted references against reuse. Manual
entries remain unverified unless provider proof exists. STK confirmation stays
separate from manual entry.
Keep cashier messages short and free of implementation details; preserve actual
verification status in financial records. Future clients inherit the shared
receipt policy through onboarding.

Test with Node 22, matching production. Use the demo Firestore emulator for
payment/concurrency tests; release checks must not create production payments or
test businesses. Deploy only functions and hosting changes relevant to the task.

<!-- postman-cli:installation:start -->
Postman CLI is installed on this device, and can be used for API Engineering work.
<!-- postman-cli:installation:end -->
