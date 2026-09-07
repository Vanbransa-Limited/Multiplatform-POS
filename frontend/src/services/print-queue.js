/**
 * Counter print queue.
 *
 * A tablet cannot reach a USB thermal printer, so the selling device queues the
 * receipt and a station page at the counter prints it. The job carries the
 * receipt's own values because sales are pushed to the backend but never pulled
 * back down: the station has no local copy of another device's sale.
 *
 * The station is the only thing that prints. If no station is online the jobs
 * simply wait, which is why the till asks for station presence before it
 * promises a cashier that paper is coming.
 */

import { DEVICE_ID, currentClaims, getFirebase } from './firebase.js';

const JOBS = 'print_jobs';
const STATIONS = 'print_stations';

/**
 * A station republishes presence well inside this, so a gap means it is gone.
 *
 * The margin is wide on purpose. The heartbeat is a timer on the same thread as
 * `window.print()`, which blocks until the operator closes the dialog, and a
 * browser throttles timers hard in a background tab. At a 3x margin an open
 * print dialog or a station left in a background tab read as dead within a
 * minute, and the till started telling cashiers there was no printer.
 */
export const STATION_STALE_MS = 180_000;
export const STATION_HEARTBEAT_MS = 20_000;

/** Nothing queues without a tenant and a branch; a job with neither is unroutable. */
async function scope(branchId) {
  const claims = await currentClaims();
  if (!claims || !claims.tenant_id) return null;
  if (typeof branchId !== 'string' || !branchId) return null;
  return { tenantId: claims.tenant_id, staffId: claims.staff_id || null, branchId };
}

/**
 * Queues one receipt for the counter. Returns the job id, or null when the
 * till has no session or no branch - the caller must not claim it printed.
 */
export async function enqueuePrintJob({ branchId, receipt, widthClass = 'receipt-paper-58' }) {
  const fb = await getFirebase();
  const where = await scope(branchId);
  if (!fb || !where || !receipt) return null;

  const reference = fb.firestore.doc(fb.firestore.collection(fb.dbInstance, JOBS));
  await fb.firestore.setDoc(reference, {
    id: reference.id,
    tenantId: where.tenantId,
    branchId: where.branchId,
    receipt,
    // 58mm is the roll in use; only an explicit 80mm choice widens the job.
    widthClass: widthClass === 'receipt-paper-80' ? 'receipt-paper-80' : 'receipt-paper-58',
    status: 'queued',
    createdAt: fb.firestore.serverTimestamp(),
    createdByStaffId: where.staffId,
    createdByDeviceId: DEVICE_ID
  });

  return reference.id;
}

/**
 * Watches this branch's queue. Returns an unsubscribe function, or null when
 * there is no session to watch with.
 */
export async function subscribeQueuedJobs(branchId, onJobs, onError) {
  const fb = await getFirebase();
  const where = await scope(branchId);
  if (!fb || !where) return null;

  const q = fb.firestore.query(
    fb.firestore.collection(fb.dbInstance, JOBS),
    fb.firestore.where('tenantId', '==', where.tenantId),
    fb.firestore.where('branchId', '==', where.branchId),
    fb.firestore.where('status', '==', 'queued')
  );

  return fb.firestore.onSnapshot(
    q,
    (snapshot) => {
      // Ordered here rather than in the query so the queue needs no composite
      // index to start working on a fresh project.
      const jobs = snapshot.docs
        .map((entry) => ({ ...entry.data(), id: entry.id }))
        .sort((a, b) => (a.createdAt?.seconds ?? 0) - (b.createdAt?.seconds ?? 0));
      onJobs(jobs);
    },
    (error) => {
      if (onError) onError(error);
    }
  );
}

/** Claims a job so a second station cannot print the same receipt. */
export async function markJobPrinted(jobId) {
  const fb = await getFirebase();
  if (!fb || !jobId) return false;
  await fb.firestore.updateDoc(fb.firestore.doc(fb.dbInstance, JOBS, jobId), {
    status: 'printed',
    printedAt: fb.firestore.serverTimestamp(),
    printedByDeviceId: DEVICE_ID
  });
  return true;
}

/** Announces that this device is at the counter with a printer attached. */
export async function publishStationHeartbeat(branchId) {
  const fb = await getFirebase();
  const where = await scope(branchId);
  if (!fb || !where) return false;
  await fb.firestore.setDoc(
    fb.firestore.doc(fb.dbInstance, STATIONS, DEVICE_ID),
    {
      deviceId: DEVICE_ID,
      tenantId: where.tenantId,
      branchId: where.branchId,
      lastSeenAt: fb.firestore.serverTimestamp()
    },
    { merge: true }
  );
  return true;
}

/**
 * True when a station on this branch has checked in recently.
 *
 * Asked at the moment a receipt is queued rather than watched continuously: a
 * queued job with no station waits silently forever, so the cashier has to be
 * told to walk to the counter instead of waiting for paper.
 */
export async function isStationOnline(branchId) {
  const fb = await getFirebase();
  const where = await scope(branchId);
  if (!fb || !where) return false;

  const snapshot = await fb.firestore.getDocs(fb.firestore.query(
    fb.firestore.collection(fb.dbInstance, STATIONS),
    fb.firestore.where('tenantId', '==', where.tenantId),
    fb.firestore.where('branchId', '==', where.branchId)
  ));

  const now = Date.now();
  return snapshot.docs.some((entry) => {
    const seen = entry.data()?.lastSeenAt;
    const millis = typeof seen?.toMillis === 'function' ? seen.toMillis() : 0;
    return millis > 0 && now - millis < STATION_STALE_MS;
  });
}
