import assert from 'node:assert/strict';
import test from 'node:test';

import { STATION_HEARTBEAT_MS, STATION_STALE_MS } from './print-queue.js';

/**
 * The station heartbeat shares a thread with window.print(), which blocks for
 * as long as the operator leaves the dialog open, and browsers throttle timers
 * in background tabs to roughly one a minute. A narrow margin here is what made
 * a working station read as absent and told cashiers there was no printer.
 */
test('a station survives a blocked thread and a throttled background tab', () => {
  assert.ok(
    STATION_STALE_MS >= STATION_HEARTBEAT_MS * 6,
    `stale window ${STATION_STALE_MS}ms is under six heartbeats (${STATION_HEARTBEAT_MS}ms)`,
  );
  // A background tab is throttled to about one timer callback per minute, so
  // the window has to clear several of those before declaring a station gone.
  assert.ok(STATION_STALE_MS >= 150_000, 'stale window must outlast throttled minutes');
});

test('presence is republished far more often than it expires', () => {
  assert.ok(STATION_HEARTBEAT_MS > 0);
  assert.ok(STATION_HEARTBEAT_MS < STATION_STALE_MS);
});
