import { test, expect } from '@playwright/test';
import { navigateTo, assertNoReactErrors, waitForContent } from './helpers.js';
import { findKataCcPod } from './cluster.js';

/**
 * Manual matrix C-35: /trustee/verify/:ns/:name redirects to overview query params.
 */
test.describe('C-35 Verify attestation redirect', () => {
  test('legacy verify URL redirects to /trustee?namespace=&name=', async ({
    page,
    baseURL,
  }) => {
    const pod = findKataCcPod();
    const ns = pod?.ns ?? 'default';
    const name = pod?.name ?? 'example-kata-cc-pod';

    await navigateTo(page, baseURL!, `/trustee/verify/${ns}/${name}`);
    await page.waitForURL(
      (u) =>
        u.pathname.includes('/trustee') &&
        !u.pathname.includes('/trustee/verify/'),
      { timeout: 60_000 },
    );
    // Assert the redirect carried the requested workload identity, not just that
    // the params exist — empty/wrong values would still satisfy a presence check.
    const params = new URL(page.url()).searchParams;
    expect(params.get('namespace')).toBe(ns);
    expect(params.get('name')).toBe(name);
    await waitForContent(page, /attestation|trustee|confidential|workload|reference/i, 120_000);
    await assertNoReactErrors(page);
  });
});
