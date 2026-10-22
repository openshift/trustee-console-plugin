import { test } from '@playwright/test';
import { waitForContent, assertNoReactErrors } from './helpers.js';

test.describe('Trustee plugin pages load without errors', () => {
  const routes = [
    {
      name: 'Overview',
      path: '/trustee',
      content: /attestation overview|confidential workloads|reference values/i,
    },
    {
      name: 'Setup',
      path: '/trustee/setup',
      content: /trustee setup|before you begin|already deployed/i,
    },
    {
      name: 'Topology',
      path: '/trustee/topology',
      content: /attestation topology|cluster|hub/i,
    },
    {
      name: 'Activity',
      path: '/trustee/activity',
      content: /attestation activity|kbs|log entries/i,
    },
    {
      name: 'Config redirect',
      path: '/trustee/config',
      content: /trusteeconfig|policies|health|details/i,
    },
  ];

  for (const route of routes) {
    test(`${route.name} (${route.path}) renders`, async ({ page, baseURL }) => {
      await page.goto(`${baseURL}${route.path}`, { waitUntil: 'load' });
      await waitForContent(page, route.content);
      await assertNoReactErrors(page);
    });
  }

  test('Setup page is accessible without TrusteeConfig CRD flag', async ({ page, baseURL }) => {
    await page.goto(`${baseURL}/trustee/setup`, { waitUntil: 'load' });
    await waitForContent(page, /trustee setup|before you begin|already deployed/i);
    await assertNoReactErrors(page);
  });
});
