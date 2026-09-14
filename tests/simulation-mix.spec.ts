import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { SIMULATIONS } from '../src/sim/host/registry';

async function openMixer(page: Page, query = 'sim=presence&source=pointer') {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(`/?fixtures=1&play=simulation&quality=low&dpr=1&${query}`);
  await expect(page.locator('#start')).toBeEnabled();
  await page.waitForFunction(() => !!window.livemixerPerformance?.simulation.player?.host.latestOutput);
  return errors;
}
async function point(page: Page, x: number, y: number) {
  const canvas = page.locator('#simulation-panel .sim-stage'); await canvas.scrollIntoViewIfNeeded();
  const box = (await canvas.boundingBox())!;
  await page.mouse.move(box.x + box.width * x, box.y + box.height * y);
}

test('simulation signals reach the live audio graph independently of diagnostic telemetry', async ({ page }) => {
  const errors = await openMixer(page);
  await page.evaluate(() => window.livemixerPerformance.simulation.player!.host.setTelemetry({ rateHz: 1, broadcast: false, window: false }));
  await page.locator('#start').click(); await point(page, .8, .15);
  await page.waitForFunction(() => {
    const api = window.livemixerPerformance, s = api.session()!.space, audio = api.engine()!;
    return s.enabled && s.presence > .8 && s.height > .75 && audio.space.height > .75 && audio.decks[0]?.space.blend.valueAt(audio.context.currentTime) > .99;
  });
  const high = await page.evaluate(() => { const e = window.livemixerPerformance.engine()!; return e.decks[0].space.levels.other!.valueAt(e.context.currentTime); });
  await point(page, .8, .9);
  await page.waitForFunction(() => window.livemixerPerformance.session()!.space.height < .2);
  await expect.poll(() => page.evaluate(() => { const e = window.livemixerPerformance.engine()!; return e.decks[0].space.levels.other!.valueAt(e.context.currentTime); })).toBeLessThan(high - .2);
  const rms = await page.evaluate(() => {
    const samples = new Float32Array(512); window.livemixerPerformance.engine()!.meter.getFloatTimeDomainData(samples);
    return Math.sqrt(samples.reduce((sum, v) => sum + v * v, 0) / samples.length);
  });
  expect(rms).toBeGreaterThan(.0001);
  await page.locator('#stop-all').click(); await expect(page.locator('#nodes')).toContainText('0 sources');
  expect(errors).toEqual([]);
});

test('stalled and failed renderers release modulation, and switching modes reuses one player', async ({ page }) => {
  const errors = await openMixer(page, 'sim=presence&source=synthetic');
  await page.locator('#start').click();
  await page.waitForFunction(() => window.livemixerPerformance.session()!.space.presence > .5);
  await page.evaluate(() => window.livemixerPerformance.simulation.player!.host.stop());
  await page.waitForFunction(() => window.livemixerPerformance.session()!.space.presence === 0);
  expect(await page.evaluate(() => window.livemixerPerformance.session()!.state.running)).toBe(true);
  await page.locator('#play-mode').selectOption('manual');
  await expect(page.locator('#manual-playing')).toBeVisible();
  expect(await page.evaluate(() => window.livemixerPerformance.session()!.space.enabled)).toBe(false);
  await page.locator('#play-mode').selectOption('simulation');
  await page.waitForFunction(() => window.livemixerPerformance.session()!.space.presence > .5);
  const lost = await page.evaluate(() => {
    const host = window.livemixerPerformance.simulation.player!.host;
    const extension = host.gl.getExtension('WEBGL_lose_context'); extension?.loseContext(); return !!extension;
  });
  expect(lost).toBe(true);
  await page.waitForFunction(() => window.livemixerPerformance.session()!.space.presence === 0);
  await page.locator('#play-mode').selectOption('space');
  await expect(page.locator('#space-panel')).toBeVisible();
  await expect(page.locator('#simulation-panel .sim-stage')).toHaveCount(1);
  await page.locator('#stop-all').click(); expect(errors).toEqual([]);
});

test('all registered simulations run in the mixer with their own signal mappings', async ({ page }) => {
  test.setTimeout(120_000);
  const errors = await openMixer(page, 'sim=presence&source=synthetic');
  for (const sim of SIMULATIONS) {
    await page.evaluate(id => window.livemixerPerformance.simulation.player!.host.selectSimulation(id), sim.id);
    await page.waitForFunction(id => window.livemixerPerformance.simulation.player!.host.latestOutput?.simId === id, sim.id);
    const result = await page.evaluate(() => {
      const panel = window.livemixerPerformance.simulation, host = panel.player!.host;
      return { warnings: host.state().warnings, routes: panel.editor!.current().routes, state: window.livemixerPerformance.session()!.space };
    });
    expect(result.warnings, sim.id).toEqual([]);
    expect(Object.values(result.routes).every(r => r.source.startsWith('signal.'))).toBe(true);
    expect([result.state.presence, result.state.height, result.state.depth].every(v => Number.isFinite(v) && v >= 0 && v <= 1)).toBe(true);
  }
  await page.screenshot({ path: 'test-results/simulation-mixer.png', fullPage: true });
  await page.setViewportSize({ width: 430, height: 900 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});

test('studio promotion carries simulation parameters and mappings into the mixer, with explicit patch persistence', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto('/sim.html?sim=presence&source=synthetic&quality=low&dpr=1');
  await page.waitForFunction(() => !!window.livemixerSim?.host.latestOutput);
  await page.evaluate(() => window.livemixerSim.host.setParam('radius', .42));
  const patch = page.locator('.performance-patch'); await patch.locator('summary').click();
  await patch.locator('[data-patch-name]').fill('A room of light'); await patch.locator('[data-patch-name]').press('Tab');
  await patch.getByLabel('Echo & reverb signal', { exact: true }).selectOption('signal.brightness');
  await patch.getByRole('button', { name: 'Play in mixer', exact: true }).click();
  await page.waitForURL('**/?play=simulation');
  await page.waitForFunction(() => !!window.livemixerPerformance?.simulation.player?.host.latestOutput);
  const restored = await page.evaluate(() => window.livemixerPerformance.simulation.editor!.current());
  expect(restored.name).toBe('A room of light'); expect(restored.settings.params.presence.radius).toBe(.42);
  expect(restored.routes.space.source).toBe('signal.brightness');
  await page.locator('.performance-patch summary').click();
  const downloading = page.waitForEvent('download'); await page.locator('[data-export]').click();
  const downloaded = await downloading, text = await readFile((await downloaded.path())!, 'utf8');
  expect(JSON.parse(text)).toEqual(restored);
  const bad = structuredClone(restored); bad.routes.space.source = 'signal.removed';
  await page.getByLabel('Open performance patch', { exact: true }).setInputFiles({ name: 'invalid.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(bad)) });
  await expect(page.locator('.performance-patch [role="status"]')).toContainText('Unknown signal');
  expect(await page.evaluate(() => window.livemixerPerformance.simulation.editor!.current())).toEqual(restored);
  await page.reload(); await page.waitForFunction(() => !!window.livemixerPerformance?.simulation.editor);
  expect(await page.evaluate(() => window.livemixerPerformance.simulation.editor!.current().name)).toBe('A room of light');
  expect(errors).toEqual([]);
});

test('studio broadcasts cannot switch the simulation embedded in the mixer', async ({ page }) => {
  await openMixer(page);
  await page.evaluate(() => {
    const channel = new BroadcastChannel('livemixer-sim');
    channel.postMessage({ direction: 'inbound', message: { type: 'select-sim', id: 'veil' } }); channel.close();
  });
  await page.waitForTimeout(150);
  expect(await page.evaluate(() => window.livemixerPerformance.simulation.player!.host.simulation.id)).toBe('presence');
});

test('mapped simulation controls round-trip through the mixer trace and replay owns the controls', async ({ page }) => {
  await openMixer(page, 'sim=presence&source=synthetic&tools=1');
  await page.locator('#start').click();
  await page.waitForFunction(() => window.livemixerPerformance.session()!.space.presence > .5);
  await page.locator('#stop-all').click(); await page.locator('#setup-tab').click();
  const downloading = page.waitForEvent('download'); await page.locator('#trace-export').click();
  const downloaded = await downloading, text = await readFile((await downloaded.path())!, 'utf8');
  expect(text).toContain('"type":"space"');
  await page.locator('#trace-file').setInputFiles({ name: 'sim.jsonl', mimeType: 'application/x-ndjson', buffer: Buffer.from(text) });
  await page.locator('#replay-verify').click(); await expect(page.locator('#replay-status')).toContainText('verification passed');
  await page.locator('#replay-start').click();
  await expect(page.locator('#replay-status')).toContainText('replay');
  expect(await page.evaluate(() => window.livemixerPerformance.simulation.player!.host.latestOutput)).toBeNull();
  await expect(page.locator('#error')).toBeHidden();
});

test('fullscreen keeps playback reachable and the embedded player supports scoped keyboard controls', async ({ page }) => {
  const errors = await openMixer(page);
  await page.locator('#simulation-fullscreen').click();
  expect(await page.evaluate(() => document.fullscreenElement?.id)).toBe('simulation-panel');
  await page.locator('#simulation-start').click(); await expect(page.locator('#simulation-start')).toBeDisabled();
  await expect(page.locator('#simulation-stop')).toBeEnabled();
  const canvas = page.locator('#simulation-panel .sim-stage'); await canvas.focus(); await page.keyboard.press('h');
  await expect(page.locator('#simulation-panel .sim-overlay')).toBeVisible();
  await canvas.focus(); await page.keyboard.press('h'); await expect(page.locator('#simulation-panel .sim-overlay')).toBeHidden();
  await page.locator('#simulation-stop').click(); await expect(page.locator('#simulation-start')).toBeEnabled();
  await page.evaluate(() => document.exitFullscreen()); expect(errors).toEqual([]);
});

test('studio input recordings survive pause/resume and can be used to tune mappings', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('/sim.html?sim=presence&source=synthetic&quality=low&dpr=1');
  await page.waitForFunction(() => window.livemixerSim?.host.state().tracked.presence > .5);
  await page.evaluate(() => window.livemixerSim.host.startRecording());
  await page.waitForFunction(() => window.livemixerSim.host.recorder.length > 3);
  await page.evaluate(async () => {
    const host = window.livemixerSim.host, recording = host.stopRecording().join('');
    await host.setSource('replay', { recording }); host.selectSimulation('trails'); host.stop(); host.start();
  });
  await page.waitForFunction(() => window.livemixerSim.host.state().sourceId === 'replay' && window.livemixerSim.host.state().tracked.presence > .5);
  await page.locator('.performance-patch summary').click();
  await page.getByLabel('Engagement signal', { exact: true }).selectOption('signal.coverage');
  await page.locator('[data-save]').click();
  await expect(page.locator('.performance-patch [role="status"]')).toContainText('Replay files are not included');
  expect(await page.evaluate(() => window.livemixerSim.host.state().warnings)).toEqual([]);
  expect(errors).toEqual([]);
});
