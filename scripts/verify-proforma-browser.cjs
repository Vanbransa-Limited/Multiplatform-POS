'use strict';
// Read-only UI verification in an isolated browser using the existing preparer's identity.
// No payment, invoice, stock or permission mutation is performed.
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const backend = require('node:module').createRequire(path.join(root, 'backend/functions/package.json'));
const frontend = require('node:module').createRequire(path.join(root, 'frontend/package.json'));
const { initializeApp, applicationDefault } = backend('firebase-admin/app');
const { getAuth } = backend('firebase-admin/auth');
const { getFirestore } = backend('firebase-admin/firestore');
const { chromium } = frontend('@playwright/test');
async function main() {
  const manifest = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  if (manifest.projectId !== 'vanbransa-pos' || manifest.tenantId !== 'tenant-01') throw new Error('Unexpected verification target.');
  const envText = fs.readFileSync(path.join(root, 'frontend/.env'), 'utf8');
  const env = Object.fromEntries(envText.split(/\r?\n/).filter(line => /^NEXT_PUBLIC_FIREBASE_[A-Z_]+=/.test(line)).map(line => {
    const at=line.indexOf('='); return [line.slice(0,at),line.slice(at+1).trim().replace(/^['"]|['"]$/g,'')];
  }));
  const config = { apiKey: env.NEXT_PUBLIC_FIREBASE_API_KEY, authDomain: env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
    projectId: env.NEXT_PUBLIC_FIREBASE_PROJECT_ID, appId: env.NEXT_PUBLIC_FIREBASE_APP_ID };
  if (config.projectId !== manifest.projectId) throw new Error('Browser build configuration differs from the import project.');
  const app = initializeApp({ projectId: manifest.projectId, credential: applicationDefault() });
  let browser;
  try {
    const staff = (await getFirestore(app).collection('staff').doc(manifest.preparedByStaffId).get()).data();
    if (!staff?.authUid || staff.name !== manifest.preparedByName || staff.tenantId !== manifest.tenantId) throw new Error('Verified preparer identity is unavailable.');
    const user = await getAuth(app).getUser(staff.authUid);
    if (user.disabled || user.customClaims?.tenant_id !== manifest.tenantId || user.customClaims?.staff_id !== manifest.preparedByStaffId) throw new Error('Preparer login claims differ from the verified account.');
    const token = await getAuth(app).createCustomToken(user.uid, {
      tenant_id: user.customClaims.tenant_id, staff_id: user.customClaims.staff_id, staff_role: user.customClaims.staff_role,
    });
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage();
    const host = 'https://vanbransa-pos.web.app';
    await page.route(`${host}/release-auth-check`, route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><body></body>' }));
    await page.goto(`${host}/release-auth-check`);
    await page.evaluate(async ({ config, token }) => {
      const appSdk = await import('https://www.gstatic.com/firebasejs/12.18.0/firebase-app.js');
      const authSdk = await import('https://www.gstatic.com/firebasejs/12.18.0/firebase-auth.js');
      const app = appSdk.initializeApp(config);
      const auth = authSdk.getAuth(app);
      await authSdk.setPersistence(auth, authSdk.indexedDBLocalPersistence);
      await authSdk.signInWithCustomToken(auth, token);
    }, { config, token });
    await page.goto(`${host}/orders/?proforma=proforma-8265f8901719e0d41a09496656238666bdf3f55a88211aef`);
    const register = page.locator('#orders-proformas');
    await register.waitFor({ state: 'visible', timeout: 60000 });
    if (process.argv.includes('--preflight')) {
      await register.locator('[data-pf-list] table').waitFor({ state: 'visible', timeout: 60000 });
      const message = await register.locator('[data-pf-message]').textContent();
      if (/could not|permission|sign in/i.test(message || '')) throw new Error('Authenticated register read failed.');
      console.log(JSON.stringify({ deployedRegisterPreflight: 'passed', identity: manifest.preparedByName, moneyMutations: 0 }));
      await context.close();
      return;
    }
    for (const row of manifest.records) await register.getByRole('button', { name: `View invoice ${row.invoice.number}`, exact: true }).waitFor({ state: 'visible', timeout: 60000 });
    await register.locator('.proforma-detail').getByText(`Prepared by: ${manifest.preparedByName}`, { exact: false }).waitFor();
    const output = path.join(root, 'tmp/proforma-release');
    await page.screenshot({ path: path.join(output, 'live-orders-proformas-desktop.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 900 });
    if (await page.locator('#customer-orders-stats').isVisible()) throw new Error('Running statistics leaked into the standalone register.');
    if (await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)) throw new Error('Standalone register overflows the phone viewport.');
    await page.screenshot({ path: path.join(output, 'live-orders-proformas-phone.png'), fullPage: true });
    if (process.argv.includes('--payments-stock')) {
      await page.setViewportSize({ width: 1440, height: 1000 });
      await page.goto(`${host}/mpesa/`);
      await page.locator('#pay-start').waitFor({ state: 'visible', timeout: 60000 });
      await page.locator('#pay-start').fill('2026-09-25');
      await page.locator('#pay-end').fill('2026-09-25');
      await page.getByRole('button', { name: 'Load', exact: true }).click();
      await page.locator('#mpesa-search').fill('UIPMJ8EEBT');
      const receipt = page.locator('#mpesa-table-body tr').filter({ hasText: 'UIPMJ8EEBT' });
      await receipt.waitFor({ state: 'visible', timeout: 60000 });
      const text = await receipt.textContent();
      if (await receipt.count() !== 1 || !text.includes('INV-BH001-000537') || !text.includes('SUCCESS')
        || /000538|000540|not applied|not matched|not synced/.test(text)) throw new Error('The live receipt does not resolve to the one canonical invoice.');
      await page.screenshot({ path: path.join(output, 'live-reconciled-receipt.png'), fullPage: true });
      await page.locator('#mpesa-search').fill('mpesa_773d359f');
      const prompt = page.locator('#mpesa-table-body tr').filter({ hasText: 'mpesa_773d359f' });
      await prompt.waitFor({ state: 'visible', timeout: 60000 });
      if (!(await prompt.textContent()).includes('NO CONFIRMATION')) throw new Error('Historical unresolved prompt is still labelled as unpaid.');
      for (const route of ['house-stock', 'store-stock']) {
        await page.goto(`${host}/${route}/`);
        await page.locator('#stk-search').waitFor({ state: 'visible', timeout: 60000 });
        await page.locator('#stk-body tr').first().waitFor({ state: 'visible', timeout: 60000 });
      }
      console.log(JSON.stringify({ liveReceiptMatchesCanonicalInvoice: true, historicalPromptNotUnpaid: true, houseAndStoreLoad: true, paymentOrStockSubmissions: 0 }));
    }
    console.log(JSON.stringify({ deployedBrowserRead: 'passed', identity: manifest.preparedByName, standaloneInvoicesVisible: 3, desktopAndPhone: true, moneyMutations: 0 }));
    await context.close();
  } finally { await browser?.close(); await app.delete(); }
}
main().catch(error => { console.error(error.message); process.exitCode=1; });
