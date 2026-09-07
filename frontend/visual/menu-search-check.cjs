/**
 * Search on the customer menu, ranked.
 *
 * Searching "Water" returned Coca-Cola, Fanta and a fruit juice above the
 * actual water, because those sit in a category called "Soft Drinks & Water"
 * and the filter matched the category name with no ordering applied. The
 * category is still worth searching - it is how somebody finds the wines - but
 * a product whose own name was typed has to come first.
 */
const { chromium } = require('@playwright/test');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '..');

// The menu from the reported screenshot, in the order the server returned it.
const menu = {
  name: 'Titanium',
  products: [
    { id: 'p1', name: 'Coca-Cola 300ml', sellPriceMinor: 10000, categoryId: 'soft', uom: 'BOTTLE', trackStock: false, soldOut: false },
    { id: 'p2', name: 'Fanta Orange 300ml', sellPriceMinor: 10000, categoryId: 'soft', uom: 'BOTTLE', trackStock: false, soldOut: false },
    { id: 'p3', name: 'Fresh Juice (glass)', sellPriceMinor: 20000, categoryId: 'soft', uom: 'GLASS', trackStock: false, soldOut: false },
    { id: 'p4', name: 'Mineral Water 500ml', sellPriceMinor: 7000, categoryId: 'soft', uom: 'BOTTLE', trackStock: false, soldOut: false },
    { id: 'p5', name: 'DRINKING WATER 500ML', sellPriceMinor: 10000, categoryId: 'general', uom: 'EACH', trackStock: false, soldOut: false },
    { id: 'p6', name: 'KERINGET SPARKLING WATER 1L', sellPriceMinor: 25000, categoryId: 'general', uom: 'EACH', trackStock: false, soldOut: false },
    { id: 'p7', name: 'WATERMELON JUICE', sellPriceMinor: 30000, categoryId: 'general', uom: 'EACH', trackStock: false, soldOut: false },
  ],
  categories: [{ id: 'soft', name: 'Soft Drinks & Water' }, { id: 'general', name: 'General' }],
  branches: [{ id: 'branch-01', name: 'Main' }],
};

(async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.route('https://menu.test/**', async (route) => {
      const pathname = new URL(route.request().url()).pathname;
      const file = pathname === '/menu.html' ? 'menu.html' : pathname === '/menu.js' ? 'menu.js' : null;
      if (file) {
        return route.fulfill({
          contentType: file.endsWith('.js') ? 'application/javascript' : 'text/html',
          body: readFileSync(path.join(root, 'public', file), 'utf8'),
        });
      }
      if (pathname === '/menu-config.js') {
        return route.fulfill({ contentType: 'application/javascript', body: 'window.MENU_CONFIG={baseUrl:"https://menu.test/api",tenantId:"tenant-01"};' });
      }
      if (pathname === '/api/getPublicMenu') return route.fulfill({ json: { result: menu } });
      return route.fulfill({ status: 404, body: '' });
    });

    await page.goto('https://menu.test/menu.html');
    assert.equal(await page.locator('.menu-card').count(), menu.products.length);

    await page.locator('#menu-search').fill('Water');
    const names = await page.locator('.menu-card .card-name, .menu-card .card-title, .menu-card h3').allInnerTexts()
      .catch(() => []);
    const shown = names.length
      ? names
      : (await page.locator('.menu-card').allInnerTexts()).map((text) => text.split('\n')[0].trim());

    // Everything still matches - the colas via their category - but the four
    // products actually called "water" have to come first.
    assert.equal(shown.length, 7, `expected the whole soft-drinks category to still match, got ${shown.length}`);
    const waterFirst = shown.slice(0, 4).map((n) => n.toLowerCase());
    for (const name of waterFirst) {
      assert.ok(name.includes('water'), `"${name}" outranked a product named water`);
    }
    // The cola matched only on its category, so it sits below all of them.
    const cola = shown.findIndex((n) => n.toLowerCase().includes('coca-cola'));
    assert.ok(cola >= 4, `Coca-Cola is at position ${cola + 1}, above the water`);

    // A word-start beats a match buried mid-name.
    const sparkling = shown.findIndex((n) => n.toLowerCase().includes('sparkling water'));
    const melon = shown.findIndex((n) => n.toLowerCase().includes('watermelon'));
    assert.ok(melon < cola, 'a name containing "water" should still beat a category-only match');
    assert.ok(sparkling < melon, '"SPARKLING WATER" should beat "WATERMELON" for the word "water"');

    console.log(`Menu search check passed: "${'Water'}" puts ${shown.slice(0, 4).join(', ')} above the category-only matches.`);
  } finally {
    await browser.close();
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
