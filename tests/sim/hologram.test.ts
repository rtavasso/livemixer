import { describe, expect, it } from 'vitest';
import { applyAffine, fitHologram, hologramFingertip, rectifyObservation, rectifySurface, type HologramPair } from '../../src/sim/input/hologram';
import { HOLOGRAM_FLOOR_MAPPING } from '../../src/sim/input/mapping';
import type { DepthSurface, HandObservation } from '../../src/sim/input/types';
import type { Vec3 } from '../../src/sim/core/types';

const v = (x: number, y: number, z: number): Vec3 => ({ x, y, z });
const add = (a: Vec3, b: Vec3, s = 1): Vec3 => v(a.x + b.x * s, a.y + b.y * s, a.z + b.z * s);
const near = (a: Vec3, b: Vec3, tol = 1e-6) => { expect(a.x).toBeCloseTo(b.x, -Math.log10(tol)); expect(a.y).toBeCloseTo(b.y, -Math.log10(tol)); expect(a.z).toBeCloseTo(b.z, -Math.log10(tol)); };

/**
 * A synthetic installation: the hologram plane sits in the source box with origin `o`, screen-right
 * axis `ex` (source units per full screen width) and screen-down axis `ey`; the viewer is along `n`.
 */
function installation(o: Vec3, ex: Vec3, ey: Vec3, n: Vec3) {
  const touch = (sx: number, sy: number) => add(add(o, ex, sx), ey, sy);
  const targets: { x: number; y: number }[] = [];
  for (const y of [.15, .5, .85]) for (const x of [.15, .5, .85]) targets.push({ x, y });
  const pairs: HologramPair[] = targets.map(t => ({ screen: t, point: touch(t.x, t.y) }));
  return { touch, pairs, pullBack: add(touch(.85, .85), n, .2) };
}

describe('fitHologram', () => {
  it('recovers an axis-aligned plane exactly', () => {
    const inst = installation(v(.1, .9, .6), v(.8, 0, 0), v(0, -.6, 0), v(0, 0, -1));
    const fit = fitHologram(inst.pairs, inst.pullBack);
    expect(fit.rmsError).toBeLessThan(1e-9);
    near(applyAffine(fit.affine, inst.touch(.3, .7)), v(.3, .7, 0));
    near(applyAffine(fit.affine, inst.pullBack), v(.85, .85, 1));
    near(applyAffine(fit.affine, add(inst.touch(.5, .5), v(0, 0, -1), .1)), v(.5, .5, .5));
  });

  it('recovers a rotated and tilted plane, and depth stays perpendicular to it', () => {
    // 20° yaw about the height axis, 8° tilt, viewer on the -w side.
    const yaw = 20 * Math.PI / 180, tilt = 8 * Math.PI / 180;
    const ex = v(.7 * Math.cos(yaw), 0, .7 * Math.sin(yaw));
    const ey = v(-.5 * Math.sin(tilt) * Math.sin(yaw), -.5 * Math.cos(tilt), .5 * Math.sin(tilt) * Math.cos(yaw));
    // n = ex × ey normalized, pointing to the viewer
    const cx = ex.y * ey.z - ex.z * ey.y, cy = ex.z * ey.x - ex.x * ey.z, cz = ex.x * ey.y - ex.y * ey.x;
    const len = Math.hypot(cx, cy, cz); let n = v(cx / len, cy / len, cz / len); if (n.z > 0) n = v(-n.x, -n.y, -n.z);
    const inst = installation(v(.15, .85, .7), ex, ey, n);
    const fit = fitHologram(inst.pairs, inst.pullBack);
    expect(fit.rmsError).toBeLessThan(1e-9);
    near(applyAffine(fit.affine, inst.touch(.2, .4)), v(.2, .4, 0));
    near(applyAffine(fit.affine, inst.pullBack), v(.85, .85, 1));
    // A point moved along the normal keeps its screen position.
    near(applyAffine(fit.affine, add(inst.touch(.6, .3), n, .1)), v(.6, .3, .5));
    // Behind the plane is negative.
    expect(applyAffine(fit.affine, add(inst.touch(.6, .3), n, -.05)).z).toBeCloseTo(-.25, 6);
  });

  it('reports the residual of a bad capture and tolerates noise', () => {
    const inst = installation(v(.1, .9, .6), v(.8, 0, 0), v(0, -.6, 0), v(0, 0, -1));
    const pairs = inst.pairs.map((p, i) => i === 4 ? { ...p, point: add(p.point, v(.05, .05, 0)) } : p);
    const fit = fitHologram(pairs, inst.pullBack);
    expect(fit.residuals[4]).toBeGreaterThan(Math.max(...fit.residuals.filter((_, i) => i !== 4)) * 3);
    expect(fit.rmsError).toBeGreaterThan(.01);
    expect(fit.rmsError).toBeLessThan(.05);
  });

  it('uses a default depth span without a pull-back capture, oriented toward the hint', () => {
    const inst = installation(v(.1, .9, .6), v(.8, 0, 0), v(0, -.6, 0), v(0, 0, -1));
    const fit = fitHologram(inst.pairs, undefined, { viewer: v(.5, .5, 0), depthSpan: .25 });
    near(applyAffine(fit.affine, add(inst.touch(.5, .5), v(0, 0, -1), .25)), v(.5, .5, 1));
  });

  it('rejects too few or collinear captures', () => {
    const inst = installation(v(.1, .9, .6), v(.8, 0, 0), v(0, -.6, 0), v(0, 0, -1));
    expect(() => fitHologram(inst.pairs.slice(0, 3), inst.pullBack)).toThrow(/at least 4/);
    const line = [.1, .3, .5, .7].map(x => ({ screen: { x, y: .5 }, point: inst.touch(x, .5) }));
    expect(() => fitHologram(line, inst.pullBack)).toThrow(/spread/);
  });
});

describe('rectifyObservation / rectifySurface', () => {
  const inst = installation(v(.1, .9, .6), v(.8, 0, 0), v(0, -.6, 0), v(0, 0, -1));
  const fit = fitHologram(inst.pairs, inst.pullBack);

  it('carries position, extent, points and capsules through the affine', () => {
    const o: HandObservation = {
      id: 1, confidence: 1, position: inst.touch(.5, .5),
      extent: { min: add(inst.touch(.4, .4), v(0, 0, -1), .1), max: inst.touch(.6, .6) },
      points: [inst.touch(.25, .25)],
      capsules: [{ a: inst.touch(.5, .5), b: add(inst.touch(.5, .5), v(0, 0, -1), .2), radius: .08 }],
    };
    const r = rectifyObservation(fit.affine, o);
    near(r.position, v(.5, .5, 0));
    near(r.extent!.min, v(.4, .4, 0)); near(r.extent!.max, v(.6, .6, .5));
    near(r.points![0], v(.25, .25, 0));
    near(r.capsules![0].b, v(.5, .5, 1));
    expect(r.capsules![0].radius).toBeCloseTo(.08 / .8, 6); // a source-u radius in screen-x units
  });

  it('re-projects a finger touching the hologram into a footprint at the touch point, at height 0', () => {
    // The source scan is the front view: columns = u, rows = v (0 = top), value = w. A finger 0.2 deep
    // along -w touches the plane at screen (.3, .7).
    const sw = 40, sh = 30, data = new Uint8Array(sw * sh);
    const tip = inst.touch(.3, .7);
    const col = Math.floor(tip.x * sw), tipRow = Math.floor(tip.y * sh);
    // The tip cell touches the plane (w = .6); the finger runs up the image from it, each cell nearer the viewer.
    for (let k = 0; k < 8; k++) { const w = .6 - .025 * k, row = tipRow - k; if (row >= 0) data[row * sw + col] = 1 + Math.round(254 * w); }
    const surface: DepthSurface = { width: sw, height: sh, data };
    const field = rectifySurface(fit.affine, HOLOGRAM_FLOOR_MAPPING, surface, 40, 20);
    expect(field).not.toBeNull();
    // Sim y is the distance from the plane; the touching cell lands in the bottom row at sim x ≈ .3 with sim z ≈ 1 - .7.
    let bottomFilled = 0, bottomX = -1, bottomZ = -1;
    for (let col = 0; col < 40; col++) if (field!.mask[col]) { bottomFilled++; bottomX = (col + .5) / 40; bottomZ = field!.z[col]; }
    expect(bottomFilled).toBe(1);
    expect(bottomX).toBeCloseTo(.3, 1);
    expect(bottomZ).toBeCloseTo(.3, 1);
    // Cells further from the plane (higher rows) are filled where the finger was, and nothing else.
    let total = 0; for (let i = 0; i < field!.mask.length; i++) if (field!.mask[i]) total++;
    expect(total).toBeGreaterThanOrEqual(4);
    expect(total).toBeLessThan(40);
  });
});

describe('hologramFingertip', () => {
  it('prefers the skeleton palm, else the scan cell nearest the hologram side, else the hand position', () => {
    // Not the index tip: the tracker guesses an occluded fingertip and it jumps between poses from touch to touch.
    const skeleton: HandObservation = { id: 1, confidence: 1, position: v(.55, .45, .6), points: [v(.55, .45, .6), v(.4, .4, .6), v(.45, .3, .7)], capsules: [{ a: v(0, 0, 0), b: v(1, 1, 1), radius: .1 }] };
    near(hologramFingertip({ hands: [skeleton] }, 'far')!, v(.55, .45, .6));
    const sw = 10, sh = 10, data = new Uint8Array(sw * sh);
    data[5 * sw + 5] = 1 + Math.round(254 * .9); data[6 * sw + 5] = 1 + Math.round(254 * .5); data[7 * sw + 5] = 1 + Math.round(254 * .2);
    const blob: HandObservation = { id: 2, confidence: 1, position: v(.5, .6, .5) };
    const far = hologramFingertip({ hands: [blob], surface: { width: sw, height: sh, data } }, 'far')!;
    expect(far.z).toBeCloseTo(.9, 2); expect(far.y).toBeCloseTo(.55, 2);
    const nearSide = hologramFingertip({ hands: [blob], surface: { width: sw, height: sh, data } }, 'near')!;
    expect(nearSide.z).toBeCloseTo(.2, 2);
    near(hologramFingertip({ hands: [blob] }, 'far')!, v(.5, .6, .5));
    expect(hologramFingertip({ hands: [] }, 'far')).toBeNull();
  });
});
