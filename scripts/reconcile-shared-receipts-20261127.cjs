'use strict';
// Owner-approved repair from the supplied receipt messages, 27 Nov 2026.
// Default: read-only preview. Applies only the reviewed hash and exact bills.
const assert = require('node:assert/strict');
const path = require('node:path');
const { createHash } = require('node:crypto');
const backend = require('node:module').createRequire(path.resolve(__dirname, '../backend/functions/package.json'));
const T = 'tenant-01', B = 'branch-nai-01', archiveId = 'shared-receipts-20261127';
const C1 = 'UKR5Q4MZG2', C2 = 'UKQFG3EATT';
const ORIGINAL = 'sale-fd8c671c4ba20e8afa6f2f5b6fa8a0204afce70974aa920c';
const NICOLE = 'sale-d23f9915ac5ef87cb34e6485ef3e3c93c2710915805ee8bd';
const HADRINE = 'sale-5286b954320e7f531a4ac254f50555f4aad694a85a22af19';
const stable = value => value?.toMillis ? { timestampMs: value.toMillis() }
  : Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
const hash = records => createHash('sha256').update(JSON.stringify(stable(records))).digest('hex');
async function main() {
  const args = process.argv.slice(2), value = name => args.includes(name) ? args[args.indexOf(name) + 1] : null;
  assert.equal(Number(process.versions.node.split('.')[0]), 22, 'Node 22 required');
  assert.equal(value('--project'), 'vanbransa-pos', 'Explicit production project required');
  assert.ok(!process.env.FIRESTORE_EMULATOR_HOST, 'This entry point targets only the approved production records');
  const apply = args.includes('--apply'), expected = value('--expected-hash');
  if (apply) assert.match(expected || '', /^[a-f0-9]{64}$/, 'Apply requires the reviewed hash');
  const { initializeApp, applicationDefault } = backend('firebase-admin/app');
  const { Timestamp } = backend('firebase-admin/firestore');
  const app = initializeApp({ projectId: 'vanbransa-pos', credential: applicationDefault() });
  const { db } = require('../backend/functions/lib/lib/firebase');
  const { deterministicId } = require('../backend/functions/lib/shared/identifiers');
  const { correctReceiptTotal } = require('../backend/functions/lib/modules/sales/correct-receipt');
  const { settleSale, outstandingMinor } = require('../backend/functions/lib/modules/sales/settle');
  const archiveRef = db.doc(`reconciliation_archives/${archiveId}`);
  const claimRef = db.doc(`payment_receipt_claims/${deterministicId('mpesa-receipt', `${T}:${C1}`)}`);
  const authorization = 'Owner explicitly approved the KES 600 -> 1,050 correction and confirmed the KES 350 receipt belongs to Hadrine INV-BH001-003494 in this conversation on 27 November 2026.';
  try {
    const preview = await db.runTransaction(async tx => {
      const refs = [archiveRef, claimRef, ...[ORIGINAL, NICOLE, HADRINE].map(id => db.doc(`sales/${id}`)),
        ...[C1,C2].flatMap(code => [db.doc(`mpesa_c2b_events/${deterministicId('c2b', `confirmation:${code}`)}`), db.doc(`payment_intents/${deterministicId('intent', `${T}:${code}`)}`)])];
      const [archive, claim, original, nicole, hadrine, ...proofs] = await tx.getAll(...refs);
      if (archive.exists) return { resumed: true, original: archive.data().originalPayment,
        nicoleUuid: nicole.data().idempotencyKey, hadrineUuid: hadrine.data().idempotencyKey, hash: archive.data().sourceFingerprint };
      const used = await tx.get(db.collection('payments').where('tenantId', '==', T).where('reference', '==', C1));
      const otherUsed = await tx.get(db.collection('payments').where('tenantId', '==', T).where('reference', '==', C2));
      const nicoleLedger = await tx.get(db.collection('payments').where('tenantId', '==', T).where('saleId', '==', NICOLE));
      const hadrineLedger = await tx.get(db.collection('payments').where('tenantId', '==', T).where('saleId', '==', HADRINE));
      for (const sale of [original, nicole, hadrine]) { assert.equal(sale.data().tenantId,T); assert.equal(sale.data().branchId,B); assert.notEqual(sale.data().status,'VOIDED'); }
      assert.equal(original.data().invoiceNumber,'INV-BH001-003556'); assert.equal(original.data().totalMinor,60000);
      assert.equal(nicole.data().invoiceNumber,'INV-BH001-003550'); assert.equal(nicole.data().orderReference,'ORD-0-071495');
      assert.equal(hadrine.data().invoiceNumber,'INV-BH001-003494'); assert.equal(hadrine.data().orderReference,'ORD-5-196030');
      assert.equal(claim.data().tenantId,T); assert.equal(claim.data().limitMinor,60000); assert.equal(claim.data().allocatedMinor,60000);
      assert.equal(claim.data().amountSource,'staff_recorded_receipt'); assert.equal(claim.data().verified,false);
      assert.equal(used.size,1); assert.equal(used.docs[0].data().saleId,ORIGINAL); assert.equal(used.docs[0].data().amountMinor,60000);
      assert.equal(otherUsed.size,0); assert.ok(proofs.every(doc => !doc.exists), 'Provider proof appeared; review before manual repair');
      assert.equal(outstandingMinor(nicoleLedger.docs.map(doc=>doc.data())),45000);
      assert.equal(outstandingMinor(hadrineLedger.docs.map(doc=>doc.data())),35000);
      const records = { claim:claim.data(), original:original.data(), nicole:nicole.data(), hadrine:hadrine.data(),
        originalPayment:{ id:used.docs[0].id, data:used.docs[0].data() },
        nicolePayments:nicoleLedger.docs.map(doc=>({id:doc.id,data:doc.data()})), hadrinePayments:hadrineLedger.docs.map(doc=>({id:doc.id,data:doc.data()})) };
      const fingerprint = hash(records);
      if (apply) {
        assert.equal(expected,fingerprint,'Records changed since the reviewed preview');
        tx.create(archiveRef,{tenantId:T,branchId:B,sourceFingerprint:fingerprint,records,originalPayment:records.originalPayment,
          authorization,createdAt:Timestamp.now(),status:'authorized',receiptReferences:[C1,C2]});
        tx.create(db.doc(`audit_logs/${archiveId}`),{tenantId:T,branchId:B,action:'receipt.reconciliation_authorized',
          actorStaffId:`reconciliation:${archiveId}`,entityType:'reconciliation',entityId:archiveId,
          metadata:{references:[C1,C2],correctionFromMinor:60000,correctionToMinor:105000,nicoleSettlementMinor:45000,hadrineSettlementMinor:35000,authorization},createdAt:Timestamp.now()});
      }
      return { hash:fingerprint, original:records.originalPayment, nicoleUuid:nicole.data().idempotencyKey, hadrineUuid:hadrine.data().idempotencyKey };
    });
    if (!apply) { console.log(JSON.stringify({ result:'dry run; no writes',hash:preview.hash,resumed:Boolean(preview.resumed),
      plan:[`${C1}: correct the recorded total from KES 600 to KES 1,050; preserve INV-003556's KES 600; settle Nicole INV-003550 KES 450.`,
        `${C2}: record KES 350 once against Hadrine INV-003494.`],authorization },null,2)); return; }
    const auth = { uid:'owner-approved-reconciliation',token:{tenant_id:T,staff_id:'user-owner',staff_role:'owner'} };
    const current = (await claimRef.get()).data();
    if (current.limitMinor === 60000) await correctReceiptTotal.run({auth,data:{reference:C1,totalMinor:105000,reason:`${archiveId}: owner-reviewed receipt is KES 1,050; preserve original KES 600 allocation.`}});
    else assert.equal(current.limitMinor,105000,'Unexpected receipt total');
    const nicole = await settleSale.run({auth,data:{saleUuid:preview.nicoleUuid,requestId:`${archiveId}-nicole`,method:'mpesa',reference:C1,amountMinor:45000}});
    const hadrine = await settleSale.run({auth,data:{saleUuid:preview.hadrineUuid,requestId:`${archiveId}-hadrine`,method:'mpesa',reference:C2,receiptAmountMinor:35000,amountMinor:35000}});
    assert.equal(nicole.outstandingMinor,0); assert.equal(hadrine.outstandingMinor,0);
    assert.deepEqual(stable((await db.doc(`payments/${preview.original.id}`).get()).data()),stable(preview.original.data),'Original payment changed');
    const after = (await claimRef.get()).data(); assert.equal(after.limitMinor,105000); assert.equal(after.allocatedMinor,105000);
    await archiveRef.update({status:'complete',completedAt:Timestamp.now(),results:{nicole,hadrine}});
    console.log(JSON.stringify({result:'complete',archiveId,nicoleInvoice:'INV-BH001-003550',nicoleOutstandingMinor:nicole.outstandingMinor,
      hadrineInvoice:'INV-BH001-003494',hadrineOutstandingMinor:hadrine.outstandingMinor,original600Unchanged:true,manualPaymentsRemainUnverified:nicole.verified===false&&hadrine.verified===false},null,2));
  } finally { await app.delete(); }
}
if(require.main===module) main().catch(error=>{console.error(error.message);process.exitCode=1;});
