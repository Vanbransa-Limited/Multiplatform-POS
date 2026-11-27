// Render the production card functions in disposable browsers; no business APIs.
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { mergeTabRounds, renderOrderCard, saleAsOrder, visibleOrders } from '../src/services/customer-orders.js';

const css = (await Promise.all(['styles', 'mobile'].map(name => readFile(new URL(`../src/ui/${name}.css`, import.meta.url), 'utf8')))).join('\n');
const screenshots = fileURLToPath(new URL('../../.tmp/counter-bill/', import.meta.url));
await mkdir(screenshots, { recursive: true });
const round = (id, amount, paid = false) => saleAsOrder({ id, sale_uuid: id, invoice_no: `INV-${id}`,
  tab_id: 'counter', order_reference: 'INV-original', branch_id: 'branch', status: 'COMPLETED',
  grand_total: amount, sold_at: '2026-11-27T16:16:00Z',
}, { payments: [{ method: paid ? 'CASH' : 'CREDIT', amount }], lines: [{ name: paid ? 'Coke' : 'Fanta Orange', qty: 1 }] });
const [bill] = mergeTabRounds([round('original', 100), round('added', 200, true)], []);
assert.equal(bill.dueMinor, 10000);
assert.equal(visibleOrders([bill], 'branch', { tab: 'running', search: 'INV-added' }).length, 1);
const browser = await chromium.launch();
try {
  for (const [name, viewport] of [['desktop', { width: 1366, height: 900 }], ['phone', { width: 390, height: 844 }]]) {
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();
    await page.route('**/*', route => {
      const url = new URL(route.request().url());
      return url.origin === 'http://127.0.0.1:38893' ? route.fulfill({ contentType: 'text/html', body: '<p>Bill selected</p>' }) : route.abort();
    });
    await page.goto('http://127.0.0.1:38893/');
    await page.setContent(`<meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style><body class="dark-mode"><main style="padding:20px"><div class="co-grid">${renderOrderCard(bill)}</div></main></body>`);
    await page.getByText('TAKEAWAY', { exact: false }).waitFor();
    assert.equal(await page.getByRole('link', { name: 'Add items', exact: true }).count(), 1);
    assert.match(await page.locator('.co-unpaid').textContent(), /100\.00 due/);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    const link = page.getByRole('link', { name: 'Add items', exact: true });
    await link.focus();
    assert.equal(await link.evaluate(node => document.activeElement === node), true);
    await page.screenshot({ path: `${screenshots}/${name}.png`, fullPage: true });
    await Promise.all([page.waitForURL('**/till?join=original&ref=INV-original'), link.press('Enter')]);
    const target = new URL(page.url());
    assert.equal(target.searchParams.get('join'), 'original');
    assert.equal(target.searchParams.has('table'), false);
    console.log(`${name}: combined counter bill remains Running, shows KES 100 due, and Add items opens its existing unpaid round.`);
    await context.close();
  }
} finally { await browser.close(); }
