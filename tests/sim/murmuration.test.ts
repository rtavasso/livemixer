import { describe, expect, it } from 'vitest';
import type { SimInput } from '../../src/sim/core/types';
import type { HandState } from '../../src/sim/input/types';
import { CRUISE, DEFAULT_MURMURATION, Flock, MurmurationState } from '../../src/sim/sims/murmuration/flock';

const ASPECT = 16 / 9, DT = 1 / 60;

const hand = (x: number, y: number, vx = 0, vy = 0, z = .3): HandState => ({
  id: 1, position: { x, y, z }, velocity: { x: vx, y: vy, z: 0 }, speed: Math.sqrt(vx * vx + vy * vy),
  extent: { min: { x: x - .05, y: y - .05, z }, max: { x: x + .05, y: y + .05, z } }, radius: .05,
  openness: 1, pinch: 0, confidence: 1, ageMs: 1000, staleMs: 0, push: z, points: [], capsules: [],
});

function input(time: number, h: HandState | null): SimInput {
  return { time, dt: DT, hands: h ? [h] : [], primary: h, events: [], presence: h ? 1 : 0, activity: 0, occupancy: null, volume: null, surface: null, music: null };
}

/** Run `seconds` with `handAt(t)` (null = nobody), recording signals. */
function run(s: MurmurationState, from: number, seconds: number, handAt: (t: number) => HandState | null, record?: (t: number) => void) {
  const steps = Math.round(seconds / DT);
  for (let k = 0; k < steps; k++) { const t = from + k * DT; s.step(input(t, handAt(t)), DEFAULT_MURMURATION); record?.(t); }
  return from + steps * DT;
}

function checkFlock(f: Flock) {
  for (let i = 0; i < f.n; i++) {
    for (const v of [f.px[i], f.py[i], f.pz[i], f.vx[i], f.vy[i], f.bright[i]]) expect(Number.isFinite(v)).toBe(true);
    expect(f.px[i]).toBeGreaterThanOrEqual(-.051); expect(f.px[i]).toBeLessThanOrEqual(ASPECT + .051);
    expect(f.py[i]).toBeGreaterThanOrEqual(-.051); expect(f.py[i]).toBeLessThanOrEqual(1.051);
  }
}

// Long simulated runs (tens of seconds of flock at 60 Hz).
describe('murmuration flock', { timeout: 60_000 }, () => {
  it('stays finite, inside the picture and moving over a long idle run, with signals in range', () => {
    const s = new MurmurationState(3000, ASPECT);
    let t = 0, minSpeed = Infinity;
    const inRange = () => { for (const v of Object.values(s.signals())) { expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThanOrEqual(1); } };
    t = run(s, t, 40, () => null, () => { minSpeed = Math.min(minSpeed, s.flock.stats.meanSpeed); inRange(); });
    checkFlock(s.flock);
    expect(minSpeed).toBeGreaterThan(CRUISE * .5);
    // Most of the flock is inside the active area.
    let inside = 0;
    for (let i = 0; i < s.flock.n; i++) if (s.flock.px[i] > 0 && s.flock.px[i] < ASPECT && s.flock.py[i] > 0 && s.flock.py[i] < 1) inside++;
    expect(inside / s.flock.n).toBeGreaterThan(.97);
    const sig = s.signals();
    expect(sig.closeness).toBe(0);
    expect(sig.agitation).toBeLessThan(.35);
    console.log(`idle: dis=${s.flock.stats.disorder.toFixed(2)} ex=${s.flock.stats.excess.toFixed(2)} agitation=${sig.agitation.toFixed(3)} meanSpeed=${s.flock.stats.meanSpeed.toFixed(3)}`);
  });

  it('wraps a halo around a still, trusted hand: closeness rises', () => {
    const s = new MurmurationState(3000, ASPECT);
    let t = run(s, 0, 5, () => null);
    const still = hand(.5, .5);
    let at4 = 0;
    t = run(s, t, 20, () => still, tt => { if (Math.abs(tt - 9) < DT / 2) at4 = s.signals().closeness; });
    const sig = s.signals();
    console.log(`halo: boldness=${s.mood.boldness.toFixed(2)} hold=${s.hold.toFixed(2)} closeShare=${s.flock.stats.closeShare.toFixed(3)} closeness=${sig.closeness.toFixed(2)} (at 4 s ${at4.toFixed(2)}) agitation=${sig.agitation.toFixed(2)} dis=${s.flock.stats.disorder.toFixed(2)} ex=${s.flock.stats.excess.toFixed(2)} speed=${s.flock.stats.meanSpeed.toFixed(2)}`);
    expect(s.mood.boldness).toBeGreaterThan(.8);
    expect(sig.closeness).toBeGreaterThan(.7);
    expect(sig.closeness).toBeGreaterThan(at4);
    expect(sig.reach).toBe(0);
    expect(sig.lift).toBeCloseTo(.5, 5);
    checkFlock(s.flock);
    // Hand gone: closeness falls to 0.
    run(s, t, 6, () => null);
    expect(s.signals().closeness).toBeLessThan(.05);
  });

  it('scatters on a fast pass, then calms: no runaway self-excitation', () => {
    const s = new MurmurationState(3000, ASPECT);
    let t = run(s, 0, 3, () => null);
    const still = hand(.5, .5);
    t = run(s, t, 14, () => still);
    const before = s.signals();
    // A fast swipe through the halo and back: 2 uv/s.
    let peak = 0, peakFear = 0;
    const t0 = t;
    const swipe = (tt: number) => { const u = tt - t0, x = .5 + .3 * Math.sin(u * 6.6); return hand(x, .5, .3 * 6.6 * Math.cos(u * 6.6), 0); };
    t = run(s, t, 1, swipe, () => { peak = Math.max(peak, s.signals().agitation); peakFear = Math.max(peakFear, s.mood.fear); });
    const after = hand(.5, .5);
    // Hand held still again: agitation must decay and fear relax.
    t = run(s, t, 8, () => after);
    const end = s.signals();
    console.log(`scatter: agitation before=${before.agitation.toFixed(2)} peak=${peak.toFixed(2)} end=${end.agitation.toFixed(2)} fearPeak=${peakFear.toFixed(2)} fearEnd=${s.mood.fear.toFixed(2)} closeness before=${before.closeness.toFixed(2)}`);
    expect(peak).toBeGreaterThan(before.agitation + .3);
    expect(peakFear).toBeGreaterThan(.5);
    expect(end.agitation).toBeLessThan(.3);
    expect(s.mood.fear).toBeLessThan(peakFear * .6);
    // It comes back to the hand eventually.
    run(s, t, 20, () => after);
    expect(s.signals().closeness).toBeGreaterThan(.5);
    checkFlock(s.flock);
  });

  it('holds reach when the hand pushes through and decays it after', () => {
    const s = new MurmurationState(2000, ASPECT);
    let t = run(s, 0, 2, () => hand(.3, .7, 0, 0, .9));
    expect(s.signals().reach).toBeGreaterThan(.6);
    expect(s.signals().lift).toBeCloseTo(.7, 5);
    t = run(s, t, 8, () => null);
    expect(s.signals().reach).toBeLessThan(.2);
    expect(s.signals().lift).toBeCloseTo(.7, 5);
  });

  it('is deterministic', () => {
    const a = new MurmurationState(1500, ASPECT), b = new MurmurationState(1500, ASPECT);
    const h = (t: number) => (t > 2 ? hand(.4 + .1 * Math.sin(t), .5, .1 * Math.cos(t), 0) : null);
    run(a, 0, 5, h); run(b, 0, 5, h);
    expect(Array.from(a.flock.px)).toEqual(Array.from(b.flock.px));
    expect(a.signals()).toEqual(b.signals());
  });

  it('steps 3000 motes within the budget', () => {
    const s = new MurmurationState(3000, ASPECT);
    let t = run(s, 0, 2, () => null);
    const timeIt = (label: string, h: HandState | null) => {
      const N = 240, t0 = performance.now();
      t = run(s, t, N * DT, () => h);
      const ms = (performance.now() - t0) / N;
      console.log(`step ${label}: ${ms.toFixed(3)} ms / step (3000 motes)`);
      return ms;
    };
    timeIt('idle', null);
    const ms = timeIt('hand', hand(.5, .5));
    expect(ms).toBeLessThan(8); // generous for CI; the real target (~1–2 ms) is logged above
  });
});
