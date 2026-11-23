# Test commands and environment contract

Phase 0 of the [stabilization plan](system-stabilization-plan.md) separates fast checks from workflow verification. Passing one group is not a release certificate.

## Runtime and dependencies

Use Node 22, as declared in `.nvmrc` and package engines, matching the deployed Functions runtime. `verify:baseline` and the emulator runner reject other Node majors. Individual unit commands remain available for diagnostic checks on another runtime; record that mismatch with their results.

Frontend and Functions have independent lockfiles and dependencies. Use their checked-in lockfiles when provisioning a test environment. Browser checks also require the matching Playwright browser; emulator checks require the installed Firebase CLI and JDK 21 or newer. Required tooling must be provisioned before a network-isolated audit run. A missing tool or fixture is a validation gap, not a passing check.

## Commands

Run from the repository root:

| Command | What it verifies | What it does not establish |
| --- | --- | --- |
| `npm test` | All discovered tooling, frontend, and backend unit tests; builds backend first | Browser persistence, real callable transport, rules, or complete workflow behavior |
| `npm run test:tooling` | Emulator target validation, test discovery, child failure propagation, runner setup | Application correctness |
| `npm run verify:baseline` | Node 22; tooling tests; frontend tests; backend build/tests; frontend typecheck; static production build | Emulator/browser workflow coverage or a release gate |
| `npm run test:emulator` | Fresh backend build; local Auth, Firestore, Functions; system scenario, stock transactions, receipt reconciliation, settings rule client | Browser-to-callable integration, every rule boundary, external provider behavior |
| `npm --prefix frontend run visual` | Production build and Playwright suite | Real provider behavior; inspect each test's substituted transport |
| `node frontend/e2e/<check>.mjs` | The standalone check named by that file | Other scenarios; check each file's fixture requirements |

`scripts/run-node-tests.cjs` discovers `.test.cjs`, `.test.mjs`, and `.test.js` recursively. It rejects an empty suite and returns a failing child exit code. It does not follow directory symlinks or traverse `node_modules`/`.git`. Adding a unit test no longer requires editing the backend package script.

The [test inventory](test-inventory.json) records the Phase 0 snapshot, test-file hashes, suite ownership, and validation status. Refresh it after merging concurrent application changes; those changes are outside this snapshot.

## Emulator contract

The integration runner uses `firebase.e2e.json`, isolated from the normal developer ports:

| Service | Endpoint |
| --- | --- |
| Project | `demo-tokgut-pos` |
| Auth | `127.0.0.1:9399` |
| Firestore | `127.0.0.1:8380` |
| Functions | `127.0.0.1:5301`, region `europe-west1` |
| Hub | `127.0.0.1:4800` |

`npm run test:emulator` supplies the explicit project and endpoints, starts the emulators, executes all five stages sequentially, and propagates any failed stage. The normal development seed is not needed: these tests provide their own demo fixtures. Temporary settings tokens are removed afterward. Do not run these scenarios against shared emulator state that needs preserving.

`npm run smoke` is now a lower-level emulator-only entry point for the system scenario. It validates all endpoint/project variables before loading the scenario, has no production fallback, and has no hard-coded staff PIN. Prefer the integration runner, which configures the environment. Starting smoke without those variables fails before any SDK initialization or request.

All nonempty values in `GCLOUD_PROJECT`, `GOOGLE_CLOUD_PROJECT`, `FIREBASE_PROJECT`, and `FIREBASE_CONFIG.projectId` must agree on `demo-tokgut-pos`. Auth, Firestore, and Functions endpoints must be explicit loopback host/port values. URLs with credentials, paths, query strings, fragments, or remote hosts are rejected.

## Audit execution and results

For security audit execution, use the Security Audit skill's isolated environment: no external network, no host credentials/services, read-only source/dependencies, scratch-only writes, and CPU/memory/process/disk/time limits. Docker is one possible implementation. Do not mount the Docker socket, real Firebase configuration, private environment files, credential directories, or the host home into the test process.

Record the exact commit plus any reviewed patch, runtime, test-file manifest, fixture setup, commands, results, skipped/blocked checks, and transport substitutions. Do not change assertions or refresh screenshot baselines simply to obtain a pass. A failure must distinguish a code defect, an obsolete expectation, and a test-environment defect.

The full `verify:release` command, CI enforcement, actual browser-to-emulator scenarios, and deployment provenance remain subsequent stabilization work. They are not implemented by Phase 0.
