import { WALK_IN_CUSTOMER_ID } from '../services/firebase';
import { db } from '../db/schema';
import { state, showNotification } from '../context';
import { logAuditEvent } from '../db/index';
import { deleteCustomer, pullCustomers, saveCustomer } from '../services/customers';
import { escapeHtml } from '../services/print-receipt';

/**
 * Where a customer's debt is paid: their unpaid bills in Orders, each settled
 * on the server. This screen used to "repay" a tab by lowering a balance kept
 * on one tablet, which recorded no money and left every bill unpaid. No amount
 * is shown here because the only per-customer balance is that device-local one.
 */
export function unpaidBillsLink(customer) {
  return `<a class="sec-btn" href="/orders?order=${encodeURIComponent(customer.name || '')}"
    aria-label="View unpaid bills for ${escapeHtml(customer.name || 'this customer')}"
    style="padding:5px 10px;font-size:11px;text-decoration:none;">View unpaid bills</a>`;
}

export class CustomersView {
  constructor(container) {
    this.container = container;
  }

  /** Taking a name off a debt is the owner's alone; the server agrees. */
  get canDelete() { return state.currentUser?.role === 'Owner'; }

  async load() {
    this.render();
    this.bindEvents();
    await this.loadCustomers();
    void this.refreshCustomers();
  }

  dispose() { this.disposed = true; }

  async refreshCustomers() {
    // The register lives on the server, so this screen shows everyone the
    // business has - not only whoever was typed into this device.
    try {
      await pullCustomers();
    } catch {
      if (this.disposed) return;
      showNotification('Showing this device only — the customer directory could not be read.', 'warning');
    }
    if (!this.disposed) await this.loadCustomers();
  }

  render() {
    this.container.innerHTML = `
      <div class="module-page" style="padding: 24px; color: var(--text-primary); max-width: 1200px; margin: 0 auto; font-family: var(--font-main);">
        
        <!-- Header -->
        <div style="margin-bottom: 28px;">
          <h2 style="font-family: var(--font-display); font-size: 24px; font-weight: 800; color: #fff; margin-bottom: 6px;">👥 CRM, Loyalty &amp; BNPL Credit Tabs</h2>
          <p style="color: var(--text-secondary); font-size: 13px;">Manage customer directory, track loyalty points, set Buy-Now-Pay-Later (BNPL) credit limits, and reconcile credit accounts.</p>
        </div>

        <div class="customer-columns" style="display: grid; grid-template-columns: 1fr 380px; gap: 24px; align-items: flex-start;">
          
          <!-- Left Column: Customers Registry -->
          <div style="background: var(--bg-element); border: 1px solid var(--border-color); border-radius: 16px; padding: 24px; box-shadow: var(--glass-shadow);">
            <h3 style="margin-top: 0; margin-bottom: 16px; font-size: 15px; color: #fff;">👥 Customer Accounts Directory</h3>
            <div style="overflow-x: auto;">
              <table style="width: 100%; border-collapse: collapse; text-align: left; font-size: 13px;">
                <thead>
                  <tr style="border-bottom: 1px solid rgba(255,255,255,0.06); color: var(--text-secondary);">
                    <th style="padding: 10px 8px;">Customer Name</th>
                    <th style="padding: 10px 8px;">Phone</th>
                    <th style="padding: 10px 8px;">Loyalty Points</th>
                    <th style="padding: 10px 8px;">Unpaid bills</th>
                    <th style="padding: 10px 8px;">Credit Limit</th>
                    <th style="padding: 10px 8px; text-align: right;">Action</th>
                  </tr>
                </thead>
                <tbody id="customers-registry-body">
                  <!-- Loaded dynamically -->
                </tbody>
              </table>
            </div>
          </div>

          <!-- Right Column: Add New Customer -->
          <div style="background: var(--bg-element); border: 1px solid var(--border-color); border-radius: 16px; padding: 24px; box-shadow: var(--glass-shadow); display: flex; flex-direction: column; gap: 16px;">
            <h3 style="margin-top: 0; margin-bottom: 4px; font-size: 15px; color: #fff;">➕ Add New Customer Profile</h3>
            <p style="color: var(--text-secondary); font-size: 12px; margin: 0;">Create a profile to enable loyalty points accrual and tab credit limit allocation.</p>

            <form id="customer-reg-form" style="display: flex; flex-direction: column; gap: 12px;">
              <div>
                <label style="display: block; font-size: 11px; color: var(--text-muted); text-transform: uppercase; margin-bottom: 6px;">Full Name</label>
                <input type="text" id="cust-name" placeholder="e.g. John Mwangi" required style="width: 100%; background: rgba(255,255,255,0.03); border: 1px solid var(--border-color); border-radius: 6px; padding: 8px 12px; color: #fff; font-size: 13px; outline: none;">
              </div>
              <div>
                <label style="display: block; font-size: 11px; color: var(--text-muted); text-transform: uppercase; margin-bottom: 6px;">Phone Number</label>
                <input type="tel" id="cust-phone" placeholder="07XXXXXXXX" required style="width: 100%; background: rgba(255,255,255,0.03); border: 1px solid var(--border-color); border-radius: 6px; padding: 8px 12px; color: #fff; font-size: 13px; outline: none; font-family: monospace;">
              </div>
              <div>
                <label style="display: block; font-size: 11px; color: var(--text-muted); text-transform: uppercase; margin-bottom: 6px;">KRA PIN (Optional)</label>
                <input type="text" id="cust-kra" placeholder="e.g. A001234567Z" style="width: 100%; background: rgba(255,255,255,0.03); border: 1px solid var(--border-color); border-radius: 6px; padding: 8px 12px; color: #fff; font-size: 13px; outline: none; font-family: monospace;">
              </div>
              <div>
                <label style="display: block; font-size: 11px; color: var(--text-muted); text-transform: uppercase; margin-bottom: 6px;">BNPL Credit Limit (KES)</label>
                <input type="number" id="cust-limit" value="10000" min="0" style="width: 100%; background: rgba(255,255,255,0.03); border: 1px solid var(--border-color); border-radius: 6px; padding: 8px 12px; color: #fff; font-size: 13px; outline: none; text-align: center;">
              </div>
              
              <button type="submit" style="background: var(--accent-cyan); color: #000; border: none; padding: 10px; border-radius: 6px; font-size: 13px; font-weight: 800; cursor: pointer; transition: all 0.2s; margin-top: 6px;">
                💾 Register Customer Profile
              </button>
            </form>
          </div>

        </div>

      </div>

    `;
  }

  async loadCustomers() {
    if (this.disposed || !state.currentTenant) return;

    try {
      const customers = await db.customers.where('tenant_id').equals(state.currentTenant.id).toArray();
      const tbody = document.getElementById('customers-registry-body');
      if (this.disposed || !tbody || !this.container.contains(tbody)) return;

      if (customers.length === 0) {
        tbody.innerHTML = `
          <tr>
            <td colspan="6" style="text-align:center;color:var(--text-muted);padding:24px;">No customer profiles registered.</td>
          </tr>
        `;
        return;
      }

      const fragment = document.createDocumentFragment();
      customers.forEach(cust => {
        const limit = cust.credit_limit || 0;
        const points = cust.loyalty_points || 0;

        const tr = document.createElement('tr');
        tr.style.borderBottom = '1px solid rgba(255,255,255,0.04)';
        tr.innerHTML = `
          <td style="padding:10px 8px;font-weight:600;color:#fff;">${cust.name}</td>
          <td style="padding:10px 8px;font-family:monospace;">${cust.phone}</td>
          <td style="padding:10px 8px;color:var(--accent-amber);font-weight:700;">★ ${points} pts</td>
          <td style="padding:10px 8px;">${unpaidBillsLink(cust)}</td>
          <td style="padding:10px 8px;color:var(--text-secondary);">
            KES ${limit.toLocaleString(undefined, {minimumFractionDigits: 2})}
          </td>
          <td style="padding:10px 8px;text-align:right;white-space:nowrap;">
            ${this.canDelete && cust.id !== WALK_IN_CUSTOMER_ID ? `
              <button class="btn-remove-customer" data-cust-id="${cust.id}" data-cust-name="${cust.name}" title="Remove from the directory" style="background:transparent;color:var(--accent-rose);border:1px solid var(--accent-rose);padding:5px 10px;border-radius:4px;font-size:11px;font-weight:700;cursor:pointer;margin-left:6px;">
                Remove
              </button>
            ` : ''}
          </td>
        `;
        fragment.appendChild(tr);
      });
      tbody.replaceChildren(fragment);

      tbody.querySelectorAll('.btn-remove-customer').forEach(btn => {
        btn.addEventListener('click', async () => {
          const name = btn.getAttribute('data-cust-name');
          // Their sales keep pointing at them; only the directory loses them.
          if (!window.confirm(`Remove ${name} from the customer directory? Their past sales keep their name.`)) return;
          btn.disabled = true;
          try {
            await deleteCustomer(btn.getAttribute('data-cust-id'));
            showNotification(`${name} removed from the directory.`, 'success');
            await this.loadCustomers();
          } catch (err) {
            showNotification(err.message || 'That customer could not be removed.', 'error');
            btn.disabled = false;
          }
        });
      });

    } catch (err) {
      console.error(err);
    }
  }

  bindEvents() {
    const regForm = document.getElementById('customer-reg-form');
    if (regForm) {
      regForm.addEventListener('submit', async (e) => {
        e.preventDefault();

        const name = document.getElementById('cust-name').value.trim();
        const phone = document.getElementById('cust-phone').value.trim();
        const kra = document.getElementById('cust-kra').value.trim();
        const limit = parseFloat(document.getElementById('cust-limit').value) || 0;

        const button = regForm.querySelector('button[type="submit"]');
        button.disabled = true;
        try {
          // Server first. A customer only this device knows about is one every
          // sale booked against them is rejected for.
          const saved = await saveCustomer({
            name,
            phone,
            kraPin: kra,
            creditLimitMinor: Math.round(limit * 100)
          });

          await logAuditEvent(state.currentTenant.id, state.currentUser.id, 'CREATE_CUSTOMER', 'CUSTOMER', saved.id);
          showNotification(`${saved.name} is registered and can now be attached to a sale.`, 'success');

          regForm.reset();
          await this.loadCustomers();
        } catch (err) {
          showNotification('Failed to create customer: ' + err.message, 'error');
        } finally {
          button.disabled = false;
        }
      });
    }
  }
}
