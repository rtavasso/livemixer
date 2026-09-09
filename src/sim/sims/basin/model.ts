/**
 * Basin — CPU-side model. Everything here is pure and free of WebGL so it can
 * be unit-tested: bowl geometry and the volume → grid mapping, the hand's
 * height against the water surface, palettes, probe encoding/decoding and the
 * analytic probe weights, signal shaping and smoothing, and the ink-drop
 * scheduler that turns hand motion into drops.
 *
 * The bowl sits on the floor of the volume and is seen from above, so the
 * water plane is the volume's horizontal plane: grid x is sim x (left → right)
 * and grid y is sim z (depth: the glass edge at the bottom of the screen, the
 * far edge of the table at the top). The top-down camera frames the whole
 * floor, so sim z maps onto the screen height directly whatever the volume's
 * `depth` setting. Sim y is the hand's HEIGHT; the water surface sits at the
 * `surface` parameter and decides whether the hand touches the water.
 *
 * Grid space: the fluid lives on a square grid whose uv ∈ [0, 1]² covers a
 * square of side `domain = min(1, aspect)` uniform units centred on the
 * canvas (uniform units: canvas height = 1, width = aspect). The bowl is a
 * circle of radius `bowl` (grid uv) at (0.5, 0.5). On a landscape display the
 * domain is exactly one uniform unit, so `bowl` is a radius in uniform units;
 * on a portrait display it shrinks so the bowl always fits.
 */
import type { Quality, SurfaceField, Vec3 } from '../../core/types';
import type { Capsule, HandState } from '../../input/types';
import { approach, clamp, clamp01, rng, smoothstep } from '../../core/math';

// ---------------------------------------------------------------------------
// Quality → resources
// ---------------------------------------------------------------------------

export const GRID_BY_QUALITY: Record<Quality, number> = { low: 160, medium: 256, high: 320 };
export const JACOBI_BY_QUALITY: Record<Quality, number> = { low: 16, medium: 24, high: 32 };

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

export interface GridPoint { x: number; y: number }

/** A hand on the water plane, in grid units, with its relation to the surface. */
export interface GridHand {
  /** Planar position (grid uv) and velocity (uv/s): x from sim x, y from sim z. */
  x: number; y: number; vx: number; vy: number;
  /** Radius of the hand's footprint on the water, grid uv: the whole hand once plunged, a fingertip's worth when barely touching. */
  radius: number;
  /** Full radius of the hand, grid uv, for its shadow. */
  extent: number;
  /** 0 with the underside above the surface … 1 with the whole hand under (`handImmersion`). */
  immersion: number;
  /** Height of the hand's underside above the surface, uniform units; ≤ 0 once it touches. */
  clearance: number;
  /** Downward speed, uniform units per second; 0 while rising. */
  descent: number;
}
export const emptyGridHand = (): GridHand => ({ x: 0, y: 0, vx: 0, vy: 0, radius: 0, extent: 0, immersion: 0, clearance: 0, descent: 0 });

/** Side of the grid domain in uniform units: the shorter canvas side. */
export const domainScale = (aspect: number) => Math.min(1, Math.max(1e-3, aspect));

/** Sim-space point → grid uv on the water plane: x from sim x, y from sim z (depth). */
export function simToGrid(p: { x: number; z: number }, aspect: number): GridPoint {
  const s = domainScale(aspect);
  return { x: (p.x * aspect - aspect * .5) / s + .5, y: (p.z - .5) / s + .5 };
}

/** Sim-space velocity (sim units/s) → grid uv per second on the water plane. */
export function simVelocityToGrid(v: { x: number; z: number }, aspect: number): GridPoint {
  const s = domainScale(aspect);
  return { x: v.x * aspect / s, y: v.z / s };
}

/** Splat radius bounds, grid uv: never below a few texels, never a wall. */
const SPLAT_MIN = .035, SPLAT_MAX = .16;

/** What the basin needs of a hand; `capsules` is the optional solid shape (empty or absent → a sphere). */
export type BasinHand = Pick<HandState, 'position' | 'extent'> & { capsules?: readonly Capsule[] };

/**
 * A conditioned hand in grid units: planar position and velocity, the footprint it makes on the
 * water, and its height against the surface. For a solid hand `immersion` is the submerged share
 * of its capsule length and `clearance` follows its lowest capsule; `extent`/`radius` describe the
 * sphere fallback only. Writes into `out` when given (no allocation per step).
 */
export function handToGrid(hand: BasinHand & Pick<HandState, 'velocity' | 'radius'>, aspect: number, surface: number, out: GridHand = emptyGridHand()): GridHand {
  const s = domainScale(aspect);
  out.x = (hand.position.x * aspect - aspect * .5) / s + .5; out.y = (hand.position.z - .5) / s + .5;
  out.vx = hand.velocity.x * aspect / s; out.vy = hand.velocity.z / s;
  out.clearance = handClearance(hand, surface, aspect);
  out.immersion = handImmersion(hand, surface, aspect);
  out.descent = Math.max(0, -hand.velocity.y);
  out.extent = clamp(hand.radius * aspect / s * .8, SPLAT_MIN, SPLAT_MAX);
  out.radius = Math.max(SPLAT_MIN, out.extent * footprint(sphereImmersion(hand, surface)));
  return out;
}

export const bowlDistance = (p: GridPoint) => Math.hypot(p.x - .5, p.y - .5);
export const insideBowl = (p: GridPoint, bowl: number) => bowlDistance(p) <= bowl;

/** Pull a point inside the bowl (used to keep drops from landing on the rim). */
export function clampToBowl(p: GridPoint, bowl: number, margin = .08): GridPoint {
  const d = bowlDistance(p), limit = Math.max(.01, bowl - margin);
  if (d <= limit) return p;
  const k = limit / d;
  return { x: .5 + (p.x - .5) * k, y: .5 + (p.y - .5) * k };
}

// ---------------------------------------------------------------------------
// Height. Sim y is the hand's height in the volume (uniform units: the canvas
// height is 1) and the water surface sits at `surface`. A hand has a body: its
// underside is `position.y − halfHeight`, so immersion ramps from 0 as the
// underside meets the surface to 1 when the whole hand is under. Sources
// without a real extent get the tracker's default box, which still works.
// ---------------------------------------------------------------------------

export const HAND_HALF_HEIGHT_MIN = .03, HAND_HALF_HEIGHT_MAX = .12;

/** Vertical half-extent of a hand, uniform units, bounded so a point source still has a body and a spread hand is not a wall. */
export const handHalfHeight = (hand: Pick<HandState, 'extent'>) => clamp((hand.extent.max.y - hand.extent.min.y) * .5, HAND_HALF_HEIGHT_MIN, HAND_HALF_HEIGHT_MAX);

/** Sphere immersion: 0 with the underside above the surface … 1 with the whole body under; linear in between. */
export function sphereImmersion(hand: Pick<HandState, 'position' | 'extent'>, surface: number): number {
  const half = handHalfHeight(hand);
  return clamp01((surface - (hand.position.y - half)) / (2 * half));
}

/**
 * The lowest point of the hand, sim x/z with its height in y: the deepest capsule underside of a
 * solid hand, the sphere's underside otherwise. `aspect` turns capsule radii (sim x) into heights.
 */
export function handUnderside(hand: BasinHand, aspect = 1, out: Vec3 = { x: 0, y: 0, z: 0 }): Vec3 {
  const caps = hand.capsules;
  if (caps && caps.length) {
    let best = Infinity;
    for (let i = 0; i < caps.length; i++) {
      const c = caps[i], ry = c.radius * aspect;
      if (c.a.y - ry < best) { best = c.a.y - ry; out.x = c.a.x; out.y = best; out.z = c.a.z; }
      if (c.b.y - ry < best) { best = c.b.y - ry; out.x = c.b.x; out.y = best; out.z = c.b.z; }
    }
    return out;
  }
  out.x = hand.position.x; out.y = hand.position.y - handHalfHeight(hand); out.z = hand.position.z;
  return out;
}
const UNDERSIDE_SCRATCH: Vec3 = { x: 0, y: 0, z: 0 };

/** Height of the hand's underside (its lowest point) above the surface, uniform units; ≤ 0 once it touches. */
export const handClearance = (hand: BasinHand, surface: number, aspect = 1) => handUnderside(hand, aspect, UNDERSIDE_SCRATCH).y - surface;

/**
 * How much of the hand is under the surface, 0..1: for a solid hand the submerged share of its
 * total capsule length (fingertips dipped in read small, a hand plunged to the wrist near 1), for
 * a bare position the sphere's immersion.
 */
export function handImmersion(hand: BasinHand, surface: number, aspect = 1): number {
  const caps = hand.capsules;
  if (caps && caps.length) {
    let wet = 0, total = 0;
    for (let i = 0; i < caps.length; i++) { capsuleFootprint(caps[i], aspect, surface, FOOT_SCRATCH); wet += FOOT_SCRATCH.wet; total += FOOT_SCRATCH.length; }
    if (total > 1e-9) return clamp01(wet / total);
  }
  return sphereImmersion(hand, surface);
}

/** How hard a hand grips the water: nothing above the surface, gently when a fingertip touches, fully once plunged. */
export const stirStrength = (immersion: number) => { const i = clamp01(immersion); return i * (2 - i); };

/** Waterline footprint relative to the hand's radius: a sphere's cross-section at the surface, the full radius once the centre is under. */
export const footprint = (immersion: number) => Math.sqrt(Math.min(1, 2 * clamp01(immersion)));

/** Immersion for the signal: a hand plunged onto the table outside the bowl reads as dry (soft at the rim). */
export function immersionSignal(hand: Pick<GridHand, 'x' | 'y' | 'immersion'>, bowl: number): number {
  const dx = hand.x - .5, dy = hand.y - .5;
  const gate = 1 - smoothstep(bowl - .04, bowl + .04, Math.sqrt(dx * dx + dy * dy));
  return clamp01(hand.immersion * gate);
}

// ---------------------------------------------------------------------------
// Solid hands. A skeleton source supplies capsules in sim space (the radius
// follows sim x, so as a height it is radius × aspect). Seen from above, a
// capsule projects onto the water plane as a stadium between its endpoints.
// The part whose underside is below the surface is its FOOTPRINT: what stirs
// the water and where the waterline ring sits, with the capsule's cross-
// section at the surface as its radius. So five dipped fingertips make five
// small stirs, a flat submerged palm one broad push, a plunged fist one round
// one. The shadow is the union of the whole capsules, each endpoint displaced
// and softened by its own height.
// ---------------------------------------------------------------------------

/** Stirring footprints per step (the advect pass): the nearest to the surface when a hand has more. */
export const MAX_FOOTPRINTS = 24;
/** Capsules the composite draws across all hands (a Leap hand has 20–21). */
export const MAX_SHADOW_CAPSULES = 48;
/** Smallest stirring footprint radius, grid uv: a few texels even on the low grid. */
export const FOOT_MIN = .02;
/** Shadow displacement per unit of height, grid uv (the window is up and to the left). Must match the composite. */
export const LIGHT_SHIFT: readonly [number, number] = [.167, -.219];
/** Shadow penumbra: base width plus growth per unit of height, grid uv. Must match the composite. */
export const PENUMBRA_BASE = .012, PENUMBRA_PER_HEIGHT = .35;
/** Relative endpoint motion (finger curl, hand rotation) is finite-differenced, capped (uv/s) and smoothed with this time constant. */
export const REL_MOTION_TAU = .1, REL_MOTION_MAX = 2;

export interface CapsuleFootprint {
  /** The wet part of the axis on the water plane, grid uv. */
  ax: number; ay: number; bx: number; by: number;
  /** Cross-section at the surface, grid uv (never below FOOT_MIN). */
  radius: number;
  /** 0 with the underside touching the surface … 1 with the deepest axis point a radius under. */
  immersion: number;
  /** How far the capsule's highest point is below the surface; 0 while it pokes through. */
  near: number;
  /** Length of the axis itself under the surface, and the full axis length (uniform units on the screen). */
  wet: number; length: number;
}
export const emptyFootprint = (): CapsuleFootprint => ({ ax: 0, ay: 0, bx: 0, by: 0, radius: 0, immersion: 0, near: 0, wet: 0, length: 0 });
const FOOT_SCRATCH = emptyFootprint();

/**
 * A capsule's footprint on the water: false (with `wet` = 0) when its underside is above the
 * surface. The axis is clipped to where the underside is under; the radius is the cross-section of
 * the capsule at the surface (the full radius once the axis is under, shrinking to nothing as the
 * underside lifts to it). `length` is always filled so callers can total the hand's capsule length.
 */
export function capsuleFootprint(c: Capsule, aspect: number, surface: number, out: CapsuleFootprint = emptyFootprint()): boolean {
  const s = domainScale(aspect), ry = Math.max(c.radius * aspect, 1e-6);
  const dx = (c.b.x - c.a.x) * aspect, dy = c.b.y - c.a.y, dz = c.b.z - c.a.z;
  out.length = Math.sqrt(dx * dx + dy * dy + dz * dz);
  const hA = c.a.y - ry - surface, hB = c.b.y - ry - surface, hmin = Math.min(hA, hB), hmax = Math.max(hA, hB);
  out.wet = 0; out.immersion = 0; out.near = 0; out.radius = 0;
  if (hmin >= 0) return false;
  // The wet part of the axis: all of it, or the part past the crossing.
  let tA = 0, tB = 1;
  if (hmax > 0) { const tc = -hA / (hB - hA); if (hA < 0) tB = tc; else tA = tc; }
  const ax = (c.a.x * aspect - aspect * .5) / s + .5, ay = (c.a.z - .5) / s + .5;
  const bx = (c.b.x * aspect - aspect * .5) / s + .5, by = (c.b.z - .5) / s + .5;
  out.ax = ax + (bx - ax) * tA; out.ay = ay + (by - ay) * tA; out.bx = ax + (bx - ax) * tB; out.by = ay + (by - ay) * tB;
  const hAxis = Math.max(hmin + ry, 0);
  out.radius = Math.max(FOOT_MIN, c.radius * aspect / s * Math.sqrt(Math.max(0, 1 - (hAxis / ry) * (hAxis / ry))));
  out.immersion = clamp01(-hmin / (2 * ry));
  // The axis itself under the surface (for the hand's immersion): a fingertip touching counts for nothing yet.
  const aAxis = hA + ry, bAxis = hB + ry;
  if (Math.min(aAxis, bAxis) < 0) {
    let uA = 0, uB = 1;
    if (Math.max(aAxis, bAxis) > 0) { const tc = -aAxis / (bAxis - aAxis); if (aAxis < 0) uB = tc; else uA = tc; }
    out.wet = (uB - uA) * out.length;
  }
  out.near = Math.max(0, -(hmax + 2 * ry));
  return true;
}

/**
 * This step's stirring footprints, packed for the advect pass: `seg` a.xy b.xy (grid uv), `vel` the
 * velocity at a and at b (uv/s, stir gain applied; they differ when the hand rotates or its fingers
 * move), `meta` radius, grip 0..1, radial press, 0. Allocates nothing per step.
 */
export class Footprints {
  readonly seg = new Float32Array(MAX_FOOTPRINTS * 4);
  readonly vel = new Float32Array(MAX_FOOTPRINTS * 4);
  readonly meta = new Float32Array(MAX_FOOTPRINTS * 4);
  count = 0;
  private readonly scratch = new Float32Array(MAX_SHADOW_CAPSULES * 8);
  private readonly order = new Int32Array(MAX_SHADOW_CAPSULES);
  private readonly fp = emptyFootprint();

  begin() { this.count = 0; }

  /** The sphere fallback: one round footprint of the hand's `radius` once it grips the water. Returns the footprints added. */
  addSphere(h: GridHand, stir: number, press: number): number {
    const grip = stirStrength(h.immersion);
    if (grip <= 0 || this.count >= MAX_FOOTPRINTS) return 0;
    const o = this.count++ * 4;
    this.seg[o] = h.x; this.seg[o + 1] = h.y; this.seg[o + 2] = h.x; this.seg[o + 3] = h.y;
    this.vel[o] = h.vx * stir; this.vel[o + 1] = h.vy * stir; this.vel[o + 2] = h.vx * stir; this.vel[o + 3] = h.vy * stir;
    this.meta[o] = h.radius; this.meta[o + 1] = grip; this.meta[o + 2] = press; this.meta[o + 3] = 0;
    return 1;
  }

  /**
   * Every capsule that touches the water, keeping the `budget` nearest the surface. Endpoint
   * velocities are the hand's (vx, vy in grid uv/s) plus the relative endpoint motion in `rel`
   * (4 floats per capsule, uv/s) when given. The hand's press is shared out over its footprints.
   * Returns the footprints added.
   */
  addSolid(capsules: readonly Capsule[], aspect: number, surface: number, vx: number, vy: number, rel: Float32Array | null, budget: number, stir: number, press: number): number {
    const fp = this.fp, sc = this.scratch, order = this.order;
    const limit = Math.min(capsules.length, MAX_SHADOW_CAPSULES);
    let n = 0;
    for (let i = 0; i < limit; i++) {
      if (!capsuleFootprint(capsules[i], aspect, surface, fp)) continue;
      const o = n * 8;
      sc[o] = fp.ax; sc[o + 1] = fp.ay; sc[o + 2] = fp.bx; sc[o + 3] = fp.by;
      sc[o + 4] = fp.radius; sc[o + 5] = stirStrength(fp.immersion); sc[o + 6] = fp.near; sc[o + 7] = i;
      // Insertion sort by `near`: the capsules at the surface come first.
      let k = n;
      while (k > 0 && sc[order[k - 1] * 8 + 6] > fp.near) { order[k] = order[k - 1]; k--; }
      order[k] = n; n++;
    }
    const take = Math.min(n, budget, MAX_FOOTPRINTS - this.count);
    if (take <= 0) return 0;
    const share = press / take;
    for (let k = 0; k < take; k++) {
      const src = order[k] * 8, o = this.count++ * 4, ci = sc[src + 7] * 4;
      this.seg[o] = sc[src]; this.seg[o + 1] = sc[src + 1]; this.seg[o + 2] = sc[src + 2]; this.seg[o + 3] = sc[src + 3];
      const rax = rel ? rel[ci] : 0, ray = rel ? rel[ci + 1] : 0, rbx = rel ? rel[ci + 2] : 0, rby = rel ? rel[ci + 3] : 0;
      this.vel[o] = (vx + rax) * stir; this.vel[o + 1] = (vy + ray) * stir; this.vel[o + 2] = (vx + rbx) * stir; this.vel[o + 3] = (vy + rby) * stir;
      this.meta[o] = sc[src + 4]; this.meta[o + 1] = sc[src + 5]; this.meta[o + 2] = share; this.meta[o + 3] = 0;
    }
    return take;
  }
}

/**
 * One hand's solid on the water plane as the composite draws it: `seg` a.xy b.xy per capsule (grid
 * uv), `meta` radius (uv), the underside clearance of a and of b (uniform units; < 0 in the water,
 * so the shader can lean and soften the shadow per endpoint and find the wet part for the
 * waterline ring), and a weight (negative: shadow only, no ring). Plus a bounding circle for the
 * shader's early-out and the relative motion of the endpoints for the stirring. One per hand,
 * kept after the hand leaves so its shadow can fade in place.
 */
export class SolidShadow {
  readonly seg = new Float32Array(MAX_SHADOW_CAPSULES * 4);
  readonly meta = new Float32Array(MAX_SHADOW_CAPSULES * 4);
  count = 0;
  /** Bounding circle on the plane, grid uv, covering shadow, penumbra and ring. */
  cx = .5; cy = .5; bound = 0;
  /** Relative endpoint velocity per capsule (ax, ay, bx, by), grid uv/s, smoothed. */
  readonly rel = new Float32Array(MAX_SHADOW_CAPSULES * 4);
  private readonly prev = new Float32Array(MAX_SHADOW_CAPSULES * 4);
  private prevCount = -1;

  /** The sphere fallback: a disc of the hand's full radius and a stub of forearm trailing toward the glass edge (shadow only). */
  setSphere(h: GridHand, aspect: number) {
    const s = this.seg, m = this.meta;
    s[0] = h.x; s[1] = h.y; s[2] = h.x; s[3] = h.y;
    m[0] = h.extent; m[1] = h.clearance; m[2] = h.clearance; m[3] = 1;
    s[4] = h.x; s[5] = h.y; s[6] = h.x; s[7] = h.y - h.extent * 2.4;
    m[4] = h.extent * .7; m[5] = h.clearance; m[6] = h.clearance; m[7] = -.5;
    this.count = 2; this.prevCount = -1; this.rel.fill(0, 0, 8);
    this.finish(domainScale(aspect));
  }

  /** A solid hand at grid position (hx, hy); `dt` > 0 lets the relative endpoint motion be tracked across steps. */
  setSolid(capsules: readonly Capsule[], aspect: number, surface: number, hx: number, hy: number, dt: number) {
    const s = domainScale(aspect), n = Math.min(capsules.length, MAX_SHADOW_CAPSULES);
    const track = this.prevCount === n && dt > 0;
    const k = track ? 1 - Math.exp(-dt / REL_MOTION_TAU) : 0;
    const seg = this.seg, meta = this.meta, rel = this.rel, prev = this.prev;
    for (let i = 0; i < n; i++) {
      const c = capsules[i], ry = c.radius * aspect, o = i * 4;
      const ax = (c.a.x * aspect - aspect * .5) / s + .5, ay = (c.a.z - .5) / s + .5;
      const bx = (c.b.x * aspect - aspect * .5) / s + .5, by = (c.b.z - .5) / s + .5;
      seg[o] = ax; seg[o + 1] = ay; seg[o + 2] = bx; seg[o + 3] = by;
      meta[o] = c.radius * aspect / s; meta[o + 1] = c.a.y - ry - surface; meta[o + 2] = c.b.y - ry - surface; meta[o + 3] = 1;
      const rax = ax - hx, ray = ay - hy, rbx = bx - hx, rby = by - hy;
      if (track) {
        rel[o] += (clamp((rax - prev[o]) / dt, -REL_MOTION_MAX, REL_MOTION_MAX) - rel[o]) * k;
        rel[o + 1] += (clamp((ray - prev[o + 1]) / dt, -REL_MOTION_MAX, REL_MOTION_MAX) - rel[o + 1]) * k;
        rel[o + 2] += (clamp((rbx - prev[o + 2]) / dt, -REL_MOTION_MAX, REL_MOTION_MAX) - rel[o + 2]) * k;
        rel[o + 3] += (clamp((rby - prev[o + 3]) / dt, -REL_MOTION_MAX, REL_MOTION_MAX) - rel[o + 3]) * k;
      } else { rel[o] = 0; rel[o + 1] = 0; rel[o + 2] = 0; rel[o + 3] = 0; }
      prev[o] = rax; prev[o + 1] = ray; prev[o + 2] = rbx; prev[o + 3] = rby;
    }
    this.count = n; this.prevCount = n;
    this.finish(s);
  }

  /** Bounding circle over the endpoints, undisplaced and shadow-displaced, padded by radius, penumbra and ring width. */
  private finish(s: number) {
    const seg = this.seg, meta = this.meta, n = this.count;
    if (!n) { this.bound = 0; return; }
    let cx = 0, cy = 0;
    for (let i = 0; i < n; i++) {
      const o = i * 4, hA = Math.max(meta[o + 1], 0) / s, hB = Math.max(meta[o + 2], 0) / s;
      cx += 2 * (seg[o] + seg[o + 2]) + LIGHT_SHIFT[0] * (hA + hB); cy += 2 * (seg[o + 1] + seg[o + 3]) + LIGHT_SHIFT[1] * (hA + hB);
    }
    cx /= 4 * n; cy /= 4 * n;
    let r = 0;
    for (let i = 0; i < n; i++) {
      const o = i * 4, rad = meta[o];
      for (let e = 0; e < 2; e++) {
        const x = seg[o + e * 2], y = seg[o + e * 2 + 1], h = Math.max(meta[o + 1 + e], 0);
        const pad = rad + PENUMBRA_BASE + h * PENUMBRA_PER_HEIGHT + .04;
        const dx = x - cx, dy = y - cy, sx = dx + LIGHT_SHIFT[0] * h / s, sy = dy + LIGHT_SHIFT[1] * h / s;
        r = Math.max(r, Math.sqrt(dx * dx + dy * dy) + pad, Math.sqrt(sx * sx + sy * sy) + pad);
      }
    }
    this.cx = cx; this.cy = cy; this.bound = r;
  }
}

// ---------------------------------------------------------------------------
// The scanned surface. A depth camera sees the performer from the FRONT, so
// the scan is a height field of depth z over the front face: cell (x, y) → z.
// Seen from above, that cell is a bit of solid at horizontal position (x, z)
// (extending SCAN_THICKNESS behind the shell) at height y. Cells at or below
// the water level are the wet footprint; every cell casts its shadow at its
// (x, z), displaced and softened by its height. The GPU samples the field
// column by column; the CPU measures it once per step for the velocity (how
// the wet centroid moved), the descent (how the lowest point moved), the
// immersion (the wet share of the scanned area) and a bounding circle.
// ---------------------------------------------------------------------------

/** How far behind the scanned shell the solid is assumed to extend, sim z units (≈ a hand's thickness in the Leap/depth box). */
export const SCAN_THICKNESS = .12;

export interface ScanMeasure {
  /** Scanned cells, and those at or below the water level. */
  total: number; wet: number;
  /** Centroid of the wet cells on the water plane, grid uv. */
  cx: number; cy: number;
  /** Half-extent of the wet cells on the plane, grid uv, within the splat bounds (the press disc). */
  wetRadius: number;
  /** Height of the lowest scanned cell, sim y (1 when nothing is scanned). */
  lowest: number;
  /** Height range of the scanned cells, sim y, for the shader's row sampling. */
  minY: number; maxY: number;
  /** Bounding circle on the plane of every cell's solid and its shadow, grid uv. */
  bx: number; by: number; bound: number;
}
export const emptyScanMeasure = (): ScanMeasure => ({ total: 0, wet: 0, cx: .5, cy: .5, wetRadius: SPLAT_MIN, lowest: 1, minY: 1, maxY: 0, bx: .5, by: .5, bound: 0 });

/** Measure a scan against the water level. Writes into `out`; allocates nothing. */
export function measureScan(field: SurfaceField, aspect: number, surface: number, out: ScanMeasure = emptyScanMeasure()): ScanMeasure {
  const s = domainScale(aspect), W = field.width, H = field.height, thick = SCAN_THICKNESS / s;
  let total = 0, wet = 0, cx = 0, cy = 0, lowest = 1, minY = 1, maxY = 0;
  let wx0 = Infinity, wx1 = -Infinity, wy0 = Infinity, wy1 = -Infinity;
  let bx0 = Infinity, bx1 = -Infinity, by0 = Infinity, by1 = -Infinity;
  for (let row = 0; row < H; row++) {
    const y = (row + .5) / H, h = Math.max(y - surface, 0), shiftX = LIGHT_SHIFT[0] * h / s, shiftY = LIGHT_SHIFT[1] * h / s;
    const pad = PENUMBRA_BASE + h * PENUMBRA_PER_HEIGHT + .04;
    for (let col = 0; col < W; col++) {
      const i = row * W + col;
      if (!field.mask[i]) continue;
      const gx = ((col + .5) / W * aspect - aspect * .5) / s + .5, gy = (field.z[i] - .5) / s + .5;
      total++;
      if (y < lowest) lowest = y;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      // The cell's solid spans gy … gy + thick; its shadow lands shifted by its height.
      bx0 = Math.min(bx0, gx - pad, gx + shiftX - pad); bx1 = Math.max(bx1, gx + pad, gx + shiftX + pad);
      by0 = Math.min(by0, gy - pad, gy + shiftY - pad); by1 = Math.max(by1, gy + thick + pad, gy + thick + shiftY + pad);
      if (y <= surface) {
        wet++; cx += gx; cy += gy + thick * .5;
        wx0 = Math.min(wx0, gx); wx1 = Math.max(wx1, gx); wy0 = Math.min(wy0, gy); wy1 = Math.max(wy1, gy + thick);
      }
    }
  }
  out.total = total; out.wet = wet; out.lowest = lowest; out.minY = minY; out.maxY = maxY;
  if (wet) { out.cx = cx / wet; out.cy = cy / wet; out.wetRadius = clamp(Math.max(wx1 - wx0, wy1 - wy0) * .5, SPLAT_MIN, SPLAT_MAX); }
  else { out.cx = .5; out.cy = .5; out.wetRadius = SPLAT_MIN; }
  if (total) { out.bx = (bx0 + bx1) * .5; out.by = (by0 + by1) * .5; out.bound = Math.sqrt((bx1 - bx0) * (bx1 - bx0) + (by1 - by0) * (by1 - by0)) * .5; }
  else { out.bx = .5; out.by = .5; out.bound = 0; }
  return out;
}

/** Cap on the scan's stirring velocity, grid uv/s, and the smoothing of its finite differences. */
export const SCAN_VELOCITY_MAX = 3, SCAN_MOTION_TAU = .08;

/**
 * How the scan moves between steps: the wet centroid's velocity (the stirring velocity, grid uv/s)
 * and the descent of the lowest scanned point (uniform units/s, 0 while rising), both smoothed.
 * A wet footprint that has just appeared, or a scan that has just returned, starts from rest.
 */
export class ScanMotion {
  vx = 0; vy = 0; descent = 0;
  private prevCx = 0; private prevCy = 0; private prevWet = 0; private prevLowest = 1; private prevTotal = 0;
  reset() { this.vx = 0; this.vy = 0; this.descent = 0; this.prevWet = 0; this.prevTotal = 0; }
  update(m: ScanMeasure, dt: number) {
    if (dt > 0 && m.wet && this.prevWet) {
      this.vx = approach(this.vx, clamp((m.cx - this.prevCx) / dt, -SCAN_VELOCITY_MAX, SCAN_VELOCITY_MAX), dt, SCAN_MOTION_TAU);
      this.vy = approach(this.vy, clamp((m.cy - this.prevCy) / dt, -SCAN_VELOCITY_MAX, SCAN_VELOCITY_MAX), dt, SCAN_MOTION_TAU);
    } else { this.vx = 0; this.vy = 0; }
    if (dt > 0 && m.total && this.prevTotal) this.descent = approach(this.descent, Math.max(0, (this.prevLowest - m.lowest) / dt), dt, SCAN_MOTION_TAU);
    else this.descent = 0;
    this.prevCx = m.cx; this.prevCy = m.cy; this.prevWet = m.wet; this.prevLowest = m.lowest; this.prevTotal = m.total;
  }
}

/**
 * A copy of the scan whose empty cells next to scanned ones carry their neighbours' depth, so a
 * bilinear sample of the depth at a silhouette edge never blends toward the "nothing" value (1 =
 * the back wall). The mask is shared, not copied. Returns `out`, re-created when the size changes.
 */
export function dilateScanDepth(field: SurfaceField, out: SurfaceField | null): SurfaceField {
  const W = field.width, H = field.height;
  if (!out || out.width !== W || out.height !== H) out = { width: W, height: H, z: new Float32Array(W * H), mask: field.mask };
  out.mask = field.mask;
  const z = out.z, src = field.z, mask = field.mask;
  for (let row = 0; row < H; row++) for (let col = 0; col < W; col++) {
    const i = row * W + col;
    if (mask[i]) { z[i] = src[i]; continue; }
    let sum = 0, n = 0;
    for (let dr = -1; dr <= 1; dr++) {
      const r = row + dr; if (r < 0 || r >= H) continue;
      for (let dc = -1; dc <= 1; dc++) {
        const c = col + dc; if (c < 0 || c >= W || (dr === 0 && dc === 0)) continue;
        const j = r * W + c;
        if (mask[j]) { sum += src[j]; n++; }
      }
    }
    z[i] = n ? sum / n : 1;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Shader time. `u_time` is never handed to a shader raw: fp32 loses the
// fractional part of a large time, so after hours the caustic hash coarsens and
// the drift phases stall. Every time-dependent term is a phase or a lattice
// offset that is periodic in the shader, and the CPU reduces it modulo that
// period so the look is seamless across the wrap and identical forever.
// ---------------------------------------------------------------------------

/** Period of the composite's lattice hash (`hash` does `mod(p, CAUSTIC_PERIOD)`). Must match shaders.ts. */
export const CAUSTIC_PERIOD = 64;
/** Lattice units per second that the two caustic layers scroll: (a.x, a.y, b.x, b.y). Must match the composite. */
export const CAUSTIC_RATES: readonly [number, number, number, number] = [.05, -.035, -.04, .045];
/** Frequency ratio of the second value-noise octave in `causticLayer`. Must match shaders.ts. */
export const CAUSTIC_LACUNARITY = 2.13;
/** Cycles per second of the four idle-drift phases in the advect shader. Must match shaders.ts. */
export const DRIFT_RATES: readonly [number, number, number, number] = [.021, -.017, .019, .013];

/** `x` reduced into [0, period) (the `+ 0` turns a -0 remainder into +0). */
export const wrap = (x: number, period: number) => { const m = x % period; return m < 0 ? m + period : m + 0; };

/**
 * Caustic scroll offsets for the composite: [0..3] first octave, [4..7] second
 * octave (the first scaled by the lacunarity), each in [0, CAUSTIC_PERIOD).
 * Each octave wraps on its own so both stay continuous across the wrap.
 */
export function causticOffsets(time: number, out = new Float32Array(8)): Float32Array {
  for (let k = 0; k < 4; k++) {
    const x = time * CAUSTIC_RATES[k];
    out[k] = wrap(x, CAUSTIC_PERIOD);
    out[k + 4] = wrap(x * CAUSTIC_LACUNARITY, CAUSTIC_PERIOD);
  }
  return out;
}

/** Idle-drift phases in cycles, each in [0, 1): the shader multiplies by 2π, so the wrap is invisible. */
export function driftPhases(time: number, out = new Float32Array(4)): Float32Array {
  for (let k = 0; k < 4; k++) out[k] = wrap(time * DRIFT_RATES[k], 1);
  return out;
}

// ---------------------------------------------------------------------------
// RGBA8 fallback ("packed") dissipation. A byte only changes when the step is
// at least half a quantum, so a per-step multiplicative decay of a small value
// is rounded away and the water would never calm (nor the ink fade). In packed
// mode the decay is applied every STRIDE steps with the compound factor, and
// never by less than PACKED_MIN_STEP quanta, so any value still reaches zero.
// ---------------------------------------------------------------------------

/** Velocity full scale of the packed encoding. Must match `VS` in shaders.ts. */
export const PACKED_VELOCITY_SCALE = 4;
/** Steps between dissipation updates in packed mode: velocity and dye. */
export const PACKED_DECAY_STRIDE = 4, PACKED_FADE_STRIDE = 8;
/** Minimum decrement per update, as a fraction of the stored range: more than half a quantum so rounding cannot undo it. */
export const PACKED_MIN_STEP = .6 / 255;

/** Multiplicative factor for this step: `exp(-rate·dt)` in float mode; in packed mode 1 off-stride and the compound factor on-stride. */
export function dissipation(rate: number, dt: number, packed: boolean, step: number, stride: number): number {
  if (!packed) return Math.exp(-rate * dt);
  return step % stride === 0 ? Math.exp(-rate * dt * stride) : 1;
}
/** Subtractive floor for this step (packed mode only, on-stride), in the stored quantity's units. */
export function dissipationFloor(packed: boolean, step: number, stride: number, scale: number): number {
  return packed && step % stride === 0 ? PACKED_MIN_STEP * scale : 0;
}

// ---------------------------------------------------------------------------
// Palettes: linear-ish RGB of the ink colours. Dense ink tends toward these.
// ---------------------------------------------------------------------------

export type Rgb = readonly [number, number, number];
export const PALETTES: Record<string, readonly Rgb[]> = {
  indigo: [[.16, .22, .95], [.05, .62, .92], [.42, .18, .85]],
  ember: [[.95, .18, .06], [.98, .52, .08], [.92, .78, .22]],
  lagoon: [[.04, .68, .62], [.35, .92, .70], [.85, .78, .38]],
  sumi: [[.92, .90, .84], [.55, .58, .62], [.30, .34, .48]],
  orchid: [[.90, .16, .62], [.52, .22, .92], [.98, .62, .48]],
};
export const PALETTE_NAMES = Object.keys(PALETTES) as readonly string[];
export const DEFAULT_PALETTE = 'indigo';

export function resolvePalette(name: string): readonly Rgb[] {
  return PALETTES[name] ?? PALETTES[DEFAULT_PALETTE];
}

// ---------------------------------------------------------------------------
// Probe: a PROBE_SIZE² RGBA8 target; each texel is the masked mean over
// PROBE_SUB² sample points of (speed, |curl|, angular momentum, ink coverage).
// The shader and `probeWeights` must agree on the sample pattern.
// ---------------------------------------------------------------------------

export const PROBE_SIZE = 16;
export const PROBE_SUB = 4;
/** Full-scale values for the 8-bit encodings. Must match shaders.ts. */
export const PROBE_ENC = { speed: 1.5, curl: 40, angular: .6 } as const;

/** Signed encoding with an exactly representable zero at 128/255. */
export const encodeSigned = (x: number, scale: number) => Math.round(clamp(128 + 127 * (x / scale), 0, 255));
export const decodeSigned = (byte: number, scale: number) => (byte - 128) / 127 * scale;
export const encodeUnsigned = (x: number, scale: number) => Math.round(clamp01(x / scale) * 255);
export const decodeUnsigned = (byte: number, scale: number) => byte / 255 * scale;

/** Per probe texel: fraction of its sample points inside the bowl (the averaging weight). */
export function probeWeights(bowl: number, size = PROBE_SIZE, sub = PROBE_SUB): Float32Array {
  const w = new Float32Array(size * size);
  for (let j = 0; j < size; j++) for (let i = 0; i < size; i++) {
    let n = 0;
    for (let sy = 0; sy < sub; sy++) for (let sx = 0; sx < sub; sx++) {
      const x = (i + (sx + .5) / sub) / size, y = (j + (sy + .5) / sub) / size;
      if (insideBowl({ x, y }, bowl)) n++;
    }
    w[j * size + i] = n / (sub * sub);
  }
  return w;
}

export interface Measures {
  /** Mean speed inside the bowl, grid uv per second. */
  speed: number;
  /** Mean |curl|, 1/s. */
  curl: number;
  /** Mean angular momentum about the centre: positive = counter-clockwise. */
  angular: number;
  /** Mean ink coverage 0..1. */
  ink: number;
}

/** Decode a probe readback (RGBA8, row-major, PROBE_SIZE²) into bowl-wide means. */
export function decodeProbe(bytes: ArrayLike<number>, weights: Float32Array): Measures {
  let speed = 0, curl = 0, angular = 0, ink = 0, total = 0;
  for (let k = 0; k < weights.length; k++) {
    const w = weights[k];
    if (w <= 0) continue;
    const o = k * 4;
    speed += w * decodeUnsigned(bytes[o], PROBE_ENC.speed);
    curl += w * decodeUnsigned(bytes[o + 1], PROBE_ENC.curl);
    angular += w * decodeSigned(bytes[o + 2], PROBE_ENC.angular);
    ink += w * decodeUnsigned(bytes[o + 3], 1);
    total += w;
  }
  if (total <= 0) return { speed: 0, curl: 0, angular: 0, ink: 0 };
  return { speed: speed / total, curl: curl / total, angular: angular / total, ink: ink / total };
}

// ---------------------------------------------------------------------------
// Signals
// ---------------------------------------------------------------------------

export interface RawSignals { energy: number; swirl: number; rotation: number; ink: number; immersion: number }
export interface BasinSignals extends RawSignals { calm: number }

/** Saturating curve: 0 at 0, ~0.63 at `scale`, → 1. */
const soft = (x: number, scale: number) => 1 - Math.exp(-Math.max(0, x) / scale);

/** Map physical means (and the primary hand's immersion, computed on the CPU) to the declared 0..1 / -1..1 ranges. */
export function measuresToSignals(m: Measures, immersion = 0): RawSignals {
  return {
    energy: soft(m.speed, .09),
    swirl: soft(m.curl, 5),
    rotation: clamp(Math.tanh(m.angular / .035), -1, 1),
    ink: clamp01(m.ink),
    immersion: clamp01(immersion),
  };
}

/** Exponential smoothing so the audio side sees stable values; `calm` follows a slower energy. */
export class SignalSmoother {
  readonly values: BasinSignals = { energy: 0, swirl: 0, rotation: 0, ink: 0, immersion: 0, calm: 1 };
  private slowEnergy = 0;
  constructor(private readonly tau = { energy: .15, swirl: .2, rotation: .35, ink: .4, immersion: .12, calm: 1.2 }) {}
  update(raw: RawSignals, dt: number): BasinSignals {
    const k = (tau: number) => (dt <= 0 ? 0 : 1 - Math.exp(-dt / tau));
    const v = this.values;
    v.energy = clamp01(v.energy + (raw.energy - v.energy) * k(this.tau.energy));
    v.swirl = clamp01(v.swirl + (raw.swirl - v.swirl) * k(this.tau.swirl));
    v.rotation = clamp(v.rotation + (raw.rotation - v.rotation) * k(this.tau.rotation), -1, 1);
    v.ink = clamp01(v.ink + (raw.ink - v.ink) * k(this.tau.ink));
    v.immersion = clamp01(v.immersion + (raw.immersion - v.immersion) * k(this.tau.immersion));
    this.slowEnergy = clamp01(this.slowEnergy + (raw.energy - this.slowEnergy) * k(this.tau.calm));
    v.calm = clamp01(1 - this.slowEnergy);
    return v;
  }
}

// ---------------------------------------------------------------------------
// Ink drops
// ---------------------------------------------------------------------------

export interface Drop {
  /** Grid uv. */
  x: number; y: number;
  /** Grid uv. */
  radius: number;
  color: Rgb;
  /** Dye concentration added at the centre. */
  amount: number;
  /** Radial velocity impulse, grid uv per second at the ring. 0 for a gentle bead. */
  impulse: number;
}

export interface DropContext {
  time: number;
  hands: readonly HandState[];
  aspect: number;
  bowl: number;
  /** Height of the water surface, sim y. */
  surface: number;
  /** Drop radius scale from the `ink` param, grid uv. */
  ink: number;
  palette: string;
  /** Drop a gentle bead wherever a hand dips into the water (a plunge always drops one). */
  dropOnEnter: boolean;
  /** Current smoothed ink coverage signal, for the idle re-seeding rule. */
  inkLevel: number;
}

/** Wet/dry hysteresis, uniform units: the underside must sink this far below the surface to count as in, and rise this far above it to count as out. */
export const WET_BAND = .012;
/** Descent speed (uniform units/s) at which a dip becomes a plunge, and the speed at which the splash is strongest. */
export const PLUNGE_SPEED = .25, PLUNGE_FULL = 1.1;
export const PLUNGE_COOLDOWN = .8;
const IDLE_AFTER = 14, IDLE_INK_BELOW = .05, IDLE_SPACING = 9;

/** Radial impulse (grid uv/s) of a plunge at a given descent speed: the old push's range, now earned by real motion. */
export const plungeImpulse = (descent: number) => .25 + .35 * clamp01((descent - PLUNGE_SPEED) / (PLUNGE_FULL - PLUNGE_SPEED));

/**
 * Turns hand motion into ink drops. Deterministic given its inputs (seeded rng
 * for colour and size variation). Rules:
 *  - A hand's underside crossing the water surface downward (with hysteresis so a hand hovering at
 *    the surface does not chatter) → a bead where it went in: with a radial splash when it came
 *    down faster than PLUNGE_SPEED, gently (and only when `dropOnEnter`) otherwise. Once per
 *    PLUNGE_COOLDOWN per hand. A hand first seen already wet drops nothing until it lifts out.
 *  - Nobody for IDLE_AFTER seconds and hardly any ink left → a lone bead so the bowl never goes dead.
 */
export class DropScheduler {
  private readonly random: () => number;
  private index = 0;
  private readonly wet = new Map<number, { wet: boolean; lastMs: number }>();
  // Scratch set reused across calls so a step allocates nothing when nothing happens.
  private readonly seen = new Set<number>();
  private lastHandTime = -Infinity;
  private lastDropTime = -Infinity;
  constructor(seed = 7) { this.random = rng(seed); }

  /** Beads scattered inside the bowl for the first frame. */
  initial(count: number, bowl: number, palette: string, ink: number): Drop[] {
    const drops: Drop[] = [];
    for (let i = 0; i < count; i++) {
      const a = this.random() * Math.PI * 2, r = bowl * (.15 + .5 * Math.sqrt(this.random()));
      drops.push(this.make({ x: .5 + Math.cos(a) * r, y: .5 + Math.sin(a) * r }, bowl, palette, ink, 1.1, 0));
    }
    return drops;
  }

  /** Appends this step's drops to `drops` (a fresh array when omitted) and returns it. */
  update(ctx: DropContext, drops: Drop[] = []): Drop[] {
    const seen = this.seen;
    seen.clear();
    let added = 0;
    if (ctx.hands.length) this.lastHandTime = ctx.time;
    for (const hand of ctx.hands) {
      seen.add(hand.id);
      // The underside is the hand's lowest point: the deepest capsule of a solid hand, the sphere's bottom otherwise.
      const under = -handClearance(hand, ctx.surface, ctx.aspect);
      const s = this.wet.get(hand.id);
      if (!s) { this.wet.set(hand.id, { wet: under >= WET_BAND, lastMs: -Infinity }); continue; }
      if (!s.wet && under >= WET_BAND) {
        s.wet = true;
        const descent = -hand.velocity.y, plunge = descent >= PLUNGE_SPEED;
        if ((plunge || ctx.dropOnEnter) && ctx.time - s.lastMs >= PLUNGE_COOLDOWN) {
          // The bead lands where the hand went in: under its lowest point.
          const p = simToGrid(handUnderside(hand, ctx.aspect, UNDERSIDE_SCRATCH), ctx.aspect);
          if (insideBowl(p, ctx.bowl)) {
            s.lastMs = ctx.time;
            drops.push(plunge ? this.make(p, ctx.bowl, ctx.palette, ctx.ink, 1.2, plungeImpulse(descent)) : this.make(p, ctx.bowl, ctx.palette, ctx.ink, .9, 0));
            added++;
          }
        }
      } else if (s.wet && under <= -WET_BAND) s.wet = false;
    }
    if (this.wet.size) for (const id of this.wet.keys()) if (!seen.has(id)) this.wet.delete(id);
    if (!ctx.hands.length && ctx.time - this.lastHandTime > IDLE_AFTER && ctx.inkLevel < IDLE_INK_BELOW && ctx.time - this.lastDropTime > IDLE_SPACING) {
      const a = this.random() * Math.PI * 2, r = ctx.bowl * (.1 + .45 * Math.sqrt(this.random()));
      drops.push(this.make({ x: .5 + Math.cos(a) * r, y: .5 + Math.sin(a) * r }, ctx.bowl, ctx.palette, ctx.ink, 1, 0)); added++;
    }
    if (added) this.lastDropTime = ctx.time;
    return drops;
  }

  private make(p: GridPoint, bowl: number, palette: string, ink: number, amount: number, impulse: number): Drop {
    const colors = resolvePalette(palette);
    const base = colors[this.index++ % colors.length];
    const tint = .85 + .3 * this.random();
    const q = clampToBowl(p, bowl);
    return { x: q.x, y: q.y, radius: ink * (.8 + .4 * this.random()), color: [clamp01(base[0] * tint), clamp01(base[1] * tint), clamp01(base[2] * tint)], amount, impulse };
  }
}
