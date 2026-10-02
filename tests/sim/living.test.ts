import { describe, expect, it } from 'vitest';
import { areaUniform, LIVING_SIGNALS, Mood, pictureHand, topFade } from '../../src/sim/sims/living';
import { beatPulse, MusicClockEstimator } from '../../src/sim/core/music';
import type { HandState } from '../../src/sim/input/types';

const hand = (z: number, extra: Partial<HandState> = {}): HandState => ({
  id: 1, position: { x: .4, y: .6, z }, velocity: { x: 0, y: 0, z: 0 }, speed: 0,
  extent: { min: { x: .35, y: .55, z }, max: { x: .45, y: .65, z } }, radius: .05, openness: 1, pinch: 0, palmNormal: null, palmUp: 0, confidence: 1,
  ageMs: 1000, staleMs: 0, push: z, points: [], capsules: [], ...extra,
});

describe('living: picture geometry', () => {
  it('reads contact and reach from depth around the picture plane', () => {
    expect(pictureHand(hand(.2)).contact).toBe(0);
    expect(pictureHand(hand(.2)).reach).toBe(0);
    expect(pictureHand(hand(.55)).contact).toBe(1);
    expect(pictureHand(hand(.55)).reach).toBeGreaterThan(0);
    expect(pictureHand(hand(1)).reach).toBe(1);
    expect(pictureHand(hand(.7)).reach).toBeLessThan(pictureHand(hand(.9)).reach);
  });
  it('fades the weak top band and maps the active area to y-up uv', () => {
    expect(topFade(.5)).toBe(1); expect(topFade(1)).toBe(0);
    expect(areaUniform({ x0: .1, y0: .2, x1: .9, y1: .7 })).toEqual([.1, .30000000000000004, .9, .8]);
    expect(areaUniform(undefined)).toEqual([0, 0, 1, 1]);
  });
  it('declares the five contract signals over 0..1', () => {
    expect(Object.keys(LIVING_SIGNALS)).toEqual(['presence', 'reach', 'lift', 'closeness', 'agitation']);
  });
});

describe('living: mood', () => {
  const run = (mood: Mood, seconds: number, input: { presence: number; stillness: number; agitation: number }) => { for (let t = 0; t < seconds; t += 1 / 60) mood.update(1 / 60, input); };
  it('approaches a still hand only after the patience delay', () => {
    const m = new Mood();
    run(m, 1.5, { presence: 1, stillness: 1, agitation: 0 });
    expect(m.boldness).toBeLessThan(1e-6);
    run(m, 5, { presence: 1, stillness: 1, agitation: 0 });
    expect(m.boldness).toBeGreaterThan(.8);
  });
  it('flees agitation quickly and recovers only after calm', () => {
    const m = new Mood();
    run(m, 8, { presence: 1, stillness: 1, agitation: 0 });
    run(m, .5, { presence: 1, stillness: 0, agitation: 1 });
    expect(m.fear).toBeGreaterThan(.8); expect(m.boldness).toBeLessThan(.2);
    run(m, 2, { presence: 1, stillness: 1, agitation: 0 });
    expect(m.boldness).toBeLessThan(.5);
    run(m, 20, { presence: 1, stillness: 1, agitation: 0 });
    expect(m.boldness).toBeGreaterThan(.8);
  });
  it('trusts a patient visitor faster and forgets when the box is empty', () => {
    const m = new Mood();
    run(m, 120, { presence: 1, stillness: 1, agitation: 0 });
    expect(m.familiarity).toBeGreaterThan(.5);
    run(m, 300, { presence: 0, stillness: 0, agitation: 0 });
    expect(m.familiarity).toBeLessThan(.1);
    expect(m.boldness).toBeLessThan(1e-6);
  });
  it('never goes beyond 0..1 and is deterministic', () => {
    const a = new Mood(), b = new Mood();
    for (let i = 0; i < 2000; i++) { const input = { presence: i % 300 < 200 ? 1 : 0, stillness: (i * 7 % 13) / 13, agitation: (i * 5 % 11) / 11 }; a.update(1 / 60, input); b.update(1 / 60, input); }
    for (const v of [a.fear, a.boldness, a.familiarity]) { expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThanOrEqual(1); }
    expect(a).toEqual(b);
  });
});

describe('music clock', () => {
  it('estimates tempo from reports and extrapolates between them', () => {
    const c = new MusicClockEstimator();
    for (let i = 0; i <= 20; i++) c.report(i * 104 / 600, true, i * 100);
    const s = c.sample(2050)!;
    expect(s.bpm).toBeCloseTo(104, 1);
    expect(s.beat).toBeCloseTo(20 * 104 / 600 + .05 * 104 / 60, 3);
  });
  it('ignores locate jumps, holds position when stopped, and goes stale', () => {
    const c = new MusicClockEstimator();
    for (let i = 0; i <= 10; i++) c.report(i * .2, true, i * 100); // 120 bpm
    c.report(300, true, 1100); // locate
    expect(c.sample(1100)!.bpm).toBeCloseTo(120, 3);
    c.report(300, false, 1200);
    expect(c.sample(1900)!.beat).toBe(300);
    expect(c.sample(1200 + 3001)).toBeNull();
  });
  it('pulses on the beat', () => {
    expect(beatPulse({ playing: true, beat: 4, bpm: 120 })).toBeCloseTo(1);
    expect(beatPulse({ playing: true, beat: 4.6, bpm: 120 })).toBeLessThan(.02);
    expect(beatPulse({ playing: false, beat: 4, bpm: 120 })).toBe(0);
    expect(beatPulse(null)).toBe(0);
  });
});
