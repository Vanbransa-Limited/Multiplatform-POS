import { callFunction } from '../services/firebase';
import { showNotification } from '../context';
import { escapeHtml as esc } from '../services/print-receipt';

const ROLE = { owner: 'Owner', manager: 'Manager' };
const ROTATE_ICON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 11a8 8 0 0 0-14.6-4.5L4 8"/><path d="M4 3v5h5"/><path d="M4 13a8 8 0 0 0 14.6 4.5L20 16"/><path d="M20 21v-5h-5"/></svg>';
const KEY_ICON = '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="8" cy="15" r="4.5"/><path d="M11.2 11.8L20 3M16.5 6.5l3 3M14 9l2 2"/></svg>';

/** Mirrors the server: repeats and straight runs are refused there too. */
export const weakCode = (code) => /^(\d)\1+$/.test(code) || '0123456789'.includes(code) || '9876543210'.includes(code);

const when = (ms) => {
  if (!ms) return '';
  const date = new Date(ms);
  const today = new Date().toDateString() === date.toDateString();
  return today ? `today ${date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
    : date.toLocaleDateString([], { day: 'numeric', month: 'short' });
};

const LOG_TEXT = {
  'discount_approval.granted': (e) => `${e.by} — approved by ${e.approver || 'a manager'}`,
  'discount_approval.refused': (e) => `${e.by} — ${e.paused ? '5 wrong codes, paused 15 min' : 'wrong code'}`,
  'approval_code.created': (e) => `Code created for ${e.subject} by ${e.by}`,
  'approval_code.rotated': (e) => `${e.subject}'s code rotated by ${e.by}`,
  'approval_code.enabled': (e) => `${e.subject}'s access turned on by ${e.by}`,
  'approval_code.disabled': (e) => `${e.subject}'s access turned off by ${e.by}`,
};

/**
 * QR & Tools › Approval codes. Owner only; the server enforces that as well.
 * Codes are never read back: a new one is shown once, after create or rotate.
 */
export class ApprovalCodesPane {
  constructor(host) {
    this.host = host;
    this.view = 'managers';
    this.holders = [];
    this.recent = [];
    this.error = '';
  }

  async load() {
    this.host.innerHTML = '<div class="acp"><p class="acp-muted">Loading approval codes…</p></div>';
    try {
      const result = await callFunction('listApprovalCodes', {});
      this.holders = result?.holders ?? [];
      this.recent = result?.recent ?? [];
      this.error = '';
    } catch (error) {
      this.holders = [];
      this.recent = [];
      this.error = error?.message || 'Approval codes could not be loaded.';
    }
    this.render();
  }

  render() {
    const tab = (id, label) => `<button type="button" role="tab" class="acp-tab${this.view === id ? ' active' : ''}" aria-selected="${this.view === id}" data-view="${id}">${label}</button>`;
    this.host.innerHTML = `
      <div class="acp">
        <div class="acp-head">
          <div>
            <h2>Approval codes</h2>
            <p class="acp-muted">Managers approve the Staff 20% Discount on any till with their own code.</p>
          </div>
          <button type="button" class="acp-primary" data-act="new">+ New manager code</button>
        </div>
        <div class="acp-tabs" role="tablist" aria-label="Show">
          ${tab('managers', 'Managers')}${tab('log', 'Approval log')}${tab('rules', 'Rules')}
        </div>
        ${this.error ? `<p class="acp-error" role="alert">${esc(this.error)}</p>` : ''}
        ${this.view === 'managers' ? this.managersHtml() : this.view === 'log' ? this.logHtml() : this.rulesHtml()}
      </div>`;
    this.host.querySelectorAll('[data-view]').forEach((button) => button.addEventListener('click', () => {
      this.view = button.dataset.view;
      this.render();
    }));
    this.host.querySelector('[data-act="new"]').addEventListener('click', () => this.openCreate());
    this.host.querySelectorAll('[data-toggle]').forEach((button) => button.addEventListener('click', () => this.toggle(button.dataset.toggle)));
    this.host.querySelectorAll('[data-rotate]').forEach((button) => button.addEventListener('click', () => this.openRotate(button.dataset.rotate)));
    this.host.querySelectorAll('[data-create]').forEach((button) => button.addEventListener('click', () => this.openCreate(button.dataset.create)));
  }

  managersHtml() {
    if (!this.holders.length) return '<div class="acp-card"><p class="acp-muted acp-pad">No active owners or managers yet. Give someone the Manager role in Settings › Staff first.</p></div>';
    return `<div class="acp-card">${this.holders.map((h) => `
      <div class="acp-row">
        <div class="acp-avatar" aria-hidden="true">${esc(h.name.slice(0, 1).toUpperCase())}</div>
        <div class="acp-who">
          <span class="acp-name">${esc(h.name)}</span>
          <span class="acp-muted">${ROLE[h.role] || esc(h.role)} · ${h.hasCode ? (h.lastApprovedAt ? `last approved ${when(h.lastApprovedAt)}` : `code set ${when(h.changedAt)}`) : 'no code yet'}</span>
        </div>
        ${h.hasCode ? `
          <div class="acp-controls">
            <span class="acp-access${h.active ? ' on' : ''}">${h.active ? 'Access on' : 'Access off'}</span>
            <button type="button" role="switch" class="acp-switch${h.active ? ' on' : ''}" aria-checked="${h.active}" aria-label="Approval access for ${esc(h.name)}" data-toggle="${esc(h.staffId)}"><span></span></button>
            <button type="button" class="acp-rotate" data-rotate="${esc(h.staffId)}">${ROTATE_ICON}<span>Rotate code</span></button>
          </div>`
        : `<button type="button" class="acp-create" data-create="${esc(h.staffId)}">Create code</button>`}
      </div>`).join('')}</div>`;
  }

  logHtml() {
    const rows = this.recent.filter((event) => LOG_TEXT[event.action]);
    if (!rows.length) return '<div class="acp-card"><p class="acp-muted acp-pad">No approvals or code changes yet.</p></div>';
    return `<div class="acp-card">${rows.map((event) => `
      <div class="acp-log${event.action === 'discount_approval.refused' ? ' refused' : ''}">
        <span class="acp-log-time">${esc(when(event.at))}</span>
        <span>${esc(LOG_TEXT[event.action](event))}</span>
      </div>`).join('')}</div>`;
  }

  rulesHtml() {
    const rule = (label, value) => `<div class="acp-rule"><span class="acp-muted">${label}</span><span>${value}</span></div>`;
    return `<div class="acp-card acp-pad">${[
      rule('Code length', '6 digits, numbers only'),
      rule('Wrong codes before entry pauses', '5, then 15 minutes'),
      rule('Who can hold a code', 'Owner, Manager'),
      rule('Blocked codes', 'Repeats and runs, like 000000 or 123456'),
      rule('An approval lasts', 'One sale, up to 12 hours'),
      rule('Needs the till online', 'Yes'),
    ].join('')}</div>`;
  }

  async toggle(staffId) {
    const holder = this.holders.find((h) => h.staffId === staffId);
    if (!holder) return;
    try {
      await callFunction('setApprovalAccess', { staffId, active: !holder.active });
      showNotification(`${holder.name}'s approval access is ${holder.active ? 'off' : 'on'}.`, 'success');
    } catch (error) {
      showNotification(error?.message || 'Access could not be changed.', 'error');
    }
    await this.load();
  }

  /** One sheet for create and rotate; it ends by showing the new code once. */
  sheet(inner) {
    const overlay = document.createElement('div');
    overlay.className = 'mcs-overlay';
    overlay.innerHTML = `<div class="mcs-sheet acp-sheet" role="dialog" aria-modal="true" aria-labelledby="acp-sheet-title" tabindex="-1">
      <div class="mcs-icon">${KEY_ICON}</div>${inner}</div>`;
    overlay.addEventListener('keydown', (event) => { if (event.key === 'Escape') overlay.remove(); });
    document.body.appendChild(overlay);
    overlay.querySelector('.mcs-sheet').focus();
    return overlay;
  }

  showCode(overlay, name, code) {
    overlay.querySelector('.mcs-sheet').innerHTML = `
      <div class="mcs-icon">${KEY_ICON}</div>
      <h2 id="acp-sheet-title">New code for ${esc(name)}</h2>
      <p class="mcs-sub">Give it to them in person. Any old code no longer works.</p>
      <div class="acp-digits" aria-label="New code ${code.split('').join(' ')}">${code.split('').map((d) => `<span>${d}</span>`).join('')}</div>
      <p class="acp-once">Shown once. It can't be looked up again.</p>
      <button type="button" class="acp-primary acp-wide" data-done>Done, I've handed it over</button>`;
    overlay.querySelector('[data-done]').addEventListener('click', () => { overlay.remove(); void this.load(); });
    overlay.querySelector('[data-done]').focus();
  }

  openCreate(staffId) {
    if (!this.holders.length) return showNotification('Give someone the Manager role first.', 'warning');
    const ordered = [...this.holders].sort((a, b) => Number(a.hasCode) - Number(b.hasCode));
    const chosen = staffId || ordered[0].staffId;
    const overlay = this.sheet(`
      <h2 id="acp-sheet-title">New manager code</h2>
      <p class="mcs-sub">Numbers only. They type it on a waiter's till to approve a staff discount.</p>
      <div class="acp-form">
        <label for="acp-person">Manager</label>
        <select id="acp-person">${ordered.map((h) => `<option value="${esc(h.staffId)}"${h.staffId === chosen ? ' selected' : ''}>${esc(h.name)} · ${ROLE[h.role] || esc(h.role)}${h.hasCode ? ' (replaces current code)' : ''}</option>`).join('')}</select>
        <label for="acp-code">6-digit code</label>
        <input id="acp-code" class="acp-code-input" type="text" inputmode="numeric" pattern="[0-9]*" maxlength="6" autocomplete="off" placeholder="000000">
        <p class="acp-hint" role="alert">6 more digits</p>
        <button type="button" class="acp-ghost" data-generate>Make one for me</button>
        <div class="acp-pair">
          <button type="button" class="acp-secondary" data-cancel>Cancel</button>
          <button type="button" class="acp-primary" data-save disabled>Save code</button>
        </div>
      </div>`);
    const input = overlay.querySelector('#acp-code');
    const hint = overlay.querySelector('.acp-hint');
    const save = overlay.querySelector('[data-save]');
    const person = () => overlay.querySelector('#acp-person').value;
    input.addEventListener('input', () => {
      input.value = input.value.replace(/\D/g, '').slice(0, 6);
      const weak = input.value.length === 6 && weakCode(input.value);
      hint.textContent = weak ? 'Too easy to guess. Avoid repeats and runs like 123456.'
        : input.value.length === 6 ? 'Looks good.' : `${6 - input.value.length} more digit${6 - input.value.length === 1 ? '' : 's'}`;
      hint.className = `acp-hint${weak ? ' bad' : input.value.length === 6 ? ' good' : ''}`;
      save.disabled = input.value.length !== 6 || weak;
    });
    overlay.querySelector('[data-cancel]').addEventListener('click', () => overlay.remove());
    const submit = async (code) => {
      const id = person();
      const name = this.holders.find((h) => h.staffId === id)?.name || 'this manager';
      save.disabled = true;
      try {
        const result = await callFunction('setApprovalCode', code ? { staffId: id, code } : { staffId: id });
        if (result?.code) this.showCode(overlay, name, result.code);
        else {
          overlay.remove();
          showNotification(`Code saved for ${name}.`, 'success');
          void this.load();
        }
      } catch (error) {
        hint.textContent = error?.message || 'The code could not be saved.';
        hint.className = 'acp-hint bad';
        save.disabled = false;
      }
    };
    save.addEventListener('click', () => submit(input.value));
    overlay.querySelector('[data-generate]').addEventListener('click', () => submit(null));
    input.focus();
  }

  openRotate(staffId) {
    const holder = this.holders.find((h) => h.staffId === staffId);
    if (!holder) return;
    const overlay = this.sheet(`
      <h2 id="acp-sheet-title">Rotate ${esc(holder.name)}'s code?</h2>
      <p class="mcs-sub">Their current code stops working straight away, on every till. You will get a new one to hand over.</p>
      <p class="acp-hint bad" role="alert"></p>
      <div class="acp-pair">
        <button type="button" class="acp-secondary" data-cancel>Cancel</button>
        <button type="button" class="acp-primary" data-rotate-now>Rotate and show new code</button>
      </div>`);
    overlay.querySelector('[data-cancel]').addEventListener('click', () => overlay.remove());
    overlay.querySelector('[data-rotate-now]').addEventListener('click', async (event) => {
      event.currentTarget.disabled = true;
      try {
        const result = await callFunction('setApprovalCode', { staffId });
        this.showCode(overlay, holder.name, result.code);
      } catch (error) {
        overlay.querySelector('.acp-hint').textContent = error?.message || 'The code could not be rotated.';
        event.currentTarget.disabled = false;
      }
    });
  }
}
