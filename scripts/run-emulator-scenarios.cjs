"use strict";
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { emulatorTestTarget } = require('./lib/test-target.cjs');

function main() {
  emulatorTestTarget();
  const root = path.resolve(__dirname, '..');
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-emulator-checks-'));
  const tokens = path.join(scratch, 'settings-tokens.json');
  const scenarios = [
    ['backend/functions/e2e/scenario.mjs'],
    ['backend/functions/e2e/stock-requests.cjs'],
    ['backend/functions/e2e/esther-receipt-reconciliation.cjs'],
    ['backend/functions/e2e/internal-receipts.cjs'],
    ['backend/functions/e2e/seed-settings.mjs', tokens],
    ['frontend/e2e/settings-rules-check.mjs', tokens],
    ['backend/functions/e2e/checkout-print.cjs'],
    ['backend/functions/e2e/tab-lifecycle.cjs'],
    ['backend/functions/e2e/table-release.cjs'],
    ['backend/functions/e2e/receipt-correction.cjs'],
    ['backend/functions/e2e/shared-receipt-repair.cjs'],
    ['backend/functions/e2e/etims.cjs'],
  ];
  try {
    for (const args of scenarios) {
      console.log(`[emulator-checks] ${args[0]}`);
      const result = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit', windowsHide: true, timeout: 120000 });
      if (result.error) throw result.error;
      if (result.status !== 0) { process.exitCode = result.status ?? 1; return; }
    }
    console.log(`[emulator-checks] All ${scenarios.length} scenario stages passed.`);
  } finally {
    if (fs.existsSync(tokens)) fs.unlinkSync(tokens);
    fs.rmdirSync(scratch);
  }
}
if (require.main === module) {
  try { main(); } catch (error) { console.error(`[emulator-checks] ${error.message}`); process.exitCode = 1; }
}
