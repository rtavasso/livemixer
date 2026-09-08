import { test, expect } from '@playwright/test';
import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { unzipSync, strFromU8 } from 'fflate';
test('browse, analyze, audition, connect, export and load an external stem library', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('/?fixtures=1&tools=1'); await expect(page.locator('#start')).toBeEnabled(); await page.locator('#library-tab').click(); await page.locator('#library-fixtures').click();
  await expect(page.locator('#song-list .song-card')).toHaveCount(2); await expect(page.locator('#library-count')).toContainText('2/2 songs');
  await page.locator('#analyze-all').click(); await expect(page.locator('#analysis-progress')).toContainText('Analysis complete', { timeout: 30000 });
  await expect(page.locator('#library-count')).toContainText('2 analyzed'); await expect(page.locator('#song-detail')).toContainText('RMS');
  await page.locator('#library-audition').click(); await expect(page.locator('#selection-status')).toContainText('Audition looping'); await page.locator('[data-solo="bass"]').click(); await page.locator('#library-stop').click();
  await page.locator('#library-add').click(); await page.locator('#song-list .song-card').nth(1).click(); await page.locator('#library-add').click();
  await expect(page.locator('#mix-path .path-card')).toHaveCount(2); await expect(page.locator('#mix-path .path-edge')).toHaveCount(1);
  const zipEvent = page.waitForEvent('download'); await page.locator('#mix-export').click(); const zipDownload = await zipEvent;
  const entries = unzipSync(new Uint8Array(await readFile((await zipDownload.path())!))); const config = JSON.parse(strFromU8(entries['manifest.json']));
  expect(config.scenes).toHaveLength(2); expect(config.scenes.every((s: any) => !s.approval.recipes)).toBe(true); expect(Object.keys(entries)).toHaveLength(7);
  const projectEvent = page.waitForEvent('download'); await page.locator('#library-save').click(); const project = await projectEvent;
  const projectBytes = await readFile((await project.path())!); await page.locator('[data-move="1"][data-direction="-1"]').click();
  await page.locator('#library-project').setInputFiles({ name: 'project.json', mimeType: 'application/json', buffer: projectBytes }); await expect(page.locator('#analysis-progress')).toContainText('Project restored');
  await expect(page.locator('#library-error')).toBeHidden(); await page.screenshot({ path: 'test-results/library-desktop.png', fullPage: true });
  await page.locator('#mix-load').click(); await expect(page.locator('#instrument-view')).toBeVisible(); await expect(page.locator('#collection')).toHaveText('My authored library mix');
  await page.locator('#start').click(); await expect(page.locator('#nodes')).toContainText('3 sources'); await page.locator('#stop').click();
  await page.locator('#filter-max').fill('6200'); await page.locator('#apply-editor').click(); await expect(page.locator('#load-status')).toContainText('Ready');
  await page.locator('#review-scene').check(); await page.locator('#approve-scene').click(); await expect(page.locator('#load-status')).toContainText('approval saved');
  await page.locator('#library-tab').click(); const tunedEvent = page.waitForEvent('download'); await page.locator('#library-save').click(); const tuned = JSON.parse(await readFile((await (await tunedEvent).path())!, 'utf8'));
  expect(tuned.performance.scenes[0].filter.maxHz).toBe(6200); expect(tuned.performance.scenes[0].approval.recipes).toBe(true);
  expect(errors).toEqual([]);
});
test('imports a 50-song folder through the real directory picker and cancels batch analysis', async ({ page }) => {
  const dir = resolve('test-results/generated-library-50');
  for (let i = 0; i < 50; i++) {
    const song = resolve(dir, `Song ${String(i + 1).padStart(2, '0')}`); await mkdir(song, { recursive: true });
    for (const stem of ['other', 'bass', 'drums']) await copyFile(`public/fixtures/fixture_1/${stem}.wav`, resolve(song, `${stem}.wav`));
  }
  await page.goto('/?fixtures=1&tools=1'); await expect(page.locator('#start')).toBeEnabled(); await page.locator('#library-tab').click();
  await page.locator('#library-folder').setInputFiles(dir); await expect(page.locator('#song-list .song-card')).toHaveCount(50, { timeout: 20000 });
  await expect(page.locator('#analyze-all')).toBeEnabled(); await page.locator('#analyze-all').click(); await page.locator('#analyze-cancel').click();
  await expect(page.locator('#analysis-progress')).toContainText('canceled'); await expect(page.locator('#analyze-all')).toBeEnabled(); await expect(page.locator('#library-error')).toBeHidden();
});
test('library search, invalid region and smaller layout give useful feedback', async ({ page }) => {
  await page.setViewportSize({ width: 768, height: 1000 }); await page.goto('/?fixtures=1&tools=1'); await expect(page.locator('#start')).toBeEnabled(); await page.locator('#library-tab').click(); await page.locator('#library-fixtures').click();
  await expect(page.locator('#song-list .song-card')).toHaveCount(2); await page.locator('#library-search').fill('fixture_2'); await expect(page.locator('#song-list .song-card')).toHaveCount(1);
  await page.locator('#library-bar').fill('999'); await page.locator('#library-bar').dispatchEvent('change'); await expect(page.locator('#library-add')).toBeDisabled(); await expect(page.locator('#selection-status')).toContainText('beyond');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); await page.screenshot({ path: 'test-results/library-narrow.png', fullPage: true });
});
