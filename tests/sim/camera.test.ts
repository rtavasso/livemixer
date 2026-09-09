import { describe, expect, it } from 'vitest';
import { DEFAULT_EYE, fromWorld, mat4LookAt, mat4Multiply, mat4Perspective, ndcToPixels, toWorld, transformPoint, windowCamera } from '../../src/sim/core/camera';
import { toUniform3 } from '../../src/sim/core/math';

describe('window camera', () => {
  const aspect = 16 / 9, depth = 1, eye = DEFAULT_EYE;
  const cam = windowCamera(aspect, depth, eye);
  it('maps the front face exactly onto the screen', () => {
    for (const [x, y, ex, ey] of [[0, 0, -1, -1], [aspect, 1, 1, 1], [aspect / 2, .5, 0, 0], [0, 1, -1, 1]] as const) {
      const p = cam.project({ x, y, z: 0 });
      expect(p.x).toBeCloseTo(ex, 9); expect(p.y).toBeCloseTo(ey, 9); expect(p.scale).toBe(1);
    }
  });
  it('shrinks deeper points toward the centre by eye / (eye + z)', () => {
    const front = cam.project({ x: aspect, y: 1, z: 0 }), back = cam.project({ x: aspect, y: 1, z: depth });
    const s = eye / (eye + depth);
    expect(back.x).toBeCloseTo(front.x * s, 9); expect(back.y).toBeCloseTo(front.y * s, 9); expect(cam.scale(depth)).toBeCloseTo(s, 9);
    expect(back.ndcZ).toBeGreaterThan(front.ndcZ); // farther = larger depth value
    expect(Math.abs(cam.project({ x: aspect / 2, y: .5, z: depth }).x)).toBeLessThan(1e-9); // the centre stays put
  });
  it('the matrix agrees with project() after the perspective divide', () => {
    for (const p of [{ x: .3, y: .8, z: .2 }, { x: 1.5, y: .1, z: .9 }, { x: 0, y: 0, z: 0 }]) {
      const c = transformPoint(cam.matrix, p), q = cam.project(p);
      // The matrix is float32 for WebGL; project() is float64.
      expect(c.x / c.w).toBeCloseTo(q.x, 5); expect(c.y / c.w).toBeCloseTo(q.y, 5); expect(c.z / c.w).toBeCloseTo(q.ndcZ, 5); expect(c.w).toBeCloseTo(p.z + eye, 5);
    }
  });
  it('a raised eye keeps the front face fixed and lifts deeper points', () => {
    const raised = windowCamera(aspect, depth, eye, undefined, undefined, 1.1);
    for (const [x, y] of [[0, 0], [aspect, 1], [.4, .5]] as const) { const a = raised.project({ x, y, z: 0 }), b = cam.project({ x, y, z: 0 }); expect(a.x).toBeCloseTo(b.x, 9); expect(a.y).toBeCloseTo(b.y, 9); }
    const floorFar = raised.project({ x: aspect / 2, y: 0, z: depth }), floorFarCentred = cam.project({ x: aspect / 2, y: 0, z: depth });
    expect(floorFar.y).toBeGreaterThan(floorFarCentred.y); // the floor is seen from above, not edge-on
    const c = transformPoint(raised.matrix, { x: .7, y: .2, z: .6 }), q = raised.project({ x: .7, y: .2, z: .6 });
    expect(c.y / c.w).toBeCloseTo(q.y, 5);
  });
  it('world conversions round-trip and match toUniform3', () => {
    const sim = { x: .25, y: .5, z: .75 };
    const world = toWorld(sim, aspect, 1.5);
    expect(world).toEqual(toUniform3(sim, aspect, 1.5)); expect(fromWorld(world, aspect, 1.5)).toEqual(sim);
    expect(ndcToPixels(-1, -1, 1280, 720)).toEqual({ x: 0, y: 0 }); expect(ndcToPixels(1, 1, 1280, 720)).toEqual({ x: 1280, y: 720 });
  });
});

describe('mat4 kit', () => {
  it('look-at plus perspective puts a point in front of the camera at the screen centre', () => {
    const view = mat4LookAt({ x: 0, y: 0, z: 5 }, { x: 0, y: 0, z: 0 }, { x: 0, y: 1, z: 0 });
    const proj = mat4Perspective(Math.PI / 3, 1, .1, 100);
    const c = transformPoint(mat4Multiply(proj, view), { x: 0, y: 0, z: 0 });
    expect(c.x / c.w).toBeCloseTo(0, 9); expect(c.y / c.w).toBeCloseTo(0, 9); expect(c.w).toBeCloseTo(5, 9);
    const right = transformPoint(mat4Multiply(proj, view), { x: 1, y: 0, z: 0 });
    expect(right.x / right.w).toBeGreaterThan(0);
    const up = transformPoint(mat4Multiply(proj, view), { x: 0, y: 1, z: 0 });
    expect(up.y / up.w).toBeGreaterThan(0);
  });
});
