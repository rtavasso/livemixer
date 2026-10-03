import { describe, expect, it } from 'vitest';
import { contraction, DEFAULT_LANTERN, Lantern, segmentDistance, type LanternParams } from '../../src/sim/sims/lantern/creature';
import { pictureHand } from '../../src/sim/sims/living';
import type { MusicClock } from '../../src/sim/core/music';
import type { Capsule, HandState } from '../../src/sim/input/types';

const ASPECT = 16 / 9, DT = 1 / 60;
const params: LanternParams = { ...DEFAULT_LANTERN };

function hand(x: number, y: number, z: number, extra: Partial<HandState> = {}): HandState {
  return {
    id: 1, position: { x, y, z }, velocity: { x: 0, y: 0, z: 0 }, speed: 0,
    extent: { min: { x: x - .05, y: y - .07, z }, max: { x: x + .05, y: y + .07, z } }, radius: .07, openness: 1, pinch: 0, palmNormal: null, palmUp: 0, confidence: 1,
    ageMs: 1000, staleMs: 0, push: z, points: [], capsules: [], ...extra,
  };
}

function run(l: Lantern, seconds: number, h: (t: number) => HandState | null, music?: (t: number) => MusicClock | null, onStep?: (t: number) => void) {
  const start = (l as unknown as { time: number }).time;
  for (let t = 0; t < seconds; t += DT) {
    const hs = h(start + t);
    const ph = hs ? pictureHand(hs) : null;
    l.step({ dt: DT, hands: ph ? [ph] : [], primary: ph, presence: hs ? 1 : 0, music: music?.(start + t) ?? null }, params);
    onStep?.(start + t);
  }
}

/** A scripted figure-eight performer, like the synthetic source, with absences. */
function performer(t: number): HandState | null {
  if (t % 14 > 11) return null;
  const x = .5 + .32 * Math.sin(t * .7), y = .5 + .22 * Math.sin(t * 1.4) * Math.cos(t * .3);
  const vx = .32 * .7 * Math.cos(t * .7), vy = .22 * 1.4 * Math.cos(t * 1.4) * Math.cos(t * .3);
  const z = .25 + .7 * Math.max(0, Math.sin(t * .45)) ** 6;
  return hand(x, y, z, { velocity: { x: vx, y: vy, z: 0 }, speed: Math.sqrt(vx * vx + vy * vy), capsules: [{ a: { x, y, z }, b: { x, y: y + .1, z }, radius: .01 }] });
}

const bellDistance = (l: Lantern, x: number, y: number) => { const [cx, cy] = l.centre(); return Math.sqrt((cx - x * ASPECT) ** 2 + (cy - y) ** 2); };

describe('lantern: body', () => {
  it('keeps tentacles finite and connected', () => {
    const l = new Lantern(ASPECT, 3);
    run(l, 40, performer);
    for (const c of l.chains) {
      for (let i = 0; i < c.n; i++) { expect(Number.isFinite(c.x[i])).toBe(true); expect(Number.isFinite(c.y[i])).toBe(true); }
      for (let i = 0; i < c.n - 1; i++) {
        const d = Math.sqrt((c.x[i + 1] - c.x[i]) ** 2 + (c.y[i + 1] - c.y[i]) ** 2);
        expect(d).toBeLessThan(c.rest * 1.6);
      }
      const [rx, ry] = l.local(c.rootU * l.width, c.rootV * l.height);
      expect(Math.abs(c.x[0] - rx) + Math.abs(c.y[0] - ry)).toBeLessThan(1e-9);
    }
  });

  it('keeps the bell inside the active area and below the top band', () => {
    const l = new Lantern(ASPECT, 5);
    const area = [.2, .1, .8, .9] as const;
    l.setFrame(ASPECT, area);
    let worst = 0;
    run(l, 60, performer, undefined, () => {
      const b = l.bounds();
      worst = Math.max(worst, b.x0 - l.x, l.x - b.x1, b.y0 - l.y, l.y - b.y1);
      expect(l.x).toBeGreaterThan(area[0] * ASPECT);
      expect(l.x).toBeLessThan(area[2] * ASPECT);
      expect(l.y + l.height).toBeLessThan(area[3] - .04);
    });
    expect(worst).toBeLessThanOrEqual(1e-9);
  });

  it('locks its pulse onto the music and swims on it', () => {
    const l = new Lantern(ASPECT, 9);
    const clock = (t: number): MusicClock => ({ playing: true, bpm: 120, beat: 1.3 + t * 2 });
    run(l, 12, () => null, clock);
    const t = (l as unknown as { time: number }).time;
    const musicPhase = (clock(t).beat / 2) % 1;
    const err = Math.abs(((l.phase - musicPhase + 1.5) % 1) - .5);
    expect(err).toBeLessThan(.03);
    // Each contraction jets it along its heading: speed peaks shortly after each pulse starts.
    const peaks: number[] = [];
    let prev = l.squeeze, rising = false;
    run(l, 6, () => null, clock, tt => {
      if (l.squeeze > prev) rising = true;
      else if (rising && l.squeeze < prev) { peaks.push(clock(tt).beat % 2); rising = false; }
      prev = l.squeeze;
    });
    expect(peaks.length, String(peaks)).toBeGreaterThanOrEqual(2);
    for (const p of peaks) expect(Math.abs(p - .36), String(peaks)).toBeLessThan(.12); // 18 % of a two-beat pulse
    expect(contraction(0)).toBe(0);
    expect(contraction(.18)).toBeCloseTo(1);
  });

  it('breathes on its own without music', () => {
    const l = new Lantern(ASPECT, 2);
    let max = 0, min = 1;
    run(l, 4, () => null, undefined, () => { max = Math.max(max, l.squeeze); min = Math.min(min, l.squeeze); });
    expect(max).toBeGreaterThan(.7); expect(min).toBeLessThan(.05);
  });

  it('pushes tentacles out of a capsule through the picture', () => {
    const l = new Lantern(ASPECT, 4);
    run(l, 3, () => null);
    // A finger across the hanging tentacles, through the picture plane.
    const y = l.y - .15, bx = l.x / ASPECT;
    const capsule: Capsule = { a: { x: bx - .12, y, z: .6 }, b: { x: bx + .12, y: y - .02, z: .6 }, radius: .012 };
    const finger = hand(bx, y, .6, { capsules: [capsule] });
    run(l, 2, () => finger);
    let touching = 0;
    for (const c of l.chains) for (let i = 1; i < c.n; i++) {
      const d = segmentDistance(c.x[i], c.y[i], capsule.a.x * ASPECT, capsule.a.y, capsule.b.x * ASPECT, capsule.b.y);
      expect(d).toBeGreaterThanOrEqual(capsule.radius * ASPECT - 1e-9);
      if (d < capsule.radius * ASPECT + .012) touching++;
    }
    expect(touching).toBeGreaterThan(3); // draped, not just pushed away
  });

  it('is deterministic', () => {
    const a = new Lantern(ASPECT, 11), b = new Lantern(ASPECT, 11);
    run(a, 10, performer); run(b, 10, performer);
    expect(a.x).toBe(b.x); expect(a.y).toBe(b.y);
    expect(Array.from(a.chains[3].x)).toEqual(Array.from(b.chains[3].x));
  });
});

describe('lantern: behaviour', () => {
  it('comes to a still hand and drapes over it, then flees repeated fast motion', () => {
    const l = new Lantern(ASPECT, 1);
    const still = hand(.3, .35, .6, { capsules: [{ a: { x: .3, y: .33, z: .6 }, b: { x: .3, y: .43, z: .6 }, radius: .012 }] });
    const before = bellDistance(l, .3, .35);
    run(l, 20, () => still);
    expect(l.mood.boldness).toBeGreaterThan(.6);
    expect(bellDistance(l, .3, .35)).toBeLessThan(before);
    // Its rim settles just above the fingertips.
    expect(Math.hypot(l.x - .3 * ASPECT, l.y - (.35 + .07 * 1.7 + .02))).toBeLessThan(.06);
    expect(l.closeness.value).toBeGreaterThan(.6);
    const settledGlow = l.glow.value;

    // Thrashing across the picture near it.
    run(l, 3, t => {
      const x = .3 + .15 * Math.sin(t * 9), vx = .15 * 9 * Math.cos(t * 9);
      return hand(x, .35, .6, { velocity: { x: vx, y: 0, z: 0 }, speed: Math.abs(vx) });
    });
    expect(l.mood.fear).toBeGreaterThan(.5);
    const away = hand(.3, .35, .6);
    run(l, 4, () => away);
    expect(bellDistance(l, .3, .35)).toBeGreaterThan(.45);
    expect(l.glow.value).toBeLessThan(settledGlow * .8);
  });

  it('flinches at a poke', () => {
    const l = new Lantern(ASPECT, 6);
    run(l, 2, () => null);
    const [cx, cy] = l.centre();
    const x = cx / ASPECT - .02;
    const poke = hand(x, cy, .6, { velocity: { x: 1.2, y: 0, z: 0 }, speed: 1.2 });
    const vx0 = l.vx;
    run(l, DT * 2, () => poke);
    expect(l.flinch).toBeGreaterThan(.8);
    expect(l.vx - vx0).toBeGreaterThan(.1);
  });

  it('publishes signals in range', () => {
    const l = new Lantern(ASPECT, 8);
    run(l, 30, performer, t => ({ playing: true, bpm: 100, beat: t * 100 / 60 }), () => {
      for (const v of [l.presence, l.reach, l.lift, l.closeness.value, l.agitation.value]) { expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThanOrEqual(1); }
    });
    const empty = new Lantern(ASPECT, 8);
    run(empty, 5, () => null);
    expect(empty.closeness.value).toBe(0);
  });
});

describe('lantern: hand shape', () => {
  const HX = .5, HY = .35;
  const capsules = [{ a: { x: HX, y: HY - .02, z: .6 }, b: { x: HX, y: HY + .08, z: .6 }, radius: .012 }];
  const shaped = (openness: number, palmUp: number) => hand(HX, HY, .6, {
    openness, palmUp, palmNormal: palmUp === 0 ? null : { x: 0, y: palmUp > 0 ? 1 : -1, z: 0 }, capsules,
  });
  /** Settle with the same seed and hand, then average over a few pulses. */
  function settle(openness: number, palmUp: number) {
    const l = new Lantern(ASPECT, 1);
    const h = shaped(openness, palmUp);
    run(l, 18, () => h);
    let dist = 0, height = 0, span = 0, n = 0;
    run(l, 4, () => h, undefined, () => {
      dist += bellDistance(l, HX, HY); height += l.y - HY;
      let s = 0, k = 0;
      for (const c of l.chains) if (c.kind === 'tentacle') { s += Math.hypot(c.x[c.n - 1] - c.x[0], c.y[c.n - 1] - c.y[0]); k++; }
      span += s / k; n++;
    });
    return { l, dist: dist / n, height: height / n, span: span / n };
  }

  it('keeps away from a fist with its tentacles drawn in', () => {
    const open = settle(1, 0), fist = settle(0, 0);
    expect(open.l.mood.boldness).toBeGreaterThan(.6);
    expect(fist.l.mood.fear).toBeLessThan(.1); // wary, not frightened
    expect(fist.dist - open.dist).toBeGreaterThan(.04);
    expect(fist.span).toBeLessThan(open.span * .8);
    expect(fist.l.reel).toBeLessThan(.7);
    expect(open.l.reel).toBe(1);
  });

  it('settles lower onto an open palm facing up, and glows', () => {
    const flat = settle(1, 0), up = settle(1, 1);
    expect(up.height).toBeLessThan(flat.height - .015);
    expect(up.dist).toBeLessThan(flat.dist);
    expect(up.l.glow.value).toBeGreaterThan(flat.l.glow.value);
    // A fist cancels the invitation.
    expect(settle(0, 1).l.invited).toBeLessThan(.05);
  });

  it('hovers above a palm facing down', () => {
    const flat = settle(1, 0), down = settle(1, -1);
    expect(down.height).toBeGreaterThan(flat.height + .08);
    expect(down.l.x).toBeCloseTo(flat.l.x, 1); // still above the hand, not away from it
  });

  it('eases the response in rather than popping', () => {
    const l = new Lantern(ASPECT, 1);
    run(l, 18, () => shaped(1, 0));
    const y0 = l.y;
    run(l, DT, () => shaped(0, -1));
    expect(l.wary).toBeLessThan(.1); expect(l.hover).toBeLessThan(.1);
    expect(Math.abs(l.y - y0)).toBeLessThan(.01);
  });

  it('still flees agitation whatever the hand shape', () => {
    const l = new Lantern(ASPECT, 1);
    run(l, 18, () => shaped(1, 1));
    run(l, 3, t => {
      const x = HX + .15 * Math.sin(t * 9), vx = .15 * 9 * Math.cos(t * 9);
      return hand(x, HY, .6, { velocity: { x: vx, y: 0, z: 0 }, speed: Math.abs(vx), openness: 1, palmUp: 1 });
    });
    expect(l.mood.fear).toBeGreaterThan(.5);
    run(l, 4, () => shaped(1, 1));
    expect(bellDistance(l, HX, HY)).toBeGreaterThan(.45);
  });

  it('behaves exactly as before with an open, sideways hand', () => {
    const a = new Lantern(ASPECT, 11), b = new Lantern(ASPECT, 11);
    run(a, 10, performer); run(b, 10, t => { const h = performer(t); return h && { ...h, openness: 1, palmUp: 0, palmNormal: { x: 1, y: 0, z: 0 } }; });
    expect(a.x).toBe(b.x); expect(a.y).toBe(b.y);
    expect(a.reel).toBe(1); expect(a.wary).toBe(0); expect(a.invited).toBe(0); expect(a.hover).toBe(0);
  });
});
