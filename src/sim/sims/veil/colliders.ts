/**
 * Hand → sphere collider bookkeeping for the Veil. Plain TypeScript, no WebGL,
 * deterministic given the sequence of update calls.
 *
 * Hands arrive in sim space [0,1]³ (z INTO the scene) and leave as spheres in
 * the cloth solver's frame: world x and y in uniform units (`toWorld`), and z
 * measured from the sheet's resting plane TOWARD THE VIEWER, so
 *
 *     cloth z = plane − world z,   cloth vz = −world vz.
 *
 * A hand nearer the glass than the sheet therefore sits at a positive z and
 * one deeper than the sheet at a negative z. Contact is purely geometric: the
 * sphere presses the sheet where it reaches it, passes through when it goes
 * deeper, and does not touch it at all while it hovers in front.
 *
 * A hand's collider grows in on arrival and shrinks out after departure so the
 * fabric never snaps. The table holds at most MAX_COLLIDERS entries; when it is
 * full, a new hand evicts the faintest collider whose hand has already left
 * (its radius is nearly zero by then, so the fabric barely notices). A new hand
 * is ignored only while every slot holds a hand that is still present.
 */
import { approach, clamp } from '../../core/math';
import { toWorld } from '../../core/camera';
import type { HandState } from '../../input/types';
import { COLLIDER_STRIDE, MAX_COLLIDERS } from './cloth';

export interface HandCollider { id: number; x: number; y: number; z: number; r: number; vx: number; vy: number; vz: number; strength: number; present: boolean }

/** The part of a HandState the colliders read; tests build these without a tracker. */
export type ColliderHand = Pick<HandState, 'id' | 'position' | 'velocity' | 'extent'>;

/** Sphere radius bounds (uniform units) for the tracked hand box, and the padding added so fabric wraps a little outside it. */
export const RADIUS_MIN = .06, RADIUS_MAX = .28, RADIUS_PAD = .03;
/** Time constants (s) for a collider growing in and fading out. */
const GROW_TAU = .1, FADE_TAU = .25, VELOCITY_TAU = .1;
/** A departed collider below this strength is dropped. */
const DROP_STRENGTH = .01;

/** Sphere radius for a hand: half its largest extent in uniform units (x scaled by the aspect, z by the depth), bounded, plus padding. */
export function handRadius(hand: Pick<HandState, 'extent'>, aspect: number, depth: number): number {
  const e = hand.extent;
  const rx = (e.max.x - e.min.x) * .5 * aspect, ry = (e.max.y - e.min.y) * .5, rz = (e.max.z - e.min.z) * .5 * depth;
  return clamp(Math.max(rx, ry, rz), RADIUS_MIN, RADIUS_MAX) + RADIUS_PAD;
}

/** The eased radius factor the cloth applies to a collider of a given strength (matches `Cloth.collide`). */
export const strengthEase = (strength: number) => strength * strength * (3 - 2 * strength);

export class HandColliders {
  /** Live colliders, in packing order. */
  readonly list: HandCollider[] = [];
  /** Packed for `Cloth.step`: COLLIDER_STRIDE floats per collider, the first `count` entries valid. */
  readonly data = new Float32Array(COLLIDER_STRIDE * MAX_COLLIDERS);
  count = 0;

  /**
   * Reconcile the table with this step's hands: present hands keep or take a collider (evicting a departed
   * one when the table is full), departed colliders fade out, and everything is packed into `data`.
   * `aspect` and `depth` size the volume in uniform units; `plane` is the world z of the sheet's resting
   * plane, from which the cloth measures its own z toward the viewer.
   */
  update(hands: readonly ColliderHand[], dt: number, aspect: number, depth: number, plane: number) {
    const list = this.list;
    for (let i = 0; i < list.length; i++) list[i].present = false;
    // Mark first, so a newcomer never evicts a hand that is still here but later in the list.
    for (const hand of hands) { const c = this.find(hand.id); if (c) c.present = true; }
    for (const hand of hands) {
      let c = this.find(hand.id);
      if (!c) {
        if (list.length >= MAX_COLLIDERS && !this.evictFaintest()) continue;
        c = { id: hand.id, x: 0, y: 0, z: 0, r: .1, vx: 0, vy: 0, vz: 0, strength: 0, present: true };
        list.push(c);
      }
      const w = toWorld(hand.position, aspect, depth);
      c.x = w.x; c.y = w.y; c.z = plane - w.z; c.r = handRadius(hand, aspect, depth);
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
    this.count = Math.min(MAX_COLLIDERS, list.length);
    const data = this.data;
    for (let i = 0; i < this.count; i++) {
      const c = list[i], o = i * COLLIDER_STRIDE;
      data[o] = c.x; data[o + 1] = c.y; data[o + 2] = c.z; data[o + 3] = c.r;
      data[o + 4] = c.vx; data[o + 5] = c.vy; data[o + 6] = c.vz; data[o + 7] = c.strength;
    }
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
