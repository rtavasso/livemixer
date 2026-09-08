import { test, expect } from '@playwright/test';
test.beforeEach(async ({ page }) => { await page.goto('/?fixtures=1&tools=1'); await expect(page.locator('#start')).toBeEnabled(); });
test('sound shape clearly filters the instrumental bed while keeping vocals dry and bypass reversible', async ({ page }) => {
  const result = await page.evaluate(async () => { const path = '/tests/browser-harness.ts'; return (await import(path)).instrumentalTone(); });
  expect(result.low[0]).toBeLessThan(result.high[0] * .01);
  expect(result.low[1]).toBeCloseTo(result.high[1], 6);
  expect(result.bypass[0]).toBeCloseTo(.24 / Math.sqrt(2), 5);
  expect(result.bypass[1]).toBeCloseTo(result.low[1], 6);
});
test('same-start impulses and native loop markers align within one sample', async ({ page }) => {
  const result = await page.evaluate(async () => { const path = '/tests/browser-harness.ts'; return (await import(path)).alignment(); });
  for (const channel of result.positions) expect(channel).toEqual(result.expected); expect(result.playbackRates).toEqual([1, 1, 1]);
});
test('muted stems reappear at the current phase', async ({ page }) => {
  const result = await page.evaluate(async () => { const path = '/tests/browser-harness.ts'; return (await import(path)).mutePhase(); });
  expect(result.before).toBe(0); expect(result.error).toBeLessThan(1e-6);
});
test('native reset has zero scene overlap and the new native period', async ({ page }) => {
  const result = await page.evaluate(async () => { const path = '/tests/browser-harness.ts'; return (await import(path)).nativeReset(); });
  expect(result.oldAfter).toBe(0); expect(result.newBefore).toBe(0); expect(result.overlap).toBe(0); expect(result.nativeDuration).toBe(.6);
  expect(result.newMarkers[1] - result.newMarkers[0]).toBe(28800);
});
test('filter writes preserve recipe and exit envelopes', async ({ page }) => {
  const result = await page.evaluate(async () => { const path = '/tests/browser-harness.ts'; return (await import(path)).ownership(); });
  expect(result.recipe).toBeCloseTo(result.expected, 8); expect(result.fade).toBe(0); expect(result.afterPeak).toBe(0);
});
test('automation replacement fallback holds the actual ramp value', async ({ page }) => {
  const result = await page.evaluate(async () => { const path = '/tests/browser-harness.ts'; return (await import(path)).fallbackEnvelope(); });
  expect(result.held).toBe(.5); expect(result.actual).toBeCloseTo(.5, 5); expect(Math.abs(result.before - result.after)).toBeLessThan(.001); expect(result.end).toBe(0);
});
test('stop/restart disposes sources and rejects the old generation', async ({ page }) => {
  const result = await page.evaluate(async () => { const path = '/tests/browser-harness.ts'; return (await import(path)).stopRestart(); });
  expect(result).toEqual({ oldDisposed: true, decks: 1, sources: 3, generation: 3 });
});
test('source WAV metadata survives context resampling', async ({ page }) => {
  const result = await page.evaluate(async () => { const path = '/tests/browser-harness.ts'; const { assets } = await (await import(path)).fixtureAssets(44100); return Object.values(assets.scenes).map((s: any) => ({ duration: s.duration, frames: s.buffers.other.length, source: s.scene.sourceFrameCount })); });
  expect(result[0].source).toBe(192000); expect(Math.abs(result[0].frames - 352800)).toBeLessThanOrEqual(1); expect(result[0].duration).toBeCloseTo(8, 4);
});
test('all fixture recipes, seams, directed boundaries and edges have headroom', async ({ page }, info) => {
  test.setTimeout(180000);
  const result = await page.evaluate(async () => { const path = '/tests/browser-harness.ts'; return (await import(path)).fixtureHeadroom(); });
  await info.attach('fixture-headroom', { body: JSON.stringify(result, null, 2), contentType: 'application/json' });
  expect(result.cases).toBe(84); expect(result.worstDbfs).toBeLessThan(-1); expect(result.nonfinite).toBe(0);
});
test('local hand worker initializes and returns preserved frame metadata', async ({ page }) => {
  const result = await page.evaluate(async () => { const path = '/tests/browser-harness.ts'; return (await import(path)).workerSmoke(); });
  expect(result).toEqual({ valid: true, sequence: 17, observedAtMs: 1234, landmarks: 0 });
});
