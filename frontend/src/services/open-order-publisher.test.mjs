import assert from 'node:assert/strict';
import test from 'node:test';

import { openOrderPublisherId, createSnapshotPublisher } from './open-order-publisher.js';

const storage = () => {
  const rows = new Map();
  return {
    getItem: (key) => rows.get(key) || null,
    setItem: (key, value) => rows.set(key, value),
  };
};

test('overlapping full snapshots cannot reach the server in reverse order', async () => {
  const sent = [];
  let finish;
  const publish = createSnapshotPublisher(async payload => {
    sent.push(payload);
    if (sent.length === 1) await new Promise(resolve => { finish = resolve; });
  });
  const first = publish('scope', { orders: [] });
  const second = publish('scope', { orders: [{ key: 'judy-table' }] });
  await Promise.resolve();
  assert.equal(sent.length, 1);
  finish();
  await Promise.all([first, second]);
  assert.deepEqual(sent[1], { orders: [{ key: 'judy-table' }] });
});

test('one browser keeps one open-order publisher id', () => {
  const browser = storage();
  const first = openOrderPublisherId('device-till-01', browser);
  assert.equal(openOrderPublisherId('device-till-01', browser), first);
  assert.match(first, /^device-till-01--[A-Za-z0-9_-]+$/);
});

test('two browsers sharing a deployed device id cannot clear each other', () => {
  const left = openOrderPublisherId('device-till-01', storage());
  const right = openOrderPublisherId('device-till-01', storage());
  assert.notEqual(left, right);
});

test('quiet snapshots heartbeat, changes and empty snapshots publish immediately', async () => {
  let time = 0;
  const sent = [];
  const publish = createSnapshotPublisher(async payload => { sent.push(payload); return 'ok'; }, () => time);
  const open = { orders: [{ key: 'tab1', totalMinor: 100 }] };
  await publish('tenant:staff:device', open);
  time = 10_000;
  assert.equal(await publish('tenant:staff:device', open), null);
  time = 60_000;
  await publish('tenant:staff:device', open);
  await publish('tenant:staff:device', { orders: [] });
  await publish('other-tenant:staff:device', { orders: [] });
  assert.equal(sent.length, 4);
  assert.deepEqual(sent[2], { orders: [] });
});

test('failed publications retry without waiting for the heartbeat', async () => {
  let calls = 0;
  const publish = createSnapshotPublisher(async () => {
    if (++calls === 1) throw new Error('offline');
    return 'ok';
  });
  await assert.rejects(publish('scope', { orders: [] }), /offline/);
  assert.equal(await publish('scope', { orders: [] }), 'ok');
  assert.equal(calls, 2);
});
