/**
 * Pulls the tenant's staff roster from Firestore into Dexie.
 *
 * The user screen reads Dexie, and Dexie was only ever filled from the bundled
 * seed file - so an account created by createStaffUser, or thirty of them
 * created by importStaff, existed on the server and appeared nowhere in the
 * app. Firebase Auth remains the identity; this is a read cache of the roster.
 *
 * Only owners and store managers can read /staff, which is exactly who sees
 * this screen.
 */

import { downloadCsvTemplate } from './csv.js';
import { roleLabel } from './roles.js';

/** Firestore's staff document -> the row shape the user screen reads. */
export function toLocalUser(doc) {
  return {
    id: doc.id,
    tenant_id: doc.tenantId,
    name: doc.name || doc.email || doc.id,
    phone: doc.phone || '',
    email: doc.email || '',
    // The screens filter on the uppercase form; the backend stores lowercase.
    status: String(doc.status || 'active').toUpperCase(),
    role: roleLabel(doc.role) || 'Cashier'
  };
}

/**
 * Replaces the local roster with the tenant's server staff.
 * Returns the number of people written, or null when there is no backend.
 */
export async function pullStaff() {
  const { getFirebase, currentClaims } = await import('./firebase.js');
  const TENANT_ID = (await currentClaims())?.tenant_id;
  const fb = await getFirebase();
  if (!fb || !TENANT_ID) return null;

  const { db } = await import('../db/schema');
  let snapshot;
  try {
    snapshot = await fb.firestore.getDocs(
      fb.firestore.query(
        fb.firestore.collection(fb.dbInstance, 'staff'),
        fb.firestore.where('tenantId', '==', TENANT_ID)
      )
    );
  } catch {
    // Not a manager: the roster is closed, but "billed by" still needs names.
    // Only ids missing here are added, so a full row is never overwritten.
    const { callFunction } = await import('./firebase.js');
    const { staff = [] } = (await callFunction('listStaffNames', {})) || {};
    const known = new Set((await db.users.toArray()).map((row) => row.id));
    const missing = staff.filter((row) => !known.has(row.id))
      .map((row) => ({ id: row.id, tenant_id: TENANT_ID, name: row.name, status: 'NAME_ONLY' }));
    if (missing.length) await db.users.bulkPut(missing);
    return staff.length;
  }

  const users = snapshot.docs.map((entry) => toLocalUser({ id: entry.id, ...entry.data() }));
  // bulkPut so a re-pull updates roles in place and overwrites seeded rows with
  // the authoritative copy, rather than duplicating either.
  if (users.length) await db.users.bulkPut(users);

  return users.length;
}

/** Header row and one worked example, so the file explains its own columns. */
export const STAFF_TEMPLATE_CSV = [
  'Name,Email,Access Level,Password,Phone',
  'Wanjiku Kamau,wanjiku@yourbusiness.pos,Cashier,changeme123,0712345678',
  'Mwangi Njoroge,mwangi@yourbusiness.pos,Cashier,changeme456,0722345678'
].join('\r\n');

/** Hands the operator a file to fill in. */
export function downloadStaffTemplate(filename = 'staff-import-template.csv') {
  downloadCsvTemplate(STAFF_TEMPLATE_CSV, filename);
}
