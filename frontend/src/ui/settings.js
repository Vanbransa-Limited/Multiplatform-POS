import { tenantStorage } from '../services/tenant-cache.js';
import { db } from '../db/schema';
import { UsersView } from './users';
import { verifyAuditTrail } from '../db/index';
import { state, showNotification } from '../context';
import { pullPaymentSettings, saveCashEnabled, pullAcceptedMethods, cachedAcceptedMethods, saveAcceptedMethods, TENDERS } from '../services/payment-settings';
import { cachedTradingHours, pullTradingHours, saveTradingHours } from '../services/trading-hours';
import { ACCESS_ROLES, accessModules, currentAccess, saveModuleAccess } from '../services/module-access.js';
import { ROLE_LABELS } from '../services/roles.js';
import { NAV_GROUPS } from '../navigation.js';
import { configureStock, storeIsEnabled, pullStock } from '../services/stock';
import { escapeHtml } from '../services/print-receipt';
import { callFunction } from '../services/firebase';

/** 00:00 - 23:00 as an hour picker, with the stored hour selected. */
function hourOptions(selected) {
  return Array.from({ length: 24 }, (_, hour) => {
    const suffix = hour < 12 ? 'AM' : 'PM';
    const shown = hour % 12 === 0 ? 12 : hour % 12;
    return `<option value="${hour}"${hour === selected ? ' selected' : ''}>${shown}:00 ${suffix}</option>`;
  }).join('');
}

export class SettingsView {
  constructor(container) {
    this.container = container;
  }

  async load() {
    this.tradingHours = cachedTradingHours();
    this.acceptedMethods = cachedAcceptedMethods();
    this.settingsReady = false;
    this.settingsStatus = 'Showing saved settings. Refreshing from the server…';
    this.activeTab = this.activeTab || 'general';
    this.render();
    this.bindEvents();
    void this.refreshSettings();
  }

  async refreshSettings() {
    const results = await Promise.allSettled([pullStock(), pullPaymentSettings(), pullTradingHours(), pullAcceptedMethods()]);
    if (this.disposed) return;
    this.settingsReady = results.every(result => result.status === 'fulfilled');
    this.settingsStatus = this.settingsReady
      ? 'Settings are up to date.'
      : 'Settings could not refresh. Reopen this screen to retry before saving changes.';
    if (results[2].status === 'fulfilled') this.tradingHours = results[2].value;
    if (results[3].status === 'fulfilled') this.acceptedMethods = results[3].value;
    if (!this.settingsEdited) { this.render(); this.bindEvents(); }
    else {
      const status = this.container.querySelector('#settings-refresh-status');
      if (status) status.textContent = this.settingsStatus;
      this.setSettingsWriteState();
    }
  }

  setSettingsWriteState() {
    // Cached settings are usable immediately, but never save unknown defaults.
    this.container.querySelectorAll('button[id^="save-"]').forEach(button => {
      if (this.settingsReady === false) {
        if (button.dataset.refreshDisabled === undefined) button.dataset.refreshDisabled = String(button.disabled);
        button.disabled = true;
      } else if (button.dataset.refreshDisabled !== undefined) {
        button.disabled = button.dataset.refreshDisabled === 'true';
        delete button.dataset.refreshDisabled;
      }
    });
  }

  /**
   * Which roles reach each module, and who may sell. Only the owner can change
   * it (the callable refuses anyone else); a store manager sees it read-only.
   */
  moduleAccessCard() {
    const owner = state.currentUser?.role === 'Owner';
    const access = currentAccess();
    const modules = accessModules();
    const selected = ACCESS_ROLES.includes(this.accessRole) ? this.accessRole : ACCESS_ROLES[0];
    const groups = [{ label: 'Selling', keys: ['sell'] }, ...NAV_GROUPS.map(group => ({ label: group.label, keys: group.items.map(item => item.tab) }))];
    const panels = ACCESS_ROLES.map(code => `<div data-access-panel="${code}" ${code === selected ? '' : 'hidden'}>
      <div class="access-role-heading"><h4>${escapeHtml(ROLE_LABELS[code])} permissions</h4><span data-access-count="${code}">${modules.filter(module => access[module.key].includes(code)).length} of ${modules.length} enabled</span></div>
      ${groups.map(group => `<fieldset class="access-group" ${owner ? '' : 'disabled'}><legend>${escapeHtml(group.label)}</legend>
        ${modules.filter(module => group.keys.includes(module.key)).map(({ key, label }) => `<label class="access-permission">
          <span class="access-permission-name">${escapeHtml(label)}${key === 'sell' ? '<small>Create sales and add rounds to tabs</small>' : ''}</span>
          <span class="access-control"><input type="checkbox" role="switch" data-access="${key}" data-role="${code}" aria-label="${escapeHtml(`${label}: ${ROLE_LABELS[code]}`)}" ${access[key].includes(code) ? 'checked' : ''}><span class="access-state" aria-hidden="true"></span></span>
        </label>`).join('')}</fieldset>`).join('')}
    </div>`).join('');
    return `<section class="discount-section module-access"><h3>Module access</h3>
      <p class="access-intro">Choose a role to manage the modules it can open. The owner always has full access.</p>
      ${owner ? '' : '<p class="access-readonly">Only the owner can change these permissions. You can review each role below.</p>'}
      <div class="discount-field access-role-picker"><label for="access-role">Staff role</label><select id="access-role">${ACCESS_ROLES.map(code => `<option value="${code}" ${code === selected ? 'selected' : ''}>${escapeHtml(ROLE_LABELS[code])}</option>`).join('')}</select></div>
      <div class="access-panels">${panels}</div>
      <div class="access-footer"><button id="save-module-access" class="primary-btn" ${owner ? '' : 'disabled'}>Save module access</button>
      <p id="module-access-result" role="status">${owner ? 'Changes apply after you save.' : 'Read-only access'}</p></div>
    </section>`;
  }

  /**
   * Which roles reach each module, and who may sell. Only the owner can change
   * it (the callable refuses anyone else); a store manager sees it read-only.
   */
  moduleAccessCard() {
    const owner = state.currentUser?.role === 'Owner';
    const access = currentAccess();
    const head = ACCESS_ROLES.map((code) => `<th scope="col">${escapeHtml(ROLE_LABELS[code])}</th>`).join('');
    const rows = accessModules().map(({ key, label }) => `<tr><th scope="row">${escapeHtml(label)}</th>${ACCESS_ROLES.map((code) => `<td><input type="checkbox" data-access="${key}" data-role="${code}" aria-label="${escapeHtml(`${label}: ${ROLE_LABELS[code]}`)}" ${access[key].includes(code) ? 'checked' : ''} ${owner ? '' : 'disabled'}></td>`).join('')}</tr>`).join('');
    return `<section class="discount-section module-access"><h3>Module access</h3>
      <p style="font-size:13px;color:var(--text-secondary);margin:0 0 12px;">Tick the roles that can open each module. The owner always has everything. "Sell" decides who can ring up a sale at the till.</p>
      <div style="overflow-x:auto;"><table class="module-access-table" style="border-collapse:collapse;font-size:13px;min-width:560px;">
        <thead><tr><th scope="col" style="text-align:left;">Module</th>${head}</tr></thead><tbody>${rows}</tbody></table></div>
      <button id="save-module-access" class="primary-btn" style="margin-top:12px;" ${owner ? '' : 'disabled'}>Save module access</button>
      <p id="module-access-result" role="status"></p>
    </section>`;
  }

  render() {
    this.usersView?.dispose(); this.usersView = null;
    const cashEnabled = tenantStorage.getItem('pos_cash_enabled') !== 'false';
    const isOwner = state.currentUser && (state.currentUser.role === 'Owner' || state.currentUser.role === 'Store Manager');
    const discounts = JSON.parse(tenantStorage.getItem('pos_discounts') || '[]');
    // The rules refuse these to anyone else, so the control is disabled rather
    // than offering a save that can only fail.
    const canSetHours = isOwner;
    const hours = this.tradingHours || cachedTradingHours();
    const acceptedMethods = this.acceptedMethods || [];

    this.container.innerHTML = `
      <div class="settings-shell" style="display:flex;height:calc(100vh - 130px);gap:0;overflow:hidden;">

        <!-- Left sub-nav -->
        <div class="settings-nav" aria-label="Settings sections" style="width:185px;flex-shrink:0;background:var(--surface);border-right:1px solid rgba(255,255,255,0.07);display:flex;flex-direction:column;padding:12px 8px;gap:4px;">
          <button class="pane-nav-btn ${this.activeTab === 'general' ? 'active' : ''}" data-stab="general">⚙️ General</button>
          <button class="pane-nav-btn ${this.activeTab === 'payments' ? 'active' : ''}" data-stab="payments">💳 Payments</button>
          <button class="pane-nav-btn ${this.activeTab === 'discounts' ? 'active' : ''}" data-stab="discounts">🏷️ Discounts</button>
          <button class="pane-nav-btn ${this.activeTab === 'system' ? 'active' : ''}" data-stab="system">🔧 System</button>
          <button class="pane-nav-btn ${this.activeTab === 'staff' ? 'active' : ''}" data-stab="staff">👥 Staff &amp; Access</button>
          <button class="pane-nav-btn ${this.activeTab === 'audit' ? 'active' : ''}" data-stab="audit">🔒 Audit</button>
        </div>

        <!-- Right content -->
        <div class="settings-content" style="flex:1;min-width:0;overflow-y:auto;padding:20px;">
          <p id="settings-refresh-status" role="status" style="font-size:13px;color:var(--text-secondary);margin:0 0 16px;">${escapeHtml(this.settingsStatus || '')}</p>
          ${this.activeTab === 'general' ? `<section class="discount-section"><h3>Stock locations</h3>
            <details class="stock-location-help" ${window.matchMedia('(max-width: 1023px)').matches ? '' : 'open'}><summary>How stock locations work</summary>
            <p>Every business has a <b>House</b> — it is what service draws from and what a sale decrements, so it cannot be switched off.</p>
            <p>A <b>Store</b> is an optional back room in front of it. With a Store enabled, every delivery is booked into the Store and the House tops itself up by requesting. A request waits until the store manager (or the owner) approves it, and only then does the stock move. Switching the Store off folds everything it holds into the House rather than stranding it.</p>
            </details>
            <select id="stock-mode" ${state.currentUser?.role === 'Owner' ? '' : 'disabled'}>${[['true','House and Store'],['false','House only']].map(([value,label]) => `<option value="${value}" ${String(storeIsEnabled()) === value ? 'selected' : ''}>${label}</option>`).join('')}</select>
            <button id="save-stock-mode" class="primary-btn" ${state.currentUser?.role === 'Owner' ? '' : 'disabled'}>Save stock locations</button><p id="stock-mode-result" role="status"></p></section>` : ''}

          <!-- GENERAL TAB -->
          <div id="stab-general" style="display:${this.activeTab === 'general' ? 'block' : 'none'}">
            <div class="discount-section">
              <h3>🏪 General Information</h3>
              <div class="discount-form-grid">
                <div>
                  <label>Establishment Name</label>
                  <input type="text" id="set-establishment-name" value="${state.currentTenant ? state.currentTenant.trading_name : 'Vanbransa'}">
                </div>
                <div>
                  <label>Assigned Site ID</label>
                  <input type="text" value="a4e69a8b8344" readonly>
                </div>
                <div>
                  <label>Currency</label>
                  <input type="text" value="KES">
                </div>
                <div>
                  <label>Trading day starts</label>
                  <select id="set-day-start" ${canSetHours ? '' : 'disabled'}>${hourOptions(hours.dayStartHour)}</select>
                </div>
                <div>
                  <label>Night session starts</label>
                  <select id="set-night-start" ${canSetHours ? '' : 'disabled'}>${hourOptions(hours.nightStartHour)}</select>
                </div>
              </div>
              <p style="margin:-6px 0 14px;color:var(--text-secondary);font-size:12px;">
                A trading day runs from the opening hour to the same hour next morning, so a night that
                crosses midnight stays on the day it started. The night session is the second half of that day.
                ${canSetHours ? '' : 'Only the owner or store manager can change these.'}
              </p>
              <div class="discount-field">
                <label>Receipt Footer Message</label>
                <input type="text" value="Thank you for coming to Vanbransa!">
              </div>
              <div style="background:rgba(255,255,255,0.03);border:1px solid var(--border-color);border-radius:8px;padding:14px;margin-bottom:16px;">
                <div style="font-size:10px;font-weight:800;color:var(--text-secondary);text-transform:uppercase;margin-bottom:4px;">License Expiry</div>
                <div style="font-size:14px;font-weight:700;">3/20/2027, 12:00:00 AM</div>
              </div>
              <button id="save-general-settings" class="discount-save-btn">Save General Settings</button>
            </div>
          </div>

          <!-- PAYMENTS SUB-TAB -->
          <div id="stab-payments" style="display:${this.activeTab === 'payments' ? 'block' : 'none'}">
            <div class="discount-section">
              <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
                <h3 style="margin:0;">💳 Owner Payment Method Controls</h3>
                <span style="font-size:11px;padding:4px 10px;border-radius:6px;background:rgba(232,165,53,0.15);color:#e8a535;font-weight:700;">
                  ${isOwner ? '👑 Owner Privileges Active' : '🔒 Read Only (Requires Owner Role)'}
                </span>
              </div>
              <p style="font-size:12px;color:var(--text-secondary);margin:-8px 0 20px 0;">Configure accepted payment methods across all Vanbransa checkout tills and online ordering endpoints.</p>

              <!-- A tender that is not enabled here is refused by the server
                   when the sale syncs, and refused permanently, so the money
                   stays stranded on the till that took it. -->
              <div style="background:rgba(255,255,255,0.03);border:1px solid var(--border-color);border-radius:10px;padding:18px;margin-bottom:16px;">
                <div style="font-weight:800;font-size:15px;color:#fff;">🏦 Other accepted tenders</div>
                <p style="font-size:12px;color:var(--text-secondary);margin:6px 0 14px;max-width:620px;line-height:1.5;">
                  A tender switched off here is refused when the sale reaches the server, and refused for good — the sale
                  stays stuck on the till that took it and never appears in Financials. Switch on everything this business
                  actually takes.${isOwner ? '' : ' Only the owner or store manager can change these.'}
                </p>
                ${TENDERS.map((tender) => `
                  <label style="display:flex;align-items:flex-start;gap:10px;margin-bottom:10px;">
                    <input type="checkbox" data-tender="${tender.id}" ${acceptedMethods.includes(tender.id) ? 'checked' : ''} ${isOwner ? '' : 'disabled'}>
                    <span>
                      <b style="color:#fff;">${tender.label}</b>
                      <span style="display:block;font-size:11px;color:var(--text-secondary);">${tender.note}</span>
                    </span>
                  </label>`).join('')}
                ${isOwner ? '<button id="save-tenders" class="discount-save-btn" style="margin-top:8px;">Save accepted tenders</button>' : ''}
                <p id="tenders-result" role="status" style="font-size:12px;color:var(--text-secondary);margin:8px 0 0;"></p>
              </div>

              <!-- Cash Payment Control -->
              <div style="background:rgba(255,255,255,0.03);border:1px solid var(--border-color);border-radius:10px;padding:18px;margin-bottom:16px;">
                <div style="display:flex;justify-content:space-between;align-items:center;">
                  <div>
                    <div style="font-weight:800;font-size:15px;color:#fff;display:flex;align-items:center;gap:10px;">
                      💵 Physical Cash Payments
                      <span id="payments-cash-badge" style="font-size:10px;padding:2px 8px;border-radius:12px;font-weight:800;background:${cashEnabled ? 'rgba(16,185,129,.15)' : 'rgba(244,63,94,.15)'};color:${cashEnabled ? 'var(--accent-green)' : 'var(--accent-rose)'};">
                        ${cashEnabled ? 'ENABLED' : 'DISABLED'}
                      </span>
                    </div>
                    <p style="font-size:12px;color:var(--text-secondary);margin-top:6px;max-width:520px;line-height:1.5;">
                      When disabled by the owner, waiters/waitresses will not see the Cash option at checkout, preventing cash sales and forcing digital/M-Pesa transactions.
                    </p>
                  </div>
                  ${isOwner ? `
                    <label style="position:relative;display:inline-block;width:50px;height:26px;flex-shrink:0;">
                      <input type="checkbox" id="payments-cash-toggle" style="opacity:0;width:0;height:0;" ${cashEnabled ? 'checked' : ''}>
                      <span id="payments-cash-slider" style="position:absolute;cursor:pointer;top:0;left:0;right:0;bottom:0;background:${cashEnabled ? '#10b981' : '#374151'};border-radius:26px;transition:.3s;">
                        <span style="position:absolute;height:20px;width:20px;left:${cashEnabled ? '26px' : '3px'};bottom:3px;background:white;border-radius:50%;transition:.3s;display:block;"></span>
                      </span>
                    </label>
                  ` : `<span style="font-size:11px;color:var(--text-muted);">Owner access only</span>`}
                </div>
              </div>

              <!-- M-Pesa Mobile Money Control -->
              <div style="background:rgba(255,255,255,0.03);border:1px solid var(--border-color);border-radius:10px;padding:18px;margin-bottom:16px;">
                <div style="display:flex;justify-content:space-between;align-items:center;">
                  <div>
                    <div style="font-weight:800;font-size:15px;color:#fff;display:flex;align-items:center;gap:10px;">
                      📱 M-Pesa STK Push &amp; Mobile Money
                      <span style="font-size:10px;padding:2px 8px;border-radius:12px;font-weight:800;background:rgba(16,185,129,.15);color:var(--accent-green);">ENABLED</span>
                    </div>
                    <p style="font-size:12px;color:var(--text-secondary);margin-top:6px;max-width:520px;line-height:1.5;">
                      Direct Safaricom STK Push integration for instant mobile payment confirmation.
                    </p>
                  </div>
                  <span style="font-size:11px;color:#10b981;font-weight:700;">Always Active</span>
                </div>
              </div>

            </div>
          </div>

          <!-- DISCOUNTS TAB -->
          <div id="stab-discounts" style="display:${this.activeTab === 'discounts' ? 'block' : 'none'}">
            <div class="discount-section">
              <h3>🏷️ Create New Discount Rule</h3>
              <div class="discount-form-grid">
                <div>
                  <label>Discount Name</label>
                  <input type="text" id="disc-name" placeholder="e.g. VIP Member, Happy Hour">
                </div>
                <div>
                  <label>Applies To</label>
                  <select id="disc-type">
                    <option value="individual">Individual Customer</option>
                    <option value="group">Customer Group</option>
                    <option value="all">All Customers</option>
                  </select>
                </div>
                <div>
                  <label>Discount Value</label>
                  <input type="number" id="disc-value" placeholder="e.g. 10" min="0" max="100">
                </div>
                <div>
                  <label>Discount Type</label>
                  <select id="disc-kind">
                    <option value="percent">Percentage (%)</option>
                    <option value="fixed">Fixed Amount (KES)</option>
                  </select>
                </div>
              </div>
              <div class="discount-form-grid">
                <div>
                  <label>Customer / Group Name (optional)</label>
                  <input type="text" id="disc-target" placeholder="e.g. John Doe, Staff Group">
                </div>
                <div>
                  <label>Status</label>
                  <select id="disc-status">
                    <option value="active">Active</option>
                    <option value="inactive">Inactive</option>
                  </select>
                </div>
              </div>
              <button class="discount-save-btn" id="disc-save-btn">+ Add Discount Rule</button>
            </div>

            <div class="discount-section">
              <h3>📋 Configured Discounts</h3>
              <table class="discount-table" id="discounts-list-table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Applies To</th>
                    <th>Target</th>
                    <th>Value</th>
                    <th>Status</th>
                    <th>Action</th>
                  </tr>
                </thead>
                <tbody id="discounts-list-body">
                  ${discounts.length === 0 ? '<tr><td colspan="6" style="text-align:center;color:var(--text-secondary);padding:24px;">No discount rules configured yet.</td></tr>' : discounts.map((d, i) => `
                    <tr>
                      <td style="font-weight:700;">${d.name}</td>
                      <td>${d.type === 'individual' ? '👤 Individual' : d.type === 'group' ? '👥 Group' : '🌍 All'}</td>
                      <td>${d.target || '—'}</td>
                      <td style="font-weight:700;color:var(--accent-cyan);">${d.kind === 'percent' ? d.value + '%' : 'KES ' + d.value}</td>
                      <td><span class="discount-badge ${d.status !== 'active' ? 'inactive' : ''}">${d.status.toUpperCase()}</span></td>
                      <td><button class="del-btn" data-disc-idx="${i}">Delete</button></td>
                    </tr>
                  `).join('')}
                </tbody>
              </table>
            </div>
          </div>

          <!-- SYSTEM TAB -->
          <div id="stab-system" style="display:${this.activeTab === 'system' ? 'block' : 'none'}">
            <div class="discount-section">
              <h3>🔧 System Configurations</h3>
              <div style="background:rgba(255,255,255,0.03);border:1px solid var(--border-color);border-radius:8px;padding:16px;display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;">
                <div>
                  <div style="font-weight:700;font-size:14px;display:flex;align-items:center;gap:8px;">💵 Cash Payments
                    <span id="cash-status-badge" style="font-size:10px;padding:2px 8px;border-radius:12px;font-weight:700;background:${cashEnabled ? 'rgba(16,185,129,.15)' : 'rgba(244,63,94,.15)'};color:${cashEnabled ? 'var(--accent-green)' : 'var(--accent-rose)'};"
                    >${cashEnabled ? 'ENABLED' : 'DISABLED'}</span>
                  </div>
                  <p style="font-size:12px;color:var(--text-secondary);margin-top:4px;">When disabled, waiters/waitresses will not see the Cash option at checkout.</p>
                </div>
                ${isOwner ? `
                  <label style="position:relative;display:inline-block;width:44px;height:24px;flex-shrink:0;">
                    <input type="checkbox" id="cash-toggle" style="opacity:0;width:0;height:0;" ${cashEnabled ? 'checked' : ''}>
                    <span id="cash-toggle-slider" style="position:absolute;cursor:pointer;top:0;left:0;right:0;bottom:0;background:${cashEnabled ? '#10b981' : '#374151'};border-radius:24px;transition:.3s;">
                      <span style="position:absolute;height:18px;width:18px;left:${cashEnabled ? '23px' : '3px'};bottom:3px;background:white;border-radius:50%;transition:.3s;display:block;"></span>
                    </span>
                  </label>` : `<span style="font-size:11px;color:var(--text-muted);">Owner access only</span>`}
              </div>
              <div style="background:rgba(255,255,255,0.03);border:1px solid var(--border-color);border-radius:8px;padding:16px;">
                <div style="font-weight:700;font-size:14px;margin-bottom:4px;">🏛️ KRA eTIMS (ETR receipts)</div>
                <p style="font-size:11px;color:var(--text-secondary);margin:0 0 12px;">Connect this branch to the OSCU device KRA approved for it. Once connected, paid bills get a Generate ETR button.</p>
                <div style="margin-bottom:12px;">
                  <label for="set-taxpayer-pin" style="font-size:11px;color:var(--text-secondary);">Business KRA PIN</label>
                  <input type="text" id="set-taxpayer-pin" value="${escapeHtml(state.currentTenant?.kra_pin || '')}" maxlength="11" ${isOwner ? '' : 'disabled'} style="width:100%;padding:8px;border-radius:4px;background:rgba(0,0,0,0.2);border:1px solid var(--border-color);color:#fff;margin-top:4px;">
                </div>
                <div style="margin-bottom:12px;">
                  <label for="set-etims-bhf" style="font-size:11px;color:var(--text-secondary);">eTIMS branch ID</label>
                  <input type="text" id="set-etims-bhf" value="${escapeHtml(state.currentBranch?.etims_bhf_id || '00')}" maxlength="2" ${isOwner ? '' : 'disabled'} style="width:100%;padding:8px;border-radius:4px;background:rgba(0,0,0,0.2);border:1px solid var(--border-color);color:#fff;margin-top:4px;">
                </div>
                <div style="margin-bottom:12px;">
                  <label for="set-etims-serial" style="font-size:11px;color:var(--text-secondary);">OSCU device serial number</label>
                  <input type="text" id="set-etims-serial" value="" autocomplete="off" ${isOwner ? '' : 'disabled'} style="width:100%;padding:8px;border-radius:4px;background:rgba(0,0,0,0.2);border:1px solid var(--border-color);color:#fff;margin-top:4px;">
                </div>
                <div style="margin-bottom:12px;">
                  <label for="set-etims-itemcls" style="font-size:11px;color:var(--text-secondary);">Default item classification code (used where a product has none)</label>
                  <input type="text" id="set-etims-itemcls" value="" maxlength="10" inputmode="numeric" ${isOwner ? '' : 'disabled'} style="width:100%;padding:8px;border-radius:4px;background:rgba(0,0,0,0.2);border:1px solid var(--border-color);color:#fff;margin-top:4px;">
                </div>
                <div style="margin-bottom:16px;">
                  <label for="set-etims-env" style="font-size:11px;color:var(--text-secondary);">Environment</label>
                  <select id="set-etims-env" ${isOwner ? '' : 'disabled'} style="width:100%;padding:8px;border-radius:4px;background:rgba(0,0,0,0.2);border:1px solid var(--border-color);color:#fff;margin-top:4px;">
                    <option value="sandbox">Sandbox (testing)</option>
                    <option value="production">Production (live receipts)</option>
                  </select>
                </div>
                ${isOwner
                  ? '<button id="save-kra-settings" style="background:var(--accent-blue);color:#fff;border:none;padding:8px 16px;border-radius:6px;font-weight:700;cursor:pointer;">Connect eTIMS</button>'
                  : '<span style="font-size:11px;color:var(--text-muted);">Owner access only</span>'}
              </div>
            </div>
          </div>

          <!-- AUDIT TAB -->
          ${this.activeTab === 'staff' ? this.moduleAccessCard() : ''}
          <div id="stab-staff" style="display:${this.activeTab === 'staff' ? 'block' : 'none'}"></div>

          <div id="stab-audit" style="display:${this.activeTab === 'audit' ? 'block' : 'none'}">
            <div class="discount-section">
              <h3>🔒 Audit Ledger Verification</h3>
              <p style="font-size:13px;color:var(--text-secondary);margin:0 0 16px 0;">Verify the cryptographic hash chain of all system events to detect tampering.</p>
              <button id="verify-logs-btn" style="background:rgba(255,255,255,0.1);color:#fff;border:1px solid var(--border-color);padding:10px 20px;border-radius:8px;font-weight:600;cursor:pointer;">🔍 Verify Integrity</button>
              <div id="integrity-result-box" style="margin-top:16px;padding:14px;border-radius:8px;font-size:13px;" class="hidden"></div>
            </div>
          </div>

        </div>
      </div>
    `;
  }

  /**
   * Staff management, moved out of its own sidebar entry.
   *
   * UsersView owns its markup and events, so it is mounted into the pane rather
   * than reimplemented here - there is one place that creates staff, and it is
   * the one already wired to createStaffUser.
   */
  mountStaffPane() {
    if (this.activeTab !== 'staff') return;
    const pane = document.getElementById('stab-staff');
    if (!pane) return;

    this.usersView = new UsersView(pane);
    this.usersView.load();
  }

  dispose() { this.disposed = true; this.usersView?.dispose(); }

  bindEvents() {
    this.setSettingsWriteState();
    this.container.addEventListener('input', () => { this.settingsEdited = true; }, { once: true });
    this.container.addEventListener('change', () => { this.settingsEdited = true; }, { once: true });
    this.container.querySelector('#access-role')?.addEventListener('change', event => {
      this.accessRole = event.target.value;
      // Keep every role mounted so switching roles never discards a draft.
      this.container.querySelectorAll('[data-access-panel]').forEach(panel => { panel.hidden = panel.dataset.accessPanel !== this.accessRole; });
    });
    this.container.querySelectorAll('input[data-access]').forEach(box => box.addEventListener('change', () => {
      const enabled = this.container.querySelectorAll(`input[data-role="${box.dataset.role}"]:checked`).length;
      this.container.querySelector(`[data-access-count="${box.dataset.role}"]`).textContent = `${enabled} of ${accessModules().length} enabled`;
      this.container.querySelector('#module-access-result').textContent = 'Unsaved changes. Save to apply permissions for all roles.';
    }));
    this.container.querySelector('#save-module-access')?.addEventListener('click', async (event) => {
      const button = event.currentTarget;
      const result = this.container.querySelector('#module-access-result');
      const map = Object.fromEntries(accessModules().map(({ key }) => [key, []]));
      this.container.querySelectorAll('input[data-access]:checked').forEach((box) => map[box.dataset.access].push(box.dataset.role));
      button.disabled = true;
      const fields = this.container.querySelectorAll('.access-group');
      fields.forEach(field => { field.disabled = true; });
      result.textContent = 'Saving permissions…';
      try { await saveModuleAccess(map); result.textContent = 'Saved. Each till picks this up when it next loads settings.'; }
      catch (error) { result.textContent = error.message || 'Module access could not be saved.'; }
      finally { button.disabled = false; fields.forEach(field => { field.disabled = false; }); }
    });
    const stockButton = this.container.querySelector('#save-stock-mode');
    if (stockButton) stockButton.onclick = async () => {
      stockButton.disabled = true;
      try { const result = await configureStock(this.container.querySelector('#stock-mode').value === 'true'); this.container.querySelector('#stock-mode-result').textContent = result.storeEnabled ? 'Saved. Deliveries now go into the Store, and the House requests from it.' : `Saved. House only; ${result.moved} Store balance(s) folded into the House.`; }
      catch (error) { this.container.querySelector('#stock-mode-result').textContent = error.message; }
      finally { stockButton.disabled = false; }
    };
    this.mountStaffPane();

    // Sub-tab switching
    this.container.querySelectorAll('[data-stab]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        this.activeTab = e.currentTarget.getAttribute('data-stab');
        this.render();
        this.bindEvents();
      });
    });

    // General Settings Save
    const saveGenBtn = document.getElementById('save-general-settings');
    if (saveGenBtn) saveGenBtn.addEventListener('click', async () => {
      const name = document.getElementById('set-establishment-name').value;
      if (state.currentTenant && name) {
        state.currentTenant.trading_name = name;
        await db.tenants.update(state.currentTenant.id, { trading_name: name });
      }
      // Trading hours decide which day money is booked to, so a failure here
      // is reported rather than folded into a blanket "saved".
      const dayEl = document.getElementById('set-day-start');
      const nightEl = document.getElementById('set-night-start');
      if (dayEl && nightEl && !dayEl.disabled) {
        const dayStartHour = Number(dayEl.value);
        const nightStartHour = Number(nightEl.value);
        if (dayStartHour !== this.tradingHours?.dayStartHour
          || nightStartHour !== this.tradingHours?.nightStartHour) {
          try {
            this.tradingHours = await saveTradingHours({ dayStartHour, nightStartHour });
            showNotification('Trading hours saved. Reload Financials to apply them.', 'success');
          } catch (error) {
            showNotification(error.message || 'Could not save trading hours.', 'error');
            return;
          }
        }
      }
      showNotification('General settings saved.', 'success');
    });

    const saveTenders = document.getElementById('save-tenders');
    if (saveTenders) saveTenders.addEventListener('click', async () => {
      const result = document.getElementById('tenders-result');
      const chosen = [...document.querySelectorAll('[data-tender]')]
        .filter((box) => box.checked).map((box) => box.dataset.tender);
      saveTenders.disabled = true;
      try {
        this.acceptedMethods = await saveAcceptedMethods(chosen);
        if (result) result.textContent = 'Saved. Tills will settle these tenders and the sales will sync.';
        showNotification('Accepted tenders saved.', 'success');
      } catch (error) {
        if (result) result.textContent = error.message || 'Could not save accepted tenders.';
        showNotification(error.message || 'Could not save accepted tenders.', 'error');
      } finally {
        saveTenders.disabled = false;
      }
    });

    // Discount Save
    const discSaveBtn = document.getElementById('disc-save-btn');
    if (discSaveBtn) discSaveBtn.addEventListener('click', () => {
      const name = document.getElementById('disc-name').value.trim();
      const type = document.getElementById('disc-type').value;
      const value = parseFloat(document.getElementById('disc-value').value);
      const kind = document.getElementById('disc-kind').value;
      const target = document.getElementById('disc-target').value.trim();
      const status = document.getElementById('disc-status').value;
      if (!name || isNaN(value) || value <= 0) {
        showNotification('Please enter a valid discount name and value.', 'error');
        return;
      }
      const discounts = JSON.parse(tenantStorage.getItem('pos_discounts') || '[]');
      discounts.push({ name, type, value, kind, target, status });
      tenantStorage.setItem('pos_discounts', JSON.stringify(discounts));
      showNotification('Discount rule "' + name + '" saved!', 'success');
      this.render();
      this.bindEvents();
    });

    // Discount Delete
    this.container.querySelectorAll('[data-disc-idx]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const idx = parseInt(e.currentTarget.getAttribute('data-disc-idx'));
        const discounts = JSON.parse(tenantStorage.getItem('pos_discounts') || '[]');
        discounts.splice(idx, 1);
        tenantStorage.setItem('pos_discounts', JSON.stringify(discounts));
        showNotification('Discount rule deleted.', 'warning');
        this.render();
        this.bindEvents();
      });
    });

    // Cash toggle (System tab)
    const toggle = document.getElementById('cash-toggle');
    if (toggle) {
      toggle.addEventListener('change', async () => {
        const enabled = toggle.checked;
        toggle.disabled = true;
        try { await saveCashEnabled(enabled); }
        catch (error) { toggle.checked = !enabled; showNotification(error.message, 'error'); return; }
        finally { toggle.disabled = false; }
        const badge  = document.getElementById('cash-status-badge');
        const slider = document.getElementById('cash-toggle-slider');
        if (badge) { badge.textContent = enabled ? 'ENABLED' : 'DISABLED'; badge.style.background = enabled ? 'rgba(16,185,129,.15)' : 'rgba(244,63,94,.15)'; badge.style.color = enabled ? 'var(--accent-green)' : 'var(--accent-rose)'; }
        if (slider) { slider.style.background = enabled ? '#10b981' : '#374151'; slider.querySelector('span').style.left = enabled ? '23px' : '3px'; }
        showNotification('Cash payments ' + (enabled ? 'enabled' : 'DISABLED') + '.', enabled ? 'success' : 'warning');
      });
    }

    // Cash toggle (Payments sub-tab)
    const payToggle = document.getElementById('payments-cash-toggle');
    if (payToggle) {
      payToggle.addEventListener('change', async () => {
        const enabled = payToggle.checked;
        payToggle.disabled = true;
        try { await saveCashEnabled(enabled); }
        catch (error) { payToggle.checked = !enabled; showNotification(error.message, 'error'); return; }
        finally { payToggle.disabled = false; }
        const badge  = document.getElementById('payments-cash-badge');
        const slider = document.getElementById('payments-cash-slider');
        if (badge) {
          badge.textContent = enabled ? 'ENABLED' : 'DISABLED';
          badge.style.background = enabled ? 'rgba(16,185,129,.15)' : 'rgba(244,63,94,.15)';
          badge.style.color = enabled ? 'var(--accent-green)' : 'var(--accent-rose)';
        }
        if (slider) {
          slider.style.background = enabled ? '#10b981' : '#374151';
          slider.querySelector('span').style.left = enabled ? '26px' : '3px';
        }
        showNotification('Owner Payment Policy: Cash payments ' + (enabled ? 'ENABLED' : 'DISABLED') + '.', enabled ? 'success' : 'warning');
      });
    }

    // KRA eTIMS: the server initialises the device with KRA and keeps its key.
    const saveKra = document.getElementById('save-kra-settings');
    if (saveKra) saveKra.addEventListener('click', async () => {
      const value = (id) => document.getElementById(id).value.trim();
      const tin = value('set-taxpayer-pin').toUpperCase();
      if (!state.currentBranch?.id) return showNotification('Choose a branch first.', 'error');
      saveKra.disabled = true;
      saveKra.textContent = 'Connecting…';
      try {
        const result = await callFunction('setupEtims', {
          branchId: state.currentBranch.id,
          tin,
          bhfId: value('set-etims-bhf'),
          deviceSerial: value('set-etims-serial'),
          environment: value('set-etims-env'),
          defaultItemClassCode: value('set-etims-itemcls') || undefined,
        });
        if (state.currentTenant) { state.currentTenant.kra_pin = tin; await db.tenants.update(state.currentTenant.id, { kra_pin: tin }); }
        showNotification(`eTIMS connected (${result.environment}). SCU ID ${result.sdcId}.`, 'success');
      } catch (error) {
        showNotification(error?.message || 'eTIMS could not be connected.', 'error');
      } finally {
        saveKra.disabled = false;
        saveKra.textContent = 'Connect eTIMS';
      }
    });

    // Verify Logs
    const verifyBtn = document.getElementById('verify-logs-btn');
    if (verifyBtn) verifyBtn.addEventListener('click', async () => {
      const res = await verifyAuditTrail();
      const box = document.getElementById('integrity-result-box');
      box.classList.remove('hidden');
      if (res.valid) {
        box.style.cssText = 'background:rgba(16,185,129,0.1);border:1px solid rgba(16,185,129,0.3);color:var(--accent-green);padding:14px;border-radius:8px;font-size:13px;margin-top:16px;';
        box.innerHTML = '<b>Integrity Verified ✅</b> — ' + res.count + ' chained records validated with zero mismatches.';
        showNotification('Ledger integrity verified.', 'success');
      } else {
        box.style.cssText = 'background:rgba(244,63,94,0.1);border:1px solid rgba(244,63,94,0.3);color:var(--accent-rose);padding:14px;border-radius:8px;font-size:13px;margin-top:16px;';
        box.innerHTML = '<b>⚠️ Integrity FAILED!</b> — ' + res.reason + ' (index: ' + res.brokenIndex + ').';
        showNotification('Ledger integrity compromised!', 'error');
      }
    });
  }
}
