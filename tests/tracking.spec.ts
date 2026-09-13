import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';

test('slow sensor frames, short losses and ID changes retain control; stale data and leaving the box release it', async ({ page }) => {
  await page.addInitScript(() => {
    class Events {
      onmessage: ((e: { data: string }) => void) | null = null; onerror: (() => void) | null = null;
      constructor(readonly url: string) { (window as any).__leap = this; }
      close() {}
    }
    (window as any).EventSource = Events;
    (window as any).sendLeap = (data: object) => (window as any).__leap.onmessage({ data: JSON.stringify({ sentAtMs: Date.now(), ...data }) });
  });
  await page.goto('/?fixtures=1'); await expect(page.locator('#start')).toBeEnabled();
  await page.locator('#play-mode').selectOption('space'); await page.locator('#space-input').selectOption('leap');
  await page.locator('#leap-connect').click(); await page.locator('#start').click();
  await page.evaluate(() => (window as any).sendLeap({ type: 'health', trackingFps: 7.2, cameraFps: 115, deviceStatus: 0, profile: 'bright-room', hintsAccepted: true }));
  await page.evaluate(async () => {
    for (let sequence = 1; sequence <= 7; sequence++) {
      (window as any).sendLeap({ type: 'frame', sequence, ageMs: 250, trackingFps: 7.2, palms: [{ id: 1, x: 0, y: 330, z: 0, visibleMs: 1000, type: 0 }] });
      await new Promise(resolve => setTimeout(resolve, 140));
    }
    (window as any).sendLeap({ type: 'frame', sequence: 8, ageMs: 150, trackingFps: 7.2, palms: [] });
  });
  await expect(page.locator('#space-presence')).toHaveText('Hand in space');
  await page.waitForTimeout(160); await expect(page.locator('#space-presence')).toHaveText('Hand in space');
  await page.evaluate(() => (window as any).sendLeap({ type: 'frame', sequence: 9, ageMs: 150, palms: [{ id: 9, x: 0, y: 335, z: 0, type: 0, visibleMs: 0 }] }));
  await expect(page.locator('#space-presence')).toHaveText('Hand in space');
  await expect(page.locator('#leap-quality')).toContainText('7.2 tracking FPS');
  await page.evaluate(() => (window as any).sendLeap({ type: 'frame', sequence: 10, ageMs: 150, palms: [{ id: 9, x: 400, y: 330, z: 0, type: 0 }] }));
  await expect(page.locator('#space-presence')).toHaveText('Instrumental bed');
  await expect(page.locator('#leap-quality')).toContainText('outside the box');
  await page.evaluate(() => (window as any).sendLeap({ type: 'frame', sequence: 11, ageMs: 700, palms: [{ id: 9, x: 0, y: 420, z: 0 }] }));
  await expect(page.locator('#space-presence')).toHaveText('Instrumental bed');
  await page.locator('#setup-tab').click(); await page.locator('#setup-space > summary').click();
  await expect(page.locator('#leap-details')).toContainText('Camera 115.0 FPS');
  await expect(page.locator('#leap-details')).toContainText('1 stale/invalid frames ignored');
  const downloadEvent = page.waitForEvent('download'); await page.locator('#leap-report').click();
  const file = await downloadEvent, report = JSON.parse(await readFile((await file.path())!, 'utf8'));
  expect(report.readings.length).toBeGreaterThan(2); expect(report.readings.some((r: any) => r.trackingFps === 7.2)).toBe(true);
  expect(report.readings.every((r: any) => !('palms' in r) && !('x' in r) && !('images' in r))).toBe(true);
  await page.locator('#leap-profile').selectOption('responsive');
  await page.locator('#instrument-tab').click(); await expect(page.locator('#leap-connect')).toBeEnabled();
  await page.locator('#leap-connect').click();
  expect(await page.evaluate(() => (window as any).__leap.url)).toContain('profile=responsive');
  await page.locator('#stop-all').click();
});

test('corrupt or delayed tracking messages do not kill the connection or produce a false hand', async ({ page }) => {
  await page.goto('/?fixtures=1'); await expect(page.locator('#start')).toBeEnabled();
  const result = await page.evaluate(async () => {
    let events: any;
    const Original = EventSource;
    (window as any).EventSource = class { close() {} constructor() { events = this; } };
    const path = '/src/control/leap.ts', { LeapAdapter } = await import(path);
    const frames: unknown[] = [], statuses: unknown[] = [];
    const adapter = new LeapAdapter((palms: unknown) => frames.push(palms), (message: string, failed: boolean) => statuses.push({ message, failed }));
    try {
      adapter.start(); events.onmessage({ data: '{broken' });
      const send = (data: object) => events.onmessage({ data: JSON.stringify({ type: 'frame', ageMs: 10, sentAtMs: Date.now(), ...data }) });
      send({ sequence: 1, palms: [{ id: 1, x: null, y: 200, z: 0 }] });
      send({ sequence: 2, palms: [], ageMs: 800 });
      send({ sequence: 3, palms: [{ id: 1, x: 0, y: 200, z: 0 }] });
      send({ sequence: 2, palms: [] });
      return { frames, statuses, rejected: adapter.health.rejected };
    } finally { adapter.stop(); (window as any).EventSource = Original; }
  });
  expect(result.frames).toHaveLength(1); expect(result.rejected).toBe(3);
  expect(result.statuses.every((s: any) => !s.failed)).toBe(true);
});

test('native Leap connection reports actual camera/tracking rates and exports a local diagnostic report', async ({ page }, info) => {
  test.skip(process.env.LIVEMIXER_NATIVE_LEAP !== '1', 'Opt in with a connected Leap sensor; no physical hand movement is needed.');
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('/'); await expect(page.locator('#start')).toBeEnabled();
  await page.locator('#space-input').selectOption('leap'); await page.locator('#leap-connect').click(); await page.locator('#start').click();
  try {
    await expect(page.locator('#leap-details')).toContainText(/Camera [\d.]+ FPS; tracking [\d.]+ FPS/, { timeout: 10000 });
    await expect(page.locator('#leap-details')).toContainText('request accepted');
    await page.waitForTimeout(2000);
    await page.locator('#setup-tab').click(); await page.locator('#setup-space > summary').click();
    const downloadEvent = page.waitForEvent('download'); await page.locator('#leap-report').click();
    const file = await downloadEvent, text = await readFile((await file.path())!, 'utf8'), report = JSON.parse(text);
    const measured = report.readings.filter((r: any) => r.cameraFps > 0 && r.trackingFps > 0);
    expect(measured.length).toBeGreaterThan(2);
    expect(measured.every((r: any) => Number.isFinite(r.frameAgeMs) && r.frameAgeMs >= 0)).toBe(true);
    await info.attach('native-tracking-report', { body: text, contentType: 'application/json' });
    await page.setViewportSize({ width: 430, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: 'test-results/tracking-health-mobile.png', fullPage: true });
    expect(errors).toEqual([]);
  } finally { await page.locator('#stop-all').click(); await page.locator('#instrument-tab').click(); await page.locator('#leap-disconnect').click(); }
});
