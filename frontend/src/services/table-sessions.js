import { tabKey } from './tabs.js';

/**
 * The server's tabs (table_sessions) are what is open whenever this device is
 * online. Each device used to decide open/owed/paid from its own copy, which
 * is how a paid table never freed up and a tablet could not add to another
 * till's tab (26 Nov 2026).
 *
 * `local` is readOpenTabs' own view; `sessions` the open server sessions for
 * the branch, or null when they are unknown (offline, signed out, not loaded).
 * - Unknown: the local view stands, as before.
 * - A local tab the server has open takes the server's amount due, plus
 *   anything still waiting to upload from here.
 * - A local tab the server does not have open is kept only while it holds a
 *   round not yet uploaded; otherwise it was paid or voided elsewhere.
 * - A server tab this device has never seen is listed so it can be added to,
 *   including when this device still holds an older tab for that table (paid
 *   or released elsewhere): the server's current tab replaces it.
 */
export function withServerSessions(local, sessions) {
  if (!sessions) return local;
  const key = (branchId, table) => `${branchId || ''}:${tabKey(table)}`;
  const open = new Map(sessions.filter(s => s.status === 'OPEN')
    .map(s => [key(s.branchId, s.tableNumber), s]));
  const seen = new Set();
  const tabs = [];
  for (const tab of local) {
    const k = key(tab.branch_id, tab.table);
    const session = open.get(k);
    if (!session) {
      // Still uploading from here, or being opened right now (no round yet).
      if (tab.pendingUploadMinor > 0 || !tab.rounds?.length) tabs.push(tab);
      continue;
    }
    // The table's server tab is another one: this copy was paid or released
    // elsewhere and not yet pulled. The server's tab is listed instead, below.
    if (session.tabId && session.tabId !== tab.id && !(tab.pendingUploadMinor > 0)) continue;
    seen.add(k);
    tabs.push({ ...tab, serverTabId: session.tabId,
      dueMinor: Number(session.dueMinor || 0) + Number(tab.pendingUploadMinor || 0) });
  }
  for (const [k, s] of open) {
    if (seen.has(k)) continue;
    tabs.push({
      id: s.tabId, status: 'OPEN', branch_id: s.branchId, table_no: s.tableNumber, table: s.tableNumber,
      order_no: s.orderReference || '', opened_at: asIso(s.openedAt), opened_by: null,
      dueMinor: Number(s.dueMinor || 0), items: 0, unpaidRounds: [],
      rounds: (s.roundSaleIds || []).map(id => ({ id, lines: [], paymentStatus: 'unpaid' })),
      // No header on this device yet; the till re-creates it on Add round.
      readOnly: true, recoveryRequired: true, serverTabId: s.tabId,
    });
  }
  return tabs.sort((a, b) => new Date(a.opened_at || 0).getTime() - new Date(b.opened_at || 0).getTime());
}

function asIso(value) {
  if (!value) return null;
  if (typeof value.toDate === 'function') return value.toDate().toISOString();
  const date = new Date(value?.seconds ? value.seconds * 1000 : value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

let latest = null;
let watching = null;

/**
 * Live open sessions for the signed-in business, or null while unknown. Starts
 * one listener on first use; each change fires `pos:tables-updated` so the
 * till and Tab Management redraw. Cached (offline) snapshots count as unknown:
 * offline, this device's own view is the better guess.
 */
export async function serverTableSessions() {
  if (!watching) watching = watch().catch(() => { watching = null; });
  await watching;
  return latest;
}

async function watch() {
  const { getFirebase } = await import('./firebase.js');
  const { activeTenantId } = await import('./catalogue.js');
  const fb = await getFirebase();
  const tenantId = fb && await activeTenantId();
  if (!fb || !tenantId) throw new Error('not signed in');
  await new Promise((resolve) => {
    fb.firestore.onSnapshot(fb.firestore.query(
      fb.firestore.collection(fb.dbInstance, 'table_sessions'),
      fb.firestore.where('tenantId', '==', tenantId),
      fb.firestore.where('status', '==', 'OPEN'),
    ), { includeMetadataChanges: true }, (snapshot) => {
      latest = snapshot.metadata.fromCache ? null : snapshot.docs.map(doc => doc.data());
      if (typeof window !== 'undefined') window.dispatchEvent(new Event('pos:tables-updated'));
      resolve();
    }, () => { latest = null; watching = null; resolve(); });
  });
}
