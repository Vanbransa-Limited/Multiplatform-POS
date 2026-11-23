# Phase 0: verification baseline

Date: 20 November 2026 (Africa/Nairobi)  
Source: committed `f05bd1b` plus the Phase 0 tooling changes listed below. Concurrent application edits are excluded.  
Status: Phase 0 tooling implemented and diagnostic unit/type checks passed; production-runtime and integration verification remain pending.

## Implemented

- Added `.nvmrc` and root/frontend engine declarations for Node 22; synchronized frontend lock metadata. Functions already declares Node 22.
- Added `npm run verify:baseline`: tooling tests, frontend tests, backend build/tests, frontend typecheck, and production static build. It stops on a failed stage and rejects other Node majors before running a stage.
- Replaced hand-maintained backend test enumeration and shell-dependent frontend globs with explicit recursive discovery. Empty suites and failing child tests fail the command.
- Added tooling tests to root `npm test` so harness failures cannot be omitted from that command.
- Replaced the production-default mutation smoke script with a guarded demo-emulator scenario. Removed its public production target fallback, fixed fixture identities, fixed PIN, and direct production authentication URL.
- Reused the seed safety helper for tests. It now accepts an explicit environment for testing, checks `FIREBASE_PROJECT` as well as the other project declarations, and rejects endpoint credentials, paths, queries, and fragments.
- Added `npm run test:emulator` and routed the backend `e2e` command to it. It builds Functions, selects the existing CLI/JDK, and supplies explicit demo-project loopback endpoints. Its worker sequences the system, stock, receipt, settings-fixture, and settings-rules stages and propagates failure. These assembled integration stages still require an actual run under the required toolchain.
- Updated the old system/rules fixture entry points to validate the demo target rather than overwrite the environment with production-named configuration.
- Added [testing instructions](testing.md), a [test-file inventory](test-inventory.json), and a dated architecture-documentation notice in README.

## Checks and current evidence

The source snapshot was created from `git archive f05bd1b`, with only reviewed Phase 0 files overlaid. No private environment files, host credential directories, Docker socket, or production connections were exposed to the test process.

Diagnostic execution uses the already cached `node:24-bookworm-slim` image, reporting Node `v24.21.0`. This does **not** satisfy the required Node 22 baseline. Docker restrictions: no network; read-only root/source/dependencies; UID/GID 65534; no capabilities or privilege escalation; 2 CPUs; 1536 MiB memory; 128 processes; 1024 open files; 16 MiB per-file limit; 256 MiB scratch filesystem. Test subprocesses have an explicit safe environment and bounded wall time. Backend dependencies were copied by trusted setup code from installed files into a temporary volume, then mounted read-only for tests. No dependencies were downloaded.

| Check | Result |
| --- | --- |
| Tooling: four existing plus seven new tests | Passed: 11 tests on Node 24 |
| Frontend unit baseline | Passed: 239 tests on Node 24 |
| Backend TypeScript compilation | Passed on Node 24 |
| Backend unit baseline | Passed: 182 tests on Node 24 |
| Frontend TypeScript check | Passed on Node 24 |
| Actual baseline entry point on the wrong runtime | Passed: rejected Node 24 before any stage ran |
| Node 22 baseline, including production build | Needs validation: Node 22 is not installed/cached in the checked locations |
| Complete assembled emulator runner | Needs validation: matching isolated Node/JDK/Firebase toolchain |
| Browser/visual/standalone checks | Inventoried; not executed in this Phase 0 pass |
| Full browser-to-emulator and security coverage | Subsequent audit phases; no coverage claim |

Two early diagnostic runs were incomplete. One omitted the static image fixtures required by the catalogue test; that fixture was added. The following run reached its 120-second limit while repeatedly loading backend packages over a Windows filesystem mount. Neither was recorded as a completed backend pass. The final run uses the same installed packages from a local read-only container volume.

The new failure-propagation regression initially exposed inherited `NODE_TEST_CONTEXT` suppressing a nested Node test invocation. The runner now removes that marker before launching its own test process. The test then passed for an empty suite, an intentional failing fixture, and the corrected passing fixture. The final diagnostic evidence is 432 passing tests, backend compilation, and frontend type checking on Node 24; there is no Node 22 or production-build pass in this audit record.

## Test inventory

The snapshot contains 84 test entry files: 2 tooling, 41 frontend unit, 19 backend unit, 13 Playwright specs, 5 standalone browser checks, 3 backend emulator scenarios, and 1 rules client. The settings seed is a supporting fixture. The inventory records file hashes so results are tied to a source snapshot. These are file counts, not counts of test cases or claims of end-to-end coverage.

Other work is adding application changes and tests concurrently. Refresh this inventory and rerun the required checks against their merged revision before claiming a result for that combined codebase.

## Remaining exit requirements

1. Provision the isolated Node 22 toolchain and matching platform dependencies, Firebase/JDK tools, and Playwright browser before freezing the execution environment.
2. Run `verify:baseline` on Node 22; run the assembled emulator stages and existing browser checks. Diagnose failures without weakening assertions.
3. Finish the incident-to-test register and state/entrypoint map; keep mocked and actual-service evidence distinct.
4. Review the Phase 0 diff independently of the concurrent application changes. Integration and release provenance gates are later work; do not treat this baseline command as `verify:release`.

No Phase 0 deployment is performed. The tooling changes remain local pending the missing runtime/integration validation and review.
