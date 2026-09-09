/**
 * Hand → collider bookkeeping for the Veil. Plain TypeScript, no WebGL,
 * deterministic given the sequence of update calls.
 *
 * Hands arrive in sim space [0,1]³ (z INTO the scene), with their solid shape
 * as `capsules` when the source knows the skeleton, and leave as capsules in
 * the cloth solver's frame: world x and y in uniform units (`toWorld`), radii
 * scaled by the aspect (they follow the x axis, like `HandState.radius`), and
 * z measured from the sheet's resting plane TOWARD THE VIEWER, so
 *
 *     cloth z = plane − world z,   cloth vz = −world vz.
 *
 * A hand nearer the glass than the sheet therefore sits at a positive z and
 * one deeper than the sheet at a negative z. Contact is purely geometric: each
 * finger, the palm and the forearm press the sheet where they reach it, pass
 * through when they go deeper, and do not touch it at all while they hover in
 * front. A hand without a shape (position-only sources) is a single sphere of
 * `handRadius` at its position: a capsule with coincident ends, so the solver
 * never needs a second path.
 *
 * Every capsule is padded a little so the fabric wraps just outside the drawn
 * hand, and each hand carries a bounding sphere so the solver can skip the
 * fabric the hand is nowhere near.
 *
 * A hand's collider grows in on arrival and shrinks out after departure (its
 * radii scale with `strength`) so the fabric never snaps. The table holds at
 * most MAX_COLLIDERS entries; when it is full, a new hand evicts the faintest
 * collider whose hand has already left (its radii are nearly zero by then, so
 * the fabric barely notices). A new hand is ignored only while every slot
 * holds a hand that is still present.
 *
 * When the source supplies a depth camera's scan (`SimInput.surface`), the scan
 * is the solid (`ScanShell`) and the hands' capsules stand down: the table
 * keeps tracking them, but packs none for the solver or the shaders.
 */
import { approach, clamp } from '../../core/math';
import { toWorld } from '../../core/camera';
import type { SurfaceField } from '../../core/types';
import type { HandState } from '../../input/types';
import { MAX_HAND_BOUNDS, MAX_HAND_CAPSULES, type PackedHands } from '../../gl/hand';
import { CAPSULE_STRIDE, COLLIDER_STRIDE, type ColliderPack, MAX_COLLIDER_CAPSULES, MAX_COLLIDERS } from './cloth';
import { ScanShell } from './scan';

export interface HandCollider {
  id: number;
  /** Bounding sphere in the cloth frame (for a hand without a shape, the sphere itself). */
  x: number; y: number; z: number; r: number;
  vx: number; vy: number; vz: number;
  strength: number;
  present: boolean;
  /** True when the hand supplied a solid shape; false for the sphere fallback. */
  solid: boolean;
  /** CAPSULE_STRIDE floats per capsule in the cloth frame: a.xyz, padded radius, b.xyz, radius as drawn. */
  capsules: Float32Array;
  capsuleCount: number;
}

/** The part of a HandState the colliders read; tests build these without a tracker. */
export type ColliderHand = Pick<HandState, 'id' | 'position' | 'velocity' | 'extent' | 'capsules'>;

/** Sphere radius bounds (uniform units) for a hand without a shape, and the padding added so fabric wraps a little outside it. */
export const RADIUS_MIN = .06, RADIUS_MAX = .28, RADIUS_PAD = .03;
/** Padding (uniform units) added to every capsule of a solid hand: the fabric wraps just outside the drawn skin. */
export const CAPSULE_PAD = .015;
/** Time constants (s) for a collider growing in and fading out. */
const GROW_TAU = .1, FADE_TAU = .25, VELOCITY_TAU = .1;
/** A departed collider below this strength is dropped. */
const DROP_STRENGTH = .01;

/** Sphere radius for a hand without a shape: half its largest extent in uniform units (x scaled by the aspect, z by the depth), bounded, plus padding. */
export function handRadius(hand: Pick<HandState, 'extent'>, aspect: number, depth: number): number {
  const e = hand.extent;
  const rx = (e.max.x - e.min.x) * .5 * aspect, ry = (e.max.y - e.min.y) * .5, rz = (e.max.z - e.min.z) * .5 * depth;
  return clamp(Math.max(rx, ry, rz), RADIUS_MIN, RADIUS_MAX) + RADIUS_PAD;
}

/** The eased radius factor the cloth applies to a collider of a given strength (matches `Cloth.collide`). */
export const strengthEase = (strength: number) => strength * strength * (3 - 2 * strength);

export class HandColliders implements ColliderPack {
  /** Live colliders, in packing order. */
  readonly list: HandCollider[] = [];
  /** Packed for `Cloth.step`: COLLIDER_STRIDE floats per hand, the first `count` entries valid. */
  readonly hands = new Float32Array(COLLIDER_STRIDE * MAX_COLLIDERS);
  /** The capsule pool the hands point into: hand i's capsules start at i * MAX_COLLIDER_CAPSULES. */
  readonly capsules = new Float32Array(CAPSULE_STRIDE * MAX_COLLIDER_CAPSULES * MAX_COLLIDERS);
  /** The depth camera's scan as a shell; active whenever the source supplies one with something in it. */
  readonly shell = new ScanShell();
  count = 0;
  /** True while the scan is the solid and the hands' capsules stand down. */
  get usingScan() { return this.shell.active; }

  /**
   * Reconcile the table with this step's hands: present hands keep or take a collider (evicting a departed
   * one when the table is full), departed colliders fade out, and everything is packed into `hands` and
   * `capsules`. `aspect` and `depth` size the volume in uniform units; `plane` is the world z of the sheet's
   * resting plane, from which the cloth measures its own z toward the viewer. With a `surface` the scan
   * becomes the solid and `count` is zero.
   */
  update(hands: readonly ColliderHand[], dt: number, aspect: number, depth: number, plane: number, surface: SurfaceField | null = null) {
    this.shell.update(surface, dt, aspect, depth, plane);
    const list = this.list;
    for (let i = 0; i < list.length; i++) list[i].present = false;
    // Mark first, so a newcomer never evicts a hand that is still here but later in the list.
    for (const hand of hands) { const c = this.find(hand.id); if (c) c.present = true; }
    for (const hand of hands) {
      let c = this.find(hand.id);
      if (!c) {
        if (list.length >= MAX_COLLIDERS && !this.evictFaintest()) continue;
        c = { id: hand.id, x: 0, y: 0, z: 0, r: .1, vx: 0, vy: 0, vz: 0, strength: 0, present: true, solid: false, capsules: new Float32Array(CAPSULE_STRIDE * MAX_COLLIDER_CAPSULES), capsuleCount: 0 };
        list.push(c);
      }
      this.shape(c, hand, aspect, depth, plane);
      c.vx = hand.velocity.x * aspect; c.vy = hand.velocity.y; c.vz = -hand.velocity.z * depth;
      c.strength = approach(c.strength, 1, dt, GROW_TAU);
    }
    for (let i = list.length - 1; i >= 0; i--) {
      const c = list[i];
      if (c.present) continue;
      c.strength = approach(c.strength, 0, dt, FADE_TAU);
      c.vx = approach(c.vx, 0, dt, VELOCITY_TAU); c.vy = approach(c.vy, 0, dt, VELOCITY_TAU); c.vz = approach(c.vz, 0, dt, VELOCITY_TAU);
      if (c.strength < DROP_STRENGTH) list.splice(i, 1);
    }
    this.count = this.shell.active ? 0 : Math.min(MAX_COLLIDERS, list.length);
    const data = this.hands, pool = this.capsules;
    for (let i = 0; i < this.count; i++) {
      const c = list[i], o = i * COLLIDER_STRIDE, first = i * MAX_COLLIDER_CAPSULES;
      data[o] = c.x; data[o + 1] = c.y; data[o + 2] = c.z; data[o + 3] = c.r;
      data[o + 4] = c.vx; data[o + 5] = c.vy; data[o + 6] = c.vz; data[o + 7] = c.strength;
      data[o + 8] = first; data[o + 9] = c.capsuleCount; data[o + 10] = c.solid ? 1 : 0; data[o + 11] = 0;
      pool.set(c.capsules.subarray(0, c.capsuleCount * CAPSULE_STRIDE), first * CAPSULE_STRIDE);
    }
  }

  /** The hand's capsules (or its fallback sphere) into the cloth frame, plus the bounding sphere. */
  private shape(c: HandCollider, hand: ColliderHand, aspect: number, depth: number, plane: number) {
    const caps = c.capsules, shape = hand.capsules;
    if (shape.length === 0) {
      const w = toWorld(hand.position, aspect, depth);
      c.solid = false;
      c.x = w.x; c.y = w.y; c.z = plane - w.z; c.r = handRadius(hand, aspect, depth);
      caps[0] = c.x; caps[1] = c.y; caps[2] = c.z; caps[3] = c.r; caps[4] = c.x; caps[5] = c.y; caps[6] = c.z; caps[7] = c.r;
      c.capsuleCount = 1;
      return;
    }
    c.solid = true;
    let n = 0, sx = 0, sy = 0, sz = 0;
    for (const cap of shape) {
      if (n >= MAX_COLLIDER_CAPSULES) break;
      const o = n * CAPSULE_STRIDE, r = cap.radius * aspect;
      caps[o] = cap.a.x * aspect; caps[o + 1] = cap.a.y; caps[o + 2] = plane - cap.a.z * depth; caps[o + 3] = r + CAPSULE_PAD;
      caps[o + 4] = cap.b.x * aspect; caps[o + 5] = cap.b.y; caps[o + 6] = plane - cap.b.z * depth; caps[o + 7] = r;
      sx += caps[o] + caps[o + 4]; sy += caps[o + 1] + caps[o + 5]; sz += caps[o + 2] + caps[o + 6];
      n++;
    }
    c.capsuleCount = n;
    // Bounding sphere: centre of the capsule endpoints, radius to the farthest endpoint plus its padded radius.
    const m = 2 * n;
    c.x = sx / m; c.y = sy / m; c.z = sz / m;
    let r = 0;
    for (let i = 0; i < n; i++) {
      const o = i * CAPSULE_STRIDE;
      for (let e = 0; e <= 4; e += 4) { const dx = caps[o + e] - c.x, dy = caps[o + e + 1] - c.y, dz = caps[o + e + 2] - c.z; r = Math.max(r, Math.sqrt(dx * dx + dy * dy + dz * dz) + caps[o + 3]); }
    }
    c.r = r;
  }

  /**
   * The colliders as world-space capsules for the shaders (`handSdfGlsl`): radii as drawn (unpadded), scaled by
   * each hand's eased strength so the drawn hand grows in and shrinks out exactly as the fabric feels it, with
   * one bounding sphere per hand. `plane` is the world z of the sheet's resting plane. Empty while the scan is
   * the solid (the shaders draw the scan then).
   */
  packWorld(plane: number, out: PackedHands): PackedHands {
    let n = 0, b = 0;
    if (this.shell.active) { out.count = 0; out.boundCount = 0; return out; }
    for (const c of this.list) {
      if (b >= MAX_HAND_BOUNDS) break;
      const ease = strengthEase(c.strength);
      if (ease < 1e-3) continue;
      const first = n, caps = c.capsules;
      for (let k = 0; k < c.capsuleCount && n < MAX_HAND_CAPSULES; k++) {
        const o = k * CAPSULE_STRIDE;
        out.capsules.set([caps[o], caps[o + 1], plane - caps[o + 2], caps[o + 7] * ease, caps[o + 4], caps[o + 5], plane - caps[o + 6], 0], n * 8);
        n++;
      }
      if (n === first) continue;
      out.bounds.set([c.x, c.y, plane - c.z, c.r], b * 4); b++;
    }
    out.count = n; out.boundCount = b;
    return out;
  }

  find(id: number): HandCollider | undefined {
    const list = this.list;
    for (let i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return undefined;
  }

  /** Remove the departed collider with the smallest strength. False when every collider's hand is present. */
  private evictFaintest(): boolean {
    const list = this.list;
    let victim = -1, faintest = Infinity;
    for (let i = 0; i < list.length; i++) if (!list[i].present && list[i].strength < faintest) { faintest = list[i].strength; victim = i; }
    if (victim < 0) return false;
    list.splice(victim, 1);
    return true;
  }
}
