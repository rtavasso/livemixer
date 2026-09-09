import { describe, expect, it } from 'vitest';
import { DEFAULT_TRACKER_SETTINGS, HandTracker, OneEuro } from '../../src/sim/input/conditioning';
import { detectGestures, emptyGestureMemory, type GestureEvent } from '../../src/sim/input/gestures';
import { calibrateMapping, IMAGE_MAPPING, mapBox, mapOccupancy, mapPoint, SCREEN_MAPPING, spaceMappingSchema, stableCapture } from '../../src/sim/input/mapping';
import { bridgeFrameToInput, ClockMapper, decodeOccupancy, encodeOccupancy, parseBridgeMessage } from '../../src/sim/input/protocol';
import { InputRecorder, parseRecording, ReplaySource } from '../../src/sim/input/replay';
import { SyntheticSource } from '../../src/sim/input/synthetic';
import { landmarksToObservation } from '../../src/sim/input/webcam';
import type { HandState, InputFrame } from '../../src/sim/input/types';

const frame = (sequence: number, at: number, x: number, y: number, z = .5, extra: Partial<InputFrame> = {}): InputFrame => ({ source: 'synthetic', sequence, observedAtMs: at, receivedAtMs: at, hands: [{ id: 1, position: { x, y, z }, confidence: 1 }], ...extra });

describe('space mapping', () => {
  it('image mapping mirrors x and flips y', () => {
    expect(mapPoint(IMAGE_MAPPING, { x: 0, y: 0, z: .5 })).toEqual({ x: 1, y: 1, z: .5 });
    expect(mapPoint(IMAGE_MAPPING, { x: 1, y: 1, z: 1 })).toEqual({ x: 0, y: 0, z: 1 });
    expect(mapPoint(SCREEN_MAPPING, { x: .25, y: 0, z: 0 })).toEqual({ x: .25, y: 1, z: 0 });
  });
  it('supports axis swaps, sub-intervals, mirroring, and clamps', () => {
    const m = spaceMappingSchema.parse({ x: { from: 'z', low: .2, high: .8, mirror: false }, y: { from: 'x', low: 0, high: 1, mirror: true }, z: { from: 'y', low: 1, high: 0, mirror: false } });
    const p = mapPoint(m, { x: .25, y: .25, z: .5 });
    expect(p.x).toBeCloseTo(.5, 9); expect(p.y).toBeCloseTo(.75, 9); expect(p.z).toBeCloseTo(.75, 9);
    expect(mapPoint(m, { x: 0, y: 0, z: 2 }).x).toBe(1);
    const box = mapBox(m, { min: { x: 0, y: 0, z: .2 }, max: { x: 1, y: 1, z: .8 } });
    expect(box.min).toEqual({ x: 0, y: 0, z: 0 }); expect(box.max).toEqual({ x: 1, y: 1, z: 1 });
  });
  it('rejects a degenerate interval', () => { expect(() => spaceMappingSchema.parse({ ...SCREEN_MAPPING, x: { from: 'x', low: .5, high: .5, mirror: false } })).toThrow(); });
  it('resamples occupancy into sim orientation', () => {
    const grid = { width: 4, height: 2, data: new Uint8Array([255, 0, 0, 0, 0, 0, 0, 9]) }; // top-left bright, bottom-right 9
    const field = mapOccupancy(SCREEN_MAPPING, grid, 4, 2);
    expect(field.data[1 * 4 + 0]).toBe(255); // row 1 = top in sim space
    expect(field.data[0 * 4 + 3]).toBe(9);
    const mirrored = mapOccupancy(IMAGE_MAPPING, grid, 4, 2);
    expect(mirrored.data[1 * 4 + 3]).toBe(255);
  });
  it('calibrates from two corners and rejects tiny spans', () => {
    const m = calibrateMapping(IMAGE_MAPPING, { bottomLeft: { x: .8, y: .9, z: .5 }, topRight: { x: .2, y: .1, z: .5 } });
    expect(mapPoint(m, { x: .8, y: .9, z: .5 })).toEqual({ x: 0, y: 0, z: .5 });
    expect(mapPoint(m, { x: .5, y: .5, z: .5 })).toEqual({ x: .5, y: .5, z: .5 });
    expect(() => calibrateMapping(IMAGE_MAPPING, { bottomLeft: { x: .5, y: .9, z: 0 }, topRight: { x: .51, y: .1, z: 0 } })).toThrow();
    const withDepth = calibrateMapping(IMAGE_MAPPING, { withdrawn: { x: 0, y: 0, z: .9 }, pushed: { x: 0, y: 0, z: .3 } });
    expect(mapPoint(withDepth, { x: 0, y: 0, z: .3 }).z).toBe(1);
  });
  it('stable capture averages still samples and rejects motion', () => {
    const still = Array.from({ length: 10 }, (_, i) => ({ position: { x: .5 + (i % 2) * .01, y: .5, z: .5 }, atMs: i * 60 }));
    expect(stableCapture(still).x).toBeCloseTo(.505, 3);
    expect(() => stableCapture(still.slice(0, 3))).toThrow();
    expect(() => stableCapture(still.map((s, i) => ({ ...s, position: { ...s.position, x: i * .1 } })))).toThrow();
  });
});

describe('one euro filter', () => {
  it('smooths jitter at rest but follows fast motion', () => {
    const f = new OneEuro(1, .02, 1);
    f.reset(0);
    let out = 0;
    for (let i = 0; i < 60; i++) out = f.filter((i % 2) * .02, 1 / 60);
    expect(Math.abs(out - .01)).toBeLessThan(.008);
    const g = new OneEuro(1, .05, 1); g.reset(0);
    let y = 0; for (let i = 1; i <= 30; i++) y = g.filter(i / 30, 1 / 60);
    expect(y).toBeGreaterThan(.8);
  });
});

describe('hand tracker', () => {
  it('requires enter time, keeps a hand through a dropout, then lets it leave', () => {
    const t = new HandTracker(SCREEN_MAPPING);
    t.ingest(frame(0, 0, .5, .5));
    expect(t.tick(0).hands).toHaveLength(0);
    t.ingest(frame(1, 30, .5, .5)); expect(t.tick(30).hands).toHaveLength(0);
    t.ingest(frame(2, 70, .5, .5)); expect(t.tick(70).hands).toHaveLength(1);
    // Dropout shorter than leaveMs keeps the hand and reports staleness.
    const held = t.tick(200); expect(held.hands).toHaveLength(1); expect(held.hands[0].staleMs).toBe(130);
    expect(t.tick(70 + DEFAULT_TRACKER_SETTINGS.leaveMs + 1).hands).toHaveLength(0);
  });
  it('discards stale and out-of-order frames and ignores low confidence', () => {
    const t = new HandTracker(SCREEN_MAPPING);
    expect(t.ingest(frame(5, 100, .5, .5))).toBe(true);
    expect(t.ingest(frame(4, 110, .5, .5))).toBe(false);
    expect(t.ingest({ ...frame(6, 120, .5, .5), observedAtMs: -500 })).toBe(false);
    expect(t.discarded).toBe(2);
    const low = new HandTracker(SCREEN_MAPPING);
    low.ingest({ ...frame(0, 0, .5, .5), hands: [{ id: 1, position: { x: .5, y: .5, z: .5 }, confidence: .1 }] });
    expect(low.tick(500).hands).toHaveLength(0);
  });
  it('estimates velocity in sim space, sorts by age, and tracks presence/activity', () => {
    const t = new HandTracker(SCREEN_MAPPING);
    let seq = 0;
    let state = t.tick(0);
    for (let at = 0; at <= 1000; at += 16) { t.ingest(frame(seq++, at, at / 1000, .5)); state = t.tick(at); }
    expect(state.hands[0].velocity.x).toBeGreaterThan(.7); expect(state.hands[0].velocity.x).toBeLessThan(1.3);
    expect(state.presence).toBeGreaterThan(.95); expect(state.activity).toBeGreaterThan(.3);
    t.ingest({ ...frame(seq++, 1016, .9, .5), hands: [{ id: 1, position: { x: .9, y: .5, z: .5 }, confidence: 1 }, { id: 7, position: { x: .1, y: .5, z: .5 }, confidence: 1 }] });
    t.ingest({ ...frame(seq++, 1100, .9, .5), hands: [{ id: 1, position: { x: .9, y: .5, z: .5 }, confidence: 1 }, { id: 7, position: { x: .1, y: .5, z: .5 }, confidence: 1 }] });
    expect(t.tick(1100).hands.map(h => h.id)).toEqual([1, 7]);
  });
  it('reports true speed for a 30 Hz source sampled by a 60 Hz display, and coasts to rest on a dropout', () => {
    const t = new HandTracker(SCREEN_MAPPING);
    let seq = 0, state = t.tick(0);
    for (let at = 0; at <= 1200; at += 16) {
      if (at % 32 === 0) t.ingest(frame(seq++, at, at / 2000, .5)); // 31 Hz observations, 0.5 units/s
      state = t.tick(at);
    }
    expect(state.hands[0].velocity.x).toBeGreaterThan(.4); expect(state.hands[0].velocity.x).toBeLessThan(.6);
    for (let at = 1216; at <= 1400; at += 16) state = t.tick(at); // no observations: still present, velocity decays
    expect(state.hands).toHaveLength(1); expect(state.hands[0].velocity.x).toBeLessThan(.3);
  });
  it('never promotes a hand seen only once', () => {
    const t = new HandTracker(SCREEN_MAPPING);
    t.ingest(frame(0, 0, .5, .5));
    for (const at of [20, 60, 100, 150, 200]) expect(t.tick(at).hands).toHaveLength(0);
  });
  it('maps occupancy and expires it', () => {
    const t = new HandTracker(SCREEN_MAPPING);
    t.ingest(frame(0, 0, .5, .5, .5, { occupancy: { width: 2, height: 2, data: new Uint8Array([255, 0, 0, 0]) } }));
    const s = t.tick(0); expect(s.occupancy?.width).toBe(DEFAULT_TRACKER_SETTINGS.occupancyWidth); expect(Math.max(...s.occupancy!.data)).toBe(255);
    expect(t.tick(5000).occupancy).toBeNull();
  });
});

describe('gestures', () => {
  const hand = (over: Partial<HandState>): HandState => ({ id: 1, position: { x: .5, y: .5, z: .2 }, velocity: { x: 0, y: 0, z: 0 }, speed: 0, extent: { min: { x: .4, y: .4, z: .2 }, max: { x: .6, y: .6, z: .2 } }, radius: .1, openness: 1, pinch: 0, confidence: 1, ageMs: 0, staleMs: 0, push: .2, points: [], ...over });
  const run = (script: (t: number) => HandState[] | null, untilMs: number, stepMs = 16) => {
    let memory = emptyGestureMemory(); const events: GestureEvent[] = [];
    for (let t = 0; t <= untilMs; t += stepMs) { const r = detectGestures(memory, script(t) ?? [], t); memory = r.memory; events.push(...r.events); }
    return events;
  };
  it('emits enter and leave with duration', () => {
    const events = run(t => t < 500 ? [hand({})] : null, 600);
    expect(events.map(e => e.type)).toEqual(['enter', 'leave']);
    expect((events[1] as Extract<GestureEvent, { type: 'leave' }>).durationMs).toBeGreaterThanOrEqual(496);
  });
  it('detects a swipe once per fast segment with direction, and re-arms after slowing down', () => {
    const events = run(t => [hand({ position: { x: Math.min(1, t / 400), y: .5, z: .2 }, speed: 2.5 })], 1500);
    const swipes = events.filter(e => e.type === 'swipe') as Extract<GestureEvent, { type: 'swipe' }>[];
    expect(swipes).toHaveLength(1); expect(swipes[0].direction).toBe('right');
    // Sweep right, pause, sweep back up-left: two swipes.
    const twice = run(t => t < 400 ? [hand({ position: { x: t / 400, y: .5, z: .2 }, speed: 2.5 })] : t < 1000 ? [hand({ position: { x: 1, y: .5, z: .2 }, speed: 0 })] : [hand({ position: { x: 1, y: .5 + (t - 1000) / 400, z: .2 }, speed: 2.5 })], 1400);
    expect((twice.filter(e => e.type === 'swipe') as Extract<GestureEvent, { type: 'swipe' }>[]).map(s => s.direction)).toEqual(['right', 'up']);
  });
  it('slow drift does not swipe; fires hold once after stillness; push on quick depth rise', () => {
    expect(run(t => [hand({ position: { x: t / 4000, y: .5, z: .2 }, speed: .25 })], 2000).filter(e => e.type === 'swipe')).toHaveLength(0);
    expect(run(() => [hand({})], 3000).filter(e => e.type === 'hold')).toHaveLength(1);
    const push = run(t => [hand({ push: t < 300 ? .1 : .6 })], 700).filter(e => e.type === 'push');
    expect(push).toHaveLength(1);
  });
  it('grab and release use hysteresis', () => {
    const script = (t: number) => [hand({ openness: t < 300 ? .9 : t < 600 ? .2 : t < 900 ? .45 : .8 })];
    const types = run(script, 1000).map(e => e.type).filter(t => t !== 'hold');
    expect(types).toEqual(['enter', 'grab', 'release']);
  });
});

describe('bridge protocol', () => {
  const hello = { type: 'hello', version: 1, source: 'synthetic', box: { x: [-.5, .5], y: [-.4, .4], z: [.5, 1.2] }, fps: 30, occupancy: { width: 2, height: 2 } };
  it('validates hello, frame, and status messages', () => {
    const h = parseBridgeMessage(JSON.stringify(hello)); expect(h.type).toBe('hello');
    const f = parseBridgeMessage(JSON.stringify({ type: 'frame', seq: 3, t: 12.5, hands: [{ id: 1, pos: [.2, .3, .4], conf: .9, extent: [[.1, .2, .3], [.3, .4, .5]] }], occupancy: encodeOccupancy({ width: 2, height: 2, data: new Uint8Array([1, 2, 3, 4]) }), stats: { pixels: 120 } }));
    expect(f.type).toBe('frame');
    expect(parseBridgeMessage(JSON.stringify({ type: 'status', message: 'hi' })).type).toBe('status');
    expect(() => parseBridgeMessage('{')).toThrow(/JSON/);
    expect(() => parseBridgeMessage(JSON.stringify({ type: 'frame', seq: -1, t: 0, hands: [] }))).toThrow(/seq/);
    expect(() => parseBridgeMessage(JSON.stringify({ type: 'frame', seq: 1, t: 0, hands: [{ id: 1, pos: [0, 0], conf: 1 }] }))).toThrow();
    if (f.type === 'frame') {
      const input = bridgeFrameToInput(f, 1000, 1010, h as never);
      expect(input.hands[0].position).toEqual({ x: .2, y: .3, z: .4 }); expect(input.hands[0].extent?.max).toEqual({ x: .3, y: .4, z: .5 });
      expect(Array.from(input.occupancy!.data)).toEqual([1, 2, 3, 4]); expect(input.stats).toEqual({ pixels: 120 });
    }
  });
  it('round-trips occupancy and rejects a size mismatch', () => {
    const grid = { width: 3, height: 2, data: new Uint8Array([0, 128, 255, 7, 8, 9]) };
    expect(Array.from(decodeOccupancy(encodeOccupancy(grid), 3, 2).data)).toEqual(Array.from(grid.data));
    expect(() => decodeOccupancy(encodeOccupancy(grid), 2, 2)).toThrow();
  });
  it('clock mapper re-based after a reset accepts a slow producer clock', () => {
    const c = new ClockMapper(5000);
    c.observe(0, 0);
    // The producer's clock runs at half speed: apparent lateness grows until a source re-bases.
    expect(1000 - c.observe(.5, 1000)).toBeCloseTo(500, 6);
    c.reset();
    expect(c.observe(.5, 1000)).toBe(1000);
  });
  it('clock mapper tracks the minimum transport delay', () => {
    const c = new ClockMapper(1000);
    expect(c.observe(1, 1100)).toBe(1100);
    expect(c.observe(1.1, 1250)).toBe(1200);   // 50 ms of jitter shows up as lateness
    expect(c.observe(1.2, 1300)).toBe(1300);
  });
});

describe('recording and replay', () => {
  it('round-trips frames with timing and occupancy', () => {
    const recorder = new InputRecorder();
    recorder.add(frame(0, 1000, .1, .2, .3, { occupancy: { width: 1, height: 1, data: new Uint8Array([200]) } }));
    recorder.add({ ...frame(1, 1050, .4, .5), observedAtMs: 1040 });
    const records = parseRecording(recorder.jsonl());
    expect(records).toHaveLength(2); expect(records[1].atMs).toBe(50);
    const out: InputFrame[] = [];
    const replay = new ReplaySource(records, f => out.push(f)); replay.loop = false; void replay.start();
    replay.sample(5000); replay.sample(5049); replay.sample(5050);
    expect(out).toHaveLength(2); expect(out[0].source).toBe('replay'); expect(out[0].occupancy?.data[0]).toBe(200); expect(out[1].observedAtMs).toBe(5040);
    expect(replay.done).toBe(true);
    expect(() => parseRecording('nope')).toThrow();
  });
  it('synthetic source is deterministic and emits occupancy', () => {
    const a: InputFrame[] = [], b: InputFrame[] = [];
    const sa = new SyntheticSource(f => a.push(f)), sb = new SyntheticSource(f => b.push(f));
    void sa.start(); void sb.start();
    for (let t = 0; t < 2000; t += 100) { sa.sample(t); sb.sample(t); }
    expect(a.map(f => f.hands[0]?.position)).toEqual(b.map(f => f.hands[0]?.position));
    expect(a[0].occupancy?.width).toBe(32); expect(a[0].hands).toHaveLength(1);
  });
});

describe('webcam landmark reduction', () => {
  const openHand = () => {
    const pts = Array.from({ length: 21 }, () => ({ x: .5, y: .5 }));
    pts[0] = { x: .5, y: .8 }; pts[5] = { x: .45, y: .6 }; pts[9] = { x: .5, y: .6 }; pts[13] = { x: .55, y: .6 }; pts[17] = { x: .6, y: .6 };
    pts[8] = { x: .45, y: .4 }; pts[12] = { x: .5, y: .38 }; pts[16] = { x: .55, y: .4 }; pts[20] = { x: .6, y: .42 }; pts[4] = { x: .3, y: .6 };
    return pts;
  };
  it('reports an open hand with a palm centre and extent', () => {
    const o = landmarksToObservation(openHand(), 640, 480)!;
    expect(o.position.x).toBeCloseTo(.52, 2); expect(o.openness).toBeGreaterThan(.8); expect(o.pinch).toBeLessThan(.3);
    expect(o.extent!.min.x).toBeCloseTo(.3, 5); expect(o.points).toHaveLength(6);
  });
  it('reports a fist as closed and rejects degenerate hands', () => {
    const fist = openHand(); for (const i of [8, 12, 16, 20]) fist[i] = { x: .5, y: .58 };
    expect(landmarksToObservation(fist, 640, 480)!.openness).toBeLessThan(.15);
    expect(landmarksToObservation(openHand().slice(0, 10), 640, 480)).toBeNull();
    expect(landmarksToObservation(Array.from({ length: 21 }, () => ({ x: .5, y: .5 })), 640, 480)).toBeNull();
  });
});
