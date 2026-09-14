import { describe, expect, it } from 'vitest';
import { HandTracker } from '../../src/sim/input/conditioning';
import { DEPTH_MAPPING, IMAGE_MAPPING, mapSurface, SCREEN_MAPPING, spaceMappingSchema } from '../../src/sim/input/mapping';
import { bridgeFrameToInput, decodeSurface, parseBridgeMessage, surfaceByteToDepth } from '../../src/sim/input/protocol';
import { surfaceFromCapsules, syntheticHandCapsules, SyntheticSource } from '../../src/sim/input/synthetic';
import { sampleSurface, surfaceContains, surfaceDepthAt, surfaceGlsl, surfaceNormalAt } from '../../src/sim/gl/surface';
import type { DepthSurface, InputFrame } from '../../src/sim/input/types';

/** A 4×3 scan: one filled cell at the top-left with the nearest depth, one at the bottom-right far away. */
const scan = (): DepthSurface => { const data = new Uint8Array(12); data[0] = 1; data[11] = 255; return { width: 4, height: 3, data }; };

describe('depth surface mapping', () => {
  it('turns bytes into depths and flips image rows into sim rows', () => {
    expect(surfaceByteToDepth(0)).toBeNull(); expect(surfaceByteToDepth(1)).toBe(0); expect(surfaceByteToDepth(255)).toBe(1);
    const field = mapSurface(SCREEN_MAPPING, scan(), 4, 3)!;
    expect(field.mask[2 * 4 + 0]).toBe(255); expect(field.z[2 * 4 + 0]).toBe(0);      // top-left of the image = top row of sim space, nearest = glass
    expect(field.mask[0 * 4 + 3]).toBe(255); expect(field.z[0 * 4 + 3]).toBe(1);      // bottom-right, farthest = back wall
    expect(field.mask[1 * 4 + 1]).toBe(0); expect(field.z[1 * 4 + 1]).toBe(1);        // empty cells carry no depth
  });
  it('mirrors with the depth mapping and honours the z interval', () => {
    const mirrored = mapSurface(DEPTH_MAPPING, scan(), 4, 3)!;
    expect(mirrored.mask[2 * 4 + 3]).toBe(255);                                        // x mirrored
    const shallow = mapSurface(spaceMappingSchema.parse({ ...IMAGE_MAPPING, z: { from: 'z', low: 0, high: .5, mirror: false } }), scan(), 4, 3)!;
    expect(shallow.z[0 * 4 + 0]).toBe(1);                                              // far cell clamps to the back wall
  });
  it('refuses an axis swap, which cannot be a height field over the front face', () => {
    expect(mapSurface(spaceMappingSchema.parse({ ...SCREEN_MAPPING, x: { from: 'z', low: 0, high: 1, mirror: false } }), scan(), 4, 3)).toBeNull();
  });
  it('flows through the bridge protocol and the tracker, and expires', () => {
    const hello = parseBridgeMessage(JSON.stringify({ type: 'hello', version: 1, source: 'synthetic', box: { x: [0, 1], y: [0, 1], z: [0, 1] }, surface: { width: 4, height: 3 } }));
    const frame = parseBridgeMessage(JSON.stringify({ type: 'frame', seq: 1, t: 0, hands: [], surface: btoa(String.fromCharCode(...scan().data)) }));
    const input = bridgeFrameToInput(frame as never, 0, 0, hello as never);
    expect(input.surface?.data[11]).toBe(255);
    expect(() => decodeSurface('AAAA', 4, 3)).toThrow();
    const t = new HandTracker(DEPTH_MAPPING);
    t.ingest(input);
    expect(t.tick(0).surface?.mask.some(m => m === 255)).toBe(true);
    expect(t.tick(5000).surface).toBeNull();
  });
});

describe('surface sampling', () => {
  const field = mapSurface(SCREEN_MAPPING, scan(), 4, 3)!;
  it('samples depth without letting empty neighbours pull it, and reports containment', () => {
    const s = sampleSurface(field, .125, 5 / 6); // centre of the top-left cell
    expect(s.mask).toBeCloseTo(1, 6); expect(s.z).toBeCloseTo(0, 6);
    expect(surfaceDepthAt(field, .5, .5)).toBeNull();
    expect(surfaceContains(field, { x: .125, y: 5 / 6, z: .05 }, .1)).toBe(true);
    expect(surfaceContains(field, { x: .125, y: 5 / 6, z: .5 }, .1)).toBe(false);
  });
  it('normals point toward the glass on a flat scan and tilt on a slope', () => {
    const flat: DepthSurface = { width: 4, height: 4, data: new Uint8Array(16).fill(128) };
    const f = mapSurface(SCREEN_MAPPING, flat, 4, 4)!;
    const n = surfaceNormalAt(f, .5, .5, 16 / 9, 1);
    expect(n.z).toBeCloseTo(-1, 6);
    const slope: DepthSurface = { width: 4, height: 4, data: new Uint8Array(16) };
    for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) slope.data[r * 4 + c] = 1 + c * 60;
    const ns = surfaceNormalAt(mapSurface(SCREEN_MAPPING, slope, 4, 4)!, .5, .5, 1, 1);
    expect(ns.x).toBeGreaterThan(0); expect(ns.z).toBeLessThan(0);
    expect(surfaceGlsl()).toContain('vec4 surfaceHit(vec3 ro, vec3 rd, float depth, int steps)');
  });
});

describe('synthetic scan', () => {
  it('scans the skeleton into a shell whose nearest points sit in front of the capsule axes', () => {
    const caps = syntheticHandCapsules({ x: .5, y: .5, z: .5 }, 1, .06);
    const s = surfaceFromCapsules(caps, 64, 48);
    const filled = Array.from(s.data).filter(v => v > 0);
    expect(filled.length).toBeGreaterThan(50);
    const nearest = Math.min(...filled.map(v => surfaceByteToDepth(v)!));
    expect(nearest).toBeLessThan(.5); expect(nearest).toBeGreaterThan(.3); // in front of z = .5 by at most a radius
  });
  it('the synthetic source emits a surface frame', () => {
    const frames: InputFrame[] = [];
    const src = new SyntheticSource(f => frames.push(f)); void src.start(); src.sample(0); src.sample(500);
    expect(frames[1].surface?.width).toBe(128); expect(Array.from(frames[1].surface!.data).some(v => v > 0)).toBe(true);
  });
});
