import { test, expect, type Page } from '@playwright/test';

test.use({ isMobile: true, hasTouch: true });

async function signInOwner(page: Page) {
  const issued = Math.floor(Date.now() / 1000);
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const token = `${encode({ alg: 'none', typ: 'JWT' })}.${encode({
    iss: 'https://securetoken.google.com/vanbransa-pos', aud: 'vanbransa-pos',
    sub: 'phone-owner', user_id: 'phone-owner', email: 'owner@phone.example',
    auth_time: issued, iat: issued, exp: issued + 3600,
    firebase: { identities: { email: ['owner@phone.example'] }, sign_in_provider: 'password' },
    tenant_id: 'tenant-01', staff_id: 'user-owner', staff_role: 'owner',
  })}.phone-test`;
  await page.route('**/identitytoolkit.googleapis.com/**', route => route.fulfill({ json: route.request().url().includes('signInWithPassword')
    ? { localId: 'phone-owner', email: 'owner@phone.example', displayName: 'Phone Owner', idToken: token, refreshToken: 'phone-refresh', expiresIn: '3600', registered: true }
    : { users: [{ localId: 'phone-owner', email: 'owner@phone.example', displayName: 'Phone Owner', providerUserInfo: [] }] } }));
  await page.route('**/securetoken.googleapis.com/**', route => route.fulfill({ json: { access_token: token, id_token: token, refresh_token: 'phone-refresh', expires_in: '3600', token_type: 'Bearer', user_id: 'phone-owner', project_id: 'vanbransa-pos' } }));
  await page.route('**/firestore.googleapis.com/**', route => route.abort());
  const mutations: string[] = [];
  await page.route('https://*.cloudfunctions.net/**', route => {
    const name = new URL(route.request().url()).pathname.split('/').pop()!;
    if (!['openShift', 'getMpesaCapability'].includes(name)) mutations.push(name);
    return route.fulfill({ json: { result: name === 'openShift' ? { shiftId: 'phone-shift' } : {} } });
  });
  await page.goto('/till/');
  await page.locator('#signin-email').fill('owner@phone.example');
  await page.locator('#signin-password').fill('phone-test-password');
  await page.getByRole('button', { name: /^sign in$/i }).click();
  await expect(page.locator('#pos-shell')).toBeVisible({ timeout: 30000 });
  return mutations;
}

async function fits(page: Page, selector: string) {
  const bounds = await page.locator(selector).evaluate(element => {
    const rect = element.getBoundingClientRect();
    return { left: rect.left, right: rect.right, width: document.documentElement.clientWidth };
  });
  expect(bounds.left, selector).toBeGreaterThanOrEqual(-1);
  expect(bounds.right, selector).toBeLessThanOrEqual(bounds.width + 1);
}

for (const width of [360, 390, 430]) {
  test(`phone ${width}: forms fit, sale stays available, More navigation works`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    const mutations = await signInOwner(page);
    await fits(page, '#till-search');
    const cartButton = await page.locator('#till-cart-toggle').boundingBox();
    expect(cartButton!.x + cartButton!.width).toBeGreaterThan(width - 30);
    expect(cartButton!.y).toBeGreaterThan(600);
    expect(cartButton!.y + cartButton!.height).toBeLessThan(844 - 60);
    await expect(page.locator('.till-cart-col')).toBeHidden();
    await page.getByRole('button', { name: /^View cart/ }).click();
    await expect(page.locator('.till-cart-col')).toBeVisible();
    await expect(page.locator('.till-catalogue-col')).toBeHidden();
    await expect(page.locator('#cart-customer-select + .pos-select-trigger')).toBeVisible();
    await fits(page, '#cart-customer-select + .pos-select-trigger');
    await page.getByRole('button', { name: /^Hide cart/ }).click();
    await expect(page.locator('#till-search')).toBeVisible();

    await page.goto('/settings/');
    await expect(page.locator('#set-establishment-name')).toBeVisible({ timeout: 30000 });
    await expect(page.locator('.stock-location-help')).not.toHaveAttribute('open');
    await page.getByText('How stock locations work', { exact: true }).click();
    await expect(page.locator('.stock-location-help')).toHaveAttribute('open');
    await page.getByText('How stock locations work', { exact: true }).click();
    await fits(page, '#set-establishment-name');
    await expect.poll(() => page.locator('#set-establishment-name').evaluate(element => parseFloat(getComputedStyle(element).fontSize))).toBeGreaterThanOrEqual(16);
    await expect.poll(() => page.locator('.settings-content').evaluate(element => element.getBoundingClientRect().width)).toBeGreaterThan(width - 40);
    await page.locator('[data-stab=staff]').click();
    await page.getByRole('button', { name: 'Staff actions', exact: true }).click();
    await page.locator('#add-user-btn').click();
    await expect(page.getByRole('dialog', { name: 'Staff actions' })).toHaveCount(0);
    await expect(page.locator('#user-name')).toBeVisible();
    await fits(page, '.staff-dialog');
    await page.locator('#user-name').fill('A long staff name that should fit the phone');
    await page.locator('#user-email').fill('someone@example.pos');
    await page.locator('#user-password').fill('test-password');
    await page.locator('#cancel-user-btn').click();

    await page.goto('/customers/');
    await expect(page.locator('#cust-name')).toBeVisible();
    await fits(page, '#cust-name');
    await page.locator('#cust-name').fill('Example customer');
    await page.locator('#cust-phone').fill('0712345678');
    await fits(page, '#cust-phone');

    await page.goto('/inventory/');
    await page.getByRole('button', { name: 'Menu actions', exact: true }).click();
    await page.locator('#ledg-add-prod-btn').click();
    await expect(page.getByRole('dialog', { name: 'Menu actions' })).toHaveCount(0);
    await expect(page.locator('#pe-name')).toBeVisible();
    await fits(page, '.product-editor-fields');
    await page.locator('#pe-name').fill('Phone form check');
    await page.locator('#pe-save-btn').scrollIntoViewIfNeeded();
    await fits(page, '#pe-save-btn');
    await expect(page.locator('#pe-cancel-btn')).toBeInViewport();
    await page.locator('#pe-cancel-btn').click();
    if (width === 390) {
      await page.locator('#ledg-search').fill('phone search');
      await expect(page.getByRole('button', { name: 'Menu actions', exact: true })).toBeVisible();
      await expect(page.locator('.mobile-filter-trigger')).toHaveCount(1);
      await page.getByRole('button', { name: 'Menu actions', exact: true }).click();
      const download = page.waitForEvent('download');
      await page.locator('#ledg-names-template-btn').click();
      expect((await download).suggestedFilename()).toBe('item-names-template.csv');
      await expect(page.getByRole('dialog', { name: 'Menu actions' })).toHaveCount(0);
      await page.getByRole('button', { name: 'Menu actions', exact: true }).click();
      const chooser = page.waitForEvent('filechooser');
      await page.locator('#ledg-import-btn').click();
      await (await chooser).setFiles([]);
      await expect(page.getByRole('dialog', { name: 'Menu actions' })).toHaveCount(0);
    }

    await page.getByRole('button', { name: /More/ }).click();
    await expect(page.getByRole('dialog', { name: 'All modules' })).toBeVisible();
    await fits(page, '.mnav-sheet');
    await expect(page.getByRole('button', { name: 'Close menu' })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'All modules' })).toHaveCount(0);
    await page.getByRole('button', { name: /More/ }).click();
    await page.locator('.mnav-sheet').getByRole('link', { name: /Settings/ }).click();
    await expect(page).toHaveURL(/\/settings\//);
    await expect(page.getByRole('dialog', { name: 'All modules' })).toHaveCount(0);
    await expect(page.locator('#set-establishment-name')).toBeVisible({ timeout: 30000 });
    expect(mutations).toEqual([]);
    await page.screenshot({ path: `visual/report/mobile-settings-${width}.png` });
  });
}

test('desktop keeps both till columns; tablet settings use the full width', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signInOwner(page);
  await expect(page.locator('.till-mobile-tabs')).toBeHidden();
  await expect(page.locator('.till-catalogue-col')).toBeVisible();
  await expect(page.locator('.till-cart-col')).toBeVisible();
  await expect(page.locator('.app-sidebar')).toBeVisible();
  await fits(page, '.till-grid');
  await page.setViewportSize({ width: 768, height: 1024 });
  await page.goto('/settings/');
  await expect(page.locator('#set-establishment-name')).toBeVisible({ timeout: 30000 });
  await fits(page, '.settings-content');
  await expect.poll(() => page.locator('.settings-content').evaluate(element => element.getBoundingClientRect().width)).toBeGreaterThan(700);
});
