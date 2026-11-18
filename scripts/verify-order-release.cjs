'use strict';
// Read-only release verification. Callable probes deliberately have no login,
// so authentication must refuse them before any financial write can occur.
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const root = path.resolve(__dirname, '..', 'frontend', 'out');
const host = 'https://vanbransa-pos.web.app';
const hash = value => createHash('sha256').update(value).digest('hex');

async function main() {
  const assets = new Set();
  const proformas = process.argv.includes('--proformas');
  const routes = proformas ? ['orders', 'till', 'tabs', 'qrtools', 'finance', 'settings', 'customers', 'inventory', 'shifts'] : ['orders', 'till', 'tabs'];
  if (process.argv.includes('--payments-stock')) routes.push('mpesa', 'house-stock', 'store-stock');
  for (const route of process.argv.includes('--backend-only') ? [] : routes) {
    const response = await fetch(`${host}/${route}/`, { cache: 'no-store', signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`Live ${route} returned ${response.status}`);
    const live = Buffer.from(await response.arrayBuffer());
    const built = await fs.readFile(path.join(root, route, 'index.html'));
    if (hash(live) !== hash(built)) throw new Error(`Live ${route} does not match this build.`);
    for (const match of live.toString('utf8').matchAll(/<script[^>]*src="([^"]+)"/g)) if (match[1].startsWith('/_next/')) assets.add(match[1]);
    console.log(JSON.stringify({ route, matchesBuiltArtifact: true }));
  }
  for (const asset of assets) {
    const response = await fetch(host + asset, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`Asset returned ${response.status}`);
    const live = Buffer.from(await response.arrayBuffer());
    const built = await fs.readFile(path.join(root, asset));
    if (hash(live) !== hash(built)) throw new Error('Live JavaScript does not match this build.');
  }
  console.log(JSON.stringify({ verifiedJavaScriptAssets: assets.size }));
  const names = ['createSale', 'settleSale', 'voidSale', 'publishOpenOrders', 'claimSalePayment'];
  if (proformas) names.push('issueProforma', 'payProforma', 'settleCustomerOrderByCode', 'generateEtr', 'setupEtims');
  if (process.argv.includes('--payments-stock')) names.push('initiateMpesaStk', 'queryMpesaStatus', 'checkCustomerOrderPayment', 'decideStockRequest');
  for (const name of names) {
    const response = await fetch(`https://europe-west1-vanbransa-pos.cloudfunctions.net/${name}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data: {} }), signal: AbortSignal.timeout(30_000),
    });
    const body = await response.json();
    if (![401, 403].includes(response.status) || !['UNAUTHENTICATED', 'PERMISSION_DENIED'].includes(body.error?.status)) throw new Error(`${name} did not reject an unauthenticated payment request correctly.`);
    console.log(JSON.stringify({ callable: name, authenticationEnforced: true }));
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
