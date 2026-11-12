/** One-time, create-only platform login. Never adopts an existing identity. */
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
const require = createRequire(new URL('../backend/functions/package.json', import.meta.url));
const { initializeApp, applicationDefault } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');

function arg(name) { const index = process.argv.indexOf(`--${name}`); return index < 0 ? undefined : process.argv[index + 1]; }
const project = arg('project');
const email = arg('email') ?? 'tech@vanbransa2.com';
if (!project || !/^[a-z][a-z0-9-]{4,29}$/.test(project) || email !== 'tech@vanbransa2.com') {
  throw new Error('Usage: node scripts/bootstrap-platform-admin.mjs --project <explicit-project-id> [--email tech@vanbransa2.com]');
}
const app = initializeApp({ projectId: project, credential: applicationDefault() });
const auth = getAuth(app);
const db = getFirestore(app);
let created;
try {
  // Firebase enforces email uniqueness. No existing account is reset or adopted.
  created = await auth.createUser({ email, password: randomBytes(48).toString('base64url'), displayName: 'Vanbransa Platform Administrator', disabled: true });
  await auth.setCustomUserClaims(created.uid, { platform_admin: true });
  await db.collection('platform_admins').doc(created.uid).create({ email, status: 'active', createdAt: Timestamp.now() });
} catch (error) {
  // Only this process's new, still-disabled identity may be removed on failure.
  if (created) await auth.deleteUser(created.uid);
  throw error;
}
await auth.updateUser(created.uid, { disabled: false });
console.log(`Created platform administrator ${email} in ${project}.`);
if (process.argv.includes('--no-reset-link')) {
  console.log('Use Set or reset password on /platform/ to receive your password setup email.');
} else {
  const link = await auth.generatePasswordResetLink(email);
  console.log('Use this private one-time link to choose a password, then sign in at /platform/:');
  console.log(link);
}
