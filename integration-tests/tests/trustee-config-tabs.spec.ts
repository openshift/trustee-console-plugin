import { test, expect } from '@playwright/test';
import { waitForContent, assertNoReactErrors } from './helpers.js';
import path from 'path';

const MODEL_REF = 'confidentialcontainers.org~v1alpha1~TrusteeConfig';
const authFile = path.join(__dirname, '..', '.auth', 'kubeadmin.json');

test.describe('TrusteeConfig horizontal nav tabs', () => {
  let configURL: string;

  test.beforeAll(async ({ browser }) => {
    const context = await browser.newContext({
      ignoreHTTPSErrors: true,
      storageState: authFile,
    });
    const page = await context.newPage();

    await page.goto(
      `${process.env.BRIDGE_BASE_ADDRESS}/trustee/config`,
      { waitUntil: 'load' },
    );

    await page.waitForURL((url) => url.pathname.includes(MODEL_REF), {
      timeout: 60_000,
    });
    configURL = page.url();
    await context.close();
  });

  const tabs = [
    { href: 'policies', content: /polic/i },
    { href: 'reference-values', content: /reference/i },
    { href: 'initdata', content: /init/i },
    { href: 'secrets', content: /secret/i },
    { href: 'gpu-attestation', content: /gpu|attestation/i },
    { href: 'health', content: /health/i },
  ];

  for (const tab of tabs) {
    test(`tab "${tab.href}" renders`, async ({ page }) => {
      const base = configURL.replace(/\/[^/]*$/, '');
      await page.goto(`${base}/${tab.href}`, { waitUntil: 'load' });
      await waitForContent(page, tab.content);
      await assertNoReactErrors(page);
    });
  }

  test('tab navigation links are visible on config page', async ({ page }) => {
    await page.goto(configURL, { waitUntil: 'load' });
    await waitForContent(page, /trusteeconfig|details/i);

    for (const tab of tabs) {
      const tabLink = page.locator(`a[href*="${tab.href}"], button`, {
        hasText: new RegExp(tab.href.replace(/-/g, '.'), 'i'),
      }).first();
      await expect(tabLink).toBeVisible({ timeout: 15_000 });
    }
  });
});
