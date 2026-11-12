/** A stalled read must not keep a screen in its loading state indefinitely.
 * This bounds the UI wait, not the underlying SDK request; no writes use it.
 */
export async function readWithDeadline(read, milliseconds = 15_000) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(read),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('The server read timed out.')), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
