import { CACHE_TENANT_ID, selectCacheTenant, deviceForTenant, walkInForTenant } from './tenant-cache.js';
/**
 * Firebase client for the till.
 *
 * The till stays offline-first: Dexie remains the system of record for the UI,
 * and this module is only the transport that drains the local outbox to the
 * trusted backend. Every export degrades to a no-op when Firebase is not
 * configured, so the app keeps selling on a laptop with no project attached.
 */

import { roleLabel } from './roles.js';
import { staffCredential } from './staff-credential.js';

const cfg = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID
};

export const REGION = process.env.NEXT_PUBLIC_FIREBASE_REGION || 'europe-west1';
export const TENANT_ID = process.env.NEXT_PUBLIC_TENANT_ID || null;

/** True when enough config exists to reach a real project. */
export const firebaseConfigured = Boolean(cfg.apiKey && cfg.projectId && cfg.appId);

let bootPromise = null;

/**
 * Whether this page is being served from the machine running the emulators.
 *
 * The emulator flag is a build-time value, so a build made with it left on
 * shipped a till that pointed its sign-in at 127.0.0.1 and could only answer
 * `auth/network-request-failed`. A deployed till is never the emulator host, so
 * the origin decides this and the flag alone cannot take the counter down.
 */
export function servedLocally(hostname) {
  const host = hostname
    ?? (typeof window === 'undefined' ? '' : window.location.hostname);
  return host === 'localhost'
    || host === '127.0.0.1'
    || host === '[::1]'
    || host === '::1'
    || host.endsWith('.localhost');
}

/**
 * Loads the Firebase SDK on first use. Kept as a dynamic import so a till with
 * no Firebase config never pays the bundle cost.
 */
async function boot() {
  const [{ initializeApp, getApps }, auth, firestore, functions] = await Promise.all([
    import('firebase/app'),
    import('firebase/auth'),
    import('firebase/firestore'),
    import('firebase/functions')
  ]);

  const app = getApps().find((candidate) => candidate.name === '[DEFAULT]') || initializeApp(cfg);
  const authInstance = auth.getAuth(app);
  const dbInstance = firestore.getFirestore(app);
  const fnInstance = functions.getFunctions(app, REGION);

  if (process.env.NEXT_PUBLIC_USE_EMULATORS === '1' && servedLocally()) {
    auth.connectAuthEmulator(authInstance, 'http://127.0.0.1:9099', { disableWarnings: true });
    firestore.connectFirestoreEmulator(dbInstance, '127.0.0.1', 8080);
    functions.connectFunctionsEmulator(fnInstance, '127.0.0.1', 5001);
  }

  // Firebase identity can change in another tab. Tear down the old page rather
  // than let its in-flight requests populate a different business's cache.
  let hadIdentity = false;
  auth.onIdTokenChanged(authInstance, async (user) => {
    if (!user) {
      if (hadIdentity && typeof window !== 'undefined') window.location.reload();
      return;
    }
    hadIdentity = true;
    const token = await user.getIdTokenResult();
    if (token.claims.platform_admin === true && typeof window !== 'undefined') {
      window.location.replace('/platform/');
      return;
    }
    if (token.claims.tenant_id && selectCacheTenant(String(token.claims.tenant_id)) && typeof window !== 'undefined') {
      window.location.reload();
    }
  });

  return { app, auth, authInstance, firestore, dbInstance, functions, fnInstance };
}

export function getFirebase() {
  if (!firebaseConfigured) return null;
  if (!bootPromise) bootPromise = boot();
  return bootPromise;
}

export const DEVICE_ID = deviceForTenant(CACHE_TENANT_ID, process.env.NEXT_PUBLIC_DEVICE_ID || 'device-till-01');
export const WALK_IN_CUSTOMER_ID = walkInForTenant(CACHE_TENANT_ID);

/**
 * Signs a staff member in with the password they own.
 *
 * Firebase Authentication is the identity: the tenant, staff id and role ride
 * back as custom claims on the ID token, so nothing about who this person is or
 * what they may do is decided in the browser.
 */
export async function signIn(email, password) {
  const fb = await getFirebase();
  if (!fb) throw new Error('Firebase is not configured on this till.');

  const credential = await fb.auth.signInWithEmailAndPassword(
    fb.authInstance,
    String(email || '').trim(),
    staffCredential(password),
  );

  const token = await credential.user.getIdTokenResult();
  const claims = token.claims || {};
  if (claims.platform_admin === true) {
    return { platformAdmin: true, authUid: credential.user.uid, tenantId: null };
  }
  if (!claims.tenant_id || !claims.staff_id) {
    // An account with no claims can see nothing, so fail here with something
    // the cashier can act on rather than at the first empty screen.
    await fb.auth.signOut(fb.authInstance);
    throw new Error('This account is not linked to a business yet. Ask your manager.');
  }

  return {
    id: String(claims.staff_id),
    authUid: credential.user.uid,
    email: credential.user.email,
    name: credential.user.displayName || credential.user.email,
    role: roleLabel(claims.staff_role),
    tenantId: String(claims.tenant_id),
  };
}

/** Restores an existing session on reload, or null. */
export async function restoreSession() {
  const fb = await getFirebase();
  if (!fb) return null;

  const user = await new Promise((resolve) => {
    const stop = fb.auth.onAuthStateChanged(fb.authInstance, (next) => {
      stop();
      resolve(next);
    });
  });
  if (!user) return null;

  const token = await user.getIdTokenResult();
  const claims = token.claims || {};
  if (claims.platform_admin === true) {
    window.location.replace('/platform/');
    return new Promise(() => {});
  }
  if (!claims.tenant_id || !claims.staff_id) return null;

  return {
    id: String(claims.staff_id),
    authUid: user.uid,
    email: user.email,
    name: user.displayName || user.email,
    role: roleLabel(claims.staff_role),
    tenantId: String(claims.tenant_id),
  };
}

/**
 * Opens (or reuses) this staff member's shift on this device. createSale
 * refuses to run without one, so the outbox cannot drain until it exists.
 */
export async function openShift(branchId, deviceId = DEVICE_ID, openingFloatMinor = 0) {
  return callFunction('openShift', { branchId, deviceId, openingFloatMinor });
}

/** Current signed-in user's custom claims, or null. */
export async function currentClaims() {
  const fb = await getFirebase();
  if (!fb || !fb.authInstance.currentUser) return null;
  const token = await fb.authInstance.currentUser.getIdTokenResult();
  if (token.claims.tenant_id && token.claims.tenant_id !== CACHE_TENANT_ID) {
    throw new Error('Your business session changed. Reload this tab before continuing.');
  }
  return token.claims;
}

/**
 * True only when we hold a session the security rules will actually accept.
 * Sync uses this to decide whether draining the outbox is worth attempting.
 */
export async function hasTenantSession() {
  try {
    const claims = await currentClaims();
    return Boolean(claims && claims.tenant_id);
  } catch { return false; }
}

export async function signOutTill() {
  const fb = await getFirebase();
  if (fb && fb.authInstance.currentUser) await fb.auth.signOut(fb.authInstance);
}

/** Invokes a callable and returns its data payload. */
export async function callFunction(name, payload, options = {}) {
  const fb = await getFirebase();
  if (!fb) throw new Error('Firebase is not configured on this till.');
  const call = fb.functions.httpsCallable(fb.fnInstance, name, { timeout: options.timeout ?? (name === 'importStaff' ? 360000 : 70000) });
  const { data } = await call(payload);
  return data;
}
