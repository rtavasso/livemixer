import { describe, expect, it } from 'vitest';
import { School, SEGMENTS, closeRadius, coilRadius, ringRadius, type SchoolBounds, type SchoolHand } from '../../src/sim/sims/tide/school';
import { Forces, HandGestures, HandWater, MAX_FORCES, TideSignals, agitationFrom, fingertips, handBloom, substeps, waveGrid } from '../../src/sim/sims/tide/model';
import { Mood, pictureHand } from '../../src/sim/sims/living';
import { syntheticHandCapsules } from '../../src/sim/input/synthetic';
import type { HandState } from '../../src/sim/input/types';

const ASPECT = 16 / 9;
const BOUNDS: SchoolBounds = { x0: .05 * ASPECT, y0: .05, x1: .95 * ASPECT, y1: .9 };
const HAND: SchoolHand = { x: .5 * ASPECT, y: .5, radius: .06 * ASPECT };
const DT = 1 / 60;

function run(school: School, seconds: number, drive: { boldness: number; fear: number; hand: SchoolHand | null; grip?: number }) {
  for (let t = 0; t < seconds; t += DT) school.update({ dt: DT, bounds: BOUNDS, ...drive });
}
function meanDistance(school: School, x: number, y: number) {
  let s = 0;
  for (let i = 0; i < school.count; i++) { const dx = school.x[i * SEGMENTS] - x, dy = school.y[i * SEGMENTS] - y; s += Math.sqrt(dx * dx + dy * dy); }
  return s / school.count;
}

const handState = (x: number, y: number, z: number, extra: Partial<HandState> = {}): HandState => ({
  id: 1, position: { x, y, z }, velocity: { x: 0, y: 0, z: 0 }, speed: 0,
  extent: { min: { x: x - .05, y: y - .05, z }, max: { x: x + .05, y: y + .05, z } }, radius: .05, openness: 1, pinch: 0, palmNormal: null, palmUp: 0, confidence: 1,
  ageMs: 1000, staleMs: 0, push: z, points: [], capsules: [], ...extra,
});

describe('tide: school', () => {
  it('is deterministic from its seed', () => {
    const a = new School(48, BOUNDS, 3), b = new School(48, BOUNDS, 3);
    run(a, 3, { boldness: .5, fear: 0, hand: HAND }); run(b, 3, { boldness: .5, fear: 0, hand: HAND });
    expect(Array.from(a.x)).toEqual(Array.from(b.x));
    expect(Array.from(a.y)).toEqual(Array.from(b.y));
  });

  it('comes to circle a still hand when bold, on a ring rather than a point', () => {
    const s = new School(48, BOUNDS, 5);
    const before = s.fractionWithin(HAND.x, HAND.y, closeRadius(HAND.radius));
    run(s, 12, { boldness: 1, fear: 0, hand: HAND });
    const after = s.fractionWithin(HAND.x, HAND.y, closeRadius(HAND.radius));
    expect(after).toBeGreaterThan(.6);
    expect(after).toBeGreaterThan(before);
    // Few sit on the hand itself: they brush around it.
    expect(s.fractionWithin(HAND.x, HAND.y, ringRadius(HAND.radius) * .4)).toBeLessThan(.15);
  });

  it('ignores the hand when not bold', () => {
    const s = new School(48, BOUNDS, 5);
    run(s, 12, { boldness: 0, fear: 0, hand: HAND });
    expect(s.fractionWithin(HAND.x, HAND.y, closeRadius(HAND.radius))).toBeLessThan(.35);
  });

  it('flees to the edges when afraid, and dims there', () => {
    const s = new School(48, BOUNDS, 9);
    run(s, 10, { boldness: 1, fear: 0, hand: HAND });
    const near = meanDistance(s, HAND.x, HAND.y);
    run(s, 4, { boldness: 0, fear: 1, hand: HAND });
    expect(meanDistance(s, HAND.x, HAND.y)).toBeGreaterThan(near + .25);
    expect(s.fractionWithin(HAND.x, HAND.y, closeRadius(HAND.radius))).toBeLessThan(.05);
    let dim = 0; for (let i = 0; i < s.count; i++) dim += s.dim[i];
    expect(dim / s.count).toBeGreaterThan(.5);
  });

  it('stays inside its bounds whatever the mood', () => {
    const s = new School(80, BOUNDS, 11);
    const moods = [{ boldness: 0, fear: 0 }, { boldness: 1, fear: 0 }, { boldness: 0, fear: 1 }];
    for (let k = 0; k < 6; k++) {
      const m = moods[k % 3];
      run(s, 5, { ...m, hand: k % 2 ? { ...HAND, x: .1 * ASPECT, y: .15 } : HAND });
      for (let i = 0; i < s.x.length; i++) {
        expect(s.x[i]).toBeGreaterThan(BOUNDS.x0 - .12); expect(s.x[i]).toBeLessThan(BOUNDS.x1 + .12);
        expect(s.y[i]).toBeGreaterThan(BOUNDS.y0 - .12); expect(s.y[i]).toBeLessThan(BOUNDS.y1 + .12);
      }
      for (let i = 0; i < s.count; i++) {
        expect(s.x[i * SEGMENTS]).toBeGreaterThanOrEqual(BOUNDS.x0); expect(s.x[i * SEGMENTS]).toBeLessThanOrEqual(BOUNDS.x1);
        expect(s.y[i * SEGMENTS]).toBeGreaterThanOrEqual(BOUNDS.y0); expect(s.y[i * SEGMENTS]).toBeLessThanOrEqual(BOUNDS.y1);
      }
    }
  });

  it('with the mood: a still hand draws them in, a splash scatters them, calm brings them back', () => {
    const s = new School(48, BOUNDS, 13), mood = new Mood();
    const step = (seconds: number, agitation: number) => {
      for (let t = 0; t < seconds; t += DT) {
        mood.update(DT, { presence: 1, stillness: agitation > 0 ? 0 : 1, agitation });
        s.update({ dt: DT, bounds: BOUNDS, boldness: mood.boldness, fear: mood.fear, hand: HAND });
      }
    };
    const radius = closeRadius(HAND.radius);
    step(12, 0);
    expect(s.fractionWithin(HAND.x, HAND.y, radius)).toBeGreaterThan(.5);
    step(.5, 1); step(3, 0);
    expect(s.fractionWithin(HAND.x, HAND.y, radius)).toBeLessThan(.2);
    step(25, 0);
    expect(s.fractionWithin(HAND.x, HAND.y, radius)).toBeGreaterThan(.5);
  });

  it('handles an empty school', () => {
    const s = new School(0, BOUNDS);
    run(s, 1, { boldness: 1, fear: 1, hand: HAND });
    expect(s.fractionWithin(0, 0, 1)).toBe(0);
  });
});

describe('tide: water and signals', () => {
  it('sizes the wave grid with square cells and a stable number of substeps', () => {
    const g = waveGrid('medium', ASPECT);
    expect(g.width / g.height).toBeCloseTo(ASPECT, 1);
    expect(.6 * DT * g.height / substeps(.6, DT, g.height)).toBeLessThanOrEqual(.5);
  });

  it('only disturbs the water for hands through the plane, and caps the disturbances', () => {
    const water = new HandWater(), forces = new Forces();
    forces.begin(); water.update([pictureHand(handState(.5, .5, .25))], DT, 0, ASPECT, 1, forces);
    expect(forces.count).toBe(0);
    const touching = pictureHand(handState(.5, .5, .8, { capsules: syntheticHandCapsules({ x: .5, y: .5, z: .8 }, 1, .05), speed: .4 }));
    const other = pictureHand(handState(.3, .4, .9, { id: 2, capsules: syntheticHandCapsules({ x: .3, y: .4, z: .9 }, 1, .05, true) }));
    forces.begin(); water.update([touching, other], DT, 1.3, ASPECT, 1, forces);
    expect(forces.count).toBeGreaterThan(2);
    expect(forces.count).toBeLessThanOrEqual(MAX_FORCES);
    for (let i = 0; i < forces.count * 4; i++) expect(Number.isFinite(forces.data[i])).toBe(true);
  });

  it('finds the fingertips of a skeleton and not the forearm', () => {
    const palm = { x: .5, y: .5, z: .8 };
    const tips = fingertips(pictureHand(handState(palm.x, palm.y, palm.z, { capsules: syntheticHandCapsules(palm, 1, .05) })), 5);
    expect(tips.length).toBe(5);
    // The synthetic hand's fingers point toward smaller y (its source frame is y-down); the forearm goes the other way.
    for (const t of tips) expect(t.y).toBeLessThan(palm.y + .03);
  });

  it('keeps every signal in 0..1 and reads agitation from motion in the water', () => {
    const sig = new TideSignals(), water = new HandWater(), forces = new Forces();
    let maxAgitation = 0;
    for (let k = 0; k < 600; k++) {
      const t = k * DT;
      const z = k < 200 ? .2 : k < 400 ? .9 : .9;
      const speed = k < 400 ? .1 : 2;
      const hand = k > 500 ? null : pictureHand(handState(.5 + .3 * Math.sin(t), .5, z, { speed }));
      forces.begin(); water.update(hand ? [hand] : [], DT, t, ASPECT, 1, forces);
      const agitation = agitationFrom(water.stir);
      if (k < 200) expect(agitation).toBe(0);
      sig.update(DT, hand ? 1 : 0, hand, agitation, hand ? .5 : 0);
      const v = sig.values();
      for (const value of Object.values(v)) { expect(value).toBeGreaterThanOrEqual(0); expect(value).toBeLessThanOrEqual(1); }
      if (k === 399) expect(v.reach).toBeGreaterThan(.5);
      maxAgitation = Math.max(maxAgitation, v.agitation);
    }
    expect(maxAgitation).toBeGreaterThan(.8);
    const end = sig.values();
    expect(end.closeness).toBeLessThan(.5);
    expect(end.reach).toBeLessThan(.95);
  });
});

describe('tide: gestures', () => {
  const UP = { x: 0, y: 1, z: 0 }, DOWN = { x: 0, y: -1, z: 0 };
  /** Feed one pose for `seconds` and return the smoothed gesture. */
  const settle = (g: HandGestures, extra: Partial<HandState>, seconds: number) => {
    const hand = pictureHand(handState(.5, .5, .8, extra));
    for (let t = 0; t < seconds; t += DT) g.update([hand], DT);
    return g.get(hand.id);
  };

  it('smooths grip and palm facing instead of popping, and reads open/sideways as nothing', () => {
    const g = new HandGestures();
    expect(settle(g, {}, 1)).toEqual({ grip: 0, offer: 0, calm: 0 });
    const first = settle(g, { openness: 0, palmNormal: UP, palmUp: 1 }, DT);
    expect(first.grip).toBeGreaterThan(0); expect(first.grip).toBeLessThan(.15);
    expect(first.offer).toBeGreaterThan(0); expect(first.offer).toBeLessThan(.15);
    const held = settle(g, { openness: 0, palmNormal: UP, palmUp: 1 }, 2);
    expect(held.grip).toBeGreaterThan(.95); expect(held.offer).toBeGreaterThan(.95); expect(held.calm).toBe(0);
    // A one-frame flicker to palm down barely moves it.
    const flick = settle(g, { openness: 0, palmNormal: DOWN, palmUp: -1 }, DT);
    expect(flick.offer).toBeGreaterThan(.85); expect(flick.calm).toBe(0);
    const down = settle(g, { openness: 1, palmNormal: DOWN, palmUp: -1 }, 3);
    expect(down.calm).toBeGreaterThan(.95); expect(down.offer).toBe(0); expect(down.grip).toBeLessThan(.05);
  });

  it('a fist coils a willing school tighter and closer than an open hand', () => {
    expect(coilRadius(HAND.radius, 0)).toBe(ringRadius(HAND.radius));
    expect(coilRadius(HAND.radius, 1)).toBeLessThan(ringRadius(HAND.radius) * .7);
    const open = new School(48, BOUNDS, 5), fist = new School(48, BOUNDS, 5);
    run(open, 12, { boldness: 1, fear: 0, hand: HAND, grip: 0 });
    run(fist, 12, { boldness: 1, fear: 0, hand: HAND, grip: 1 });
    expect(meanDistance(fist, HAND.x, HAND.y)).toBeLessThan(meanDistance(open, HAND.x, HAND.y) * .8);
    const tight = ringRadius(HAND.radius);
    expect(fist.fractionWithin(HAND.x, HAND.y, tight)).toBeGreaterThan(open.fractionWithin(HAND.x, HAND.y, tight) + .2);
    expect(fist.fractionWithin(HAND.x, HAND.y, closeRadius(HAND.radius))).toBeGreaterThan(.6);
  });

  it('a fist does not hold a frightened school', () => {
    const s = new School(48, BOUNDS, 9);
    run(s, 10, { boldness: 1, fear: 0, hand: HAND, grip: 1 });
    run(s, 4, { boldness: 0, fear: 1, hand: HAND, grip: 1 });
    expect(s.fractionWithin(HAND.x, HAND.y, closeRadius(HAND.radius))).toBeLessThan(.05);
  });

  it('grip 0 leaves the school exactly as before', () => {
    const a = new School(48, BOUNDS, 3), b = new School(48, BOUNDS, 3);
    run(a, 3, { boldness: .7, fear: .1, hand: HAND }); run(b, 3, { boldness: .7, fear: .1, hand: HAND, grip: 0 });
    expect(Array.from(b.x)).toEqual(Array.from(a.x));
    expect(Array.from(b.y)).toEqual(Array.from(a.y));
  });

  it('palm up wells the glow up around the hand, palm down damps it', () => {
    const r = .06 * ASPECT, base = { grip: 0, offer: 0, calm: 0 };
    for (const d of [0, .5 * r, r]) {
      const flat = handBloom(d, r, .3, 1, base);
      expect(handBloom(d, r, .3, 1)).toBe(flat);
      expect(handBloom(d, r, .3, 1, { ...base, offer: 1 })).toBeGreaterThan(flat * 1.8);
      expect(handBloom(d, r, .3, 1, { ...base, offer: .5 })).toBeGreaterThan(flat);
      expect(handBloom(d, r, .3, 1, { ...base, calm: 1 })).toBeLessThan(flat * .5);
    }
    // No touch, no light, whatever the palm.
    expect(handBloom(0, r, .3, 0, { ...base, offer: 1 })).toBe(0);
  });

  it('palm down calms the disturbance of the water; sideways changes nothing', () => {
    const impulses = (extra: Partial<HandState>, withGestures: boolean) => {
      const water = new HandWater(), forces = new Forces(), g = new HandGestures();
      const hand = pictureHand(handState(.5, .5, .8, { capsules: syntheticHandCapsules({ x: .5, y: .5, z: .8 }, 1, .05), speed: .4, ...extra }));
      let sum = 0;
      for (let k = 0; k < 120; k++) {
        g.update([hand], DT);
        forces.begin(); water.update([hand], DT, k * DT, ASPECT, 1, forces, withGestures ? g : undefined);
        for (let i = 0; i < forces.count; i++) sum += Math.abs(forces.data[i * 4 + 3]);
      }
      return { sum, stir: water.stir };
    };
    const before = impulses({}, false), neutral = impulses({}, true);
    expect(neutral.sum).toBe(before.sum);
    const down = impulses({ palmNormal: { x: 0, y: -1, z: 0 }, palmUp: -1 }, true);
    expect(down.sum).toBeLessThan(before.sum * .5);
    // Agitation (a published signal) still reads the hand's real motion.
    expect(down.stir).toBe(before.stir);
  });
});
