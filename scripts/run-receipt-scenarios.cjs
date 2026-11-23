'use strict';
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { emulatorTestTarget } = require('./lib/test-target.cjs');
emulatorTestTarget();
for (const scenario of ['checkout-print', 'internal-receipts']) {
  const result = spawnSync(process.execPath, [path.join(__dirname, `../backend/functions/e2e/${scenario}.cjs`)],
    { stdio: 'inherit', windowsHide: true, timeout: 120000 });
  if (result.error) throw result.error;
  if (result.status !== 0) { process.exitCode = result.status ?? 1; break; }
}
