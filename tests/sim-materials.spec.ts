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

for (const packed of [false, true]) test(`Shallows water rests, conserves volume, reflects off the screen edges, and loses ripples before the slosh (${packed ? 'RGBA8' : 'float'})`, async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto('/sim.html?sim=presence&source=pointer&overlay=0&quality=low');
  await page.waitForFunction(() => !!window.livemixerSim?.host);
  const result = await page.evaluate(async packed => {
    window.livemixerSim.host.stop();
    const [{ wave, restColor }, model, { PingPong }, { quadProgram, drawQuad }] = await Promise.all([
      import('../src/sim/sims/shallows/shaders'), import('../src/sim/sims/shallows/model'), import('../src/sim/gl/fbo'), import('../src/sim/gl/quad'),
    ]);
    const gl = document.createElement('canvas').getContext('webgl2')!;
    if (!packed && !gl.getExtension('EXT_color_buffer_float')) throw new Error('Test requires floating targets as well as the RGBA8 fallback.');
    const aspect = 1.5, rows = 96, cols = 144, dt = 1 / 60, speed = .5, settle = .2;
    const n = model.substepsFor(speed, dt, rows), c = model.effectiveSpeed(speed, dt, rows), sub = dt / n, nu = model.rippleViscosity(.5);
    const field = new PingPong(gl, cols, rows, packed ? 'rgba8' : 'rgba16f', 'linear');
    const shader = quadProgram(gl, wave(packed), 'shallows-wave-test');
    const stamps = new model.Stamps();
    const bytes = new Uint8Array(cols * rows * 4), floats = new Float32Array(cols * rows * 4), heights = new Float32Array(cols * rows);
    const reset = () => { for (const f of [field.read, field.write]) f.clear(...restColor(packed)); };
    const step = () => {
      shader.use().f2('u_texel', 1 / cols, 1 / rows).f1('u_dx', 1 / rows).f1('u_dt', sub).f1('u_stepDt', dt).f1('u_c2', c * c).f1('u_nu', nu)
        .f1('u_damp', Math.exp(-settle * sub)).f1('u_relax', Math.exp(-model.HEIGHT_RELAX * sub)).f1('u_aspect', aspect)
        .f4v('u_seg', stamps.seg).f4v('u_vel', stamps.vel).f4v('u_meta', stamps.meta);
      for (let i = 0; i < n; i++) { field.write.bind(); shader.texture('u_field', field.read.texture, 0).i1('u_stampCount', i === 0 ? stamps.count : 0); drawQuad(gl); field.swap(); }
      stamps.begin();
    };
    const measure = () => {
      field.read.bind();
      if (packed) { gl.readPixels(0, 0, cols, rows, gl.RGBA, gl.UNSIGNED_BYTE, bytes); for (let i = 0; i < heights.length; i++) heights[i] = (bytes[i * 4] * 256 + bytes[i * 4 + 1] - 32768) * model.HEIGHT_RANGE / 32767; }
      else { gl.readPixels(0, 0, cols, rows, gl.RGBA, gl.FLOAT, floats); for (let i = 0; i < heights.length; i++) heights[i] = floats[i * 4]; }
      let max = 0, sum = 0, sq = 0, right = 0, finite = true;
      for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
        const h = heights[y * cols + x];
        if (!Number.isFinite(h)) finite = false;
        max = Math.max(max, Math.abs(h)); sum += h; sq += h * h;
        if (x >= cols * .75) right += h * h;
      }
      return { max, mean: sum / heights.length, rms: Math.sqrt(sq / heights.length), right, finite };
    };
    /** Seed a standing wave with `waves` half-periods across the width, run for `seconds`, and return the share of its amplitude left. */
    const survive = (waves: number, seconds: number) => {
      reset(); field.read.bind();
      gl.enable(gl.SCISSOR_TEST);
      for (let x = 0; x < cols; x++) {
        const h = .004 * Math.cos(Math.PI * waves * (x + .5) / cols);
        const q = Math.round(h / model.HEIGHT_RANGE * 32767 + 32768);
        gl.scissor(x, 0, 1, rows);
        if (packed) gl.clearColor(Math.floor(q / 256) / 255, (q % 256) / 255, 128 / 255, 0); else gl.clearColor(h, 0, 0, 1);
        gl.clear(gl.COLOR_BUFFER_BIT);
      }
      gl.disable(gl.SCISSOR_TEST);
      const before = measure().rms;
      // Sample the envelope over the last stretch so the phase of the oscillation does not matter.
      let peak = 0;
      const total = Math.round(seconds * 60), tail = Math.round(total * .3);
      for (let i = 0; i < total; i++) { step(); if (i >= total - tail && i % 4 === 0) peak = Math.max(peak, measure().rms); }
      return peak / before;
    };
    try {
      reset(); stamps.begin();
      for (let i = 0; i < 20; i++) step();
      const rest = measure();
      stamps.addImpulse(.3, .5, .06, -.2); step();
      for (let i = 0; i < 12; i++) step();
      const splash = measure();
      for (let i = 0; i < 150; i++) step();      // long enough to reach the right edge (1.2 units away at 0.5/s)
      const spread = measure();
      for (let i = 0; i < 2400; i++) step();
      const calm = measure();
      const slosh = survive(1, 4), ripple = survive(60, 4);
      return { rest, splash, spread, calm, slosh, ripple, substeps: n, glError: gl.getError() };
    } finally { shader.dispose(); field.dispose(); gl.getExtension('WEBGL_lose_context')?.loseContext(); }
  }, packed);
  expect(result.glError).toBe(0);
  expect(result.rest.max).toBe(0);
  for (const state of [result.splash, result.spread, result.calm]) expect(state.finite).toBe(true);
  expect(result.splash.max).toBeGreaterThan(.001);
  expect(result.splash.max).toBeLessThan(.05);                                       // no clipping
  expect(Math.abs(result.splash.mean)).toBeLessThan(result.splash.max * .02);         // a splash moves water, it does not make any
  expect(result.spread.right).toBeGreaterThan(result.splash.right * 10 + 1e-12);      // it has travelled
  expect(result.calm.rms).toBeLessThan(result.splash.rms * .05);                      // and it settles
  expect(result.slosh).toBeGreaterThan(.45);                                          // the sheet is still rocking after 4 s (e^-0.5 ≈ 0.6)
  expect(result.slosh).toBeLessThan(1.02);
  expect(result.ripple).toBeLessThan(result.slosh * .5);                              // short ripples are gone first
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
