import { test as setup, expect } from '@playwright/test';
import path from 'path';

const authFile = path.join(__dirname, '.auth', 'kubeadmin.json');

setup('authenticate as kubeadmin', async ({ page, baseURL }) => {
  const password = process.env.BRIDGE_KUBEADMIN_PASSWORD;
  if (!password) {
    throw new Error('BRIDGE_KUBEADMIN_PASSWORD is required');
  }

  // Start at the Console login entrypoint rather than hand-building the OAuth
  // authorize URL: the Console sets the `state` query param and the `login-state`
  // cookie here, and its /auth/callback rejects requests that lack them (routing
  // to /auth/error). Driving the real entrypoint lets the full OAuth flow complete.
  await page.goto(`${baseURL}/auth/login`, { waitUntil: 'load' });

  const kubeLink = page.locator('a', { hasText: 'kube:admin' }).first();
  if (await kubeLink.isVisible({ timeout: 10_000 }).catch(() => false)) {
    await kubeLink.click();
  }

  await page.fill('input[name="username"], #inputUsername', 'kube:admin');
  await page.fill('input[name="password"], #inputPassword', password);
  await page.click('button[type="submit"]');

  await page.waitForURL((url) => !url.pathname.includes('/login'), {
    timeout: 60_000,
  });

  // A missing/invalid state cookie lands the callback on /auth/error; fail loudly
  // instead of saving an unauthenticated storage state.
  expect(page.url(), 'authentication landed on /auth/error').not.toContain('/auth/error');

  await page.goto(baseURL!, { waitUntil: 'load' });

  await expect(async () => {
    const body = await page.locator('body').innerText();
    expect(body.length).toBeGreaterThan(200);
  }).toPass({ timeout: 120_000, intervals: [2_000] });

  await page.context().storageState({ path: authFile });
});
