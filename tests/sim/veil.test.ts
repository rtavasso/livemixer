import { describe, expect, it } from 'vitest';
import { CAPSULE_STRIDE, Cloth, COLLIDER_STRIDE, type ColliderPack, CONTACT_SKIN, lateralDisplacement, MAX_COLLIDER_CAPSULES, MAX_COLLIDERS, NO_COLLIDERS, type ClothStepParams } from '../../src/sim/sims/veil/cloth';
import { CAPSULE_PAD, type ColliderHand, HandColliders, handRadius, RADIUS_MAX, RADIUS_PAD, strengthEase } from '../../src/sim/sims/veil/colliders';
import { SCAN_SLOPE_MAX, SCAN_THICKNESS, ScanShell } from '../../src/sim/sims/veil/scan';
import { WindField } from '../../src/sim/sims/veil/wind';
import { DEFAULT_EYE, windowCamera } from '../../src/sim/core/camera';
import type { SurfaceField } from '../../src/sim/core/types';
import { createPackedHands } from '../../src/sim/gl/hand';
import { sampleSurface, surfaceNormalAt } from '../../src/sim/gl/surface';
import { syntheticHandCapsules } from '../../src/sim/input/synthetic';
import veil, { layoutFor } from '../../src/sim/sims/veil';

const ASPECT = 16 / 9;
const DT = 1 / 60;
const PARAMS: ClothStepParams = { gravity: 3.25, damping: 1.2, stiffness: .6, dragNormal: 3, dragTangent: .8, friction: .5, substeps: 2, iterations: 2 };

function makeCloth(seed = 11) {
  return new Cloth({ cols: 24, rows: 36, rodX0: .08 * ASPECT, rodX1: .92 * ASPECT, top: 1.03, length: .99, gather: 1.22, folds: 6, seed });
}
const allFinite = (a: ArrayLike<number>) => { for (let i = 0; i < a.length; i++) if (!Number.isFinite(a[i])) return false; return true; };
function hemY(cloth: Cloth) { let y = 0; for (let c = 0; c < cloth.cols; c++) y += cloth.pos[((cloth.rows - 1) * cloth.cols + c) * 3 + 1]; return y / cloth.cols; }
function minZ(cloth: Cloth) { let z = Infinity; for (let i = 0; i < cloth.count; i++) z = Math.min(z, cloth.pos[i * 3 + 2]); return z; }

/** A collider pack with room for MAX_COLLIDERS hands, each with its own run of capsule slots (the layout `HandColliders` uses). */
function makePack(): ColliderPack {
  return { hands: new Float32Array(COLLIDER_STRIDE * MAX_COLLIDERS), count: 0, capsules: new Float32Array(CAPSULE_STRIDE * MAX_COLLIDER_CAPSULES * MAX_COLLIDERS) };
}
/** Hand `slot` as a single sphere: a capsule with coincident ends, its own bounding sphere. */
function setSphere(pack: ColliderPack, slot: number, x: number, y: number, z: number, r: number, vx = 0, vy = 0, vz = 0, strength = 1) {
  const first = slot * MAX_COLLIDER_CAPSULES;
  pack.hands.set([x, y, z, r, vx, vy, vz, strength, first, 1, 0, 0], slot * COLLIDER_STRIDE);
  pack.capsules.set([x, y, z, r, x, y, z, r], first * CAPSULE_STRIDE);
  pack.count = Math.max(pack.count, slot + 1);
}
/** Hand `slot` as capsules [ax, ay, az, bx, by, bz, r] with the bounding sphere computed the way the collider table does. */
function setCapsules(pack: ColliderPack, slot: number, caps: number[][], vx = 0, vy = 0, vz = 0, strength = 1) {
  const first = slot * MAX_COLLIDER_CAPSULES;
  let sx = 0, sy = 0, sz = 0;
  caps.forEach(([ax, ay, az, bx, by, bz, r], k) => { pack.capsules.set([ax, ay, az, r, bx, by, bz, r], (first + k) * CAPSULE_STRIDE); sx += ax + bx; sy += ay + by; sz += az + bz; });
  const m = 2 * caps.length, cx = sx / m, cy = sy / m, cz = sz / m;
  let R = 0;
  for (const [ax, ay, az, bx, by, bz, r] of caps) R = Math.max(R, Math.hypot(ax - cx, ay - cy, az - cz) + r, Math.hypot(bx - cx, by - cy, bz - cz) + r);
  pack.hands.set([cx, cy, cz, R, vx, vy, vz, strength, first, caps.length, 1, 0], slot * COLLIDER_STRIDE);
  pack.count = Math.max(pack.count, slot + 1);
}
const settled = () => { const c = makeCloth(); for (let i = 0; i < 200; i++) c.step(DT, PARAMS, NO_COLLIDERS); return c; };

describe('veil cloth solver', () => {
  it('settles under gravity without NaN over 600 steps and hangs to its rest length', () => {
    const cloth = makeCloth();
    for (let i = 0; i < 600; i++) cloth.step(DT, PARAMS, NO_COLLIDERS);
    expect(allFinite(cloth.pos)).toBe(true);
    expect(allFinite(cloth.normal)).toBe(true);
    // The hem hangs at rod height minus the fabric length (the long-range attachment forbids sag beyond it).
    expect(hemY(cloth)).toBeGreaterThan(1.03 - .99 - .01);
    expect(hemY(cloth)).toBeLessThan(1.03 - .99 + .03);
    // Top row stays pinned to the rod.
    for (let c = 0; c < cloth.cols; c++) { expect(cloth.pos[c * 3 + 1]).toBe(1.03); expect(cloth.pos[c * 3 + 2]).toBe(0); }
    expect(cloth.meanSpeed).toBeLessThan(.02);
    expect(Math.abs(cloth.meanZ)).toBeLessThan(.05);
  });

  it('keeps constraint strain small once settled', () => {
    const cloth = makeCloth();
    for (let i = 0; i < 400; i++) cloth.step(DT, PARAMS, NO_COLLIDERS);
    expect(cloth.meanStrain).toBeLessThan(.05);
    // The gathered sheet folds: it must not be flat, and the folds are of a sane amplitude.
    let zMax = 0; for (let i = 0; i < cloth.count; i++) zMax = Math.max(zMax, Math.abs(cloth.pos[i * 3 + 2]));
    expect(zMax).toBeGreaterThan(.01); expect(zMax).toBeLessThan(.2);
  });

  it('pushes points out of a sphere collider and never leaves any inside after a step', () => {
    const cloth = settled();
    const before = Float64Array.from(cloth.pos);
    const pack = makePack();
    const cx = ASPECT * .5, cy = .5, cz = -.02, r = .16;
    setSphere(pack, 0, cx, cy, cz, r);
    for (let i = 0; i < 90; i++) { cloth.step(DT, PARAMS, pack); expect(cloth.anyInside(pack)).toBe(false); }
    expect(allFinite(cloth.pos)).toBe(true);
    // Points near the sphere were displaced (mostly toward the viewer, off the sphere's front).
    let moved = 0, maxDz = 0;
    for (let i = 0; i < cloth.count; i++) { const dz = cloth.pos[i * 3 + 2] - before[i * 3 + 2]; if (Math.abs(dz) > .01) moved++; maxDz = Math.max(maxDz, dz); }
    expect(moved).toBeGreaterThan(10);
    expect(maxDz).toBeGreaterThan(.05);
    expect(cloth.contactFraction).toBeGreaterThan(.02);
    expect(cloth.contactFraction).toBeLessThanOrEqual(1);
    // A moving hand drags fabric along: the fabric ahead of and around it picks up its lateral velocity.
    let x = cx;
    let xBefore = 0; for (let i = 0; i < cloth.count; i++) xBefore += cloth.pos[i * 3];
    for (let i = 0; i < 10; i++) { x += 1.2 * DT; setSphere(pack, 0, x, cy, cz, r, 1.2, 0, 0); cloth.step(DT, PARAMS, pack); expect(cloth.anyInside(pack)).toBe(false); }
    let xAfter = 0; for (let i = 0; i < cloth.count; i++) xAfter += cloth.pos[i * 3];
    expect(xAfter).toBeGreaterThan(xBefore);
    // Hand leaves: the collider fades and the sheet settles without blowing up.
    let strength = 1;
    for (let i = 0; i < 240; i++) { strength = Math.max(0, strength - DT / .25); setSphere(pack, 0, x, cy, cz, r, 1.2, 0, 0, strength); cloth.step(DT, PARAMS, pack); }
    expect(allFinite(cloth.pos)).toBe(true);
    expect(cloth.contactFraction).toBe(0);
    expect(cloth.meanSpeed).toBeLessThan(.15);
  });

  it('never lets a hand push fabric below the floor', () => {
    const cloth = settled();
    const pack = makePack();
    // A sphere straddling the hem, pressing down and back.
    let y = .08;
    for (let i = 0; i < 60; i++) {
      y = Math.max(-.1, y - .6 * DT);
      setSphere(pack, 0, ASPECT * .5, y, .02, .16, 0, -.6, 0);
      cloth.step(DT, PARAMS, pack);
      let lowest = Infinity; for (let p = 0; p < cloth.count; p++) lowest = Math.min(lowest, cloth.pos[p * 3 + 1]);
      expect(lowest).toBeGreaterThanOrEqual(cloth.floor);
    }
    expect(cloth.floor).toBe(0);
    expect(allFinite(cloth.pos)).toBe(true);
  });

  it('is moved by wind toward the viewer', () => {
    const still = makeCloth(), windy = makeCloth();
    for (let i = 0; i < 200; i++) { still.step(DT, PARAMS, NO_COLLIDERS); windy.step(DT, PARAMS, NO_COLLIDERS); }
    for (let i = 0; i < windy.wind.length; i += 3) { windy.wind[i] = .05; windy.wind[i + 1] = 0; windy.wind[i + 2] = .5; }
    for (let i = 0; i < 240; i++) { still.step(DT, PARAMS, NO_COLLIDERS); windy.step(DT, PARAMS, NO_COLLIDERS); }
    expect(windy.meanZ - still.meanZ).toBeGreaterThan(.03);
    expect(windy.meanSpeed).toBeGreaterThan(0);
    expect(allFinite(windy.pos)).toBe(true);
    // The hem must still be within reach of the rod (no stretching).
    for (let c = 0; c < windy.cols; c++) {
      const i = ((windy.rows - 1) * windy.cols + c) * 3, a = c * 3;
      expect(Math.hypot(windy.pos[i] - windy.pos[a], windy.pos[i + 1] - windy.pos[a + 1], windy.pos[i + 2] - windy.pos[a + 2])).toBeLessThanOrEqual(.99 + 1e-6);
    }
  });

  it('is deterministic: identical inputs give identical positions', () => {
    const a = makeCloth(5), b = makeCloth(5);
    const windA = new WindField({ cols: a.windCols, rows: a.windRows, seed: 7 }), windB = new WindField({ cols: b.windCols, rows: b.windRows, seed: 7 });
    const pack = makePack();
    for (let i = 0; i < 300; i++) {
      const t = (i + 1) * DT;
      setSphere(pack, 0, ASPECT * .5 + .3 * Math.sin(t), .5, .05 - .2 * Math.max(0, Math.sin(t * 2)), .15, .3 * Math.cos(t), 0, 0, Math.min(1, t));
      const u = { time: t, dt: DT, wind: .4, gustiness: .6, turbulence: .2, x0: a.rodX0, x1: a.rodX1, top: 1.03, length: .99 };
      if (windA.update(u)) a.wind.set(windA.data);
      if (windB.update(u)) b.wind.set(windB.data);
      a.step(DT, PARAMS, pack); b.step(DT, PARAMS, pack);
    }
    expect(a.pos).toEqual(b.pos);
    expect(a.meanStrain).toBe(b.meanStrain);
    expect(windA.gust).toBe(windB.gust);
    expect(windA.data).toEqual(windB.data);
    expect(windA.gust).toBeGreaterThanOrEqual(0); expect(windA.gust).toBeLessThanOrEqual(1);
    // Different seeds fold differently.
    expect(makeCloth(6).pos).not.toEqual(makeCloth(5).pos);
  });

  it('wind field is bounded and gustless when gustiness is zero', () => {
    const wind = new WindField({ cols: 7, rows: 9, seed: 3, stride: 1 });
    let maxSpeed = 0;
    for (let i = 0; i < 600; i++) {
      wind.update({ time: i * DT, dt: DT, wind: 1, gustiness: 0, turbulence: 1, x0: 0, x1: ASPECT, top: 1.03, length: .99 });
      expect(wind.gust).toBe(0);
      for (let k = 0; k < wind.data.length; k += 3) maxSpeed = Math.max(maxSpeed, Math.hypot(wind.data[k], wind.data[k + 1], wind.data[k + 2]));
    }
    expect(maxSpeed).toBeGreaterThan(.1); expect(maxSpeed).toBeLessThan(3);
    expect(allFinite(wind.data)).toBe(true);
  });

  it('collider skin counts as contact but does not displace untouched fabric', () => {
    const cloth = settled();
    const before = Float64Array.from(cloth.pos);
    const pack = makePack();
    // Sphere hovering in front: its surface is inside the skin distance of the sheet but does not intersect it.
    setSphere(pack, 0, ASPECT * .5, .5, .12 + CONTACT_SKIN * .5, .12);
    cloth.step(DT, PARAMS, pack);
    expect(cloth.contactFraction).toBeGreaterThan(0);
    let maxMove = 0; for (let i = 0; i < cloth.count; i++) maxMove = Math.max(maxMove, Math.abs(cloth.pos[i * 3 + 2] - before[i * 3 + 2]));
    expect(maxMove).toBeLessThan(.02);
  });

  it('reflows with the rod on setExtent, so strain and sway are back at their resting levels after a short settle', () => {
    const cloth = settled();
    const maxDx = () => { let m = 0; for (let i = 0; i < cloth.count; i++) m = Math.max(m, Math.abs(cloth.pos[i * 3] - cloth.restX[i])); return m; };
    const strainBefore = cloth.meanStrain, dxBefore = cloth.meanAbsDx, hemBefore = hemY(cloth);
    // The resting sheet's own lateral fold offset; a point is never further than this from its column.
    const foldOffset = maxDx();
    // 16:9 → 4:3 shrinks the rod span by a quarter (the sheet would otherwise have to swing ~0.4 units), then back.
    for (const aspect of [4 / 3, 16 / 9]) {
      const x0 = .08 * aspect, x1 = .92 * aspect;
      cloth.setExtent(x0, x1);
      expect(cloth.rodX0).toBe(x0); expect(cloth.rodX1).toBe(x1);
      // Pins sit exactly on the new rod and every point already hangs near its new column (only the fold offset,
      // scaled with the span): no sideways swing to come.
      for (let c = 0; c < cloth.cols; c++) { expect(cloth.pos[c * 3]).toBeCloseTo(x0 + (x1 - x0) * c / (cloth.cols - 1), 12); expect(cloth.pos[c * 3 + 1]).toBe(1.03); expect(cloth.pos[c * 3 + 2]).toBe(0); }
      expect(maxDx()).toBeLessThan(foldOffset * 1.3 + .01);
      expect(maxDx()).toBeLessThan(.2);
      // A single step (what the first frame after a resize sees) is already close to the resting strain: no tension spike.
      cloth.step(DT, PARAMS, NO_COLLIDERS);
      expect(cloth.meanStrain).toBeLessThan(strainBefore * 1.5 + .002);
      // The host resettles for 30 steps before retaking its baselines; by then both are back where they were.
      for (let i = 0; i < 29; i++) cloth.step(DT, PARAMS, NO_COLLIDERS);
      expect(allFinite(cloth.pos)).toBe(true);
      expect(cloth.meanStrain).toBeLessThan(strainBefore * 1.5 + .002);
      expect(cloth.meanAbsDx).toBeLessThan(dxBefore * 1.5 + .005);
      expect(Math.abs(hemY(cloth) - hemBefore)).toBeLessThan(.02);
      expect(cloth.meanSpeed).toBeLessThan(.05);
    }
  });

  it('re-hangs at a new rod height and length on setExtent, scaling the sheet about the rod', () => {
    const cloth = settled();
    const strainBefore = cloth.meanStrain;
    // A deeper sheet: wider, taller rod, longer fabric, as the simulation lays it out to fill the view there.
    const x0 = -.2, x1 = ASPECT + .2, top = 1.21, length = 1.195;
    cloth.setExtent(x0, x1, top, length);
    expect(cloth.top).toBe(top); expect(cloth.length).toBe(length);
    for (let c = 0; c < cloth.cols; c++) { expect(cloth.pos[c * 3 + 1]).toBe(top); expect(cloth.pos[c * 3]).toBeCloseTo(x0 + (x1 - x0) * c / (cloth.cols - 1), 12); }
    // The hem lands at the new length straight away, and nothing hangs below the floor.
    expect(Math.abs(hemY(cloth) - (top - length))).toBeLessThan(.02);
    cloth.step(DT, PARAMS, NO_COLLIDERS);
    expect(cloth.meanStrain).toBeLessThan(strainBefore * 1.5 + .002);
    for (let i = 0; i < 29; i++) cloth.step(DT, PARAMS, NO_COLLIDERS);
    expect(cloth.meanStrain).toBeLessThan(strainBefore * 1.5 + .002);
    expect(Math.abs(hemY(cloth) - (top - length))).toBeLessThan(.03);
    for (let i = 0; i < cloth.count; i++) expect(cloth.pos[i * 3 + 1]).toBeGreaterThanOrEqual(0);
    expect(cloth.meanSpeed).toBeLessThan(.05);
    expect(allFinite(cloth.pos)).toBe(true);
  });
});

describe('veil solid hands in the solver', () => {
  const CY = .5;
  /** Points pushed deeper than the plane by more than `by` since `before`: how many, and how wide in x. */
  const pocket = (cloth: Cloth, before: Float64Array, by = .03) => {
    let count = 0, x0 = Infinity, x1 = -Infinity, deepest = 0;
    for (let i = 0; i < cloth.count; i++) {
      const drop = before[i * 3 + 2] - cloth.pos[i * 3 + 2];
      if (drop <= by) continue;
      count++; x0 = Math.min(x0, cloth.pos[i * 3]); x1 = Math.max(x1, cloth.pos[i * 3]); deepest = Math.max(deepest, drop);
    }
    return { count, width: count ? x1 - x0 : 0, deepest };
  };
  /** Drive `pack`'s hand 0 from `zFrom` to `zTo` (cloth z, toward the viewer is +) over `steps`, then hold. */
  const approachWith = (cloth: Cloth, pack: ColliderPack, shape: (z: number) => number[][], zFrom: number, zTo: number, steps: number, hold: number) => {
    const vz = (zTo - zFrom) / (steps * DT);
    for (let i = 0; i < steps; i++) { setCapsules(pack, 0, shape(zFrom + (zTo - zFrom) * (i + 1) / steps), 0, 0, vz); cloth.step(DT, PARAMS, pack); expect(cloth.anyInside(pack, 1e-3)).toBe(false); }
    for (let i = 0; i < hold; i++) { setCapsules(pack, 0, shape(zTo)); cloth.step(DT, PARAMS, pack); expect(cloth.anyInside(pack, 1e-3)).toBe(false); }
  };

  it('a single finger pokes a narrow pocket and a palm of five metacarpals presses a wide one', () => {
    // The test grid is coarse (columns .065 apart), so the finger is a fat one aimed at a column: a thinner
    // one threads between the points of this grid (the real grids are two to three times finer).
    const R = .05;
    const fingerCloth = settled(), palmCloth = settled();
    const FX = fingerCloth.restX[12];
    // A finger pointing into the scene: its tip goes from .12 in front of the plane to .08 behind it.
    const finger = (tip: number) => [[FX, CY, tip + .4, FX, CY, tip, R]];
    // A palm facing the sheet: five metacarpals fanning from the wrist to knuckles .07 apart, all at the same depth.
    const palm = (z: number) => [0, 1, 2, 3, 4].map(k => [FX, CY - .12, z, FX + (k - 2) * .07, CY + .05, z, R + .005]);
    const before = Float64Array.from(fingerCloth.pos);
    const fingerPack = makePack(), palmPack = makePack();
    approachWith(fingerCloth, fingerPack, finger, .12, -.08, 40, 30);
    approachWith(palmCloth, palmPack, palm, .12, -.06, 40, 30);
    const f = pocket(fingerCloth, before), p = pocket(palmCloth, before);
    // Both press a pocket deeper than the plane; the finger's is a narrow dimple, the palm's spans the hand.
    expect(f.count).toBeGreaterThan(0); expect(f.deepest).toBeGreaterThan(.06);
    expect(p.count).toBeGreaterThan(0); expect(p.deepest).toBeGreaterThan(.04);
    expect(f.width).toBeLessThan(.3);
    expect(p.width).toBeGreaterThan(.4);
    expect(p.width).toBeGreaterThan(f.width * 1.8);
    expect(p.count).toBeGreaterThan(f.count * 1.5);
    expect(palmCloth.contactFraction).toBeGreaterThan(fingerCloth.contactFraction);
    expect(fingerCloth.contactFraction).toBeGreaterThan(0);
    expect(allFinite(fingerCloth.pos)).toBe(true); expect(allFinite(palmCloth.pos)).toBe(true);
  });

  it('two fingers poke two pockets with a ridge of fabric between them', () => {
    const cloth = settled();
    const pack = makePack();
    // Two fingers four columns apart on the coarse test grid (.26 apart), each aimed at a column, poking to tip −.08.
    const L = cloth.restX[8], Rx = cloth.restX[12], R = .05, tip = -.08;
    const fingers = (t: number) => [[L, CY, t + .4, L, CY, t, R], [Rx, CY, t + .4, Rx, CY, t, R]];
    approachWith(cloth, pack, fingers, .12, tip, 40, 30);
    // The deepest fabric in each column near CY (absolute, since the resting folds are themselves ±.08 deep):
    // ahead of each fingertip it sits at the tip's front, and the ridge between the fingers stays well above that.
    let row = 0, best = Infinity;
    for (let r = 0; r < cloth.rows; r++) { const d = Math.abs(cloth.pos[(r * cloth.cols) * 3 + 1] - CY); if (d < best) { best = d; row = r; } }
    const deepestAt = (col: number) => { let z = Infinity; for (let r = row - 3; r <= row + 3; r++) z = Math.min(z, cloth.pos[(r * cloth.cols + col) * 3 + 2]); return z; };
    const left = deepestAt(8), right = deepestAt(12), ridge = deepestAt(10);
    expect(left).toBeLessThan(tip - R + .025); expect(right).toBeLessThan(tip - R + .025);
    expect(left).toBeGreaterThanOrEqual(tip - R - 1e-3); expect(right).toBeGreaterThanOrEqual(tip - R - 1e-3);
    expect(ridge).toBeGreaterThan(Math.max(left, right) + .03);
  });

  it('a synthetic skeleton passing through the sheet never leaves a point inside any of its capsules', () => {
    const cloth = settled();
    const table = new HandColliders();
    const DEPTH = 1, PLANE = .45;
    let crossed = false;
    const skeleton = (z: number, openness: number): ColliderHand => ({ id: 1, position: { x: .5, y: .5, z }, velocity: { x: 0, y: 0, z: .6 / (119 * DT) }, extent: { min: { x: .45, y: .42, z }, max: { x: .55, y: .58, z } }, capsules: syntheticHandCapsules({ x: .5, y: .5, z }, openness, .06) });
    // Open to half-closed: the capsules overlap only at the wrist and joints, and every point ends outside them all.
    for (let i = 0; i < 120; i++) {
      table.update([skeleton(.1 + .6 * i / 119, .75 + .25 * Math.sin(i * .05))], DT, ASPECT, DEPTH, PLANE);
      cloth.step(DT, PARAMS, table);
      expect(cloth.anyInside(table, 1e-3)).toBe(false);
      if (cloth.contactFraction > .01) crossed = true;
    }
    expect(table.list[0].solid).toBe(true); expect(table.list[0].capsuleCount).toBe(19);
    expect(crossed).toBe(true);
    // A fist closes the fingers back onto the palm: fabric caught in that hollow has no way out, but its
    // penetration stays small and bounded (the deepest-capsule pushes do not fight each other into a blow-up).
    for (let i = 0; i < 60; i++) {
      table.update([skeleton(.7 - .3 * i / 59, Math.max(0, .6 - i / 40))], DT, ASPECT, DEPTH, PLANE);
      cloth.step(DT, PARAMS, table);
      expect(cloth.anyInside(table, .01)).toBe(false);
    }
    expect(allFinite(cloth.pos)).toBe(true);
    expect(cloth.meanSpeed).toBeLessThan(.5);
  });

  it('is deterministic with a solid hand: identical inputs give identical positions', () => {
    const run = () => {
      const cloth = makeCloth(5), table = new HandColliders(), wind = new WindField({ cols: cloth.windCols, rows: cloth.windRows, seed: 7 });
      for (let i = 0; i < 240; i++) {
        const t = (i + 1) * DT, z = .3 + .3 * Math.sin(t * 2), x = .5 + .2 * Math.sin(t);
        const hand: ColliderHand = { id: 1, position: { x, y: .5, z }, velocity: { x: .2 * Math.cos(t), y: 0, z: .6 * Math.cos(t * 2) }, extent: { min: { x: x - .05, y: .42, z }, max: { x: x + .05, y: .58, z } }, capsules: syntheticHandCapsules({ x, y: .5, z }, .5 + .5 * Math.cos(t), .06) };
        if (wind.update({ time: t, dt: DT, wind: .4, gustiness: .6, turbulence: .2, x0: cloth.rodX0, x1: cloth.rodX1, top: 1.03, length: .99 })) cloth.wind.set(wind.data);
        table.update([hand], DT, ASPECT, 1, .45);
        cloth.step(DT, PARAMS, table);
      }
      return cloth;
    };
    const a = run(), b = run();
    expect(a.pos).toEqual(b.pos);
    expect(a.contactFraction).toBe(b.contactFraction);
    expect(a.meanStrain).toBe(b.meanStrain);
  });
});

describe('veil scan shell', () => {
  const DEPTH = 1, PLANE = .45, W = 64, H = 48;
  /** A scanned disc: a flat front at sim depth `z` over a circle of radius `r` (uniform units) about sim (cx, cy). */
  const disc = (cx: number, cy: number, r: number, z: number): SurfaceField => {
    const zf = new Float32Array(W * H).fill(1), mask = new Uint8Array(W * H);
    for (let row = 0; row < H; row++) for (let col = 0; col < W; col++) {
      const u = (col + .5) / W, v = (row + .5) / H, dx = (u - cx) * ASPECT, dy = v - cy;
      if (dx * dx + dy * dy < r * r) { zf[row * W + col] = z; mask[row * W + col] = 255; }
    }
    return { width: W, height: H, z: zf, mask };
  };
  const pocket = (cloth: Cloth, before: Float64Array, by = .03) => {
    let count = 0, x0 = Infinity, x1 = -Infinity, deepest = 0;
    for (let i = 0; i < cloth.count; i++) {
      const drop = before[i * 3 + 2] - cloth.pos[i * 3 + 2];
      if (drop <= by) continue;
      count++; x0 = Math.min(x0, cloth.pos[i * 3]); x1 = Math.max(x1, cloth.pos[i * 3]); deepest = Math.max(deepest, drop);
    }
    return { count, width: count ? x1 - x0 : 0, deepest };
  };

  it('samples like the shared helpers: filled cells only, slopes toward the glass, a box around the scan', () => {
    const shell = new ScanShell();
    const field = disc(.5, .5, .2, .4);
    // A sloped patch inside the disc so the normal is not trivial.
    for (let row = 0; row < H; row++) for (let col = 0; col < W; col++) if (field.mask[row * W + col]) field.z[row * W + col] = .3 + .2 * (col + .5) / W;
    shell.update(field, DT, ASPECT, DEPTH, PLANE);
    expect(shell.active).toBe(true); expect(shell.filled).toBeGreaterThan(0);
    for (const [x, y] of [[.5, .5], [.45, .55], [.42, .5], [.6, .5]]) {
      shell.sample(x, y);
      const ref = sampleSurface(field, x, y);
      expect(shell.sz).toBeCloseTo(ref.z, 6); expect(shell.smask).toBeCloseTo(ref.mask, 6);
    }
    for (const [x, y] of [[.5, .5], [.45, .55], [.42, .5]]) {
      shell.slopes(x, y);
      // Interior: the same gradient the shared normal is built from (dz/dx = 0.2 · depth / aspect, dz/dy = 0).
      const n = surfaceNormalAt(field, x, y, ASPECT, DEPTH);
      expect(shell.gx).toBeCloseTo(-n.x / n.z, 4); expect(shell.gy).toBeCloseTo(-n.y / n.z, 4);
      expect(shell.gx).toBeCloseTo(.2 * DEPTH / ASPECT, 3);
    }
    // At the silhouette the shared normal leans on the empty side; the shell's slope is one-sided there, so it
    // stays the interior slope rather than tilting toward nothing, and is always bounded.
    shell.slopes(.6, .5);
    expect(shell.gx).toBeCloseTo(.2 * DEPTH / ASPECT, 2); expect(Math.abs(shell.gy)).toBeLessThanOrEqual(SCAN_SLOPE_MAX);
    // Outside the disc: no depth, no mask. The box holds the disc (with a cell of margin) and its shell's depth range.
    shell.sample(.1, .1); expect(shell.smask).toBe(0);
    expect(shell.x0).toBeLessThan((.5 - .2 / ASPECT) * ASPECT); expect(shell.x1).toBeGreaterThan((.5 + .2 / ASPECT) * ASPECT);
    expect(shell.y0).toBeLessThan(.3); expect(shell.y1).toBeGreaterThan(.7);
    // The disc spans cells 25..38 of the slope: front at the shallowest cell, back at the deepest plus the thickness.
    expect(shell.z0).toBeCloseTo((.3 + .2 * 25.5 / W) * DEPTH, 3); expect(shell.z1).toBeCloseTo((.3 + .2 * 38.5 / W + SCAN_THICKNESS) * DEPTH, 3);
    // No scan, or an empty one, deactivates the shell.
    shell.update(null, DT, ASPECT, DEPTH, PLANE); expect(shell.active).toBe(false);
    shell.update({ width: W, height: H, z: new Float32Array(W * H).fill(1), mask: new Uint8Array(W * H) }, DT, ASPECT, DEPTH, PLANE); expect(shell.active).toBe(false);
  });

  it('reads the depth velocity from consecutive frames, clamped, and zero where a cell just appeared', () => {
    const shell = new ScanShell();
    shell.update(disc(.5, .5, .15, .3), DT, ASPECT, DEPTH, PLANE);
    shell.sample(.5, .5); expect(shell.svz).toBe(0);
    shell.update(disc(.5, .5, .15, .3 + .3 * DT), DT, ASPECT, DEPTH, PLANE);
    shell.sample(.5, .5); expect(shell.svz).toBeCloseTo(.3, 3);
    // The same field again (a camera slower than the step) keeps the last velocity; a bigger disc's new rim has none.
    const bigger = disc(.5, .5, .25, .3 + .6 * DT);
    shell.update(bigger, DT, ASPECT, DEPTH, PLANE); shell.update(bigger, DT, ASPECT, DEPTH, PLANE);
    shell.sample(.5, .5); expect(shell.svz).toBeCloseTo(.3, 3);
    shell.sample(.5 + .2 / ASPECT, .5); expect(shell.svz).toBe(0);
    // A field that arrives after two steps spreads its change over both; a jump is clamped.
    shell.update(disc(.5, .5, .25, .3 + 1.2 * DT), DT, ASPECT, DEPTH, PLANE);
    shell.sample(.5, .5); expect(shell.svz).toBeCloseTo(.3, 3);
    shell.update(disc(.5, .5, .25, .9), DT, ASPECT, DEPTH, PLANE);
    shell.sample(.5, .5); expect(shell.svz).toBe(4);
  });

  it('a flat scanned disc arriving at the plane presses a pocket, the hands stand down, and nothing ends inside the shell', () => {
    const cloth = settled();
    const before = Float64Array.from(cloth.pos);
    const table = new HandColliders();
    const hand: ColliderHand = { id: 1, position: { x: .5, y: .5, z: .3 }, velocity: { x: 0, y: 0, z: .5 }, extent: { min: { x: .4, y: .4, z: .3 }, max: { x: .6, y: .6, z: .3 } }, capsules: syntheticHandCapsules({ x: .5, y: .5, z: .3 }, 1, .06) };
    // The disc's front goes from well in front of the plane to just behind it, so its back face sweeps the sheet deeper.
    const z0 = PLANE - SCAN_THICKNESS - .15, z1 = PLANE + .02;
    for (let i = 0; i < 60; i++) {
      table.update([hand], DT, ASPECT, DEPTH, PLANE, disc(.5, .5, .14, z0 + (z1 - z0) * (i + 1) / 60));
      expect(table.usingScan).toBe(true); expect(table.count).toBe(0);
      cloth.step(DT, PARAMS, table);
      expect(cloth.anyInsideShell(table.shell, 1e-4)).toBe(false);
    }
    for (let i = 0; i < 30; i++) { table.update([hand], DT, ASPECT, DEPTH, PLANE, disc(.5, .5, .14, z1)); cloth.step(DT, PARAMS, table); expect(cloth.anyInsideShell(table.shell, 1e-4)).toBe(false); }
    // The pocket's floor (fabric pushed more than .07 deeper) is the disc's size, not the whole sheet.
    const p = pocket(cloth, before, .07);
    expect(p.count).toBeGreaterThan(20); expect(p.deepest).toBeGreaterThan(.12);
    expect(p.width).toBeGreaterThan(.2); expect(p.width).toBeLessThan(.45);
    expect(cloth.contactFraction).toBeGreaterThan(.01);
    expect(table.packWorld(PLANE, createPackedHands()).count).toBe(0);
    expect(allFinite(cloth.pos)).toBe(true);
    // The hand's capsules were tracked all along: when the scan stops, they take over at once.
    table.update([hand], DT, ASPECT, DEPTH, PLANE, null);
    expect(table.usingScan).toBe(false); expect(table.count).toBe(1); expect(table.list[0].strength).toBeGreaterThan(.9);
    expect(table.packWorld(PLANE, createPackedHands()).count).toBe(19);
  });

  it('a scan in front of the plane does nothing to the sheet', () => {
    const cloth = settled(), twin = settled();
    const table = new HandColliders();
    // The shell's back face plus the contact skin stops short of the sheet's resting folds.
    const field = disc(.5, .5, .2, PLANE - SCAN_THICKNESS - CONTACT_SKIN - .12);
    for (let i = 0; i < 60; i++) { table.update([], DT, ASPECT, DEPTH, PLANE, field); cloth.step(DT, PARAMS, table); twin.step(DT, PARAMS, NO_COLLIDERS); }
    expect(table.usingScan).toBe(true);
    expect(cloth.contactFraction).toBe(0);
    expect(cloth.pos).toEqual(twin.pos);
  });

  it('a sheet swinging onto a scan behind it rests on the front face, and a sloped scan pushes fabric down its slope', () => {
    const cloth = settled();
    const table = new HandColliders();
    // A scan just behind the sheet's resting folds; a strong breeze from the front pushes the sheet onto it.
    const field = disc(.5, .5, .25, PLANE + .06);
    for (let i = 0; i < cloth.wind.length; i += 3) { cloth.wind[i] = 0; cloth.wind[i + 1] = 0; cloth.wind[i + 2] = -.8; }
    for (let i = 0; i < 120; i++) { table.update([], DT, ASPECT, DEPTH, PLANE, field); cloth.step(DT, PARAMS, table); expect(cloth.anyInsideShell(table.shell, 1e-4)).toBe(false); }
    // Fabric over the disc stopped at its front (world z ≈ plane + .06 → cloth z ≈ −.06), never deeper.
    let onDisc = 0, deepest = 0;
    for (let i = cloth.cols; i < cloth.count; i++) {
      const x = cloth.pos[i * 3] / ASPECT - .5, y = cloth.pos[i * 3 + 1] - .5;
      if ((x * ASPECT) ** 2 + y * y < .2 * .2) { onDisc++; deepest = Math.max(deepest, -cloth.pos[i * 3 + 2]); }
    }
    expect(onDisc).toBeGreaterThan(5);
    expect(deepest).toBeLessThanOrEqual(.06 + 1e-4);
    expect(deepest).toBeGreaterThan(.04);
    expect(cloth.contactFraction).toBeGreaterThan(.02);
  });

  it('is deterministic with a scan: identical fields give identical positions', () => {
    const run = () => {
      const cloth = makeCloth(5), table = new HandColliders();
      for (let i = 0; i < 150; i++) { table.update([], DT, ASPECT, DEPTH, PLANE, disc(.5 + .1 * Math.sin(i * .05), .5, .15, .25 + .3 * Math.max(0, Math.sin(i * .03)))); cloth.step(DT, PARAMS, table); }
      return cloth;
    };
    const a = run(), b = run();
    expect(a.pos).toEqual(b.pos); expect(a.contactFraction).toBe(b.contactFraction);
  });
});

describe('veil hand colliders', () => {
  const DEPTH = 1, PLANE = .45;
  const hand = (id: number, x = .5, y = .5, z = .2): ColliderHand => ({
    id, position: { x, y, z }, velocity: { x: 0, y: 0, z: 0 },
    extent: { min: { x: x - .05, y: y - .08, z }, max: { x: x + .05, y: y + .08, z } }, capsules: [],
  });
  const update = (t: HandColliders, hands: ColliderHand[]) => t.update(hands, DT, ASPECT, DEPTH, PLANE);
  const ids = (t: HandColliders) => t.list.map(c => c.id).sort((a, b) => a - b);
  const strengthOf = (t: HandColliders, id: number) => t.find(id)!.strength;

  it('grows a collider in on arrival, places the sphere at the hand\'s world position in the sheet\'s frame, and fades it out after the hand leaves', () => {
    const table = new HandColliders();
    update(table, [hand(1)]);
    expect(table.count).toBe(1);
    expect(table.hands[7]).toBeGreaterThan(0); expect(table.hands[7]).toBeLessThan(.5);
    for (let i = 0; i < 60; i++) update(table, [hand(1)]);
    expect(table.hands[7]).toBeGreaterThan(.99);
    // World x, y in uniform units; z measured from the plane toward the viewer: sim z .2 is .25 in front of a plane at .45.
    expect(table.hands[0]).toBeCloseTo(.5 * ASPECT, 6); expect(table.hands[1]).toBeCloseTo(.5, 6);
    expect(table.hands[2]).toBeCloseTo(PLANE - .2 * DEPTH, 6);
    // Radius from the hand's box in uniform units (x half-extent .05 sim → .089 at 16:9 beats the y half-extent .08), plus padding.
    expect(table.hands[3]).toBeCloseTo(.05 * ASPECT + RADIUS_PAD, 6);
    expect(table.hands[3]).toBeCloseTo(handRadius(hand(1), ASPECT, DEPTH), 6);
    // Deeper than the plane: negative z. Velocity converts the same way: x scales with the aspect, z with the depth and flips.
    const deep: ColliderHand = { ...hand(1, .5, .5, .8), velocity: { x: .1, y: .2, z: .5 } };
    for (let i = 0; i < 5; i++) update(table, [deep]);
    expect(table.hands[2]).toBeCloseTo(PLANE - .8 * DEPTH, 6);
    expect(table.hands[4]).toBeCloseTo(.1 * ASPECT, 6); expect(table.hands[5]).toBeCloseTo(.2, 6); expect(table.hands[6]).toBeCloseTo(-.5 * DEPTH, 6);
    // Departure: the collider stays, marked absent, and fades rather than vanishing.
    update(table, []);
    expect(table.count).toBe(1); expect(table.list[0].present).toBe(false);
    expect(table.hands[7]).toBeLessThan(1); expect(table.hands[7]).toBeGreaterThan(.9);
    for (let i = 0; i < 120; i++) update(table, []);
    expect(table.count).toBe(0); expect(table.list).toHaveLength(0);
  });

  it('falls back to a single sphere when the hand has no shape, and packs it as a capsule with coincident ends', () => {
    const table = new HandColliders();
    for (let i = 0; i < 30; i++) update(table, [hand(1)]);
    const c = table.list[0];
    expect(c.solid).toBe(false); expect(c.capsuleCount).toBe(1);
    // Hand record: first capsule index, capsule count, solid flag.
    expect(table.hands[8]).toBe(0); expect(table.hands[9]).toBe(1); expect(table.hands[10]).toBe(0);
    const cap = table.capsules.subarray(0, CAPSULE_STRIDE);
    expect(cap[0]).toBeCloseTo(.5 * ASPECT, 6); expect(cap[1]).toBeCloseTo(.5, 6); expect(cap[2]).toBeCloseTo(PLANE - .2, 6);
    expect(cap[4]).toBe(cap[0]); expect(cap[5]).toBe(cap[1]); expect(cap[6]).toBe(cap[2]);
    expect(cap[3]).toBeCloseTo(handRadius(hand(1), ASPECT, DEPTH), 6);
    // Packed for the shaders: one capsule, one bound, world z back on the volume's axis.
    const packed = table.packWorld(PLANE, createPackedHands());
    expect(packed.count).toBe(1); expect(packed.boundCount).toBe(1);
    expect(packed.capsules[2]).toBeCloseTo(.2, 6); expect(packed.capsules[3]).toBeCloseTo(cap[3] * strengthEase(c.strength), 6);
    expect(packed.bounds[3]).toBeCloseTo(c.r, 6);
  });

  it('converts a solid hand\'s capsules into the sheet\'s frame with padding and a bounding sphere that holds them all', () => {
    const table = new HandColliders();
    const shape = syntheticHandCapsules({ x: .4, y: .6, z: .3 }, .8, .06);
    const solid: ColliderHand = { ...hand(2, .4, .6, .3), capsules: shape };
    update(table, [solid]);
    const c = table.list[0];
    expect(c.solid).toBe(true); expect(c.capsuleCount).toBe(shape.length); expect(table.hands[10]).toBe(1); expect(table.hands[9]).toBe(shape.length);
    for (let k = 0; k < shape.length; k++) {
      const s = shape[k], o = k * CAPSULE_STRIDE, cap = c.capsules;
      expect(cap[o]).toBeCloseTo(s.a.x * ASPECT, 5); expect(cap[o + 1]).toBeCloseTo(s.a.y, 5); expect(cap[o + 2]).toBeCloseTo(PLANE - s.a.z * DEPTH, 5);
      expect(cap[o + 4]).toBeCloseTo(s.b.x * ASPECT, 5); expect(cap[o + 5]).toBeCloseTo(s.b.y, 5); expect(cap[o + 6]).toBeCloseTo(PLANE - s.b.z * DEPTH, 5);
      expect(cap[o + 3]).toBeCloseTo(s.radius * ASPECT + CAPSULE_PAD, 5); expect(cap[o + 7]).toBeCloseTo(s.radius * ASPECT, 5);
      // Every padded endpoint lies inside the bounding sphere.
      for (const e of [0, 4]) expect(Math.hypot(cap[o + e] - c.x, cap[o + e + 1] - c.y, cap[o + e + 2] - c.z) + cap[o + 3]).toBeLessThanOrEqual(c.r + 1e-5);
      // The pool the solver reads mirrors the hand's own array.
      for (let f = 0; f < CAPSULE_STRIDE; f++) expect(table.capsules[o + f]).toBe(cap[o + f]);
    }
    // Packed for the shaders: unpadded radii scaled by the eased strength, world z, one bound at the unscaled radius.
    const packed = table.packWorld(PLANE, createPackedHands());
    expect(packed.count).toBe(shape.length); expect(packed.boundCount).toBe(1);
    const ease = strengthEase(c.strength);
    expect(ease).toBeGreaterThan(0); expect(ease).toBeLessThan(1);
    expect(packed.capsules[3]).toBeCloseTo(shape[0].radius * ASPECT * ease, 6);
    expect(packed.capsules[2]).toBeCloseTo(shape[0].a.z * DEPTH, 5);
    expect(packed.bounds[2]).toBeCloseTo(PLANE - c.z, 5); expect(packed.bounds[3]).toBeCloseTo(c.r, 6);
    // A second, shapeless hand packs after it with its own bound.
    update(table, [solid, hand(3, .8)]);
    const both = table.packWorld(PLANE, createPackedHands());
    expect(both.count).toBe(shape.length + 1); expect(both.boundCount).toBe(2);
    expect(table.hands[COLLIDER_STRIDE + 8]).toBe(MAX_COLLIDER_CAPSULES);
  });

  it('scales z with the volume depth and bounds the radius, taking the z extent into account', () => {
    const table = new HandColliders();
    table.update([hand(1, .5, .5, .2)], DT, ASPECT, 2, .9);
    expect(table.hands[2]).toBeCloseTo(.9 - .2 * 2, 6);
    // A tall z extent (fingertips reaching in) sets the radius, capped at RADIUS_MAX before padding.
    const reaching: ColliderHand = { ...hand(2), extent: { min: { x: .45, y: .42, z: 0 }, max: { x: .55, y: .58, z: .3 } } };
    expect(handRadius(reaching, ASPECT, 2)).toBeCloseTo(RADIUS_MAX + RADIUS_PAD, 6);
    expect(handRadius(reaching, ASPECT, 1)).toBeCloseTo(.15 + RADIUS_PAD, 6);
  });

  it('never holds more than MAX_COLLIDERS and ignores a new hand only while every slot is a present hand', () => {
    const table = new HandColliders();
    const five = [1, 2, 3, 4, 5].map(id => hand(id, id / 6));
    for (let i = 0; i < 30; i++) update(table, five);
    expect(table.count).toBe(MAX_COLLIDERS); expect(table.list).toHaveLength(MAX_COLLIDERS);
    expect(ids(table)).toEqual([1, 2, 3, 4]); expect(table.find(5)).toBeUndefined();
    // Once a hand leaves, the waiting hand takes its slot on the very next step (not after the fade-out).
    update(table, [five[0], five[2], five[3], five[4]]);
    expect(ids(table)).toEqual([1, 3, 4, 5]); expect(table.find(5)!.present).toBe(true);
    expect(table.count).toBe(MAX_COLLIDERS);
  });

  it('a new hand on a full table evicts the faintest departed collider, never a present hand', () => {
    const table = new HandColliders();
    const [h1, h2, h3, h4] = [1, 2, 3, 4].map(id => hand(id, id / 5));
    for (let i = 0; i < 60; i++) update(table, [h1, h2, h3, h4]);
    // Hand 2 leaves first, hand 4 later: 2 has faded further than 4 when hand 5 arrives.
    for (let i = 0; i < 12; i++) update(table, [h1, h3, h4]);
    for (let i = 0; i < 6; i++) update(table, [h1, h3]);
    expect(ids(table)).toEqual([1, 2, 3, 4]);
    const s2 = strengthOf(table, 2), s4 = strengthOf(table, 4);
    expect(s2).toBeLessThan(s4); expect(s2).toBeGreaterThan(.01);
    // The newcomer is listed before the present hands, so a naive first-come scan would evict one of them.
    const h5 = hand(5, .9);
    update(table, [h5, h1, h3]);
    expect(ids(table)).toEqual([1, 3, 4, 5]);
    expect(table.find(5)!.present).toBe(true); expect(strengthOf(table, 5)).toBeGreaterThan(0);
    expect(table.find(1)!.present).toBe(true); expect(table.find(3)!.present).toBe(true);
    expect(table.find(4)!.present).toBe(false); expect(strengthOf(table, 4)).toBeLessThan(s4);
    // The packed data mirrors the list, in order, each hand pointing at its own run of capsules.
    expect(table.count).toBe(4);
    for (let i = 0; i < table.count; i++) {
      const c = table.list[i], o = i * COLLIDER_STRIDE;
      expect(table.hands[o]).toBeCloseTo(c.x, 5); expect(table.hands[o + 3]).toBeCloseTo(c.r, 5); expect(table.hands[o + 7]).toBeCloseTo(c.strength, 5);
      expect(table.hands[o + 8]).toBe(i * MAX_COLLIDER_CAPSULES); expect(table.hands[o + 9]).toBe(1);
      expect(table.capsules[i * MAX_COLLIDER_CAPSULES * CAPSULE_STRIDE]).toBeCloseTo(c.x, 5);
    }
    // A sixth hand with the last departed collider still fading takes that slot too; a seventh finds only present hands and waits.
    update(table, [h5, h1, h3, hand(6, .1)]);
    expect(ids(table)).toEqual([1, 3, 5, 6]);
    update(table, [h5, h1, h3, hand(6, .1), hand(7, .3)]);
    expect(ids(table)).toEqual([1, 3, 5, 6]); expect(table.find(7)).toBeUndefined();
  });
});

describe('veil contact in the volume', () => {
  const DEPTH = 1, PLANE = .45, X = .5, Y = .5;
  const handAt = (z: number, vz = 0): ColliderHand => ({
    id: 1, position: { x: X, y: Y, z }, velocity: { x: 0, y: 0, z: vz },
    extent: { min: { x: X - .05, y: Y - .07, z }, max: { x: X + .05, y: Y + .07, z } }, capsules: [],
  });
  const R = handRadius(handAt(0), ASPECT, DEPTH);
  const drive = (cloth: Cloth, table: HandColliders, hands: ColliderHand[], steps: number) => {
    for (let i = 0; i < steps; i++) { table.update(hands, DT, ASPECT, DEPTH, PLANE); cloth.step(DT, PARAMS, table); }
  };

  it('a hand in front of the plane leaves the cloth untouched', () => {
    const cloth = settled(), twin = settled();
    const table = new HandColliders();
    // The sphere's near side plus the contact skin stops a good way short of the sheet and its resting folds.
    drive(cloth, table, [handAt(PLANE - R - CONTACT_SKIN - .1)], 60);
    for (let i = 0; i < 60; i++) twin.step(DT, PARAMS, NO_COLLIDERS);
    expect(table.count).toBe(1); expect(table.hands[2]).toBeGreaterThan(R + CONTACT_SKIN);
    expect(cloth.contactFraction).toBe(0);
    expect(cloth.pos).toEqual(twin.pos);
  });

  it('a hand at the plane presses into the sheet: fabric is displaced, wraps the sphere and none of it ends inside', () => {
    const cloth = settled();
    const before = Float64Array.from(cloth.pos);
    const table = new HandColliders();
    drive(cloth, table, [handAt(PLANE)], 90);
    const c = table.list[0];
    expect(c.z).toBeCloseTo(0, 6);
    expect(cloth.contactFraction).toBeGreaterThan(.02);
    expect(cloth.anyInside(table)).toBe(false);
    let moved = 0, maxMove = 0;
    for (let i = 0; i < cloth.count; i++) {
      const o = i * 3, d = Math.hypot(cloth.pos[o] - before[o], cloth.pos[o + 1] - before[o + 1], cloth.pos[o + 2] - before[o + 2]);
      if (d > .01) moved++; maxMove = Math.max(maxMove, d);
    }
    expect(moved).toBeGreaterThan(10); expect(maxMove).toBeGreaterThan(.05);
    expect(allFinite(cloth.pos)).toBe(true);
  });

  it('a hand that moves deeper than the plane passes through it and pulls the sheet past the plane', () => {
    const cloth = settled();
    const table = new HandColliders();
    // Approach from in front, cross the plane, and stop with the sphere just behind it (0.6 sim units/s).
    const z0 = PLANE - R - .1, z1 = PLANE + .5 * R, steps = 60, vz = (z1 - z0) / (steps * DT);
    for (let i = 0; i < steps; i++) { table.update([handAt(z0 + (z1 - z0) * i / (steps - 1), vz)], DT, ASPECT, DEPTH, PLANE); cloth.step(DT, PARAMS, table); }
    drive(cloth, table, [handAt(z1)], 30);
    const c = table.list[0];
    expect(c.z).toBeCloseTo(PLANE - z1, 6);
    // The fabric it pushed ahead of it lies deeper than the plane (cloth z < 0 ⇔ world z > plane), wrapped over the sphere.
    expect(minZ(cloth)).toBeLessThan(-.1);
    expect(cloth.contactFraction).toBeGreaterThan(.02);
    expect(cloth.anyInside(table)).toBe(false);
    // In the volume's sense the sheet is displaced deeper: the `depth` signal (−meanZ) is positive.
    expect(cloth.meanZ).toBeLessThan(0);
    // Carrying on to the back of the volume leaves the sheet behind the hand, sane and untangled.
    drive(cloth, table, [handAt(.95)], 120);
    expect(cloth.anyInside(table)).toBe(false);
    expect(allFinite(cloth.pos)).toBe(true);
    expect(cloth.meanSpeed).toBeLessThan(.5);
  });
});

describe('veil layout', () => {
  it('sizes the rod so the sheet fills the view at its depth and hangs above the floor', () => {
    for (const [aspect, depth, plane] of [[16 / 9, 1, .45], [4 / 3, 1.5, .2], [16 / 9, 2, .9]] as const) {
      const planeZ = plane * depth, camera = windowCamera(aspect, depth), l = layoutFor(aspect, planeZ);
      expect(l.scale).toBeCloseTo((DEFAULT_EYE + planeZ) / DEFAULT_EYE, 9);
      // The rod ends project just outside the frame at the sheet's depth, and its top is above the visible top there.
      const left = camera.project({ x: l.x0, y: l.top, z: planeZ }), right = camera.project({ x: l.x1, y: l.top, z: planeZ });
      expect(left.x).toBeLessThan(-.9); expect(left.x).toBeGreaterThan(-1.2); expect(right.x).toBeGreaterThan(.9); expect(left.y).toBeGreaterThan(1);
      // The hem stays just above the floor, inside the volume.
      expect(l.top - l.length).toBeGreaterThan(0); expect(l.top - l.length).toBeLessThan(.05);
      // At the glass the layout is the glass itself, plus the rod's small overhang past each side.
      const atGlass = layoutFor(aspect, 0);
      expect(atGlass.scale).toBe(1); expect(atGlass.x0).toBeLessThan(0); expect(atGlass.x1).toBeGreaterThan(aspect);
      expect(atGlass.x1 - atGlass.x0).toBeLessThan(aspect * 1.1);
    }
  });
});

describe('veil definition', () => {
  it('measures lateral motion even when straightening one fold cancels the mean offset of another', () => {
    const settled = new Float64Array([-.1, 1.1]);
    // Relative to straight columns [0, 1], both states have a mean offset of .1.
    // Each material point has nevertheless moved left by .1.
    expect(lateralDisplacement(new Float64Array([-.2, 0, 0, 1, 0, 0]), settled)).toBeCloseTo(.1);
    expect(lateralDisplacement(new Float64Array([-.1, 2, .4, 1.1, 3, -.4]), settled)).toBe(0);
  });
  it('declares the contract', () => {
    expect(veil.id).toBe('veil'); expect(veil.title).toBe('Veil'); expect(veil.stepHz).toBe(60);
    expect(Object.keys(veil.params).sort()).toEqual(['backlight', 'damping', 'drape', 'fabric', 'gustiness', 'opacity', 'plane', 'sheen', 'stiffness', 'tint', 'weave', 'wind']);
    expect(veil.params.plane.default).toBeCloseTo(.45, 6); expect(veil.params.plane.min).toBeGreaterThan(0); expect(veil.params.plane.max).toBeLessThan(1);
    expect(Object.keys(veil.signals).sort()).toEqual(['contact', 'depth', 'flutter', 'gust', 'sway', 'tension']);
    expect(veil.signals.depth.min).toBe(-1); expect(veil.signals.depth.max).toBe(1);
  });
});
