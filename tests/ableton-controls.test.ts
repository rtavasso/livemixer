import { describe, it, expect } from 'vitest';
import { normalize, stutterCount, smooth } from '../src/ableton/controls';

describe('Ableton controls', () => {
  it('keeps a MIDI midpoint at two sixteenth-note stutters and clamps the endpoints', () => {
    expect([0, .25, .5, 64 / 127, .75, 1].map(stutterCount)).toEqual([0, 1, 2, 2, 3, 4]);
    expect(stutterCount(Number.NaN)).toBe(0);
  });
  it('normalizes signal ranges without sending invalid values to audio', () => {
    expect(normalize({ value: 12, min: 10, max: 14 }, 0)).toBe(.5);
    expect(normalize({ value: 100, min: 10, max: 14 }, 0)).toBe(1);
    expect(normalize({ value: NaN, min: 0, max: 1 }, 1)).toBe(1);
    expect(normalize({ value: 0, min: 1, max: 1 }, .5)).toBe(.5);
    expect(normalize(undefined, 1)).toBe(1);
  });
  it('smooths continuously without overshoot after a long pause', () => {
    expect(smooth(0, 1, 120)).toBeCloseTo(1 - Math.exp(-1));
    expect(smooth(.2, 1, 0)).toBe(.2);
    expect(smooth(.2, 1, 5000)).toBeLessThan(1);
  });
  it('settles exactly to zero so fresh but motionless input disables repeat', () => {
    let amount = 1;
    for (let i = 0; i < 10; i++) amount = smooth(amount, 0, 120);
    expect(amount).toBe(0);
    expect(stutterCount(amount)).toBe(0);
  });
});
