"use strict";
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawnSync } = require('node:child_process');
const { emulatorTestTarget } = require('../lib/test-target.cjs');
const { discoverTests } = require('../run-node-tests.cjs');
const { assertTestRuntime, baselineSteps } = require('../verify-baseline.cjs');

const demo = () => ({ GCLOUD_PROJECT: 'demo-tokgut-pos', FIRESTORE_EMULATOR_HOST: '127.0.0.1:8380',
  FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9399', FIREBASE_FUNCTIONS_EMULATOR_HOST: '127.0.0.1:5301' });

test('emulator tests derive every URL from explicit loopback endpoints and the demo project', () => {
  const target = emulatorTestTarget(demo());
  assert.equal(target.projectId, 'demo-tokgut-pos');
  assert.equal(target.functionsBase, 'http://127.0.0.1:5301/demo-tokgut-pos/europe-west1');
  assert.equal(target.authBase, 'http://127.0.0.1:9399');
  assert.equal(emulatorTestTarget({ ...demo(), FIREBASE_AUTH_EMULATOR_HOST: '[::1]:9399' }).authHost, '[::1]:9399');
});

test('emulator tests reject missing or conflicting project identities, including the old smoke override', () => {
  for (const key of ['GCLOUD_PROJECT', 'GOOGLE_CLOUD_PROJECT', 'FIREBASE_PROJECT']) {
    assert.throws(() => emulatorTestTarget({ ...demo(), [key]: 'vanbransa-pos' }), /expected demo-tokgut-pos/);
  }
  assert.throws(() => emulatorTestTarget({ ...demo(), GCLOUD_PROJECT: '' }), /must identify/);
  assert.throws(() => emulatorTestTarget({ ...demo(), FIREBASE_CONFIG: '{' }), /valid JSON/);
  assert.throws(() => emulatorTestTarget({ ...demo(), FIREBASE_CONFIG: '{"projectId":"other-project"}' }), /expected demo/);
});

test('all three emulator endpoints reject absent, remote, credential-bearing, and malformed targets', () => {
  for (const key of ['FIRESTORE_EMULATOR_HOST', 'FIREBASE_AUTH_EMULATOR_HOST', 'FIREBASE_FUNCTIONS_EMULATOR_HOST']) {
    for (const value of ['', 'example.com:8380', '0.0.0.0:8380', 'http://localhost:8380', 'localhost',
      'user:password@localhost:8380', 'localhost:8380/path', 'localhost:8380?project=live', 'localhost:8380#live']) {
      assert.throws(() => emulatorTestTarget({ ...demo(), [key]: value }), undefined, `${key} accepted ${value}`);
    }
  }
});

test('smoke entry point refuses unsafe targets before importing the scenario or attempting fetch', () => {
  const smoke = pathToFileURL(path.resolve(__dirname, '../smoke-test.mjs')).href;
  for (const environment of [{}, { ...demo(), GCLOUD_PROJECT: 'vanbransa-pos' },
    { ...demo(), FIREBASE_FUNCTIONS_EMULATOR_HOST: 'remote.invalid:5301' }]) {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e',
      `globalThis.fetch=()=>{throw Error('NETWORK_MUST_NOT_RUN')};await import(${JSON.stringify(smoke)});`],
    { env: environment, encoding: 'utf8', timeout: 5000, windowsHide: true });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /\[smoke\]/);
    assert.doesNotMatch(result.stderr, /NETWORK_MUST_NOT_RUN|ERR_MODULE_NOT_FOUND|firebase-admin/);
  }
});

test('test discovery finds newly added nested tests and ignores dependency folders', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-test-discovery-'));
  try {
    fs.mkdirSync(path.join(scratch, 'nested'));
    fs.mkdirSync(path.join(scratch, 'node_modules'));
    for (const file of ['first.test.cjs', 'nested/new.test.mjs', 'node_modules/ignored.test.cjs', 'not-a-test.cjs']) {
      fs.writeFileSync(path.join(scratch, file), '');
    }
    assert.deepEqual(discoverTests(scratch).map(file => path.relative(scratch, file).replaceAll('\\', '/')),
      ['first.test.cjs', 'nested/new.test.mjs']);
    assert.throws(() => discoverTests(path.join(scratch, 'missing')), /ENOENT/);
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
});

test('test runner fails for an empty suite and propagates an actual failing test', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-test-runner-'));
  const runner = path.resolve(__dirname, '../run-node-tests.cjs');
  const run = () => spawnSync(process.execPath, [runner, scratch], { encoding: 'utf8', timeout: 10000, windowsHide: true });
  try {
    const empty = run(); assert.equal(empty.status, 1); assert.match(empty.stderr, /No test files/);
    fs.writeFileSync(path.join(scratch, 'new.test.cjs'), "require('node:test')('regression',()=>{throw Error('EXPECTED_FAILURE')});");
    const failed = run(); assert.equal(failed.status, 1); assert.match(failed.stdout, /EXPECTED_FAILURE/);
    fs.writeFileSync(path.join(scratch, 'new.test.cjs'), "require('node:test')('regression',()=>{});");
    assert.equal(run().status, 0);
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
});

test('baseline requires the production Node major and explicitly names all five stages', () => {
  assert.doesNotThrow(() => assertTestRuntime('22.20.0'));
  for (const version of ['20.0.0', '24.0.0', '26.13.1']) assert.throws(() => assertTestRuntime(version), /requires Node 22/);
  assert.deepEqual(baselineSteps('/repo', '/toolchain/npm-cli.js').map(step => step.name),
    ['tooling tests', 'frontend tests', 'backend build and tests', 'frontend typecheck', 'frontend production build']);
});
