/** Bound the loading screen without cancelling initialization or deleting data.
 * A late successful restore is still accepted; unmounted observers are ignored.
 */
export const STARTUP_WAIT_MS = 20_000;
export function watchStartup(work, { onReady, onError, timeoutMs = STARTUP_WAIT_MS }) {
  let active = true;
  const timer = setTimeout(() => {
    if (active) onError(new Error('Opening the till took too long.'));
  }, timeoutMs);
  Promise.resolve(work).then(value => {
    clearTimeout(timer);
    if (active) onReady(value);
  }, error => {
    clearTimeout(timer);
    if (active) onError(error);
  });
  return () => { active = false; clearTimeout(timer); };
}
