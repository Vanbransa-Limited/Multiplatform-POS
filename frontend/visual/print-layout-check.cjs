/**
 * Guards the geometry the printer actually receives.
 *
 * Every receipt surface is `position: absolute; left: 0`, which resolves against
 * the nearest positioned ancestor. `.app-main-content` is `position: relative`,
 * so without the print rules that flatten the shell the receipt is laid out from
 * the left edge of the content column - 220px in, once the sidebar counts - at a
 * desktop width. A 58mm roll has roughly 384px of printable width, so the paper
 * came out blank. A scroll container in the chain clips long receipts too.
 *
 * This asserts what a printer would see, not what the screen looks like.
 */
const { chromium } = require('@playwright/test');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '..');
const css = readFileSync(path.join(root, 'src/ui/styles.css'), 'utf8');

/** Widest printable area of the 58mm roll in use, at 203dpi. */
const ROLL_WIDTH_PX = 384;

const page = (surfaceId) => `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head>
  <body class="dark-mode"><div id="pos-shell">
    <aside class="app-sidebar">nav</aside>
    <main class="app-main-content"><section class="tab-view active">
      <div id="${surfaceId}" class="receipt-paper-58" style="display:none">
        <div class="receipt-header"><h2>Titanium</h2></div>
        <div class="receipt-items"><div class="receipt-item-row"><span>Item</span><span>10.00</span></div></div>
      </div>
    </section></main>
    <nav class="mobile-nav"><a class="mnav-btn">Till</a></nav>
  </div></body></html>`;

(async () => {
  const browser = await chromium.launch();
  try {
    for (const surface of ['station-receipt-paper', 'receipt-paper-view']) {
      const tab = await browser.newPage({ viewport: { width: 1100, height: 900 } });
      await tab.setContent(page(surface));
      // The station reveals the surface for the duration of window.print().
      await tab.evaluate((id) => { document.getElementById(id).style.display = 'block'; }, surface);
      await tab.emulateMedia({ media: 'print' });

      const seen = await tab.evaluate((id) => {
        const el = document.getElementById(id);
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return {
          left: Math.round(rect.left),
          top: Math.round(rect.top),
          visibility: style.visibility,
          display: style.display,
          ink: [...el.querySelectorAll('*')].filter((n) => getComputedStyle(n).visibility === 'visible').length,
          widthMm: Math.round(rect.width / 96 * 25.4),
          smallestPx: Math.min(...[...el.querySelectorAll('*')].map((n) => parseFloat(getComputedStyle(n).fontSize)).filter(Boolean).concat(parseFloat(style.fontSize))),
          sidebar: getComputedStyle(document.querySelector('.app-sidebar')).display,
          nav: getComputedStyle(document.querySelector('.mobile-nav')).display,
        };
      }, surface);

      // The whole receipt has to start on the paper, not past its edge.
      assert.equal(seen.left, 0, `${surface} starts ${seen.left}px in; a ${ROLL_WIDTH_PX}px roll would clip it`);
      assert.equal(seen.top, 0, `${surface} starts ${seen.top}px down the page`);
      assert.equal(seen.visibility, 'visible', `${surface} is not visible to the printer`);
      assert.notEqual(seen.display, 'none', `${surface} is display:none while printing`);
      assert.ok(seen.ink > 0, `${surface} has no visible content`);
      // A page-relative width means the printer scales the receipt onto the
      // roll, and scaling is what made the type unreadable at 48mm.
      assert.equal(seen.widthMm, 48, `${surface} prints ${seen.widthMm}mm wide, not the roll's 48mm printable band`);
      assert.ok(seen.smallestPx >= 12, `${surface} has ${seen.smallestPx}px type; below 12px a thermal head smears it`);
      // Chrome that still occupies layout pushes blank pages onto the roll.
      assert.equal(seen.sidebar, 'none', 'the sidebar still takes layout when printing');
      assert.equal(seen.nav, 'none', 'the mobile nav still takes layout when printing');
      await tab.close();
    }
    console.log(`Print layout checks passed: receipt surfaces start at the page origin, stay visible, and the navigation chrome takes no space on a ${ROLL_WIDTH_PX}px roll.`);
  } finally {
    await browser.close();
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
