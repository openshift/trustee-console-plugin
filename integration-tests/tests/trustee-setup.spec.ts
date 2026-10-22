import { test, expect } from '@playwright/test';
import { waitForContent, assertNoReactErrors } from './helpers.js';

const SETUP_CONTENT = /trustee setup|before you begin|already deployed/i;

test.describe('Trustee Setup wizard', () => {
  test.beforeEach(async ({ page, baseURL }) => {
    await page.goto(`${baseURL}/trustee/setup`, { waitUntil: 'load' });
    await waitForContent(page, SETUP_CONTENT);
  });

  test('page renders without errors', async ({ page }) => {
    await assertNoReactErrors(page);
  });

  test('shows "already deployed" alert when TrusteeConfig exists', async ({ page }) => {
    const alert = page.locator('[class*="alert"], [class*="Alert"]', {
      hasText: /already deployed|already.*TrusteeConfig/i,
    }).first();
    await expect(alert).toBeVisible({ timeout: 30_000 });
  });

  test('shows link to existing TrusteeConfig', async ({ page }) => {
    const link = page.getByText(/view existing trustee/i).first();
    await expect(link).toBeVisible({ timeout: 30_000 });
  });

  test('displays setup content', async ({ page }) => {
    const body = await page.locator('body').innerText().then((t) => t.toLowerCase());
    const hasSetupContent =
      body.includes('before you begin') ||
      body.includes('requirements') ||
      body.includes('trustee setup') ||
      body.includes('where will the confidential') ||
      body.includes('already deployed');
    expect(hasSetupContent, 'setup page should display wizard content').toBe(true);
  });
});
