import { describe, expect, it } from 'vitest';
import type { Quality } from '../../src/sim/core/types';
import type { Capsule, HandState } from '../../src/sim/input/types';
import { Footprints, emptyGridHand, handToGrid } from '../../src/sim/sims/basin/model';
import {
  COURANT_MAX, DIFFUSION_MAX, HEIGHT_RANGE, MAX_STAMPS, MAX_SUBSTEPS, PROBE_ENC, PROBE_SIZE, ROWS_BY_QUALITY, SPLASH_COOLDOWN, SWELL_CURVATURE, SWELL_WAVES, SignalSmoother, SplashDetector, Stamps, Swell,
  dampingRate, decodeProbe, dipoleKernel, effectiveSpeed, encodeProbeTexel, fieldSize, gridToPlaneX, gridToPlaneY, measuresToSignals, pressKernel, rippleViscosity,
  substepsFor,
} from '../../src/sim/sims/shallows/model';
import { composite, probe, wave } from '../../src/sim/sims/shallows/shaders';
import shallows from '../../src/sim/sims/shallows';
import { validateRegistry, findSimulation } from '../../src/sim/host/registry';

const QUALITIES: Quality[] = ['low', 'medium', 'high'];
const DT = 1 / 60;
const hand = (id: number, x: number, z: number, y = .6, extra: Partial<HandState> = {}): HandState => ({
  id, position: { x, y, z }, velocity: { x: 0, y: 0, z: 0 }, speed: 0,
  extent: { min: { x: x - .04, y: y - .06, z }, max: { x: x + .04, y: y + .06, z } },
  radius: .06, openness: 1, pinch: 0, confidence: 1, ageMs: 100, staleMs: 0, push: z, points: [], capsules: [], ...extra,
});

describe('shallows field', () => {
  it('covers the whole screen with square cells', () => {
    for (const q of QUALITIES) {
      const f = fieldSize(q, 16 / 9);
      expect(f.height).toBe(ROWS_BY_QUALITY[q]);
      expect(f.width % 2).toBe(0);
      expect(Math.abs(f.width / f.height - 16 / 9)).toBeLessThan(.01);
    }
    // Extreme canvases stay within a sane texture size.
    expect(fieldSize('high', 10).width).toBeLessThanOrEqual(ROWS_BY_QUALITY.high * 3);
    expect(fieldSize('low', .1).width).toBeGreaterThanOrEqual(ROWS_BY_QUALITY.low * .4 - 1);
  });

  it('maps Basin grid coordinates onto the plane: x in [0, aspect], y = sim z', () => {
    for (const aspect of [16 / 9, 1, .6]) {
      const g = handToGrid(hand(1, .25, .8), aspect, .35, emptyGridHand());
      expect(gridToPlaneX(g.x, aspect)).toBeCloseTo(.25 * aspect, 9);
      expect(gridToPlaneY(g.y, aspect)).toBeCloseTo(.8, 9);
    }
  });
});

describe('shallows solver numerics', () => {
  it('keeps the Courant number under the bound for every quality and speed', () => {
    for (const q of QUALITIES) for (const speed of [.25, .5, .8, 5]) {
      const rows = ROWS_BY_QUALITY[q], n = substepsFor(speed, DT, rows), c = effectiveSpeed(speed, DT, rows);
      expect(n).toBeGreaterThanOrEqual(1); expect(n).toBeLessThanOrEqual(MAX_SUBSTEPS);
      expect(c * (DT / n) * rows).toBeLessThanOrEqual(COURANT_MAX + 1e-9);
      if (speed <= .8) expect(c).toBeCloseTo(speed, 9); // the declared range is never throttled
    }
  });

  it('keeps the ripple viscosity explicit-stable across the parameter range', () => {
    for (const q of QUALITIES) for (const ripples of [0, .5, 1]) for (const speed of [.25, .8]) {
      const rows = ROWS_BY_QUALITY[q], dtSub = DT / substepsFor(speed, DT, rows);
      expect(rippleViscosity(ripples) * dtSub * rows * rows).toBeLessThanOrEqual(DIFFUSION_MAX);
    }
    expect(rippleViscosity(1)).toBeLessThan(rippleViscosity(0)); // more `ripples` = longer-lived ripples
  });

  it('lets ripples die long before the slosh settles', () => {
    const nu = rippleViscosity(.5), settle = .2;
    const ripple = dampingRate(2 * Math.PI / .06, settle, nu), slosh = dampingRate(2 * Math.PI / 3.5, settle, nu);
    expect(ripple).toBeGreaterThan(slosh * 3);
    expect(1 / slosh).toBeGreaterThan(5);  // the slosh rocks for seconds
    expect(1 / ripple).toBeLessThan(3);    // a ripple is gone in a few
  });

  it('displaces water without creating any: both kernels integrate to zero', () => {
    let press = 0, dipole = 0, dipoleAbs = 0;
    const n = 400, span = 6, cell = (2 * span / n) ** 2;
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      const x = -span + (i + .5) * 2 * span / n, y = -span + (j + .5) * 2 * span / n;
      press += pressKernel(x * x + y * y) * cell;
      const d = dipoleKernel(x, y, 1, .3); dipole += d * cell; dipoleAbs += Math.abs(d) * cell;
    }
    expect(Math.abs(press)).toBeLessThan(1e-6);
    expect(Math.abs(dipole)).toBeLessThan(1e-9); expect(dipoleAbs).toBeGreaterThan(.1);
    // Water rises ahead of a moving body and falls behind it.
    expect(dipoleKernel(.5, 0, 1, 0)).toBeGreaterThan(0); expect(dipoleKernel(-.5, 0, 1, 0)).toBeLessThan(0);
  });

  it('embeds the same kernels and the packed storage in the wave shader', () => {
    for (const packed of [false, true]) {
      const src = wave(packed);
      expect(src).toContain('(1.0 - q) * exp(-q)');
      expect(src).toContain(`const int MAX_STAMPS = ${MAX_STAMPS};`);
      expect(src.includes('#define PACKED 1')).toBe(packed);
      expect(composite(packed)).toContain('filmicOutput'); expect(probe(packed)).toContain(PROBE_ENC.height.toFixed(4));
    }
  });
});

describe('shallows stamps', () => {
  const capsule = (x: number, z: number, y: number): Capsule => ({ a: { x, y, z }, b: { x: x + .02, y, z: z + .1 }, radius: .012 });

  it('turns wet Basin footprints into plane-space stamps scaled by the force', () => {
    const aspect = 16 / 9, fp = new Footprints(), stamps = new Stamps();
    fp.begin(); fp.addSolid([capsule(.3, .4, .3), capsule(.5, .4, .9)], aspect, .35, .5, -.25, null, 8, 1, 0);
    expect(fp.count).toBe(1); // only the capsule under the surface
    stamps.begin(); stamps.addFootprints(fp, aspect, 2, -.4);
    expect(stamps.count).toBe(1);
    expect(stamps.seg[0]).toBeCloseTo(.3 * aspect, 5); expect(stamps.seg[1]).toBeCloseTo(.4, 5);
    expect(stamps.seg[2]).toBeCloseTo(.32 * aspect, 5); expect(stamps.seg[3]).toBeCloseTo(.5, 5);
    expect(stamps.vel[0]).toBeCloseTo(.5 * 2, 5); expect(stamps.vel[1]).toBeCloseTo(-.25 * 2, 5);
    expect(stamps.meta[0]).toBeGreaterThan(0); expect(stamps.meta[1]).toBeGreaterThan(0);
    expect(stamps.meta[2]).toBeCloseTo(-.4, 6); expect(stamps.meta[3]).toBe(0);
  });

  it('never overflows and ignores empty impulses', () => {
    const stamps = new Stamps(); stamps.begin();
    stamps.addImpulse(.5, .5, .05, 0); expect(stamps.count).toBe(0);
    for (let i = 0; i < MAX_STAMPS + 10; i++) stamps.addImpulse(.5, .5, .05, -.1);
    expect(stamps.count).toBe(MAX_STAMPS);
    expect(stamps.meta[3]).toBeCloseTo(-.1, 6); expect(stamps.meta[1]).toBe(0);
    stamps.begin(); expect(stamps.count).toBe(0);
  });
});

describe('shallows splashes', () => {
  it('fires once when a body crosses the surface going down, harder when faster, then cools down', () => {
    const d = new SplashDetector();
    expect(d.update(1, .2, 0, 0)).toBe(0);               // above
    const slow = d.update(1, -.01, .1, .1);
    expect(slow).toBeGreaterThan(0);
    expect(d.update(1, -.05, .1, .12)).toBe(0);          // still under: no repeat
    expect(d.update(1, .1, 0, .2)).toBe(0);              // lifted out
    expect(d.update(1, -.01, 2, .3)).toBe(0);            // within the cooldown
    const fast = d.update(2, -.01, 2, .3);               // first sight of a hand already under: nothing
    expect(fast).toBe(0);
    expect(d.update(1, .1, 0, .4)).toBe(0);
    const hard = d.update(1, -.01, 2, .3 + SPLASH_COOLDOWN + 1);
    expect(hard).toBeGreaterThan(slow); expect(hard).toBeLessThanOrEqual(1);
    d.retain(new Set([2])); expect(d.tracked).toBe(1);
  });
});

describe('shallows swell', () => {
  it('is deterministic, keeps wrapped phases for hours, and scales with the breeze', () => {
    const a = new Swell(5), b = new Swell(5);
    for (let i = 0; i < 5000; i++) { a.update(.3, .5, 1); b.update(.3, .5, 1); }
    expect(Array.from(a.data)).toEqual(Array.from(b.data));
    for (let i = 0; i < SWELL_WAVES.length; i++) {
      const [angle, wavelength] = SWELL_WAVES[i], o = i * 4, k = Math.hypot(a.data[o], a.data[o + 1]);
      expect(k).toBeCloseTo(2 * Math.PI / wavelength, 3); expect(Math.atan2(a.data[o + 1], a.data[o])).toBeCloseTo(angle, 5);
      expect(a.data[o + 3]).toBeGreaterThanOrEqual(0); expect(a.data[o + 3]).toBeLessThan(2 * Math.PI + 1e-6);
      // Curvature A·k² is what focuses light; it follows the breeze and never exceeds the declared ceiling.
      expect(a.data[o + 2] * k * k).toBeLessThanOrEqual(.3 * SWELL_CURVATURE + 1e-6);
    }
    expect(new Swell(5).update(0, .5, 1)[2]).toBe(0);
    expect(new Swell(5).update(1, .5, 1)[2]).toBeGreaterThan(new Swell(5).update(.2, .5, 1)[2]);
    expect(composite(false)).toContain(`const int SWELL = ${SWELL_WAVES.length};`);
  });
});

describe('shallows signals', () => {
  /** A probe image from a height function of plane position (u, v in 0..1). */
  const image = (h: (u: number, v: number) => number, speed = 0, curvature = 0) => {
    const bytes = new Uint8Array(PROBE_SIZE * PROBE_SIZE * 4);
    for (let j = 0; j < PROBE_SIZE; j++) for (let i = 0; i < PROBE_SIZE; i++) bytes.set(encodeProbeTexel(h((i + .5) / PROBE_SIZE, (j + .5) / PROBE_SIZE), speed, curvature), (j * PROBE_SIZE + i) * 4);
    return bytes;
  };

  it('reads the slosh as the signed tilt of the sheet', () => {
    const right = measuresToSignals(decodeProbe(image(u => .004 * (2 * u - 1))), 0);
    expect(right.sloshX).toBeGreaterThan(.3); expect(Math.abs(right.sloshZ)).toBeLessThan(.02);
    const near = measuresToSignals(decodeProbe(image((_, v) => -.004 * (2 * v - 1))), 0);
    expect(near.sloshZ).toBeLessThan(-.3); expect(Math.abs(near.sloshX)).toBeLessThan(.02);
    const flat = measuresToSignals(decodeProbe(image(() => 0)), 0);
    expect(flat).toEqual({ energy: 0, sloshX: 0, sloshZ: 0, ripple: 0, immersion: 0 });
    // A uniform rise is not a tilt.
    expect(Math.abs(measuresToSignals(decodeProbe(image(() => .003)), 0).sloshX)).toBeLessThan(.02);
  });

  it('keeps every signal within its declared range, even for a saturated probe', () => {
    const wild = measuresToSignals(decodeProbe(image(u => (u > .5 ? 1 : -1) * HEIGHT_RANGE, 99, 9999)), 7);
    for (const [name, spec] of Object.entries(shallows.signals)) {
      if (name === 'calm') continue;
      const v = wild[name as keyof typeof wild];
      expect(v).toBeGreaterThanOrEqual(spec.min); expect(v).toBeLessThanOrEqual(spec.max);
    }
    expect(wild.energy).toBeGreaterThan(.9); expect(wild.ripple).toBeGreaterThan(.9);
  });

  it('smooths, and reports calm once the energy has been low for a while', () => {
    const s = new SignalSmoother();
    expect(s.values.calm).toBe(1);
    for (let i = 0; i < 120; i++) s.update({ energy: 1, sloshX: -1, sloshZ: 1, ripple: 1, immersion: 1 }, DT);
    expect(s.values.energy).toBeGreaterThan(.95); expect(s.values.sloshX).toBeLessThan(-.9); expect(s.values.calm).toBeLessThan(.3);
    for (let i = 0; i < 600; i++) s.update({ energy: 0, sloshX: 0, sloshZ: 0, ripple: 0, immersion: 0 }, DT);
    expect(s.values.calm).toBeGreaterThan(.95); expect(Math.abs(s.values.sloshX)).toBeLessThan(.01);
    s.update({ energy: 1, sloshX: 0, sloshZ: 0, ripple: 0, immersion: 0 }, 0); expect(s.values.energy).toBeLessThan(.01); // dt = 0 changes nothing
  });
});

describe('shallows definition', () => {
  it('is registered with valid ranges', () => {
    expect(findSimulation('shallows')).toBe(shallows);
    expect(validateRegistry()).toEqual([]);
    expect(shallows.params.heightContact.default).toBe(false); // a hand moves the water at any height unless asked otherwise
    expect(Object.keys(shallows.signals).sort()).toEqual(['calm', 'energy', 'immersion', 'ripple', 'sloshX', 'sloshZ']);
  });
});
