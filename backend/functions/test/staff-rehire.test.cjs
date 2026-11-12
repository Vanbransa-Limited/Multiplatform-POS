const assert = require('node:assert/strict');
const test = require('node:test');

const authModule = require('firebase-admin/auth');
const { db } = require('../lib/lib/firebase');
const { createStaffUser, bootstrapOwner } = require('../lib/modules/staff-admin');
const { deterministicId } = require('../lib/shared/identifiers');

const owner = { token: { tenant_id: 't1', staff_id: 's-owner', staff_role: 'owner' } };
const STAFF_ID = deterministicId('staff', 't1:ayuma@savahope.pos');

/** Firestore and Firebase Auth, both in memory. */
function harness({ docs = new Map(), identities = new Map(), owners = [] } = {}) {
  const realGetAuth = authModule.getAuth;
  const realCollection = db.collection;
  const calls = { created: [], updated: [], deleted: [], claims: [] };

  authModule.getAuth = () => ({
    createUser: async ({ email, password, displayName }) => {
      if (identities.has(email)) {
        const error = new Error('exists');
        error.code = 'auth/email-already-exists';
        throw error;
      }
      const uid = `uid-${identities.size + 1}`;
      identities.set(email, { uid, password, displayName, disabled: false });
      calls.created.push(email);
      return { uid };
    },
    getUserByEmail: async (email) => {
      const found = identities.get(email);
      if (!found) throw Object.assign(new Error('missing'), { code: 'auth/user-not-found' });
      return found;
    },
    getUser: async uid => {
      const found = [...identities.values()].find(user => user.uid === uid);
      if (!found) throw Object.assign(new Error('missing'), { code: 'auth/user-not-found' });
      return found;
    },
    updateUser: async (uid, change) => {
      for (const [email, record] of identities) {
        if (record.uid === uid) identities.set(email, { ...record, ...change });
      }
      calls.updated.push({ uid, ...change });
    },
    deleteUser: async (uid) => { calls.deleted.push(uid); },
    setCustomUserClaims: async (uid, claims) => {
      calls.claims.push({ uid, ...claims });
      for (const [email, record] of identities) {
        if (record.uid === uid) identities.set(email, { ...record, customClaims: claims });
      }
    },
  });

  db.collection = (name) => ({
    doc: (id) => ({
      id,
      path: `${name}/${id}`,
      get: async () => ({
        exists: docs.has(`${name}/${id}`),
        data: () => docs.get(`${name}/${id}`),
      }),
      set: async (data, options) => {
        const previous = options?.merge ? docs.get(`${name}/${id}`) : undefined;
        docs.set(`${name}/${id}`, { ...previous, ...data });
      },
      create: async (data) => { docs.set(`${name}/${id}`, data); },
      update: async (data) => { docs.set(`${name}/${id}`, { ...docs.get(`${name}/${id}`), ...data }); },
    }),
    add: async () => ({}),
    where: () => ({ where: () => ({ where: () => ({
      get: async () => ({ size: 2, docs: [] }),
      limit: () => ({ get: async () => ({ empty: !owners.length, docs: owners.map(id => ({ id, data: () => docs.get(`staff/${id}`) })) }) }),
    }) }) }),
  });

  return {
    docs,
    identities,
    calls,
    restore: () => { authModule.getAuth = realGetAuth; db.collection = realCollection; },
  };
}

test('bootstrap cannot repoint another tenant or platform account by email', async () => {
  const previousSecret = process.env.POS_BOOTSTRAP_SECRET;
  process.env.POS_BOOTSTRAP_SECRET = 'test-secret';
  for (const customClaims of [{ tenant_id: 'other-business', staff_id: 'owner-elsewhere' }, { platform_admin: true }, undefined]) {
    const original = { uid: 'existing-uid', password: 'unchanged', customClaims };
    const bench = harness({ docs: new Map([['tenants/t1', { status: 'active' }]]), identities: new Map([['owner@example.com', original]]) });
    try {
      await assert.rejects(bootstrapOwner.run({ data: { bootstrapSecret: 'test-secret', tenantId: 't1', email: 'owner@example.com', password: 'new-password-123' } }), /cannot be adopted/);
      assert.deepEqual(bench.identities.get('owner@example.com'), original);
      assert.equal(bench.calls.updated.length, 0);
      assert.equal(bench.calls.claims.length, 0);
      assert.equal(bench.docs.size, 1);
    } finally { bench.restore(); }
  }
  if (previousSecret === undefined) delete process.env.POS_BOOTSTRAP_SECRET; else process.env.POS_BOOTSTRAP_SECRET = previousSecret;
});

test('bootstrap adoption checks an owner profile identity before resetting it', async () => {
  const previousSecret = process.env.POS_BOOTSTRAP_SECRET;
  process.env.POS_BOOTSTRAP_SECRET = 'test-secret';
  const original = { uid: 'existing-uid', password: 'unchanged', customClaims: { tenant_id: 't2', staff_id: 'real-other-owner' } };
  const bench = harness({
    docs: new Map([['tenants/t1', { status: 'active' }], ['staff/seed-owner', { tenantId: 't1', authUid: original.uid, role: 'owner' }]]),
    identities: new Map([['owner@example.com', original]]), owners: ['seed-owner'],
  });
  try {
    await assert.rejects(bootstrapOwner.run({ data: { bootstrapSecret: 'test-secret', tenantId: 't1', email: 'new@example.com', password: 'new-password-123', adoptExisting: true } }), /not linked to this business/);
    assert.deepEqual(bench.identities.get('owner@example.com'), original);
    assert.equal(bench.calls.updated.length, 0);
    assert.equal(bench.calls.claims.length, 0);
  } finally {
    bench.restore();
    if (previousSecret === undefined) delete process.env.POS_BOOTSTRAP_SECRET; else process.env.POS_BOOTSTRAP_SECRET = previousSecret;
  }
});

const hire = (extra = {}) => createStaffUser.run({
  auth: owner,
  data: { name: 'Ayuma', email: 'ayuma@savahope.pos', password: 'firstpass1', role: 'cashier', ...extra },
});

test('a removed staff member can be taken back on with the same email', async () => {
  const bench = harness();
  try {
    await hire();
    assert.equal(bench.docs.get(`staff/${STAFF_ID}`).status, 'active');

    // Removed: the profile is disabled and the sign-in is shut off, but both
    // records stay because sales and audit rows point at this id.
    bench.docs.set(`staff/${STAFF_ID}`, { ...bench.docs.get(`staff/${STAFF_ID}`), status: 'disabled' });
    bench.identities.set('ayuma@savahope.pos', { ...bench.identities.get('ayuma@savahope.pos'), disabled: true });

    // Re-adding used to fail here: the id is derived from the email, so it
    // collided every time and only the Firebase console could clear it.
    const again = await hire({ password: 'secondpass2' });
    assert.equal(again.staffId, STAFF_ID, 'the same person, so the same record');

    const profile = bench.docs.get(`staff/${STAFF_ID}`);
    assert.equal(profile.status, 'active');
    assert.ok(profile.rehiredAt, 'the return is recorded');
    // Their history is intact: this is not a new joiner.
    assert.equal(profile.createdAt, (await hireCreatedAt(bench)), 'the original start date survives');

    const identity = bench.identities.get('ayuma@savahope.pos');
    assert.equal(identity.disabled, false, 'they can sign in again');
    assert.equal(identity.password, 'secondpass2', 'with the password just issued');
    assert.equal(bench.calls.deleted.length, 0, 'an identity that was already here is never deleted');
  } finally { bench.restore(); }
});

/** The createdAt written by the first hire, read back for comparison. */
async function hireCreatedAt(bench) {
  return bench.docs.get(`staff/${STAFF_ID}`).createdAt;
}

test('an email still on the roster and working is refused', async () => {
  const bench = harness();
  try {
    await hire();
    await assert.rejects(hire(), /already belongs to a staff member/);
  } finally { bench.restore(); }
});

test('a sign-in left behind with matching tenant claims and no profile is reused', async () => {
  // The profile is gone but Firebase Auth still holds the address - a half
  // finished create, or a tenant cleaned out by hand.
  const bench = harness({
    identities: new Map([['ayuma@savahope.pos', { uid: 'uid-orphan', password: 'old', disabled: true,
      customClaims: { tenant_id: 't1', staff_id: STAFF_ID, staff_role: 'cashier' } }]]),
  });
  try {
    const created = await hire({ password: 'freshpass9' });
    assert.equal(created.staffId, STAFF_ID);
    assert.equal(bench.identities.get('ayuma@savahope.pos').uid, 'uid-orphan', 'the same identity');
    assert.equal(bench.identities.get('ayuma@savahope.pos').password, 'freshpass9');
    assert.equal(bench.identities.get('ayuma@savahope.pos').disabled, false);
    assert.deepEqual(bench.calls.claims.at(-1), {
      uid: 'uid-orphan', tenant_id: 't1', staff_id: STAFF_ID, staff_role: 'cashier',
    });
  } finally { bench.restore(); }
});

for (const [label, customClaims] of [
  ['another tenant', { tenant_id: 't2', staff_id: 'other-staff', staff_role: 'owner' }],
  ['an unclaimed identity', undefined],
  ['a platform administrator', { platform_admin: true }],
  ['a different staff identity in this tenant', { tenant_id: 't1', staff_id: 'different-staff', staff_role: 'cashier' }],
]) {
  test(`hiring cannot take over ${label} by email`, async () => {
    const original = { uid: 'uid-existing', password: 'unchanged-password', displayName: 'Existing owner', disabled: false, customClaims };
    const bench = harness({ identities: new Map([['ayuma@savahope.pos', original]]) });
    try {
      await assert.rejects(hire(), /already belongs to another sign-in account/);
      assert.deepEqual(bench.identities.get('ayuma@savahope.pos'), original);
      assert.deepEqual(bench.calls.updated, []);
      assert.deepEqual(bench.calls.claims, []);
      assert.deepEqual(bench.calls.deleted, []);
      assert.equal(bench.docs.size, 0);
    } finally { bench.restore(); }
  });
}
