import { test, expect, type Page } from '@playwright/test';

async function mockPlatform(page: Page, admin = true) {
  const issued = Math.floor(Date.now() / 1000);
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const token = `${encode({ alg: 'none', typ: 'JWT' })}.${encode({
    iss: 'https://securetoken.google.com/vanbransa-pos', aud: 'vanbransa-pos',
    sub: 'platform-test', user_id: 'platform-test', email: 'tech@vanbransa2.com',
    auth_time: issued, iat: issued, exp: issued + 3600,
    firebase: { identities: { email: ['tech@vanbransa2.com'] }, sign_in_provider: 'password' },
    ...(admin ? { platform_admin: true } : { tenant_id: 'tenant-01', staff_id: 'user-owner', staff_role: 'owner' }),
  })}.test-signature`;
  await page.route('**/identitytoolkit.googleapis.com/**', route => {
    if (route.request().url().includes('signInWithPassword')) return route.fulfill({ json: {
      localId: 'platform-test', email: 'tech@vanbransa2.com', idToken: token,
      refreshToken: 'test-refresh', expiresIn: '3600', registered: true,
    } });
    return route.fulfill({ json: { users: [{ localId: 'platform-test', email: 'tech@vanbransa2.com', emailVerified: true, providerUserInfo: [] }] } });
  });
  await page.route('**/securetoken.googleapis.com/**', route => route.fulfill({ json: { access_token: token, id_token: token, refresh_token: 'test-refresh', expires_in: '3600', token_type: 'Bearer', user_id: 'platform-test', project_id: 'vanbransa-pos' } }));
  const calls: Record<string, unknown>[] = [];
  await page.route('**/firestore.googleapis.com/**', route => route.abort());
  await page.route('https://*.cloudfunctions.net/**', route => {
    if (route.request().url().endsWith('/listPlatformTenants')) return route.fulfill({ json: { result: { tenants: [{ tenantId: 'tenant-01', businessName: 'Titanium', slug: 'titanium', ownerEmail: 'owner@example.com', status: 'active' }] } } });
    if (!route.request().url().endsWith('/createPlatformTenant')) return route.fulfill({ json: { result: { shiftId: 'test-shift' } } });
    const data = route.request().postDataJSON().data;
    calls.push(data);
    return route.fulfill({ json: { result: { tenantId: 'tenant-lakeside', ...data, status: 'active' } } });
  });
  return calls;
}

test('administrator creates a separate business; desktop and mobile layout', async ({ page }) => {
  const calls = await mockPlatform(page);
  await page.goto('/till/');
  await expect(page.getByRole('link', { name: 'Platform administrator sign in' })).toHaveCount(0);
  await page.locator('#signin-email').fill('tech@vanbransa2.com');
  await page.locator('#signin-password').fill('test-password-only');
  await page.getByRole('button', { name: /^sign in$/i }).click();
  await expect(page.getByRole('heading', { name: 'Add a business' })).toBeVisible();
  await expect(page).toHaveURL(/\/platform\//);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Add a business' })).toBeVisible();
  await expect(page.getByRole('row').filter({ hasText: 'Titanium' })).toBeVisible();
  await page.getByLabel('Business name', { exact: true }).fill('Lakeside Cafe');
  await page.getByLabel('Business identifier').fill('lakeside-cafe');
  await page.getByLabel('First branch name').fill('Main branch');
  await page.getByLabel('Owner name').fill('Cafe Owner');
  await page.getByLabel('Owner email').fill('owner@lakeside.example');
  await page.getByLabel('Initial password').fill('temporary-test-password');
  await page.getByLabel('Business logo').setInputFiles({ name: 'logo.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aG9sAAAAASUVORK5CYII=', 'base64') });
  await expect(page.getByAltText('Business logo preview')).toBeVisible();
  await page.screenshot({ path: 'visual/report/platform-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'visual/report/platform-mobile.png', fullPage: true });
  await page.getByRole('button', { name: 'Create business and owner' }).click();
  await expect(page.getByRole('heading', { name: 'Lakeside Cafe is ready' })).toBeVisible();
  expect(calls).toHaveLength(1);
  expect(calls[0].ownerEmail).toBe('owner@lakeside.example');
  expect(calls[0].logoUrl).toMatch(/^data:image\/png;base64,/);
  expect(calls[0].requestId).toBeTruthy();
  await expect(page.getByLabel('Initial password')).toHaveValue('');
  await expect(page.getByRole('row').filter({ hasText: 'Titanium' })).toBeVisible();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.locator('#signin-email')).toBeVisible();
});

test('tenant owner cannot enter platform onboarding', async ({ page }) => {
  const calls = await mockPlatform(page, false);
  await page.goto('/platform/');
  await expect(page).toHaveURL(/\/till\//);
  await page.locator('#signin-email').fill('owner@example.com');
  await page.locator('#signin-password').fill('test-password-only');
  await page.getByRole('button', { name: /^sign in$/i }).click();
  await expect(page.locator('#pos-shell')).toBeVisible();
  await page.goto('/platform/');
  await expect(page).toHaveURL(/\/till\//);
  await expect(page.locator('#pos-shell')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Add a business' })).toHaveCount(0);
  expect(calls).toHaveLength(0);
});
