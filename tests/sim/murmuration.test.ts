import { describe, expect, it } from 'vitest';
import type { SimInput } from '../../src/sim/core/types';
import type { HandState } from '../../src/sim/input/types';
import { CRUISE, DEFAULT_MURMURATION, Flock, MurmurationState } from '../../src/sim/sims/murmuration/flock';
import type { Vec3 } from '../../src/sim/core/types';
import { MusicClockEstimator, type MusicClock } from '../../src/sim/core/music';

const ASPECT = 16 / 9, DT = 1 / 60;

const hand = (x: number, y: number, vx = 0, vy = 0, z = .3): HandState => ({
  id: 1, position: { x, y, z }, velocity: { x: vx, y: vy, z: 0 }, speed: Math.sqrt(vx * vx + vy * vy),
  extent: { min: { x: x - .05, y: y - .05, z }, max: { x: x + .05, y: y + .05, z } }, radius: .05,
  openness: 1, pinch: 0, palmNormal: null, palmUp: 0, confidence: 1, ageMs: 1000, staleMs: 0, push: z, points: [], capsules: [],
});

/** The same hand with a grip (0 open … 1 fist) and palm facing (1 up … −1 down). */
const shaped = (h: HandState, grip: number, palmUp: number): HandState => {
  const palmNormal: Vec3 | null = palmUp === 0 ? null : { x: 0, y: palmUp, z: Math.sqrt(Math.max(0, 1 - palmUp * palmUp)) };
  return { ...h, openness: 1 - grip, palmUp, palmNormal };
};

/** Motes within `radius` (uniform units) of the hand at uv (hx, hy): their mean distance and mean height relative to the hand. */
function haloAround(f: Flock, hx: number, hy: number, radius = .35) {
  const x0 = hx * f.aspect;
  let count = 0, dist = 0, dy = 0;
  for (let i = 0; i < f.n; i++) {
    const dx = f.px[i] - x0, ddy = f.py[i] - hy, d = Math.sqrt(dx * dx + ddy * ddy);
    if (d > radius) continue;
    count++; dist += d; dy += ddy;
  }
  return { count, meanDist: count ? dist / count : Infinity, meanDy: count ? dy / count : 0 };
}

/** Idle, then a still trusted hand with the given shape until the halo has formed. */
function gather(grip: number, palmUp: number, count = 2000) {
  const s = new MurmurationState(count, ASPECT);
  const t = run(s, 0, 3, () => null);
  const h = shaped(hand(.5, .5), grip, palmUp);
  run(s, t, 16, () => h);
  return s;
}

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

  it('a fist draws the halo into a tighter, denser, brighter ball than an open hand', () => {
    const open = gather(0, 0), fist = gather(1, 0);
    const a = haloAround(open.flock, .5, .5), b = haloAround(fist.flock, .5, .5);
    const brightNear = (f: Flock) => { let s = 0, c = 0; for (let i = 0; i < f.n; i++) { const dx = f.px[i] - .5 * f.aspect, dy = f.py[i] - .5; if (dx * dx + dy * dy < .35 * .35) { s += f.bright[i]; c++; } } return s / c; };
    console.log(`grip: open meanDist=${a.meanDist.toFixed(3)} (${a.count}) fist meanDist=${b.meanDist.toFixed(3)} (${b.count}) bright ${brightNear(open.flock).toFixed(2)} → ${brightNear(fist.flock).toFixed(2)}`);
    expect(b.meanDist).toBeLessThan(a.meanDist * .8);
    expect(brightNear(fist.flock)).toBeGreaterThan(brightNear(open.flock));
    // Still a calm halo, and the music still hears the hand.
    expect(fist.signals().agitation).toBeLessThan(.3);
    expect(fist.signals().closeness).toBeGreaterThan(.7);
    checkFlock(fist.flock);
  });

  it('palm up lifts the halo above the hand; palm down settles it below', () => {
    const flat = gather(0, 0), up = gather(0, 1), down = gather(0, -1);
    const f = haloAround(flat.flock, .5, .5, .4), u = haloAround(up.flock, .5, .5, .4), d = haloAround(down.flock, .5, .5, .4);
    console.log(`palm: flat dy=${f.meanDy.toFixed(3)} up dy=${u.meanDy.toFixed(3)} down dy=${d.meanDy.toFixed(3)}`);
    expect(Math.abs(f.meanDy)).toBeLessThan(.03);
    expect(u.meanDy).toBeGreaterThan(.05);
    expect(d.meanDy).toBeLessThan(-.05);
    checkFlock(up.flock); checkFlock(down.flock);
  });

  it('a fast hand still tears a fist-held, palm-up halo apart', () => {
    const s = gather(1, 1, 3000);
    const t0 = 19;
    let peak = 0, peakFear = 0;
    const swipe = (tt: number) => { const u = tt - t0; return shaped(hand(.5 + .3 * Math.sin(u * 6.6), .5, .3 * 6.6 * Math.cos(u * 6.6), 0), 1, 1); };
    run(s, t0, 1, swipe, () => { peak = Math.max(peak, s.signals().agitation); peakFear = Math.max(peakFear, s.mood.fear); });
    expect(peak).toBeGreaterThan(.3);
    expect(peakFear).toBeGreaterThan(.5);
  });

  it('an open hand with a sideways palm is the plain halo (grip 0, palmUp 0 change nothing)', () => {
    // Explicit zero shapes give bit-identical motion to stepping with no shapes at all.
    const a = new Flock(1500, ASPECT), b = new Flock(1500, ASPECT);
    const h = hand(.45, .55);
    const ph = { id: 1, x: .45, y: .55, vx: 0, vy: 0, speed: 0, contact: 0, reach: 0, radius: .05, grip: 0, palmUp: 0, hand: h };
    const mood = { fear: 0, boldness: .9, hold: .5, threat: 0, presence: 1, pulse: .3 };
    for (let k = 0; k < 300; k++) {
      a.step(DT, k * DT, [ph], 1, mood, DEFAULT_MURMURATION, { x0: 0, y0: 0, x1: 1, y1: 1 });
      b.step(DT, k * DT, [ph], 1, mood, DEFAULT_MURMURATION, { x0: 0, y0: 0, x1: 1, y1: 1 }, [{ grip: 0, palmUp: 0 }]);
    }
    expect(Array.from(b.px)).toEqual(Array.from(a.px));
    expect(Array.from(b.bright)).toEqual(Array.from(a.bright));
    // Through the whole simulation, a neutral hand is unaffected by the gesture tunables.
    const off = { ...DEFAULT_MURMURATION, gripTighten: 0, palmLift: 0 };
    const c = new MurmurationState(1500, ASPECT), d = new MurmurationState(1500, ASPECT);
    for (let k = 0; k < 600; k++) { const inp = input(k * DT, h); c.step(inp, off); d.step(inp, DEFAULT_MURMURATION); }
    expect(d.mood.boldness).toBeGreaterThan(.5);
    expect(Array.from(d.flock.px)).toEqual(Array.from(c.flock.px));
    expect(d.signals()).toEqual(c.signals());
  });
});

describe('murmuration and the music levels', { timeout: 60_000 }, () => {
  /** A clock at `t` s: 120 bpm, with a kick on every beat in the rhythm level when `levels`. */
  function musicAt(est: MusicClockEstimator, t: number, levels: boolean) {
    const ms = t * 1000;
    // Reports at ~10 Hz, as Live sends them.
    if (Math.floor(ms / 100) !== Math.floor((ms - DT * 1000) / 100) || t === 0) {
      const beat = t * 2, phase = beat - Math.floor(beat);
      est.report(beat, true, ms, 120, levels ? { main: .6, rhythm: phase < .15 ? .85 : .45, melodic: .5 } : undefined);
    }
    return est.sample(ms);
  }
  const withMusic = (time: number, h: HandState | null, music: MusicClock | null): SimInput => ({ ...input(time, h), music });

  /** Spread of the drawn motes about their centroid (uv units). */
  function drawnSpread(s: MurmurationState) {
    const out = new Float32Array(s.flock.n * 4);
    s.flock.pack(out, s.musicBreath, s.breathX, s.breathY);
    let mx = 0, my = 0;
    for (let i = 0; i < s.flock.n; i++) { mx += out[i * 4]; my += out[i * 4 + 1]; }
    mx /= s.flock.n; my /= s.flock.n;
    let d = 0;
    for (let i = 0; i < s.flock.n; i++) d += Math.hypot(out[i * 4] - mx, out[i * 4 + 1] - my);
    return d / s.flock.n;
  }

  it('pulses brighter and breathes in on each rhythm hit with nobody in the box', () => {
    const s = new MurmurationState(1500, ASPECT), est = new MusicClockEstimator();
    let glowMax = 0, glowMin = Infinity, breathMax = 0, spreadMin = Infinity, spreadMax = 0, onsets = 0, wasHigh = false;
    for (let k = 0; k < 600; k++) {
      const t = k * DT;
      s.step(withMusic(t, null, musicAt(est, t, true)), DEFAULT_MURMURATION);
      if (t < 2) continue;
      glowMax = Math.max(glowMax, s.musicGlow); glowMin = Math.min(glowMin, s.musicGlow);
      breathMax = Math.max(breathMax, s.musicBreath);
      const spread = drawnSpread(s);
      spreadMin = Math.min(spreadMin, spread); spreadMax = Math.max(spreadMax, spread);
      const high = s.musicGlow > .4;
      if (high && !wasHigh) onsets++;
      wasHigh = high;
    }
    // One pulse per beat (120 bpm over 8 s: ~16), dropping back between beats.
    expect(onsets).toBeGreaterThanOrEqual(12);
    expect(onsets).toBeLessThanOrEqual(20);
    expect(glowMax).toBeGreaterThan(.4);
    expect(glowMin).toBeLessThan(.25);
    expect(breathMax).toBeGreaterThan(.02);
    expect(breathMax).toBeLessThanOrEqual(.2);
    expect(spreadMax - spreadMin).toBeGreaterThan(0);
    // The melodic parts set the shimmer.
    expect(s.shimmer).toBeGreaterThan(.5);
    checkFlock(s.flock);
  });

  it('never feeds the music into the flock: positions, agitation and signals are identical', () => {
    const quiet = new MurmurationState(1500, ASPECT), loud = new MurmurationState(1500, ASPECT);
    const eq = new MusicClockEstimator(), el = new MusicClockEstimator();
    const h = hand(.5, .5);
    for (let k = 0; k < 900; k++) {
      const t = k * DT, who = t > 5 && t < 12 ? h : null;
      quiet.step(withMusic(t, who, musicAt(eq, t, false)), DEFAULT_MURMURATION);
      loud.step(withMusic(t, who, musicAt(el, t, true)), DEFAULT_MURMURATION);
    }
    expect(loud.musicGlow).toBeGreaterThan(0);
    expect(quiet.musicGlow).toBe(0);
    expect(Array.from(loud.flock.px)).toEqual(Array.from(quiet.flock.px));
    expect(loud.flock.stats.agitation).toBe(quiet.flock.stats.agitation);
    expect(loud.signals()).toEqual(quiet.signals());
    expect(loud.mood.fear).toBe(quiet.mood.fear);
    expect(loud.mood.boldness).toBe(quiet.mood.boldness);
  });

  it('with no music, or the music tunables at zero, draws exactly as before', () => {
    const s = new MurmurationState(1000, ASPECT);
    run(s, 0, 2, () => null);
    expect(s.musicGlow).toBe(0); expect(s.musicBreath).toBe(0); expect(s.shimmer).toBe(0);
    const a = new Float32Array(s.flock.n * 4), b = new Float32Array(s.flock.n * 4);
    s.flock.pack(a); s.flock.pack(b, s.musicBreath, s.breathX, s.breathY);
    expect(Array.from(b)).toEqual(Array.from(a));
    const off = { ...DEFAULT_MURMURATION, musicPulse: 0, musicShimmer: 0 }, est = new MusicClockEstimator();
    const z = new MurmurationState(1000, ASPECT);
    for (let k = 0; k < 300; k++) z.step(withMusic(k * DT, null, musicAt(est, k * DT, true)), off);
    expect(z.musicGlow).toBe(0); expect(z.musicBreath).toBe(0); expect(z.shimmer).toBe(0);
  });

  it('breathes a trusted halo around the hand', () => {
    const s = gather(0, 0, 1500), est = new MusicClockEstimator();
    const h = hand(.5, .5);
    for (let k = 0; k < 120; k++) { const t = 19 + k * DT; s.step(withMusic(t, h, musicAt(est, t, true)), DEFAULT_MURMURATION); }
    expect(s.breathX).toBeCloseTo(.5 * ASPECT, 1);
    expect(s.breathY).toBeCloseTo(.5, 1);
  });
});
