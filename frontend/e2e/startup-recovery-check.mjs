// Real static app and session provider, with stalled browser database startup.
// Every external request is blocked; no business session or provider is contacted.
import assert from 'node:assert/strict';
import { readFile, stat, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
const out = fileURLToPath(new URL('../out/', import.meta.url));
const screenshots = fileURLToPath(new URL('../../.tmp/startup-recovery/', import.meta.url));
await mkdir(screenshots, { recursive: true });
const browser = await chromium.launch();
try {
  for (const [name, viewport] of [['desktop', { width: 1366, height: 900 }], ['phone', { width: 390, height: 844 }]]) {
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();
    const pageErrors = [];
    const consoleErrors = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin !== 'http://127.0.0.1:38884') return route.abort();
      let file = path.resolve(out, `.${decodeURIComponent(url.pathname)}`);
      if (!file.startsWith(out)) return route.abort();
      try {
        if ((await stat(file)).isDirectory()) file = path.join(file, 'index.html');
        const contentType = ({ '.html':'text/html', '.js':'application/javascript', '.css':'text/css', '.json':'application/json', '.svg':'image/svg+xml', '.png':'image/png' })[path.extname(file)] || 'application/octet-stream';
        await route.fulfill({ contentType, body: await readFile(file) });
      } catch { await route.fulfill({ status: 404, body: '' }); }
    });
    await page.addInitScript(() => {
      if (!localStorage.getItem('saved-order-test')) localStorage.setItem('saved-order-test', 'kept across retry');
      indexedDB.open = () => ({});
      const delay = window.setTimeout.bind(window);
      window.setTimeout = (handler, milliseconds, ...args) => delay(handler, milliseconds === 20000 ? 100 : milliseconds, ...args);
    });
    await page.goto('http://127.0.0.1:38884/till/');
    const problem = page.getByRole('heading', { name:'Unable to open the till' });
    await problem.waitFor({ timeout: 20000 });
    assert.match(await page.locator('.pos-startup-problem').textContent(), /Saved orders remain on this device/);
    assert.ok(consoleErrors.some(message => message.includes('Opening the till took too long.')), 'the startup watchdog must handle the stalled browser database');
    const retry = page.getByRole('button', { name:'Try again' });
    await retry.waitFor({ state:'visible' });
    await page.screenshot({ path:path.join(screenshots, `${name}.png`), fullPage:true });
    assert.ok(await retry.evaluate(node => node.getBoundingClientRect().height) >= 44);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path:path.join(screenshots, `${name}.png`), fullPage:true });
    await Promise.all([page.waitForEvent('domcontentloaded'), retry.click()]);
    await problem.waitFor({ timeout:20000 });
    assert.equal(await page.evaluate(() => localStorage.getItem('saved-order-test')), 'kept across retry');
    assert.deepEqual(pageErrors, []);
    console.log(`${name}: stalled real session startup exposes recovery; Retry reloads and preserves stored work.`);
    await context.close();
  }
} finally { await browser.close(); }
