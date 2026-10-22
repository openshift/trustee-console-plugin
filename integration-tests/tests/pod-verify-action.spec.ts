import { test, expect } from '@playwright/test';
import { navigateTo, assertNoReactErrors, waitForContent } from './helpers.js';
import { findKataCcPod, ocAvailable } from './cluster.js';

/**
 * Manual matrix C-39: Pod Actions includes "Verify attestation" for kata-cc* pods.
 * Trustee action provider only — does not require CoCo plugin pages.
 */
test.describe('C-39 Pod Verify attestation action', () => {
  test('Actions menu lists Verify attestation for kata-cc pod', async ({
    page,
    baseURL,
  }) => {
    test.skip(!ocAvailable(), 'oc / KUBECONFIG required to locate a kata-cc pod');
    const pod = findKataCcPod();
    test.skip(!pod, 'No Running kata-cc* pod found');

    await navigateTo(page, baseURL!, `/k8s/ns/${pod!.ns}/pods/${pod!.name}`);
    await waitForContent(page, new RegExp(`${pod!.name}|Running|kata-cc|Status`, 'i'), 180_000);

    let actions = page.locator('button').filter({ hasText: /^Actions$/ });
    await expect(async () => {
      const n = await actions.count();
      let visible = false;
      for (let i = 0; i < n; i++) {
        if (await actions.nth(i).isVisible().catch(() => false)) {
          visible = true;
          break;
        }
      }
      expect(visible).toBeTruthy();
    }).toPass({ timeout: 60_000, intervals: [2_000] });

    const n = await actions.count();
    for (let i = 0; i < n; i++) {
      if (await actions.nth(i).isVisible().catch(() => false)) {
        await actions.nth(i).click();
        break;
      }
    }

    const items = page.locator('[role="menuitem"]');
    await expect(items.filter({ hasText: /Verify attestation/i }).first()).toBeVisible({
      timeout: 15_000,
    });
    await page.keyboard.press('Escape');
    await assertNoReactErrors(page);
  });
});
