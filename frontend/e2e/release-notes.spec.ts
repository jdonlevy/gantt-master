import { expect, test } from '@playwright/test';

test('loads release notes list and detail', async ({ page }) => {
  await page.goto('/release-notes');
  await expect(page.getByRole('heading', { name: 'Release Notes' })).toBeVisible();

  await expect(page.getByRole('link', { name: 'v3' })).toBeVisible();
  await page.getByRole('link', { name: 'v3' }).click();
  await expect(page.getByRole('heading', { name: 'Delivery Tracker – Release Notes v3' })).toBeVisible();
});
