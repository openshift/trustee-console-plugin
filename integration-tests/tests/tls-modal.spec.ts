import { test, expect } from '@playwright/test';
import { navigateTo, assertNoReactErrors, waitForContent } from './helpers.js';

/**
 * Manual matrix C-36: Generate TLS secret modal from Trustee setup.
 */
test.describe('C-36 Generate TLS secret modal', () => {
  test('opens Generate TLS secret modal when button is available', async ({
    page,
    baseURL,
  }) => {
    await navigateTo(page, baseURL!, '/trustee/setup');
    await waitForContent(page, /trustee setup|already deployed|Generate TLS|before you begin/i);

    const tlsBtn = page
      .locator('button, a')
      .filter({ hasText: /Generate TLS secret|generate.*tls/i })
      .first();
    const visible = await tlsBtn.isVisible({ timeout: 20_000 }).catch(() => false);
    test.skip(!visible, 'Generate TLS secret control not shown in current setup state');

    await tlsBtn.click();
    const dialog = page.getByRole('dialog').first();
    await expect(dialog).toBeVisible({ timeout: 15_000 });
    await expect(dialog).toContainText(/TLS|certificate|secret/i);
    await page.keyboard.press('Escape');
    await assertNoReactErrors(page);
  });
});
