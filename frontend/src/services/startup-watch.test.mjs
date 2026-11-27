import test from 'node:test';
import assert from 'node:assert/strict';
import { watchStartup } from './startup-watch.js';

test('a stalled startup leaves loading, and a late successful restore still recovers', async () => {
  let resolve;
  const pending = new Promise(done => { resolve = done; });
  const events = [];
  const timedOut = new Promise(done => {
    watchStartup(pending, { timeoutMs: 5, onError: error => { events.push(error.message); done(); }, onReady: value => events.push(value) });
  });
  await timedOut;
  assert.deepEqual(events, ['Opening the till took too long.']);
  resolve('restored existing session');
  await pending; await Promise.resolve();
  assert.deepEqual(events, ['Opening the till took too long.', 'restored existing session']);
});

test('normal startup and errors settle promptly without waiting for the watchdog', async () => {
  const events = [];
  const ok = new Promise(done => watchStartup(Promise.resolve('ready'), {
    onReady: value => { events.push(value); done(); }, onError: error => { throw error; },
  }));
  await ok;
  const failure = new Error('Authentication could not load');
  await new Promise(done => watchStartup(Promise.reject(failure), {
    onReady: () => assert.fail('failed startup must not authenticate'), onError: error => { assert.equal(error, failure); done(); },
  }));
  assert.deepEqual(events, ['ready']);
});

test('unmount cancels the timer and ignores late completion without touching stored work', async () => {
  let resolve;
  const pending = new Promise(done => { resolve = done; });
  const events = [];
  const stop = watchStartup(pending, { timeoutMs: 5, onReady: value => events.push(value), onError: error => events.push(error) });
  stop();
  resolve('old render'); await pending; await Promise.resolve();
  await new Promise(done => setTimeout(done, 10));
  assert.deepEqual(events, []);
});
