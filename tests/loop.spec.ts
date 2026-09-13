import { expect, test } from '@playwright/test';
import { existsSync } from 'node:fs';

test('decoded frame lengths keep playing the music across repeated loops at all supported speeds', async ({ page }, info) => {
  await page.goto('/?fixtures=1'); await expect(page.locator('#start')).toBeEnabled();
  const results = await page.evaluate(async () => { const path = '/tests/loop-harness.ts'; return (await import(path)).loopFidelity(); });
  await info.attach('loop-waveform-fidelity', { body: JSON.stringify(results, null, 2), contentType: 'application/json' });
  for (const result of results) {
    expect(result.nonfinite).toBe(0);
    for (const error of result.errors) expect(error, JSON.stringify(result)).toBeLessThan(.001);
  }
});

test('Sun plays through two live loop restarts without freezing a render block', async ({ page }, info) => {
  test.skip(!existsSync('public/scenes/love-supreme-sun/manifest.json'), 'Local user recordings are absent.');
  test.setTimeout(70000);
  await page.addInitScript(() => {
    const meters: AnalyserNode[] = [];
    const NativeContext = window.AudioContext;
    window.AudioContext = class extends NativeContext {
      createAnalyser() { const meter = super.createAnalyser(); meters.push(meter); return meter; }
    };
    (window as any).__loopMeters = meters;
  });
  await page.goto('/?collection=love-supreme-sun'); await expect(page.locator('#start')).toBeEnabled();
  await page.locator('#start').click();
  const readings = await page.evaluate(async () => {
    const meter = (window as any).__loopMeters[0] as AnalyserNode;
    const data = new Float32Array(512), rows: { at: number; loop: number; repeatedBlockError: number }[] = [];
    const config = JSON.parse((document.querySelector('#manifest-editor') as HTMLTextAreaElement).value);
    const scene = config.scenes[0], period = scene.sourceFrameCount / scene.sourceSampleRate;
    const until = meter.context.currentTime + period * 2 + 1;
    while (meter.context.currentTime < until) {
      await new Promise(resolve => setTimeout(resolve, 100));
      meter.getFloatTimeDomainData(data);
      let error = 0;
      for (let i = 128; i < data.length; i++) error += (data[i] - data[i - 128]) ** 2;
      rows.push({ at: meter.context.currentTime, loop: Number(document.querySelector('#bar')!.textContent!.match(/Loop (\d+)/)?.[1] ?? 0), repeatedBlockError: Math.sqrt(error / 384) });
    }
    return rows;
  });
  await page.locator('#stop-all').click();
  await info.attach('live-loop-readings', { body: JSON.stringify(readings, null, 2), contentType: 'application/json' });
  for (const loop of [1, 2, 3]) {
    const rows = readings.filter(r => r.loop === loop);
    expect(rows.length).toBeGreaterThan(2);
    // A frozen 128-frame block gives zero error on every subsequent reading.
    expect(rows.filter(r => r.repeatedBlockError > .0001).length / rows.length).toBeGreaterThan(.95);
  }
  await expect(page.locator('#error')).toBeHidden(); await expect(page.locator('#nodes')).toContainText('0 sources');
});
