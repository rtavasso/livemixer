import { expect, test, type Page } from '@playwright/test';
import { SIMULATIONS } from '../src/sim/host/registry';

/**
 * Browser checks for the simulation page. Chromium headless renders WebGL2
 * through SwiftShader, so this proves the shaders compile, the host loop
 * runs, and telemetry flows; it does not measure real-GPU performance.
 */
async function openSim(page: Page, query: string) {
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(`/sim.html?${query}`);
  await page.waitForFunction(() => !!window.livemixerSim?.host);
  return errors;
}
const state = (page: Page) => page.evaluate(() => {
  const s = window.livemixerSim.host.state();
  return { sim: s.simulation.id, hands: s.tracked.hands.length, presence: s.tracked.presence, signals: s.signals, violations: s.signalViolations, warnings: s.warnings.map(w => w.message), fps: s.perf.fps, sent: s.telemetry.sent, width: s.width, height: s.height };
});

test('every simulation renders with the synthetic performer and publishes signals without warnings', async ({ page }) => {
  test.setTimeout(120_000);
  const errors = await openSim(page, 'source=synthetic&overlay=0&quality=low&dpr=1');
  // The performer is present 11 of every 14 seconds; the tracker must actually see it.
  await page.waitForFunction(() => window.livemixerSim.host.state().tracked.presence > .5, null, { timeout: 20_000 });
  for (const sim of SIMULATIONS) {
    await page.evaluate(id => window.livemixerSim.host.selectSimulation(id), sim.id);
    await page.waitForTimeout(1500);
    const s = await state(page);
    expect(s.sim, sim.id).toBe(sim.id);
    expect(s.warnings, `${sim.id} warnings`).toEqual([]);
    expect(s.violations, `${sim.id} signal ranges`).toEqual([]);
    expect(Object.keys(s.signals).sort(), `${sim.id} signals`).toEqual(Object.keys(sim.signals).sort());
    for (const [name, value] of Object.entries(s.signals)) expect(Number.isFinite(value), `${sim.id}.${name} finite`).toBe(true);
    expect(s.width).toBeGreaterThan(0);
  }
  expect(errors).toEqual([]);
});

test('every simulation survives a GPU without float render targets (forced RGBA8 fallback)', async ({ page }) => {
  test.setTimeout(120_000);
  const errors = await openSim(page, 'source=synthetic&overlay=0&quality=low&dpr=1&forceRgba8=1');
  for (const sim of SIMULATIONS) {
    await page.evaluate(id => window.livemixerSim.host.selectSimulation(id), sim.id);
    await page.waitForTimeout(1200);
    const s = await state(page);
    expect(s.sim).toBe(sim.id);
    // Precision notices are expected on this path; anything that reads like a failure is not.
    expect(s.warnings.filter(w => /fail|error|could not|incomplete|retrying/i.test(w)), `${sim.id} warnings`).toEqual([]);
    expect(s.violations, `${sim.id} signal ranges`).toEqual([]);
    for (const [name, value] of Object.entries(s.signals)) expect(Number.isFinite(value), `${sim.id}.${name} finite`).toBe(true);
  }
  expect(errors).toEqual([]);
});

test('telemetry frames carry hands, gestures, params, and the schema answers requests', async ({ page }) => {
  await openSim(page, 'source=synthetic&overlay=0&sim=presence&quality=low&dpr=1');
  const result = await page.evaluate(() => new Promise<{ schema: unknown; frame: unknown; count: number }>(resolve => {
    const bus = window.livemixerSim.host.bus; let schema: unknown = null, count = 0, frame: unknown = null;
    bus.subscribe(m => { if (m.type === 'schema') schema = m; if (m.type === 'frame') { count++; frame = m; } if (count >= 20) resolve({ schema, frame, count }); });
    bus.receive({ type: 'get-schema' });
  }));
  const schema = result.schema as { sim: { id: string; params: Record<string, unknown>; signals: Record<string, unknown> }; sims: unknown[]; input: { gestures: string[] } };
  expect(schema.sim.id).toBe('presence'); expect(Object.keys(schema.sim.signals)).toContain('brightness'); expect(schema.sims.length).toBe(SIMULATIONS.length); expect(schema.input.gestures).toContain('swipe');
  const frame = result.frame as { sim: { params: Record<string, unknown>; signals: Record<string, number> }; input: { source: string; hands: unknown[]; presence: number }; perf: { fps: number } };
  expect(frame.input.source).toBe('synthetic'); expect(frame.sim.params.radius).toBeDefined(); expect(typeof frame.sim.signals.presence).toBe('number');
  expect(Array.isArray(frame.input.hands)).toBe(true);
});

test('inbound commands set parameters and switch simulations, persisting to settings', async ({ page }) => {
  await openSim(page, 'source=synthetic&overlay=0&sim=presence&quality=low&dpr=1');
  await page.evaluate(() => { const bus = window.livemixerSim.host.bus; bus.receive({ type: 'set-param', name: 'radius', value: .42 }); bus.receive({ type: 'set-param', name: 'radius', value: 'garbage' }); });
  expect(await page.evaluate(() => window.livemixerSim.host.currentParams.radius)).toBeCloseTo(.42, 5);
  const target = SIMULATIONS.find(s => s.id !== 'presence')!.id;
  await page.evaluate(id => window.livemixerSim.host.bus.receive({ type: 'select-sim', id }), target);
  await page.waitForTimeout(300);
  expect((await state(page)).sim).toBe(target);
  await page.evaluate(() => window.livemixerSim.settings.flush());
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('livemixer-sim-settings')!))).toMatchObject({ sim: target, params: { presence: { radius: .42 } } });
});

test('the telemetry monitor tab receives the stream over BroadcastChannel and can set a parameter', async ({ context }) => {
  const sim = await context.newPage();
  await openSim(sim, 'source=synthetic&overlay=0&sim=presence&quality=low&dpr=1');
  const monitor = await context.newPage();
  await monitor.goto('/telemetry.html');
  await expect(monitor.locator('h1')).toHaveText('Presence', { timeout: 10_000 });
  await expect(monitor.locator('.bar')).not.toHaveCount(0);
  const before = await sim.evaluate(() => window.livemixerSim.host.currentParams.radius);
  await monitor.locator('input[data-param="radius"]').fill('0.55');
  await sim.waitForFunction(() => window.livemixerSim.host.currentParams.radius === .55);
  expect(before).not.toBe(.55);
});

test('pointer source maps screen position into sim space and the overlay renders controls', async ({ page }) => {
  await openSim(page, 'source=pointer&overlay=1&sim=presence&quality=low&dpr=1');
  await page.setViewportSize({ width: 800, height: 600 });
  await page.mouse.move(700, 100); await page.mouse.move(720, 110); await page.waitForTimeout(250);
  const s = await page.evaluate(() => { const h = window.livemixerSim.host.state().tracked.hands[0]; return h ? { x: h.position.x, y: h.position.y } : null; });
  expect(s).not.toBeNull(); expect(s!.x).toBeGreaterThan(.8); expect(s!.y).toBeGreaterThan(.75);
  await expect(page.locator('#overlay')).toBeVisible();
  await expect(page.locator('#overlay select').first()).toHaveValue('presence');
  expect(await page.locator('#overlay .param').count()).toBeGreaterThan(0);
  expect(await page.locator('#overlay .signal').count()).toBe(Object.keys(SIMULATIONS.find(s => s.id === 'presence')!.signals).length);
});
