import { state, showNotification } from '../context';
import { renderReceiptHtml } from '../services/print-receipt';
import {
  STATION_HEARTBEAT_MS,
  markJobPrinted,
  publishStationHeartbeat,
  subscribeQueuedJobs
} from '../services/print-queue';

/**
 * The counter print station.
 *
 * Tablets cannot reach a USB thermal printer, so they queue receipts and this
 * page prints them on the machine the printer is plugged into. It must be left
 * open on that machine; nothing else in the app prints a queued job.
 *
 * Printing is deliberately opt-in: the operator presses Start, which both makes
 * the intent explicit and guarantees a user gesture has happened before the
 * first window.print().
 */
export class PrintStationView {
  constructor(container) {
    this.container = container;
    this.running = false;
    this.busy = false;
    this.printed = 0;
    this.unsubscribe = null;
    this.heartbeat = null;
    this.pending = [];
  }

  get branchId() {
    return state.currentBranch?.id || null;
  }

  async load() {
    this.container.innerHTML = `
      <div class="content-header">
        <h1>Print Station</h1>
        <p class="muted">Queued receipts print on this machine's default printer.</p>
      </div>

      <div class="card" style="padding:16px; margin-bottom:16px;">
        <div style="display:flex; align-items:center; justify-content:space-between; gap:12px; flex-wrap:wrap;">
          <div>
            <div id="station-state" style="font-size:15px; font-weight:700;">Stopped</div>
            <div class="muted" style="font-size:12px;">
              Branch: ${state.currentBranch?.name || 'Not selected'} &middot; Printed this session:
              <span id="station-count">0</span>
            </div>
          </div>
          <button class="primary-btn" id="station-toggle">Start station</button>
        </div>
        <p class="muted" style="font-size:11px; margin-top:12px;">
          Set the thermal printer as this machine's <b>default</b> printer. To print without a
          dialog, open this page in a browser launched with <code>--kiosk-printing</code>.
        </p>
      </div>

      <div class="card" style="padding:16px;">
        <h3 style="margin:0 0 8px; font-size:13px;">Waiting</h3>
        <div id="station-queue" class="muted" style="font-size:12px;">Station stopped.</div>
      </div>

      <!-- Print surface. Only this is visible to the printer; see @media print. -->
      <div id="station-receipt-paper" class="receipt-paper-58" style="display:none;"></div>
    `;

    this.container.querySelector('#station-toggle')
      .addEventListener('click', () => (this.running ? this.stop() : this.start()));
  }

  async start() {
    if (!this.branchId) {
      showNotification('Select a branch before starting the print station.', 'error');
      return;
    }

    this.unsubscribe = await subscribeQueuedJobs(
      this.branchId,
      (jobs) => {
        this.pending = jobs;
        this.renderQueue();
        void this.drain();
      },
      () => showNotification('The print queue could not be read. Check the connection.', 'error')
    );

    if (!this.unsubscribe) {
      showNotification('No till session, so the print queue cannot be watched.', 'error');
      return;
    }

    this.running = true;
    await publishStationHeartbeat(this.branchId);
    this.heartbeat = setInterval(
      () => void publishStationHeartbeat(this.branchId),
      STATION_HEARTBEAT_MS
    );

    this.container.querySelector('#station-state').textContent = 'Running';
    this.container.querySelector('#station-toggle').textContent = 'Stop station';
    showNotification('Print station running. Leave this page open.', 'success');
  }

  stop() {
    this.running = false;
    if (this.unsubscribe) this.unsubscribe();
    this.unsubscribe = null;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;

    this.container.querySelector('#station-state').textContent = 'Stopped';
    this.container.querySelector('#station-toggle').textContent = 'Start station';
    this.container.querySelector('#station-queue').textContent = 'Station stopped.';
  }

  renderQueue() {
    const queue = this.container.querySelector('#station-queue');
    if (!queue) return;
    queue.textContent = this.pending.length === 0
      ? 'Nothing waiting.'
      : `${this.pending.length} receipt(s) waiting.`;
  }

  /**
   * Prints one job at a time. window.print() blocks until the dialog closes, so
   * overlapping calls would interleave two receipts onto one page.
   */
  async drain() {
    if (this.busy || !this.running) return;
    this.busy = true;

    try {
      while (this.running && this.pending.length > 0) {
        const job = this.pending.shift();
        const html = renderReceiptHtml(job?.receipt);
        if (!html) {
          // Unprintable payload: retire it rather than blocking the queue.
          await markJobPrinted(job.id);
          continue;
        }

        const paper = this.container.querySelector('#station-receipt-paper');
        paper.className = job.widthClass === 'receipt-paper-80'
          ? 'receipt-paper-80'
          : 'receipt-paper-58';
        paper.innerHTML = html;
        paper.style.display = 'block';

        try {
          window.print();
          // Only claimed once the print call returned, so a crashed station
          // leaves the job queued for the next one rather than losing it.
          await markJobPrinted(job.id);
          this.printed += 1;
          this.container.querySelector('#station-count').textContent = String(this.printed);
        } finally {
          paper.style.display = 'none';
        }

        this.renderQueue();
      }
    } finally {
      this.busy = false;
    }
  }
}
