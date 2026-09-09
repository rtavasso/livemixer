/**
 * Helpers for treating hands as solids on the GPU.
 *
 * `packHands` turns the tracked hands into a flat uniform array of capsules in
 * uniform world units (x ∈ [0, aspect], y ∈ [0, 1], z ∈ [0, depth]) plus one
 * bounding sphere per hand, so a shader can skip pixels whose ray misses the
 * hand entirely and evaluate the capsule distance field only where it matters.
 * A hand without a solid shape becomes a single sphere of its `radius`.
 *
 * `handSdfGlsl` emits the matching GLSL: `handDistance(p)` (signed distance to
 * the nearest hand surface, uniform units) and `handBoundsHit(ro, rd)` for the
 * early-out. Simulations that need capsules on the CPU can use `capsuleDistance`.
 */
import { toWorld } from '../core/camera';
import type { Vec3 } from '../core/types';
import type { HandState } from '../input/types';

export const MAX_HAND_CAPSULES = 48;
export const MAX_HAND_BOUNDS = 4;

export interface PackedHands {
  /** capsule i: data[i*8..i*8+3] = a.xyz, radius; data[i*8+4..i*8+7] = b.xyz, 0 */
  capsules: Float32Array;
  count: number;
  /** bound i: center.xyz, radius */
  bounds: Float32Array;
  boundCount: number;
}

export function createPackedHands(): PackedHands {
  return { capsules: new Float32Array(MAX_HAND_CAPSULES * 8), count: 0, bounds: new Float32Array(MAX_HAND_BOUNDS * 4), boundCount: 0 };
}

/** Fill `out` from the tracked hands. Radii follow the x axis (like `HandState.radius`) and are scaled by `aspect`. */
export function packHands(hands: readonly HandState[], aspect: number, depth: number, out: PackedHands): PackedHands {
  let n = 0, b = 0;
  for (const hand of hands) {
    if (b >= MAX_HAND_BOUNDS) break;
    const first = n;
    if (hand.capsules.length) {
      for (const c of hand.capsules) {
        if (n >= MAX_HAND_CAPSULES) break;
        const a = toWorld(c.a, aspect, depth), bb = toWorld(c.b, aspect, depth);
        out.capsules.set([a.x, a.y, a.z, c.radius * aspect, bb.x, bb.y, bb.z, 0], n * 8); n++;
      }
    } else if (n < MAX_HAND_CAPSULES) {
      const p = toWorld(hand.position, aspect, depth);
      out.capsules.set([p.x, p.y, p.z, hand.radius * aspect, p.x, p.y, p.z, 0], n * 8); n++;
    }
    if (n === first) continue;
    // Bounding sphere: centre of the capsule endpoints, radius to the farthest endpoint plus its capsule radius.
    let cx = 0, cy = 0, cz = 0;
    for (let i = first; i < n; i++) { cx += out.capsules[i * 8] + out.capsules[i * 8 + 4]; cy += out.capsules[i * 8 + 1] + out.capsules[i * 8 + 5]; cz += out.capsules[i * 8 + 2] + out.capsules[i * 8 + 6]; }
    const m = 2 * (n - first); cx /= m; cy /= m; cz /= m;
    let r = 0;
    for (let i = first; i < n; i++) {
      for (const o of [0, 4]) { const dx = out.capsules[i * 8 + o] - cx, dy = out.capsules[i * 8 + o + 1] - cy, dz = out.capsules[i * 8 + o + 2] - cz; r = Math.max(r, Math.sqrt(dx * dx + dy * dy + dz * dz) + out.capsules[i * 8 + 3]); }
    }
    out.bounds.set([cx, cy, cz, r], b * 4); b++;
  }
  out.count = n; out.boundCount = b;
  return out;
}

/** Distance from `p` to the surface of capsule a–b with `radius` (negative inside). */
export function capsuleDistance(p: Vec3, a: Vec3, b: Vec3, radius: number): number {
  const abx = b.x - a.x, aby = b.y - a.y, abz = b.z - a.z;
  const apx = p.x - a.x, apy = p.y - a.y, apz = p.z - a.z;
  const len2 = abx * abx + aby * aby + abz * abz;
  const t = len2 > 1e-12 ? Math.min(1, Math.max(0, (apx * abx + apy * aby + apz * abz) / len2)) : 0;
  const dx = apx - abx * t, dy = apy - aby * t, dz = apz - abz * t;
  return Math.sqrt(dx * dx + dy * dy + dz * dz) - radius;
}

/** GLSL (ES 3.00) for the packed hands: declare `uniform vec4 u_capsules[2*MAX]`, `uniform int u_capsuleCount`, `uniform vec4 u_handBounds[MAXB]`, `uniform int u_handBoundCount`. */
export function handSdfGlsl(maxCapsules = MAX_HAND_CAPSULES, maxBounds = MAX_HAND_BOUNDS): string {
  return `
uniform vec4 u_capsules[${maxCapsules * 2}];
uniform int u_capsuleCount;
uniform vec4 u_handBounds[${maxBounds}];
uniform int u_handBoundCount;
float capsuleDist(vec3 p, vec3 a, vec3 b, float r) {
  vec3 ab = b - a, ap = p - a;
  float l2 = dot(ab, ab);
  float t = l2 > 1e-12 ? clamp(dot(ap, ab) / l2, 0.0, 1.0) : 0.0;
  return length(ap - ab * t) - r;
}
float handDistance(vec3 p) {
  float d = 1e9;
  for (int i = 0; i < ${maxCapsules}; i++) {
    if (i >= u_capsuleCount) break;
    vec4 a = u_capsules[i * 2], b = u_capsules[i * 2 + 1];
    d = min(d, capsuleDist(p, a.xyz, b.xyz, a.w));
  }
  return d;
}
// Ray/sphere test against every hand's bounding sphere: returns the entry and exit distances of the union, or exit < entry.
vec2 handBoundsHit(vec3 ro, vec3 rd) {
  vec2 span = vec2(1e9, -1e9);
  for (int i = 0; i < ${maxBounds}; i++) {
    if (i >= u_handBoundCount) break;
    vec4 s = u_handBounds[i];
    vec3 oc = ro - s.xyz;
    float b = dot(oc, rd), c = dot(oc, oc) - s.w * s.w, h = b * b - c;
    if (h < 0.0) continue;
    h = sqrt(h);
    span.x = min(span.x, -b - h); span.y = max(span.y, -b + h);
  }
  return span;
}`;
}
