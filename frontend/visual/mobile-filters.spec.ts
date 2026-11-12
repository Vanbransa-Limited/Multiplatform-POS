import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

test('sliders button opens a native filter sheet; choices, reset and desktop controls stay functional', async ({ page }) => {
  await page.setContent('<meta name="viewport" content="width=device-width, initial-scale=1"><main class="app-main-content"><section id="test-screen" class="tab-view active"><div id="toolbar"><input placeholder="Search"></div><div id="choices"><button class="co-tab active" data-choice="all">All</button><button class="co-tab" data-choice="unpaid">Unpaid</button><button class="co-tab" data-choice="paid">Paid</button></div><input id="date" type="date"><p id="result">All orders</p></section></main>');
  await page.addStyleTag({ content: readFileSync('src/ui/styles.css', 'utf8') + readFileSync('src/ui/mobile.css', 'utf8') });
  const helper = readFileSync('src/ui/mobile-filters.js', 'utf8').replace('export function', 'function');
  await page.addScriptTag({ content: `${helper}
    let calls=0;
    document.querySelector('#choices').addEventListener('click',event=>{
      const button=event.target.closest('button'); if(!button)return;
      calls++; document.querySelectorAll('[data-choice]').forEach(item=>item.classList.toggle('active',item===button));
      document.querySelector('#result').textContent=button.textContent+' orders';
    });
    window.sheet = createMobileFilters({container:document.querySelector('#test-screen'),toolbar:document.querySelector('#toolbar'),controls:[document.querySelector('#choices'),document.querySelector('#date')],title:'Order filters',count:()=>Number(!document.querySelector('[data-choice=all]').classList.contains('active')),reset:()=>document.querySelector('[data-choice=all]').click()});
    window.filterCalls=()=>calls;
  ` });
  await expect(page.locator('#choices')).toBeHidden();
  const trigger = page.getByRole('button', { name: 'Order filters', exact: true });
  await expect(trigger.locator('svg')).toBeVisible();
  await trigger.click();
  await expect(page.getByRole('dialog', { name: 'Order filters' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Close filters' })).toBeFocused();
  await page.getByRole('button', { name: 'Unpaid', exact: true }).click();
  await page.locator('#date').fill('2026-11-10');
  await page.getByRole('button', { name: 'Show results' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0); // Closed native dialogs leave the accessibility tree.
  await expect(page.getByRole('button', { name: 'Order filters, 1 active' })).toBeFocused();
  await expect(page.locator('#result')).toHaveText('Unpaid orders');
  expect(await page.evaluate('filterCalls()')).toBe(1);
  await page.getByRole('button', { name: 'Order filters, 1 active' }).click();
  await expect(page.locator('#date')).toHaveValue('2026-11-10');
  await page.getByRole('button', { name: 'Reset', exact: true }).click();
  await page.keyboard.press('Escape');
  await expect(trigger).toBeVisible();
  await expect(page.locator('#result')).toHaveText('All orders');
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(trigger).toBeHidden();
  await expect(page.locator('#choices')).toBeVisible();
  await page.getByRole('button', { name: 'Paid', exact: true }).click();
  await expect(page.locator('#result')).toHaveText('Paid orders');
  expect(await page.evaluate('filterCalls()')).toBe(3);
});

test('action sheets close before an editor or file-picker handler runs', async ({ page }) => {
  await page.setContent('<meta name="viewport" content="width=device-width, initial-scale=1"><section id="actions-screen"><div id="toolbar"><input placeholder="Search"></div><button id="add">Add product</button><button id="import">Import file</button><div id="editor" hidden>Editor</div></section>');
  await page.addStyleTag({ content: readFileSync('src/ui/mobile.css', 'utf8') });
  const helper = readFileSync('src/ui/mobile-filters.js', 'utf8').replace('export function', 'function');
  await page.addScriptTag({ content: `${helper}
    window.calls=0;window.wasModal=true;
    document.querySelector('#add').onclick=()=>{window.calls++;window.wasModal=Boolean(document.querySelector('dialog[open]'));document.querySelector('#editor').hidden=false;};
    createMobileFilters({container:document.querySelector('#actions-screen'),toolbar:document.querySelector('#toolbar'),controls:[document.querySelector('#add'),document.querySelector('#import')],title:'Menu actions',buttonLabel:'Actions',closeOnSelect:true,doneLabel:'Done'});
  ` });
  await expect(page.locator('#add')).toBeHidden();
  await page.getByRole('button', { name: 'Menu actions', exact: true }).click();
  await page.getByRole('button', { name: 'Add product', exact: true }).click();
  await expect(page.locator('#editor')).toBeVisible();
  expect(await page.evaluate('window.wasModal')).toBe(false);
  expect(await page.evaluate('window.calls')).toBe(1);
  await page.getByRole('button', { name: 'Menu actions', exact: true }).click();
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(await page.evaluate('window.calls')).toBe(1);
});
