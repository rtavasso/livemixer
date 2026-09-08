import { test, expect } from '@playwright/test';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';

test('invalid and missing prepared collections show an error and allow fixture recovery', async ({ page }) => {
  await page.goto('/?collection=..%2Fsecret&tools=1');
  await expect(page.locator('#error')).toContainText('Invalid local collection ID');
  await page.locator('#load-fixtures').click(); await expect(page.locator('#start')).toBeEnabled();
  await page.route('**/scenes/missing-test-collection/manifest.json', route => route.fulfill({ status: 404, body: '' }));
  await page.goto('/?collection=missing-test-collection&tools=1');
  await expect(page.locator('#error')).toContainText('Prepared collection is missing');
  await page.locator('#load-fixtures').click(); await expect(page.locator('#start')).toBeEnabled();
});

test('prepared real stems play, measure with headroom, and restore their full-song library', async ({ page }) => {
  test.skip(!existsSync('public/scenes/love-supreme-sun/manifest.json'), 'User recordings are intentionally absent from a clean checkout.');
  test.setTimeout(180000);
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('/?collection=love-supreme-sun');
  await expect(page.locator('#start')).toBeEnabled(); await expect(page.locator('#collection')).toContainText('LOVE SUPREME - Sun');
  const manifest = JSON.parse(await page.locator('#manifest-editor').inputValue());
  expect(Object.keys(manifest.scenes[0].stems)).toHaveLength(4);
  expect(manifest.scenes[0].recipes.sparse.vocals).toBeNull();
  await page.locator('#start').click(); await expect(page.locator('#nodes')).toContainText('4 sources');
  await page.locator('#vocal-toggle').click();
  await expect(page.locator('#current-recipe')).toHaveText('open', { timeout: 30000 });
  await page.locator('#stop').click();
  await page.locator('#studio-tools > summary').click(); await page.locator('#render-all').click();
  await expect(page.locator('#render-status')).toContainText('Complete', { timeout: 90000 });
  await expect(page.locator('#render-status')).toContainText('0 failed');
  const reportEvent = page.waitForEvent('download'); await page.locator('#report-export').click();
  const reportDownload = await reportEvent; await reportDownload.saveAs('test-results/sun-measurements.json');
  const report = JSON.parse(await readFile('test-results/sun-measurements.json', 'utf8'));
  expect(report.completed).toBe(true); expect(report.results.every((r: any) => r.nonfinite === 0 && r.peakDbfs < -1)).toBe(true);
  await page.screenshot({ path: 'test-results/sun-instrument.png', fullPage: true });
  await page.locator('#library-tab').click(); await page.locator('#library-prepared').click();
  await expect(page.locator('#analysis-progress')).toContainText('Prepared song loaded', { timeout: 30000 });
  await expect(page.locator('#library-count')).toContainText('1 analyzed');
  await expect(page.locator('#song-detail')).toContainText('vocals');
  await expect(page.locator('#mix-path .path-card')).toHaveCount(3);
  await expect(page.locator('#library-bpm')).toHaveValue('88.778');
  await page.locator('#library-audition').click(); await expect(page.locator('#selection-status')).toContainText('Audition looping');
  await page.locator('[data-solo="vocals"]').click(); await page.locator('#library-stop').click();
  await page.screenshot({ path: 'test-results/sun-library.png', fullPage: true });
  await page.locator('#mix-load').click(); await expect(page.locator('#collection')).toContainText('LOVE SUPREME - Sun');
  await expect(page.locator('#error')).toBeHidden(); await expect(page.locator('#library-error')).toBeHidden(); expect(errors).toEqual([]);
});
