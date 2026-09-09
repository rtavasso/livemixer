import { describe, expect, it } from 'vitest';
import type { HandState } from '../../src/sim/input/types';
import { Noise } from '../../src/sim/core/noise';
import { windowCamera } from '../../src/sim/core/camera';
import {
  CURL_EPS, DEPTH_DIM, DEPTH_GATE, HUE_OFFSETS, HUE_WANDER, InkDepth, POOL_GAIN, SparkleField, StrokeTracker, accumulate, brushAmplitude, brushKernel, brushRadius,
  curlX, curlY, decayFor, deposit, depthAttenuation, depthTint, floorColour, floorFor, floorPool, hueWander, inkTarget, projectFloorPool, projectSegment, reduceProbe,
  segmentDistance, segmentLight, sparkColour, sparkleRate, strokeColor, wrapHue,
} from '../../src/sim/sims/trails/logic';

const hand = (id: number, x: number, y: number, extra: Partial<HandState> = {}): HandState => ({
  id, position: { x, y, z: .3 }, velocity: { x: 0, y: 0, z: 0 }, speed: 0,
  extent: { min: { x: x - .05, y: y - .05, z: .3 }, max: { x: x + .05, y: y + .05, z: .3 } }, radius: .05,
  openness: 1, pinch: 0, confidence: 1, ageMs: 0, staleMs: 0, push: 0, points: [], ...extra,
});
const params = { brushSize: .045, brightness: 1, saturation: .55, hue: .07, depthFade: 0 };

describe('decay', () => {
  it('is frame-rate independent: two half steps equal one full step', () => {
    expect(decayFor(1 / 30, 4)).toBeCloseTo(decayFor(1 / 60, 4) ** 2, 12);
    expect(decayFor(0, 4)).toBe(1);
    expect(decayFor(-1, 4)).toBe(1);
  });
  it('reaches about 2% after the declared lifetime', () => {
    expect(decayFor(4, 4)).toBeCloseTo(Math.exp(-4), 9);
    expect(decayFor(10, 10)).toBeCloseTo(Math.exp(-4), 9);
  });
  it('fades a fresh stroke to exactly black in about one lifetime, and not much sooner', () => {
    for (const lifetime of [1, 4, 12]) {
      let v = 1, t = 0;
      const dt = 1 / 60, decay = decayFor(dt, lifetime), floor = floorFor(lifetime, true) * dt;
      while (v > 0 && t < lifetime * 2) { v = accumulate(v, 0, decay, floor); t += dt; }
      expect(v, `lifetime ${lifetime}`).toBe(0);
      expect(t, `lifetime ${lifetime} reaches black`).toBeLessThan(lifetime * 1.3);
      expect(t, `lifetime ${lifetime} does not vanish early`).toBeGreaterThan(lifetime * .6);
    }
  });
  it('uses a floor large enough that 8-bit targets cannot get stuck', () => {
    expect(floorFor(4, false) / 60).toBeGreaterThan(.5 / 255);
    expect(floorFor(4, true)).toBeLessThan(floorFor(4, false));
  });
  it('deposits saturate: increments shrink as a pixel brightens and never explode', () => {
    expect(deposit(0, .2)).toBeCloseTo(.2, 12);
    expect(deposit(.5, .2) - .5).toBeLessThan(deposit(0, .2));
    let v = 0;
    for (let i = 0; i < 100_000; i++) v = deposit(v, .2);
    expect(v).toBeGreaterThan(1);
    expect(v).toBeLessThan(8);
  });
});

describe('brush', () => {
  it('kernel is 1 at the centre, smooth, monotone, and exactly 0 at the edge', () => {
    expect(brushKernel(0)).toBe(1);
    expect(brushKernel(1)).toBe(0);
    expect(brushKernel(2)).toBe(0);
    let prev = 1;
    for (let t = .05; t < 1; t += .05) { const w = brushKernel(t); expect(w).toBeLessThan(prev); expect(w).toBeGreaterThan(0); prev = w; }
    expect(brushKernel(.999)).toBeLessThan(1e-4);
  });
  it('measures distance to a segment, its endpoints, or a point', () => {
    expect(segmentDistance(.5, 1, 0, 0, 1, 0)).toBeCloseTo(1, 12);
    expect(segmentDistance(.5, 0, 0, 0, 1, 0)).toBeCloseTo(0, 12);
    expect(segmentDistance(3, 0, 0, 0, 1, 0)).toBeCloseTo(2, 12);
    expect(segmentDistance(-1, -1, 0, 0, 1, 0)).toBeCloseTo(Math.SQRT2, 12);
    expect(segmentDistance(3, 4, 0, 0, 0, 0)).toBeCloseTo(5, 12);
  });
  it('leaves no gaps along a fast stroke: every point on the path receives full light', () => {
    const seg = { ax: .1, ay: .2, bx: 1.4, by: .9, radius: .04, amplitude: 1 };
    for (let i = 0; i <= 200; i++) {
      const u = i / 200;
      const { colour, white } = segmentLight(seg, seg.ax + (seg.bx - seg.ax) * u, seg.ay + (seg.by - seg.ay) * u);
      expect(colour).toBeCloseTo(1, 9);
      expect(white).toBeCloseTo(.35, 9);
    }
    expect(segmentLight(seg, .1, .2 + .05).colour).toBe(0);
  });
  it('radius grows with the hand blob and gently with speed, within bounds', () => {
    const base = brushRadius(.045, .09, 0);
    expect(base).toBeCloseTo(.045, 9);
    expect(brushRadius(.045, .18, 0)).toBeGreaterThan(base);
    expect(brushRadius(.045, .18, 0)).toBeLessThan(base * 2);
    expect(brushRadius(.045, .0001, 0)).toBeGreaterThan(base * .5);
    expect(brushRadius(.045, 1, 0)).toBeLessThan(base * 1.7);
    expect(brushRadius(.045, .09, 3)).toBeCloseTo(base * 1.3, 9);
  });
  it('amplitude is positive for a still hand, rises with speed, and stroke total is speed-independent before the boost', () => {
    const dt = 1 / 60;
    expect(brushAmplitude(1, 0, .045, 0, dt)).toBeGreaterThan(0);
    expect(brushAmplitude(0, .01, .045, 1, dt)).toBe(0);
    const slow = brushAmplitude(1, .005, .045, .3, dt), fast = brushAmplitude(1, .025, .045, 1.5, dt);
    expect(fast / .025).toBeGreaterThan(slow / .005);
    // Total light along a stroke of fixed length is the sum of per-step travel terms, independent of the step count.
    const total = (steps: number) => { let sum = 0; for (let i = 0; i < steps; i++) sum += brushAmplitude(1, .3 / steps, .045, 0, 0); return sum; };
    expect(total(10)).toBeCloseTo(total(100), 9);
    // And of depth: a projected length and radius shrink together, so the travel term is the same for the same world stroke.
    expect(brushAmplitude(1, .3 * .6, .045 * .6, 0, 0)).toBeCloseTo(brushAmplitude(1, .3, .045, 0, 0), 9);
  });
  it('colours have unit value, moderate saturation, a small direction shift, and hue wraps', () => {
    const [r, g, b] = strokeColor(.07, .55, 1, 0);
    expect(Math.max(r, g, b)).toBeCloseTo(1, 12);
    expect(Math.min(r, g, b)).toBeCloseTo(.45, 12);
    expect(strokeColor(.07, .55, 0, 1)).not.toEqual(strokeColor(.07, .55, 0, -1));
    expect(strokeColor(.07, .55, 0, 0)).toEqual(strokeColor(.07, .55, 0, 0, 0));
    expect(strokeColor(1.07, .55, 0, 0)).toEqual(strokeColor(.07, .55, 0, 0));
    expect(wrapHue(-.25)).toBeCloseTo(.75, 12); expect(wrapHue(2.5)).toBeCloseTo(.5, 12);
    const white = sparkColour(1, .45, .45);
    expect(white[1]).toBeGreaterThan(.45); expect(white[0]).toBe(1);
  });
  it('hue wanders deterministically within its band around the base and wraps', () => {
    const noise = new Noise(11), again = new Noise(11);
    let min = 1, max = 0, moved = false;
    for (let t = 0; t < 600; t += .5) {
      const h = hueWander(.5, t, .02, noise);
      expect(h).toBe(hueWander(.5, t, .02, again));
      min = Math.min(min, h); max = Math.max(max, h);
      if (Math.abs(h - .5) > .01) moved = true;
    }
    expect(moved).toBe(true);
    expect(min).toBeGreaterThanOrEqual(.5 - HUE_WANDER - 1e-9); expect(max).toBeLessThanOrEqual(.5 + HUE_WANDER + 1e-9);
    expect(hueWander(.5, 3, 0, noise)).toBe(hueWander(.5, 90, 0, noise));
    const wrapped = hueWander(.99, 12.3, .02, noise);
    expect(wrapped).toBeGreaterThanOrEqual(0); expect(wrapped).toBeLessThan(1);
  });
});

describe('aerial perspective', () => {
  it('attenuation is 1 at the glass or without fade, falls monotonically with depth, and never reaches zero', () => {
    expect(depthAttenuation(0, 1)).toBe(1);
    expect(depthAttenuation(.7, 0)).toBe(1);
    let prev = 1;
    for (let z = .1; z <= 1.0001; z += .1) { const a = depthAttenuation(z, .6); expect(a).toBeLessThan(prev); expect(a).toBeGreaterThan(0); prev = a; }
    expect(depthAttenuation(1, 1)).toBeCloseTo(1 / (1 + DEPTH_DIM), 12);
    expect(depthAttenuation(5, 5), 'inputs clamp').toBeCloseTo(1 / (1 + DEPTH_DIM), 12);
    expect(depthAttenuation(1, .5)).toBeGreaterThan(depthAttenuation(1, 1));
  });
  it('tint leaves the glass and fade-less colours alone, cools deeper colours, and keeps the peak channel', () => {
    const amber: [number, number, number] = [1, .6, .45];
    expect(depthTint(...amber, 0, 1)).toEqual(amber);
    expect(depthTint(...amber, 1, 0)).toEqual(amber);
    const deep = depthTint(...amber, 1, 1);
    expect(Math.max(...deep)).toBeCloseTo(1, 12);
    expect(deep[2] / deep[0]).toBeGreaterThan(amber[2] / amber[0]);
    expect(deep[1] / deep[0]).toBeGreaterThan(amber[1] / amber[0]);
    const half = depthTint(...amber, .5, 1);
    expect(half[2] / half[0]).toBeGreaterThan(amber[2] / amber[0]);
    expect(half[2] / half[0]).toBeLessThan(deep[2] / deep[0]);
    // A bluish base does not overshoot 1 in blue.
    const blue = depthTint(.45, .6, 1, 1, 1);
    expect(Math.max(...blue)).toBeCloseTo(1, 12);
    expect(depthTint(0, 0, 0, 1, 1)).toEqual([0, 0, 0]);
  });
  it('floor pool colour is a paler, cooler version of the stroke hue', () => {
    const [r, g, b] = floorColour(.055, .55);
    expect(r).toBeGreaterThan(b); expect(Math.max(r, g, b)).toBeLessThanOrEqual(1);
    const [sr, , sb] = strokeColor(.055, .55, 0, 0);
    expect(b / r).toBeGreaterThan(sb / sr);
  });
});

describe('projection through the window camera', () => {
  const camera = windowCamera(1.6, 1);
  it('leaves a segment at the glass where a 2D drawing would put it', () => {
    const p = projectSegment({ ax: .2, ay: .3, az: 0, bx: 1.1, by: .8, bz: 0, radius: .05 }, camera);
    expect(p.ax).toBeCloseTo(.2, 9); expect(p.ay).toBeCloseTo(.3, 9); expect(p.bx).toBeCloseTo(1.1, 9); expect(p.by).toBeCloseTo(.8, 9);
    expect(p.radius).toBeCloseTo(.05, 9); expect(p.scale).toBeCloseTo(1, 9); expect(p.z01).toBe(0);
  });
  it('draws a deeper segment smaller and toward the centre by the camera scale', () => {
    const z = .75, s = camera.scale(z);
    const p = projectSegment({ ax: .2, ay: .3, az: z, bx: 1.1, by: .8, bz: z, radius: .05 }, camera);
    expect(s).toBeLessThan(1); expect(s).toBeGreaterThan(.5);
    expect(p.scale).toBeCloseTo(s, 9); expect(p.z01).toBeCloseTo(.75, 9);
    expect(p.radius).toBeCloseTo(.05 * s, 9);
    expect(p.ax).toBeCloseTo(.8 + (.2 - .8) * s, 9); expect(p.ay).toBeCloseTo(.5 + (.3 - .5) * s, 9);
    expect(p.bx).toBeCloseTo(.8 + (1.1 - .8) * s, 9); expect(p.by).toBeCloseTo(.5 + (.8 - .5) * s, 9);
  });
  it('uses the midpoint depth of a segment that moves in z, projecting each end where it is', () => {
    const p = projectSegment({ ax: .5, ay: .5, az: 0, bx: .5, by: .5, bz: 1, radius: .1 }, camera);
    expect(p.z01).toBeCloseTo(.5, 9);
    expect(p.radius).toBeCloseTo(.1 * camera.scale(.5), 9);
    expect(p.ax).toBeCloseTo(.5, 9);
    expect(p.bx).toBeCloseTo(.8 + (.5 - .8) * camera.scale(1), 9);
    expect(projectSegment({ ax: 0, ay: 0, az: -1, bx: 0, by: 0, bz: 4, radius: .1 }, camera).z01).toBeGreaterThanOrEqual(0);
  });
  it('puts the floor pool on the bottom edge for a stroke at the glass and climbs it toward the horizon deeper in', () => {
    const at = (z: number, y = .4) => projectFloorPool({ ax: .3, ay: y, az: z, bx: .3, by: y, bz: z }, camera);
    expect(at(0).y).toBeCloseTo(0, 9);
    expect(at(0).x).toBeCloseTo(.3, 9);
    const near = at(.25), far = at(1);
    expect(far.y).toBeGreaterThan(near.y); expect(far.y).toBeLessThan(.5);
    expect(far.x).toBeGreaterThan(near.x); expect(far.x).toBeLessThan(.8);
    expect(far.rx).toBeLessThan(near.rx);
    // The ellipse is flatter than it is wide, and the shader recovers its height from the screen position alone: cy = (1 − scale) / 2 on the floor.
    for (const pool of [near, far]) { expect(pool.ry).toBeLessThan(pool.rx); expect(pool.ry).toBeCloseTo(pool.rx * .5 * (1 - 2 * pool.y) / camera.eye, 9); }
  });
  it('a higher hand lights a wider, fainter pool', () => {
    expect(floorPool(0).gain).toBeCloseTo(POOL_GAIN, 12);
    expect(floorPool(.8).radius).toBeGreaterThan(floorPool(.1).radius);
    expect(floorPool(.8).gain).toBeLessThan(floorPool(.1).gain);
    expect(floorPool(-1)).toEqual(floorPool(0));
    const low = projectFloorPool({ ax: .3, ay: .1, az: .25, bx: .3, by: .1, bz: .25 }, camera), high = projectFloorPool({ ax: .3, ay: .8, az: .25, bx: .3, by: .8, bz: .25 }, camera);
    expect(high.rx).toBeGreaterThan(low.rx); expect(high.gain).toBeLessThan(low.gain);
    expect(high.y).toBeCloseTo(low.y, 9);
  });
});

describe('stroke tracker', () => {
  it('draws a dot on the first frame of a hand, then segments from the previous position', () => {
    const tracker = new StrokeTracker();
    const first = tracker.update([hand(1, .5, .5)], 1.6, 1, 1 / 60, params);
    expect(first).toHaveLength(1);
    expect(first[0].ax).toBeCloseTo(.8, 12); expect(first[0].ay).toBeCloseTo(.5, 12); expect(first[0].az).toBeCloseTo(.3, 12);
    expect(first[0].bx).toBeCloseTo(.8, 12); expect(first[0].length).toBe(0);
    expect(first[0].amplitude).toBeGreaterThan(0);
    const second = tracker.update([hand(1, .6, .55, { velocity: { x: 6, y: 3, z: 0 }, speed: 6.7 })], 1.6, 1, 1 / 60, params);
    expect(second[0].ax).toBeCloseTo(.8, 12); expect(second[0].bx).toBeCloseTo(.96, 12); expect(second[0].by).toBeCloseTo(.55, 12);
    expect(second[0].length).toBeCloseTo(Math.hypot(.16, .05), 9);
    expect(second[0].speed).toBeCloseTo(Math.hypot(9.6, 3), 9);
  });
  it('lays segments down in the volume: endpoints carry z and a stroke can move in depth alone', () => {
    const tracker = new StrokeTracker();
    tracker.update([hand(1, .5, .5, { position: { x: .5, y: .5, z: 0 } })], 1, 1.5, 1 / 60, params);
    const s = tracker.update([hand(1, .5, .5, { position: { x: .5, y: .5, z: .2 }, velocity: { x: 0, y: 0, z: 12 } })], 1, 1.5, 1 / 60, params)[0];
    expect(s.az).toBe(0); expect(s.bz).toBeCloseTo(.3, 9);
    expect(s.length).toBeCloseTo(.3, 9); expect(s.speed).toBeCloseTo(18, 9); expect(s.vz).toBeCloseTo(18, 9);
    expect(s.z01).toBeCloseTo(.1, 9);
    expect(s.amplitude).toBeGreaterThan(brushAmplitude(1, 0, s.radius, 0, 1 / 60));
  });
  it('makes deeper ink dimmer and cooler by the depth fade, and leaves it alone without one', () => {
    const p = { ...params, depthFade: 1 };
    const seg = (z: number, fade: typeof params) => {
      const t = new StrokeTracker();
      t.update([hand(1, .5, .5, { position: { x: .5, y: .5, z } })], 1.6, 1, 1 / 60, fade);
      return t.update([hand(1, .6, .5, { position: { x: .6, y: .5, z } })], 1.6, 1, 1 / 60, fade)[0];
    };
    const shallow = seg(.1, p), deep = seg(.9, p);
    expect(shallow.z01).toBeCloseTo(.1, 9); expect(deep.z01).toBeCloseTo(.9, 9);
    expect(deep.amplitude).toBeLessThan(shallow.amplitude);
    expect(deep.amplitude).toBeCloseTo(shallow.amplitude * depthAttenuation(.9, 1) / depthAttenuation(.1, 1), 9);
    expect(deep.b / deep.r).toBeGreaterThan(shallow.b / shallow.r);
    expect(Math.max(deep.r, deep.g, deep.b)).toBeCloseTo(1, 9);
    const flat = seg(.9, params), flatShallow = seg(.1, params);
    expect(flat.amplitude).toBeCloseTo(flatShallow.amplitude, 9);
    expect([flat.r, flat.g, flat.b]).toEqual([flatShallow.r, flatShallow.g, flatShallow.b]);
    expect(flat.radius).toBeCloseTo(shallow.radius, 9);
  });
  it('forgets a hand that leaves so its return starts a fresh dot, never a line from the old spot', () => {
    const tracker = new StrokeTracker();
    tracker.update([hand(1, .1, .1)], 1, 1, 1 / 60, params);
    tracker.update([], 1, 1, 1 / 60, params);
    expect(tracker.tracked).toBe(0);
    const back = tracker.update([hand(1, .9, .9)], 1, 1, 1 / 60, params);
    expect(back[0].length).toBe(0); expect(back[0].ax).toBeCloseTo(.9, 12);
  });
  it('keeps every hand separately with distinct hue offsets', () => {
    const tracker = new StrokeTracker();
    tracker.update([hand(1, .2, .2), hand(2, .8, .8)], 1, 1, 1 / 60, params);
    const segs = tracker.update([hand(1, .25, .2), hand(2, .75, .8)], 1, 1, 1 / 60, params);
    expect(segs).toHaveLength(2);
    expect(segs[0].ax).toBeCloseTo(.2, 12); expect(segs[1].ax).toBeCloseTo(.8, 12);
    expect([segs[0].r, segs[0].g, segs[0].b]).not.toEqual([segs[1].r, segs[1].g, segs[1].b]);
    expect(HUE_OFFSETS[0]).toBe(0);
  });
  it('ink target and sparkle rate stay sane', () => {
    expect(inkTarget(0, 1 / 60)).toBe(0);
    expect(inkTarget(1000, 1 / 60)).toBe(1);
    expect(inkTarget(.1, 1 / 60)).toBeGreaterThan(0); expect(inkTarget(.1, 1 / 60)).toBeLessThan(1);
    expect(sparkleRate(0, .045, 1 / 60)).toBeGreaterThan(0);
    expect(sparkleRate(.02, .045, 1 / 60)).toBeGreaterThan(sparkleRate(.01, .045, 1 / 60));
    expect(sparkleRate(0, 0, 0)).toBe(0);
  });
});

describe('depth signal', () => {
  const seg = (amplitude: number, z01: number) => ({ amplitude, z01 });
  it('is 0 before any ink, follows a single depth, and weights depths by energy', () => {
    const m = new InkDepth();
    expect(m.value).toBe(0);
    for (let i = 0; i < 30; i++) m.update([seg(.1, .8)], 1 / 60);
    expect(m.value).toBeCloseTo(.8, 6);
    const two = new InkDepth();
    for (let i = 0; i < 30; i++) two.update([seg(.3, .2), seg(.1, 1)], 1 / 60);
    expect(two.value).toBeCloseTo((.3 * .2 + .1 * 1) / .4, 6);
  });
  it('follows the hand as it moves in depth, with a short memory', () => {
    const m = new InkDepth();
    for (let i = 0; i < 60; i++) m.update([seg(.1, .2)], 1 / 60);
    for (let i = 0; i < 60; i++) m.update([seg(.1, .9)], 1 / 60);
    expect(m.value).toBeGreaterThan(.8); expect(m.value).toBeLessThan(.9);
  });
  it('fades to 0 when nothing recent is laid down, over many frames rather than in one', () => {
    const m = new InkDepth();
    for (let i = 0; i < 30; i++) m.update([seg(.1, .9)], 1 / 60);
    let prev = m.value, t = 0, drops = 0;
    while (m.value > 0 && t < 10) {
      m.update([], 1 / 60); t += 1 / 60;
      expect(m.value).toBeLessThanOrEqual(prev + 1e-12);
      if (m.value < prev - 1e-3) drops++;
      prev = m.value;
    }
    expect(m.value).toBe(0);
    expect(t).toBeLessThan(6);
    expect(drops).toBeGreaterThan(5);
    m.update([seg(DEPTH_GATE * 100, .5)], 0);
    expect(m.value).toBeCloseTo(.5, 9);
    m.reset(); expect(m.value).toBe(0);
  });
  it('stays in range for any input and ignores non-positive time', () => {
    const m = new InkDepth();
    m.update([seg(1e6, 3), seg(1e6, -1), seg(-5, .5)], -1);
    expect(m.value).toBeGreaterThanOrEqual(0); expect(m.value).toBeLessThanOrEqual(1);
    expect(m.value).toBeCloseTo(.5, 9);
  });
});

describe('sparkles', () => {
  const seg = { ax: .5, ay: .5, az: .3, bx: .6, by: .5, bz: .3, radius: .05, vx: .5, vy: 0, vz: 0 };
  it('is deterministic for a seed and never exceeds its capacity', () => {
    const a = new SparkleField(50, 3), b = new SparkleField(50, 3);
    for (let i = 0; i < 20; i++) { a.emit(seg, 7.3, [1, .8, .6]); b.emit(seg, 7.3, [1, .8, .6]); a.step(1 / 60, i / 60, .5, 1.6, 1); b.step(1 / 60, i / 60, .5, 1.6, 1); }
    expect(a.count).toBe(50); expect(b.count).toBe(50);
    expect(Array.from(a.x)).toEqual(Array.from(b.x)); expect(Array.from(a.vy)).toEqual(Array.from(b.vy)); expect(Array.from(a.z)).toEqual(Array.from(b.z));
    expect(a.alive).toBe(1);
    expect(new SparkleField(0).alive).toBe(0);
  });
  it('carries fractional emission and does not bank a burst while full', () => {
    const f = new SparkleField(10, 1);
    f.emit(seg, .4, [1, 1, 1]); expect(f.count).toBe(0);
    f.emit(seg, .4, [1, 1, 1]); expect(f.count).toBe(0);
    f.emit(seg, .4, [1, 1, 1]); expect(f.count).toBe(1);
    f.emit(seg, 100, [1, 1, 1]); expect(f.count).toBe(10);
    for (let i = 0; i < 60; i++) f.step(1 / 10, i / 10, 0, 1.6, 1);
    expect(f.count).toBe(0);
    f.emit(seg, 0, [1, 1, 1]); expect(f.count).toBe(0);
    f.emit(seg, 1, [1, 1, 1]); expect(f.count).toBeLessThanOrEqual(2);
  });
  it('particles live for their lifetime, then die; intensity fades to zero and stays within 0..1', () => {
    const f = new SparkleField(100, 9);
    f.emit(seg, 100, [1, 1, 1]);
    const lives = Array.from(f.life.subarray(0, f.count));
    expect(Math.min(...lives)).toBeGreaterThanOrEqual(.7); expect(Math.max(...lives)).toBeLessThanOrEqual(2.5);
    for (let i = 0; i < f.count; i++) { const v = f.intensity(i, 0); expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThanOrEqual(1); }
    let t = 0;
    while (f.count > 0 && t < 5) { f.step(1 / 60, t, 0, 1.6, 1); t += 1 / 60; }
    expect(f.count).toBe(0); expect(t).toBeLessThan(2.6);
  });
  it('inlined curl matches Noise.curl2 component for component', () => {
    const noise = new Noise(1337);
    const samples: [number, number, number][] = [[0, 0, 0], [.37, .81, .05], [1.6, .96, 12.5], [-2.3, 4.7, 300.1], [255.99, .001, 7], [.5, .5, .5]];
    let magnitude = 0;
    for (const [x, y, t] of samples) {
      const c = noise.curl2(x, y, t, CURL_EPS);
      expect(curlX(noise, x, y, t), `x at ${x},${y},${t}`).toBeCloseTo(c.x, 9);
      expect(curlY(noise, x, y, t), `y at ${x},${y},${t}`).toBeCloseTo(c.y, 9);
      magnitude = Math.max(magnitude, Math.abs(c.x), Math.abs(c.y));
    }
    expect(magnitude, 'the samples exercise a non-trivial field').toBeGreaterThan(.1);
    expect(noise.curl2(.37, .81, .05)).toEqual(noise.curl2(.37, .81, .05, CURL_EPS));
  });
  it('drifts on the curl field and culls off-screen particles', () => {
    const f = new SparkleField(20, 5);
    f.emit({ ...seg, vx: 0, vy: 0 }, 20, [1, 1, 1]);
    const before = Array.from(f.x.subarray(0, f.count));
    for (let i = 0; i < 30; i++) f.step(1 / 60, i / 60, 1, 1.6, 1);
    const moved = Array.from(f.x.subarray(0, f.count)).some((x, i) => Math.abs(x - before[i]) > 1e-4);
    expect(moved).toBe(true);
    const edge = new SparkleField(20, 5);
    edge.emit({ ...seg, ax: -.2, ay: .5, bx: -.2, by: .5, radius: .001, vx: 0, vy: 0 }, 5, [1, 1, 1]);
    expect(edge.count).toBe(5);
    edge.step(1 / 60, 0, 0, 1.6, 1);
    expect(edge.count).toBe(0);
  });
  it('lives in the volume: born around the stroke depth, carried by an inherited push that relaxes, culled past the walls', () => {
    const f = new SparkleField(100, 2);
    f.emit({ ...seg, az: .6, bz: .6 }, 100, [1, 1, 1]);
    const zs = Array.from(f.z.subarray(0, f.count));
    expect(Math.min(...zs)).toBeGreaterThanOrEqual(.6 - .05 * .3 - 1e-6); expect(Math.max(...zs)).toBeLessThanOrEqual(.6 + .05 * .3 + 1e-6);
    expect(Math.max(...zs) - Math.min(...zs)).toBeGreaterThan(.01);
    const pushed = new SparkleField(10, 3);
    pushed.emit({ ...seg, vz: 2 }, 1, [1, 1, 1]);
    const z0 = pushed.z[0], vz0 = pushed.vz[0];
    expect(vz0).toBeCloseTo(.7, 6);
    pushed.step(1 / 60, 0, 0, 1.6, 1);
    expect(pushed.z[0]).toBeGreaterThan(z0); expect(pushed.vz[0]).toBeLessThan(vz0);
    const back = new SparkleField(20, 5);
    back.emit({ ...seg, az: 1.2, bz: 1.2, radius: .001 }, 5, [1, 1, 1]);
    expect(back.count).toBe(5);
    back.step(1 / 60, 0, 0, 1.6, 1);
    expect(back.count).toBe(0);
    back.emit({ ...seg, az: 1.2, bz: 1.2, radius: .001 }, 5, [1, 1, 1]);
    back.step(1 / 60, 0, 0, 1.6, 1.5);
    expect(back.count).toBe(5);
  });
});

describe('probe reduction', () => {
  it('maps the readback to glow and coverage in 0..1', () => {
    const n = 16 * 16;
    expect(reduceProbe(new Uint8Array(n * 4), n)).toEqual({ glow: 0, coverage: 0 });
    expect(reduceProbe(new Uint8Array(n * 4).fill(255), n)).toEqual({ glow: 1, coverage: 1 });
    const px = new Uint8Array(n * 4);
    for (let i = 0; i < n / 2; i++) { px[i * 4] = 255; px[i * 4 + 1] = 51; }
    const r = reduceProbe(px, n);
    expect(r.glow).toBeCloseTo(.5, 9); expect(r.coverage).toBeCloseTo(.1, 9);
    expect(reduceProbe([], 0)).toEqual({ glow: 0, coverage: 0 });
  });
});
