"use strict";
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

/** Explicit discovery is consistent across Node versions and Windows shells. */
function discoverTests(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory() && !['node_modules', '.git'].includes(entry.name)) files.push(...discoverTests(file));
    else if (entry.isFile() && /\.test\.(?:cjs|mjs|js)$/.test(entry.name)) files.push(file);
  }
  return files.sort();
}
function main() {
  const supplied = process.argv.slice(2);
  if (supplied.length !== 1) throw new Error('Pass exactly one test directory.');
  const files = discoverTests(path.resolve(supplied[0]));
  if (files.length === 0) throw new Error('No test files discovered; refusing an empty passing suite.');
  console.log(`[tests] Discovered ${files.length} test files in ${supplied[0]}`);
  // Node suppresses nested test-runner invocation when this marker is inherited.
  // A CLI launched by another test must still execute its files and fail on failure.
  const environment = { ...process.env };
  delete environment.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit', windowsHide: true, env: environment });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}
module.exports = { discoverTests };
if (require.main === module) {
  try { main(); } catch (error) { console.error(`[tests] ${error.message}`); process.exitCode = 1; }
}
