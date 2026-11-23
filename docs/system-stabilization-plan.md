# POS system audit and stabilization plan

Prepared: 20 November 2026 (Africa/Nairobi)  
Planning baseline: `f05bd1b` on `main`  
Status: Phase 0 implementation started; see [test commands](testing.md), [inventory](test-inventory.json), and [baseline evidence](phase0-baseline.md). The full audit has not run.

## Outcome

Stop recurring checkout, receipt allocation, stock, synchronization, and reporting failures by enforcing shared business rules and testing complete workflows before release. An incident is closed only when its original failure has a reproducible test, the underlying rule is enforced at the trusted boundary, other affected entry points pass, and the deployed revision is traceable.

The previous 239 frontend and 182 backend passes are useful baseline evidence. They are not an end-to-end audit result. Phase 0 changes verification tooling and documentation; application fixes and production changes are outside this phase.

## Initial observations

These are source observations and confirmed historical incidents, not a completed vulnerability assessment.

| ID | Observation and evidence | Consequence | First action |
| --- | --- | --- | --- |
| A01 | Root `package.json` runs frontend and backend unit suites. Browser tests, standalone browser checks, rules checks, and emulator scenarios are separate. | A passing default command does not establish that a complete checkout works. | Create a documented aggregate release gate with separate fast and integration stages. |
| A02 | `firebase.json` runs backend tests before Functions deployment; `scripts/safe-deploy.cjs` validates project selection but does not enforce the complete gate, tested commit, or tested artifact. No `.github/workflows` directory exists in this checkout. | Verification depends on the operator remembering extra commands. Remote branch protection and external CI remain unverified. | Add repository CI and release evidence tied to the commit and build artifact. |
| A03 | Fifteen frontend test files use `new Function` to test extracted source with replaced dependencies. Examples: `orders-loading.test.mjs`, `financial-sync.test.mjs`, `order-visibility.test.mjs`. Browser recovery tests also substitute settlement transports. | These tests isolate useful behavior but cannot prove that actual module wiring, callable contracts, and persistence agree. | Retain useful fast assertions; add module and real browser-to-emulator coverage before replacing brittle extraction tests. |
| A04 | `scripts/smoke-test.mjs` defaults to the production project and contains shift/sale mutations plus fixed fixture identities and a PIN. | It is unsuitable as an ordinary automated regression test. Whether its fixtures still authenticate is unverified. | Make mutation checks emulator-only and fail closed; separate production health checks into read-only verification. Do not run the existing smoke script during this audit. |
| A05 | Backend declares Node 22; the current local Node executable reports `v26.13.1`. The older system scenario uses a production-named project with loopback endpoints; newer checks require `demo-tokgut-pos`. | Test/runtime parity and emulator setup are inconsistent. | Standardize Node 22, explicit demo IDs, emulator guards, ports, and fixture setup. |
| A06 | Esther's KES 800 payment covered a KES 700 checkout and a separate KES 100 bill. The first checkout became the receipt's allocation limit; an audited maintenance script was needed to finish allocation. | Valid split payments across separate bills need a deliberate product workflow, beyond grouping rounds already in one checkout. | Specify one receipt with multiple explicit allocations, a known remaining amount, appropriate authorization, and preserved verification status. |
| A07 | Stock requests formerly treated sale-inactive products as retired. A duplicate settings method also shadowed the completed permission controls. Both have been corrected. | Overloaded state and duplicated implementations can pass local checks and reappear through integration. | Audit state definitions and duplicate class members; test the compiled application and every mutation entry point. |
| A08 | README and the August migration audit still describe substantial live workflows as missing or read-only. | Old documentation can drive incorrect implementation and testing assumptions. | Establish an evidence-based current architecture map; date historical documents and replace obsolete operating instructions. |

## Scope and review order

Priority is based on financial correctness and recurrence, not file size or cosmetic complexity.

| Order | Area | Main paths | Required review |
| --- | --- | --- | --- |
| 1 | Receipts and settlement | `backend/functions/src/shared/mpesa-receipt.ts`; modules `sales`, `mpesa`, `customer-orders`, `proformas`; frontend `tender`, `mpesa`, Orders and Till | Allocation, amount limits, provider proof, manual assertions, retries, concurrent payment, split tender, original dates, and auditability. |
| 2 | Orders, tabs, and sync | frontend `sync`, `checkout-rounds`, `tabs`, `tab-edit`, `open-orders`, `sale-history`, `till-draft`; backend `sales/open-orders.ts` | Stable identities, local commits, outbox recovery, snapshot ordering, cross-device checkout, reservations, and visibility. |
| 3 | Inventory and catalogue | stock/catalogue modules; frontend stock, catalogue, inventory, stock counts and imports | Sale eligibility versus retirement, approvals, balanced movements, negative House balances, stock reservations, imports, and replay. |
| 4 | Financials and shifts | frontend `financial-snapshot`, `financial-data`, `takings`, trading periods; backend shifts and settlement | One set of receipt/debt rules, staff attribution, branch scope, trading days, reconciliation, and reporting agreement. |
| 5 | Identity and tenant boundaries | Firestore/Storage rules; provisioning, staff, roles, platform; frontend session/cache handling | Tenant isolation, suspended identities, role changes, credential handling, and server enforcement. |
| 6 | Remaining operational flows | customer directory, public menu, printing, proformas, eTIMS/ETR, settings, exports, active subscriptions/report modules | Contract consistency, failure recovery, reachability, fiscal state, accessibility, and mobile operation. Trace reachability before labelling code dead. |
| 7 | Release and maintenance tooling | root/backend/frontend scripts; emulator tooling; operational and repair scripts; documentation | Test discovery, environment guards, source/artifact provenance, reviewed migrations, rollback, and observability. |

## Business rules that every entry point must satisfy

1. A sale keeps the same identity across local persistence, upload, publication, retry, another device, and later settlement. Read projections never create a replacement sale.
2. One provider receipt represents one amount of money. Multiple invoice allocations may reference it, but their sum never exceeds its authorized amount. Replaying an allocation changes nothing.
3. Typed receipt text and a screenshot are manual evidence. Provider-verified status requires correlated provider evidence. Later confirmation must reconcile existing allocations without creating additional income.
4. Separate booking status, amount outstanding, provider verification, synchronization acknowledgment, and fiscalization. No screen may infer all of them from a single `completed` or `active` flag.
5. Money has explicit units. Server contracts and business calculations use integer minor units; conversion at display and legacy-storage boundaries is tested. A new bill and a saved-bill settlement have distinct pricing contracts.
6. A Store-to-House transfer produces equal and opposite movements exactly once. Asking for approval moves nothing. Retirement, sale eligibility, menu visibility, and stock tracking have separate meanings.
7. A failed refresh does not undo or mislabel a successful commit. A timeout after a commit is recoverable through the same operation identity.
8. A view or device cannot silently erase an unpaid order, recreate a paid one, change another tenant's records, or lose unsynchronized work during upgrade or account switching.
9. Orders, tabs, shifts, and Financials agree on the same underlying outstanding and received amounts when their scopes match. Allocation corrections retain the original receipt date; they do not manufacture income on the repair date.
10. Provider callbacks, concurrent cashiers, and background sync may arrive in any order. Transactions, idempotency, and explicit state transitions preserve rules 1–9.

## Execution phases and exit gates

### Phase 0 — Baseline and reproducible test environment

- Record the reviewed commit, local changes, active routes, schema versions, imports, scripts, and deployed-contract assumptions. Preserve unrelated worktrees and local ledgers.
- Build an incident register from the existing incident documents and recent fixes. Each entry needs a trigger, affected state, expected outcome, reproduction, root cause, and regression-test reference.
- Inventory every test: discovery command, behavior covered, real versus substituted dependencies, runtime, last verified run, and external-service access.
- Pin the test runtime to Node 22; use lockfiles and locally available dependencies for the initial baseline.
- Define one demo-project emulator setup and a test runner that returns failure on missing emulators, skipped required scenarios, stale builds, or failed child processes.
- Separate fast tests, rules tests, browser tests, integration tests, diagnostics, and production maintenance. `npm run verify:baseline` now names the fast/build stages; the eventual `npm run verify:release` still needs complete integration coverage and release provenance.

Exit: every required test is discoverable and classified; fixtures cannot fall through to production; baseline failures and missing capabilities are recorded rather than ignored.

### Phase 1 — Reproduce the recurring failures before refactoring

Implement the matrix below against dummy principals and generated fixtures. Use real IndexedDB for browser persistence and real Firestore transactions for backend integration. Add at least one path using the actual application modules, Firebase client, Auth emulator, callable Functions emulator, and Firestore together. A mocked transport test remains a mocked transport test.

Restore each old failure in a disposable test copy, or introduce a small controlled defect at the relevant boundary, and prove its regression test fails. Then prove the corrected implementation passes. This checks that a test protects the behavior it claims.

Exit: every recurring payment, stock, or disappearing-order incident has a red/green reproduction; the end-to-end fixture checks sales, payments, receivables, stock movements, and Financials together.

### Phase 2 — Correct shared rules and supported workflows

- Trace every caller of the existing receipt allocation helper. Build one policy for amount authorization, remaining balance, target ownership, and replay across sales, customer orders, and proformas. Preserve legitimate differences in their lifecycles.
- Add an explicit, authorized workflow for allocating one payment across selected bills and reconciling an earlier manual allocation. Distinguish the receipt total, the current checkout total, and the amount already allocated. Do not silently increase a receipt limit when a code is reused.
- Define named order/payment/sync/fiscal transitions and adapters for current persisted data. Validate saved-bill settlement independently of cart pricing.
- Put stock movement eligibility in one backend policy used by requesting, approving, importing, and adjusting. Keep sale/menu rules distinct.
- Consolidate outstanding-balance and receipt projections so the UI and reports use the same tested meaning.
- Make failure responses include a usable operation reference and whether the operation committed, is pending, was rejected, or needs review.

Exit: the incident matrix passes through every affected entry point; historical data fixtures remain readable; ordinary supported reconciliation no longer requires a new incident-specific script.

### Phase 3 — Remove flawed and redundant implementations

Search specifically for duplicate class members, copy/pasted settlement or balance calculations, stale fallbacks, swallowed errors, mutable shared retry state, inconsistent enum casing, implicit unit conversion, and direct writes that bypass the trusted mutation path.

Create an active import/route/export map before deleting code. Distinguish live code, intentional adapters, historical archives, one-time migrations, operational scripts, and unused code. A similarly named function is not sufficient evidence of redundancy.

Extract transaction orchestration from large UI classes into importable services where it makes the behavior testable. Preserve tested boundaries and public contracts. Replace source slicing in the critical financial tests with real imports or browser-driven behavior; keep source-text assertions only for genuine structural requirements.

For each cleanup, require a defect or maintenance rationale, caller inventory, replacement, migration/compatibility decision, and regression proof. Avoid a wholesale framework rewrite during stabilization.

Exit: no duplicate critical class members; one authoritative policy per business rule; removed code has a reachability justification; every changed financial path has behavior coverage through actual modules.

### Phase 4 — Security, resilience, and operational audit

- Review tenant, role, staff-status, branch/device, and resource ownership at every callable and rule boundary. Use two dummy tenants and the full role matrix.
- Exercise crash/reload points, lost acknowledgments, offline/reconnect cycles, reordered callbacks, expired leases, and concurrent devices.
- Review catalogue/cache migrations and browser upgrade recovery with existing unsent orders. Never use browser-data clearing as a repair step.
- Measure representative catalogue/history sizes and concurrent staff activity. Establish measured latency/read budgets before changing performance code.
- Review checkout, stock, reconciliation, and stale/error states with Impeccable: keyboard, focus, screen-reader messages, 320/390/768/1440-pixel layouts, and recovery after interrupted actions. Record which gestures were synthesized and which physical devices remain untested.
- Review eTIMS and print retry behavior separately from payment state: provider or printer failure must not create another charge or falsely claim fiscal confirmation.

Exit: confirmed issues have reproduction and repair evidence; unverified hypotheses list their missing evidence. No open critical/major money, data-loss, or tenant-boundary finding is waived by a passing screenshot.

### Phase 5 — Release gate and controlled rollout

- CI runs the fast suites, type checks, production build, rule tests, critical browser scenarios, and browser-to-emulator scenarios on the same commit. Broader deterministic stress/permutation tests run as a separate required stabilization stage before release.
- Test discovery fails if required scenario groups are absent or skipped. Snapshot changes require review; updating a baseline is not proof of correct behavior.
- Build once from the reviewed commit. Record the commit, toolchain, schema/contract version, test results, and artifact hashes. Deployment uses that tested artifact and verifies repository state and required gate evidence.
- Rehearse migrations and rollback on synthetic data and a disposable non-production environment. Explicitly assess older browser clients against the new backend before rollout.
- Publish the backend/rules/frontend in a compatible order. Verify deployed revisions and read-only health checks. Production business mutations remain operational actions with their own scope, never generic automated smoke tests.
- Add diagnostics for aged outbox items, unallocated receipts, allocation conflicts, expired checkouts, and request/approval failures. Choose numerical alert thresholds from baseline measurements; diagnostics must not expose secrets or customer contact details.

Exit: the release is traceable to passing evidence; rollback is rehearsed; any required migration has a checked dry run, idempotent apply, archive, and read-back verification.

## Required regression matrix

Each scenario asserts the final persistent ledger and the user-visible result, not only the returned message. Boundary suites share expectations but exercise their actual entry points.

| ID | Scenario family | Required assertions |
| --- | --- | --- |
| PAY-01 | One KES 800 payment across KES 300 + 400 + 100 on two bills | One receipt; allocations sum to 800; both bills clear; no second charge or stock decrement. |
| PAY-02 | The first KES 700 was already allocated before the KES 100 bill is selected | Authorized reconciliation uses only the remaining money; original entries/date retained; unrelated reuse still refused. |
| PAY-03 | Verified versus typed receipt, with confirmation arriving before/during/after allocation | Verification never inferred from text; later evidence does not duplicate income; rejected/conflicting evidence remains visible for review. |
| PAY-04 | Exact/short/excess payment; partial payment; split tender | Money conserved; explicit remaining balance; declared excess has a defined treatment; no silent coercion. |
| PAY-05 | Saved invoice after catalogue price change or retirement | Original debt is authoritative; no cart-line requirement or second membership discount. |
| PAY-06 | Staff discount, service charge, zero adjustment-only round, rounding | Correct minor-unit totals; empty adjustments do not become chargeable sales; regular zero-value orders follow an explicit policy. |
| PAY-07 | Double-click, lost response, reload, reopened modal, concurrent devices | One sale/allocation; stable retry identity; other cashier cannot pay the same debt twice. |
| PAY-08 | Sale/customer order/proforma share or conflict on a receipt | Supported allocations obey ownership and cap rules; a receipt cannot be independently spent in another workflow. |
| ORD-01 | Three rounds, one voided, one paid, one unpaid | Correct amount due everywhere; only unpaid billable rounds remain running. |
| ORD-02 | Missing tab header, older trading date, settled header with unpaid round | Unpaid work remains discoverable; projections do not create replacement sales. |
| ORD-03 | Cross-device settlement and original till refresh | Same sale UUIDs; one settlement; original table frees only after all debt clears. |
| SYN-01 | Commit succeeds but refresh/response fails | User can recover the original result; no second payment, order, audit entry, or movement. |
| SYN-02 | Crash before/after each local transaction and server acknowledgment | Atomic local state; durable queue; deterministic retry; no data loss. |
| SYN-03 | Parallel publishers, old snapshot arriving last, two browser tabs | Newer state survives; unpaid orders cannot disappear through snapshot races. |
| SYN-04 | Offline settlement, later upload, conflicting typed receipt | Correct tender/debt representation; review state is explicit; upload does not duplicate stock or collected money. |
| SYN-05 | Tenant/staff switch and schema upgrade with queued work | Cached and pending records retain correct ownership; no clearing, leakage, or accidental submission under the new account. |
| STK-01 | Unpriced ingredient, sale-inactive product, retired product, service | Stock/sale/menu eligibility remain distinct for request, approval, import, and adjustment. |
| STK-02 | Approval replay, concurrent approval, insufficient Store | Exactly two balanced movements on success; no movement on failure or pending request. |
| STK-03 | Negative House, reserved stock, correction, Store disable | Refill works; reserved units remain protected; folding locations conserves total stock. |
| FIN-01 | Same receipts seen by Orders, Till, shifts, Financials | Matching totals under identical tenant/branch/staff/time scope; one receipt count across allocations. |
| FIN-02 | Historical reconciliation and trading-day boundary | Original-day income is correct; repair day gains no fictional new receipt. |
| SEC-01 | Two tenants, every role, revoked/suspended staff, forged resource IDs | Forbidden reads/writes fail at the server/rules boundary; UI hiding is not the control. |
| OPS-01 | Print failure, duplicate print, failed fiscal request, callback retry | No additional payment; fiscal status reflects confirmed evidence; retries are attributable. |
| UX-01 | Slow/offline reads, long names, keyboard/mobile completion | Action state remains understandable and operable; committed outcomes are not presented as failed payments. |
| REL-01 | Older client with newer backend, interrupted rollout, rollback | Supported contracts remain functional; incompatible clients receive a recoverable response without losing queued work. |

Add seeded random sequences of these operations after deterministic scenarios pass. Record the seed and event trace for every failure. Test invariants after every step and after convergence; a final green screen alone is insufficient.

## Updating old tests

- Classify each existing test as keep, repair, supplement, replace, or retire, with a reason. Age alone is not a reason to delete it.
- Preserve high-value regressions for delayed Web Crypto/IndexedDB commits, cross-device settlement, voided/empty rounds, unpriced stock, and receipt reuse.
- Replace obsolete fixture identities, hard-coded production defaults, stale domain assumptions, and hand-maintained test lists where they cause omission or incorrect expectations.
- Keep browser-realistic timing cases and upgrade fixtures. Add real service-boundary checks where the existing test replaces the critical dependency.
- Review mocks against the actual callable schema, Firestore transaction semantics, retry behavior, and error codes. Mocks cannot certify those contracts.
- Do not make a test pass by weakening its assertions or refreshing all snapshots. Document changed business behavior and retain a failure that the revised test detects.
- Maintain an incident-to-test map so a reopened incident identifies its original guard and the boundary it failed to cover.

## Skills, evidence, and execution limits

Use Security Audit guidance for source/trust-boundary planning and a separately recorded full security review when that phase begins. Full security review requires independently verified findings and an explicit coverage ledger. Keep its confirmed vulnerabilities separate from code-quality observations and business-rule defects.

The Security Audit skill requires target-controlled execution inside an isolated sandbox with no external network, an allowlisted empty environment, read-only source/toolchain, scratch-only writes, and resource limits. The current workspace tools have not established all those controls. Consequently this planning pass did not run target-controlled security tests. Phase 0 must provision that capability; otherwise record dynamic security checks as needing validation and continue source review. Do not relax those controls by using production credentials.

Use Impeccable for the operational UI audit and bounded desktop/mobile verification. Use the installed Next.js guides before frontend implementation changes. Other specialist skills are added only for their actual domains, such as a focused webhook handler review or DeepStream/Android work if those become in scope.

## Deliverables and closure

The execution produces a current architecture and state map, incident register, test inventory, coverage ledger, prioritized findings with reproduction evidence, revised tests, reviewed fixes in focused pull requests, and a release/rollback record. Record each reviewed area as complete, incomplete, or needing validation; absence of a finding does not imply coverage.

Start with Phase 0, then payment/order/sync/stock reproductions. Each pull request states the triggering failure, the invariant restored, the entry points tested, migration impact, and deployed-contract compatibility. Merge only after its required checks pass; final stabilization release requires the aggregate gate.

Completion means all recurring critical scenarios pass through actual boundaries, no unresolved major financial/data-loss/tenant-isolation defect remains, supported split-receipt reconciliation is available without custom scripts, and release tooling enforces the evidence. Set a defined observation window and metrics before rollout; a recurring integrity incident reopens its root-cause work rather than being closed by another isolated repair.

Do not schedule a background or multi-week audit from this document alone. Work is executed in reviewable phases; duration estimates follow the Phase 0 inventory and reproduced failure count.
