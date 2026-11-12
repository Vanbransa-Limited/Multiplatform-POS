import { state, showNotification, ACTIVITY_EVENT } from '../context';
import { renderReceiptHtml, escapeHtml } from '../services/print-receipt';
import {
  STATION_HEARTBEAT_MS,
  markJobPrinted,
  publishStationHeartbeat,
  subscribeQueuedJobs
} from '../services/print-queue';

/** Backoff between reconnect attempts after the queue listener drops. */
const RETRY_MS = [2_000, 4_000, 8_000, 15_000, 30_000];

/** A job that fails to print this many times stops blocking the ones behind it. */
const MAX_ATTEMPTS = 3;

/**
 * The counter print station.
 *
 * Tablets cannot reach a USB thermal printer, so they queue receipts and this
 * page prints them on the machine the printer is plugged into.
 *
 * The hard part is not printing, it is staying up. A Firestore listener is
 * terminated by its first error and does not come back on its own, so the
 * station used to sit there saying "Running" while receiving nothing. Every
 * drop is now reconnected with backoff, the header shows the real state rather
 * than the intended one, and any queued job can be printed by hand so a bad
 * night never leaves a cashier with no way to produce paper.
 */
export class PrintStationView {
  constructor(container) {
    this.container = container;
    this.running = false;
    this.busy = false;
    this.printed = 0;
    this.unsubscribe = null;
    this.heartbeat = null;
    this.retry = null;
    this.retries = 0;
    this.pending = [];
    // Ids handed to the printer but not yet confirmed. A snapshot that lands
    // mid-print still lists them as queued, and without this they print twice.
    this.claimed = new Set();
    this.attempts = new Map();
    this.events = [];
    this.search = '';
    this.disposed = false;
    this.onVisible = () => {
      if (document.visibilityState !== 'visible' || this.disposed) return;
      if (this.running) void this.beat();
      // A backgrounded tab may have had its listener dropped and its retry
      // timer throttled; coming back to the foreground rechecks both. The
      // queue is watched whether or not this station is printing.
      if (!this.unsubscribe) void this.connect();
    };
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
              Branch: ${escapeHtml(state.currentBranch?.name || 'Not selected')} &middot; Printed this session:
              <span id="station-count">0</span>
            </div>
          </div>
          <button class="primary-btn" id="station-toggle">Start station</button>
        </div>
        <p class="muted" style="font-size:11px; margin-top:12px;">
          Set the thermal printer as this machine's <b>default</b> printer. To print without a
          dialog, open this page in a browser launched with <code>--kiosk-printing</code>.
          Leave this page in the foreground: a background tab is throttled by the browser.
        </p>
      </div>

      <div class="card" style="padding:16px; margin-bottom:16px;">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:8px;">
          <h3 style="margin:0; font-size:13px;">Waiting <span id="station-waiting-count" class="muted"></span></h3>
          <button type="button" class="co-print" id="station-test">Test print</button>
        </div>
        <p class="muted" style="font-size:11px;margin:0 0 8px;">
          Every receipt this branch queues lands here, whoever sent it and from whatever device.
        </p>
        <!-- One queue for the whole branch means finding one order in it needs
             a search, not a scroll: the runner knows the table, not the job id. -->
        <div class="co-toolbar" style="padding:0 0 12px;">
          <input id="station-search" class="co-search" type="search" placeholder="Search invoice, order, table, customer, item or who sent it…" aria-label="Search queued print jobs">
        </div>
        <div id="station-queue" class="muted" style="font-size:12px;">Connecting to the queue…</div>
      </div>

      <!-- Every step is recorded here. Without it a station that prints nothing
           gives no clue whether jobs never arrived or the printer never fired. -->
      <div class="card" style="padding:16px;">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:8px;">
          <h3 style="margin:0; font-size:13px;">Activity log</h3>
          <button type="button" class="co-print" id="station-copy-log">Copy log</button>
        </div>
        <pre id="station-log" style="margin:0;max-height:240px;overflow:auto;font-size:11px;line-height:1.6;color:var(--text-secondary);white-space:pre-wrap;word-break:break-word;">Nothing yet.</pre>
      </div>

      <!-- Print surface. Only this is visible to the printer; see @media print. -->
      <div id="station-receipt-paper" class="receipt-paper-58" style="display:none;"></div>
    `;

    this.container.querySelector('#station-toggle')
      .addEventListener('click', () => (this.running ? this.stop() : this.start()));

    // Any queued job can be forced through by hand, station running or not.
    this.container.querySelector('#station-queue').addEventListener('click', (event) => {
      const button = event.target.closest('[data-print-job]');
      if (button) void this.printOne(this.pending.find((job) => job.id === button.dataset.printJob), true);
    });

    // Proves the printer end of the chain on its own, with no Firestore in the
    // way: if this prints and queued jobs do not, the queue is the problem.
    this.container.querySelector('#station-test').addEventListener('click', () => {
      this.log('Test print requested.');
      void this.printOne({
        id: `test-${Date.now()}`,
        widthClass: 'receipt-paper-58',
        test: true,
        receipt: {
          tenantName: state.currentTenant?.trading_name || 'Test print',
          branchName: state.currentBranch?.name || '',
          invoiceNo: 'TEST-PRINT',
          soldAt: new Date().toLocaleString(),
          cashierName: state.currentUser?.name || '',
          customerName: 'Printer test',
          lines: [{ name: 'Printer test line', qty: 1, unitPrice: 0, lineTotal: 0 }],
          subtotal: 0, taxTotal: 0, grandTotal: 0, paymentMethod: 'NONE',
        },
      }, true);
    });

    this.container.querySelector('#station-copy-log').addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(this.events.join('\n'));
        showNotification('Activity log copied.', 'success');
      } catch {
        showNotification('Could not copy. Select the log text and copy it by hand.', 'warning');
      }
    });

    this.container.querySelector('#station-search').addEventListener('input', (event) => {
      this.search = event.target.value;
      this.renderQueue();
    });

    document.addEventListener('visibilitychange', this.onVisible);
    this.log(`Station opened. Branch: ${state.currentBranch?.name || 'none selected'}.`);

    // Watching is not printing. The queue is listed as soon as this screen
    // opens so somebody can walk up to the counter machine and print what is
    // waiting; starting the station is what makes it print by itself.
    await this.connect();
  }

  /** Timestamped record of what the station actually did. */
  log(text) {
    this.events.push(`${new Date().toLocaleTimeString()}  ${text}`);
    if (this.events.length > 200) this.events.shift();
    const panel = this.container.querySelector('#station-log');
    if (panel) {
      panel.textContent = this.events.slice(-40).join('\n');
      panel.scrollTop = panel.scrollHeight;
    }
  }

  say(text) {
    const state_ = this.container.querySelector('#station-state');
    if (state_) state_.textContent = text;
  }

  async start() {
    if (!this.branchId) {
      showNotification('Select a branch before starting the print station.', 'error');
      return;
    }
    this.running = true;
    this.retries = 0;
    this.log('Station started.');
    this.container.querySelector('#station-toggle').textContent = 'Stop station';

    await this.beat();
    this.heartbeat = setInterval(() => void this.beat(), STATION_HEARTBEAT_MS);
    await this.connect();
  }

  /**
   * Publishes presence and holds the session open.
   *
   * The idle timer signs a session out after fifteen minutes without a
   * pointer or key event, and nobody touches the station on purpose - it used
   * to sign itself out mid-service and take the printer with it. A running
   * station is real work, so it says so on every beat.
   *
   * A failed beat is reported rather than swallowed: silent failure here is
   * what makes the till tell cashiers there is no printer.
   */
  async beat() {
    if (!this.running) return;
    window.dispatchEvent(new Event(ACTIVITY_EVENT));
    try {
      const published = await publishStationHeartbeat(this.branchId);
      if (!published) {
        this.log('Presence not published — no session or no branch. The till will report no station.');
        this.say('Running — but presence could not be published; the till may not see this station.');
      }
      else if (this.unsubscribe) this.say('Running');
    } catch (error) {
      this.log(`Presence failed: ${error?.code || ''} ${error?.message || error}`.trim());
      this.say(`Running — presence failed: ${error.message || 'unknown error'}`);
    }
  }

  /**
   * Attaches the queue listener, and reattaches it after a drop.
   *
   * onSnapshot delivers one error and then stops for good, so treating an error
   * as a notification and nothing else is what left the station deaf.
   */
  async connect() {
    if (this.disposed || !this.branchId) return;
    clearTimeout(this.retry);
    this.retry = null;

    try {
      this.unsubscribe = await subscribeQueuedJobs(
        this.branchId,
        (jobs) => {
          this.retries = 0;
          this.log(`Queue update: ${jobs.length} job(s) waiting.`);
          this.pending = jobs;
          this.renderQueue();
          if (this.running) this.say('Running');
          void this.drain();
        },
        (error) => this.reconnect(`queue listener error: ${error?.code || ''} ${error?.message || error}`.trim()),
      );
    } catch (error) {
      this.unsubscribe = null;
      this.log(`Could not attach the queue listener: ${error?.code || ''} ${error?.message || error}`.trim());
    }

    if (!this.unsubscribe) {
      this.reconnect('no till session, so the queue cannot be watched');
      return;
    }
    this.log('Queue listener attached.');
    if (this.running) this.say('Running');
  }

  reconnect(why) {
    if (this.disposed) return;
    if (this.unsubscribe) { this.unsubscribe(); this.unsubscribe = null; }
    const wait = RETRY_MS[Math.min(this.retries, RETRY_MS.length - 1)];
    this.retries += 1;
    this.log(`Reconnecting in ${wait / 1000}s — ${why}`);
    if (this.running) this.say(`Reconnecting… (${why})`);
    clearTimeout(this.retry);
    this.retry = setTimeout(() => void this.connect(), wait);
  }

  /**
   * Stops printing. The queue listener stays attached, because the list of
   * what is waiting is the reason somebody walks over to this machine.
   */
  stop() {
    this.running = false;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;

    this.log('Station stopped. Still listing the queue; nothing prints by itself.');
    this.say('Stopped');
    const toggle = this.container.querySelector('#station-toggle');
    if (toggle) toggle.textContent = 'Start station';
    this.renderQueue();
  }

  dispose() {
    this.disposed = true;
    this.stop();
    if (this.unsubscribe) this.unsubscribe();
    this.unsubscribe = null;
    clearTimeout(this.retry);
    this.retry = null;
    document.removeEventListener('visibilitychange', this.onVisible);
  }

  /** What a job is called on paper: an invoice number, or an order reference. */
  jobTitle(job) {
    return job.receipt?.invoiceNo || job.receipt?.ref || job.id;
  }

  /**
   * Everything about a job somebody might type looking for it.
   *
   * A runner holding a table number does not know the invoice, and whoever
   * queued it is on another device entirely, so all of it is searchable.
   */
  jobHaystack(job) {
    const receipt = job.receipt || {};
    return [
      this.jobTitle(job),
      receipt.customerName,
      receipt.tableNo,
      receipt.tableNumber,
      receipt.cashierName,
      receipt.paymentMethod,
      receipt.paymentReference,
      ...(Array.isArray(receipt.lines) ? receipt.lines.map((line) => line?.name) : []),
    ].filter(Boolean).join(' ').toLowerCase();
  }

  /** One line of who and what, so the right paper is picked without opening it. */
  jobSubtitle(job) {
    const receipt = job.receipt || {};
    const when = job.createdAt?.toDate?.();
    const table = receipt.tableNo || receipt.tableNumber;
    return [
      receipt.kind === 'kitchen' ? 'Kitchen ticket' : null,
      table ? `Table ${table}` : null,
      receipt.customerName,
      receipt.grandTotal === undefined ? null : `KES ${Number(receipt.grandTotal).toFixed(2)}`,
      receipt.unpaid ? 'UNPAID — proforma' : null,
      receipt.cashierName ? `sent by ${receipt.cashierName}` : null,
      when ? when.toLocaleTimeString() : null,
    ].filter(Boolean).join(' · ');
  }

  renderQueue() {
    const queue = this.container.querySelector('#station-queue');
    if (!queue) return;

    const needle = this.search.trim().toLowerCase();
    const shown = needle
      ? this.pending.filter((job) => this.jobHaystack(job).includes(needle))
      : this.pending;

    const count = this.container.querySelector('#station-waiting-count');
    if (count) {
      count.textContent = needle && this.pending.length
        ? `(${shown.length} of ${this.pending.length})`
        : this.pending.length ? `(${this.pending.length})` : '';
    }

    if (shown.length === 0) {
      queue.textContent = this.pending.length
        ? `Nothing waiting matches “${this.search.trim()}”.`
        : 'Nothing waiting.';
      return;
    }

    queue.innerHTML = shown.map((job) => {
      const failed = (this.attempts.get(job.id) || 0) >= MAX_ATTEMPTS;
      return `<div style="display:flex;align-items:center;gap:10px;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--border-color)">
        <span>
          <b>${escapeHtml(this.jobTitle(job))}</b>${failed ? ' — failed, needs a hand' : ''}
          <span style="display:block;color:var(--text-secondary);font-size:11px;">${escapeHtml(this.jobSubtitle(job))}</span>
        </span>
        <button type="button" class="co-print" data-print-job="${escapeHtml(job.id)}">Print now</button>
      </div>`;
    }).join('');
  }

  /**
   * Prints one job.
   *
   * The job is claimed before the dialog opens and released only on failure, so
   * a snapshot arriving mid-print cannot queue the same receipt twice. A job
   * that keeps failing is left in place but stops being retried automatically,
   * because a poison payload retried forever blocks every receipt behind it.
   */
  async printOne(job, manual = false) {
    if (!job || this.claimed.has(job.id)) return false;
    const html = renderReceiptHtml(job.receipt);
    if (!html) {
      // Unprintable payload: retire it rather than blocking the queue. Logged
      // loudly, because silently retiring a job looks exactly like printing it.
      this.log(`Job ${job.id} has no printable receipt; retiring it unprinted.`);
      await markJobPrinted(job.id).catch(() => {});
      return true;
    }

    this.claimed.add(job.id);
    const paper = this.container.querySelector('#station-receipt-paper');
    paper.className = job.widthClass === 'receipt-paper-80' ? 'receipt-paper-80' : 'receipt-paper-58';
    paper.innerHTML = html;
    paper.style.display = 'block';

    try {
      this.log(`Printing ${job.id} (${html.length} chars). Opening the browser print dialog…`);
      window.print();
      this.log(`Print dialog returned for ${job.id}.`);
      if (job.test) return true;
      // Claimed only once the print call returned, so a crashed station leaves
      // the job queued for the next one rather than losing it.
      await markJobPrinted(job.id);
      this.log(`Marked ${job.id} printed.`);
      this.printed += 1;
      this.attempts.delete(job.id);
      const count = this.container.querySelector('#station-count');
      if (count) count.textContent = String(this.printed);
      return true;
    } catch (error) {
      // Releasing the claim lets it be retried; the attempt count stops that
      // becoming an endless reprint loop on a job the server keeps refusing.
      this.claimed.delete(job.id);
      this.attempts.set(job.id, (this.attempts.get(job.id) || 0) + 1);
      this.log(`FAILED ${job.id}: ${error?.code || ''} ${error?.message || error}`.trim());
      showNotification(
        manual ? `That receipt did not print: ${error.message || 'unknown error'}` : 'A receipt could not be marked printed. It stays in the queue.',
        'error',
      );
      return false;
    } finally {
      paper.style.display = 'none';
      // window.print() blocks the thread the heartbeat runs on, so presence is
      // republished the moment it returns rather than waiting for the interval.
      if (this.running) void this.beat();
      this.renderQueue();
    }
  }

  /** Prints waiting jobs one at a time; overlapping calls interleave receipts. */
  async drain() {
    if (this.busy || !this.running) return;
    this.busy = true;
    try {
      for (const job of [...this.pending]) {
        if (!this.running) break;
        if (this.claimed.has(job.id)) continue;
        if ((this.attempts.get(job.id) || 0) >= MAX_ATTEMPTS) continue;
        await this.printOne(job);
      }
    } finally {
      this.busy = false;
    }
  }
}
