import { db } from '../db/schema';
import { logAuditEvent } from '../db/index';
import { state, showNotification } from '../context';
import { firebaseConfigured, openShift as openCloudShift } from '../services/firebase';
import { cashIsEnabled, pullPaymentSettings } from '../services/payment-settings';
import { shiftCloseBlockers } from '../services/tabs';

export class ShiftsView {
  constructor(container) {
    this.container = container;
  }

  async load() {
    this.activeShift = await db.shifts.where('user_id').equals(state.currentUser.id).filter((shift) => shift.status === 'OPEN' && shift.branch_id === state.currentBranch.id).first();
    this.render();
    this.bindEvents();
    void pullPaymentSettings().catch(() => {
      if (!this.disposed) showNotification('Payment settings could not refresh.', 'warning');
    });
  }

  dispose() { this.disposed = true; }

  render() {
    if (!this.activeShift) {
      this.renderNoActiveShift();
    } else {
      this.renderActiveShiftDetails();
    }
  }

  renderNoActiveShift() {
    this.container.innerHTML = `
      <div class="view-header">
        <h2>Shift Management</h2>
      </div>

      <div style="background:var(--bg-surface);border:1px solid var(--border-color);border-radius:14px;padding:32px;text-align:center;max-width:500px;margin: 40px auto;box-shadow:var(--glass-shadow);">
        <span style="font-size:48px;">🏪</span>
        <h3 style="margin-top:16px;font-family:var(--font-display);font-weight:700;">No Open Shift Found</h3>
        <p style="color:var(--text-secondary);font-size:13px;margin-top:8px;margin-bottom:24px;">${cashIsEnabled() ? 'Declare your opening cash float to begin selling.' : 'Cash payments are disabled. Open your shift to begin selling.'}</p>
        
        <div style="text-align:left;margin-bottom:20px;${cashIsEnabled() ? '' : 'display:none;'}">
          <label style="font-size:11px;color:var(--text-secondary);display:block;margin-bottom:6px;">Opening Cash Float (KES)</label>
          <input type="number" id="opening-float-input" min="0" step="0.01" value="0" style="width:100%;background:rgba(3,7,18,0.4);border:1px solid var(--border-color);color:#fff;padding:10px;border-radius:8px;outline:none;">
        </div>

        <button class="checkout-btn" id="open-shift-btn" style="width:100%;">Open Waiter/Waitress Shift</button>
      </div>
    `;
  }

  renderActiveShiftDetails() {
    this.container.innerHTML = `
      <div class="view-header">
        <h2>Active Till Shift</h2>
        <span class="badge success">OPEN since ${new Date(this.activeShift.opened_at).toLocaleTimeString()}</span>
      </div>

      <div class="shift-columns" style="display:grid;grid-template-columns: 1fr 1fr;gap:24px;">
        <!-- Left: Details and Movements -->
        <div style="background:var(--bg-surface);border:1px solid var(--border-color);border-radius:14px;padding:24px;">
          <h3 style="font-family:var(--font-display);margin-bottom:16px;">Cash Ledger Actions</h3>
          
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:20px;">
            <div class="metric-card" style="padding:14px;">
              <h3>Opening Float</h3>
              <span class="val" style="font-size:18px;">KES ${this.activeShift.opening_float.toFixed(2)}</span>
            </div>
            <div class="metric-card" style="padding:14px;">
              <h3>Expected Drawer Cash</h3>
              <span class="val" style="font-size:18px;" id="shift-expected-cash">KES 0.00</span>
            </div>
          </div>

          <div style="display:flex;gap:10px;margin-bottom:20px;">
            <button class="primary-btn" id="cash-payout-btn" style="flex:1;">Record Cash Pay-out</button>
            <button class="sec-btn" id="cash-payin-btn" style="flex:1;">Record Cash Pay-in</button>
          </div>

          <h3 style="font-family:var(--font-display);margin-bottom:12px;font-size:14px;">Shift X-Report Preview</h3>
          <button class="sec-btn" id="print-x-btn" style="width:100%;margin-bottom:12px;">Print Mid-Shift X-Report (Non-Resetting)</button>
        </div>

        <!-- Right: Z-Report Close -->
        <div style="background:var(--bg-surface);border:1px solid var(--border-color);border-radius:14px;padding:24px;">
          <h3 style="font-family:var(--font-display);margin-bottom:16px;color:var(--accent-rose)">Shift Close & Cash Up</h3>
          <p style="color:var(--text-secondary);font-size:12px;margin-bottom:20px;">Declare counted physical drawer currency per tender to close the register.</p>

          <div class="checkout-inputs" style="margin-bottom:16px;">
            <label style="font-size:11px;color:var(--text-secondary)">Counted Cash (Drawer total)</label>
            <input type="number" id="counted-cash-input" placeholder="Enter counted KES cash...">
          </div>

          <div class="checkout-inputs" style="margin-bottom:24px;">
            <label style="font-size:11px;color:var(--text-secondary)">Counted M-Pesa total</label>
            <input type="number" id="counted-mpesa-input" placeholder="Enter verified M-Pesa receipts...">
          </div>

          <button class="checkout-btn" id="close-shift-btn" style="width:100%;background:linear-gradient(135deg, var(--accent-rose), #be123c);box-shadow:0 4px 15px rgba(244,63,94,0.2);">
            Post Sequential Z-Report & Close Shift
          </button>
        </div>
      </div>
    `;

    this.calculateExpectedDrawer();
  }

  bindEvents() {
    const openBtn = document.getElementById('open-shift-btn');
    if (openBtn) {
      openBtn.addEventListener('click', () => {
        this.openShift();
      });
    }

    const payoutBtn = document.getElementById('cash-payout-btn');
    if (payoutBtn) {
      payoutBtn.addEventListener('click', () => {
        this.recordCashMovement('PAYOUT');
      });
    }

    const payinBtn = document.getElementById('cash-payin-btn');
    if (payinBtn) {
      payinBtn.addEventListener('click', () => {
        this.recordCashMovement('PAYIN');
      });
    }

    const printXBtn = document.getElementById('print-x-btn');
    if (printXBtn) {
      printXBtn.addEventListener('click', () => {
        this.printXReport();
      });
    }

    const closeBtn = document.getElementById('close-shift-btn');
    if (closeBtn) {
      closeBtn.addEventListener('click', () => {
        this.closeShiftAndGenerateZ();
      });
    }
  }

  async openShift() {
    const float = cashIsEnabled() ? Number(document.getElementById('opening-float-input').value) : 0;
    if (!Number.isFinite(float) || float < 0) { showNotification('Enter a valid opening float.', 'warning'); return; }
    
    // Check if user already has an active shift
    const existing = await db.shifts.where('user_id').equals(state.currentUser.id).filter(s => s.status === 'OPEN').first();
    if (existing) {
      showNotification('You already have an open shift. Close it first.', 'error');
      return;
    }

    let shiftId = state.cloudShiftId || crypto.randomUUID();
    let actualFloat = float;
    if (firebaseConfigured) {
      try {
        const cloudShift = await openCloudShift(
          state.currentBranch.id,
          undefined,
          Math.round(float * 100)
        );
        state.cloudShiftId = cloudShift?.shiftId || null;
        actualFloat = (cloudShift.openingFloatMinor ?? Math.round(float * 100)) / 100;
        shiftId = state.cloudShiftId || shiftId;
      } catch {
        // Offline shifts retain a local id. They remain queued until a cloud
        // session is available; no provider payment can start while offline.
      }
    }
    const newShift = {
      id: shiftId,
      branch_id: state.currentBranch.id,
      user_id: state.currentUser.id,
      opening_float: actualFloat,
      status: 'OPEN',
      opened_at: new Date().toISOString()
    };

    // The cloud shift id is deterministic and may already have a locally
    // closed row from yesterday. Reopening replaces that row; add() would
    // throw a duplicate-key error and leave the waiter apparently off shift.
    await db.shifts.put(newShift);
    
    await logAuditEvent(state.currentTenant.id, state.currentUser.id, 'SHIFT_OPEN', 'SHIFT', shiftId);

    showNotification('Waiter/Waitress register shift opened.', 'success');
    this.activeShift = newShift;
    this.renderActiveShiftDetails();
    this.bindEvents();
  }

  async calculateExpectedDrawer() {
    // 1. Fetch completed sales during shift
    const sales = await db.sales
      .where('shift_id')
      .equals(this.activeShift.id)
      .toArray();

    // 2. Fetch cash payments
    const paymentsList = await db.payments.toArray();
    const saleIds = new Set(sales.map(s => s.id));
    const shiftPayments = paymentsList.filter(p => saleIds.has(p.sale_id));
    
    let cashSalesTotal = 0;
    let mpesaSalesTotal = 0;
    
    shiftPayments.forEach(p => {
      if (p.method === 'CASH') cashSalesTotal += p.amount;
      if (p.method === 'MPESA') mpesaSalesTotal += p.amount;
      if (p.method === 'SPLIT') {
        cashSalesTotal += (p.amount / 2); // Simple ratio representation
      }
    });

    // 3. Fetch Petty Cash Expenses (PAYOUTS)
    const expensesList = await db.expenses
      .where('shift_id')
      .equals(this.activeShift.id)
      .toArray();
    const totalPayouts = expensesList.reduce((acc, exp) => acc + exp.amount, 0);

    // 4. Fetch Cash Pay-ins from audit logs
    const auditLogs = await db.audit_log
      .where('entity_id')
      .equals(this.activeShift.id)
      .toArray();
    
    let totalPayins = 0;
    auditLogs.forEach(log => {
      if (log.action === 'CASH_PAYIN') {
        try {
          const data = JSON.parse(log.details);
          totalPayins += data.amount || 0;
        } catch (e) {}
      }
    });

    const expectedCash = this.activeShift.opening_float + cashSalesTotal + totalPayins - totalPayouts;
    
    document.getElementById('shift-expected-cash').innerText = `KES ${expectedCash.toFixed(2)}`;
    
    this.expectedSums = {
      cash: expectedCash,
      mpesa: mpesaSalesTotal
    };
  }

  async recordCashMovement(type) {
    const amt = parseFloat(prompt(`Enter cash ${type} amount (KES):`));
    if (isNaN(amt) || amt <= 0) return;
    const reason = prompt('Enter justification / reason code:');

    if (type === 'PAYOUT') {
      await db.expenses.add({
        id: `exp-${crypto.randomUUID().slice(0, 8)}`,
        tenant_id: state.currentTenant.id,
        branch_id: state.currentBranch.id,
        shift_id: this.activeShift.id,
        category: reason || 'Miscellaneous Expense',
        amount: amt,
        created_at: new Date().toISOString()
      });
    }

    // Logs movement details
    await logAuditEvent(
      state.currentTenant.id,
      state.currentUser.id,
      `CASH_${type}`,
      'SHIFT',
      this.activeShift.id,
      null,
      JSON.stringify({ amount: amt, reason })
    );

    showNotification(`Cash drawer ${type} logged.`, 'success');
    this.calculateExpectedDrawer();
  }

  showThermalShiftReport({ title, subtitle, lines, footer }) {
    let modal = document.getElementById('shift-thermal-modal');
    if (modal) modal.remove();
    modal = document.createElement('div');
    modal.id = 'shift-thermal-modal';
    modal.className = 'modal active';
    const tenantName = state.currentTenant?.trading_name || 'Vanbransa Lounge';
    const branchName = state.currentBranch?.name || 'Main Branch';
    modal.innerHTML = `
      <div class="modal-content" style="max-width:400px;background:#1a1109;border:1px solid rgba(232,165,53,0.35);padding:20px;border-radius:16px;">
        <h3 style="margin:0 0 12px;color:#f5ece0;font-size:16px;">🧾 ${title}</h3>
        <div id="shift-thermal-paper" class="receipt-paper-58" style="background:#fff;color:#000;padding:18px;border-radius:8px;font-family:monospace;font-size:12px;line-height:1.55;max-width:290px;margin:0 auto;">
          <div style="text-align:center;font-weight:800;font-size:15px;">${tenantName}</div>
          <div style="text-align:center;font-size:11px;color:#444;">${branchName}</div>
          <div style="text-align:center;font-weight:700;margin:6px 0;">${title}</div>
          <div style="text-align:center;font-size:11px;color:#555;margin-bottom:8px;">${subtitle}</div>
          <div style="border-top:1px dashed #444;margin:8px 0;"></div>
          ${lines.map(([k, v, bold]) => `
            <div style="display:flex;justify-content:space-between;${bold ? 'font-weight:800;border-top:1px solid #000;padding-top:4px;margin-top:4px;' : ''}">
              <span>${k}</span>
              <span>${v}</span>
            </div>
          `).join('')}
          <div style="border-top:1px dashed #444;margin:10px 0 6px;"></div>
          <div style="font-size:11px;text-align:center;color:#333;">${footer}</div>
          <div style="margin-top:14px;border-top:1px dotted #888;padding-top:4px;font-size:10px;text-align:center;color:#555;">Staff Signature</div>
        </div>
        <div style="display:flex;gap:10px;margin-top:16px;width:100%;">
          <button type="button" class="primary-btn" id="shift-report-print" style="flex:1.4;">🖨️ Print Report</button>
          <button type="button" class="sec-btn" id="shift-report-close" style="flex:1;">Done</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);
    modal.querySelector('#shift-report-print').addEventListener('click', () => {
      if (typeof window !== 'undefined' && typeof window.print === 'function') window.print();
      modal.remove();
      showNotification(`${title} printed.`, 'success');
    });
    modal.querySelector('#shift-report-close').addEventListener('click', () => modal.remove());
  }

  async printXReport() {
    await this.calculateExpectedDrawer();
    const sales = await db.sales.where('shift_id').equals(this.activeShift.id).toArray();
    this.showThermalShiftReport({
      title: 'X-REPORT (MID-SHIFT)',
      subtitle: new Date().toLocaleString(),
      lines: [
        ['Staff:', state.currentUser?.name || 'Staff'],
        ['Role:', state.currentUser?.role || 'Cashier'],
        ['Opened:', new Date(this.activeShift.opened_at).toLocaleTimeString()],
        ['Completed Sales:', String(sales.length)],
        ['Opening Float:', `KES ${this.activeShift.opening_float.toFixed(2)}`],
        ['Expected Cash:', `KES ${this.expectedSums.cash.toFixed(2)}`, true],
        ['Expected M-Pesa:', `KES ${this.expectedSums.mpesa.toFixed(2)}`, true],
      ],
      footer: 'NON-RESETTING MID-SHIFT AUDITOR RECORD',
    });
  }

  async closeShiftAndGenerateZ() {
    const countedCash = parseFloat(document.getElementById('counted-cash-input').value);
    const countedMpesa = parseFloat(document.getElementById('counted-mpesa-input').value);

    if (isNaN(countedCash) || isNaN(countedMpesa)) {
      showNotification('Please enter counted cash and M-Pesa totals to close shift.', 'warning');
      return;
    }

    const blockers = shiftCloseBlockers(await db.tabs.toArray(), state.currentBranch?.id);
    if (blockers.length > 0) {
      const tables = blockers.map((tab) => `Table ${tab.table_no}`).join(', ');
      showNotification(
        `${blockers.length} tab${blockers.length === 1 ? '' : 's'} still open (${tables}). Settle or close ${blockers.length === 1 ? 'it' : 'them'} in Orders before closing the shift.`,
        'error'
      );
      return;
    }

    await this.calculateExpectedDrawer();
    const cashVariance = countedCash - this.expectedSums.cash;
    const mpesaVariance = countedMpesa - this.expectedSums.mpesa;
    const closedShift = this.activeShift;

    await db.transaction('rw', db.shifts, async () => {
      await db.shifts.update(closedShift.id, {
        status: 'CLOSED',
        closed_at: new Date().toISOString(),
        counted_cash: countedCash,
        expected_cash: this.expectedSums.cash,
        cash_variance: cashVariance,
        counted_mpesa: countedMpesa,
        expected_mpesa: this.expectedSums.mpesa,
        mpesa_variance: mpesaVariance
      });
    });

    await logAuditEvent(state.currentTenant.id, state.currentUser.id, 'SHIFT_CLOSE_Z', 'SHIFT', closedShift.id, JSON.stringify(this.expectedSums), JSON.stringify({ countedCash, cashVariance }));

    const zId = `Z-${new Date().getTime().toString().slice(-5)}`;
    this.showThermalShiftReport({
      title: `SEQUENTIAL Z-REPORT (${zId})`,
      subtitle: new Date().toLocaleString(),
      lines: [
        ['Staff:', state.currentUser?.name || 'Staff'],
        ['Opened:', new Date(closedShift.opened_at).toLocaleTimeString()],
        ['Closed:', new Date().toLocaleTimeString()],
        ['Expected Cash:', `KES ${this.expectedSums.cash.toFixed(2)}`],
        ['Counted Cash:', `KES ${countedCash.toFixed(2)}`],
        ['Cash Variance:', `KES ${cashVariance.toFixed(2)}`, true],
        ['Expected M-Pesa:', `KES ${this.expectedSums.mpesa.toFixed(2)}`],
        ['Counted M-Pesa:', `KES ${countedMpesa.toFixed(2)}`],
        ['M-Pesa Variance:', `KES ${mpesaVariance.toFixed(2)}`, true],
      ],
      footer: 'IMMUTABLE SYSTEM Z-REPORT POSTED',
    });

    showNotification('Shift closed and Z-report generated.', 'success');
    state.cloudShiftId = null;
    this.activeShift = null;
    this.renderNoActiveShift();
    this.bindEvents();
  }
}
