/**
 * Does enabling a tender actually save?
 *
 * Runs the real client SDK against the real firestore.rules in the emulator,
 * making exactly the write saveAcceptedMethods makes. The owner reported
 * ticking Bank transfer and still being refused, so the question is whether
 * the rules accept that write at all - and for which shapes of the settings
 * document they do not.
 */
import { readFileSync } from 'node:fs';
import { initializeApp } from 'firebase/app';
import { getAuth, connectAuthEmulator, signInWithCustomToken } from 'firebase/auth';
import {
  initializeFirestore, connectFirestoreEmulator, doc, runTransaction, serverTimestamp, getDoc,
  terminate,
} from 'firebase/firestore';

const { tokens } = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const app = initializeApp({ apiKey: 'fake', projectId: 'vanbransa-pos', appId: '1:1:web:1' });
const auth = getAuth(app);
connectAuthEmulator(auth, 'http://127.0.0.1:9399', { disableWarnings: true });
// Node's gRPC transport hangs against the emulator; long polling is what the
// browser uses here anyway, so this stays faithful to the real client.
const db = initializeFirestore(app, { experimentalForceLongPolling: true });
connectFirestoreEmulator(db, '127.0.0.1', 8380);

const TENDERS = ['mpesa', 'bank_transfer', 'card', 'airtel_money'];
const problems = [];

/** Exactly what services/payment-settings.js saveAcceptedMethods does. */
async function enable(tenantId, wanted) {
  const ref = doc(db, 'tenant_settings', tenantId);
  await runTransaction(db, async (transaction) => {
    const snap = await transaction.get(ref);
    if (!snap.exists()) throw new Error('Business payment settings are unavailable.');
    const current = new Set(snap.data().acceptedPaymentMethods || []);
    for (const tender of TENDERS) {
      if (wanted.includes(tender)) current.add(tender); else current.delete(tender);
    }
    if (!current.size) throw new Error('Leave at least one payment method enabled.');
    transaction.update(ref, {
      acceptedPaymentMethods: [...current],
      updatedAt: serverTimestamp(), updatedByStaffId: 'user-owner',
    });
  });
}

for (const [tenantId, label] of [
  ['t-complete', 'a complete settings document'],
  ['t-credit', 'a list that already contains "credit"'],
  ['t-sparse', 'a document missing receiptFooter/locale/timezone'],
]) {
  await signInWithCustomToken(auth, tokens[tenantId]);
  const before = (await getDoc(doc(db, 'tenant_settings', tenantId))).data().acceptedPaymentMethods;
  try {
    await enable(tenantId, ['mpesa', 'bank_transfer']);
    const after = (await getDoc(doc(db, 'tenant_settings', tenantId))).data().acceptedPaymentMethods;
    const ok = after.includes('bank_transfer');
    console.log(`   ${ok ? 'OK  ' : 'FAIL'} ${label}: ${JSON.stringify(before)} -> ${JSON.stringify(after)}`);
    if (!ok) problems.push(`${label}: saved but bank_transfer is missing`);
  } catch (error) {
    console.log(`   FAIL ${label}: REFUSED — ${error.message}`);
    problems.push(`${label}: ${error.message}`);
  }
}

console.log(problems.length
  ? `\n=== ${problems.length} SHAPE(S) CANNOT ENABLE A TENDER ===\n- ${problems.join('\n- ')}`
  : '\n=== every settings shape can enable a tender ===');
process.exitCode = problems.length ? 1 : 0;
await terminate(db);
