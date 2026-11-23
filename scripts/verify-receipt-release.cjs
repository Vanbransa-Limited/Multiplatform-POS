'use strict';
// Read-only release checks. Credentials and business configuration are never printed.
const path = require('node:path');
const fs = require('node:fs/promises');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { resolveFirebaseCli } = require('./lib/toolchain.cjs');
const backend = require('node:module').createRequire(path.resolve(__dirname, '../backend/functions/package.json'));
const projectId = 'vanbransa-pos';
const checkpoint = path.resolve(__dirname, '../tmp/receipt-release-settings-hashes.json');
const stable = value => value?.toMillis ? { timestampMs: value.toMillis() }
  : Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
const hash = value => createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');

async function settingsHashes() {
  const { initializeApp, applicationDefault } = backend('firebase-admin/app');
  const { getFirestore } = backend('firebase-admin/firestore');
  const app = initializeApp({ projectId, credential: applicationDefault() });
  try {
    const db = getFirestore(app), result = {};
    for (const name of ['tenant_settings', 'mpesa_configs']) {
      const snapshot = await db.collection(name).get();
      for (const doc of snapshot.docs) result[doc.ref.path] = hash(doc.data());
    }
    return result;
  } finally { await app.delete(); }
}

async function main() {
  if (process.argv.includes('--capture-settings')) {
    await fs.writeFile(checkpoint, JSON.stringify(await settingsHashes(), null, 2));
    console.log(JSON.stringify({ protectedSettingsSnapshotSaved: true }));
    return;
  }
  assert.deepEqual(await settingsHashes(), JSON.parse(await fs.readFile(checkpoint, 'utf8')), 'Business or M-Pesa configuration changed');
  console.log(JSON.stringify({ businessAndMpesaSettingsUnchanged: true }));
  const cli = resolveFirebaseCli(path.resolve(__dirname, '..'));
  assert.ok(cli.argumentsPrefix[0], 'Firebase CLI Node installation required');
  const auth = require(path.resolve(path.dirname(cli.argumentsPrefix[0]), '../auth.js'));
  const account = auth.getGlobalDefaultAccount();
  assert.ok(account?.tokens?.refresh_token, 'Existing Firebase CLI login required');
  const token = await auth.getAccessToken(account.tokens.refresh_token, ['https://www.googleapis.com/auth/cloud-platform']);
  const names = ['settleSale', 'lookupMpesaReceipt'];
  if (process.argv.includes('--onboarding')) names.push('createPlatformTenant');
  if (process.argv.includes('--manual-entry')) names.push('payProforma', 'settleCustomerOrderByCode');
  for (const name of names) {
    const response = await fetch(`https://cloudfunctions.googleapis.com/v2/projects/${projectId}/locations/europe-west1/functions/${name}`, {
      headers: { Authorization: `Bearer ${token.access_token}` }, signal: AbortSignal.timeout(30000),
    });
    const fn = await response.json();
    assert.equal(response.status, 200, `Cannot inspect ${name}`);
    assert.equal(fn.state, 'ACTIVE', `${name} is not active`);
    assert.equal(fn.buildConfig?.runtime, 'nodejs22');
    if (name === 'lookupMpesaReceipt') assert.equal(fn.serviceConfig?.timeoutSeconds, 12);
    console.log(JSON.stringify({ function: name, state: fn.state, runtime: fn.buildConfig.runtime,
      updateTime: fn.updateTime, revision: fn.serviceConfig?.revision }));
    const gate = await fetch(`https://europe-west1-${projectId}.cloudfunctions.net/${name}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data: {} }),
      signal: AbortSignal.timeout(30000),
    });
    const body = await gate.json();
    assert.ok([401, 403].includes(gate.status));
    assert.ok(['UNAUTHENTICATED', 'PERMISSION_DENIED'].includes(body.error?.status));
    console.log(JSON.stringify({ callable: name, authenticationEnforced: true }));
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
