/**
 * Hands as solids in the light plane.
 *
 * The tracer sees the world as a horizontal plane at the beam's height. Two
 * kinds of solid can stand in it:
 *
 *  - A skeleton hand (`HandState.capsules`, sim space): every capsule that
 *    reaches the plane is handed to the tracer as-is, and the ray test slices
 *    it exactly (a vertical bone reads as a disc of its radius, a bone passing
 *    `dy` above the plane as a disc of radius sqrt(r² − dy²)).
 *  - A depth scan (`SimInput.surface`): the scan row at the plane's height
 *    gives, per column, the depth where the shell starts; the shell is taken
 *    to be `thickness` deep, so each run of scanned cells becomes a band in
 *    the plane, split into straight pieces (convex quads) where its depth
 *    profile bends.
 *
 * Each body is a group with its own bounding disc so rays that miss it test
 * nothing. The solid the beam leaves from must not stop its own light, so an
 * `Emitter` names the beam's origin: solids within `reach` of it are the
 * emitter (a ray's first segment passes through them: the palm, the base of
 * the thumb, a forearm; fingers farther out still shade the beam), and those
 * within `touch` of it are the palm itself, whose extent sizes the clearance
 * disc the rays are started outside of so the beam is seen leaving the hand.
 * For a scan, the run whose cells come within those distances is the emitter.
 *
 * Coordinates: the tracer's x is the volume's x (uniform units), its y is the
 * volume's z (depth), and heights are the volume's y.
 */
import type { SurfaceField } from '../../core/types';
import type { HandState } from '../../input/types';
import { OCCLUDER_STRIDE, type OccluderSet } from './optics';

/** Where a beam leaves a solid, in plane coordinates: x, height, z (the tracer's y); `reach` and `touch` as above, uniform units. */
export interface Emitter { x: number; y: number; z: number; reach: number; touch: number }

/** Distance from a point to a capsule's surface (negative inside), all in world units. */
function pointCapsuleDistance(px: number, py: number, pz: number, ax: number, ay: number, az: number, bx: number, by: number, bz: number, r: number): number {
  const abx = bx - ax, aby = by - ay, abz = bz - az, apx = px - ax, apy = py - ay, apz = pz - az;
  const l2 = abx * abx + aby * aby + abz * abz;
  const t = l2 > 1e-18 ? Math.min(1, Math.max(0, (apx * abx + apy * aby + apz * abz) / l2)) : 0;
  const dx = apx - abx * t, dy = apy - aby * t, dz = apz - abz * t;
  return Math.sqrt(dx * dx + dy * dy + dz * dz) - r;
}

/** Distance from a point in the plane to a convex counter-clockwise quad (negative inside). */
export function pointQuadDistance(px: number, py: number, q: ArrayLike<number>, o = 0): number {
  let inside = true, best = Infinity;
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) & 3, ax = q[o + i * 2], ay = q[o + i * 2 + 1], bx = q[o + j * 2], by = q[o + j * 2 + 1];
    const ex = bx - ax, ey = by - ay, wx = px - ax, wy = py - ay;
    if (ey * wx - ex * wy > 0) inside = false;                                            // outside this edge's half-plane (CCW)
    const t = Math.min(1, Math.max(0, (wx * ex + wy * ey) / (ex * ex + ey * ey || 1)));
    const dx = wx - ex * t, dy = wy - ey * t, d = Math.sqrt(dx * dx + dy * dy);
    if (d < best) best = d;
  }
  return inside ? -best : best;
}

/**
 * Add one hand's capsules (sim space) to the set as a group. With an `emitter`, capsules within its reach are
 * flagged as the emitter and those within its touch as the palm. Returns how many capsules reached the plane.
 */
export function addHandOccluders(occ: OccluderSet, hand: HandState, aspect: number, depth: number, emitter: Emitter | null): number {
  if (!hand.capsules.length) return 0;
  const before = occ.count;
  occ.beginGroup();
  for (const c of hand.capsules) {
    if (occ.full) break;
    const ax = c.a.x * aspect, ay = c.a.y, az = c.a.z * depth, bx = c.b.x * aspect, by = c.b.y, bz = c.b.z * depth, r = c.radius * aspect;
    const d = emitter === null ? Infinity : pointCapsuleDistance(emitter.x, emitter.y, emitter.z, ax, ay, az, bx, by, bz, r);
    occ.addCapsule(ax, ay, az, bx, by, bz, r, emitter !== null && d < emitter.reach, emitter !== null && d < emitter.touch);
  }
  occ.endGroup();
  return occ.count - before;
}

/** Piece boundaries of the scan run being built: pairs of first and last column. */
const pieces = new Int32Array(1024);
const quad = new Float64Array(8);

/**
 * Add the depth scan's slice at the plane's height: each run of scanned cells in that row becomes a group of
 * convex quads, one per straight piece of the run's depth profile (a piece ends where a cell's depth strays
 * more than `tolerance` from the line through the piece's ends), each `thickness` deep behind the shell. With an
 * `emitter`, a run with a piece within its reach is the emitter and pieces within its touch are the palm. Depth
 * units are sim z for `thickness` and `tolerance`; the plane's height is in sim y. Returns the number of quads added.
 */
export function addScanOccluders(occ: OccluderSet, field: SurfaceField, planeY: number, aspect: number, depth: number, thickness: number, tolerance: number, emitter: Emitter | null): number {
  if (!(planeY >= 0 && planeY <= 1) || field.width < 1 || field.height < 1) return 0;
  const row = Math.min(field.height - 1, Math.floor(planeY * field.height)), base = row * field.width, width = field.width;
  const cell = aspect / width, t = thickness * depth, before = occ.count;
  const z = field.z, mask = field.mask;
  let c = 0;
  while (c < width) {
    if (mask[base + c] === 0) { c++; continue; }
    // A run of scanned cells [c, end), cut into straight pieces.
    let end = c + 1;
    while (end < width && mask[base + end] !== 0) end++;
    let pieceCount = 0;
    for (let p0 = c; p0 < end && pieceCount * 2 + 1 < pieces.length;) {
      let p1 = p0;
      while (p1 + 1 < end) {
        const z0 = z[base + p0], z1 = z[base + p1 + 1], n = p1 + 1 - p0;
        let ok = true;
        for (let k = p0 + 1; k <= p1; k++) { if (Math.abs(z[base + k] - (z0 + (z1 - z0) * ((k - p0) / n))) > tolerance) { ok = false; break; } }
        if (!ok) break;
        p1++;
      }
      pieces[pieceCount * 2] = p0; pieces[pieceCount * 2 + 1] = p1; pieceCount++;
      p0 = p1 + 1;
    }
    // The run is the emitter when any piece comes within the emitter's reach of the origin.
    let isEmitter = false;
    if (emitter !== null) {
      for (let p = 0; p < pieceCount && !isEmitter; p++) { pieceQuad(pieces[p * 2], pieces[p * 2 + 1], base, cell, depth, t, z); isEmitter = pointQuadDistance(emitter.x, emitter.z, quad) < emitter.reach; }
    }
    occ.beginGroup();
    for (let p = 0; p < pieceCount; p++) {
      if (occ.full) break;
      pieceQuad(pieces[p * 2], pieces[p * 2 + 1], base, cell, depth, t, z);
      const palm = emitter !== null && pointQuadDistance(emitter.x, emitter.z, quad) < emitter.touch;
      occ.addQuad(quad[0], quad[1], quad[2], quad[3], quad[4], quad[5], quad[6], quad[7], isEmitter, palm);
    }
    occ.endGroup();
    c = end;
  }
  return occ.count - before;
}

/** The band of the shell over columns p0..p1 as a counter-clockwise quad in `quad`: the front edge, then the back edge `t` deeper. */
function pieceQuad(p0: number, p1: number, base: number, cell: number, depth: number, t: number, z: Float32Array) {
  const x0 = p0 * cell, x1 = (p1 + 1) * cell, f0 = z[base + p0] * depth, f1 = z[base + p1] * depth;
  quad[0] = x0; quad[1] = f0; quad[2] = x1; quad[3] = f1; quad[4] = x1; quad[5] = f1 + t; quad[6] = x0; quad[7] = f0 + t;
}

/** The four corners of quad `k` of a set, as x, y pairs (for tests and debugging). */
export function quadCorners(occ: OccluderSet, k: number): number[] { const o = k * OCCLUDER_STRIDE; return Array.from(occ.data.subarray(o, o + 8)); }
