import { describe, expect, it } from 'vitest';
import { areaUniform, LIVING_SIGNALS, Mood, pictureHand, topFade } from '../../src/sim/sims/living';
import { beatPulse, LevelDynamics, MUSIC_STALE_MS, MusicClockEstimator, resolveLevels } from '../../src/sim/core/music';
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
  it('carries no levels from senders without them (backwards compatible)', () => {
    const c = new MusicClockEstimator();
    c.report(1, true, 0);
    const s = c.sample(50)!;
    expect(s.levels).toBeNull();
    expect(s.dynamics).toBeNull();
  });
  it('resolves missing groups: −1 or absent falls back to main, main to the louder group', () => {
    expect(resolveLevels(undefined)).toBeNull();
    expect(resolveLevels({ main: -1, rhythm: -1, melodic: -1 })).toBeNull();
    expect(resolveLevels({ main: .7, rhythm: -1 })).toEqual({ main: .7, rhythm: .7, melodic: .7 });
    expect(resolveLevels({ rhythm: .4, melodic: .6 })).toEqual({ main: .6, rhythm: .4, melodic: .6 });
    expect(resolveLevels({ main: Number.NaN, rhythm: .5 })).toEqual({ main: .5, rhythm: .5, melodic: .5 });
  });
  it('follows levels with a fast attack and a slower release', () => {
    const d = new LevelDynamics();
    d.set({ main: 0, rhythm: 0, melodic: 0 }, 0);
    d.set({ main: .8, rhythm: .8, melodic: .8 }, 1000);
    d.advance(1040); // one attack time constant: ~63 %
    expect(d.value().envelope.main).toBeCloseTo(.8 * (1 - Math.exp(-1)), 1);
    d.advance(1300);
    expect(d.value().envelope.main).toBeGreaterThan(.79);
    d.set({ main: 0, rhythm: 0, melodic: 0 }, 1300);
    d.advance(1340); // 40 ms into the release: still mostly up
    expect(d.value().envelope.main).toBeGreaterThan(.6);
    d.advance(1550); // one release time constant
    expect(d.value().envelope.main).toBeCloseTo(.8 * Math.exp(-1), 1);
  });
  it('is the same envelope whatever the sample cadence', () => {
    const a = new LevelDynamics(), b = new LevelDynamics();
    for (let ms = 0; ms <= 3000; ms += 100) {
      const lv = { main: .5, rhythm: ms % 500 === 0 ? .9 : .4, melodic: .3 };
      a.set(lv, ms); b.set(lv, ms);
      if (ms < 3000) for (let t = ms + 16; t < ms + 100; t += 16) b.advance(t);
    }
    a.advance(3050); b.advance(3050);
    const va = a.value(), vb = b.value();
    expect(vb.envelope.rhythm).toBeCloseTo(va.envelope.rhythm, 3);
    expect(vb.onset).toBeCloseTo(va.onset, 2);
  });
  it('normalises energy: a quiet song and a loud one both reach ~1', () => {
    for (const loudness of [.25, .9]) {
      const c = new MusicClockEstimator();
      for (let ms = 0; ms <= 20000; ms += 100) c.report(ms / 500, true, ms, 120, { main: loudness, rhythm: loudness, melodic: loudness * .8 });
      const s = c.sample(20000)!;
      expect(s.levels!.main).toBe(loudness);
      expect(s.dynamics!.energy.main).toBeGreaterThan(.95);
      expect(s.dynamics!.energy.melodic).toBeGreaterThan(.95);
    }
    // Near silence stays near zero (the auto-gain has a floor).
    const q = new MusicClockEstimator();
    for (let ms = 0; ms <= 10000; ms += 100) q.report(ms / 500, true, ms, 120, { main: .01, rhythm: .01, melodic: .01 });
    expect(q.sample(10000)!.dynamics!.energy.main).toBeLessThan(.15);
  });
  it('pulses an onset on a jump of the rhythm level that decays over ~200 ms', () => {
    const c = new MusicClockEstimator();
    for (let ms = 0; ms <= 5000; ms += 100) c.report(ms / 500, true, ms, 120, { main: .5, rhythm: .4, melodic: .5 });
    expect(c.sample(5000)!.dynamics!.onset).toBeLessThan(.05);
    c.report(10.2, true, 5100, 120, { main: .7, rhythm: .9, melodic: .5 });
    const hit = c.sample(5160)!.dynamics!.onset;
    expect(hit).toBeGreaterThan(.7);
    c.report(10.4, true, 5200, 120, { main: .5, rhythm: .4, melodic: .5 });
    const later = c.sample(5600)!.dynamics!.onset;
    expect(later).toBeLessThan(hit * .25);
    // A steady loud level is energy, not onsets.
    for (let ms = 5300; ms <= 9000; ms += 100) c.report(ms / 500, true, ms, 120, { main: .9, rhythm: .9, melodic: .9 });
    expect(c.sample(9000)!.dynamics!.onset).toBeLessThan(.05);
  });
  it('drops stale levels by the clock rule while beats keep coming, and starts afresh', () => {
    const c = new MusicClockEstimator();
    for (let ms = 0; ms <= 1000; ms += 100) c.report(ms / 500, true, ms, 120, { main: .8, rhythm: .8, melodic: .8 });
    for (let ms = 1100; ms <= 1000 + MUSIC_STALE_MS + 500; ms += 100) c.report(ms / 500, true, ms, 120);
    const s = c.sample(1000 + MUSIC_STALE_MS + 500)!;
    expect(s).not.toBeNull();
    expect(s.levels).toBeNull();
    expect(s.dynamics).toBeNull();
    expect(c.sample(1000 + MUSIC_STALE_MS + 500 + MUSIC_STALE_MS + 1)).toBeNull();
    c.reset();
    c.report(0, true, 10000, 120, { main: .3 });
    expect(c.sample(10000)!.dynamics!.envelope.main).toBe(0);
  });
  it('pulses on the beat', () => {
    expect(beatPulse({ playing: true, beat: 4, bpm: 120 })).toBeCloseTo(1);
    expect(beatPulse({ playing: true, beat: 4.6, bpm: 120 })).toBeLessThan(.02);
    expect(beatPulse({ playing: false, beat: 4, bpm: 120 })).toBe(0);
    expect(beatPulse(null)).toBe(0);
  });
});
