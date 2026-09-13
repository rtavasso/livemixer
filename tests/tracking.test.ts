import { describe, expect, it } from 'vitest';
import { HandSpace, type Palm } from '../src/control/space';
const palm = (values: Partial<Palm> = {}): Palm => ({ id: 1, x: 0, y: 270, z: 0, type: 0, visibleMs: 1000, ...values });

describe('imperfect sensor playback', () => {
  it('bridges two missing frames at the measured 7 Hz cadence and still releases a withdrawn hand', () => {
    const hand = new HandSpace();
    for (let t = 0; t <= 1400; t += 140) hand.observe([palm()], t);
    hand.observe([], 1540); hand.observe([], 1680);
    expect(hand.sample(1810).presence).toBe(1);
    expect(hand.observe([palm({ id: 7, y: 280 })], 1820).presence).toBe(1);
    hand.observe([], 1960);
    expect(hand.sample(2600).presence).toBe(0);
    expect(hand.sample(10000).presence).toBe(0);
  });
  it('uses native cadence immediately, before the arrival-rate estimate has warmed up', () => {
    const hand = new HandSpace(); hand.observe([palm()], 0, 7.2);
    hand.observe([], 140, 7.2); hand.observe([], 280, 7.2);
    expect(hand.sample(410).presence).toBe(1);
    expect(hand.observe([palm()], 420, 7.2).presence).toBe(1);
    expect(hand.sample(1200).presence).toBe(0);
  });
  it('rejects one-frame false hands and confirms an actual arrival', () => {
    const hand = new HandSpace();
    expect(hand.observe([palm({ visibleMs: 0 })], 0).presence).toBe(0);
    expect(hand.observe([], 40).presence).toBe(0);
    expect(hand.observe([palm({ visibleMs: 0 })], 80).presence).toBe(0);
    expect(hand.observe([palm({ visibleMs: 40 })], 120).presence).toBe(1);
  });
  it('recovers a nearby ID change without handing control to the opposite hand', () => {
    const hand = new HandSpace(); hand.observe([palm()], 0);
    hand.observe([], 50);
    hand.observe([palm({ id: 8, type: 1, y: 260 }), palm({ id: 9, y: 275 })], 100);
    expect(hand.sample(150).presence).toBe(1);
    expect(hand.sample(150).height).toBeGreaterThan(.5);
    hand.observe([palm({ id: 8, type: 1, y: 120 })], 175);
    expect(hand.sample(200).height).toBeGreaterThan(.5);
  });
  it('holds a sudden position glitch for confirmation but follows deliberate macro movement', () => {
    const hand = new HandSpace(); hand.observe([palm({ y: 150 })], 0);
    hand.observe([palm({ y: 410 })], 33);
    expect(hand.sample(60).height).toBeCloseTo(.1);
    hand.observe([palm({ y: 150 })], 66);
    expect(hand.sample(90).height).toBeCloseTo(.1);
    expect(hand.rejectedJumps).toBe(1);
    for (let t = 100; t <= 400; t += 25) hand.observe([palm({ y: 150 + (t - 100) * .8 })], t);
    expect(hand.sample(475).height).toBeGreaterThan(.82);
  });
  it('reduces stationary noise without letting controls drift after tracking loss', () => {
    const hand = new HandSpace(); hand.observe([palm()], 0);
    let rawError = 0, smoothError = 0;
    for (let i = 1; i <= 120; i++) {
      const y = 270 + (i % 2 ? 8 : -8), t = i * 33;
      hand.observe([palm({ y })], t); const state = hand.sample(t + 25);
      rawError += ((y - 270) / 300) ** 2; smoothError += (state.height - .5) ** 2;
    }
    expect(Math.sqrt(smoothError / rawError)).toBeLessThan(.4);
    hand.sample(4200); hand.sample(5000); const held = hand.sample(5500);
    expect(held.presence).toBe(0);
    expect(hand.sample(10000).height).toBeCloseTo(held.height, 4);
  });
  it('recognizes a real movement out of the box without waiting for the dropout grace', () => {
    const hand = new HandSpace(); hand.observe([palm()], 0);
    expect(hand.observe([palm({ x: 300 })], 100).presence).toBe(0);
    expect(hand.status).toBe('outside');
  });
  it('does not turn malformed positions or old timestamps into movement', () => {
    const hand = new HandSpace(); hand.observe([palm()], 100);
    hand.observe([palm({ y: NaN })], 150); hand.observe([palm({ y: 400 })], 120);
    expect(hand.sample(160).height).toBe(.5);
    expect(hand.sample(1000).presence).toBe(0);
  });
});
