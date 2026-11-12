const STORAGE_PREFIX = 'pos_open_order_publisher_v1:';
const volatileTokens = new Map();

/** Changed snapshots publish immediately; quiet tills refresh once per minute.
 * Remember only acknowledged snapshots: a failed call must retry next tick.
 */
export function createSnapshotPublisher(send, now = Date.now, heartbeatMs = 60_000) {
  const acknowledged = new Map();
  let tail = Promise.resolve();
  const publish = async (scope, payload) => {
    const fingerprint = JSON.stringify(payload);
    const previous = acknowledged.get(scope);
    if (previous?.fingerprint === fingerprint && now() - previous.at < heartbeatMs) return null;
    const result = await send(payload);
    acknowledged.set(scope, { fingerprint, at: now() });
    return result;
  };
  // Whole snapshots must reach the server in order. Otherwise an older slow
  // request can clear tables created while that request was in flight.
  return (scope, payload) => {
    const next = tail.then(() => publish(scope, payload));
    tail = next.catch(() => {});
    return next;
  };
}

/**
 * A browser installation, not merely the configured till record.
 *
 * Several tablets can legitimately use the same hosted build and therefore
 * the same NEXT_PUBLIC_DEVICE_ID. Using that shared id as the owner of a live
 * snapshot let one tablet's empty snapshot delete another tablet's tabs. A
 * stable per-browser suffix makes each publisher replace only its own rows.
 */
export function openOrderPublisherId(deviceId, storage = globalThis.localStorage) {
  const base = String(deviceId || '').replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 80);
  if (!base) return '';

  const key = `${STORAGE_PREFIX}${base}`;
  let token = '';
  let persistent = false;
  try {
    if (storage) {
      token = storage.getItem(key) || '';
      persistent = true;
    }
  } catch {
    // Private browsing can expose localStorage while refusing access to it.
  }
  if (!persistent) token = volatileTokens.get(base) || '';

  if (!/^[A-Za-z0-9_-]{8,40}$/.test(token)) {
    token = globalThis.crypto?.randomUUID?.()
      || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 14)}`;
    volatileTokens.set(base, token);
    if (persistent) {
      try { storage.setItem(key, token); } catch { /* stable for this page */ }
    }
  }

  return `${base}--${token}`.slice(0, 128);
}
