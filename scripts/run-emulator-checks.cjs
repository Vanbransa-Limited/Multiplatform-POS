"use strict";
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { resolveFirebaseCli, resolveJavaRuntime, withJavaRuntime } = require('./lib/toolchain.cjs');
const { assertTestRuntime } = require('./verify-baseline.cjs');
const { emulatorTestTarget } = require('./lib/test-target.cjs');

function main() {
  assertTestRuntime();
  const args = process.argv.slice(2);
  if (args.some(arg => !['--receipts-only', '--etims-only', '--tables-only'].includes(arg)) || new Set(args).size > 1) throw new Error('Unknown emulator check option');
  const receiptsOnly = args.includes('--receipts-only');
  const etimsOnly = args.includes('--etims-only');
  const tablesOnly = args.includes('--tables-only');
  const root = path.resolve(__dirname, '..');
  if (!process.env.npm_execpath) throw new Error('Run npm run test:emulator.');
  const build = spawnSync(process.execPath, [process.env.npm_execpath, '--prefix', 'backend/functions', 'run', 'build'],
    { cwd: root, stdio: 'inherit', windowsHide: true });
  if (build.error) throw build.error;
  if (build.status !== 0) { process.exitCode = build.status ?? 1; return; }
  const cli = resolveFirebaseCli(root);
  const environment = withJavaRuntime({ ...process.env,
    GCLOUD_PROJECT: 'demo-tokgut-pos', GOOGLE_CLOUD_PROJECT: 'demo-tokgut-pos', FIREBASE_PROJECT: 'demo-tokgut-pos',
    FIREBASE_CONFIG: JSON.stringify({ projectId: 'demo-tokgut-pos' }),
    FIRESTORE_EMULATOR_HOST: '127.0.0.1:8380', FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9399',
    FIREBASE_FUNCTIONS_EMULATOR_HOST: '127.0.0.1:5301' }, resolveJavaRuntime());
  emulatorTestTarget(environment);
  const result = spawnSync(cli.command, [...cli.argumentsPrefix, 'emulators:exec', '--config', 'firebase.e2e.json',
    '--project', 'demo-tokgut-pos', '--only', receiptsOnly || etimsOnly || tablesOnly ? 'firestore' : 'auth,firestore,functions',
    tablesOnly ? 'node backend/functions/e2e/tab-lifecycle.cjs' : etimsOnly ? 'node backend/functions/e2e/etims.cjs' : receiptsOnly ? 'node scripts/run-receipt-scenarios.cjs' : 'node scripts/run-emulator-scenarios.cjs'],
  { cwd: root, env: environment, stdio: 'inherit', windowsHide: true, shell: cli.shell ?? false, timeout: 15 * 60_000 });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}
if (require.main === module) {
  try { main(); } catch (error) { console.error(`[emulator-checks] ${error.message}`); process.exitCode = 1; }
}
