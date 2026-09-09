import { expect, test, type Page } from '@playwright/test';
import { SIMULATIONS } from '../src/sim/host/registry';
import { createTelemetrySink, type SinkClient } from '../scripts/telemetry-sink';
import { DEFAULT_LEAP_BOX } from '../src/sim/input/leap';
import { bridgeSkeleton, encodeOccupancy, PROTOCOL_VERSION, type BridgeSkeleton } from '../src/sim/input/protocol';
import { skeletonCapsules } from '../src/sim/input/skeleton';
import { surfaceFromCapsules } from '../src/sim/input/synthetic';

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

test('leap source tracks a hand from a fake Leap Motion service (v6 WebSocket protocol)', async ({ page }) => {
  // A stand-in for the Leap service: greets, then streams frames of a right hand sweeping to the performer's right and closing.
  const clients = new Set<SinkClient>();
  let frameId = 0;
  // The performance timeline starts when the page connects, so a slow page load under CI load cannot miss the open-hand phase.
  let started = Infinity;
  const sink = await createTelemetrySink({ port: 0, onOpen: client => { clients.add(client); started = Math.min(started, performance.now()); client.send({ serviceVersion: 'fake', version: 6 }); } });
  const timer = setInterval(() => {
    if (!clients.size) return;
    const t = (performance.now() - started) / 1000; frameId++;
    const x = -100 + Math.min(200, t * 200), grab = Math.min(1, Math.max(0, t - 2.5));
    const frame = {
      currentFrameRate: 100, id: frameId, timestamp: Math.round(performance.now() * 1000), // real microsecond timestamps, like the service
      hands: [{ id: 7, type: 'right', confidence: 1, grabStrength: grab, pinchStrength: 0, palmPosition: [x, 220, -30], palmVelocity: [200, 0, 0] }],
      pointables: [0, 1, 2, 3, 4].map(type => ({ id: 70 + type, handId: 7, type, tipPosition: [x + type * 10, 250, -60], extended: grab < .5, tool: false })),
    };
    for (const c of clients) c.send(frame);
  }, 10);
  try {
    const errors = await openSim(page, `source=leap&leap=ws://127.0.0.1:${sink.port}/v6.json&overlay=1&sim=presence&quality=low&dpr=1`);
    await page.waitForFunction(() => window.livemixerSim.host.state().tracked.hands.length === 1, null, { timeout: 15_000 });
    await page.waitForTimeout(600);
    // Under heavy CPU load a stalled frame can let the tracker drop and re-acquire the hand; wait for it to be present again.
    await page.waitForFunction(() => window.livemixerSim.host.state().tracked.hands.length === 1, null, { timeout: 15_000 });
    const early = await page.evaluate(() => { const h = window.livemixerSim.host.state().tracked.hands[0]; return { x: h.position.x, y: h.position.y, z: h.position.z, openness: h.openness, points: h.points.length, vx: h.velocity.x }; });
    const expectY = (220 - DEFAULT_LEAP_BOX.y[0]) / (DEFAULT_LEAP_BOX.y[1] - DEFAULT_LEAP_BOX.y[0]);
    expect(early.y).toBeGreaterThan(expectY - .1); expect(early.y).toBeLessThan(expectY + .1); // 220 mm inside the default box
    expect(early.z).toBeGreaterThan(.5);                                                         // z = −30 mm is toward the display: pushed in
    expect(early.points).toBe(6); expect(early.openness).toBeCloseTo(1, 1); expect(early.vx).toBeGreaterThan(0);
    await page.waitForFunction(() => { const h = window.livemixerSim.host.state().tracked.hands[0]; return !!h && h.openness < .2; }, null, { timeout: 15_000 });
    const late = await page.evaluate(() => { const s = window.livemixerSim.host.state(); return { x: s.tracked.hands[0].position.x, stats: s.tracked.stats, status: s.source?.status().state }; });
    const expectX = (100 - DEFAULT_LEAP_BOX.x[0]) / (DEFAULT_LEAP_BOX.x[1] - DEFAULT_LEAP_BOX.x[0]); // the hand stops at +100 mm
    expect(late.x).toBeGreaterThan(expectX - .08); expect(late.x).toBeLessThan(expectX + .08); expect(late.stats.leapHands).toBe(1); expect(late.status).toBe('running');
    await expect(page.locator('#overlay')).toContainText('Leap');
    expect(errors).toEqual([]);
  } finally { clearInterval(timer); for (const c of clients) c.close(); await sink.close(); }
});

/** A right hand in the bridge's box frame (u right, v down, w deep): palm at (u, v, w), fingers fanning upward, forearm below. */
function fakeBridgeSkeleton(u: number, v: number, w: number): BridgeSkeleton {
  const finger = (i: number) => {
    const du = (i - 2) * .035, len = i === 0 ? .09 : .13;
    const joints = [0, .3, .6, .85, 1].map(t => [u + du * t, v - .02 - len * t, w + .01 * t] as [number, number, number]) as BridgeSkeleton['fingers'][number]['joints'];
    return { joints, width: .028, extended: true };
  };
  return { type: 'right', palm: [u, v, w], wrist: [u, v + .08, w], elbow: [u, v + .2, w + .02], palmWidth: .13, armWidth: .085, fingers: [0, 1, 2, 3, 4].map(finger) };
}

test('depth source takes hand skeletons and the scan together from a fake bridge, and the solid setting selects between them', async ({ page }) => {
  test.setTimeout(90_000);
  // A stand-in for `depth_bridge.py --source leap`: hello announces skeletons and a small scan, then ~30 Hz frames of one
  // tracked hand drifting to the right, each with its skeleton and the scan a depth camera would make of that same hand.
  const SCAN = { width: 16, height: 12 };
  const clients = new Set<SinkClient>();
  let seq = 0, started = Infinity;
  const sink = await createTelemetrySink({ port: 0, onOpen: client => {
    client.send({ type: 'hello', version: PROTOCOL_VERSION, source: 'fake-leap', box: { x: [-.3, .3], y: [-.2, .2], z: [.1, .5] }, fps: 30, surface: SCAN, skeleton: true });
    clients.add(client); started = Math.min(started, performance.now());
  } });
  const timer = setInterval(() => {
    if (!clients.size) return;
    const t = (performance.now() - started) / 1000;
    const u = .4 + Math.min(.2, t * .05), v = .55, w = .3;
    const skeleton = fakeBridgeSkeleton(u, v, w);
    const surface = encodeOccupancy(surfaceFromCapsules(skeletonCapsules(bridgeSkeleton(skeleton)), SCAN.width, SCAN.height));
    const frame = { type: 'frame', seq: seq++, t: performance.now() / 1000, hands: [{ id: 1, pos: [u, v, w], conf: 1, extent: [[u - .1, v - .18, w], [u + .1, v + .1, w + .03]], openness: 1, pinch: 0, skeleton }], surface, stats: { fps: 30 } };
    for (const c of clients) c.send(frame);
  }, 33);
  const solidState = () => page.evaluate(() => {
    const s = window.livemixerSim.host.state(), h = s.tracked.hands[0], scan = s.tracked.surface;
    let scanned = 0; if (scan) for (let i = 0; i < scan.mask.length; i++) if (scan.mask[i]) scanned++;
    return { hands: s.tracked.hands.length, capsules: h?.capsules.length ?? 0, points: h?.points.length ?? 0, x: h?.position.x ?? -1, scanned, presence: s.tracked.presence, warnings: s.warnings.map(w => w.message), signals: s.signals, status: s.source?.status(), solid: s.solid, setting: window.livemixerSim.settings.value.solid };
  });
  try {
    const errors = await openSim(page, `source=depth&bridge=ws://127.0.0.1:${sink.port}&sim=presence&overlay=1&quality=low&dpr=1`);
    const solidHand = () => page.waitForFunction(() => { const h = window.livemixerSim.host.state().tracked.hands[0]; return !!h && h.capsules.length > 0 && !!window.livemixerSim.host.state().tracked.surface; }, null, { timeout: 20_000 });
    await solidHand();
    await page.waitForFunction(() => window.livemixerSim.host.state().tracked.presence > .5, null, { timeout: 15_000 });
    // Under heavy CPU load a stalled frame can let the tracker drop and re-acquire the hand; wait for it to be solid again.
    await solidHand();
    const both = await solidState();
    expect(both.hands).toBe(1);
    expect(both.capsules).toBe(21);                    // 5 fingers × 4 bones + forearm
    expect(both.points).toBe(6);                       // derived from the skeleton: palm + five tips
    expect(both.scanned).toBeGreaterThan(0);           // the scan arrived and mapped into the volume
    expect(both.x).toBeGreaterThan(.3); expect(both.x).toBeLessThan(.7); // the depth mapping mirrors u: a hand at u ≈ .4–.6 lands around the centre
    expect(both.status?.state).toBe('running'); expect(both.status?.message).toContain('skeleton');
    expect(both.solid).toBe('both'); expect(both.warnings).toEqual([]);
    await expect(page.locator('#overlay')).toContainText('sends hand skeletons');
    await expect(page.locator('#overlay')).toContainText('1 of 1 tracked hands solid');
    // The same bridge with the skeleton chosen as the solid: the scan is withheld from the simulation, which keeps rendering cleanly.
    await openSim(page, `source=depth&bridge=ws://127.0.0.1:${sink.port}&sim=presence&overlay=1&quality=low&dpr=1&solid=skeleton`);
    await solidHand();
    await page.waitForTimeout(1200);
    await solidHand();
    const skeletonOnly = await solidState();
    expect(skeletonOnly.setting).toBe('skeleton'); expect(skeletonOnly.solid).toBe('skeleton');
    expect(skeletonOnly.capsules).toBe(21); expect(skeletonOnly.scanned).toBeGreaterThan(0); // the tracker still holds everything; only the simulation's view changes
    expect(skeletonOnly.warnings).toEqual([]);
    for (const [name, value] of Object.entries(skeletonOnly.signals)) expect(Number.isFinite(value), `${name} finite`).toBe(true);
    expect(skeletonOnly.signals.presence).toBeGreaterThan(.3);
    await expect(page.locator('#overlay')).toContainText('simulation sees: skeleton');
    expect(errors).toEqual([]);
  } finally { clearInterval(timer); for (const c of clients) c.close(); await sink.close(); }
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
