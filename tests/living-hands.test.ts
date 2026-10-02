import { describe, it, expect } from 'vitest';
import { HandCombiner, DEFAULT_HANDS } from '../src/living/hands';
import { GESTURE_HOME, GESTURE_KEYS, type GestureFx } from '../src/living/governor';
import type { HandTelemetry } from '../src/sim/telemetry/types';

const DT = 1 / 30;
type Pose = Partial<HandTelemetry> & { id: number };
const hand = (pose: Pose): HandTelemetry => ({
  x: .5, y: .5, z: .5, vx: 0, vy: 0, vz: 0, speed: 0, radius: .05, openness: 1, pinch: 0, push: 0, palmUp: 0, ageMs: 0, staleMs: 0, solid: 0, ...pose,
});
function run(c: HandCombiner, poses: Pose[] | ((t: number) => Pose[]), seconds: number, each?: (fx: GestureFx, t: number) => void): GestureFx {
  let fx = c.value;
  for (let t = 0; t < seconds - 1e-9; t += DT) {
    fx = c.step((typeof poses === 'function' ? poses(t) : poses).map(hand), DT);
    each?.(fx, t);
  }
  return fx;
}
const inRange = (fx: GestureFx) => GESTURE_KEYS.every(k => Number.isFinite(fx[k]) && fx[k] >= 0 && fx[k] <= 1);

describe('hand combiner', () => {
  it('stays home with no hands, and for empty or garbage input', () => {
    const c = new HandCombiner();
    expect(run(c, [], 2)).toEqual(GESTURE_HOME);
    expect(c.step(null, DT)).toEqual(GESTURE_HOME);
    expect(c.step([{ id: NaN } as HandTelemetry, { id: 1, x: NaN, y: .5 } as HandTelemetry], DT)).toEqual(GESTURE_HOME);
  });

  it('one hand conducts the whole song: muffle and tilt both halves', () => {
    const c = new HandCombiner();
    const fx = run(c, [{ id: 1, openness: .2, palmUp: 1 }], 2);
    expect(fx.muffleRhythm).toBeCloseTo(.8, 3);
    expect(fx.muffleMelodic).toBeCloseTo(.8, 3);
    expect(fx.tiltRhythm).toBeCloseTo(1, 3);
    expect(fx.tiltMelodic).toBeCloseTo(1, 3);
    expect(fx.span).toBe(.5);
    const down = run(c, [{ id: 1, openness: 1, palmUp: -1 }], 3);
    expect(down.tiltRhythm).toBeCloseTo(0, 3);
    expect(down.muffleRhythm).toBe(0);
  });

  it('one hand spotlights by height with a dead zone around the middle', () => {
    const high = run(new HandCombiner(), [{ id: 1, y: 1 }], 2);
    expect(high.levelMelodic).toBeCloseTo(1, 3);
    expect(high.levelRhythm).toBeCloseTo(0, 3);
    const low = run(new HandCombiner(), [{ id: 1, y: .1 }], 2);
    expect(low.levelRhythm).toBeGreaterThan(.8);
    expect(low.levelMelodic).toBeLessThan(.2);
    for (const y of [.43, .5, .57]) {
      const mid = run(new HandCombiner(), [{ id: 1, y }], 2);
      expect([mid.levelRhythm, mid.levelMelodic]).toEqual([.5, .5]);
    }
    // Continuous just outside the dead zone: no step at its edge.
    const edge = run(new HandCombiner(), [{ id: 1, y: .59 }], 2);
    expect(edge.levelMelodic - .5).toBeLessThan(.02);
  });

  it('two hands split the band by side, each driving its own half', () => {
    const c = new HandCombiner();
    const fx = run(c, [{ id: 7, x: .8, y: .9, openness: 1, palmUp: 1 }, { id: 3, x: .2, y: .1, openness: 0, palmUp: -1 }], 2);
    // id 3 is on the left: rhythm.
    expect(fx.muffleRhythm).toBeCloseTo(1, 2);
    expect(fx.muffleMelodic).toBeCloseTo(0, 2);
    expect(fx.tiltRhythm).toBeCloseTo(0, 2);
    expect(fx.tiltMelodic).toBeCloseTo(1, 2);
    expect(fx.levelRhythm).toBeCloseTo(.1, 3);
    expect(fx.levelMelodic).toBeCloseTo(.9, 3);
  });

  it('two hands: span opens when apart and narrows when together', () => {
    const apart = run(new HandCombiner(), [{ id: 1, x: .1 }, { id: 2, x: .9 }], 2);
    expect(apart.span).toBeCloseTo(1, 3);
    const normal = run(new HandCombiner(), [{ id: 1, x: .325 }, { id: 2, x: .675 }], 2);
    expect(normal.span).toBeCloseTo(.5, 3);
    const together = run(new HandCombiner(), [{ id: 1, x: .45 }, { id: 2, x: .55 }], 2);
    expect(together.span).toBeCloseTo(0, 3);
  });

  it('swaps halves only after the hands cross by more than the margin', () => {
    const c = new HandCombiner();
    const pair = (x1: number) => [{ id: 1, x: x1, openness: 0 }, { id: 2, x: .5, openness: 1 }];
    expect(run(c, pair(.3), 2).muffleRhythm).toBeCloseTo(1, 3); // hand 1 is rhythm
    expect(run(c, pair(.56), 2).muffleRhythm).toBeCloseTo(1, 3); // crossed by .06: no flip
    const flipped = run(c, pair(.62), 2); // crossed by .12: hand 1 is now melodic
    expect(flipped.muffleRhythm).toBeCloseTo(0, 3);
    expect(flipped.muffleMelodic).toBeCloseTo(1, 3);
    expect(run(c, pair(.45), 2).muffleMelodic).toBeCloseTo(1, 3); // back by .05: still melodic
  });

  it('a hand dropping mid-gesture crossfades over about half a second without a jump', () => {
    const c = new HandCombiner();
    const two = [{ id: 1, x: .2, y: .9, openness: 0 }, { id: 2, x: .8, y: .2, openness: 1 }];
    const before = run(c, two, 2);
    expect(before.muffleMelodic).toBeCloseTo(0, 3);
    let largest = 0, previous = before;
    const after = run(c, [two[1]], .5, fx => {
      for (const k of ['muffleRhythm', 'muffleMelodic', 'levelRhythm', 'levelMelodic', 'span'] as const) largest = Math.max(largest, Math.abs(fx[k] - previous[k]));
      previous = fx;
    });
    expect(largest).toBeLessThan(.1); // spread over ~15 frames, not a step
    // Once the fade completes the remaining (open, low) hand conducts everything.
    expect(after.muffleRhythm).toBeLessThan(.05);
    expect(after.span).toBeCloseTo(.5, 3);
    expect(after.levelRhythm).toBeGreaterThan(.7);
  });

  it('freezes after a fist is held, ends on opening and fires the bloom', () => {
    const c = new HandCombiner();
    run(c, [{ id: 1, openness: 0 }], .45);
    expect(c.value.freeze).toBe(0); // grip still rising, then the 0.4 s hold
    run(c, [{ id: 1, openness: 0 }], .5);
    expect(c.value.freeze).toBe(1);
    expect(c.value.bloom).toBe(0);
    run(c, [{ id: 1, openness: 1 }], .4);
    expect(c.value.freeze).toBe(0);
    expect(c.value.bloom).toBeGreaterThan(.5);
    run(c, [{ id: 1, openness: 1 }], 1);
    expect(c.value.bloom).toBeLessThan(.4); // τ 0.8 s
    run(c, [{ id: 1, openness: 1 }], 6);
    expect(c.value.bloom).toBe(0);
  });

  it('a short squeeze does not freeze', () => {
    const c = new HandCombiner();
    run(c, [{ id: 1, openness: 0 }], .4);
    run(c, [{ id: 1, openness: 1 }], 2, fx => expect(fx.freeze).toBe(0));
  });

  it('caps a freeze at 6 s, and needs the hand to open before freezing again', () => {
    const c = new HandCombiner();
    let frozen = 0;
    run(c, [{ id: 1, openness: 0 }], 10, fx => { frozen += fx.freeze * DT; });
    expect(frozen).toBeCloseTo(DEFAULT_HANDS.freezeCap, 1);
    expect(c.value.freeze).toBe(0);
    expect(c.value.bloom).toBeGreaterThan(0); // the cap fired the bloom too
    run(c, [{ id: 1, openness: .45 }], 2); // grip .55: not open enough to re-arm
    run(c, [{ id: 1, openness: 0 }], 2);
    expect(c.value.freeze).toBe(0);
    run(c, [{ id: 1, openness: 1 }], 1); // opened: re-armed
    run(c, [{ id: 1, openness: 0 }], 1.5);
    expect(c.value.freeze).toBe(1);
  });

  it('two hands: the larger grip freezes', () => {
    const c = new HandCombiner();
    run(c, [{ id: 1, x: .2, openness: 1 }, { id: 2, x: .8, openness: 0 }], 1.5);
    expect(c.value.freeze).toBe(1);
  });

  it('a swipe fires one whoosh, at most once per cooldown', () => {
    const c = new HandCombiner();
    const fires: number[] = [];
    let last = 0;
    const swipe = (t: number) => [{ id: 1, speed: t < .5 ? 4 : 0 }];
    run(c, swipe, 3, (fx, t) => { if (fx.whoosh === 1 && last < 1) fires.push(t); last = fx.whoosh; });
    expect(fires).toHaveLength(1); // held fast: still one shot
    expect(c.value.whoosh).toBe(0); // decayed and snapped home
    // Two swipes 0.4 s apart: the second falls inside the cooldown.
    fires.length = 0;
    const twice = (t: number) => [{ id: 1, speed: (t < .2 || (t > .4 && t < .6)) ? 6 : 0 }];
    run(c, twice, 2, (fx, t) => { if (fx.whoosh === 1 && last < 1) fires.push(t); last = fx.whoosh; });
    expect(fires).toHaveLength(1);
    // Slow motion never whooshes.
    run(new HandCombiner(), [{ id: 1, speed: 1.2 }], 2, fx => expect(fx.whoosh).toBe(0));
  });

  it('returns home over about a second when the hands leave', () => {
    const c = new HandCombiner();
    run(c, [{ id: 1, openness: .3, palmUp: 1, y: .95 }], 2);
    const half = run(c, [], .5);
    expect(half.tiltRhythm).toBeGreaterThan(.6); // still on its way, not a dropout
    expect(run(c, [], .6)).toEqual({ ...GESTURE_HOME, bloom: c.value.bloom });
    expect(run(c, [], 5)).toEqual(GESTURE_HOME);
  });

  it('with three hands, the two present longest play', () => {
    const c = new HandCombiner();
    run(c, [{ id: 5, x: .1, openness: 0 }, { id: 6, x: .9, openness: 1 }], 1);
    const fx = run(c, [{ id: 5, x: .1, openness: 0 }, { id: 6, x: .9, openness: 1 }, { id: 9, x: .5, y: 1, palmUp: 1 }], 1);
    expect(fx.tiltMelodic).toBeCloseTo(.5, 3); // the newcomer is ignored
    expect(fx.muffleRhythm).toBeCloseTo(1, 3);
  });

  it('release returns home at once', () => {
    const c = new HandCombiner();
    run(c, [{ id: 1, openness: 0, palmUp: 1, speed: 3 }], 2);
    expect(c.release()).toEqual(GESTURE_HOME);
    expect(c.value).toEqual(GESTURE_HOME);
    expect(c.step([hand({ id: 1, openness: 1 })], DT)).toEqual(GESTURE_HOME);
  });

  it('stays within 0..1 for random input and is deterministic', () => {
    const script = () => {
      let seed = 11;
      const random = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
      const c = new HandCombiner(), out: GestureFx[] = [];
      for (let i = 0; i < 3000; i++) {
        const count = Math.floor(random() * 4);
        const poses = Array.from({ length: count }, (_, k) => hand({ id: k + Math.floor(random() * 2), x: random() * 1.4 - .2, y: random(), openness: random() < .1 ? NaN : random(), palmUp: random() * 3 - 1.5, speed: random() * 3 }));
        const fx = c.step(poses, random() < .02 ? NaN : random() * .1);
        expect(inRange(fx)).toBe(true);
        out.push(fx);
      }
      return out;
    };
    expect(script()).toEqual(script());
  });
});
