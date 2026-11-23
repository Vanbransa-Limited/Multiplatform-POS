import { callFunction } from '../services/firebase';
import { showNotification } from '../context';

/**
 * Off by the owner's request (2026-11-22). Keep in step with
 * PRINT_BEFORE_PAYMENT in backend/functions/src/modules/sales/printed-receipt.ts:
 * switching this back on before the backend would leave nothing enforcing it.
 */
export const PRINT_BEFORE_PAYMENT = false;

/** A single print gate for tills, saved bills and menu orders. Never trusts local print flags. */
export function requirePrintedReceipt(target, { onReady, onCancel = () => {}, isActive = () => true } = {}) {
  if (!PRINT_BEFORE_PAYMENT) {
    // The target still runs: on the till it saves the bill to the server,
    // which is what payment settles against.
    void (async () => {
      try {
        if (typeof target === 'function') await target();
        if (isActive()) onReady();
      } catch (error) {
        showNotification(error.message || 'The bill could not be saved. Try again.', 'error');
        onCancel();
      }
    })();
    return;
  }
  // Keep one protected checkout on screen, including while its status is loading.
  if (document.querySelector('#checkout-print-modal')) return;
  const previousFocus = document.activeElement;
  const modal = document.createElement('div');
  modal.id = 'checkout-print-modal';
  modal.className = 'modal active';
  modal.innerHTML = `
    <div class="modal-content checkout-print-content" role="dialog" aria-modal="true" aria-labelledby="checkout-print-title">
      <h2 id="checkout-print-title">Print receipt first</h2>
      <p>Print the unpaid receipt at the counter before taking payment.</p>
      <p class="checkout-print-status" role="status" aria-live="polite">Checking receipt…</p>
      <div class="checkout-print-actions">
        <button type="button" class="sec-btn" data-print-close>Close</button>
        <button type="button" class="sec-btn" data-print-send disabled>Send to printer</button>
        <button type="button" class="primary-btn" data-print-pay disabled>Pay Now</button>
      </div>
    </div>`;
  document.body.appendChild(modal);
  const status = modal.querySelector('[role="status"]');
  const send = modal.querySelector('[data-print-send]');
  const pay = modal.querySelector('[data-print-pay]');
  const close = modal.querySelector('[data-print-close]');
  let timer, busy = false, disposed = false;
  let resolvedTarget;
  function cleanup() {
    disposed = true;
    clearTimeout(timer);
    document.removeEventListener('keydown', onKeydown);
    modal.remove();
    previousFocus?.focus();
  }
  async function check(queue = false) {
    if (busy || disposed) return;
    if (!isActive()) { cleanup(); return; }
    busy = true;
    send.disabled = true;
    close.disabled = !resolvedTarget;
    clearTimeout(timer);
    try {
      resolvedTarget ||= typeof target === 'function' ? await target() : target;
      if (disposed || !isActive()) { cleanup(); return; }
      const result = await callFunction('prepareCheckoutReceipt', { ...resolvedTarget, queue }, { timeout: 12000 });
      if (disposed) return;
      pay.disabled = !result.printed;
      send.disabled = result.printed || result.queued;
      status.textContent = result.printed ? 'Receipt printed. You can take payment.'
        : result.queued ? 'Waiting for the counter to print and confirm the receipt.'
          : 'Send the receipt to the counter printer to continue.';
    } catch (error) {
      if (disposed) return;
      pay.disabled = true;
      send.disabled = false;
      status.textContent = error.message || 'Could not check the receipt. Try again.';
    } finally {
      busy = false;
      close.disabled = false;
      if (!disposed && !modal.contains(document.activeElement)) close.focus();
      if (!disposed) timer = setTimeout(() => void check(), 2500);
    }
  }
  close.addEventListener('click', () => { cleanup(); onCancel(); });
  send.addEventListener('click', () => void check(true));
  pay.addEventListener('click', () => {
    if (pay.disabled || !isActive()) return;
    cleanup();
    onReady();
  });
  function onKeydown(event) {
    if (event.key === 'Escape') { event.preventDefault(); close.click(); }
    if (event.key !== 'Tab') return;
    const buttons = [...modal.querySelectorAll('button:not(:disabled)')];
    const first = buttons[0], last = buttons[buttons.length - 1];
    if (!first) { event.preventDefault(); return; }
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }
  document.addEventListener('keydown', onKeydown);
  close.focus();
  void check();
}
