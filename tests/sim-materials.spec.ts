import { expect, test } from '@playwright/test';
test.use({ deviceScaleFactor: 2 });

test('the GPU wave field rests, propagates a dip, and dissipates without saturating', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto('/sim.html?sim=presence&source=pointer&overlay=0&quality=low');
  await page.waitForFunction(() => !!window.livemixerSim?.host);
  const result = await page.evaluate(async () => {
    window.livemixerSim.host.stop();
    const [{ WAVE_FS, WAVE_GRID, WAVE_HEIGHT }, { PingPong }, { quadProgram, drawQuad }] = await Promise.all([
      import('../src/sim/sims/basin/waves'), import('../src/sim/gl/fbo'), import('../src/sim/gl/quad'),
    ]);
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2')!;
    const n = WAVE_GRID.low;
    const field = new PingPong(gl, n, n, 'rgba8', 'linear');
    const shader = quadProgram(gl, WAVE_FS, 'wave-behaviour-test');
    const forces = new Float32Array(32); forces.set([.5, .5, .025, -.04]);
    const pixels = new Uint8Array(n * n * 4);
    const step = (force: boolean) => {
      field.write.bind();
      shader.use().texture('u_wave', field.read.texture, 0).f2('u_texel', 1 / n, 1 / n)
        .f1('u_dt', 1 / 60).f1('u_bowl', .42).i1('u_forceCount', force ? 1 : 0).f4v('u_forces', forces);
      drawQuad(gl); field.swap();
    };
    const measure = () => {
      field.read.bind(); gl.readPixels(0, 0, n, n, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      let max = 0, sum = 0, distant = 0, clipped = 0;
      for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
        const i = (y * n + x) * 4, q = pixels[i] * 256 + pixels[i + 1];
        const h = (q - 32768) * WAVE_HEIGHT / 32767;
        max = Math.max(max, Math.abs(h)); sum += h * h;
        if (q <= 1 || q === 65535) clipped++;
        if (Math.hypot((x + .5) / n - .5, (y + .5) / n - .5) > .12) distant += h * h;
      }
      return { max, rms: Math.sqrt(sum / (n * n)), distant, clipped };
    };
    try {
      for (const f of [field.read, field.write]) f.clear(128 / 255, 0, 128 / 255, 0);
      for (let i = 0; i < 30; i++) step(false);
      const rest = measure();
      step(true); const dip = measure();
      for (let i = 0; i < 60; i++) step(false);
      const spread = measure();
      for (let i = 0; i < 600; i++) step(false);
      const calm = measure();
      return { rest, dip, spread, calm, glError: gl.getError() };
    } finally { shader.dispose(); field.dispose(); gl.getExtension('WEBGL_lose_context')?.loseContext(); }
  });
  expect(result.glError).toBe(0);
  expect(result.rest.max).toBe(0);
  expect(result.dip.max).toBeGreaterThan(.0003);
  expect(result.spread.distant).toBeGreaterThan(result.dip.distant + 1e-10);
  expect(result.spread.max).toBeLessThan(result.dip.max);
  expect(result.calm.rms).toBeLessThan(result.dip.rms * .25);
  for (const state of [result.dip, result.spread, result.calm]) expect(state.clipped).toBe(0);
});

test('Retina resizing stays inside the selected budget and keeps publishing', async ({ page }) => {
  await page.setViewportSize({ width: 2560, height: 1600 });
  await page.goto('/sim.html?sim=basin&source=synthetic&overlay=0&quality=medium&dpr=2');
  await page.waitForFunction(() => !!window.livemixerSim?.host.latestOutput);
  for (const [quality, budget] of [['medium', 1280 * 800], ['low', 800 * 600], ['high', 1920 * 1080]] as const) {
    await page.evaluate(q => window.livemixerSim.host.setQuality(q), quality);
    await page.waitForFunction(() => !!window.livemixerSim.host.latestOutput);
    const s = await page.evaluate(() => { const h = window.livemixerSim.host, s = h.state(); return { pixels: s.width * s.height, warnings: s.warnings, violations: s.signalViolations, glError: h.gl.getError() }; });
    expect(s.pixels).toBeLessThanOrEqual(budget);
    expect(s.warnings).toEqual([]); expect(s.violations).toEqual([]); expect(s.glError).toBe(0);
  }
});
