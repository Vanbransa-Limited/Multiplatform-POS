/**
 * The session gate must never show a login form to someone already signed in.
 *
 * Restoring a session dynamically imports the Firebase SDK and then waits on
 * auth state. The shell used to treat "not signed in yet" as "signed out", so
 * that window put the sign-in screen in front of the operator on every load and
 * every remount - which is what switching modules looked like.
 *
 * Runs against the built static export, so it checks what is actually shipped.
 */
const { chromium } = require('@playwright/test');
const { existsSync, readFileSync } = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const out = path.resolve(__dirname, '..', 'out');
const TYPES = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.txt': 'text/plain' };

(async () => {
  if (!existsSync(out)) {
    console.log('No build in frontend/out; run `npm run build` first. Skipping.');
    return;
  }
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

    await page.route('**/*', (route) => {
      const url = new URL(route.request().url());
      if (url.host !== 'pos.test') return route.abort();
      let file = path.join(out, url.pathname);
      if (url.pathname.endsWith('/')) file = path.join(file, 'index.html');
      if (!existsSync(file) || !path.extname(file)) {
        const asDir = path.join(out, url.pathname, 'index.html');
        file = existsSync(asDir) ? asDir : file;
      }
      if (!existsSync(file)) return route.fulfill({ status: 404, body: '' });
      return route.fulfill({ contentType: TYPES[path.extname(file)] || 'application/octet-stream', body: readFileSync(file) });
    });

    // Record which gate is on screen over the whole restore window. Firebase is
    // unreachable here, so the restore settles to "nobody is signed in".
    const seen = new Set();
    await page.goto('https://pos.test/till/', { waitUntil: 'commit' });
    for (let i = 0; i < 60; i += 1) {
      const state = await page.evaluate(() => {
        if (document.querySelector('.pos-boot')) return 'boot';
        if (document.querySelector('#pos-shell')) return 'shell';
        // The sign-in screen is the only other thing this layout renders.
        if (document.body.innerText.trim().length > 0) return 'signin';
        return 'blank';
      }).catch(() => 'blank');
      seen.add(state);
      if (state === 'signin' || state === 'shell') break;
      await page.waitForTimeout(100);
    }

    assert.ok(seen.has('boot'), `never showed the boot screen; saw ${[...seen].join(' -> ')}`);
    // Reaching a decision is fine; showing it before deciding is the defect.
    assert.ok(seen.has('signin') || seen.has('shell'), `never resolved the session; saw ${[...seen].join(' -> ')}`);

    console.log(`Boot screen check passed: gate went ${[...seen].join(' -> ')}, so the sign-in form only appears once the session is known.`);
  } finally {
    await browser.close();
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
