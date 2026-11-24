import { escapeHtml } from '../services/print-receipt';

const LENGTH = 6;
const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', 'del'];
const KEY_ICON = '<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="8" cy="15" r="4.5"/><path d="M11.2 11.8L20 3M16.5 6.5l3 3M14 9l2 2"/></svg>';
const DEL_ICON = '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 5H9l-6 7 6 7h12z"/><path d="M17 9l-6 6M11 9l6 6"/></svg>';
const CHECK_ICON = '<svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
const CLOCK_ICON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="8"/><path d="M12 8v4l2.5 2"/></svg>';
const BIN_ICON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>';

/**
 * The manager code sheet: six boxes and a keypad over the till.
 *
 * `approve(code)` asks the server and resolves with the approver's name, or
 * throws with the server's message. A paused requester ("resource-exhausted")
 * loses the keypad; removing the discount is always available.
 */
export function openManagerCodeSheet({ subtitle, chip, approve, onRemove, onKeep }) {
  const returnFocus = document.activeElement;
  const overlay = document.createElement('div');
  overlay.className = 'mcs-overlay';
  overlay.innerHTML = `
    <div class="mcs-sheet" role="dialog" aria-modal="true" aria-labelledby="mcs-title" tabindex="-1">
      <div class="mcs-entry">
        <div class="mcs-icon">${KEY_ICON}</div>
        <h2 id="mcs-title">Manager code</h2>
        <p class="mcs-sub">${escapeHtml(subtitle)}</p>
        <div class="mcs-chip">${escapeHtml(chip)}</div>
        <div class="mcs-cells" role="group">${'<span class="mcs-cell"></span>'.repeat(LENGTH)}</div>
        <p class="mcs-msg" role="alert">Enter the 6-digit code</p>
        <div class="mcs-keypad">${KEYS.map((key) => key === ''
          ? '<span class="mcs-key-gap" aria-hidden="true"></span>'
          : `<button type="button" class="mcs-key${key === 'del' ? ' mcs-key-del' : ''}" data-key="${key}" aria-label="${key === 'del' ? 'Delete last digit' : `Digit ${key}`}">${key === 'del' ? DEL_ICON : key}</button>`).join('')}</div>
        <div class="mcs-foot">
          <span>No manager around?</span>
          <div class="mcs-foot-row">
            <button type="button" class="mcs-keep">${CLOCK_ICON} Keep it waiting</button>
            <button type="button" class="mcs-remove">${BIN_ICON} Remove discount</button>
          </div>
        </div>
      </div>
      <div class="mcs-done hidden">
        <div class="mcs-done-icon">${CHECK_ICON}</div>
        <h2>Discount applied</h2>
        <p class="mcs-sub mcs-done-text"></p>
      </div>
    </div>`;

  const sheet = overlay.querySelector('.mcs-sheet');
  const cells = [...overlay.querySelectorAll('.mcs-cell')];
  const message = overlay.querySelector('.mcs-msg');
  const keypad = overlay.querySelector('.mcs-keypad');
  let code = '';
  let busy = false;
  let wrong = false;

  const render = () => {
    cells.forEach((cell, index) => {
      cell.className = `mcs-cell${index < code.length ? ' filled' : ''}${index === code.length && !wrong ? ' current' : ''}${wrong ? ' wrong' : ''}`;
    });
    overlay.querySelector('.mcs-cells').setAttribute('aria-label', `${code.length} of ${LENGTH} digits entered`);
  };
  const say = (text, tone = '') => { message.textContent = text; message.className = `mcs-msg ${tone}`; };
  const close = () => {
    overlay.remove();
    returnFocus?.focus?.();
  };

  const submit = async () => {
    busy = true;
    say('Checking…');
    try {
      const approvedBy = await approve(code);
      overlay.querySelector('.mcs-entry').classList.add('hidden');
      overlay.querySelector('.mcs-done').classList.remove('hidden');
      overlay.querySelector('.mcs-done-text').textContent = `Approved by ${approvedBy}`;
      setTimeout(close, 1200);
    } catch (error) {
      code = '';
      wrong = true;
      const paused = String(error?.code || '').includes('resource-exhausted');
      say(error?.message || 'That code could not be checked. Try again.', 'error');
      if (paused) keypad.classList.add('hidden');
      render();
    } finally {
      busy = false;
    }
  };

  const press = (key) => {
    if (busy || keypad.classList.contains('hidden')) return;
    wrong = false;
    if (key === 'del') code = code.slice(0, -1);
    else if (code.length < LENGTH) code += key;
    if (message.classList.contains('error')) say('Enter the 6-digit code');
    render();
    keypad.querySelectorAll('.mcs-key').forEach((button) => button.classList.toggle('hit', button.dataset.key === key && key !== 'del'));
    if (code.length === LENGTH) void submit();
  };

  keypad.addEventListener('click', (event) => {
    const button = event.target.closest('[data-key]');
    if (button) press(button.dataset.key);
  });
  // Scoped to the sheet, so typing elsewhere on the page is untouched.
  overlay.addEventListener('keydown', (event) => {
    if (/^\d$/.test(event.key)) { event.preventDefault(); press(event.key); }
    else if (event.key === 'Backspace') { event.preventDefault(); press('del'); }
    else if (event.key === 'Escape') { close(); onKeep?.(); }
  });
  overlay.querySelector('.mcs-keep').addEventListener('click', () => { close(); onKeep?.(); });
  overlay.querySelector('.mcs-remove').addEventListener('click', () => { close(); onRemove?.(); });

  document.body.appendChild(overlay);
  render();
  sheet.focus();
  return { close };
}
