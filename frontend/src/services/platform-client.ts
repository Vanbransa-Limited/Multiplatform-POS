import { getApps, initializeApp } from 'firebase/app';
import { connectAuthEmulator, getAuth } from 'firebase/auth';
import { connectFunctionsEmulator, getFunctions } from 'firebase/functions';

// Both destinations share the central Firebase login. Claims and server checks
// decide which workspace the authenticated account may enter.
let connection: ReturnType<typeof connect> | undefined;
function connect() {
  const app = getApps().find(app => app.name === '[DEFAULT]') ?? initializeApp({
    apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
    authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
    projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
    appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
    storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
    messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  });
  const auth = getAuth(app);
  const functions = getFunctions(app, process.env.NEXT_PUBLIC_FIREBASE_REGION || 'europe-west1');
  if (process.env.NEXT_PUBLIC_USE_EMULATORS === '1' && ['localhost', '127.0.0.1', '[::1]'].includes(window.location.hostname)) {
    connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
    connectFunctionsEmulator(functions, '127.0.0.1', 5001);
  }
  const ready = auth.authStateReady();
  return { auth, functions, ready };
}
export function platformClient() {
  connection ??= connect();
  return connection;
}
