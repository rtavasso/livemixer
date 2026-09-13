import { test, expect } from '@playwright/test';
import { existsSync } from 'node:fs';
test('Play stays focused and saved Sun combinations show only distinct sounds', async ({ page }) => {
  test.skip(!existsSync('public/scenes/love-supreme-sun/manifest.json'), 'Local recordings are absent.');
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto('/'); await expect(page.locator('#start')).toBeEnabled();
  await page.locator('#play-mode').selectOption('manual');
  await expect(page.locator('#instrument-tab')).toHaveText('Play'); await expect(page.locator('#library-tab')).toHaveText('Build mix');
  await expect(page.locator('#load-prepared')).toBeHidden(); await expect(page.locator('#author-panel')).toBeHidden();
  await page.locator('#setup-tab').click(); await expect(page.locator('#instrument-view')).toBeHidden();
  await page.locator('#setup-mixes > summary').click();
  await expect(page.locator('[data-recipe="sparse"]')).toHaveText(/Instrumental:/);
  await expect(page.locator('[data-recipe="open"]')).toHaveText(/With vocals:/);
  await expect(page.locator('[data-recipe="pulse"]')).toBeHidden();
  await expect(page.locator('[data-recipe="sparse"]')).toBeDisabled();
  await page.locator('#instrument-tab').click(); await page.locator('#start').click(); await page.locator('#setup-tab').click();
  await page.locator('[data-recipe="open"]').click(); await expect(page.locator('#current-recipe')).toHaveText('open', {timeout:1500});
  await page.locator('[data-recipe="sparse"]').click(); await expect(page.locator('#current-recipe')).toHaveText('sparse', {timeout:1500});
  await expect(page.locator('#gain-vocals')).toHaveText('muted');
  await page.locator('#stop-all').click(); await expect(page.locator('#nodes')).toContainText('0 sources');
  await page.screenshot({path:'test-results/setup-clear.png',fullPage:true});
  await page.locator('#instrument-tab').click(); await page.screenshot({path:'test-results/play-clear.png',fullPage:true});
  expect(errors).toEqual([]);
});
test('full-song action explains its purpose, preserves edits once open, and preview stops from every workspace', async ({ page }) => {
  test.skip(!existsSync('public/scenes/love-supreme-sun/manifest.json'), 'Local recordings are absent.');
  await page.goto('/'); await expect(page.locator('#start')).toBeEnabled();
  await page.locator('#play-mode').selectOption('manual');
  await page.locator('#library-tab').click();
  await expect(page.locator('#library-prepared')).toHaveText('Open full song & waveforms');
  await expect(page.locator('#prepared-source-help')).toContainText('already ready in Play');
  await expect(page.locator('#library-fixtures')).toBeHidden();
  await page.locator('#library-prepared').click(); await expect(page.locator('#library-prepared')).toHaveText('Full song is open', {timeout:30000});
  await expect(page.locator('#library-prepared')).toBeDisabled(); await expect(page.locator('#analyze-all')).toBeDisabled();
  await page.locator('#library-add').click(); await expect(page.locator('#mix-path .path-card')).toHaveCount(4);
  await page.locator('#instrument-tab').click(); await page.locator('#library-tab').click();
  await expect(page.locator('#mix-path .path-card')).toHaveCount(4); await expect(page.locator('#library-prepared')).toBeDisabled();
  await page.locator('#library-audition').click(); await expect(page.locator('#context-state')).toHaveText('Previewing selection');
  await page.locator('#setup-tab').click(); await page.locator('#stop-all').click(); await expect(page.locator('#stop-all')).toBeDisabled();
  await expect(page.locator('#selection-status')).toHaveText('Preview stopped.');
  await expect(page.locator('#error')).toBeHidden();
  await page.setViewportSize({width:430,height:900});
  for (const tab of ['instrument', 'library', 'setup']) {
    await page.locator(`#${tab}-tab`).click(); expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  }
});

test('Stop all cancels a library preview that is still decoding', async ({ page }) => {
  await page.goto('/?fixtures=1&tools=1'); await expect(page.locator('#start')).toBeEnabled();
  await page.locator('#setup-tab').click(); await page.locator('#library-fixtures').click();
  await page.evaluate(() => {
    const decode = AudioContext.prototype.decodeAudioData;
    AudioContext.prototype.decodeAudioData = function(data: ArrayBuffer) { return new Promise<AudioBuffer>((resolve, reject) => setTimeout(() => decode.call(this, data).then(resolve, reject), 350)); };
  });
  await page.locator('#library-audition').click(); await expect(page.locator('#selection-status')).toHaveText('Loading preview...');
  await page.locator('#stop-all').click(); await expect(page.locator('#selection-status')).toHaveText('Preview stopped.');
  await page.waitForTimeout(500); await expect(page.locator('#stop-all')).toBeDisabled();
  await expect(page.locator('#selection-status')).toHaveText('Preview stopped.');
});
