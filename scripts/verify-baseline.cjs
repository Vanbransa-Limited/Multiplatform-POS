"use strict";
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function assertTestRuntime(version = process.versions.node) {
  if (Number(version.split('.')[0]) !== 22) {
    throw new Error(`Baseline verification requires Node 22, matching production Functions; found ${version}. See .nvmrc.`);
  }
}
function baselineSteps(root, npmCli = process.env.npm_execpath) {
  if (!npmCli) throw new Error('Run through npm run verify:baseline so the installed npm CLI is used.');
  const npm = (...args) => [npmCli, ...args];
  return [
    { name: 'tooling tests', args: [path.join(root, 'scripts/run-node-tests.cjs'), path.join(root, 'scripts/test')] },
    { name: 'frontend tests', args: npm('--prefix', 'frontend', 'test') },
    { name: 'backend build and tests', args: npm('--prefix', 'backend/functions', 'test') },
    { name: 'frontend typecheck', args: npm('--prefix', 'frontend', 'run', 'typecheck') },
    { name: 'frontend production build', args: npm('--prefix', 'frontend', 'run', 'build', '--', '--webpack') },
  ];
}
function main() {
  assertTestRuntime();
  const root = path.resolve(__dirname, '..');
  for (const step of baselineSteps(root)) {
    console.log(`[baseline] ${step.name}`);
    const result = spawnSync(process.execPath, step.args, { cwd: root, stdio: 'inherit', windowsHide: true,
      env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1' } });
    if (result.error) throw result.error;
    if (result.status !== 0) { process.exitCode = result.status ?? 1; return; }
  }
  console.log('[baseline] All five baseline stages passed. Browser and emulator verification are separate required stages; this is not release certification.');
}
module.exports = { assertTestRuntime, baselineSteps };
if (require.main === module) {
  try { main(); } catch (error) { console.error(`[baseline] ${error.message}`); process.exitCode = 1; }
}
