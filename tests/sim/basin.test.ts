import { describe, expect, it } from 'vitest';
import type { HandState } from '../../src/sim/input/types';
import type { GestureEvent } from '../../src/sim/input/gestures';
import {
  CAUSTIC_LACUNARITY, CAUSTIC_PERIOD, CAUSTIC_RATES, DEFAULT_PALETTE, DRIFT_RATES, DropScheduler, PACKED_DECAY_STRIDE, PACKED_FADE_STRIDE,
  PACKED_MIN_STEP, PACKED_VELOCITY_SCALE, PALETTES, PALETTE_NAMES, PROBE_ENC, PROBE_SIZE, PROBE_SUB, SignalSmoother,
  bowlDistance, causticOffsets, clampToBowl, decodeProbe, decodeSigned, decodeUnsigned, dissipation, dissipationFloor, domainScale, driftPhases,
  encodeSigned, encodeUnsigned, handToGrid, insideBowl, measuresToSignals, probeWeights, resolvePalette, simToGrid, simVelocityToGrid, wrap,
} from '../../src/sim/sims/basin/model';
import { advectVelocity, composite } from '../../src/sim/sims/basin/shaders';

const hand = (id: number, x: number, y: number, push = .3, extra: Partial<HandState> = {}): HandState => ({
  id, position: { x, y, z: push }, velocity: { x: 0, y: 0, z: 0 }, speed: 0,
  extent: { min: { x: x - .04, y: y - .06, z: push }, max: { x: x + .04, y: y + .06, z: push } },
  radius: .06, openness: 1, pinch: 0, confidence: 1, ageMs: 100, staleMs: 0, push, points: [], ...extra,
});
const enter = (handId: number, x: number, y: number): GestureEvent => ({ type: 'enter', handId, atMs: 0, position: { x, y, z: .3 } });
const push = (handId: number, x: number, y: number, depth = .9): GestureEvent => ({ type: 'push', handId, atMs: 0, position: { x, y, z: depth }, depth });

describe('basin geometry', () => {
  it('maps sim space onto a centred square grid in uniform units', () => {
    expect(domainScale(16 / 9)).toBe(1);
    expect(domainScale(.5)).toBe(.5);
    const c = simToGrid({ x: .5, y: .5 }, 16 / 9);
    expect(c.x).toBeCloseTo(.5, 9); expect(c.y).toBeCloseTo(.5, 9);
    // Landscape: the grid spans one canvas height horizontally, centred.
    const right = simToGrid({ x: 1, y: 0 }, 2);
    expect(right.x).toBeCloseTo(1.5, 9); expect(right.y).toBeCloseTo(0, 9);
    // Portrait: the domain shrinks to the width so the bowl still fits.
    const p = simToGrid({ x: 1, y: 1 }, .5);
    expect(p.x).toBeCloseTo(1, 9); expect(p.y).toBeCloseTo(1.5, 9);
    const v = simVelocityToGrid({ x: 1, y: 1 }, 2);
    expect(v.x).toBeCloseTo(2, 9); expect(v.y).toBeCloseTo(1, 9);
  });
  it('converts hands with a clamped splat radius and clamped push', () => {
    const h = handToGrid(hand(1, .5, .5, 1.4, { radius: 5, velocity: { x: .5, y: -.25, z: 0 } }), 16 / 9);
    expect(h.radius).toBe(.16); expect(h.push).toBe(1);
    expect(h.vx).toBeCloseTo(.5 * 16 / 9, 9); expect(h.vy).toBeCloseTo(-.25, 9);
    expect(handToGrid(hand(1, .5, .5, .2, { radius: .001 }), 1).radius).toBe(.035);
    // Agrees with the point/velocity mappings and writes into a caller-owned record when given.
    const src = hand(2, .8, .3, .5, { velocity: { x: .2, y: .1, z: 0 } });
    const out = { x: 0, y: 0, vx: 0, vy: 0, radius: 0, push: 0 };
    expect(handToGrid(src, .5, out)).toBe(out);
    const p = simToGrid(src.position, .5), v = simVelocityToGrid(src.velocity, .5);
    expect(out.x).toBeCloseTo(p.x, 12); expect(out.y).toBeCloseTo(p.y, 12); expect(out.vx).toBeCloseTo(v.x, 12); expect(out.vy).toBeCloseTo(v.y, 12);
    expect(out).toEqual(handToGrid(src, .5));
  });
  it('knows the bowl and pulls points inside it', () => {
    expect(insideBowl({ x: .5, y: .5 }, .4)).toBe(true);
    expect(insideBowl({ x: .95, y: .5 }, .4)).toBe(false);
    expect(bowlDistance({ x: .5, y: .9 })).toBeCloseTo(.4, 9);
    const q = clampToBowl({ x: .99, y: .5 }, .4, .08);
    expect(bowlDistance(q)).toBeCloseTo(.32, 9); expect(q.y).toBeCloseTo(.5, 9);
    const inside = { x: .55, y: .52 };
    expect(clampToBowl(inside, .4)).toEqual(inside);
  });
});

describe('basin shader time', () => {
  const mod = (x: number, p: number) => ((x % p) + p) % p;
  it('wraps into [0, period) for either sign', () => {
    expect(wrap(3, 64)).toBe(3); expect(wrap(64, 64)).toBe(0); expect(wrap(-1, 64)).toBe(63); expect(wrap(130.5, 64)).toBeCloseTo(2.5, 12);
    expect(wrap(-.25, 1)).toBeCloseTo(.75, 12);
  });
  it('reduces the caustic scroll offsets modulo the hash period, octave by octave, without a seam', () => {
    const zero = causticOffsets(0);
    expect(zero.length).toBe(8); expect(Array.from(zero)).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    // Before any wrap the offsets are the raw scroll (negative rates count down from the period).
    const early = causticOffsets(10);
    for (let k = 0; k < 4; k++) {
      expect(early[k]).toBeCloseTo(mod(10 * CAUSTIC_RATES[k], CAUSTIC_PERIOD), 5);
      expect(early[k + 4]).toBeCloseTo(mod(10 * CAUSTIC_RATES[k] * CAUSTIC_LACUNARITY, CAUSTIC_PERIOD), 5);
    }
    // Hours in: every offset is still exactly the raw scroll modulo the period, i.e. the same lattice
    // position the periodic hash would see for the unwrapped time, and it stays inside [0, period).
    for (const t of [1280, 1280 + 1e-3, 3600 * 9.5, 86400 * 3]) {
      const o = causticOffsets(t);
      for (let k = 0; k < 4; k++) {
        expect(o[k]).toBeGreaterThanOrEqual(0); expect(o[k]).toBeLessThan(CAUSTIC_PERIOD);
        expect(o[k + 4]).toBeGreaterThanOrEqual(0); expect(o[k + 4]).toBeLessThan(CAUSTIC_PERIOD);
        // Distance on the circle of circumference CAUSTIC_PERIOD is ~0 (fp32 storage bounds the error).
        const d1 = mod(o[k] - t * CAUSTIC_RATES[k], CAUSTIC_PERIOD), d2 = mod(o[k + 4] - t * CAUSTIC_RATES[k] * CAUSTIC_LACUNARITY, CAUSTIC_PERIOD);
        expect(Math.min(d1, CAUSTIC_PERIOD - d1)).toBeLessThan(1e-4); expect(Math.min(d2, CAUSTIC_PERIOD - d2)).toBeLessThan(1e-4);
      }
    }
    // Continuity across the first layer's wrap (rate .05 → period/rate = 1280 s): a small step in time
    // moves every offset by a small distance on the circle.
    const eps = 1 / 60, a = causticOffsets(1280 - eps / 2), b = causticOffsets(1280 + eps / 2);
    expect(a[0]).toBeGreaterThan(CAUSTIC_PERIOD - .01); expect(b[0]).toBeLessThan(.01);
    for (let k = 0; k < 8; k++) { const d = mod(b[k] - a[k], CAUSTIC_PERIOD); expect(Math.min(d, CAUSTIC_PERIOD - d)).toBeLessThan(.01); }
    // Reuses the caller's buffer.
    const buf = new Float32Array(8);
    expect(causticOffsets(5, buf)).toBe(buf); expect(buf[0]).toBeCloseTo(.25, 5);
  });
  it('reduces the drift phases modulo one cycle', () => {
    expect(Array.from(driftPhases(0))).toEqual([0, 0, 0, 0]);
    for (const t of [1, 123.4, 3600 * 8, 86400 * 2]) {
      const p = driftPhases(t);
      for (let k = 0; k < 4; k++) {
        expect(p[k]).toBeGreaterThanOrEqual(0); expect(p[k]).toBeLessThan(1);
        const d = mod(p[k] - t * DRIFT_RATES[k], 1);
        expect(Math.min(d, 1 - d)).toBeLessThan(1e-5);
      }
    }
    const buf = new Float32Array(4);
    expect(driftPhases(2, buf)).toBe(buf); expect(buf[1]).toBeCloseTo(1 - .034, 5);
  });
  it('bakes the period, lacunarity and rates the CPU wraps with into the shaders', () => {
    const c = composite(false);
    expect(c).toContain(`const float HASH_PERIOD = ${CAUSTIC_PERIOD.toFixed(1)};`);
    expect(c).toContain('mod(p, HASH_PERIOD)');
    expect(c).toContain(`p * ${CAUSTIC_LACUNARITY.toFixed(2)} + 7.1 + o2`);
    expect(c).not.toContain('u_time');
    expect(advectVelocity(false)).not.toContain('u_time');
    expect(advectVelocity(true)).toContain('u_decayFloor');
  });
});

describe('basin packed dissipation', () => {
  // Emulate an RGBA8 texel: velocity stored as v / VS + 128/255, rounded to the nearest byte.
  const VS = PACKED_VELOCITY_SCALE;
  const quantizeV = (v: number) => (Math.round((v / VS + 128 / 255) * 255) / 255 - 128 / 255) * VS;
  const quantizeDye = (d: number) => Math.round(Math.min(1, Math.max(0, d)) * 255) / 255;
  const dt = 1 / 60;
  it('is the plain exponential factor in float mode', () => {
    expect(dissipation(.2, dt, false, 0, PACKED_DECAY_STRIDE)).toBeCloseTo(Math.exp(-.2 * dt), 12);
    expect(dissipation(.2, dt, false, 3, PACKED_DECAY_STRIDE)).toBeCloseTo(Math.exp(-.2 * dt), 12);
    expect(dissipationFloor(false, 0, PACKED_DECAY_STRIDE, VS)).toBe(0);
  });
  it('applies the compound factor and a floor on the stride in packed mode', () => {
    expect(dissipation(.2, dt, true, 0, PACKED_DECAY_STRIDE)).toBeCloseTo(Math.exp(-.2 * dt * PACKED_DECAY_STRIDE), 12);
    expect(dissipation(.2, dt, true, 1, PACKED_DECAY_STRIDE)).toBe(1);
    expect(dissipationFloor(true, PACKED_DECAY_STRIDE * 5, PACKED_DECAY_STRIDE, VS)).toBeCloseTo(PACKED_MIN_STEP * VS, 12);
    expect(dissipationFloor(true, 2, PACKED_DECAY_STRIDE, VS)).toBe(0);
    // More than half a quantum, so a decrement always survives rounding to the nearest byte.
    expect(PACKED_MIN_STEP * 255).toBeGreaterThan(.5); expect(PACKED_MIN_STEP * 255).toBeLessThan(1);
  });
  it('lets a quantised velocity reach exactly zero where the multiplicative decay stalls', () => {
    const stuck = (v: number) => { for (let s = 0; s < 3600; s++) v = quantizeV(v * Math.exp(-.2 * dt)); return v; };
    expect(stuck(quantizeV(.5))).toBeCloseTo(quantizeV(.5), 12);   // the old path: a byte never moves below v ≈ 2.35
    const shaderStep = (v: number, s: number) => {
      const decay = dissipation(.2, dt, true, s, PACKED_DECAY_STRIDE), floor = dissipationFloor(true, s, PACKED_DECAY_STRIDE, VS);
      return quantizeV(v - Math.sign(v) * Math.min(Math.abs(v), Math.max(Math.abs(v) * (1 - decay), floor)));
    };
    for (const start of [3, .5, -.5, .05, VS / 255]) {
      let v = quantizeV(start), steps = 0;
      const seen: number[] = [v];
      while (v !== 0 && steps < 3600) { v = shaderStep(v, steps++); seen.push(v); }
      expect(v).toBe(0);
      expect(steps).toBeLessThan(60 * 15);   // even a 3 uv/s stir is fully still within 15 s
      for (let i = 1; i < seen.length; i++) expect(Math.abs(seen[i])).toBeLessThanOrEqual(Math.abs(seen[i - 1]));   // monotone
    }
    // Large velocities still follow the exponential (the compound factor on the stride): after 4 s a
    // 3 uv/s stir is near 3·e^-0.8 ≈ 1.35 (byte rounding lags a little), far from the floor-only 2.44.
    let v = quantizeV(3);
    for (let s = 0; s < PACKED_DECAY_STRIDE * 60; s++) v = shaderStep(v, s);
    expect(v).toBeGreaterThan(1.2); expect(v).toBeLessThan(1.55);
  });
  it('lets quantised dye fade to exactly zero', () => {
    let stuck = quantizeDye(.6);
    for (let s = 0; s < 3600; s++) stuck = quantizeDye(stuck * Math.exp(-.03 * dt));
    expect(stuck).toBeCloseTo(.6, 2);   // the old path
    let d = quantizeDye(.6), steps = 0;
    while (d > 0 && steps < 60 * 120) {
      const fade = dissipation(.03, dt, true, steps, PACKED_FADE_STRIDE), floor = dissipationFloor(true, steps, PACKED_FADE_STRIDE, 1);
      d = quantizeDye(d - Math.min(d, Math.max(d * (1 - fade), floor))); steps++;
    }
    expect(d).toBe(0);
    expect(steps / 60).toBeGreaterThan(15); expect(steps / 60).toBeLessThan(90);   // fades over tens of seconds, like the float path's 1/fade ≈ 33 s
  });
});

describe('basin palettes', () => {
  it('resolves every declared palette and falls back to the default', () => {
    for (const name of PALETTE_NAMES) {
      const colors = resolvePalette(name);
      expect(colors.length).toBeGreaterThanOrEqual(2);
      for (const c of colors) for (const v of c) { expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThanOrEqual(1); }
    }
    expect(resolvePalette('nope')).toBe(PALETTES[DEFAULT_PALETTE]);
    expect(PALETTE_NAMES).toContain(DEFAULT_PALETTE);
  });
});

describe('basin probe', () => {
  it('round-trips the 8-bit encodings with an exact zero', () => {
    expect(encodeSigned(0, 1)).toBe(128); expect(decodeSigned(128, 1)).toBe(0);
    expect(decodeSigned(encodeSigned(.4, PROBE_ENC.angular), PROBE_ENC.angular)).toBeCloseTo(.4, 2);
    expect(decodeSigned(encodeSigned(-.25, PROBE_ENC.angular), PROBE_ENC.angular)).toBeCloseTo(-.25, 2);
    expect(encodeSigned(99, 1)).toBe(255); expect(encodeSigned(-99, 1)).toBe(0);
    expect(decodeUnsigned(encodeUnsigned(.9, PROBE_ENC.speed), PROBE_ENC.speed)).toBeCloseTo(.9, 2);
    expect(encodeUnsigned(5, 1)).toBe(255);
  });
  it('weights probe cells by the fraction of their samples inside the bowl', () => {
    const bowl = .42, w = probeWeights(bowl);
    expect(w.length).toBe(PROBE_SIZE * PROBE_SIZE);
    let sum = 0;
    for (const v of w) { expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThanOrEqual(1); sum += v; }
    // Total weight ≈ bowl area in probe cells.
    expect(sum / (PROBE_SIZE * PROBE_SIZE)).toBeCloseTo(Math.PI * bowl * bowl, 1);
    expect(w[8 * PROBE_SIZE + 8]).toBe(1); expect(w[0]).toBe(0);
    expect(probeWeights(.2, 8, 2).length).toBe(64);
    expect(PROBE_SUB).toBeGreaterThan(0);
  });
  it('decodes a readback into masked means', () => {
    const bowl = .42, w = probeWeights(bowl);
    const bytes = new Uint8Array(PROBE_SIZE * PROBE_SIZE * 4);
    for (let k = 0; k < w.length; k++) {
      bytes[k * 4] = encodeUnsigned(.3, PROBE_ENC.speed);
      bytes[k * 4 + 1] = encodeUnsigned(10, PROBE_ENC.curl);
      bytes[k * 4 + 2] = encodeSigned(-.12, PROBE_ENC.angular);
      bytes[k * 4 + 3] = encodeUnsigned(.25, 1);
    }
    const m = decodeProbe(bytes, w);
    expect(m.speed).toBeCloseTo(.3, 2); expect(m.curl).toBeCloseTo(10, 0); expect(m.angular).toBeCloseTo(-.12, 2); expect(m.ink).toBeCloseTo(.25, 2);
    // Cells outside the bowl contribute nothing even when they carry garbage.
    const garbage = new Uint8Array(bytes); for (let k = 0; k < w.length; k++) if (w[k] === 0) garbage.set([255, 255, 255, 255], k * 4);
    expect(decodeProbe(garbage, w)).toEqual(m);
    expect(decodeProbe(bytes, new Float32Array(w.length))).toEqual({ speed: 0, curl: 0, angular: 0, ink: 0 });
  });
});

describe('basin signals', () => {
  it('maps measures into the declared ranges', () => {
    const still = measuresToSignals({ speed: 0, curl: 0, angular: 0, ink: 0 });
    expect(still).toEqual({ energy: 0, swirl: 0, rotation: 0, ink: 0 });
    const wild = measuresToSignals({ speed: 50, curl: 1e4, angular: 9, ink: 3 });
    expect(wild.energy).toBeLessThanOrEqual(1); expect(wild.energy).toBeGreaterThan(.99);
    expect(wild.swirl).toBeLessThanOrEqual(1); expect(wild.rotation).toBeLessThanOrEqual(1); expect(wild.ink).toBe(1);
    expect(measuresToSignals({ speed: 0, curl: 0, angular: -9, ink: 0 }).rotation).toBeGreaterThanOrEqual(-1);
    expect(measuresToSignals({ speed: 0, curl: 0, angular: -.02, ink: 0 }).rotation).toBeLessThan(0);
    expect(measuresToSignals({ speed: .09, curl: 0, angular: 0, ink: 0 }).energy).toBeCloseTo(1 - Math.exp(-1), 6);
  });
  it('smooths toward the raw values and derives calm from a slower energy', () => {
    const s = new SignalSmoother();
    expect(s.values.calm).toBe(1);
    const raw = { energy: 1, swirl: .5, rotation: -1, ink: .8 };
    s.update(raw, 0);
    expect(s.values.energy).toBe(0);
    for (let i = 0; i < 60; i++) s.update(raw, 1 / 60);
    expect(s.values.energy).toBeGreaterThan(.95); expect(s.values.energy).toBeLessThanOrEqual(1);
    expect(s.values.rotation).toBeLessThan(-.85); expect(s.values.rotation).toBeGreaterThanOrEqual(-1);
    expect(s.values.swirl).toBeCloseTo(.5, 1); expect(s.values.ink).toBeGreaterThan(.6);
    // Calm lags: after one second of full energy it has only partly fallen.
    expect(s.values.calm).toBeLessThan(.8); expect(s.values.calm).toBeGreaterThan(.3);
    for (let i = 0; i < 600; i++) s.update(raw, 1 / 60);
    expect(s.values.calm).toBeLessThan(.02);
    for (let i = 0; i < 600; i++) s.update({ energy: 0, swirl: 0, rotation: 0, ink: 0 }, 1 / 60);
    expect(s.values.calm).toBeGreaterThan(.98); expect(s.values.energy).toBeLessThan(.01);
  });
});

describe('basin drop scheduler', () => {
  const base = { time: 0, events: [] as GestureEvent[], hands: [] as HandState[], aspect: 16 / 9, bowl: .42, ink: .05, palette: 'ember', dropOnEnter: true, inkLevel: .5 };
  it('seeds initial beads inside the bowl, cycling the palette, deterministically', () => {
    const a = new DropScheduler(3).initial(4, .42, 'ember', .05), b = new DropScheduler(3).initial(4, .42, 'ember', .05);
    expect(a).toEqual(b);
    expect(a).toHaveLength(4);
    for (const d of a) { expect(insideBowl(d, .42)).toBe(true); expect(d.impulse).toBe(0); expect(d.radius).toBeGreaterThan(.03); expect(d.radius).toBeLessThan(.07); }
    const hueOf = (c: readonly number[]) => c.indexOf(Math.max(...c));
    expect(hueOf(a[0].color)).toBe(hueOf(PALETTES.ember[0])); expect(hueOf(a[1].color)).toBe(hueOf(PALETTES.ember[1]));
    expect(new DropScheduler(4).initial(4, .42, 'ember', .05)).not.toEqual(a);
  });
  it('drops on enter (when enabled, inside the bowl) and on push gestures with an impulse', () => {
    const s = new DropScheduler();
    const inBowl = s.update({ ...base, events: [enter(1, .5, .5)] });
    expect(inBowl).toHaveLength(1); expect(inBowl[0].impulse).toBe(0);
    expect(inBowl[0].x).toBeCloseTo(.5, 9); expect(inBowl[0].y).toBeCloseTo(.5, 9);
    expect(s.update({ ...base, events: [enter(2, .02, .02)] })).toHaveLength(0);
    expect(new DropScheduler().update({ ...base, dropOnEnter: false, events: [enter(1, .5, .5)] })).toHaveLength(0);
    const pushed = s.update({ ...base, time: 1, events: [push(1, .55, .5, .9)], hands: [hand(1, .55, .5, .9)] });
    expect(pushed).toHaveLength(1); expect(pushed[0].impulse).toBeGreaterThan(.2);
    // The same push must not be counted twice by the threshold rule on the next step.
    expect(s.update({ ...base, time: 1.02, hands: [hand(1, .55, .5, .95)] })).toHaveLength(0);
  });
  it('fires on a slow push crossing the threshold, with hysteresis and a cooldown', () => {
    const s = new DropScheduler();
    let t = 0;
    const step = (p: number) => s.update({ ...base, time: (t += 1 / 60), hands: [hand(1, .5, .5, p)] });
    expect(step(.3)).toHaveLength(0);
    expect(step(.5)).toHaveLength(0);
    expect(step(.7)).toHaveLength(1);
    expect(step(.9)).toHaveLength(0);
    expect(step(.5)).toHaveLength(0);   // between OFF and ON: still armed off
    expect(step(.7)).toHaveLength(0);   // never dipped below OFF: no re-fire
    expect(step(.4)).toHaveLength(0);   // released
    expect(step(.7)).toHaveLength(0);   // re-crossed but inside the cooldown
    t += 1;
    expect(step(.4)).toHaveLength(0);
    expect(step(.7)).toHaveLength(1);
    // A hand that first appears already pushed does not drop until it releases and pushes again.
    const fresh = new DropScheduler();
    expect(fresh.update({ ...base, time: 5, hands: [hand(9, .5, .5, .9)] })).toHaveLength(0);
  });
  it('appends into a caller-owned queue and allocates nothing when nothing happens', () => {
    const s = new DropScheduler();
    const queue = [] as ReturnType<DropScheduler['update']>;
    expect(s.update({ ...base, events: [enter(1, .5, .5)] }, queue)).toBe(queue);
    expect(queue).toHaveLength(1);
    expect(s.update({ ...base, time: .1, hands: [hand(1, .5, .5)] }, queue)).toBe(queue);
    expect(queue).toHaveLength(1);   // untouched: nothing new was appended, nothing was removed
    s.update({ ...base, time: 1, events: [push(1, .55, .5)], hands: [hand(1, .55, .5, .9)] }, queue);
    expect(queue).toHaveLength(2); expect(queue[1].impulse).toBeGreaterThan(0);
    // The scratch sets are reused between calls: hand bookkeeping still works across many steps.
    for (let i = 0; i < 100; i++) s.update({ ...base, time: 2 + i / 60, hands: [hand(1, .55, .5, .3)] }, queue);
    expect(queue).toHaveLength(2);
    s.update({ ...base, time: 5, hands: [hand(1, .55, .5, .9)] }, queue);
    expect(queue).toHaveLength(3);
  });
  it('re-seeds a lone bead when nobody has been there for a while and the ink is gone', () => {
    const s = new DropScheduler();
    s.update({ ...base, time: 0, hands: [hand(1, .5, .5)] });
    expect(s.update({ ...base, time: 10, inkLevel: 0 })).toHaveLength(0);
    expect(s.update({ ...base, time: 20, inkLevel: .5 })).toHaveLength(0);
    const idle = s.update({ ...base, time: 20, inkLevel: 0 });
    expect(idle).toHaveLength(1); expect(insideBowl(idle[0], .42)).toBe(true); expect(idle[0].impulse).toBe(0);
    expect(s.update({ ...base, time: 21, inkLevel: 0 })).toHaveLength(0);
    expect(s.update({ ...base, time: 40, inkLevel: 0 })).toHaveLength(1);
  });
});
