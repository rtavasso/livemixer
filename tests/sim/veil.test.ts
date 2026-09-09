import { describe, expect, it } from 'vitest';
import { Cloth, COLLIDER_STRIDE, CONTACT_SKIN, MAX_COLLIDERS, type ClothStepParams } from '../../src/sim/sims/veil/cloth';
import { type ColliderHand, HandColliders, HOVER_GAP } from '../../src/sim/sims/veil/colliders';
import { WindField } from '../../src/sim/sims/veil/wind';
import veil from '../../src/sim/sims/veil';

const ASPECT = 16 / 9;
const DT = 1 / 60;
const PARAMS: ClothStepParams = { gravity: 3.25, damping: 1.2, stiffness: .6, dragNormal: 3, dragTangent: .8, friction: .5, substeps: 2, iterations: 2 };

function makeCloth(seed = 11) {
  return new Cloth({ cols: 24, rows: 36, rodX0: .08 * ASPECT, rodX1: .92 * ASPECT, top: 1.03, length: .99, gather: 1.22, folds: 6, seed });
}
const noColliders = new Float32Array(COLLIDER_STRIDE * MAX_COLLIDERS);
const allFinite = (a: ArrayLike<number>) => { for (let i = 0; i < a.length; i++) if (!Number.isFinite(a[i])) return false; return true; };
function hemY(cloth: Cloth) { let y = 0; for (let c = 0; c < cloth.cols; c++) y += cloth.pos[((cloth.rows - 1) * cloth.cols + c) * 3 + 1]; return y / cloth.cols; }

describe('veil cloth solver', () => {
  it('settles under gravity without NaN over 600 steps and hangs to its rest length', () => {
    const cloth = makeCloth();
    for (let i = 0; i < 600; i++) cloth.step(DT, PARAMS, noColliders, 0);
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
    for (let i = 0; i < 400; i++) cloth.step(DT, PARAMS, noColliders, 0);
    expect(cloth.meanStrain).toBeLessThan(.05);
    // The gathered sheet folds: it must not be flat, and the folds are of a sane amplitude.
    let zMax = 0; for (let i = 0; i < cloth.count; i++) zMax = Math.max(zMax, Math.abs(cloth.pos[i * 3 + 2]));
    expect(zMax).toBeGreaterThan(.01); expect(zMax).toBeLessThan(.2);
  });

  it('pushes points out of a sphere collider and never leaves any inside after a step', () => {
    const cloth = makeCloth();
    for (let i = 0; i < 200; i++) cloth.step(DT, PARAMS, noColliders, 0);
    const before = Float64Array.from(cloth.pos);
    const colliders = new Float32Array(COLLIDER_STRIDE * MAX_COLLIDERS);
    const cx = ASPECT * .5, cy = .5, cz = -.02, r = .16;
    colliders.set([cx, cy, cz, r, 0, 0, 0, 1], 0);
    for (let i = 0; i < 90; i++) { cloth.step(DT, PARAMS, colliders, 1); expect(cloth.anyInside(cx, cy, cz, r)).toBe(false); }
    expect(allFinite(cloth.pos)).toBe(true);
    // Points near the sphere were displaced (mostly toward the viewer, off the sphere's front).
    let moved = 0, maxDz = 0;
    for (let i = 0; i < cloth.count; i++) { const dz = cloth.pos[i * 3 + 2] - before[i * 3 + 2]; if (Math.abs(dz) > .01) moved++; maxDz = Math.max(maxDz, dz); }
    expect(moved).toBeGreaterThan(10);
    expect(maxDz).toBeGreaterThan(.05);
    expect(cloth.contactFraction).toBeGreaterThan(.02);
    expect(cloth.contactFraction).toBeLessThanOrEqual(1);
    // A moving hand drags fabric along: the fabric ahead of and around it picks up its lateral velocity.
    colliders.set([cx, cy, cz, r, 1.2, 0, 0, 1], 0);
    let xBefore = 0; for (let i = 0; i < cloth.count; i++) xBefore += cloth.pos[i * 3];
    for (let i = 0; i < 10; i++) { colliders[0] += 1.2 * DT; cloth.step(DT, PARAMS, colliders, 1); expect(cloth.anyInside(colliders[0], cy, cz, r)).toBe(false); }
    let xAfter = 0; for (let i = 0; i < cloth.count; i++) xAfter += cloth.pos[i * 3];
    expect(xAfter).toBeGreaterThan(xBefore);
    // Hand leaves: the collider fades and the sheet settles without blowing up.
    for (let i = 0; i < 240; i++) { colliders[7] = Math.max(0, colliders[7] - DT / .25); cloth.step(DT, PARAMS, colliders, 1); }
    expect(allFinite(cloth.pos)).toBe(true);
    expect(cloth.contactFraction).toBe(0);
    expect(cloth.meanSpeed).toBeLessThan(.15);
  });

  it('is moved by wind toward the viewer', () => {
    const still = makeCloth(), windy = makeCloth();
    for (let i = 0; i < 200; i++) { still.step(DT, PARAMS, noColliders, 0); windy.step(DT, PARAMS, noColliders, 0); }
    for (let i = 0; i < windy.wind.length; i += 3) { windy.wind[i] = .05; windy.wind[i + 1] = 0; windy.wind[i + 2] = .5; }
    for (let i = 0; i < 240; i++) { still.step(DT, PARAMS, noColliders, 0); windy.step(DT, PARAMS, noColliders, 0); }
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
    const colliders = new Float32Array(COLLIDER_STRIDE * MAX_COLLIDERS);
    for (let i = 0; i < 300; i++) {
      const t = (i + 1) * DT;
      colliders.set([ASPECT * .5 + .3 * Math.sin(t), .5, .05 - .2 * Math.max(0, Math.sin(t * 2)), .15, .3 * Math.cos(t), 0, 0, Math.min(1, t)], 0);
      const u = { time: t, dt: DT, wind: .4, gustiness: .6, turbulence: .2, x0: a.rodX0, x1: a.rodX1, top: 1.03, length: .99 };
      if (windA.update(u)) a.wind.set(windA.data);
      if (windB.update(u)) b.wind.set(windB.data);
      a.step(DT, PARAMS, colliders, 1); b.step(DT, PARAMS, colliders, 1);
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
    const cloth = makeCloth();
    for (let i = 0; i < 200; i++) cloth.step(DT, PARAMS, noColliders, 0);
    const before = Float64Array.from(cloth.pos);
    const colliders = new Float32Array(COLLIDER_STRIDE * MAX_COLLIDERS);
    // Sphere hovering in front: its surface is inside the skin distance of the sheet but does not intersect it.
    colliders.set([ASPECT * .5, .5, .12 + CONTACT_SKIN * .5, .12, 0, 0, 0, 1], 0);
    cloth.step(DT, PARAMS, colliders, 1);
    expect(cloth.contactFraction).toBeGreaterThan(0);
    let maxMove = 0; for (let i = 0; i < cloth.count; i++) maxMove = Math.max(maxMove, Math.abs(cloth.pos[i * 3 + 2] - before[i * 3 + 2]));
    expect(maxMove).toBeLessThan(.02);
  });

  it('reflows with the rod on setExtent, so strain and sway are back at their resting levels after a short settle', () => {
    const cloth = makeCloth();
    for (let i = 0; i < 200; i++) cloth.step(DT, PARAMS, noColliders, 0);
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
      cloth.step(DT, PARAMS, noColliders, 0);
      expect(cloth.meanStrain).toBeLessThan(strainBefore * 1.5 + .002);
      // The host resettles for 30 steps before retaking its baselines; by then both are back where they were.
      for (let i = 0; i < 29; i++) cloth.step(DT, PARAMS, noColliders, 0);
      expect(allFinite(cloth.pos)).toBe(true);
      expect(cloth.meanStrain).toBeLessThan(strainBefore * 1.5 + .002);
      expect(cloth.meanAbsDx).toBeLessThan(dxBefore * 1.5 + .005);
      expect(Math.abs(hemY(cloth) - hemBefore)).toBeLessThan(.02);
      expect(cloth.meanSpeed).toBeLessThan(.05);
    }
  });
});

describe('veil hand colliders', () => {
  const REACH = .4;
  const hand = (id: number, x = .5, y = .5, push = 0): ColliderHand => ({
    id, position: { x, y, z: 0 }, velocity: { x: 0, y: 0, z: 0 }, push,
    extent: { min: { x: x - .05, y: y - .08, z: 0 }, max: { x: x + .05, y: y + .08, z: 0 } },
  });
  const ids = (t: HandColliders) => t.list.map(c => c.id).sort((a, b) => a - b);
  const strengthOf = (t: HandColliders, id: number) => t.find(id)!.strength;

  it('grows a collider in on arrival, places it in front of the sheet, and fades it out after the hand leaves', () => {
    const table = new HandColliders();
    table.update([hand(1)], DT, ASPECT, REACH);
    expect(table.count).toBe(1);
    expect(table.data[7]).toBeGreaterThan(0); expect(table.data[7]).toBeLessThan(.5);
    for (let i = 0; i < 60; i++) table.update([hand(1)], DT, ASPECT, REACH);
    expect(table.data[7]).toBeGreaterThan(.99);
    // Withdrawn: centre at hand position in uniform units, front of the sphere hovering HOVER_GAP before the sheet.
    const r = table.data[3];
    expect(table.data[0]).toBeCloseTo(.5 * ASPECT, 6); expect(table.data[1]).toBeCloseTo(.5, 6);
    expect(table.data[2]).toBeCloseTo(r + HOVER_GAP, 5);
    // Pushed: the centre goes `reach` behind the sheet.
    for (let i = 0; i < 5; i++) table.update([hand(1, .5, .5, 1)], DT, ASPECT, REACH);
    expect(table.data[2]).toBeCloseTo(-REACH, 5);
    // Departure: the collider stays, marked absent, and fades rather than vanishing.
    table.update([], DT, ASPECT, REACH);
    expect(table.count).toBe(1); expect(table.list[0].present).toBe(false);
    expect(table.data[7]).toBeLessThan(1); expect(table.data[7]).toBeGreaterThan(.9);
    for (let i = 0; i < 120; i++) table.update([], DT, ASPECT, REACH);
    expect(table.count).toBe(0); expect(table.list).toHaveLength(0);
  });

  it('never holds more than MAX_COLLIDERS and ignores a new hand only while every slot is a present hand', () => {
    const table = new HandColliders();
    const five = [1, 2, 3, 4, 5].map(id => hand(id, id / 6));
    for (let i = 0; i < 30; i++) table.update(five, DT, ASPECT, REACH);
    expect(table.count).toBe(MAX_COLLIDERS); expect(table.list).toHaveLength(MAX_COLLIDERS);
    expect(ids(table)).toEqual([1, 2, 3, 4]); expect(table.find(5)).toBeUndefined();
    // Once a hand leaves, the waiting hand takes its slot on the very next step (not after the fade-out).
    table.update([five[0], five[2], five[3], five[4]], DT, ASPECT, REACH);
    expect(ids(table)).toEqual([1, 3, 4, 5]); expect(table.find(5)!.present).toBe(true);
    expect(table.count).toBe(MAX_COLLIDERS);
  });

  it('a new hand on a full table evicts the faintest departed collider, never a present hand', () => {
    const table = new HandColliders();
    const [h1, h2, h3, h4] = [1, 2, 3, 4].map(id => hand(id, id / 5));
    for (let i = 0; i < 60; i++) table.update([h1, h2, h3, h4], DT, ASPECT, REACH);
    // Hand 2 leaves first, hand 4 later: 2 has faded further than 4 when hand 5 arrives.
    for (let i = 0; i < 12; i++) table.update([h1, h3, h4], DT, ASPECT, REACH);
    for (let i = 0; i < 6; i++) table.update([h1, h3], DT, ASPECT, REACH);
    expect(ids(table)).toEqual([1, 2, 3, 4]);
    const s2 = strengthOf(table, 2), s4 = strengthOf(table, 4);
    expect(s2).toBeLessThan(s4); expect(s2).toBeGreaterThan(.01);
    // The newcomer is listed before the present hands, so a naive first-come scan would evict one of them.
    const h5 = hand(5, .9);
    table.update([h5, h1, h3], DT, ASPECT, REACH);
    expect(ids(table)).toEqual([1, 3, 4, 5]);
    expect(table.find(5)!.present).toBe(true); expect(strengthOf(table, 5)).toBeGreaterThan(0);
    expect(table.find(1)!.present).toBe(true); expect(table.find(3)!.present).toBe(true);
    expect(table.find(4)!.present).toBe(false); expect(strengthOf(table, 4)).toBeLessThan(s4);
    // The packed data mirrors the list, in order.
    expect(table.count).toBe(4);
    for (let i = 0; i < table.count; i++) { const c = table.list[i], o = i * COLLIDER_STRIDE; expect(table.data[o]).toBeCloseTo(c.x, 5); expect(table.data[o + 3]).toBeCloseTo(c.r, 5); expect(table.data[o + 7]).toBeCloseTo(c.strength, 5); }
    // A sixth hand with the last departed collider still fading takes that slot too; a seventh finds only present hands and waits.
    table.update([h5, h1, h3, hand(6, .1)], DT, ASPECT, REACH);
    expect(ids(table)).toEqual([1, 3, 5, 6]);
    table.update([h5, h1, h3, hand(6, .1), hand(7, .3)], DT, ASPECT, REACH);
    expect(ids(table)).toEqual([1, 3, 5, 6]); expect(table.find(7)).toBeUndefined();
  });
});

describe('veil definition', () => {
  it('declares the contract', () => {
    expect(veil.id).toBe('veil'); expect(veil.title).toBe('Veil'); expect(veil.stepHz).toBe(60);
    expect(Object.keys(veil.params).sort()).toEqual(['backlight', 'damping', 'drape', 'gustiness', 'opacity', 'reach', 'stiffness', 'tint', 'weave', 'wind']);
    expect(Object.keys(veil.signals).sort()).toEqual(['contact', 'depth', 'flutter', 'gust', 'sway', 'tension']);
    expect(veil.signals.depth.min).toBe(-1);
  });
});
