/**
 * Hologram calibration: from touches on a projected plane to a rectified frame.
 *
 * A depth camera lying under a Pepper's-ghost hologram sees the hologram plane
 * edge-on, from some arbitrary tilt and rotation. The performer touches nine
 * targets on the picture with a fingertip; each touch is a metric point in the
 * source frame (the bridge's upright box is linear in millimetres on every
 * axis). Those points fix the plane and the affine map from it to the screen,
 * and one capture with the finger pulled back fixes the depth scale, giving a
 * single affine from the source frame to the HOLOGRAM FRAME:
 *
 *   x = screen position, 0 left … 1 right as the viewer sees the picture
 *   y = screen position, 0 top … 1 bottom
 *   z = signed distance from the plane toward the viewer, 1 at the pull-back point
 *
 * which is source-like ([right, down, deep]) so a `SpaceMapping` finishes the
 * job: `HOLOGRAM_FLOOR_MAPPING` for top-down water (screen → x/z, distance →
 * height y, so a touch is in the water and a raised finger is above it).
 */
import { z } from 'zod';
import type { SurfaceField, Vec3 } from '../core/types';
import { mapPointOpen, type SpaceMapping } from './mapping';
import type { Box3, Capsule, DepthSurface, HandObservation } from './types';

/** Row-major 3×3 matrix `m` and translation `t`: `h = m·p + t`. */
export const affine3Schema = z.object({ m: z.array(z.number().finite()).length(9), t: z.array(z.number().finite()).length(3) }).strict();
export type Affine3 = z.infer<typeof affine3Schema>;

export function applyAffine(a: Affine3, p: Vec3): Vec3 {
  const { m, t } = a;
  return { x: m[0] * p.x + m[1] * p.y + m[2] * p.z + t[0], y: m[3] * p.x + m[4] * p.y + m[5] * p.z + t[1], z: m[6] * p.x + m[7] * p.y + m[8] * p.z + t[2] };
}

/** How long a unit step along source x is on the screen (for radii, which follow the x axis). */
export function affineXScale(a: Affine3): number { return Math.hypot(a.m[0], a.m[3]); }

export interface HologramPair { screen: { x: number; y: number }; point: Vec3 }
export interface HologramFit {
  affine: Affine3;
  /** Root-mean-square screen error of the touches, in screen units (1 = the picture's width). */
  rmsError: number;
  /** Per-touch screen error, same units. */
  residuals: number[];
  /** Unit normal of the plane in the source frame, toward the viewer. */
  normal: Vec3;
  /** Source-frame distance from the plane that maps to z = 1. */
  depthSpan: number;
}

const dot = (a: Vec3, b: Vec3) => a.x * b.x + a.y * b.y + a.z * b.z;
const sub = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const scale = (a: Vec3, s: number): Vec3 => ({ x: a.x * s, y: a.y * s, z: a.z * s });
const cross = (a: Vec3, b: Vec3): Vec3 => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
const norm = (a: Vec3) => Math.hypot(a.x, a.y, a.z);
const unit = (a: Vec3): Vec3 => scale(a, 1 / norm(a));

/**
 * Fit the hologram frame. `pullBack` is the fingertip held in front of the plane on the viewer's
 * side; without it, `options.viewer` (any source point on the viewer's side) orients the normal
 * and `options.depthSpan` (source units) sets the depth scale.
 */
export function fitHologram(pairs: HologramPair[], pullBack?: Vec3, options: { viewer?: Vec3; depthSpan?: number } = {}): HologramFit {
  if (pairs.length < 4) throw new Error('Hologram calibration needs at least 4 touches.');
  const n = pairs.length;
  const c: Vec3 = { x: 0, y: 0, z: 0 };
  for (const p of pairs) { c.x += p.point.x / n; c.y += p.point.y / n; c.z += p.point.z / n; }
  // Covariance → eigenvectors; the smallest is the plane normal, the largest two span it.
  const cov = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  for (const p of pairs) {
    const d = sub(p.point, c), v = [d.x, d.y, d.z];
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) cov[i * 3 + j] += v[i] * v[j] / n;
  }
  const { values, vectors } = symmetricEigen3(cov);
  const order = [0, 1, 2].sort((a, b) => values[a] - values[b]);
  const spread = Math.sqrt(Math.max(values[order[1]], 0));
  if (spread < .01) throw new Error('The touches need more spread: they lie almost on a line.');
  let normal = unit(vectors[order[0]]);
  const towardViewer = pullBack ?? options.viewer;
  if (!towardViewer) throw new Error('Hologram calibration needs a pull-back capture or a viewer-side hint.');
  if (dot(normal, sub(towardViewer, c)) < 0) normal = scale(normal, -1);
  let depthSpan = options.depthSpan ?? .2;
  if (pullBack) {
    depthSpan = dot(normal, sub(pullBack, c));
    if (depthSpan < .02) throw new Error('The pull-back capture is too close to the plane. Hold the finger further in front of the picture.');
  }
  // In-plane orthonormal basis: e1 along the source x axis as far as the plane allows.
  let e1 = sub({ x: 1, y: 0, z: 0 }, scale(normal, normal.x));
  if (norm(e1) < .1) e1 = sub({ x: 0, y: 1, z: 0 }, scale(normal, normal.y));
  e1 = unit(e1);
  const e2 = cross(normal, e1);
  // Least squares screen = A·s + b over the in-plane coordinates s = ((p-c)·e1, (p-c)·e2).
  const coords = pairs.map(p => { const d = sub(p.point, c); return [dot(d, e1), dot(d, e2), 1]; });
  const rowX = solveLeastSquares3(coords, pairs.map(p => p.screen.x));
  const rowY = solveLeastSquares3(coords, pairs.map(p => p.screen.y));
  const residuals = pairs.map((p, i) => {
    const s = coords[i];
    return Math.hypot(rowX[0] * s[0] + rowX[1] * s[1] + rowX[2] - p.screen.x, rowY[0] * s[0] + rowY[1] * s[1] + rowY[2] - p.screen.y);
  });
  const rmsError = Math.sqrt(residuals.reduce((sum, r) => sum + r * r, 0) / n);
  // Compose: h_x = rowX[0]·(e1·(p-c)) + rowX[1]·(e2·(p-c)) + rowX[2], likewise y; h_z = normal·(p-c) / depthSpan.
  const mx = [rowX[0] * e1.x + rowX[1] * e2.x, rowX[0] * e1.y + rowX[1] * e2.y, rowX[0] * e1.z + rowX[1] * e2.z];
  const my = [rowY[0] * e1.x + rowY[1] * e2.x, rowY[0] * e1.y + rowY[1] * e2.y, rowY[0] * e1.z + rowY[1] * e2.z];
  const mz = [normal.x / depthSpan, normal.y / depthSpan, normal.z / depthSpan];
  const affine: Affine3 = {
    m: [...mx, ...my, ...mz],
    t: [rowX[2] - (mx[0] * c.x + mx[1] * c.y + mx[2] * c.z), rowY[2] - (my[0] * c.x + my[1] * c.y + my[2] * c.z), -(mz[0] * c.x + mz[1] * c.y + mz[2] * c.z)],
  };
  return { affine: affine3Schema.parse(affine), rmsError, residuals, normal, depthSpan };
}

/** Eigen-decomposition of a symmetric 3×3 (row-major) by cyclic Jacobi rotations. */
function symmetricEigen3(a: number[]): { values: number[]; vectors: Vec3[] } {
  const m = a.slice(), v = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  for (let sweep = 0; sweep < 50; sweep++) {
    const off = Math.abs(m[1]) + Math.abs(m[2]) + Math.abs(m[5]);
    if (off < 1e-15) break;
    for (const [p, q] of [[0, 1], [0, 2], [1, 2]] as const) {
      const apq = m[p * 3 + q];
      if (Math.abs(apq) < 1e-18) continue;
      const theta = (m[q * 3 + q] - m[p * 3 + p]) / (2 * apq);
      const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const cs = 1 / Math.sqrt(t * t + 1), sn = t * cs;
      for (let k = 0; k < 3; k++) { // rotate columns p, q of m and v
        const mkp = m[k * 3 + p], mkq = m[k * 3 + q];
        m[k * 3 + p] = cs * mkp - sn * mkq; m[k * 3 + q] = sn * mkp + cs * mkq;
        const vkp = v[k * 3 + p], vkq = v[k * 3 + q];
        v[k * 3 + p] = cs * vkp - sn * vkq; v[k * 3 + q] = sn * vkp + cs * vkq;
      }
      for (let k = 0; k < 3; k++) { // rotate rows p, q of m
        const mpk = m[p * 3 + k], mqk = m[q * 3 + k];
        m[p * 3 + k] = cs * mpk - sn * mqk; m[q * 3 + k] = sn * mpk + cs * mqk;
      }
    }
  }
  return { values: [m[0], m[4], m[8]], vectors: [0, 1, 2].map(j => ({ x: v[j], y: v[3 + j], z: v[6 + j] })) };
}

/** Least squares x minimizing |A x - b| for rows of 3 via the normal equations. */
function solveLeastSquares3(rows: number[][], b: number[]): number[] {
  const ata = [0, 0, 0, 0, 0, 0, 0, 0, 0], atb = [0, 0, 0];
  rows.forEach((r, k) => { for (let i = 0; i < 3; i++) { atb[i] += r[i] * b[k]; for (let j = 0; j < 3; j++) ata[i * 3 + j] += r[i] * r[j]; } });
  const [a, b1, c, d, e, f, g, h, i] = ata;
  const det = a * (e * i - f * h) - b1 * (d * i - f * g) + c * (d * h - e * g);
  if (Math.abs(det) < 1e-12) throw new Error('The touches need more spread: they lie almost on a line.');
  const inv = [e * i - f * h, c * h - b1 * i, b1 * f - c * e, f * g - d * i, a * i - c * g, c * d - a * f, d * h - e * g, b1 * g - a * h, a * e - b1 * d].map(x => x / det);
  return [0, 1, 2].map(r => inv[r * 3] * atb[0] + inv[r * 3 + 1] * atb[1] + inv[r * 3 + 2] * atb[2]);
}

function affineBox(a: Affine3, box: Box3): Box3 {
  const p = applyAffine(a, box.min), q = applyAffine(a, box.max);
  return { min: { x: Math.min(p.x, q.x), y: Math.min(p.y, q.y), z: Math.min(p.z, q.z) }, max: { x: Math.max(p.x, q.x), y: Math.max(p.y, q.y), z: Math.max(p.z, q.z) } };
}
function affineCapsule(a: Affine3, c: Capsule): Capsule { return { a: applyAffine(a, c.a), b: applyAffine(a, c.b), radius: c.radius * affineXScale(a) }; }

/** A source-frame observation in the hologram frame (unclamped; the mapping clamps). */
export function rectifyObservation(a: Affine3, o: HandObservation): HandObservation {
  return { ...o, position: applyAffine(a, o.position), extent: o.extent ? affineBox(a, o.extent) : undefined, points: o.points?.map(p => applyAffine(a, p)), capsules: o.capsules?.map(c => affineCapsule(a, c)) };
}

/**
 * Re-project a source-frame scan (row 0 = top, byte = nearest depth) through the affine and the
 * mapping into a sim-space surface field (row 0 = bottom, `z` in sim units). The scan is a height
 * field over the CAMERA's view; the hologram frame turns it about, so this scatters every filled
 * cell to its sim cell instead of resampling, keeps the nearest z where cells collide, and closes
 * one-cell gaps. A finger touching the picture becomes a footprint at the touch, at sim height 0.
 */
export function rectifySurface(a: Affine3, mapping: SpaceMapping, surface: DepthSurface, width: number, height: number): SurfaceField {
  const z = new Float32Array(width * height).fill(1), mask = new Uint8Array(width * height);
  const sw = surface.width, sh = surface.height, data = surface.data;
  const p: Vec3 = { x: 0, y: 0, z: 0 };
  for (let row = 0; row < sh; row++) {
    for (let col = 0; col < sw; col++) {
      const byte = data[row * sw + col];
      if (byte === 0) continue;
      p.x = (col + .5) / sw; p.y = (row + .5) / sh; p.z = (byte - 1) / 254;
      const q = mapPointOpen(mapping, applyAffine(a, p));
      if (q.x < 0 || q.x >= 1 || q.y < 0 || q.y >= 1) continue;
      const i = Math.floor(q.y * height) * width + Math.floor(q.x * width);
      const qz = Math.min(1, Math.max(0, q.z));
      if (!mask[i] || qz < z[i]) { z[i] = qz; mask[i] = 255; }
    }
  }
  // Close single-cell gaps left by the scatter (an empty cell between two filled neighbours).
  const filled = mask.slice();
  for (let row = 0; row < height; row++) for (let col = 0; col < width; col++) {
    const i = row * width + col;
    if (filled[i]) continue;
    let count = 0, sum = 0;
    const tap = (j: number) => { if (filled[j]) { count++; sum += z[j]; } };
    if (col > 0) tap(i - 1); if (col < width - 1) tap(i + 1); if (row > 0) tap(i - width); if (row < height - 1) tap(i + width);
    if (count >= 2) { z[i] = sum / count; mask[i] = 255; }
  }
  return { width, height, z, mask };
}

/** Which end of the source depth axis the hologram is on: `far` = w → 1, `near` = w → 0. */
export type HologramSide = 'far' | 'near';

/**
 * Where the fingertip is, in the source frame, for a calibration capture: the skeleton's index tip
 * when a hand is tracked, else the scan cells nearest the hologram side (averaged), else the most
 * confident hand's position. Null when nothing is in view.
 */
export function hologramFingertip(frame: { hands: HandObservation[]; surface?: DepthSurface }, side: HologramSide): Vec3 | null {
  const skeleton = frame.hands.find(h => h.capsules?.length && h.points && h.points.length >= 3);
  if (skeleton) return skeleton.points![2]; // palm, thumb, INDEX, …
  if (frame.surface) {
    const { width: sw, height: sh, data } = frame.surface;
    let extreme = side === 'far' ? -1 : 256;
    for (let i = 0; i < data.length; i++) { const b = data[i]; if (b && (side === 'far' ? b > extreme : b < extreme)) extreme = b; }
    if (extreme >= 1 && extreme <= 255) {
      const band = Math.round(254 * .03); // cells within 3% of the depth range of the extreme
      let n = 0, sx = 0, sy = 0, sz = 0;
      for (let i = 0; i < data.length; i++) {
        const b = data[i];
        if (!b || Math.abs(b - extreme) > band) continue;
        n++; sx += ((i % sw) + .5) / sw; sy += (Math.floor(i / sw) + .5) / sh; sz += (b - 1) / 254;
      }
      if (n >= 1) return { x: sx / n, y: sy / n, z: sz / n };
    }
  }
  if (!frame.hands.length) return null;
  return frame.hands.reduce((best, h) => h.confidence > best.confidence ? h : best, frame.hands[0]).position;
}
