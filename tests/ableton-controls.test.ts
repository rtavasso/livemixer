import { describe, it, expect } from 'vitest';
import { musicRelay, normalize, stutterCount, smooth } from '../src/ableton/controls';
import { parseInbound } from '../src/sim/telemetry/types';

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
  it('relays Live\'s transport to the simulation page in the inbound music format', () => {
    const relay = musicRelay({ repeat: 0, onLeft: 0, offLeft: 0, beat: 12.5, playing: 1, amount: 0, bound: 1 });
    expect(relay).toEqual({ direction: 'inbound', message: { type: 'music', beat: 12.5, playing: true } });
    expect(parseInbound(relay!.message)).toEqual(relay!.message);
    expect(musicRelay({ beat: 0, playing: 0 })!.message.playing).toBe(false);
    expect(musicRelay(null)).toBeNull();
    // Live's meters ride along when the bridge has them, so the simulations can pulse with the audio.
    expect(musicRelay({ beat: 4, playing: 1 }, { main: .8, rhythm: .6, melodic: -1 })!.message.levels).toEqual({ main: .8, rhythm: .6, melodic: -1 });
    expect(musicRelay({ beat: 4, playing: 1 }, null)!.message.levels).toBeUndefined();
    expect(musicRelay({ beat: 4, playing: 1 }, { main: NaN, rhythm: .6, melodic: .2 })!.message.levels).toBeUndefined();
    expect(musicRelay({ beat: NaN, playing: 1 })).toBeNull();
  });
});
