import { expect, test } from '@playwright/test';
test.use({ deviceScaleFactor: 2 });

test('corrected GPU ink transport retains detail without introducing pigment extrema', async ({ page }) => {
  await page.goto('/sim.html?sim=presence&source=pointer&overlay=0&quality=low');
  await page.waitForFunction(() => !!window.livemixerSim?.host);
  const results = await page.evaluate(async () => {
    window.livemixerSim.host.stop();
    const [{ advectDye, predictDye }, { Fbo, PingPong }, { quadProgram, drawQuad }, { PACKED_VELOCITY_SCALE }] = await Promise.all([
      import('../src/sim/sims/basin/shaders'), import('../src/sim/gl/fbo'), import('../src/sim/gl/quad'), import('../src/sim/sims/basin/model'),
    ]);
    const gl = document.createElement('canvas').getContext('webgl2')!;
    if (!gl.getExtension('EXT_color_buffer_float')) throw new Error('Test requires floating targets as well as the RGBA8 fallback.');
    const n = 96, dt = 1 / 60, steps = 50, requestedVelocity = 30 / n;
    try {
      return (['rgba16f', 'rgba8'] as const).map(format => {
        const packed = format === 'rgba8', zero = 128 / 255;
        const encodedVelocity = packed ? Math.round((zero + requestedVelocity / PACKED_VELOCITY_SCALE) * 255) / 255 : requestedVelocity;
        const velocity = packed ? (encodedVelocity - zero) * PACKED_VELOCITY_SCALE : requestedVelocity;
        const flow = new Fbo(gl, n, n, format);
        const prediction = new Fbo(gl, n, n, format);
        const field = new PingPong(gl, n, n, format);
        const predict = quadProgram(gl, predictDye(packed), 'test.ink-predict');
        flow.clear(encodedVelocity, packed ? zero : 0, 0, 1);
        const run = (corrected: boolean) => {
          const shader = quadProgram(gl, advectDye(packed, corrected), 'test.ink-transport');
          try {
            field.clear(); field.read.bind();
            gl.enable(gl.SCISSOR_TEST); gl.scissor(24, 46, 3, 3);
            gl.clearColor(1, 1, 1, 1); gl.clear(gl.COLOR_BUFFER_BIT); gl.disable(gl.SCISSOR_TEST);
            for (let i = 0; i < steps; i++) {
              if (corrected) {
                prediction.bind();
                predict.use().texture('u_dye', field.read.texture, 0).texture('u_velocity', flow.texture, 1).f1('u_dt', dt).f1('u_bowl', .72);
                drawQuad(gl);
              }
              field.write.bind();
              shader.use().texture('u_dye', field.read.texture, 0).texture('u_velocity', flow.texture, 1)
                .texture('u_prediction', prediction.texture, 2).f2('u_texel', 1 / n, 1 / n)
                .f1('u_dt', dt).f1('u_bowl', .72).f1('u_fade', 1).f1('u_fadeFloor', 0).i1('u_dropCount', 0);
              drawQuad(gl); field.swap();
            }
            field.read.bind();
            const pixels = packed ? new Uint8Array(n * n * 4) : new Float32Array(n * n * 4);
            gl.readPixels(0, 0, n, n, gl.RGBA, packed ? gl.UNSIGNED_BYTE : gl.FLOAT, pixels);
            let min = Infinity, peak = 0, mass = 0, moment = 0, second = 0;
            for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
              const value = pixels[(y * n + x) * 4] / (packed ? 255 : 1);
              min = Math.min(min, value); peak = Math.max(peak, value);
              mass += value; moment += value * x; second += value * x * x;
            }
            const centre = moment / mass;
            return { min, peak, centre, variance: second / mass - centre * centre, glError: gl.getError() };
          } finally { shader.dispose(); }
        };
        try { return { format, expectedCentre: 25 + velocity * dt * steps * n, basic: run(false), corrected: run(true) }; }
        finally { predict.dispose(); flow.dispose(); prediction.dispose(); field.dispose(); }
      });
    } finally { gl.getExtension('WEBGL_lose_context')?.loseContext(); }
  });
  for (const { format, basic, corrected, expectedCentre } of results) {
    expect(corrected.peak).toBeGreaterThan(basic.peak * 1.4);
    // RGBA8 retains one-quantum tails after interpolation. It still improves
    // contrast and spread; the float path can retain much narrower filaments.
    expect(corrected.variance).toBeLessThan(basic.variance * (format === 'rgba8' ? 1 : .65));
    expect(Math.abs(corrected.centre - expectedCentre)).toBeLessThan(2);
    for (const state of [basic, corrected]) {
      expect(state.glError).toBe(0); expect(state.min).toBeGreaterThanOrEqual(0); expect(state.peak).toBeLessThanOrEqual(1);
    }
  }
});

for (const packed of [false, true]) test(`Basin material and camera changes preserve the running fluid (${packed ? 'RGBA8' : 'float'})`, async ({ page }) => {
  await page.goto(`/sim.html?sim=basin&source=synthetic&overlay=0&quality=medium&forceRgba8=${packed ? 1 : 0}`);
  await page.waitForFunction(() => !!window.livemixerSim?.host.latestOutput);
  await page.waitForFunction(() => window.livemixerSim.host.state().signals.ink > .01);
  for (const elevation of [35, 40, 90]) {
    const texture = elevation === 35 ? 1.5 : elevation === 90 ? 0 : 1;
    const change = await page.evaluate(({ angle, texture }) => {
      const h = window.livemixerSim.host, before = h.latestOutput;
      h.setParam('elevation', angle);
      h.setParam('ceramicTexture', texture);
      return { preserved: h.latestOutput === before, angle: h.currentParams.elevation, texture: h.currentParams.ceramicTexture };
    }, { angle: elevation, texture });
    expect(change).toEqual({ preserved: true, angle: elevation, texture });
    await page.waitForTimeout(300);
    const s = await page.evaluate(() => { const h = window.livemixerSim.host, s = h.state(); return { warnings: s.warnings.map(w => w.message), violations: s.signalViolations, ink: s.signals.ink, glError: h.gl.getError() }; });
    expect(s.warnings.filter(w => !/8-bit precision|reduced precision/.test(w))).toEqual([]);
    expect(s.violations).toEqual([]); expect(s.glError).toBe(0); expect(s.ink).toBeGreaterThan(.005);
  }
});

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
