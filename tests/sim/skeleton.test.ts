/**
 * The shared skeleton → capsules rules (skeleton.ts), the Leap source's reduction onto them
 * (kept equivalent to the builder it replaced), and the depth bridge's `skeleton` field.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BONE_WIDTH_FACTORS, FOREARM_WIDTH_FACTOR, skeletonCapsules, skeletonPoints, type Skeleton } from '../../src/sim/input/skeleton';
import { DEFAULT_LEAP_BOX, leapFrameToHands, leapHandCapsules, leapSkeleton, parseLeapMessage, type LeapBox, type LeapFrame } from '../../src/sim/input/leap';
import { bridgeFrameToInput, bridgeSkeletonSchema, parseBridgeMessage, PROTOCOL_VERSION, type BridgeFrame, type BridgeHello } from '../../src/sim/input/protocol';
import { DEPTH_MAPPING, mapCapsule, mapPoint } from '../../src/sim/input/mapping';
import { HandTracker } from '../../src/sim/input/conditioning';
import type { Vec3 } from '../../src/sim/core/types';
import type { Capsule } from '../../src/sim/input/types';

const v = (x: number, y: number, z: number): Vec3 => ({ x, y, z });
type Joints = Skeleton['fingers'][number]['joints'];
/** A hand in a unit image-oriented box: palm at the centre, five straight fingers fanning upward (v decreasing), forearm below. */
function skeleton(over: Partial<Skeleton> = {}): Skeleton {
  const finger = (i: number) => {
    const du = (i - 2) * .04, len = i === 0 ? .1 : .14;
    const joints = [0, .3, .6, .85, 1].map(t => v(.5 + du * t, .48 - len * t, .3 + .01 * t)) as Joints;
    return { joints, width: .03 + .002 * (4 - i), extended: true };
  };
  return { palm: v(.5, .5, .3), wrist: v(.5, .58, .3), elbow: v(.5, .7, .32), palmWidth: .14, armWidth: .09, fingers: [0, 1, 2, 3, 4].map(finger), ...over };
}
const tuple = (p: Vec3): [number, number, number] => [p.x, p.y, p.z];
/** The same hand in the wire shape of the depth bridge. */
function wireSkeleton(s: Skeleton = skeleton()) {
  return { type: 'right', palm: tuple(s.palm), wrist: tuple(s.wrist), elbow: s.elbow && tuple(s.elbow), palmWidth: s.palmWidth, armWidth: s.armWidth, fingers: s.fingers.map(f => ({ joints: f.joints.map(tuple), width: f.width, extended: f.extended })) };
}
const near = (a: Vec3, b: Vec3, digits = 12) => { expect(a.x).toBeCloseTo(b.x, digits); expect(a.y).toBeCloseTo(b.y, digits); expect(a.z).toBeCloseTo(b.z, digits); };

describe('skeleton capsules', () => {
  it('builds four capsules per finger in bone order with tapered radii, then the forearm', () => {
    const s = skeleton(), caps = skeletonCapsules(s);
    expect(caps).toHaveLength(21);
    s.fingers.forEach((f, i) => { for (let k = 0; k < 4; k++) { const c = caps[i * 4 + k]; expect(c.a).toEqual(f.joints[k]); expect(c.b).toEqual(f.joints[k + 1]); expect(c.radius).toBeCloseTo(f.width / 2 * BONE_WIDTH_FACTORS[k], 12); } });
    const forearm = caps[20];
    expect(forearm.a).toEqual(s.wrist); expect(forearm.b).toEqual(s.elbow); expect(forearm.radius).toBeCloseTo(.09 * FOREARM_WIDTH_FACTOR / 2, 12);
    expect(BONE_WIDTH_FACTORS).toEqual([1.15, 1, .9, .8]);
  });
  it('skips zero-length bones (the Leap thumb metacarpal) and builds no forearm without an elbow', () => {
    const s = skeleton(); s.fingers[0].joints[0] = { ...s.fingers[0].joints[1] };
    expect(skeletonCapsules(s)).toHaveLength(20);
    expect(skeletonCapsules(skeleton({ elbow: undefined }))).toHaveLength(20);
    expect(skeletonCapsules(skeleton({ fingers: [], elbow: undefined }))).toEqual([]);
  });
  it('never clamps joints: a finger past the box edge keeps its length', () => {
    const s = skeleton(); s.fingers[2].joints[4] = v(1.2, -.1, 1.05);
    const tip = skeletonCapsules(s)[2 * 4 + 3];
    expect(tip.b).toEqual({ x: 1.2, y: -.1, z: 1.05 });
  });
  it('stands in for missing widths with anatomical ratios, and drops the forearm when nothing is known', () => {
    const fromPalm = skeletonCapsules(skeleton({ armWidth: undefined }));
    expect(fromPalm[20].radius).toBeCloseTo(.14 * .68 * FOREARM_WIDTH_FACTOR / 2, 12);
    const fromFinger = skeletonCapsules(skeleton({ armWidth: undefined, palmWidth: undefined }));
    expect(fromFinger[20].radius).toBeCloseTo(skeleton().fingers[1].width * 3.2 * FOREARM_WIDTH_FACTOR / 2, 12);
    expect(skeletonCapsules(skeleton({ armWidth: undefined, palmWidth: undefined, fingers: [] }))).toEqual([]);
  });
  it('copies endpoints, so later edits to the skeleton do not reach the capsules', () => {
    const s = skeleton(), caps = skeletonCapsules(s);
    s.fingers[0].joints[0].x = 99; s.wrist.x = 99;
    expect(caps[0].a.x).not.toBe(99); expect(caps[20].a.x).not.toBe(99);
  });
  it('points are the palm then the fingertips, thumb first', () => {
    const s = skeleton(), pts = skeletonPoints(s);
    expect(pts).toHaveLength(6); expect(pts[0]).toEqual(s.palm); expect(pts[1]).toEqual(s.fingers[0].joints[4]); expect(pts[5]).toEqual(s.fingers[4].joints[4]);
  });
});

/** The capsule builder leap.ts had before skeleton.ts existed, kept verbatim as the reference. */
function legacyLeapCapsules(hand: LeapFrame['hands'][number], fingers: LeapFrame['pointables'], box: LeapBox): Capsule[] {
  const normOpen = (value: number, [low, high]: [number, number]) => (value - low) / (high - low);
  const toSourceOpen = (p: [number, number, number]): Vec3 => ({ x: normOpen(p[0], box.x), y: normOpen(p[1], box.y), z: normOpen(p[2], box.z) });
  const mmToSourceX = (mm: number) => mm / (box.x[1] - box.x[0]);
  const out: Capsule[] = [];
  const seg = (a: [number, number, number], b: [number, number, number], widthMm: number) => {
    const dx = a[0] - b[0], dy = a[1] - b[1], dz = a[2] - b[2];
    if (dx * dx + dy * dy + dz * dz < 1) return;
    out.push({ a: toSourceOpen(a), b: toSourceOpen(b), radius: mmToSourceX(widthMm / 2) });
  };
  for (const f of fingers) {
    const width = f.width ?? 16;
    if (f.carpPosition && f.mcpPosition) seg(f.carpPosition, f.mcpPosition, width * 1.15);
    if (f.mcpPosition && f.pipPosition) seg(f.mcpPosition, f.pipPosition, width);
    if (f.pipPosition && f.dipPosition) seg(f.pipPosition, f.dipPosition, width * .9);
    if (f.dipPosition && (f.btipPosition ?? f.tipPosition)) seg(f.dipPosition, f.btipPosition ?? f.tipPosition, width * .8);
  }
  if (hand.wrist && hand.elbow) {
    const d = [hand.elbow[0] - hand.wrist[0], hand.elbow[1] - hand.wrist[1], hand.elbow[2] - hand.wrist[2]];
    const len = Math.sqrt(d[0] * d[0] + d[1] * d[1] + d[2] * d[2]) || 1, cut = Math.min(len, 70) / len;
    seg(hand.wrist, [hand.wrist[0] + d[0] * cut, hand.wrist[1] + d[1] * cut, hand.wrist[2] + d[2] * cut], (hand.armWidth ?? 55) * .85);
  }
  return out;
}

describe('leap source through the shared skeleton', () => {
  const realFrame = parseLeapMessage(readFileSync(new URL('./fixtures/leap-hand-frame.json', import.meta.url), 'utf8'))!;
  const hand = realFrame.hands[0], fingers = realFrame.pointables.filter(p => p.handId === hand.id && !p.tool).sort((a, b) => (a.type ?? 0) - (b.type ?? 0));
  it('matches the previous capsule builder on a real frame, capsule for capsule', () => {
    for (const box of [DEFAULT_LEAP_BOX, { x: [-160, 160], y: [100, 450], z: [-120, 120] } as LeapBox]) {
      const before = legacyLeapCapsules(hand, fingers, box), after = leapHandCapsules(hand, fingers, box);
      expect(after).toHaveLength(before.length); expect(after.length).toBe(21);
      before.forEach((c, i) => { near(after[i].a, c.a); near(after[i].b, c.b); expect(after[i].radius).toBeCloseTo(c.radius, 12); });
    }
  });
  it('yields no capsules for abridged frames without joints, as before', () => {
    const abridged = parseLeapMessage(JSON.stringify({ id: 1, timestamp: 1, hands: [{ id: 3, palmPosition: [0, 200, 0] }], pointables: [0, 1, 2, 3, 4].map(type => ({ id: 30 + type, handId: 3, type, tipPosition: [type * 10, 250, -40] })) }))!;
    expect(legacyLeapCapsules(abridged.hands[0], abridged.pointables, DEFAULT_LEAP_BOX)).toEqual([]);
    expect(leapHandCapsules(abridged.hands[0], abridged.pointables, DEFAULT_LEAP_BOX)).toEqual([]);
    expect(leapFrameToHands(abridged, DEFAULT_LEAP_BOX)[0].capsules).toBeUndefined();
  });
  it('reduces the hand to five fingers thumb-first, box-fraction widths, and a 70 mm forearm stub', () => {
    const s = leapSkeleton(hand, fingers, DEFAULT_LEAP_BOX);
    expect(s.fingers).toHaveLength(5);
    expect(s.fingers[0].width).toBeCloseTo(18.027338 / 600, 12); expect(s.fingers[4].extended).toBe(false);
    expect(s.palmWidth).toBeCloseTo(81.002838 / 600, 12); expect(s.armWidth).toBeCloseTo(56.726025 / 600, 12);
    const dx = (s.elbow!.x - s.wrist.x) * 600, dy = (s.elbow!.y - s.wrist.y) * 340, dz = (s.elbow!.z - s.wrist.z) * 240;
    expect(Math.sqrt(dx * dx + dy * dy + dz * dz)).toBeCloseTo(70, 6);
    expect(skeletonPoints(s)).toHaveLength(6);
    // Joints are open-mapped: the elbow of a hand held at the box's far edge may lie outside [0, 1].
    const far = leapSkeleton({ ...hand, wrist: [290, 200, 0], elbow: [400, 200, 0] }, fingers, DEFAULT_LEAP_BOX);
    expect(far.elbow!.x).toBeGreaterThan(1);
  });
});

describe('bridge skeleton protocol', () => {
  const hello = { type: 'hello', version: PROTOCOL_VERSION, source: 'leap', box: { x: [-.3, .3], y: [-.2, .2], z: [.1, .5] }, fps: 60, surface: { width: 8, height: 6 }, skeleton: true };
  const hand = (over: Record<string, unknown> = {}) => ({ id: 4, pos: [.5, .5, .3], conf: 1, openness: .9, pinch: .1, skeleton: wireSkeleton(), ...over });
  const frame = (hands: unknown[]) => JSON.stringify({ type: 'frame', seq: 1, t: 2.5, hands });
  it('hello may announce skeletons and hands may carry one; bridges without them still validate', () => {
    const h = parseBridgeMessage(JSON.stringify(hello)) as BridgeHello;
    expect(h.skeleton).toBe(true);
    expect((parseBridgeMessage(JSON.stringify({ ...hello, skeleton: undefined })) as BridgeHello).skeleton).toBeUndefined();
    const f = parseBridgeMessage(frame([hand()])) as BridgeFrame;
    expect(f.hands[0].skeleton?.fingers).toHaveLength(5); expect(f.hands[0].skeleton?.type).toBe('right');
    expect((parseBridgeMessage(frame([hand({ skeleton: undefined })])) as BridgeFrame).hands[0].skeleton).toBeUndefined();
    expect(PROTOCOL_VERSION).toBe(1);
  });
  it('rejects the wrong finger count, non-finite joints, bad handedness and unknown keys', () => {
    const s = wireSkeleton();
    expect(() => parseBridgeMessage(frame([hand({ skeleton: { ...s, fingers: s.fingers.slice(0, 4) } })]))).toThrow(/fingers/);
    expect(() => parseBridgeMessage(frame([hand({ skeleton: { ...s, fingers: [...s.fingers, s.fingers[0]] } })]))).toThrow(/fingers/);
    const nulled = wireSkeleton(); (nulled.fingers[1].joints[2] as unknown[])[0] = null;
    expect(() => parseBridgeMessage(frame([hand({ skeleton: nulled })]))).toThrow(/joints/);
    const infinite = wireSkeleton(); infinite.palm[2] = Infinity;
    expect(bridgeSkeletonSchema.safeParse(infinite).success).toBe(false);
    expect(() => parseBridgeMessage(frame([hand({ skeleton: { ...s, type: 'both' } })]))).toThrow(/type/);
    expect(() => parseBridgeMessage(frame([hand({ skeleton: { ...s, handedness: 'right' } })]))).toThrow(/handedness|unrecognized/i);
    const extra = wireSkeleton(); (extra.fingers[0] as Record<string, unknown>).length = 45;
    expect(() => parseBridgeMessage(frame([hand({ skeleton: extra })]))).toThrow(/length|unrecognized/i);
    // A skeleton with the elbow and widths omitted is fine: they are optional on the wire.
    expect(() => parseBridgeMessage(frame([hand({ skeleton: { ...s, elbow: undefined, palmWidth: undefined, armWidth: undefined } })]))).not.toThrow();
  });
  it('converts a skeleton into capsules and derives points when the bridge sends none', () => {
    const h = parseBridgeMessage(JSON.stringify(hello)) as BridgeHello;
    const derived = bridgeFrameToInput(parseBridgeMessage(frame([hand()])) as BridgeFrame, 0, 0, h).hands[0];
    expect(derived.capsules).toHaveLength(21); expect(derived.points).toHaveLength(6);
    expect(derived.points![0]).toEqual({ x: .5, y: .5, z: .3 }); expect(derived.points![1]).toEqual(skeleton().fingers[0].joints[4]);
    expect(derived.capsules![20].radius).toBeCloseTo(.09 * FOREARM_WIDTH_FACTOR / 2, 12);
    const sent = bridgeFrameToInput(parseBridgeMessage(frame([hand({ points: [[.1, .2, .3], [.4, .5, .6]] })])) as BridgeFrame, 0, 0, h).hands[0];
    expect(sent.points).toEqual([{ x: .1, y: .2, z: .3 }, { x: .4, y: .5, z: .6 }]); expect(sent.capsules).toHaveLength(21);
    const blob = bridgeFrameToInput(parseBridgeMessage(frame([hand({ skeleton: undefined })])) as BridgeFrame, 0, 0, h).hands[0];
    expect(blob.capsules).toBeUndefined(); expect(blob.points).toBeUndefined();
    // Joints that overshoot the box are kept: the bridge does not clamp them and neither does the browser.
    const over = skeleton(); over.fingers[2].joints[4] = v(1.15, -.05, .3);
    const overshoot = bridgeFrameToInput(parseBridgeMessage(frame([hand({ skeleton: wireSkeleton(over) })])) as BridgeFrame, 0, 0, h).hands[0];
    expect(overshoot.capsules![2 * 4 + 3].b).toEqual({ x: 1.15, y: -.05, z: .3 });
  });
  it('capsules cross the depth mapping unclamped, while positions still clamp, and ride through the tracker', () => {
    const c = mapCapsule(DEPTH_MAPPING, { a: v(-.1, .5, .5), b: v(.5, 1.2, .5), radius: .02 });
    expect(c.a.x).toBeCloseTo(1.1, 12); expect(c.b.y).toBeCloseTo(-.2, 12); expect(c.radius).toBeCloseTo(.02, 12);
    expect(mapPoint(DEPTH_MAPPING, v(-.1, 1.2, .5))).toEqual({ x: 1, y: 0, z: .5 });
    const h = parseBridgeMessage(JSON.stringify(hello)) as BridgeHello, t = new HandTracker(DEPTH_MAPPING);
    for (let i = 0; i < 12; i++) {
      const f = parseBridgeMessage(JSON.stringify({ type: 'frame', seq: i, t: i / 30, hands: [hand()] })) as BridgeFrame;
      t.ingest(bridgeFrameToInput(f, i * 33, i * 33, h)); t.tick(i * 33);
    }
    const tracked = t.tick(400).hands[0];
    expect(tracked.capsules).toHaveLength(21); expect(tracked.points).toHaveLength(6);
    // Image v grows downward; the fingertips point up the picture, above the mirrored palm.
    expect(tracked.capsules[3].b.y).toBeGreaterThan(tracked.position.y);
  });
});

describe('bridge frame announcement', () => {
  const hello = { type: 'hello', version: PROTOCOL_VERSION, source: 'leap', box: { x: [-.31, .31], y: [.1, .45], z: [-.175, .175] }, surface: { width: 8, height: 6 }, skeleton: true };
  it('accepts image and upright frames and rejects anything else', () => {
    expect((parseBridgeMessage(JSON.stringify({ ...hello, frame: 'upright' })) as BridgeHello).frame).toBe('upright');
    expect((parseBridgeMessage(JSON.stringify({ ...hello, frame: 'image' })) as BridgeHello).frame).toBe('image');
    expect((parseBridgeMessage(JSON.stringify(hello)) as BridgeHello).frame).toBeUndefined();
    expect(() => parseBridgeMessage(JSON.stringify({ ...hello, frame: 'sideways' }))).toThrow(/frame/);
  });
});
