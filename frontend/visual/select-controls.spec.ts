import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';

async function setup(page: Page, width = 1200) {
  await page.setViewportSize({ width, height: 800 });
  await page.setContent(`<meta name="viewport" content="width=device-width, initial-scale=1"><style>body{margin:0;padding:24px;background:#0a0705;color:#f5ece0;font:14px Inter,sans-serif}form{max-width:340px}label{display:block;margin-bottom:8px}#after{margin-top:16px}</style><form><label for="category">Category</label><select id="category" name="category" required><option value="">Choose a category</option><optgroup label="Drinks"><option value="beer">Beers &amp; Ciders</option><option value="wine">Spirits &amp; Wines</option><option value="water">Soft Drinks &amp; Water</option><option value="whisky">Whisky</option><option value="gin">Gin</option><option value="vodka">Vodka</option><option value="rum">Rum</option><option value="retired" disabled>Retired product type</option></optgroup><optgroup label="Kitchen"><option value="food">Food &amp; Meals</option><option value="supplies">Consumables &amp; Supplies</option></optgroup></select><button type="button" id="after">Next field</button><button type="submit">Save</button><button type="reset">Reset</button></form>`);
  await page.addStyleTag({ content: readFileSync('public/select-control.css', 'utf8') });
  await page.addScriptTag({ content: `${readFileSync('public/select-control.js', 'utf8').replace('export function', 'function')}
    window.changed=0;window.submitted=0;
    document.querySelector('select').addEventListener('change',()=>window.changed++);
    document.querySelector('form').addEventListener('submit',event=>{event.preventDefault();window.submitted++});
    window.cleanupSelects=installSelectControls(document);
  ` });
}

test('searchable dropdown preserves native form values and emits one change', async ({ page }) => {
  await setup(page);
  const control = page.getByRole('combobox', { name: 'Category', exact: true });
  await control.click();
  await expect(page.getByRole('dialog', { name: 'Category', exact: true })).toBeVisible();
  await page.getByRole('searchbox', { name: 'Search Category' }).fill('whis');
  await expect(page.getByRole('option')).toHaveCount(1);
  await page.getByRole('option', { name: 'Whisky', exact: true }).click();
  await expect(control).toHaveText('Whisky');
  await expect(page.locator('#category')).toHaveValue('whisky');
  expect(await page.evaluate('new FormData(document.querySelector("form")).get("category")')).toBe('whisky');
  expect(await page.evaluate('window.changed')).toBe(1);
  await control.click();
  await expect(page.getByRole('option', { name: 'Retired product type' })).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(control).toBeFocused();
  await expect(control).toHaveText('Whisky');
  await control.click();
  await page.getByRole('option', { name: 'Whisky', exact: true }).click();
  expect(await page.evaluate('window.changed')).toBe(1);
  await page.getByRole('button', { name: 'Reset', exact: true }).click();
  await expect(control).toHaveText('Choose a category');
});

test('option updates, programmatic selection, disabled controls and validation stay synchronized', async ({ page }) => {
  await setup(page);
  const control = page.getByRole('combobox', { name: 'Category', exact: true });
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(control).toHaveAttribute('aria-invalid', 'true');
  await expect(page.getByRole('alert')).not.toBeEmpty();
  expect(await page.evaluate('window.submitted')).toBe(0);
  await page.evaluate(`document.querySelector('#category').add(new Option('New category','new'));document.querySelector('#category').value='new'`);
  await expect(control).toHaveText('New category');
  await expect(control).not.toHaveAttribute('aria-invalid');
  await page.evaluate(`document.querySelector('#category').options[1].selected=true`);
  await expect(control).toHaveText('Beers & Ciders');
  await page.evaluate(`document.querySelector('#category').disabled=true`);
  await expect(control).toBeDisabled();
  await page.evaluate(`document.querySelector('#category').disabled=false`);
  await control.click();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(control).toHaveText('Spirits & Wines');
  await control.focus();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Tab');
  await expect(page.locator('#after')).toBeFocused();
  await page.evaluate('window.cleanupSelects()');
  await expect(page.locator('.pos-select-trigger')).toHaveCount(0);
  await expect(page.locator('#category')).toBeVisible();
  await expect(page.locator('#category')).toHaveValue('wine');
});

test('unrelated rerenders and focus scrolling do not replace or dismiss open options', async ({ page }) => {
  await setup(page);
  const control = page.getByRole('combobox', { name: 'Category', exact: true });
  await control.click();
  const row = await page.getByRole('option', { name: 'Whisky', exact: true }).elementHandle();
  await page.evaluate(`for(let i=0;i<10;i++){document.querySelector('#category').style.opacity='1';document.querySelector('#category').options[0].selected=true;}document.dispatchEvent(new Event('scroll'));`);
  expect(await row!.evaluate(element => element.isConnected)).toBe(true);
  await page.getByRole('option', { name: 'Whisky', exact: true }).click();
  await expect(control).toHaveText('Whisky');
  await page.evaluate(`document.body.dataset.selectTheme='light'`);
  await expect(control).toHaveCSS('background-color', 'rgb(255, 255, 255)');
});

test('phone picker stays bounded, searches and opens above a parent dialog', async ({ page }) => {
  await setup(page, 360);
  await page.evaluate(`const form=document.querySelector('form');const parent=document.createElement('dialog');parent.style.width='300px';form.before(parent);parent.append(form);parent.showModal();`);
  const control = page.getByRole('combobox', { name: 'Category', exact: true });
  await control.click();
  const menu = page.locator('.pos-select-menu');
  await expect(menu).toBeVisible();
  const rect = await menu.boundingBox();
  expect(rect!.x).toBeGreaterThanOrEqual(0);
  expect(rect!.x + rect!.width).toBeLessThanOrEqual(361);
  expect(rect!.height).toBeLessThanOrEqual(800 * .82 + 2);
  await expect(page.getByRole('listbox', { name: 'Category', exact: true })).toBeFocused();
  await page.getByRole('searchbox', { name: 'Search Category' }).fill('nothing like this');
  await expect(page.getByRole('status')).toHaveText('No matching options');
  await page.getByRole('searchbox', { name: 'Search Category' }).fill('food');
  await page.getByRole('option', { name: 'Food & Meals', exact: true }).click();
  await expect(control).toHaveText('Food & Meals');
  await expect(page.locator('dialog[open]')).toHaveCount(1);
  await control.click();
  await page.screenshot({ path: 'visual/report/dropdown-phone.png' });
});

test('desktop picker is compact rather than expanding a long native menu', async ({ page }) => {
  await setup(page);
  await page.getByRole('combobox', { name: 'Category', exact: true }).click();
  const rect = await page.locator('.pos-select-menu').boundingBox();
  expect(rect!.width).toBeLessThanOrEqual(350);
  expect(rect!.height).toBeLessThanOrEqual(392);
  await page.screenshot({ path: 'visual/report/dropdown-desktop.png' });
});
