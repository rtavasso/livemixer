import { expect, test } from '@playwright/test';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';

test('hand effects remain audible with completely silent vocals, gate vocals, and stop all tails', async ({ page }, info) => {
  await page.goto('/?fixtures=1'); await expect(page.locator('#start')).toBeEnabled();
  const result = await page.evaluate(async () => { const path = '/tests/space-harness.ts'; return (await import(path)).spaceSynthetic(); });
  await info.attach('hand-space-waveforms', { body: JSON.stringify(result, null, 2), contentType: 'application/json' });
  for (const value of [result.entryDifference, result.heightDifference, result.depthDifference]) expect(value).toBeGreaterThan(.001);
  expect(result.inactiveVocalLeak).toBeLessThan(1e-7); expect(result.activeVocalDifference).toBeGreaterThan(.001);
  expect(result.stopTail).toBe(0); expect(result.settledDifference).toBeLessThan(result.releaseDifference);
  expect(result.peakDbfs).toBeLessThan(-1); expect(result.nonfinite).toBe(0);
  const tail = await page.evaluate(async () => { const path = '/tests/space-harness.ts'; return (await import(path)).spaceTailAndReset(); });
  expect(tail.naturalTail).toBeGreaterThan(.000001); expect(tail.afterExit).toBe(0); expect(tail.disposed).toBe(true);
});
test('Sun responds throughout all three passages with its vocal buffers silent', async ({ page }, info) => {
  test.skip(!existsSync('public/scenes/love-supreme-sun/manifest.json'), 'Local user recordings are absent.');
  test.setTimeout(120000);
  await page.goto('/?play=space'); await expect(page.locator('#start')).toBeEnabled();
  await expect(page.locator('#play-mode')).toHaveValue('space'); await expect(page.locator('#manual-playing')).toBeHidden();
  const results = await page.evaluate(async () => { const path = '/tests/space-harness.ts'; return (await import(path)).sunSpace(); });
  await info.attach('sun-hand-space', { body: JSON.stringify(results, null, 2), contentType: 'application/json' });
  for (const r of results) { expect(r.entryDifference).toBeGreaterThan(.001); expect(r.heightDifference).toBeGreaterThan(.001); expect(r.depthDifference).toBeGreaterThan(.001); expect(r.voiceDifference).toBeGreaterThan(.001); expect(r.peakDbfs).toBeLessThan(-1); expect(r.nonfinite).toBe(0); }
});
test('mouse, keyboard and touch preview have discoverable entry, stillness and withdrawal', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto('/?fixtures=1'); await expect(page.locator('#start')).toBeEnabled(); await page.locator('#play-mode').selectOption('space'); await page.locator('#start').click();
  const pad = page.locator('#space-pad'); await pad.scrollIntoViewIfNeeded(); const rect = (await pad.boundingBox())!;
  await page.mouse.move(rect.x + rect.width * .8, rect.y + rect.height * .2);
  await expect(page.locator('#space-presence')).toHaveText('Hand in space'); await expect(page.locator('#space-sound')).toHaveText('Echoes & cloud');
  await page.waitForTimeout(500); await expect(page.locator('#space-presence')).toHaveText('Hand in space');
  await page.mouse.move(2, 2); await expect(page.locator('#space-presence')).toHaveText('Instrumental bed');
  await pad.focus(); await page.keyboard.press('Space'); await page.keyboard.press('ArrowLeft'); await expect(page.locator('#space-presence')).toHaveText('Hand in space');
  await page.keyboard.press('Escape'); await expect(page.locator('#space-presence')).toHaveText('Instrumental bed');
  await page.locator('#space-height').fill('1'); await expect(page.locator('#space-height-value')).toHaveText('100%');
  await page.locator('#stop-all').click(); await expect(page.locator('#nodes')).toContainText('0 sources');
  await expect(page.locator('#space-presence')).toHaveText('Instrumental bed');
  await page.setViewportSize({ width: 430, height: 900 }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/hand-space-mobile.png', fullPage: true });
  expect(errors).toEqual([]);
});
test('Leap adapter handles fresh palms, short loss, stale frames, disconnect and saved bounds', async ({ page }) => {
  await page.addInitScript(() => {
    class FakeEvents {
      onmessage: ((e: { data: string }) => void) | null = null; onerror: (() => void) | null = null;
      constructor() { (window as any).__leap = this; } close() {}
    }
    (window as any).EventSource = FakeEvents;
    (window as any).leapFrame = (sequence: number, palms: unknown[], ageMs = 0) => (window as any).__leap.onmessage({ data: JSON.stringify({ type: 'frame', sequence, ageMs, sentAtMs: Date.now(), palms }) });
  });
  await page.goto('/?fixtures=1'); await expect(page.locator('#start')).toBeEnabled(); await page.locator('#play-mode').selectOption('space');
  await page.locator('#space-input').selectOption('leap'); await page.locator('#leap-connect').click(); await page.locator('#start').click();
  await page.evaluate(() => (window as any).leapFrame(1, [{ id: 1, x: 0, y: 420, z: -150, visibleMs: 100 }]));
  await expect(page.locator('#space-height-value')).toHaveText('100%'); await expect(page.locator('#space-depth-value')).toHaveText('100%');
  await page.evaluate(() => (window as any).leapFrame(2, [])); await expect(page.locator('#space-presence')).toHaveText('Hand in space');
  await expect(page.locator('#space-presence')).toHaveText('Instrumental bed', { timeout: 1500 });
  await page.evaluate(() => (window as any).leapFrame(3, [{ id: 1, x: 0, y: 120, z: 150 }], 500));
  await expect(page.locator('#space-height-value')).toHaveText('100%');
  await page.evaluate(() => (window as any).leapFrame(4, [{ id: 1, x: 0, y: 270, z: 0, visibleMs: 100 }]));
  await expect(page.locator('#space-height-value')).toHaveText('50%');
  await page.locator('#leap-disconnect').click(); await expect(page.locator('#leap-connect')).toBeEnabled();
  await expect(page.locator('#space-presence')).toHaveText('Instrumental bed');
  await page.locator('#setup-tab').click(); await page.locator('#setup-space > summary').click();
  await page.locator('#space-bound-top').fill('110'); await page.locator('#space-bounds-save').click(); await expect(page.locator('#space-bounds-status')).toContainText('at least 100 mm');
  await page.locator('#space-bound-top').fill('500'); await page.locator('#space-bounds-save').click(); await expect(page.locator('#space-bounds-status')).toContainText('Bounds saved');
  await page.reload(); await expect(page.locator('#space-bound-top')).toHaveValue('500');
});
test('real touch events enter, drag and withdraw without a stuck hand', async ({ browser, baseURL }) => {
  const context = await browser.newContext({ hasTouch: true, viewport: { width: 430, height: 900 } });
  const page = await context.newPage(), errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(`${baseURL}/?fixtures=1`); await expect(page.locator('#start')).toBeEnabled();
  await page.locator('#play-mode').selectOption('space'); await page.locator('#start').click();
  const pad = page.locator('#space-pad'); await pad.scrollIntoViewIfNeeded(); const rect = (await pad.boundingBox())!;
  const cdp = await context.newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: rect.x + 50, y: rect.y + 50, id: 1 }] });
  await expect(page.locator('#space-presence')).toHaveText('Hand in space');
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: rect.x + rect.width - 40, y: rect.y + 40, id: 1 }] });
  await expect(page.locator('#space-sound')).toHaveText('Echoes & cloud');
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await expect(page.locator('#space-presence')).toHaveText('Instrumental bed'); expect(errors).toEqual([]);
  await context.close();
});
test('hand space preserves control through immediate passage/speed changes and round-trips its trace', async ({ page }) => {
  test.skip(!existsSync('public/scenes/love-supreme-sun/manifest.json'), 'Local user recordings are absent.');
  await page.goto('/?tools=1&play=space'); await expect(page.locator('#start')).toBeEnabled(); await page.locator('#start').click();
  await page.locator('#space-height').fill('0.8'); await page.locator('#space-depth').fill('0.9');
  await expect(page.locator('#gain-vocals')).toContainText('% hand mix');
  await page.locator('#response-timing').selectOption('immediate'); await page.locator('.speed-control summary').click();
  await page.locator('#playback-rate').fill('1.1'); await expect(page.locator('#rate-value')).toContainText('110% speed /', { timeout: 1000 });
  for (const index of [2, 3]) {
    await page.locator('#next').click(); await expect(page.locator('#scene-meta')).toContainText(`Passage ${index} of 3`, { timeout: 500 });
    await expect(page.locator('#space-height-value')).toHaveText('80%'); await expect(page.locator('#space-presence')).toHaveText('Hand in space');
  }
  await page.locator('#stop-all').click(); await page.locator('#setup-tab').click();
  const downloadPromise = page.waitForEvent('download'); await page.locator('#trace-export').click();
  const file = await downloadPromise, text = await readFile((await file.path())!, 'utf8');
  const rows = text.trim().split('\n').map(line => JSON.parse(line));
  expect(rows.some(r => r.input?.type === 'space' && r.input.state.presence === 1)).toBe(true);
  expect(rows.every((r, i) => !i || r.atMs >= rows[i - 1].atMs)).toBe(true);
  await page.locator('#trace-file').setInputFiles({ name: 'hand-space.jsonl', mimeType: 'application/x-ndjson', buffer: Buffer.from(text) });
  await page.locator('#replay-verify').click(); await expect(page.locator('#replay-status')).toContainText('verification passed');
  await expect(page.locator('#error')).toBeHidden();
});
