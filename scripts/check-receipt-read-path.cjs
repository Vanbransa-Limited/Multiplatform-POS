'use strict';
// Exercise the deployed read algorithm against known reconciliations; no writes.
process.env.GCLOUD_PROJECT = 'vanbransa-pos';
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const { db } = require('../backend/functions/lib/lib/firebase');
const { readReceiptBalance } = require('../backend/functions/lib/modules/sales/receipt-balance');
async function main() {
  for (const [reference, expectedMinor] of [['UKL6537WE3', 170000], ['UKLDQ29EAJ', 6265000]]) {
    const start = performance.now();
    const receipt = await db.runTransaction(tx => readReceiptBalance(tx, 'tenant-01', reference, 'branch-nai-01'), { readOnly: true });
    assert.equal(receipt.amountMinor, expectedMinor);
    assert.equal(receipt.allocatedMinor, expectedMinor);
    assert.equal(receipt.availableMinor, 0);
    assert.equal(receipt.verified, false);
    console.log(JSON.stringify({ reference, amountKES: expectedMinor / 100, availableKES: 0,
      manuallyReconciled: true, readOnlyCheckPassed: true, roundTripMs: Math.round(performance.now() - start) }));
  }
  await db.terminate();
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
