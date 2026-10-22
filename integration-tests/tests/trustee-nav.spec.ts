import { test, expect } from '@playwright/test';
import { waitForConsoleReady, expandNavSection } from './helpers.js';

test.describe('Trustee nav section visibility', () => {
  test('Confidential Attestation section is present in admin nav', async ({ page, baseURL }) => {
    await page.goto(`${baseURL}/trustee`, { waitUntil: 'load' });
    await waitForConsoleReady(page);

    const nav = page.locator('nav');
    const navText = await nav.innerText();

    expect(navText).toContain('Confidential Attestation');
  });

  const navItems = [
    { name: 'Overview', href: '/trustee' },
    { name: 'Setup', href: '/trustee/setup' },
    { name: 'Attestation topology', href: '/trustee/topology' },
    { name: 'Attestation activity', href: '/trustee/activity' },
    { name: 'TrusteeConfig', href: '/trustee/config' },
  ];

  for (const item of navItems) {
    test(`nav item "${item.name}" is visible after expanding section`, async ({ page, baseURL }) => {
      await page.goto(`${baseURL}/trustee`, { waitUntil: 'load' });
      await waitForConsoleReady(page);

      await expandNavSection(page, 'Confidential Attestation');

      const link = page.locator(`nav a[href="${item.href}"]`).first();
      await expect(link).toBeVisible({ timeout: 15_000 });
    });
  }

  test('no JS console errors on Overview page', async ({ page, baseURL }) => {
    const jsErrors: string[] = [];
    page.on('pageerror', (err) => jsErrors.push(err.message));

    await page.goto(`${baseURL}/trustee`, { waitUntil: 'load' });
    await waitForConsoleReady(page);

    const criticalErrors = jsErrors.filter(
      (msg) => !msg.includes('ResizeObserver') && !msg.includes('Non-Error promise rejection'),
    );
    expect(criticalErrors, `unexpected JS errors: ${criticalErrors.join('; ')}`).toHaveLength(0);
  });
});
