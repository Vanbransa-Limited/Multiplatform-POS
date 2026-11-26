'use strict';
// One item, one product. Default is a read-only dry run; apply needs its hash.
//
// The catalogue carried the same item under several products: copies with a
// count date in the name, a spelling slip ("GUINESS"), an unpriced copy added
// from the Stock screen, a retired copy that deliveries were still booked on.
// Deliveries landed on one copy and the till sold another, so the one the till
// sells went negative while the stock sat out of sight.
//
// For each duplicate below, every House and Store balance moves onto the
// product the till sells (recorded as a 'merge' movement on both), and the
// duplicate is retired and marked mergedIntoProductId. Sales history is left
// on whichever product it was sold as.
// Also: live products left flagged retired by an old restore are un-flagged
// (the Stock screen hid them, which is how two of these twins were born), and
// stock on the demo products the business was set up with, which nothing ever
// delivered, is cleared.
const assert = require('node:assert/strict');
const path = require('node:path');
const { createHash } = require('node:crypto');
const backend = require('node:module').createRequire(path.resolve(__dirname, '../backend/functions/package.json'));
const { initializeApp, applicationDefault } = backend('firebase-admin/app');
const { getFirestore, Timestamp, FieldValue } = backend('firebase-admin/firestore');

const tenantId = 'tenant-01';
const archiveId = 'merge-duplicate-products-20261124';
const actor = `reconciliation:${archiveId}`;
const p = (suffix) => `product-${suffix}`;

// keeper <- duplicates (reviewed 24 Nov 2026)
const MERGES = [
  [p('5f1f8076a2673218001ea502ad33e7b39dc616b1a9f48f18'), [p('a590050afa680e9826364228f951d28e8fc7c557eccd6fc2')]], // KO LIME & PASSION 330ML BOTTLE
  [p('3e95a5656f7a7882dc3bcc01e200ad5b96d1195aca93c077'), [p('0a034202e189c028e8106db248649a672c0286fcbe47ef24')]], // KO PINEAPPLE & MINT BOTTLE 330ML
  [p('0e68fbd8a23707bf9b9281d1035394a2d6534614820fdf87'), [p('f19e9148d3df66eb095ac957473f66ec66c6eee7d988a98d')]], // FISH NO.3 & 4
  [p('06966830baf87d9177e4793b29586abc90259179f2054951'), [p('e4b1d3f29c50dbfea60d1da3123464cd8777ecf7dcbeb6b1')]], // AMARULA CREAM 1000ML
  [p('b4a0780c34061b308e3de86e204634fd83a1b655a9f26e44'), [p('d1839f63a20a493f605ad2516a1e3da1a4a32a85e0e28c00')]], // JAGERMEISTER MANIFEST 1000ML
  [p('9889baaf2d7d538e64f3e2fe6b3524891f51f99cf90d79bd'), [p('702bfa575d3a2e5424e2f40f58385184b9b28febcc3c1a7e')]], // SINGLETON FRUITY DECADENCE 15 YRS
  [p('dc0d9c2badc2b315a1090127104e84a6615cd1140f99a2fd'), [p('520ecc64b6f87672b1231a38cc622b7c0c86b410b86d0503')]], // SPARKLING WATER 1LITRE
  [p('2594ce9ed3936a0d52e7137e9533e87851ed9c71d762b8ac'), [p('c38e1c600ecdb786d99012af93fee922153de58af2de807a')]], // GORDON PINK TONIC CAN 330ML
  [p('e6a7ac32e288fc501d9a13cdaea72e3205949c5c72eeed92'), [p('29b1ab09b1475619f5f47b716b96b58e29a66cbea8f69667'), p('5aee42a8ec454aef8bbf42e3a6f8e32692e2569fbec9b976')]], // GUINNESS STOUT 500ML BOTTLE
  [p('904287d310d3c88cfffdb831bbbc954e59f9511bed64c914'), [p('18ef515901d408114bd9eeebb6edf5d6d11ff30e17a6334f'), p('e481b7ff493e2fd250cb6c063048fec2423efccf5bfd39e9')]], // TUSKER LAGER BOTTLE 500ML
  [p('0cdec3a35dd71f4dc079586eee3ea73e81fa743b701fedcf'), [p('ac54c9e1753b35cfb482693ae61c9f2038ca82dd8058c657')]], // TUSKER CIDER 500ML CAN
  [p('28483d791d53d79c86126f40945cd93ed02ecef0e45e0762'), [p('0a4a80fd80d7b46bf1f5056daa1538b8b018fdc6e91dfb90')]], // WATER 500ML
  [p('860093672ae43b1ef3686fefc71bc2ba3c68cae8434a7303'), [p('079975d713739224942006828c1249f1e3a977656d30a35f')]], // JACK DANIEL 700ML
  [p('6b87f85c97df19a473e8f7735cbeafa9697a981d49e9a7ea'), [p('0746881b4bb0a72184db6abe78c2dc083756ce84adf08b38')]], // HENNESSY VS(700ML)
  [p('36bbc1801a9df0c09386eb494b7f81290d1e21d504151af1'), [p('f6b0fe6d70fec3b1e7900ba2e71f230a70c0bc6ce87d549b'), p('e1a8f1986eed9c4bb516216a2ddc795f694c0e58bd990b08')]], // JAGERMEISTER 700ML
  [p('ad6bf429800f7d4d7bb6af0f00addde80a29b6a3638d866a'), [p('cc5f6accf28f766ca930a3a5b577d1fe1077dfed2d470dba')]], // MUCHO MAS BLACK EDITION 750ML
  [p('b5a1c12a4b875e54587394126e61df38a13adab7d87fab9a'), [p('49a79120cace7c6f3a188e60915ff9ce3191342c9f524dd0'), p('bf50c874dfb30d4388aa1966d12a6b588d525fbc569114db'), p('53e672097dd91265e025be434e9335f51259762407ad4218'), p('59dae2f46ff6d549c89c158d151b5219f46cf1f4962daf34')]], // JOHNNIE WALKER BLACK LABEL (750ML)
  [p('9309e79ea04e9216c26f80da6d40831ef1fafbb824d7cce5'), [p('1928c3a7bde60b81055a5ec91d2237a7cd44ad7cc8b3a173'), p('f8c22ef476cdbfa972b644ff64e9a1aab2030964e443764e'), p('0a49753bea36913a3c42422014dc9c43f6633627624031c8')]], // JOHNNIE WALKER BLACK LABEL (1L)
  [p('edf9bb551f59efe0c0375a2931b9b6e4e8f9a6b9a8999d23'), [p('2e3cd701e0033494688401c620ba4dd2a01083853b422a43')]], // CASAMIGOS BLANCO (750ML)
  [p('02c2b1b8011bf449c52601a2f54d2137c2c1d03e8b9846ab'), [p('32e819f966f736b81ddc1c33d79c7a417713708142a23e97')]], // GORDONS LONDON DRY GIN(750ML)
  [p('77c94a244230530e515b47e95bbbf4580707a4242445be96'), [p('e0a8b88f74047dd83def48b6d528c9fc900da065c6b7ae3b')]], // GILBEYS GIN(750ML)
  [p('53ca0ddf78d2b722bd22bade465a071d5b7477fef8be8f85'), [p('349d4bdb4df087b4648f0f90233b4109fc4acd6f5c8929c0')]], // JAMESON 750ML
  [p('924c474444edcb8df69a3fb0f5a8b06dcd1b1cc1d9746ffa'), [p('fa9168abbf765abcf2e59936f0e96916f15fc61fb67d992e')]], // JOHNNIE WALKER RED LABEL(750ML)
  [p('6d8f8e4ac197a127d35ce164c05191a59f164c700f108d85'), [p('26631d008043bb41f7b889687a6652a8aeace476dbdf2fcb'), p('4d7431f53992de0e01a1d423418b9f6adf5282af14638dc2')]], // ROBERTSON SWEET RED (750ML)
  [p('775351433834708a029a888f973a515a1b06cde21404ffe5'), [p('b451f204e3da5a7b649e9cab6a9d3f173c282da7f8d283a9'), p('e164a8262f97fc1736009b9d5fc6bb9aa6939e544cf672ed')]], // ROBERTSON SWEET WHITE (750ML)
  [p('c93b756fbe7be358c528b0ee1185dccc4c79fd0ceda7e59b'), [p('3ea3630da720532fafd3399a4b0b12f94eea5cb2b24bf827')]], // CHICKEN FULL (KIENYEJI)
  [p('afb05e4df37a4fda9f1de3032c8d53ad09b523b2ceb143cc'), [p('6c0d9dd6fbe78009fdde60f05ce8ac0c9ce1ecf741798c09')]], // DRUMSTICKS (3PCS)
  [p('ccd91a4b88cadd79e8131bcdbc37c0dd2c9d4f3161f966d6'), ['prod-savanna']], // SAVANNAH CIDER DRY330ML
  [p('b747f0bf7fc16d268bf74d5292ad9d6ae6d87687e819be98'), [p('ea830d88e7475d976a0ba86972119773e8c8968e365156dc'), p('b242d9878fe5db06e5364887f7df17d7c6c61e737e9c1905')]], // FANTA BLACK CURRANT BOTTLE 300ML
];
// Live, priced and selling, but still flagged retired by an old restore.
const UNFLAG = [p('904287d310d3c88cfffdb831bbbc954e59f9511bed64c914'), p('c93b756fbe7be358c528b0ee1185dccc4c79fd0ceda7e59b'), 'prod-corkage', p('db5b5cfdb55d07964b46c0cab44eb3c98cd44dec293b1bb1')];
// Demo products the business was provisioned with: stock nothing ever delivered.
const CLEAR = ['prod-coca-cola', 'prod-chicken-chips', 'prod-guinness', 'prod-jameson-tot', 'prod-juice', 'prod-konyagi',
  'prod-nyama-choma', 'prod-pilau', 'prod-ugali-stew', 'prod-water', 'prod-whitecap', 'prod-wine-glass'];
// A recent sale on a live duplicate means the till still uses it: stop rather than retire it.
const RECENT_SALE_DAYS = 14;

const stable = value => value?.toMillis ? { timestampMs: value.toMillis() }
  : Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
const fingerprint = value => createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');

async function merge(db, { apply = false, expectedHash = null } = {}) {
  const archiveRef = db.doc(`reconciliation_archives/${archiveId}`);
  if ((await archiveRef.get()).exists) return { result: 'already merged', archiveId };
  const ids = [...new Set([...MERGES.flatMap(([keeper, dups]) => [keeper, ...dups]), ...UNFLAG, ...CLEAR])];
  const duplicates = MERGES.flatMap(([, dups]) => dups);
  assert.equal(new Set(duplicates).size, duplicates.length, 'a duplicate is listed twice');
  assert.ok(!duplicates.some(id => MERGES.some(([keeper]) => keeper === id)), 'a keeper is also a duplicate');
  const since = Timestamp.fromMillis(Date.now() - RECENT_SALE_DAYS * 864e5);

  return db.runTransaction(async tx => {
    const products = new Map((await tx.getAll(...ids.map(id => db.doc(`products/${id}`)))).map(snap => {
      assert.ok(snap.exists && snap.data().tenantId === tenantId, `${snap.id} missing`);
      return [snap.id, snap.data()];
    }));
    const balances = [];
    for (let i = 0; i < ids.length; i += 30) {
      const snap = await tx.get(db.collection('stock_balances').where('tenantId', '==', tenantId).where('productId', 'in', ids.slice(i, i + 30)));
      balances.push(...snap.docs.map(doc => ({ ref: doc.ref, ...doc.data() })));
    }
    const plan = { merges: [], unflag: [], clear: [] };

    for (const [keeperId, dupIds] of MERGES) {
      const keeper = products.get(keeperId);
      assert.ok(keeper.isActive && Number(keeper.sellPriceMinor) > 0, `keeper ${keeper.name} is not a priced live item`);
      for (const dupId of dupIds) {
        const dup = products.get(dupId);
        if (!dup.retiredAt && dup.isActive) {
          const sold = await tx.get(db.collection('sale_lines').where('productId', '==', dupId));
          const recent = sold.docs.filter(doc => Number(doc.data().createdAt?.toMillis?.() || 0) >= since.toMillis());
          assert.equal(recent.length, 0, `${dup.name} sold in the last ${RECENT_SALE_DAYS} days; the till still uses it`);
        }
        const moves = balances.filter(b => b.productId === dupId && Number(b.qty) !== 0)
          .map(b => ({ branchId: b.branchId, location: b.location, qty: Number(b.qty) }));
        plan.merges.push({ keeperId, keeper: keeper.name, dupId, duplicate: dup.name, state: dup.retiredAt ? 'retired' : dup.isActive ? 'live' : 'unpriced', moves });
      }
    }
    for (const id of UNFLAG) {
      const product = products.get(id);
      assert.ok(product.isActive && product.retiredAt, `${product.name} is not a live item flagged retired`);
      plan.unflag.push({ id, name: product.name });
    }
    for (const id of CLEAR) {
      const product = products.get(id);
      assert.ok(product.retiredAt, `${product.name} is not retired`);
      const movements = await tx.get(db.collection('stock_movements').where('productId', '==', id).limit(1));
      assert.equal(movements.size, 0, `${product.name} has real stock movements; merge it instead`);
      plan.clear.push({ id, name: product.name, balances: balances.filter(b => b.productId === id && Number(b.qty) !== 0).map(b => ({ location: b.location, qty: b.qty })) });
    }

    // What each keeper holds once its duplicates are folded in.
    const after = {};
    for (const [keeperId, dupIds] of MERGES) {
      const name = products.get(keeperId).name;
      after[name] = {};
      for (const b of balances.filter(b => [keeperId, ...dupIds].includes(b.productId))) after[name][b.location] = (after[name][b.location] || 0) + Number(b.qty);
    }
    const records = { products: Object.fromEntries([...products].map(([id, data]) => [id, data])), balances: balances.map(({ ref, ...b }) => b) };
    const hash = fingerprint(records);
    if (!apply) return { result: 'dry run, nothing written', hash, plan, after };
    assert.equal(expectedHash, hash, 'The records changed since the reviewed dry run.');

    const now = Timestamp.now();
    tx.create(archiveRef, { tenantId, records, sourceFingerprint: hash, plan, createdAt: now, authorizedBy: 'Owner, 24 Nov 2026 (clear double entries)' });
    // Balances are keyed branch_product_LOCATION; sum per target before writing.
    const target = new Map();
    const bump = (branchId, productId, location, delta) => {
      const id = `${branchId}_${productId}_${location}`;
      const current = target.get(id) ?? { branchId, productId, location, qty: Number(balances.find(b => b.ref.id === id)?.qty || 0), exists: balances.some(b => b.ref.id === id) };
      current.qty += delta;
      target.set(id, current);
    };
    let n = 0;
    const movement = (branchId, productId, location, qty, type, note) => tx.create(db.doc(`stock_movements/${archiveId}-${++n}`), {
      tenantId, branchId, productId, location, qty, type, referenceId: archiveId, reason: note, createdByStaffId: actor, createdAt: now });
    for (const step of plan.merges) {
      for (const m of step.moves) {
        bump(m.branchId, step.dupId, m.location, -m.qty);
        bump(m.branchId, step.keeperId, m.location, m.qty);
        movement(m.branchId, step.dupId, m.location, -m.qty, 'merge', `Merged into ${step.keeper}`);
        movement(m.branchId, step.keeperId, m.location, m.qty, 'merge', `Merged from ${step.duplicate}`);
      }
      tx.update(db.doc(`products/${step.dupId}`), { isActive: false, showOnMenu: false, retiredAt: products.get(step.dupId).retiredAt || now,
        retiredByStaffId: products.get(step.dupId).retiredByStaffId || actor, mergedIntoProductId: step.keeperId, updatedAt: now });
    }
    for (const step of plan.clear) {
      for (const b of balances.filter(x => x.productId === step.id && Number(x.qty) !== 0)) {
        bump(b.branchId, step.id, b.location, -Number(b.qty));
        movement(b.branchId, step.id, b.location, -Number(b.qty), 'adjust', 'Demo stock from setup, never delivered');
      }
    }
    for (const [id, b] of target) {
      const data = { tenantId, branchId: b.branchId, productId: b.productId, location: b.location, qty: b.qty, id, updatedAt: now };
      if (b.exists) tx.update(db.doc(`stock_balances/${id}`), { qty: b.qty, updatedAt: now });
      else tx.create(db.doc(`stock_balances/${id}`), data);
    }
    for (const step of plan.unflag) tx.update(db.doc(`products/${step.id}`), { retiredAt: null, retiredByStaffId: FieldValue.delete(), updatedAt: now });
    tx.create(db.doc(`audit_logs/${archiveId}`), { tenantId, actorStaffId: actor, action: 'catalogue.duplicates_merged', entityType: 'reconciliation',
      entityId: archiveId, metadata: { merged: plan.merges.length, unflagged: plan.unflag.length, cleared: plan.clear.length }, createdAt: now });
    return { result: 'applied', archiveId, hash, after };
  });
}

async function main() {
  const args = process.argv.slice(2);
  const value = name => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
  if (value('--project') !== 'vanbransa-pos') throw new Error('Explicit --project vanbransa-pos required.');
  const apply = args.includes('--apply');
  if (apply && !value('--expected-hash')) throw new Error('Apply requires the reviewed --expected-hash.');
  const db = getFirestore(initializeApp({ projectId: 'vanbransa-pos', credential: applicationDefault() }));
  console.log(JSON.stringify(await merge(db, { apply, expectedHash: value('--expected-hash') }), null, 2));
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { merge };
