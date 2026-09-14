import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Capsule, HandState } from '../../src/sim/input/types';
import type { SurfaceField } from '../../src/sim/core/types';
import { Noise } from '../../src/sim/core/noise';
import { windowCamera } from '../../src/sim/core/camera';
import { syntheticHandCapsules } from '../../src/sim/input/synthetic';
import { DEFAULT_LEAP_BOX, leapFrameToHands, parseLeapMessage } from '../../src/sim/input/leap';
import {
  CURL_EPS, DEFAULT_BRUSH_SIZE, DEPTH_DIM, DEPTH_GATE, HUE_OFFSETS, HUE_WANDER, InkDepth, MIN_CAPSULE_BRUSH, POOL_GAIN, SCAN_BUDGET, SCAN_DEPTH_NOISE, SCAN_DEPTH_STEP, SCAN_RADIUS_CELLS, SOLID_NORM,
  SparkleField, StrokeTracker, SurfacePainter, TIP_SPARKLE_BIAS, accumulate, brushAmplitude, brushKernel, brushRadius, capsuleBrush, capsuleTips, createScanStrokes,
  curlX, curlY, decayFor, deposit, depthAttenuation, depthTint, floorColour, floorFor, floorPool, hueWander, inkTarget, paintingStrokes, projectFloorPool, projectSegment,
  projectSweep, reduceProbe, scanAmplitude, scanBounds, scanBrush, scanDotSize, scanWeight, segmentDistance, segmentLight, solidGain, sparkColour, sparkleRate, strokeColor, sweepDistance, wrapHue,
  SCAN_SWEEP, type CapsuleStroke,
} from '../../src/sim/sims/trails/logic';

const hand = (id: number, x: number, y: number, extra: Partial<HandState> = {}): HandState => ({
  id, position: { x, y, z: .3 }, velocity: { x: 0, y: 0, z: 0 }, speed: 0,
  extent: { min: { x: x - .05, y: y - .05, z: .3 }, max: { x: x + .05, y: y + .05, z: .3 } }, radius: .05,
  openness: 1, pinch: 0, confidence: 1, ageMs: 0, staleMs: 0, push: 0, points: [], capsules: [], ...extra,
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

// ---------------------------------------------------------------------------
// Solid hands: capsules as brushes
// ---------------------------------------------------------------------------

describe('solid hands', () => {
  const aspect = 1.6, depth = 1, dt = 1 / 60;
  /** A skeleton hand in sim space (the synthetic performer's, used directly: orientation is irrelevant to the tracker). */
  const skeleton = (x: number, y: number, z: number, openness = 1, r = .06): Capsule[] => syntheticHandCapsules({ x, y, z }, openness, r);
  const solidHand = (id: number, x: number, y: number, z: number, extra: Partial<HandState> = {}): HandState =>
    hand(id, x, y, { position: { x, y, z }, radius: .06, capsules: skeleton(x, y, z), ...extra });

  it('finds the five fingertips of the synthetic skeleton and neither the forearm nor the palm', () => {
    const caps = skeleton(.5, .5, .3);
    const tips = capsuleTips(caps);
    expect(caps).toHaveLength(19);
    expect(Array.from(tips).reduce((a, b) => a + b, 0)).toBe(5);
    expect(tips[0], 'forearm').toBe(0);
    for (let f = 0; f < 4; f++) { expect(tips[1 + f * 4], `metacarpal ${f}`).toBe(0); expect(tips[1 + f * 4 + 3], `distal phalanx ${f}`).toBe(1); }
    expect(tips[caps.length - 1], 'thumb tip').toBe(1); expect(tips[caps.length - 2], 'thumb base').toBe(0);
    expect(capsuleTips(skeleton(.5, .5, .3, 0)), 'a fist has the same tips').toEqual(tips);
  });
  it('finds five fingertips on a real Leap skeleton, whose carpal bases are free proximal ends, and none on a lone capsule', () => {
    const frame = readFileSync(new URL('./fixtures/leap-hand-frame.json', import.meta.url), 'utf8');
    const leap = leapFrameToHands(parseLeapMessage(frame)!, DEFAULT_LEAP_BOX)[0].capsules!;
    expect(Array.from(capsuleTips(leap)).reduce((a, b) => a + b, 0)).toBe(5);
    expect(capsuleTips(leap)[leap.length - 1], 'forearm').toBe(0);
    expect(Array.from(capsuleTips([{ a: { x: 0, y: 0, z: 0 }, b: { x: .1, y: 0, z: 0 }, radius: .01 }]))).toEqual([0]);
    expect(Array.from(capsuleTips([]))).toEqual([]);
  });
  it('gives each capsule its own brush radius, scaled by the brush size and floored', () => {
    expect(capsuleBrush(.03, DEFAULT_BRUSH_SIZE)).toBeCloseTo(.03, 12);
    expect(capsuleBrush(.03, DEFAULT_BRUSH_SIZE * 2)).toBeCloseTo(.06, 12);
    expect(capsuleBrush(.001, DEFAULT_BRUSH_SIZE)).toBe(MIN_CAPSULE_BRUSH);
    expect(capsuleBrush(.03, -1)).toBe(MIN_CAPSULE_BRUSH);
  });
  it('normalises by the footprint: gain 1 for the sphere itself, never a boost, the square root of the ratio beyond', () => {
    expect(solidGain(.136, .136)).toBe(1);
    expect(solidGain(.05, .136)).toBe(1);
    expect(solidGain(.136 * 4, .136)).toBeCloseTo(.5, 12);
    expect(solidGain(.136 * 49, .136)).toBeCloseTo(1 / 7, 12);
    expect(SOLID_NORM).toBe(.5);
    expect(solidGain(0, 1)).toBe(1); expect(solidGain(1, 0)).toBe(1);
  });
  it('yields one sweep per capsule: dots when the skeleton is first seen, then sweeps from where each capsule was to where it is', () => {
    const tracker = new StrokeTracker();
    const first = tracker.update([solidHand(1, .5, .5, .3)], aspect, depth, dt, params);
    expect(first).toHaveLength(1);
    const caps = skeleton(.5, .5, .3);
    expect(first[0].solid).toBe(caps.length); expect(first[0].strokes).toHaveLength(caps.length);
    first[0].strokes.forEach((s, i) => {
      expect(s.ax0).toBe(s.ax1); expect(s.by0).toBe(s.by1); expect(s.az0).toBe(s.az1); expect(s.length).toBe(0);
      expect(s.ax1).toBeCloseTo(caps[i].a.x * aspect, 9); expect(s.bz1).toBeCloseTo(caps[i].b.z * depth, 9);
      expect(s.radius).toBeCloseTo(capsuleBrush(caps[i].radius * aspect, params.brushSize), 9);
      expect(s.amplitude).toBeGreaterThan(0); expect(s.tip).toBe(capsuleTips(caps)[i]);
      expect(Math.max(s.r, s.g, s.b)).toBeCloseTo(1, 9);
    });
    const moved = tracker.update([solidHand(1, .55, .5, .3, { velocity: { x: 3, y: 0, z: 0 }, speed: 3 })], aspect, depth, dt, params)[0];
    const next = skeleton(.55, .5, .3);
    moved.strokes.forEach((s, i) => {
      expect(s.ax0).toBeCloseTo(caps[i].a.x * aspect, 6); expect(s.bx0).toBeCloseTo(caps[i].b.x * aspect, 6);
      expect(s.ax1).toBeCloseTo(next[i].a.x * aspect, 9); expect(s.bx1).toBeCloseTo(next[i].b.x * aspect, 9);
      expect(s.length).toBeCloseTo(.05 * aspect, 6);
      expect(s.vx).toBeCloseTo(.05 * aspect / dt, 4); expect(s.speed).toBeGreaterThan(0);
      expect(s.amplitude).toBeGreaterThan(first[0].strokes[i].amplitude);
    });
  });
  it('keeps a full skeleton within an order of magnitude of the sphere brush in total, with thin bones brighter per pixel than the forearm', () => {
    const tracker = new StrokeTracker();
    tracker.update([solidHand(1, .5, .5, .3)], aspect, depth, dt, params);
    const seg = tracker.update([solidHand(1, .53, .5, .3, { velocity: { x: 1.8, y: 0, z: 0 }, speed: 1.8 })], aspect, depth, dt, params)[0];
    const sphere = seg.amplitude * 2 * seg.radius;
    let total = 0, raw = 0;
    for (const s of seg.strokes) {
      const lx = s.bx1 - s.ax1, ly = s.by1 - s.ay1, lz = s.bz1 - s.az1, foot = Math.sqrt(lx * lx + ly * ly + lz * lz) + 2 * s.radius;
      total += s.amplitude * foot;
      raw += brushAmplitude(params.brightness, s.length, s.radius, s.speed, dt) * foot;
    }
    expect(total / sphere).toBeGreaterThan(1); expect(total / sphere).toBeLessThan(12);
    expect(raw / sphere, 'without the normalisation the hand would be far brighter').toBeGreaterThan(30);
    const forearm = seg.strokes[0], tip = seg.strokes.find(s => s.tip)!;
    expect(forearm.radius).toBeGreaterThan(tip.radius);
    expect(tip.amplitude).toBeGreaterThan(forearm.amplitude);
  });
  it('paints a one-capsule hand that equals the sphere brush exactly like the sphere brush (gain 1)', () => {
    const tracker = new StrokeTracker();
    const at = (x: number) => {
      const speed = .05 * aspect / dt;
      const radius = brushRadius(params.brushSize, .06 * aspect, speed) / aspect * DEFAULT_BRUSH_SIZE / params.brushSize;
      return hand(1, x, .5, { position: { x, y: .5, z: .3 }, velocity: { x: speed / aspect, y: 0, z: 0 }, speed, radius: .06, capsules: [{ a: { x, y: .5, z: .3 }, b: { x, y: .5, z: .3 }, radius }] });
    };
    tracker.update([at(.5)], aspect, depth, dt, params);
    const seg = tracker.update([at(.55)], aspect, depth, dt, params)[0];
    expect(seg.strokes).toHaveLength(1);
    expect(seg.strokes[0].radius).toBeCloseTo(seg.radius, 9);
    expect(seg.strokes[0].amplitude).toBeCloseTo(seg.amplitude, 9);
    expect([seg.strokes[0].r, seg.strokes[0].g, seg.strokes[0].b]).toEqual([seg.r, seg.g, seg.b]);
  });
  it('falls back to the single brush as one point sweep for a hand without a skeleton', () => {
    const tracker = new StrokeTracker();
    tracker.update([hand(1, .5, .5)], aspect, depth, dt, params);
    const seg = tracker.update([hand(1, .6, .55, { velocity: { x: 6, y: 3, z: 0 }, speed: 6.7 })], aspect, depth, dt, params)[0];
    expect(seg.solid).toBe(0); expect(seg.strokes).toHaveLength(1);
    const s = seg.strokes[0];
    expect([s.ax0, s.ay0, s.az0]).toEqual([s.bx0, s.by0, s.bz0]); expect([s.ax1, s.ay1, s.az1]).toEqual([s.bx1, s.by1, s.bz1]);
    expect([s.ax0, s.ay0, s.az0, s.ax1, s.ay1, s.az1]).toEqual([seg.ax, seg.ay, seg.az, seg.bx, seg.by, seg.bz]);
    expect(s.radius).toBe(seg.radius); expect(s.amplitude).toBe(seg.amplitude); expect(s.tip).toBe(0);
    expect([s.r, s.g, s.b, s.length, s.speed, s.vx]).toEqual([seg.r, seg.g, seg.b, seg.length, seg.speed, seg.vx]);
  });
  it('restarts the capsule memory when the skeleton comes and goes, so no sweep joins the old pose', () => {
    const tracker = new StrokeTracker();
    tracker.update([solidHand(1, .2, .5, .3)], aspect, depth, dt, params);
    tracker.update([hand(1, .5, .5)], aspect, depth, dt, params);
    const back = tracker.update([solidHand(1, .8, .5, .3)], aspect, depth, dt, params)[0];
    for (const s of back.strokes) { expect(s.length).toBe(0); expect(s.ax0).toBe(s.ax1); }
    // A change of shape (a different capsule count) also restarts.
    const fewer = tracker.update([solidHand(1, .85, .5, .3, { capsules: skeleton(.85, .5, .3).slice(0, 5) })], aspect, depth, dt, params)[0];
    expect(fewer.strokes).toHaveLength(5);
    for (const s of fewer.strokes) expect(s.length).toBe(0);
  });
  it('sweep distance is zero inside the swept quad, the edge distance outside, and the point brush reduces to its path', () => {
    // A vertical capsule (0,0)-(0,1) moving right to (1,0)-(1,1).
    expect(sweepDistance(.5, .5, 0, 0, 0, 1, 1, 0, 1, 1)).toBe(0);
    expect(sweepDistance(.01, .99, 0, 0, 0, 1, 1, 0, 1, 1)).toBe(0);
    expect(sweepDistance(1.5, .5, 0, 0, 0, 1, 1, 0, 1, 1)).toBeCloseTo(.5, 12);
    expect(sweepDistance(.5, -.25, 0, 0, 0, 1, 1, 0, 1, 1)).toBeCloseTo(.25, 12);
    expect(sweepDistance(-1, 2, 0, 0, 0, 1, 1, 0, 1, 1)).toBeCloseTo(Math.SQRT2, 12);
    // A rotating capsule: a point between its two poses is swept.
    expect(sweepDistance(.2, .2, 0, 0, 1, 0, 0, 0, 0, 1)).toBe(0);
    // A point brush along its path: exactly the segment distance, no plateau.
    expect(sweepDistance(.5, .3, 0, 0, 0, 0, 1, 0, 1, 0)).toBeCloseTo(segmentDistance(.5, .3, 0, 0, 1, 0), 12);
    expect(sweepDistance(.5, 0, 0, 0, 0, 0, 1, 0, 1, 0)).toBe(0);
    expect(sweepDistance(3, 0, 0, 0, 0, 0, 1, 0, 1, 0)).toBeCloseTo(2, 12);
    // A still point: a dot, nothing more.
    expect(sweepDistance(.3, .4, 0, 0, 0, 0, 0, 0, 0, 0)).toBeCloseTo(.5, 12);
    expect(sweepDistance(.3, 0, 0, 0, 0, 0, 0, 0, 0, 0)).toBeCloseTo(.3, 12);
  });
  it('projects a point sweep exactly like a segment, and a capsule by all four ends', () => {
    const camera = windowCamera(aspect, depth);
    const dot = (ax: number, ay: number, az: number, bx: number, by: number, bz: number, radius: number): CapsuleStroke =>
      ({ ax0: ax, ay0: ay, az0: az, bx0: ax, by0: ay, bz0: az, ax1: bx, ay1: by, az1: bz, bx1: bx, by1: by, bz1: bz, radius, amplitude: 1, r: 1, g: 1, b: 1, z01: 0, tip: 0, length: 0, speed: 0, vx: 0, vy: 0, vz: 0 });
    const p = projectSweep(dot(.2, .3, .25, 1.1, .8, .75, .05), camera), q = projectSegment({ ax: .2, ay: .3, az: .25, bx: 1.1, by: .8, bz: .75, radius: .05 }, camera);
    expect([p.ax0, p.ay0, p.ax1, p.ay1, p.radius, p.scale, p.z01]).toEqual([q.ax, q.ay, q.bx, q.by, q.radius, q.scale, q.z01]);
    expect([p.bx0, p.by0, p.bx1, p.by1]).toEqual([p.ax0, p.ay0, p.ax1, p.ay1]);
    const s = projectSweep({ ...dot(.2, .3, 0, .2, .3, 0, .05), bx0: .6, by0: .3, bx1: .6, by1: .3, bz0: 1, bz1: 1 }, camera);
    expect(s.ax0).toBeCloseTo(.2, 9); expect(s.bx0).toBeCloseTo(.8 + (.6 - .8) * camera.scale(1), 9);
    expect(s.radius).toBeCloseTo(.05 * camera.scale(.5), 9); expect(s.z01).toBeCloseTo(.5, 9);
  });
  it('sheds sparkles from the fingertips far more often than from the rest of the hand', () => {
    const tracker = new StrokeTracker(), field = new SparkleField(20_000, 4);
    let nearTip = 0, elsewhere = 0;
    for (let i = 0; i < 80; i++) {
      const x = .3 + i * .004;
      const seg = tracker.update([solidHand(1, x, .5, .3, { velocity: { x: .24, y: 0, z: 0 }, speed: .24 })], aspect, depth, dt, params)[0];
      const before = field.count;
      field.emitFrom(seg.strokes, 12, [1, 1, 1]);
      const tips = seg.strokes.filter(s => s.tip);
      for (let k = before; k < field.count; k++) {
        const px = field.x[k], py = field.y[k], pz = field.z[k];
        let near = false;
        for (const t of tips) {
          const abx = t.bx1 - t.bx0, aby = t.by1 - t.by0, abz = t.bz1 - t.bz0, l2 = abx * abx + aby * aby + abz * abz;
          const u = l2 > 1e-12 ? Math.max(0, Math.min(1, ((px - t.bx0) * abx + (py - t.by0) * aby + (pz - t.bz0) * abz) / l2)) : 0;
          const dx = px - (t.bx0 + abx * u), dy = py - (t.by0 + aby * u), dz = pz - (t.bz0 + abz * u);
          if (Math.sqrt(dx * dx + dy * dy + dz * dz) <= t.radius) { near = true; break; }
        }
        if (near) nearTip++; else elsewhere++;
      }
    }
    expect(nearTip + elsewhere).toBe(80 * 12);
    expect(nearTip / (nearTip + elsewhere)).toBeGreaterThan(.6);
    expect(nearTip).toBeGreaterThan(elsewhere * 2);
    expect(TIP_SPARKLE_BIAS).toBeGreaterThan(1);
    // A point brush sheds along its path as before; an empty stroke list sheds nothing.
    const plain = new SparkleField(10, 1);
    plain.emitFrom([{ ax0: 0, ay0: .5, az0: .3, bx0: 0, by0: .5, bz0: .3, ax1: 1, ay1: .5, az1: .3, bx1: 1, by1: .5, bz1: .3, radius: .001, amplitude: 1, r: 1, g: 1, b: 1, z01: .3, tip: 0, length: 1, speed: 0, vx: 0, vy: 0, vz: 0 }], 10, [1, 1, 1]);
    expect(plain.count).toBe(10);
    expect(Math.max(...Array.from(plain.x.subarray(0, 10))) - Math.min(...Array.from(plain.x.subarray(0, 10)))).toBeGreaterThan(.2);
    plain.emitFrom([], 10, [1, 1, 1]);
    expect(plain.count).toBe(10);
  });
  it('is deterministic: the same skeleton sequence yields identical sweeps and sparkles', () => {
    const run = () => {
      const tracker = new StrokeTracker(), field = new SparkleField(500, 8);
      const strokes: CapsuleStroke[] = [];
      for (let i = 0; i < 40; i++) {
        const x = .3 + .3 * Math.sin(i * .1), y = .5 + .2 * Math.cos(i * .13), z = .3 + .2 * Math.sin(i * .07);
        const seg = tracker.update([solidHand(1, x, y, z, { velocity: { x: Math.cos(i * .1), y: 0, z: 0 }, speed: Math.abs(Math.cos(i * .1)), capsules: skeleton(x, y, z, .5 + .5 * Math.sin(i * .2)) })], aspect, depth, dt, params)[0];
        strokes.push(...seg.strokes);
        field.emitFrom(seg.strokes, 2.5, [1, .8, .6]);
        field.step(dt, i * dt, .5, aspect, depth);
      }
      return { strokes, x: Array.from(field.x), z: Array.from(field.z), count: field.count };
    };
    const a = run(), b = run();
    expect(a.strokes).toEqual(b.strokes);
    expect(a.x).toEqual(b.x); expect(a.z).toEqual(b.z); expect(a.count).toBe(b.count);
    expect(a.count).toBeGreaterThan(50);
  });
});

// ---------------------------------------------------------------------------
// Scanned surface: the shell paints where it moves
// ---------------------------------------------------------------------------

describe('scanned surface', () => {
  const aspect = 1.5, depth = 1;
  /** A field with a rectangle of cells [x0, x1) × [y0, y1) scanned at depth `z`. */
  const rect = (width: number, height: number, x0: number, x1: number, y0: number, y1: number, z: number): SurfaceField => {
    const zs = new Float32Array(width * height).fill(1), mask = new Uint8Array(width * height);
    for (let row = y0; row < y1; row++) for (let col = x0; col < x1; col++) { zs[row * width + col] = z; mask[row * width + col] = 255; }
    return { width, height, z: zs, mask };
  };
  const cellOf = (s: CapsuleStroke, width: number, height: number) => ({ col: Math.floor(s.ax1 / aspect * width), row: Math.floor(s.ay1 * height) });

  it('only records the first scan, paints nothing for a still shell, and lists the silhouette edge inside the grid', () => {
    const painter = new SurfacePainter(), out = createScanStrokes();
    const field = rect(12, 8, 3, 7, 2, 5, .4);
    painter.update(field, [], aspect, depth, params, out);
    expect(out.strokes).toHaveLength(0); expect(out.edges).toHaveLength(0);
    painter.update(field, [], aspect, depth, params, out);
    expect(out.strokes).toHaveLength(0); expect(out.covered).toBe(0);
    expect(out.edges).toHaveLength(4 * 3 - 2 * 1);
    for (const e of out.edges) { expect(e.tip).toBe(1); expect(e.amplitude).toBe(0); expect(e.az1).toBeCloseTo(.4 * depth, 6); }
    // A shell touching the grid border has no edge along that border.
    const flush = new SurfacePainter(), o2 = createScanStrokes(), f2 = rect(12, 8, 0, 4, 0, 3, .4);
    flush.update(f2, [], aspect, depth, params, o2); flush.update(f2, [], aspect, depth, params, o2);
    expect(o2.edges).toHaveLength(4 + 3 - 1);
    expect(o2.edges.some(e => cellOf(e, 12, 8).col === 0 && cellOf(e, 12, 8).row === 0)).toBe(false);
    // No scan at all: nothing, and the memory forgets so the next scan only records again.
    painter.update(null, [], aspect, depth, params, out);
    expect(out.strokes).toHaveLength(0); expect(out.edges).toHaveLength(0);
    painter.update(field, [], aspect, depth, params, out);
    expect(out.edges).toHaveLength(0);
  });
  it('paints the cells a moving shell newly covers, at full weight, at their 3D position, and nothing in its unchanged interior', () => {
    const painter = new SurfacePainter(), out = createScanStrokes();
    painter.update(rect(12, 8, 3, 7, 2, 5, .4), [], aspect, depth, params, out);
    painter.update(rect(12, 8, 4, 8, 2, 5, .4), [], aspect, depth, params, out);
    expect(out.strokes).toHaveLength(3); expect(out.covered).toBe(3);
    const cell = Math.max(aspect / 12, 1 / 8);
    for (const s of out.strokes) {
      expect(cellOf(s, 12, 8).col).toBe(7);
      expect(s.ax1).toBeCloseTo(7.5 / 12 * aspect, 9); expect(s.az1).toBeCloseTo(.4 * depth, 6); expect(s.z01).toBeCloseTo(.4, 6);
      expect(s.amplitude).toBeCloseTo(scanAmplitude(params.brightness, 1, 0), 9);
      expect(s.radius).toBeCloseTo(scanBrush(cell, params.brushSize), 9);
      expect(s.length).toBe(0); expect(s.tip).toBe(0); expect(s.ax0).toBe(s.bx1);
    }
    expect(out.edges.length).toBeGreaterThan(0);
  });
  it('paints every cell of a shell pushing in depth, weighted by how far its depth moved beyond the noise floor', () => {
    expect(scanWeight(0)).toBe(0); expect(scanWeight(SCAN_DEPTH_NOISE)).toBe(0); expect(scanWeight(-SCAN_DEPTH_NOISE * .5)).toBe(0);
    expect(scanWeight(SCAN_DEPTH_NOISE + SCAN_DEPTH_STEP * .5)).toBeCloseTo(.5, 12); expect(scanWeight(-(SCAN_DEPTH_NOISE + SCAN_DEPTH_STEP))).toBe(1); expect(scanWeight(1)).toBe(1);
    const painter = new SurfacePainter(), out = createScanStrokes();
    painter.update(rect(12, 8, 3, 7, 2, 5, .4), [], aspect, depth, params, out);
    // Depth noise on a still hand paints nothing.
    painter.update(rect(12, 8, 3, 7, 2, 5, .4 + SCAN_DEPTH_NOISE * .6 / depth), [], aspect, depth, params, out);
    expect(out.strokes).toHaveLength(0); expect(out.covered).toBe(0);
    painter.update(rect(12, 8, 3, 7, 2, 5, .4 + (SCAN_DEPTH_NOISE * .6 + SCAN_DEPTH_NOISE + SCAN_DEPTH_STEP * .5) / depth), [], aspect, depth, params, out);
    expect(out.strokes).toHaveLength(12);
    for (const s of out.strokes) expect(s.amplitude).toBeCloseTo(scanAmplitude(params.brightness, .5, 0), 4);
    expect(out.covered).toBeCloseTo(6, 3);
    painter.update(rect(12, 8, 3, 7, 2, 5, .9), [], aspect, depth, params, out);
    for (const s of out.strokes) expect(s.amplitude).toBeCloseTo(scanAmplitude(params.brightness, 1, 0) * depthAttenuation(.9, params.depthFade), 6);
    expect(scanAmplitude(1, 1, 3)).toBeGreaterThan(scanAmplitude(1, 1, 0));
    expect(scanAmplitude(0, 1, 1)).toBe(0); expect(scanAmplitude(1, 0, 1)).toBe(0);
    expect(scanBrush(.02, DEFAULT_BRUSH_SIZE)).toBeCloseTo(.02 * SCAN_RADIUS_CELLS, 12);
    expect(scanBrush(.02, 0)).toBe(.02);
  });
  it('decimates a wild frame to the budget and pools the light so the total is unchanged', () => {
    const painter = new SurfacePainter(), out = createScanStrokes();
    painter.update(rect(96, 64, 0, 96, 0, 64, .2), [], aspect, depth, params, out);
    painter.update(rect(96, 64, 0, 96, 0, 64, .8), [], aspect, depth, params, out);
    expect(out.strokes.length).toBeLessThanOrEqual(SCAN_BUDGET);
    expect(out.strokes.length).toBeGreaterThan(SCAN_BUDGET / 2);
    const total = out.strokes.reduce((s, x) => s + x.amplitude, 0);
    expect(total).toBeCloseTo(96 * 64 * scanAmplitude(params.brightness, 1, 0) * depthAttenuation(.8, params.depthFade), 3);
    expect(out.covered).toBe(96 * 64);
  });
  it("lends each cell the nearest hand's speed, velocity and hue", () => {
    const painter = new SurfacePainter(), out = createScanStrokes(), tracker = new StrokeTracker();
    const pair = (x: number) => [hand(1, x, .5, { velocity: { x: 1, y: 0, z: 0 }, speed: 1 }), hand(2, .9, .5)];
    tracker.update(pair(.1), aspect, depth, 1 / 60, params);
    const segs = tracker.update(pair(.12), aspect, depth, 1 / 60, params);
    painter.update(rect(20, 10, 0, 20, 4, 6, .3), segs, aspect, depth, params, out);
    painter.update(rect(20, 10, 0, 20, 4, 6, .3 + .1), segs, aspect, depth, params, out);
    const nearLeft = out.strokes.filter(s => s.ax1 / aspect < .4), nearRight = out.strokes.filter(s => s.ax1 / aspect > .6);
    expect(nearLeft.length).toBeGreaterThan(0); expect(nearRight.length).toBeGreaterThan(0);
    expect(nearLeft[0].amplitude).toBeGreaterThan(nearRight[0].amplitude);
    expect(nearLeft[0].vx).toBeCloseTo(aspect, 9); expect(nearLeft[0].speed).toBe(segs[0].speed); expect(nearRight[0].vx).toBe(0);
    expect([nearLeft[0].r, nearLeft[0].g, nearLeft[0].b]).not.toEqual([nearRight[0].r, nearRight[0].g, nearRight[0].b]);
    expect([nearLeft[0].r, nearLeft[0].g, nearLeft[0].b]).toEqual(depthTint(...strokeColor(params.hue, params.saturation, segs[0].vx, segs[0].vy, HUE_OFFSETS[0]), Math.fround(.4), params.depthFade));
    expect([nearRight[0].r, nearRight[0].g, nearRight[0].b]).toEqual(depthTint(...strokeColor(params.hue, params.saturation, 0, 0, HUE_OFFSETS[1]), Math.fround(.4), params.depthFade));
  });
  it('grows the dots with the hand\'s travel in the step so stamps join, spreading the same light over the larger dot', () => {
    expect(scanDotSize(.03, .01)).toEqual({ radius: .03, gain: 1 });
    expect(scanDotSize(.03, -1)).toEqual({ radius: .03, gain: 1 });
    const grown = scanDotSize(.03, .1);
    expect(grown.radius).toBeCloseTo(.1 * SCAN_SWEEP, 12); expect(grown.gain).toBeCloseTo((.03 / grown.radius) ** 2, 12);
    const painter = new SurfacePainter(), out = createScanStrokes(), tracker = new StrokeTracker();
    const cell = Math.max(aspect / 12, 1 / 8), brush = scanBrush(cell, params.brushSize);
    tracker.update([hand(1, .1, .5)], aspect, depth, 1 / 60, params);
    const segs = tracker.update([hand(1, .1 + 5 * cell / aspect, .5)], aspect, depth, 1 / 60, params);
    expect(segs[0].length).toBeCloseTo(5 * cell, 9);
    painter.update(rect(12, 8, 3, 7, 2, 5, .4), segs, aspect, depth, params, out);
    painter.update(rect(12, 8, 4, 8, 2, 5, .4), segs, aspect, depth, params, out);
    expect(out.strokes).toHaveLength(3);
    for (const s of out.strokes) {
      expect(s.radius).toBeCloseTo(5 * cell * SCAN_SWEEP, 9);
      expect(s.amplitude).toBeCloseTo(scanAmplitude(params.brightness, 1, segs[0].speed) * (brush / s.radius) ** 2, 9);
    }
    for (const e of out.edges) expect(e.radius).toBeCloseTo(brush, 9);
  });
  it("prefers the scan over the skeleton whenever a scan exists, and flattens the hands' sweeps otherwise", () => {
    const tracker = new StrokeTracker();
    const segs = tracker.update([hand(1, .5, .5, { capsules: syntheticHandCapsules({ x: .5, y: .5, z: .3 }, 1, .06) }), hand(2, .2, .2)], aspect, depth, 1 / 60, params);
    const scan = createScanStrokes();
    expect(paintingStrokes(scan, segs)).toHaveLength(0);
    scan.strokes.push(segs[1].strokes[0]);
    expect(paintingStrokes(scan, segs)).toEqual([segs[1].strokes[0]]);
    expect(paintingStrokes(null, segs)).toHaveLength(19 + 1);
    const reused: CapsuleStroke[] = [segs[1].strokes[0]];
    expect(paintingStrokes(null, [], reused)).toBe(reused); expect(reused).toHaveLength(0);
  });
  it('bounds the silhouette on the glass and sheds sparkles from its edge', () => {
    const field = rect(12, 8, 3, 7, 2, 5, .4);
    const b = scanBounds(field, aspect)!;
    expect(b.x).toBeCloseTo(5 / 12 * aspect, 9); expect(b.y).toBeCloseTo(3.5 / 8, 9);
    expect(b.r).toBeGreaterThan(Math.hypot(2 / 12 * aspect, 1.5 / 8));
    expect(scanBounds(rect(12, 8, 0, 0, 0, 0, .4), aspect)).toBeNull();
    const painter = new SurfacePainter(), out = createScanStrokes();
    painter.update(field, [], aspect, depth, params, out); painter.update(field, [], aspect, depth, params, out);
    const sparks = new SparkleField(200, 6);
    sparks.emitFrom(out.edges, 50, [1, 1, 1]);
    expect(sparks.count).toBe(50);
    for (let i = 0; i < sparks.count; i++) {
      const near = out.edges.some(e => Math.hypot(sparks.x[i] - e.ax1, sparks.y[i] - e.ay1) <= e.radius);
      expect(near, `sparkle ${i} born at an edge cell`).toBe(true);
      expect(Math.abs(sparks.z[i] - .4 * depth)).toBeLessThan(out.edges[0].radius);
    }
  });
});
