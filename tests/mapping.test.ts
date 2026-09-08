import { describe, expect, it } from 'vitest';
import { advanceGesture, candidateRecipe, disarmed, initialMapping, mapRecipe } from '../src/music/mapping';
import { Conditioner, calibrate, calibratedOpenness, handTilt, stableCapture } from '../src/control/conditioning';
import type { ControlFrame } from '../src/control/types';
const frame = (at: number, u: number, valid = true): ControlFrame => ({ sequence: at, observedAtMs: at, receivedAtMs: at, valid, values: { openness: u }, source: 'camera' });
describe('recipe mapping', () => {
  it('uses the desired-state hysteresis band and permits direct jumps', () => {
    expect(candidateRecipe(.7, 'open')).toBe('open'); expect(candidateRecipe(.3, 'sparse')).toBe('sparse');
    expect(candidateRecipe(.9, 'sparse')).toBe('open'); expect(candidateRecipe(.1, 'open')).toBe('sparse');
    let state = initialMapping('pulse');
    for (let i = 0; i < 100; i++) state = mapRecipe(state, i % 2 ? .3 : .37, i * 30, true);
    expect(state.desired).toBe('pulse');
  });
  it('requires continuous dwell; invalid input resets the candidate', () => {
    let state = mapRecipe(initialMapping(), .9, 0, true);
    state = mapRecipe(state, .9, 119, true); expect(state.desired).toBe('sparse');
    state = mapRecipe(state, .9, 120, true); expect(state.desired).toBe('open');
    state = mapRecipe(state, .1, 130, true); state = mapRecipe(state, .1, 240, false);
    state = mapRecipe(state, .1, 300, true); expect(state.desired).toBe('open');
  });
});
describe('advance latch', () => {
  it('requires low rearm, emits once, and cannot accumulate before residence', () => {
    let state = disarmed(), count = 0;
    for (let at = 0; at <= 10000; at += 100) {
      const result = advanceGesture(state, { u: at < 600 ? .3 : 1, atMs: at, valid: true, enabled: true, eligible: at >= 2000, busy: false });
      state = result.state; if (result.advance) { count++; expect(at).toBe(3200); }
    }
    expect(count).toBe(1);
  });
  it('disarms on invalid tracking or toggle disable', () => {
    expect(advanceGesture({ ...disarmed(), armed: true }, { u: 1, atMs: 0, valid: false, enabled: true, eligible: true, busy: false }).state.armed).toBe(false);
    expect(advanceGesture({ ...disarmed(), armed: true }, { u: 1, atMs: 0, valid: true, enabled: false, eligible: true, busy: false }).state.armed).toBe(false);
  });
});
describe('control conditioning', () => {
  it('smooths with elapsed time and stabilizes camera reacquisition', () => {
    const a = new Conditioner('camera', 0, .3);
    for (let at = 0; at < 250; at += 25) { expect(a.frame(frame(at, 1)).structural).toBe(false); a.tick(at + 1); }
    expect(a.frame(frame(250, 1)).structural).toBe(true);
    expect(a.frame(frame(310, 1)).smooth).toBeGreaterThan(.7);
  });
  it('holds loss, returns toward neutral without structure, and resumes smoothly', () => {
    const a = new Conditioner('camera', 0, 1);
    for (let at = 0; at <= 300; at += 25) a.frame(frame(at, 1));
    expect(a.frame(frame(325, 1, false)).smooth).toBe(1);
    expect(a.tick(574).smooth).toBe(1); expect(a.tick(1075).smooth).toBeCloseTo(.65);
    expect(a.tick(1575).smooth).toBeCloseTo(.3);
    for (let at = 1600; at < 1850; at += 25) { expect(a.frame(frame(at, 1)).structural).toBe(false); a.tick(at + 1); }
    const ready = a.frame(frame(1850, 1)); expect(ready.structural).toBe(true); expect(ready.smooth).toBeLessThan(.6);
  });
  it('rejects stale and reordered frames and catches absence of frames', () => {
    const a = new Conditioner('camera', 0);
    a.frame(frame(10, .3));
    expect(a.frame(frame(9, 1)).discarded).toMatch(/stale/);
    expect(a.frame({ ...frame(20, 1), receivedAtMs: 221 }).discarded).toBeTruthy();
    expect(a.tick(500).structural).toBe(false);
  });
  it('seeds adapter smoothing from the existing continuous value', () => {
    const a = new Conditioner('slider', 100, .8);
    expect(a.frame({ ...frame(100, .1), source: 'slider' }).smooth).toBe(.8);
  });
});
describe('camera geometry and calibration', () => {
  it('uses pixel aspect ratio independently of preview mirroring', () => {
    const points = Array.from({ length: 21 }, () => ({ x: .5, y: .5 })); points[9] = { x: .6, y: .3 };
    expect(handTilt(points, 640, 480)).toBeCloseTo(Math.atan2(64, 96));
    expect(handTilt([], 640, 480)).toBeNull(); expect(handTilt(points, 0, 480)).toBeNull();
  });
  it('accepts reversed endpoints and unwrapped short sweeps', () => {
    const c = calibrate(Math.PI / 4, -Math.PI / 4);
    expect(calibratedOpenness(Math.PI / 4, c)).toBe(0); expect(calibratedOpenness(-Math.PI / 4, c)).toBe(1);
    const wrapped = calibrate(2.6, -2.6); expect(calibratedOpenness(-2.6, wrapped)).toBeCloseTo(1);
    expect(() => calibrate(0, .1)).toThrow(); expect(() => calibrate(0, Math.PI)).toThrow();
  });
  it('requires a stable half-second calibration hold', () => {
    expect(() => stableCapture([{ at: 0, angle: 0 }])).toThrow();
    expect(stableCapture(Array.from({ length: 7 }, (_, i) => ({ at: i * 100, angle: .4 })))).toBeCloseTo(.4);
  });
});
