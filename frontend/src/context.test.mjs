import test from 'node:test';
import assert from 'node:assert/strict';

// Just enough DOM for showNotification: one body, elements that can be removed.
const live = new Set();
globalThis.document = {
  body: { appendChild: (el) => live.add(el) },
  createElement: () => {
    const handlers = {};
    const el = {
      style: {}, attrs: {},
      setAttribute: (k, v) => { el.attrs[k] = v; },
      addEventListener: (name, fn) => { handlers[name] = fn; },
      fire: (name, event = {}) => handlers[name]?.({ clientX: 0, pointerId: 1, ...event }),
      setPointerCapture: () => {},
      remove: () => { assert.ok(live.delete(el), 'removed twice'); },
    };
    return el;
  },
};

const { showNotification } = await import('./context.js');
const latest = () => [...live].at(-1);

test('a tap dismisses a toast at once, and the auto-hide timer later is harmless', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  showNotification('Enter a valid whole-number quantity.', 'error');
  const toast = latest();
  assert.equal(toast.attrs.role, 'alert');
  toast.fire('pointerdown');
  toast.fire('pointerup');
  assert.equal(live.has(toast), false);
  t.mock.timers.tick(10000);
});

test('a sideways swipe dismisses; untouched errors linger longer than successes', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  showNotification('Saved.');
  const ok = latest();
  assert.equal(ok.attrs.role, 'status');
  showNotification('Failed.', 'error');
  const bad = latest();
  bad.fire('pointerdown', { clientX: 10 });
  bad.fire('pointermove', { clientX: 120 });
  bad.fire('pointerup', { clientX: 120 });
  assert.equal(live.has(bad), false);

  showNotification('Failed again.', 'error');
  const lingering = latest();
  // Slide-out then removal are chained timers, so tick each stage.
  t.mock.timers.tick(4000);
  t.mock.timers.tick(400);
  assert.equal(live.has(ok), false);
  assert.equal(live.has(lingering), true);
  t.mock.timers.tick(4000);
  t.mock.timers.tick(400);
  assert.equal(live.has(lingering), false);
});
