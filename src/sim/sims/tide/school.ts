/**
 * The school of luminous eels in Tide: CPU agents with a few-segment body each.
 *
 * Space is uniform units (picture height = 1, width = aspect, y up), so a circle is round and
 * speeds mean the same in every direction. Each head steers toward a blend of desires:
 *
 *  - wander: a preferred direction that random-walks and relaxes toward the heading (every eel its own);
 *  - schooling: mild alignment and cohesion with neighbours, separation when crowded;
 *  - bounds: a soft push back inside the active area, stronger the closer to the edge;
 *  - boldness: swim to a ring around the hand (radius ≈ hand radius + margin) and circle it, each
 *    eel in its own preferred direction, so they brush around the hand rather than onto a point;
 *  - fear: scatter away from the hand (or the middle) toward the dim edges, where they slow down;
 *  - grip: a fist (`grip` → 1) draws the ring in tighter and pulls harder, so a willing school
 *    coils close around it. It only shapes the approach: fear is untouched, and boldness (which
 *    fear caps) still decides whether they come at all.
 *
 * The body follows the head as a chain of fixed-length links, so turns ripple down it. Everything
 * is deterministic from the seed and the drives; the step allocates nothing.
 */
import { clamp01, rng } from '../../core/math';

export const SEGMENTS = 6;
/** Length of one body link, uniform units. */
export const LINK = .017;
/** Cruising speed, uniform units per second. */
export const BASE_SPEED = .085;
/** Maximum turn rate, radians per second (more when afraid). */
const MAX_TURN = 2.4;
const NEIGHBOUR = .1, SEPARATION = .03, MARGIN = .09;

export interface SchoolHand { x: number; y: number; radius: number }
export interface SchoolBounds { x0: number; y0: number; x1: number; y1: number }
export interface SchoolDrive {
  dt: number;
  /** Mood, 0..1. */
  boldness: number;
  fear: number;
  /** The primary hand in uniform units, or null. */
  hand: SchoolHand | null;
  /** Where the eels may swim, uniform units. */
  bounds: SchoolBounds;
  /** The primary hand's grip, 0 open … 1 fist (smoothed by the caller). Omitted reads as open. */
  grip?: number;
  /** How much a fist shrinks the ring (0..1 of its radius). Default `FIST_COIL`. */
  coil?: number;
  /** Extra pull toward the ring with a fist (multiplier − 1). Default `FIST_PULL`. */
  pull?: number;
}

/** A fist shrinks the ring by this fraction of its radius… */
export const FIST_COIL = .45;
/** …and pulls the school onto it this much harder (1 + this). */
export const FIST_PULL = .8;

/** The ring the bold school circles: a little outside the hand. */
export const ringRadius = (handRadius: number) => Math.max(handRadius * 1.3, handRadius + .035);
/** "Close to the hand" for the closeness signal: twice the hand radius, and always a little beyond the ring. */
/** The ring for a hand with this grip: an open hand gives `ringRadius`, a fist a tighter coil. */
export const coilRadius = (handRadius: number, grip: number, coil = FIST_COIL) => ringRadius(handRadius) * (1 - clamp01(coil) * clamp01(grip));
export const closeRadius = (handRadius: number) => Math.max(2 * handRadius, ringRadius(handRadius) + .05);

export class School {
  readonly count: number;
  /** Body points, `SEGMENTS` per eel, head first. */
  readonly x: Float32Array;
  readonly y: Float32Array;
  readonly heading: Float32Array;
  readonly speed: Float32Array;
  /** Per-eel size and speed character, 0.75..1.25. */
  readonly size: Float32Array;
  /** Undulation phase, radians. */
  readonly phase: Float32Array;
  /** How much the edge has dimmed this eel (0..1), from fear and position. */
  readonly dim: Float32Array;
  private readonly wander: Float32Array;
  private readonly spin: Float32Array;
  private readonly random: () => number;

  constructor(count: number, bounds: SchoolBounds, seed = 7) {
    this.count = Math.max(0, Math.floor(count));
    const n = this.count;
    this.x = new Float32Array(n * SEGMENTS); this.y = new Float32Array(n * SEGMENTS);
    this.heading = new Float32Array(n); this.speed = new Float32Array(n); this.size = new Float32Array(n);
    this.phase = new Float32Array(n); this.dim = new Float32Array(n); this.wander = new Float32Array(n); this.spin = new Float32Array(n);
    this.random = rng(seed);
    const r = this.random;
    const w = bounds.x1 - bounds.x0, h = bounds.y1 - bounds.y0;
    for (let i = 0; i < n; i++) {
      const hx = bounds.x0 + w * (.1 + .8 * r()), hy = bounds.y0 + h * (.1 + .8 * r());
      const a = r() * Math.PI * 2;
      this.heading[i] = a; this.size[i] = .75 + .5 * r(); this.speed[i] = BASE_SPEED * (.8 + .4 * r());
      this.phase[i] = r() * Math.PI * 2; this.wander[i] = a; this.spin[i] = r() < .5 ? -1 : 1;
      for (let s = 0; s < SEGMENTS; s++) { this.x[i * SEGMENTS + s] = hx - Math.cos(a) * LINK * s; this.y[i * SEGMENTS + s] = hy - Math.sin(a) * LINK * s; }
    }
  }

  /** Stretch every x (the canvas changed aspect). */
  rescaleX(ratio: number) { for (let i = 0; i < this.x.length; i++) this.x[i] *= ratio; }

  update(d: SchoolDrive) {
    const n = this.count, dt = d.dt, b = clamp01(d.boldness), f = clamp01(d.fear), r = this.random;
    const { x0, y0, x1, y1 } = d.bounds, cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    const grip = clamp01(d.grip ?? 0), pull = Math.max(0, d.pull ?? FIST_PULL);
    const hand = d.hand, ring = hand ? coilRadius(hand.radius, grip, d.coil ?? FIST_COIL) : 0;
    for (let i = 0; i < n; i++) {
      const k = i * SEGMENTS, px = this.x[k], py = this.y[k], hd = this.heading[i];
      // Wander: a preferred direction that random-walks.
      let lag = hd - this.wander[i];
      lag -= Math.PI * 2 * Math.round(lag / (Math.PI * 2));
      this.wander[i] += (r() - .5) * 3.5 * Math.sqrt(dt) + lag * Math.min(1, dt * .8);
      let dx = Math.cos(this.wander[i]), dy = Math.sin(this.wander[i]);
      // Schooling with neighbours (heads only).
      let ax = 0, ay = 0, mx = 0, my = 0, sx = 0, sy = 0, m = 0;
      for (let j = 0; j < n; j++) {
        if (j === i) continue;
        const qx = this.x[j * SEGMENTS] - px, qy = this.y[j * SEGMENTS] - py, q2 = qx * qx + qy * qy;
        if (q2 > NEIGHBOUR * NEIGHBOUR) continue;
        ax += Math.cos(this.heading[j]); ay += Math.sin(this.heading[j]); mx += qx; my += qy; m++;
        if (q2 < SEPARATION * SEPARATION) { const q = Math.sqrt(q2) + 1e-5, push = (SEPARATION - q) / SEPARATION / q; sx -= qx * push; sy -= qy * push; }
      }
      const calm = 1 - f;
      if (m > 0) {
        const al = Math.sqrt(ax * ax + ay * ay) + 1e-6, co = Math.sqrt(mx * mx + my * my) + 1e-6;
        dx += .6 * calm * ax / al + .35 * calm * (1 - b) * mx / co; dy += .6 * calm * ay / al + .35 * calm * (1 - b) * my / co;
      }
      dx += (2 + 2 * f) * sx; dy += (2 + 2 * f) * sy;
      // Boldness: the ring around the hand, circled.
      if (hand && b > 0) {
        const ux0 = px - hand.x, uy0 = py - hand.y, dist = Math.sqrt(ux0 * ux0 + uy0 * uy0) + 1e-6, ux = ux0 / dist, uy = uy0 / dist;
        const err = Math.max(-1.6, Math.min(1.6, (ring - dist) * 14));
        const tx = -uy * this.spin[i], ty = ux * this.spin[i];
        // A fist pulls harder, but only as far as the school is calm: fear keeps its full say.
        const w = 3.2 * b * (1 + pull * grip * calm);
        dx += w * (tx * (dist < ring * 2.5 ? 1 : .3) + ux * err); dy += w * (ty * (dist < ring * 2.5 ? 1 : .3) + uy * err);
      }
      // Fear: away from the hand (or the middle), out to the edges.
      const ex = Math.min(px - x0, x1 - px), ey = Math.min(py - y0, y1 - py), edge = Math.min(ex, ey);
      const edgeness = 1 - clamp01(edge / .15);
      if (f > 0) {
        const ox = hand ? hand.x : cx, oy = hand ? hand.y : cy;
        const ux0 = px - ox, uy0 = py - oy, dist = Math.sqrt(ux0 * ux0 + uy0 * uy0) + 1e-6;
        // Once out at the edge the push eases, so they patrol the dim margin instead of piling into corners.
        const w = 4 * f * (hand ? 1 : .6) * (1 - .75 * edgeness);
        dx += w * ux0 / dist; dy += w * uy0 / dist;
      }
      // Bounds: a soft wall.
      const wall = 5 + 4 * f;
      if (px - x0 < MARGIN) dx += wall * (MARGIN - (px - x0)) / MARGIN;
      if (x1 - px < MARGIN) dx -= wall * (MARGIN - (x1 - px)) / MARGIN;
      if (py - y0 < MARGIN) dy += wall * (MARGIN - (py - y0)) / MARGIN;
      if (y1 - py < MARGIN) dy -= wall * (MARGIN - (y1 - py)) / MARGIN;
      // Turn toward the wish at a limited rate.
      const want = Math.atan2(dy, dx);
      let turn = want - hd;
      turn -= Math.PI * 2 * Math.round(turn / (Math.PI * 2));
      const maxTurn = MAX_TURN * (1 + .6 * f) * dt;
      const heading = hd + Math.max(-maxTurn, Math.min(maxTurn, turn));
      this.heading[i] = heading;
      // Speed: quick when fleeing near the hand, slow and dim once out at the edges, a little slower circling.
      let near = 0;
      if (hand) { const qx = px - hand.x, qy = py - hand.y; near = 1 - clamp01(Math.sqrt(qx * qx + qy * qy) / .4); }
      const target = BASE_SPEED * (.8 + .4 * (this.size[i] - .75) / .5) * (1 + 1.6 * f * near) * (1 - .5 * f * edgeness) * (1 - .25 * b);
      this.speed[i] += (target - this.speed[i]) * (1 - Math.exp(-dt / .4));
      this.dim[i] = clamp01(f * (.6 + .4 * edgeness));
      this.phase[i] += dt * (5 + 40 * this.speed[i]);
      // Move the head, clamp it inside, and let the body follow.
      let nx = px + Math.cos(heading) * this.speed[i] * dt, ny = py + Math.sin(heading) * this.speed[i] * dt;
      nx = Math.max(x0, Math.min(x1, nx)); ny = Math.max(y0, Math.min(y1, ny));
      this.x[k] = nx; this.y[k] = ny;
      for (let s = 1; s < SEGMENTS; s++) {
        const a = k + s - 1, c = k + s;
        const lx = this.x[c] - this.x[a], ly = this.y[c] - this.y[a], l = Math.sqrt(lx * lx + ly * ly);
        const len = LINK * this.size[i];
        if (l > 1e-6) { this.x[c] = this.x[a] + lx / l * len; this.y[c] = this.y[a] + ly / l * len; }
        else { this.x[c] = this.x[a] - Math.cos(heading) * len; this.y[c] = this.y[a] - Math.sin(heading) * len; }
      }
    }
  }

  /** Fraction of heads within `radius` of (x, y). */
  fractionWithin(x: number, y: number, radius: number): number {
    if (this.count === 0) return 0;
    let c = 0;
    const r2 = radius * radius;
    for (let i = 0; i < this.count; i++) { const dx = this.x[i * SEGMENTS] - x, dy = this.y[i * SEGMENTS] - y; if (dx * dx + dy * dy <= r2) c++; }
    return c / this.count;
  }
}
