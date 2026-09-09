import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DEFAULT_LEAP_BOX, leapFrameToHands, parseLeapMessage } from '../../src/sim/input/leap';
import { LEAP_MAPPING, mapCapsule, mapVoxels, SCREEN_MAPPING, spaceMappingSchema } from '../../src/sim/input/mapping';
import { HandTracker } from '../../src/sim/input/conditioning';
import { bridgeFrameToInput, decodeVoxels, parseBridgeMessage } from '../../src/sim/input/protocol';
import { capsuleDistance, createPackedHands, handSdfGlsl, packHands } from '../../src/sim/gl/hand';
import type { HandState } from '../../src/sim/input/types';

/** A real frame from the user's Leap Motion Controller (service 5.0.0-preview), abridged. */
const realFrame = readFileSync(new URL('./fixtures/leap-hand-frame.json', import.meta.url), 'utf8');

describe('solid hand from the Leap skeleton', () => {
  const hand = leapFrameToHands(parseLeapMessage(realFrame)!, DEFAULT_LEAP_BOX)[0];
  it('builds finger bones, metacarpals and a forearm', () => {
    // 5 fingers × up to 4 bones (a zero-length thumb metacarpal is skipped) + forearm
    expect(hand.capsules!.length).toBeGreaterThanOrEqual(20); expect(hand.capsules!.length).toBeLessThanOrEqual(21);
    for (const c of hand.capsules!) { expect(c.radius).toBeGreaterThan(0); expect(c.radius).toBeLessThan(.06); expect(Number.isFinite(c.a.x + c.b.y + c.a.z)).toBe(true); }
  });
  it('keeps radii proportional to reported widths and the forearm thickest', () => {
    const radii = hand.capsules!.map(c => c.radius);
    const forearm = hand.capsules![hand.capsules!.length - 1];
    expect(forearm.radius).toBe(Math.max(...radii));
    expect(forearm.radius).toBeCloseTo(56.726025 * .85 / 2 / 600, 6);
  });
  it('cuts the forearm off as a short stub past the wrist', () => {
    const forearm = hand.capsules![hand.capsules!.length - 1];
    const dx = (forearm.b.x - forearm.a.x) * 600, dy = (forearm.b.y - forearm.a.y) * 340, dz = (forearm.b.z - forearm.a.z) * 240; // back to mm
    expect(Math.sqrt(dx * dx + dy * dy + dz * dz)).toBeCloseTo(70, 0);
  });
  it('flows through the mapping and tracker, riding on the smoothed position', () => {
    const t = new HandTracker(LEAP_MAPPING);
    const obs = leapFrameToHands(parseLeapMessage(realFrame)!, DEFAULT_LEAP_BOX);
    for (let i = 0; i < 12; i++) { t.ingest({ source: 'leap', sequence: i, observedAtMs: i * 9, receivedAtMs: i * 9, hands: obs }); t.tick(i * 9); }
    const h = t.tick(110).hands[0];
    expect(h.capsules.length).toBe(obs[0].capsules!.length);
    // A still hand: smoothed == raw, so the capsules are exactly the mapped ones.
    const mapped = mapCapsule(LEAP_MAPPING, obs[0].capsules![0]);
    expect(h.capsules[0].a.x).toBeCloseTo(mapped.a.x, 9); expect(h.capsules[0].radius).toBeCloseTo(mapped.radius, 9);
  });
});

describe('capsule mapping and packing', () => {
  it('scales a capsule radius by the sim x axis interval', () => {
    const m = spaceMappingSchema.parse({ ...SCREEN_MAPPING, x: { from: 'x', low: .25, high: .75, mirror: false } });
    const c = mapCapsule(m, { a: { x: .25, y: 0, z: 0 }, b: { x: .75, y: 1, z: 1 }, radius: .05 });
    expect(c.a.x).toBe(0); expect(c.b.x).toBe(1); expect(c.radius).toBeCloseTo(.1, 9);
  });
  it('packs hands into world-unit capsules with a bounding sphere, and spheres for shapeless hands', () => {
    const base: HandState = { id: 1, position: { x: .5, y: .5, z: .5 }, velocity: { x: 0, y: 0, z: 0 }, speed: 0, extent: { min: { x: .4, y: .4, z: .5 }, max: { x: .6, y: .6, z: .5 } }, radius: .05, openness: 1, pinch: 0, confidence: 1, ageMs: 0, staleMs: 0, push: .5, points: [], capsules: [] };
    const solid: HandState = { ...base, id: 2, capsules: [{ a: { x: .1, y: .5, z: .2 }, b: { x: .3, y: .5, z: .2 }, radius: .02 }, { a: { x: .3, y: .5, z: .2 }, b: { x: .3, y: .7, z: .2 }, radius: .01 }] };
    const packed = packHands([base, solid], 2, 1, createPackedHands());
    expect(packed.count).toBe(3); expect(packed.boundCount).toBe(2);
    const sphere = Array.from(packed.capsules.subarray(0, 4)), want = [1, .5, .5, .1]; // sphere: position × aspect, radius × aspect (float32)
    sphere.forEach((v, i) => expect(v).toBeCloseTo(want[i], 6));
    expect(packed.capsules[8]).toBeCloseTo(.2, 6); expect(packed.capsules[11]).toBeCloseTo(.04, 6);
    const b = packed.bounds.subarray(4, 8);
    for (let i = 1; i < 3; i++) for (const o of [0, 4]) {
      const dx = packed.capsules[i * 8 + o] - b[0], dy = packed.capsules[i * 8 + o + 1] - b[1], dz = packed.capsules[i * 8 + o + 2] - b[2];
      expect(Math.sqrt(dx * dx + dy * dy + dz * dz) + packed.capsules[i * 8 + 3]).toBeLessThanOrEqual(b[3] + 1e-9);
    }
  });
  it('capsule distance is negative inside, zero on the surface, and matches the GLSL definition', () => {
    const a = { x: 0, y: 0, z: 0 }, b = { x: 1, y: 0, z: 0 };
    expect(capsuleDistance({ x: .5, y: 0, z: 0 }, a, b, .1)).toBeCloseTo(-.1, 9);
    expect(capsuleDistance({ x: .5, y: .1, z: 0 }, a, b, .1)).toBeCloseTo(0, 9);
    expect(capsuleDistance({ x: 1.3, y: 0, z: 0 }, a, b, .1)).toBeCloseTo(.2, 9);
    expect(handSdfGlsl(8, 2)).toContain('float handDistance(vec3 p)');
  });
});

describe('synthetic skeleton', () => {
  it('produces a hand-shaped capsule set that curls with openness', async () => {
    const { syntheticHandCapsules } = await import('../../src/sim/input/synthetic');
    const open = syntheticHandCapsules({ x: .5, y: .5, z: .5 }, 1, .05), fist = syntheticHandCapsules({ x: .5, y: .5, z: .5 }, 0, .05);
    expect(open).toHaveLength(1 + 4 * 4 + 2);
    const tipY = (caps: typeof open) => Math.min(...caps.map(c => c.b.y));
    expect(tipY(open)).toBeLessThan(tipY(fist)); // straight fingers reach farther up the image
    for (const c of open) expect(c.radius).toBeGreaterThan(0);
  });
});

describe('depth-camera voxels', () => {
  it('decodes bridge voxels and maps them into the volume with z reversed for the glass', () => {
    const nx = 2, ny = 2, nz = 2, data = new Uint8Array(nx * ny * nz); data[0] = 200; // x0, y0 (top), z0 (nearest the camera)
    const b64 = btoa(String.fromCharCode(...data));
    const hello = parseBridgeMessage(JSON.stringify({ type: 'hello', version: 1, source: 'synthetic', box: { x: [0, 1], y: [0, 1], z: [0, 1] }, voxels: { nx, ny, nz } }));
    const frame = parseBridgeMessage(JSON.stringify({ type: 'frame', seq: 1, t: 0, hands: [], voxels: b64 }));
    const input = bridgeFrameToInput(frame as never, 0, 0, hello as never);
    expect(input.voxels?.data[0]).toBe(200);
    expect(() => decodeVoxels(b64, 3, 2, 2)).toThrow();
    // Depth mapping mirrors x and flips y (image down → sim up); z keeps its direction (nearest camera = glass).
    const field = mapVoxels({ x: { from: 'x', low: 0, high: 1, mirror: true }, y: { from: 'y', low: 1, high: 0, mirror: false }, z: { from: 'z', low: 0, high: 1, mirror: false } }, input.voxels!, 2, 2, 2);
    expect(field.data[(0 * 2 + 1) * 2 + 1]).toBe(200); // z0, top row → sim y1, mirrored x → x1
  });
  it('the tracker exposes and expires the volume', () => {
    const t = new HandTracker(SCREEN_MAPPING);
    t.ingest({ source: 'depth', sequence: 0, observedAtMs: 0, receivedAtMs: 0, hands: [], voxels: { nx: 1, nz: 1, ny: 1, data: new Uint8Array([9]) } });
    expect(t.tick(0).volume?.data.some(v => v === 9)).toBe(true);
    expect(t.tick(5000).volume).toBeNull();
  });
});
