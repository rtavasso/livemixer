import { describe, expect, it } from 'vitest';
import { DEFAULT_LEAP_BOX, leapBoxSchema, leapFrameToHands, parseLeapMessage } from '../../src/sim/input/leap';
import { LEAP_MAPPING, mapPoint } from '../../src/sim/input/mapping';
import { HandTracker } from '../../src/sim/input/conditioning';

/** A tracking frame in the shape the Leap service's v6 WebSocket API sends (abridged). */
const frame = (over: Record<string, unknown> = {}) => JSON.stringify({
  currentFrameRate: 112.4, id: 4180, timestamp: 27381529, r: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], s: 1, t: [0, 0, 0],
  interactionBox: { center: [0, 200, 0], size: [235.247, 235.247, 147.751] },
  hands: [{ id: 12, type: 'right', confidence: .98, grabStrength: .25, pinchStrength: .1, timeVisible: 2.4, palmPosition: [40, 210, -20], stabilizedPalmPosition: [41, 211, -21], palmVelocity: [120, 0, -30], palmNormal: [0, -1, 0], direction: [0, 0, -1], palmWidth: 85 }],
  pointables: [
    { id: 120, handId: 12, type: 0, tipPosition: [-10, 205, -50], stabilizedTipPosition: [-10, 205, -50], extended: true, tool: false, length: 45, width: 18 },
    { id: 121, handId: 12, type: 1, tipPosition: [30, 260, -70], extended: true, tool: false },
    { id: 122, handId: 12, type: 2, tipPosition: [45, 265, -75], extended: true, tool: false },
    { id: 123, handId: 12, type: 3, tipPosition: [60, 255, -70], extended: false, tool: false },
    { id: 124, handId: 12, type: 4, tipPosition: [75, 240, -55], extended: false, tool: false },
    { id: 900, handId: 12, type: 0, tipPosition: [0, 0, 0], tool: true },
  ],
  gestures: [], devices: [], ...over,
});

describe('leap protocol', () => {
  it('ignores greetings and events, parses tracking frames', () => {
    expect(parseLeapMessage('{"serviceVersion":"5.0.0-preview+52386","version":6}')).toBeNull();
    expect(parseLeapMessage('{"event":{"type":"deviceEvent","state":{"attached":true,"id":"LP123","streaming":true,"type":"peripheral"}}}')).toBeNull();
    expect(parseLeapMessage('not json')).toBeNull();
    const f = parseLeapMessage(frame())!;
    expect(f.id).toBe(4180); expect(f.hands).toHaveLength(1); expect(f.pointables).toHaveLength(6);
  });
  it('normalizes palm and fingertips into the box, keeping the tool out and fingers in order', () => {
    const hands = leapFrameToHands(parseLeapMessage(frame())!, DEFAULT_LEAP_BOX);
    expect(hands).toHaveLength(1);
    const h = hands[0];
    expect(h.id).toBe(12);
    expect(h.position.x).toBeCloseTo((41 + 140) / 280, 6); expect(h.position.y).toBeCloseTo((211 - 90) / 240, 6); expect(h.position.z).toBeCloseTo((-21 + 100) / 200, 6);
    expect(h.openness).toBeCloseTo(.75, 6); expect(h.pinch).toBeCloseTo(.1, 6); expect(h.confidence).toBeCloseTo(.98, 6);
    expect(h.points).toHaveLength(6); // five fingertips then the palm
    expect(h.points![0].x).toBeCloseTo((-10 + 140) / 280, 6); // thumb first
    expect(h.extent!.min.x).toBeCloseTo((-10 + 140) / 280, 6); expect(h.extent!.max.y).toBeCloseTo((265 - 90) / 240, 6);
  });
  it('clamps outside the box and defaults missing strengths', () => {
    const h = leapFrameToHands(parseLeapMessage(frame({ hands: [{ id: 3, palmPosition: [900, -50, 500] }], pointables: [] }))!, DEFAULT_LEAP_BOX)[0];
    expect(h.position).toEqual({ x: 1, y: 0, z: 1 }); expect(h.openness).toBe(1); expect(h.pinch).toBe(0); expect(h.confidence).toBe(1);
    expect(h.points).toHaveLength(1);
  });
  it('rejects a degenerate box', () => { expect(() => leapBoxSchema.parse({ x: [0, 5], y: [0, 100], z: [0, 100] })).toThrow(); });
});

describe('leap mapping into sim space', () => {
  it('right is right, up is up, and moving toward the display pushes in', () => {
    const hands = leapFrameToHands(parseLeapMessage(frame())!, DEFAULT_LEAP_BOX);
    const p = mapPoint(LEAP_MAPPING, hands[0].position);
    expect(p.x).toBeGreaterThan(.5);                       // palm at +41 mm: performer's right
    expect(p.y).toBeCloseTo((211 - 90) / 240, 6);          // higher hand = higher on screen
    expect(p.z).toBeCloseTo(1 - (-21 + 100) / 200, 6);     // z toward the performer is withdrawn; toward the display is pushed
    const nearDisplay = mapPoint(LEAP_MAPPING, { x: .5, y: .5, z: 0 }), nearPerformer = mapPoint(LEAP_MAPPING, { x: .5, y: .5, z: 1 });
    expect(nearDisplay.z).toBe(1); expect(nearPerformer.z).toBe(0);
  });
  it('flows through the tracker as a present hand with openness', () => {
    const t = new HandTracker(LEAP_MAPPING);
    const hands = leapFrameToHands(parseLeapMessage(frame())!, DEFAULT_LEAP_BOX);
    for (let i = 0; i < 12; i++) { t.ingest({ source: 'leap', sequence: i, observedAtMs: i * 9, receivedAtMs: i * 9, hands }); t.tick(i * 9); }
    const s = t.tick(110);
    expect(s.hands).toHaveLength(1); expect(s.hands[0].openness).toBeCloseTo(.75, 6); expect(s.hands[0].points).toHaveLength(6);
  });
});
