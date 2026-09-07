import test from 'node:test';
import assert from 'node:assert/strict';
import { servedLocally } from './firebase.js';

/**
 * A build made with the emulator flag left on shipped a till whose sign-in
 * pointed at 127.0.0.1, so the counter could only ever answer
 * auth/network-request-failed. The origin has to be the deciding vote.
 */
test('a deployed till never counts as the emulator host', () => {
  assert.equal(servedLocally('vanbransa-pos.web.app'), false);
  assert.equal(servedLocally('vanbransa-pos.firebaseapp.com'), false);
  assert.equal(servedLocally('titaniumlounge.com'), false);
  // Not a real local host, however much it reads like one.
  assert.equal(servedLocally('localhost.attacker.example'), false);
  assert.equal(servedLocally('notlocalhost'), false);
  assert.equal(servedLocally(''), false);
});

test('a developer machine still reaches its emulators', () => {
  assert.equal(servedLocally('localhost'), true);
  assert.equal(servedLocally('127.0.0.1'), true);
  assert.equal(servedLocally('::1'), true);
  assert.equal(servedLocally('[::1]'), true);
  assert.equal(servedLocally('till.localhost'), true);
});
