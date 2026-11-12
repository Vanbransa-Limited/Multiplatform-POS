/** Date selection belongs on the server. Read both canonical Timestamps and
 * legacy ISO strings, including records dated only by createdAt. The caller
 * applies soldAt || createdAt precedence after these candidate queries merge.
 */
export async function readSalesSince(fb, tenantId, since) {
  const start = new Date(since);
  if (!Number.isFinite(start.getTime())) throw new Error('Choose a valid sales history start date.');
  const end = new Date('9999-12-31T23:59:59.999Z');
  // ISO strings can carry timezone offsets. Include a one-day margin in the
  // lexical query; the loader normalizes dates and applies the precise cutoff.
  const stringStart = new Date(start.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const snapshots = await Promise.all(['soldAt', 'createdAt'].flatMap(field => [
    [start, end], [stringStart, end.toISOString()],
  ].map(([from, to]) => fb.firestore.getDocsFromServer(fb.firestore.query(
    fb.firestore.collection(fb.dbInstance, 'sales'),
    fb.firestore.where('tenantId', '==', tenantId),
    fb.firestore.where(field, '>=', from),
    fb.firestore.where(field, '<=', to),
  )))));
  const docs = new Map();
  for (const snapshot of snapshots) for (const doc of snapshot.docs) docs.set(doc.id, doc);
  return { docs: [...docs.values()] };
}

/** Narrow selections use sale IDs. Broad history views use one bulk read per
 * collection: dozens of sequential query waves can cost more than the data.
 * Firestore allows 30 values per `in` query; concurrency is bounded at four.
 * Fail the refresh if any batch fails; partial history must not look complete.
 */
export async function readSaleChildren(fb, tenantId, collectionName, saleIds) {
  const ids = [...new Set(saleIds.filter(Boolean))];
  if (ids.length > 120) {
    const selected = new Set(ids);
    const snapshot = await fb.firestore.getDocsFromServer(fb.firestore.query(
      fb.firestore.collection(fb.dbInstance, collectionName),
      fb.firestore.where('tenantId', '==', tenantId),
    ));
    return { docs: snapshot.docs.filter(doc => selected.has(doc.data().saleId)) };
  }
  const batches = [];
  for (let start = 0; start < ids.length; start += 30) batches.push(ids.slice(start, start + 30));
  const results = new Array(batches.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(4, batches.length) }, async () => {
    while (next < batches.length) {
      const index = next++;
      const snapshot = await fb.firestore.getDocsFromServer(fb.firestore.query(
        fb.firestore.collection(fb.dbInstance, collectionName),
        fb.firestore.where('tenantId', '==', tenantId),
        fb.firestore.where('saleId', 'in', batches[index]),
      ));
      results[index] = snapshot.docs;
    }
  }));
  return { docs: results.flat() };
}
