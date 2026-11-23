const test = require('node:test');
const assert = require('node:assert/strict');
const authModule = require('firebase-admin/auth');
const { db } = require('../lib/lib/firebase');
const { createPlatformTenant, listPlatformTenants, parseTenantInput, parseLogo } = require('../lib/modules/platform');

const admin = { uid: 'platform-user', token: { platform_admin: true, email: 'tech@vanbransa2.com' } };
const input = { requestId: 'request-1', businessName: 'Second Shop', slug: 'second-shop', ownerName: 'Amina', ownerEmail: 'amina@example.com', ownerPassword: 'private-password-123', branchName: 'Main' };
function harness() {
  const docs = new Map([
    ['platform_admins/platform-user', { email: 'tech@vanbransa2.com', status: 'active' }],
    ['tenants/tenant-01', { tradingName: 'Titanium', status: 'active' }],
    ['sales/titanium-sale', { tenantId: 'tenant-01', totalMinor: 99900 }],
    ['products/titanium-product', { tenantId: 'tenant-01', name: 'Original item' }],
  ]);
  const identities = new Map([['original-uid', { uid: 'original-uid', email: 'existing@example.com', password: 'original-secret', disabled: false, customClaims: { tenant_id: 'tenant-01' } }]]);
  const original = { collection: db.collection, runTransaction: db.runTransaction, getAuth: authModule.getAuth };
  const calls = { updated: [], claims: [], created: [] };
  let failActivation = false;
  let collideEmail = false;
  const snapshot = (ref) => ({ ref, id: ref.id, exists: docs.has(ref.path), data: () => docs.get(ref.path) });
  db.collection = (name) => ({
    doc: (id) => { const ref = { id, path: `${name}/${id}`, get: async () => snapshot(ref), update: async (change) => docs.set(ref.path, { ...docs.get(ref.path), ...change }) }; return ref; },
    limit: () => ({ get: async () => ({ docs: [...docs].filter(([path]) => path.startsWith(`${name}/`)).map(([path]) => snapshot({ id: path.split('/')[1], path })) }) }),
  });
  db.runTransaction = async (fn) => {
    const writes = [];
    const result = await fn({
      getAll: async (...refs) => refs.map(snapshot), get: async (ref) => snapshot(ref),
      create: (ref, value) => writes.push({ ref, value, create: true }),
      update: (ref, value) => writes.push({ ref, value }),
      delete: (ref) => writes.push({ ref, deleted: true }),
    });
    // Model create preconditions atomically: no write applies when one conflicts.
    for (const write of writes) if (write.create && docs.has(write.ref.path)) throw new Error('already exists');
    for (const write of writes) { if (write.deleted) docs.delete(write.ref.path); else docs.set(write.ref.path, write.create ? write.value : { ...docs.get(write.ref.path), ...write.value }); }
    return result;
  };
  authModule.getAuth = () => ({
    createUser: async (value) => {
      if (collideEmail) { collideEmail = false; identities.set('racing-other-uid', { uid: 'racing-other-uid', email: value.email, password: 'untouched-racing-secret', disabled: false, customClaims: { tenant_id: 'tenant-01' } }); }
      if (identities.has(value.uid)) throw Object.assign(new Error('UID exists'), { code: 'auth/uid-already-exists' });
      if ([...identities.values()].some((user) => user.email === value.email)) throw Object.assign(new Error('email exists'), { code: 'auth/email-already-exists' });
      identities.set(value.uid, { ...value }); calls.created.push(value.uid); return value;
    },
    getUser: async (uid) => { if (!identities.has(uid)) throw Object.assign(new Error('missing'), { code: 'auth/user-not-found' }); return identities.get(uid); },
    getUserByEmail: async (email) => { const user = [...identities.values()].find((value) => value.email === email); if (!user) throw Object.assign(new Error('missing'), { code: 'auth/user-not-found' }); return user; },
    setCustomUserClaims: async (uid, claims) => { identities.set(uid, { ...identities.get(uid), customClaims: claims }); calls.claims.push(uid); },
    updateUser: async (uid, value) => {
      if (failActivation) { failActivation = false; throw new Error('Temporary activation outage'); }
      identities.set(uid, { ...identities.get(uid), ...value }); calls.updated.push(uid);
    },
  });
  return { docs, identities, calls, raceEmailCollision: () => { collideEmail = true; }, failActivation: () => { failActivation = true; }, restore: () => Object.assign(db, { collection: original.collection, runTransaction: original.runTransaction }) && (authModule.getAuth = original.getAuth) };
}

test('platform administration rejects anonymous, tenant owners, forged email and revoked registry', async () => {
  const bench = harness();
  try {
    for (const auth of [undefined, { uid: 'owner', token: { tenant_id: 'tenant-01', staff_role: 'owner' } }, { uid: 'other', token: { platform_admin: true, email: 'other@example.com' } }]) {
      await assert.rejects(createPlatformTenant.run({ auth, data: input }), /Sign in|administrator/);
      await assert.rejects(listPlatformTenants.run({ auth }), /Sign in|administrator/);
    }
    bench.docs.get('platform_admins/platform-user').status = 'disabled';
    await assert.rejects(createPlatformTenant.run({ auth: admin, data: input }), /inactive/);
    assert.equal(bench.calls.created.length, 0);
  } finally { bench.restore(); }
});

test('onboarding creates an isolated blank business and replay is idempotent; Titanium stays byte-for-byte unchanged', async () => {
  const bench = harness();
  const before = [...bench.docs].filter(([key]) => !key.startsWith('platform_admins/')).map(([key, value]) => [key, JSON.stringify(value)]);
  try {
    const result = await createPlatformTenant.run({ auth: admin, data: input });
    assert.equal(result.tenantId, 'tenant-second-shop');
    for (const [key, value] of before) assert.equal(JSON.stringify(bench.docs.get(key)), value, key);
    const identity = [...bench.identities.values()].find((user) => user.email === input.ownerEmail);
    assert.equal(identity.disabled, false);
    assert.deepEqual(identity.customClaims, { tenant_id: result.tenantId, staff_id: result.staffId, staff_role: 'owner' });
    assert.equal(bench.docs.get(`devices/${result.deviceId}`).branchId, result.branchId);
    assert.equal(bench.docs.get(`customers/${result.customerId}`).tenantId, result.tenantId);
    assert.equal(bench.docs.get(`tenant_settings/${result.tenantId}`).acceptedPaymentMethods.join(), 'cash');
    const receiptPolicy = bench.docs.get(`mpesa_receipt_controls/${result.tenantId}`);
    assert.equal(receiptPolicy.tenantId, result.tenantId);
    assert.equal(receiptPolicy.entryMode, 'staff_entry'); assert.equal(receiptPolicy.duration, 'ongoing');
    assert.equal(receiptPolicy.policyVersion, 3); assert.equal(receiptPolicy.until, null);
    assert.equal(receiptPolicy.branchScope, 'tenant'); assert.deepEqual(receiptPolicy.branchIds, [result.branchId]);
    assert.equal(receiptPolicy.authorizationId, `${result.tenantId}-onboarding`);
    assert.equal(bench.docs.has('mpesa_receipt_controls/tenant-01'), false, 'onboarding must not modify another tenant policy');
    assert.equal(JSON.stringify([...bench.docs]).includes(input.ownerPassword), false);
    assert.deepEqual(await createPlatformTenant.run({ auth: admin, data: input }), result);
    assert.equal(bench.calls.created.length, 1);
    await assert.rejects(createPlatformTenant.run({ auth: admin, data: { ...input, requestId: 'request-2', ownerEmail: 'another@example.com' } }), /already in use/);
    await assert.rejects(createPlatformTenant.run({ auth: admin, data: { ...input, businessName: 'Changed' } }), /different business details/);
    const listing = await listPlatformTenants.run({ auth: admin });
    assert.equal(listing.tenants.length, 2);
    assert.equal(listing.tenants.find((tenant) => tenant.tenantId === 'tenant-01').businessName, 'Titanium');
    assert.equal(JSON.stringify(listing).includes('password'), false);
  } finally { bench.restore(); }
});

test('existing owner email is refused without password, claims or activation changes', async () => {
  const bench = harness();
  const before = JSON.stringify(bench.identities.get('original-uid'));
  try {
    await assert.rejects(createPlatformTenant.run({ auth: admin, data: { ...input, ownerEmail: 'existing@example.com' } }), /already has an account/);
    assert.equal(JSON.stringify(bench.identities.get('original-uid')), before);
    assert.deepEqual(bench.calls.updated, []);
    assert.deepEqual(bench.calls.claims, []);
    assert.equal(bench.docs.has('tenants/tenant-second-shop'), false);
    assert.equal(bench.docs.has('platform_tenant_slugs/second-shop'), false);
    await createPlatformTenant.run({ auth: admin, data: input });
    assert.equal(bench.docs.has('tenants/tenant-second-shop'), true, 'corrected email can reuse the same business identifier');
  } finally { bench.restore(); }
});

test('activation interruption can be retried without recreating data or resetting credentials', async () => {
  const bench = harness();
  try {
    bench.failActivation();
    await assert.rejects(createPlatformTenant.run({ auth: admin, data: input }), /activation outage/);
    const identity = [...bench.identities.values()].find((user) => user.email === input.ownerEmail);
    assert.equal(identity.disabled, true);
    const before = JSON.stringify(bench.docs.get('tenants/tenant-second-shop'));
    await createPlatformTenant.run({ auth: admin, data: input });
    assert.equal(JSON.stringify(bench.docs.get('tenants/tenant-second-shop')), before);
    assert.equal(bench.calls.created.length, 1);
    assert.equal(bench.identities.get(identity.uid).password, input.ownerPassword);
    assert.equal(bench.identities.get(identity.uid).disabled, false);
  } finally { bench.restore(); }
});

test('an email claimed during onboarding releases only its untouched reservation for a corrected new request', async () => {
  const bench = harness();
  try {
    bench.raceEmailCollision();
    await assert.rejects(createPlatformTenant.run({ auth: admin, data: input }), /already has an account/);
    assert.equal(bench.docs.has('platform_tenant_slugs/second-shop'), false);
    assert.equal(bench.docs.has('platform_onboarding/platform-user_request-1'), false);
    assert.equal(bench.docs.has('tenants/tenant-second-shop'), false);
    const before = JSON.stringify(bench.identities.get('racing-other-uid'));
    await createPlatformTenant.run({ auth: admin, data: { ...input, requestId: 'corrected-request', ownerEmail: 'corrected@example.com' } });
    assert.equal(bench.docs.has('tenants/tenant-second-shop'), true);
    assert.equal(JSON.stringify(bench.identities.get('racing-other-uid')), before);
    assert.equal(bench.calls.updated.includes('racing-other-uid'), false);
    assert.equal(bench.calls.claims.includes('racing-other-uid'), false);
  } finally { bench.restore(); }
});

test('replaying a completed onboarding never reactivates a subsequently disabled owner', async () => {
  const bench = harness();
  try {
    await createPlatformTenant.run({ auth: admin, data: input });
    const identity = [...bench.identities.values()].find((user) => user.email === input.ownerEmail);
    bench.identities.set(identity.uid, { ...identity, disabled: true });
    const updateCount = bench.calls.updated.length;
    await createPlatformTenant.run({ auth: admin, data: input });
    assert.equal(bench.calls.updated.length, updateCount);
    assert.equal(bench.identities.get(identity.uid).disabled, true);
  } finally { bench.restore(); }
});

test('input and logo validation block malformed identifiers and executable logo content', () => {
  for (const change of [{ slug: '../tenant-01' }, { ownerEmail: 'bad' }, { ownerPassword: '1234' }, { businessName: '' }]) assert.throws(() => parseTenantInput({ ...input, ...change }));
  for (const logo of ['javascript:alert(1)', 'data:image/svg+xml;base64,PHN2Zz4=', 'data:image/png;base64,YmFk', 'https://user:pass@example.com/a.png', 'http://example.com/a.png']) assert.throws(() => parseLogo(logo));
  assert.equal(parseLogo('https://example.com/logo.png'), 'https://example.com/logo.png');
  const png = 'data:image/png;base64,iVBORw0KGgo=';
  assert.equal(parseLogo(png), png);
});
