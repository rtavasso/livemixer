import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
test('slider performance, desired/committed state, stop, and authoring gate', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto('/?fixtures=1&tools=1'); await expect(page.locator('#start')).toBeEnabled();
  await page.locator('#setup-tab').click(); await page.locator('#authoring').uncheck(); await expect(page.locator('#start')).toBeDisabled(); await expect(page.locator('#approval-status')).toContainText('review');
  await page.locator('#authoring').check(); await page.locator('#instrument-tab').click(); await page.getByRole('button', { name: 'Start audio', exact: true }).click();
  await expect(page.locator('#context-state')).toHaveText('Audio running'); await expect(page.locator('#nodes')).toContainText('3 sources');
  await page.locator('#openness').fill('1'); await page.locator('#openness').dispatchEvent('input');
  await expect(page.locator('#desired-recipe')).toHaveText('open'); await expect(page.locator('#current-recipe')).toHaveText('open', { timeout: 4000 });
  await expect(page.locator('#apply-editor')).toBeDisabled();
  await page.getByRole('button', { name: 'Stop', exact: true }).click(); await expect(page.locator('#nodes')).toContainText('0 sources');
  await expect(page.locator('#apply-editor')).toBeEnabled(); expect(errors).toEqual([]);
  await page.screenshot({ path: 'test-results/instrument-desktop.png', fullPage: true });
});
test('trace export and deterministic raw-control verification', async ({ page }) => {
  await page.goto('/?fixtures=1&tools=1'); await expect(page.locator('#start')).toBeEnabled(); await page.locator('#start').click();
  await page.locator('#setup-tab').click(); await page.locator('[data-recipe="open"]').click(); await expect(page.locator('#current-recipe')).toHaveText('open', { timeout: 4000 }); await page.locator('#stop-all').click();
  const downloadPromise = page.waitForEvent('download'); await page.locator('#trace-export').click(); const download = await downloadPromise;
  const text = await readFile((await download.path())!, 'utf8');
  await page.locator('#trace-file').setInputFiles({ name: 'trace.jsonl', mimeType: 'application/x-ndjson', buffer: Buffer.from(text) });
  await expect(page.locator('#replay-verify')).toBeEnabled(); await page.locator('#replay-verify').click();
  await expect(page.locator('#replay-status')).toContainText('verification passed'); await expect(page.locator('#error')).toBeHidden();
});
test('a missing user asset fails clearly and retains the loaded collection', async ({ page }) => {
  await page.goto('/?fixtures=1&tools=1'); await expect(page.locator('#start')).toBeEnabled();
  const manifest = JSON.parse(await readFile('public/fixtures/manifest.json', 'utf8')); manifest.scenes[0].stems.other.file = 'missing.wav';
  await page.locator('#manifest-file').setInputFiles({ name: 'manifest.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(manifest)) });
  await expect(page.locator('#error')).toContainText('missing.wav'); await expect(page.locator('#load-status')).toContainText('Load failed'); await expect(page.locator('#start')).toBeEnabled();
});
test('authoring edits invalidate approval and configuration can be exported', async ({ page }) => {
  await page.goto('/?fixtures=1&tools=1'); await expect(page.locator('#start')).toBeEnabled();
  await page.locator('#setup-tab').click(); await page.locator('#review-scene').check(); await page.locator('#approve-scene').click();
  await expect(page.locator('#load-status')).toContainText('approval saved');
  await page.locator('#filter-max').fill('7000'); await page.locator('#apply-editor').click();
  await expect(page.locator('#load-status')).toContainText('Ready'); await page.locator('#authoring').uncheck();
  await expect(page.locator('#approval-status')).toContainText('stale'); await expect(page.locator('#start')).toBeDisabled();
  const pending = page.waitForEvent('download'); await page.locator('#config-export').click(); expect((await pending).suggestedFilename()).toBe('manifest.json');
});
test('layout remains usable at a narrow width', async ({ page }) => {
  await page.setViewportSize({ width: 768, height: 1000 }); await page.goto('/?fixtures=1&tools=1'); await expect(page.locator('#start')).toBeEnabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/instrument-narrow.png', fullPage: true });
});
