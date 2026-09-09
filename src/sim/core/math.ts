import type { Vec2, Vec3 } from './types';

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
export const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const mix = lerp;
export const smoothstep = (edge0: number, edge1: number, x: number) => {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
};
/** Frame-rate independent exponential approach: returns the new value after `dt` seconds with time constant `tau`. */
export const approach = (current: number, target: number, dt: number, tau: number) =>
  tau <= 0 ? target : current + (target - current) * (1 - Math.exp(-dt / tau));

export const vec2 = (x = 0, y = 0): Vec2 => ({ x, y });
export const vec3 = (x = 0, y = 0, z = 0): Vec3 => ({ x, y, z });
export const add3 = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
export const sub3 = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
export const scale3 = (a: Vec3, s: number): Vec3 => ({ x: a.x * s, y: a.y * s, z: a.z * s });
// sqrt of a sum of squares: Math.hypot is an order of magnitude slower in V8 and these run in hot loops.
export const length3 = (a: Vec3) => Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z);
export const length2 = (a: Vec2) => Math.sqrt(a.x * a.x + a.y * a.y);
export const distance2 = (a: Vec2, b: Vec2) => { const dx = a.x - b.x, dy = a.y - b.y; return Math.sqrt(dx * dx + dy * dy); };

/**
 * Convert sim-space coordinates (each axis spans the canvas independently) to
 * "uniform" units where the canvas height is 1 and the width is `aspect`.
 * In uniform units a circle drawn with equal radius in x and y looks round.
 */
export const toUniform = (p: Vec2 | Vec3, aspect: number): Vec2 => ({ x: p.x * aspect, y: p.y });
export const fromUniform = (p: Vec2, aspect: number): Vec2 => ({ x: p.x / aspect, y: p.y });
/** A hand's `radius` is in sim x units; this is the same radius in uniform units. */
export const uniformRadius = (radiusSimX: number, aspect: number) => radiusSimX * aspect;
/** Sim space [0,1]³ → uniform units: width = aspect, height = 1, depth = `depth` (z into the scene). */
export const toUniform3 = (p: Vec3, aspect: number, depth: number): Vec3 => ({ x: p.x * aspect, y: p.y, z: p.z * depth });

/** Deterministic pseudo-random generator (mulberry32). Simulations must not use Math.random for anything replayable. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Hue (0..1), saturation, value → rgb 0..1. */
export function hsv(h: number, s: number, v: number): [number, number, number] {
  const i = Math.floor(((h % 1) + 1) % 1 * 6);
  const f = (((h % 1) + 1) % 1) * 6 - i;
  const p = v * (1 - s), q = v * (1 - f * s), t = v * (1 - (1 - f) * s);
  switch (i % 6) {
    case 0: return [v, t, p];
    case 1: return [q, v, p];
    case 2: return [p, v, t];
    case 3: return [p, q, v];
    case 4: return [t, p, v];
    default: return [v, p, q];
  }
}
