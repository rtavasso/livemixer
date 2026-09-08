import { test, expect } from '@playwright/test';
import { existsSync } from 'node:fs';

test('clean launch asks for music instead of substituting test tones', async ({ page }) => {
  await page.route('**/scenes/default.local.json', route => route.fulfill({ status: 404, body: '' }));
  await page.goto('/'); await expect(page.locator('#empty-state')).toBeVisible();
  await expect(page.locator('#start')).toBeDisabled(); await expect(page.locator('#content-notice')).toBeHidden();
});

test('normal launch uses Sun and keeps tone, vocals, passages and studio tools distinct', async ({ page }) => {
  test.skip(!existsSync('public/scenes/love-supreme-sun/manifest.json'), 'Local recordings are not committed.');
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto('/'); await expect(page.locator('#start')).toBeEnabled();
  await expect(page.locator('#collection')).toContainText('LOVE SUPREME - Sun');
  await expect(page.locator('#performance-scene option')).toHaveCount(3);
  await expect(page.locator('#studio-tools')).not.toHaveAttribute('open', '');
  await expect(page.locator('#mapping')).toBeHidden(); await expect(page.locator('#load-fixtures')).toBeHidden();
  await expect(page.locator('#mapping')).toHaveValue('timbre_only'); await expect(page.locator('#content-notice')).toBeHidden();
  for (const index of [1, 2, 0]) {
    await page.locator('#performance-scene').selectOption({ index });
    await page.locator('#start').click(); await expect(page.locator('#nodes')).toContainText('4 sources');
    await expect(page.locator('#scene-meta')).toContainText(`Passage ${index + 1} of 3`);
    await page.locator('#openness').fill('1'); await page.locator('#openness').dispatchEvent('input');
    await expect(page.locator('#sound-amount')).toHaveText('100%'); await expect(page.locator('#desired-recipe')).toHaveText('sparse');
    await page.locator('#stop').click();
  }
  await page.locator('#start').click(); await page.locator('#vocal-toggle').click();
  await expect(page.locator('#voice-feedback')).toContainText('Vocals enter in');
  await page.locator('#openness').fill('0'); await page.locator('#openness').dispatchEvent('input');
  await expect(page.locator('#desired-recipe')).toHaveText('open');
  await page.locator('#vocal-toggle').click(); await expect(page.locator('#voice-feedback')).toContainText('instrumental keeps');
  await page.locator('#next').click(); await expect(page.locator('#passage-feedback')).toContainText('Next passage');
  await expect(page.locator('#next')).toBeDisabled(); await page.locator('#stop').click();
  await page.screenshot({ path: 'test-results/performance-simple.png', fullPage: true });
  await page.setViewportSize({ width: 430, height: 900 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/performance-phone.png', fullPage: true });
  await page.locator('#studio-tools > summary').click();
  await page.locator('#filter-max').fill('11000'); await page.locator('#apply-editor').click();
  await expect(page.locator('#load-status')).toContainText('Ready');
  const edited = JSON.parse(await page.locator('#manifest-editor').inputValue());
  expect(edited.scenes[0].filter.target).toBe('instrumental');
  await page.locator('#load-fixtures').click();
  await expect(page.locator('#content-notice')).toBeVisible(); await expect(page.locator('#content-notice')).toContainText('not musical passages');
  expect(errors).toEqual([]);
});
