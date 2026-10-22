import { test, expect } from '@playwright/test';
import { navigateTo, assertNoReactErrors, waitForContent, mainText } from './helpers.js';

/**
 * Manual matrix C-38: Generate reference values modal.
 * Trustee-only — does not open CoCo/OSC plugin pages.
 */
test.describe('C-38 Generate reference values modal', () => {
  test('opens modal from Reference values tab', async ({ page, baseURL }) => {
    await navigateTo(page, baseURL!, '/trustee/config');
    await waitForContent(page, /TrusteeConfig|Reference values|Policies|trustee/i, 180_000);

    let url = page.url();
    if (url.includes('TrusteeConfig') && !url.includes('reference-values')) {
      const cleaned = url
        .split('?')[0]
        .replace(/\/$/, '')
        .replace(
          /\/(details|yaml|policies|health|initdata|secrets|gpu-attestation|reference-values)$/i,
          '',
        );
      await page.goto(`${cleaned}/reference-values`, {
        waitUntil: 'domcontentloaded',
        timeout: 120_000,
      });
    } else {
      const tab = page.getByRole('tab', { name: /Reference values/i }).first();
      if (await tab.isVisible({ timeout: 10_000 }).catch(() => false)) {
        await tab.click();
      }
    }

    await waitForContent(
      page,
      /Generate reference values|reference-values|veritas|empty by default|No reference values/i,
      240_000,
    );

    const btn = page.locator('button').filter({ hasText: /Generate reference values/i }).first();
    await expect(btn).toBeVisible({ timeout: 60_000 });
    await btn.click();
    const dialog = page.getByRole('dialog').first();
    await expect(dialog).toBeVisible({ timeout: 15_000 });
    await page.keyboard.press('Escape');
    await assertNoReactErrors(page);
    expect(await mainText(page)).toMatch(/reference/i);
  });
});
