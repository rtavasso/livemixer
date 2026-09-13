import { test, expect } from '@playwright/test';
import { existsSync } from 'node:fs';
test('speed changes keep all four stems phase aligned, including vocals unmuted later', async ({ page }) => {
  await page.goto('/?fixtures=1&tools=1'); await expect(page.locator('#start')).toBeEnabled();
  const r = await page.evaluate(async () => { const path = '/tests/browser-harness.ts'; return (await import(path)).rateAlignment(); });
  expect(r.error).toBeLessThan(1e-7); expect(r.phaseError).toBeLessThan(.0001); expect(r.mutedPeak).toBe(0);
  for (const speed of r.playbackRates) expect(speed).toBeCloseTo(.9, 6);
});
test('Sun retains instrumental harmonics through sparse, passage changes and speed changes', async ({ page }, info) => {
  test.skip(!existsSync('public/scenes/love-supreme-sun/manifest.json'), 'Local user recordings are absent.');
  await page.goto('/'); await expect(page.locator('#start')).toBeEnabled();
  await page.locator('#play-mode').selectOption('manual');
  const results = await page.evaluate(async () => { const path = '/tests/browser-harness.ts'; return (await import(path)).sunReactiveAudio(); });
  await info.attach('sun-reactive-audio', { body: JSON.stringify(results, null, 2), contentType: 'application/json' });
  for (const r of results) {
    expect(r.resets).toHaveLength(2); expect(r.resets.every((a: any) => a.recipe === 'sparse')).toBe(true); expect(r.resets[1].rate).toBe(1.1);
    expect(r.speedChanges).toBe(2); expect(r.mutedError).toBeLessThan(2e-6); expect(r.vocalDifference).toBeGreaterThan(.001);
    expect(r.nonfinite).toBe(0); expect(r.peakDbfs).toBeLessThan(-1);
    for (const b of r.bandsByPassage) { expect(b.dark).toBeGreaterThan(.00001); expect(b.dark / b.clear).toBeGreaterThan(.28); expect(b.dark / b.clear).toBeLessThan(.5); }
  }
});
test('main controls react within a beat and offer immediate changes and linked speed/pitch', async ({ page }) => {
  test.skip(!existsSync('public/scenes/love-supreme-sun/manifest.json'), 'Local user recordings are absent.');
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto('/'); await expect(page.locator('#start')).toBeEnabled();
  await page.locator('#play-mode').selectOption('manual');
  await expect(page.locator('#response-timing')).toHaveValue('beat');
  await page.locator('#start').click();
  await page.locator('#openness').fill('0'); await page.locator('#openness').dispatchEvent('input');
  await page.locator('#vocal-toggle').click(); await expect(page.locator('#current-recipe')).toHaveText('open', { timeout: 1200 });
  await page.locator('#vocal-toggle').click(); await expect(page.locator('#current-recipe')).toHaveText('sparse', { timeout: 1200 });
  await page.locator('#next').click(); await expect(page.locator('#scene-meta')).toContainText('Passage 2 of 3', { timeout: 1200 });
  await expect(page.locator('#current-recipe')).toHaveText('sparse');
  await page.locator('#response-timing').selectOption('immediate');
  await page.locator('#vocal-toggle').click(); await expect(page.locator('#current-recipe')).toHaveText('open', { timeout: 500 });
  await page.locator('#vocal-toggle').click(); await expect(page.locator('#current-recipe')).toHaveText('sparse', { timeout: 500 });
  await page.locator('.speed-control summary').click();
  await page.locator('#playback-rate').fill('1.1'); await page.locator('#playback-rate').dispatchEvent('input');
  await expect(page.locator('#rate-value')).toContainText('110% speed /', { timeout: 1000 });
  await expect(page.locator('#rate-value')).toContainText('+1.65 semitones');
  await page.locator('#next').click(); await expect(page.locator('#scene-meta')).toContainText('Passage 3 of 3', { timeout: 500 });
  await expect(page.locator('#rate-value')).toContainText('110% speed /');
  await page.locator('#rate-reset').click(); await expect(page.locator('#rate-value')).toContainText('100% speed /', { timeout: 500 });
  await expect(page.locator('#error')).toBeHidden(); expect(errors).toEqual([]);
  await page.locator('#stop').click();
  await page.screenshot({ path: 'test-results/reactive-controls.png', fullPage: true });
});

test('speed changes cancel future metronome clicks and let the current click finish', async ({ page }) => {
  await page.goto('/?fixtures=1&tools=1'); await expect(page.locator('#start')).toBeEnabled();
  const r = await page.evaluate(async () => { const path = '/tests/browser-harness.ts'; return (await import(path)).metronomeRateChange(); });
  expect(r.canceled).toBe(0); expect(r.completed).toBeGreaterThan(.00001); expect(r.tail).toBe(0);
});
