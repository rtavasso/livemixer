/**
 * Afterglow — pure CPU logic, kept free of WebGL so it can be unit-tested:
 * decay maths, the brush (radius, amplitude and colour of one stroke
 * segment), aerial perspective, the stroke tracker that turns hands into 3D
 * sweeps (one per capsule of a solid hand, or a single point brush), the
 * projection of those through the window camera onto the accumulation
 * buffer, the pool of light on the floor beneath a stroke, the sparkle
 * particle field, the depth meter behind the `depth` signal, and the probe
 * reduction that turns a 16×16 readback into signals.
 *
 * Units: everything here is in "uniform" world units (canvas height = 1,
 * width = aspect, z into the scene up to the volume depth). Strokes are laid
 * down where the hand is IN the volume and projected with the window camera
 * onto the glass; the accumulation buffer holds that 2D projection, normalised
 * so 1.0 is roughly "white", and the renderer applies an exposure before
 * tone-mapping.
 */
import type { Capsule, HandState } from '../../input/types';
import type { SurfaceField } from '../../core/types';
import type { WindowCamera } from '../../core/camera';
import { approach, clamp, clamp01, hsv, rng, smoothstep } from '../../core/math';
import { Noise } from '../../core/noise';

/** A typical hand blob radius in uniform units; the brush scales relative to it. */
export const REFERENCE_HAND_RADIUS = .09;
/** Light deposited per second by a hand that holds still (normalised units, before brightness). */
export const DWELL_RATE = .5;
/** Light deposited per brush-radius of travel (normalised units, before brightness). */
export const TRAVEL_RATE = .25;
/** The hue wanders at most this far (in hue units) from the base hue. */
export const HUE_WANDER = .08;
/** Deposit saturation: a pixel already holding `v` takes `exp(-HEAD_K * v)` of new light. */
export const HEAD_K = 1.5;
/** Deposit amplitude per second that counts as "full ink". */
export const INK_FULL_RATE = 14;
/** Per-hand hue offsets so a second hand reads as a slightly different colour (first toward rose, then toward gold). */
export const HUE_OFFSETS = [0, -.06, .06, -.12, .12] as const;

export const wrapHue = (h: number) => ((h % 1) + 1) % 1;

/**
 * Slow, deterministic wander of the hue around its base: Perlin noise along
 * time keeps the palette coherent (amber drifts toward rose or gold) instead
 * of rotating through every colour. `rate` is in noise features per second.
 */
export function hueWander(base: number, time: number, rate: number, noise: Noise): number {
  const n = clamp(noise.noise2(time * Math.max(0, rate) + 7.3, .5) * 1.4, -1, 1);
  return wrapHue(base + HUE_WANDER * n);
}

// ---------------------------------------------------------------------------
// Decay
// ---------------------------------------------------------------------------

/** Multiplicative decay for `dt` seconds. A stroke drops to e^-4 (≈2%) of its brightness after `lifetime` seconds. */
export function decayFor(dt: number, lifetime: number): number {
  const tau = Math.max(.05, lifetime) / 4;
  return Math.exp(-Math.max(0, dt) / tau);
}

/**
 * Linear floor subtracted per second. An exponential tail never reaches zero
 * and gamma makes even 1% light visibly grey, so a small linear term finishes
 * the fade to true black in about `lifetime` seconds. RGBA8 targets need a
 * larger floor or rounding would leave pixels stuck a few counts above black.
 */
export function floorFor(lifetime: number, hdr: boolean): number {
  return hdr ? .025 / Math.max(.05, lifetime) : .15;
}

/** Saturating deposit: the brighter a pixel already is, the less new light it takes, so overlaps bloom toward white without exploding. */
export function deposit(old: number, add: number): number {
  return old + add * Math.exp(-HEAD_K * old);
}

/** One accumulation update for a single channel: decay, floor, then deposit. Mirrors the GPU pass. */
export function accumulate(old: number, add: number, decay: number, floor: number): number {
  return deposit(Math.max(0, old * decay - floor), add);
}

// ---------------------------------------------------------------------------
// Aerial perspective
// ---------------------------------------------------------------------------

/** At full `depthFade` a stroke at the back wall deposits 1 / (1 + DEPTH_DIM) of what it would at the glass. */
export const DEPTH_DIM = 2;
/** At full `depthFade` the colour at the back wall is moved this far toward its cooled version. */
export const DEPTH_COOL = .6;
/** Per-channel multiplier of a fully cooled colour: deeper light loses red and keeps blue, like haze. */
export const COOL_TINT: readonly [number, number, number] = [.7, .85, 1.1];

/** Brightness multiplier for light at normalised depth `z01` (0 at the glass … 1 at the back wall). 1 at the glass or without fade. */
export function depthAttenuation(z01: number, depthFade: number): number {
  return 1 / (1 + DEPTH_DIM * clamp01(depthFade) * clamp01(z01));
}

/** Cool a colour with depth, keeping its peak channel: brightness stays the job of `depthAttenuation`. */
export function depthTint(r: number, g: number, b: number, z01: number, depthFade: number): [number, number, number] {
  const t = DEPTH_COOL * clamp01(depthFade) * clamp01(z01);
  if (t <= 0) return [r, g, b];
  const peak = Math.max(r, g, b);
  const cr = r * (1 + (COOL_TINT[0] - 1) * t), cg = g * (1 + (COOL_TINT[1] - 1) * t), cb = b * (1 + (COOL_TINT[2] - 1) * t);
  const norm = peak > 1e-6 ? peak / Math.max(cr, cg, cb, 1e-6) : 1;
  return [cr * norm, cg * norm, cb * norm];
}

// ---------------------------------------------------------------------------
// Brush
// ---------------------------------------------------------------------------

export interface BrushParams { brushSize: number; brightness: number; saturation: number; hue: number; depthFade: number }

/** Brush radius in world units: scales with the hand blob and gently with speed. Perspective, not the brush, makes a deep stroke small. */
export function brushRadius(brushSize: number, handRadius: number, speed: number): number {
  const size = .55 + .45 * clamp(handRadius / REFERENCE_HAND_RADIUS, .3, 2.5);
  return brushSize * size * (1 + .3 * clamp01(speed / 1.5));
}

/**
 * Light a segment deposits at its centre line (normalised units), before
 * depth attenuation. The travel term makes a stroke's total brightness
 * independent of how many steps it took (and, since a projected length and
 * radius shrink together, of its depth); the dwell term lets a still hand
 * slowly brighten its spot; speed boosts both, so a fast push flares.
 */
export function brushAmplitude(brightness: number, length: number, radius: number, speed: number, dt: number): number {
  const travel = TRAVEL_RATE * length / Math.max(radius, 1e-4);
  const dwell = DWELL_RATE * Math.max(0, dt);
  const boost = .55 + .75 * clamp01(speed / 1.5);
  return Math.max(0, brightness) * (travel + dwell) * boost;
}

/** Stroke colour: base hue shifted subtly by the direction of movement, plus a per-hand offset. Value is always 1 (max channel). */
export function strokeColor(hue: number, saturation: number, dx: number, dy: number, offset = 0): [number, number, number] {
  const shift = dx * dx + dy * dy > 1e-12 ? .025 * Math.sin(Math.atan2(dy, dx)) : 0;
  return hsv(wrapHue(hue + shift + offset), clamp01(saturation), 1);
}

/** Compact, soft brush falloff over normalised distance `t = d / radius`: 1 at the centre, 0 at and beyond the edge. */
export function brushKernel(t: number): number {
  if (t >= 1) return 0;
  const w = 1 - t * t;
  return w * w * w;
}

/** Distance from a point to a segment (a degenerate segment is a point). */
export function segmentDistance(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const abx = bx - ax, aby = by - ay;
  const len2 = abx * abx + aby * aby;
  const t = len2 > 1e-12 ? clamp01(((px - ax) * abx + (py - ay) * aby) / len2) : 0;
  return Math.hypot(px - (ax + abx * t), py - (ay + aby * t));
}

/** Light a projected segment adds at a point on the glass: the brush kernel plus a tighter warm-white core. Mirrors the GPU pass. */
export function segmentLight(seg: { ax: number; ay: number; bx: number; by: number; radius: number; amplitude: number }, px: number, py: number): { colour: number; white: number } {
  const w = brushKernel(segmentDistance(px, py, seg.ax, seg.ay, seg.bx, seg.by) / Math.max(seg.radius, 1e-6));
  return { colour: seg.amplitude * w, white: seg.amplitude * .35 * w * w * w };
}

/** Whether `p` lies inside triangle a, b, c (either winding). A degenerate triangle contains nothing, so a point brush never paints a plateau. */
function insideTriangle(px: number, py: number, ax: number, ay: number, bx: number, by: number, cx: number, cy: number): boolean {
  const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  if (Math.abs(area) < 1e-12) return false;
  const s1 = (bx - ax) * (py - ay) - (by - ay) * (px - ax);
  const s2 = (cx - bx) * (py - by) - (cy - by) * (px - bx);
  const s3 = (ax - cx) * (py - cy) - (ay - cy) * (px - cx);
  return (s1 >= 0 && s2 >= 0 && s3 >= 0) || (s1 <= 0 && s2 <= 0 && s3 <= 0);
}

/**
 * Distance from a point to the area a segment sweeps as it moves from a0–b0
 * to a1–b1: 0 anywhere inside the swept quad, else the distance to its
 * nearest edge (the two capsule positions and the two endpoint paths). Both
 * diagonals split the quad so a rotating capsule leaves no hole; a point
 * brush (a = b) reduces to the distance to its path. Mirrors the GPU pass.
 */
export function sweepDistance(px: number, py: number, ax0: number, ay0: number, bx0: number, by0: number, ax1: number, ay1: number, bx1: number, by1: number): number {
  if (insideTriangle(px, py, ax0, ay0, bx0, by0, bx1, by1) || insideTriangle(px, py, ax0, ay0, bx1, by1, ax1, ay1)
    || insideTriangle(px, py, ax0, ay0, bx0, by0, ax1, ay1) || insideTriangle(px, py, bx0, by0, bx1, by1, ax1, ay1)) return 0;
  return Math.min(
    segmentDistance(px, py, ax0, ay0, bx0, by0), segmentDistance(px, py, ax1, ay1, bx1, by1),
    segmentDistance(px, py, ax0, ay0, ax1, ay1), segmentDistance(px, py, bx0, by0, bx1, by1),
  );
}

// ---------------------------------------------------------------------------
// Solid hands: capsules as brushes
// ---------------------------------------------------------------------------

/** The `brushSize` at which a solid hand's capsules paint with exactly their own thickness. */
export const DEFAULT_BRUSH_SIZE = .065;
/** Floor on a capsule's brush radius (world units): a fingertip trail stays a few pixels wide even at half resolution. */
export const MIN_CAPSULE_BRUSH = .012;
/**
 * Exponent of the solid-hand normalisation. A full skeleton sweeps a footprint
 * some 50× that of the sphere brush it replaces (and thin bones deposit more
 * per pixel for the same travel): 0 would keep per-pixel brightness and make
 * the hand 50× brighter in total, 1 would keep the total and starve every
 * pixel; ½ is the geometric mean, about 7× the total at half the brightness.
 */
export const SOLID_NORM = .5;
/** Time constant of a capsule's speed estimate (its own displacement per step, smoothed). */
export const CAPSULE_SPEED_TAU = .06;
/** Sparkle weight of a fingertip capsule relative to any other capsule of the same hand. */
export const TIP_SPARKLE_BIAS = 8;

/** Brush radius of a capsule of world radius `radius`, scaled by `brushSize / DEFAULT_BRUSH_SIZE`. */
export function capsuleBrush(radius: number, brushSize: number): number {
  return Math.max(MIN_CAPSULE_BRUSH, radius * Math.max(0, brushSize) / DEFAULT_BRUSH_SIZE);
}

/** Squared distance between two sim-space points is exactly zero when a skeleton reuses a joint for two bones. */
const sameJoint = (a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }) => {
  const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
  return dx * dx + dy * dy + dz * dz < 1e-10;
};

/**
 * Mark the capsules whose distal end `b` is a fingertip: an end no other
 * capsule touches. Bones are built base → tip by every skeleton source, so a
 * free proximal end (a Leap carpal base) does not count, and the thickest
 * capsule (the forearm, whose free end is the elbow side) is excluded. A
 * lone capsule has no tips.
 */
export function capsuleTips(capsules: readonly Capsule[], out: Uint8Array = new Uint8Array(capsules.length)): Uint8Array {
  const n = capsules.length;
  let thickest = -1, thick = -1;
  for (let i = 0; i < n; i++) if (capsules[i].radius > thick) { thick = capsules[i].radius; thickest = i; }
  for (let i = 0; i < n; i++) {
    let free = i === thickest ? 0 : 1;
    const b = capsules[i].b;
    for (let j = 0; j < n && free; j++) if (j !== i && (sameJoint(capsules[j].a, b) || sameJoint(capsules[j].b, b))) free = 0;
    out[i] = free;
  }
  return out;
}

/**
 * Amplitude scale for a solid hand: `(reference / footprint) ^ SOLID_NORM`,
 * never above 1. `footprint` is Σ (length + 2·radius) · sphereRadius / radius
 * over the capsules (the area each sweeps per unit of travel, weighted by how
 * much brighter its thinner brush is per pixel) and `reference` is the sphere
 * brush's 2·sphereRadius, so a hand that is exactly the sphere keeps gain 1.
 */
export function solidGain(footprint: number, reference: number): number {
  if (!(footprint > 0) || !(reference > 0)) return 1;
  return Math.min(1, (reference / footprint) ** SOLID_NORM);
}

// ---------------------------------------------------------------------------
// Strokes: hands → sweeps in the volume
// ---------------------------------------------------------------------------

/**
 * One capsule's stroke for one step: the capsule where it was (a0–b0) and
 * where it is now (a1–b1), in world units; the GPU deposits light over the
 * area swept between them. A point brush has a = b at both ends.
 */
export interface CapsuleStroke {
  ax0: number; ay0: number; az0: number; bx0: number; by0: number; bz0: number;
  ax1: number; ay1: number; az1: number; bx1: number; by1: number; bz1: number;
  /** Brush radius in world units, before perspective. */
  radius: number;
  /** Light over the swept area, already attenuated for depth and normalised for the hand. */
  amplitude: number;
  /** Colour, already cooled for depth. */
  r: number; g: number; b: number;
  /** Normalised depth of the sweep's centre: 0 at the glass, 1 at the back wall. */
  z01: number;
  /** 1 when the distal end `b` is a fingertip (sparkles are shed from there), else 0. */
  tip: number;
  /** Travel since the previous step (mean of both ends), smoothed 3D speed, and world velocity. */
  length: number; speed: number; vx: number; vy: number; vz: number;
}

export interface StrokeSegment {
  /** Endpoints in world units: x across, y up, z into the volume. */
  ax: number; ay: number; az: number; bx: number; by: number; bz: number;
  /** Brush radius in world units at the stroke, before perspective. */
  radius: number;
  /** Light at the centre line, already attenuated for depth. */
  amplitude: number;
  /** Colour, already cooled for depth. */
  r: number; g: number; b: number;
  /** Normalised depth of the segment's midpoint: 0 at the glass, 1 at the back wall. */
  z01: number;
  /** 3D travel since the previous step, 3D speed, and world velocity. */
  length: number; speed: number; vx: number; vy: number; vz: number;
  /** What paints this hand: one sweep per capsule of a solid hand, or the segment itself as a point brush. */
  strokes: CapsuleStroke[];
  /** Number of capsules the source supplied (0 for the point brush). */
  solid: number;
  /** This hand's hue offset (`HUE_OFFSETS`), so the scan can colour its cells like the hand. */
  hueOffset: number;
}

interface HandMemory {
  x: number; y: number; z: number; offset: number;
  /** Capsules seen last step: 6 numbers (a.xyz, b.xyz) each in world units, their smoothed speeds, and tip flags. `count` is 0 until a skeleton has been seen. */
  count: number; ends: Float64Array; speeds: Float32Array; tips: Uint8Array;
}

const NO_ENDS = new Float64Array(0), NO_FLOATS = new Float32Array(0), NO_BYTES = new Uint8Array(0);

/**
 * Remembers where each hand, and each of its capsules, was last step so every
 * step yields a segment per hand (a dot for a hand seen for the first time)
 * and a sweep per capsule. The segment is the hand as a sphere brush, which
 * still drives the floor pool, the `ink` and `depth` signals and the sparkle
 * budget; when the source supplies a skeleton the capsule sweeps paint
 * instead of it, otherwise the segment itself is the single sweep.
 */
export class StrokeTracker {
  private readonly last = new Map<number, HandMemory>();
  private seen = 0;

  update(hands: readonly HandState[], aspect: number, depth: number, dt: number, params: BrushParams): StrokeSegment[] {
    const out: StrokeSegment[] = [];
    const present = new Set<number>();
    for (const hand of hands) {
      present.add(hand.id);
      const x = hand.position.x * aspect, y = hand.position.y, z = hand.position.z * depth;
      let prev = this.last.get(hand.id);
      if (!prev) { prev = { x, y, z, offset: HUE_OFFSETS[this.seen++ % HUE_OFFSETS.length], count: 0, ends: NO_ENDS, speeds: NO_FLOATS, tips: NO_BYTES }; this.last.set(hand.id, prev); }
      const vx = hand.velocity.x * aspect, vy = hand.velocity.y, vz = hand.velocity.z * depth;
      const speed = Math.sqrt(vx * vx + vy * vy + vz * vz);
      const dx = x - prev.x, dy = y - prev.y, dz = z - prev.z;
      const length = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const z01 = depth > 0 ? clamp01((prev.z + z) * .5 / depth) : 0;
      const radius = brushRadius(params.brushSize, hand.radius * aspect, speed);
      const amplitude = brushAmplitude(params.brightness, length, radius, speed, dt) * depthAttenuation(z01, params.depthFade);
      const [r, g, b] = depthTint(...strokeColor(params.hue, params.saturation, dx, dy, prev.offset), z01, params.depthFade);
      const seg: StrokeSegment = { ax: prev.x, ay: prev.y, az: prev.z, bx: x, by: y, bz: z, radius, amplitude, r, g, b, z01, length, speed, vx, vy, vz, strokes: [], solid: hand.capsules.length, hueOffset: prev.offset };
      if (hand.capsules.length) this.sweepCapsules(hand.capsules, prev, seg, aspect, depth, dt, params);
      else {
        prev.count = 0;
        seg.strokes.push({ ax0: seg.ax, ay0: seg.ay, az0: seg.az, bx0: seg.ax, by0: seg.ay, bz0: seg.az, ax1: x, ay1: y, az1: z, bx1: x, by1: y, bz1: z, radius, amplitude, r, g, b, z01, tip: 0, length, speed, vx, vy, vz });
      }
      out.push(seg);
      prev.x = x; prev.y = y; prev.z = z;
    }
    for (const id of this.last.keys()) if (!present.has(id)) this.last.delete(id);
    return out;
  }

  /** One sweep per capsule, from where it was last step to where it is now; a skeleton seen for the first time (or after a change of shape) paints dots. */
  private sweepCapsules(capsules: readonly Capsule[], memory: HandMemory, seg: StrokeSegment, aspect: number, depth: number, dt: number, params: BrushParams) {
    const n = capsules.length;
    if (memory.ends.length !== n * 6) { memory.ends = new Float64Array(n * 6); memory.speeds = new Float32Array(n); memory.tips = new Uint8Array(n); memory.count = 0; }
    const ends = memory.ends, speeds = memory.speeds, fresh = memory.count !== n;
    if (fresh) {
      for (let i = 0; i < n; i++) {
        const c = capsules[i], o = i * 6;
        ends[o] = c.a.x * aspect; ends[o + 1] = c.a.y; ends[o + 2] = c.a.z * depth; ends[o + 3] = c.b.x * aspect; ends[o + 4] = c.b.y; ends[o + 5] = c.b.z * depth;
        speeds[i] = seg.speed;
      }
    }
    capsuleTips(capsules, memory.tips);
    // The hand's footprint against the sphere brush's, for the normalisation.
    let footprint = 0;
    for (let i = 0; i < n; i++) {
      const c = capsules[i];
      const lx = (c.b.x - c.a.x) * aspect, ly = c.b.y - c.a.y, lz = (c.b.z - c.a.z) * depth;
      const r = capsuleBrush(c.radius * aspect, params.brushSize);
      footprint += (Math.sqrt(lx * lx + ly * ly + lz * lz) + 2 * r) * seg.radius / r;
    }
    const gain = solidGain(footprint, 2 * seg.radius);
    const inv = dt > 0 ? 1 / dt : 0;
    for (let i = 0; i < n; i++) {
      const c = capsules[i], o = i * 6;
      const ax0 = ends[o], ay0 = ends[o + 1], az0 = ends[o + 2], bx0 = ends[o + 3], by0 = ends[o + 4], bz0 = ends[o + 5];
      const ax1 = c.a.x * aspect, ay1 = c.a.y, az1 = c.a.z * depth, bx1 = c.b.x * aspect, by1 = c.b.y, bz1 = c.b.z * depth;
      const dax = ax1 - ax0, day = ay1 - ay0, daz = az1 - az0, dbx = bx1 - bx0, dby = by1 - by0, dbz = bz1 - bz0;
      const length = (Math.sqrt(dax * dax + day * day + daz * daz) + Math.sqrt(dbx * dbx + dby * dby + dbz * dbz)) * .5;
      const mx = (dax + dbx) * .5, my = (day + dby) * .5, mz = (daz + dbz) * .5;
      const vx = fresh ? seg.vx : mx * inv, vy = fresh ? seg.vy : my * inv, vz = fresh ? seg.vz : mz * inv;
      const speed = speeds[i] = approach(speeds[i], fresh ? seg.speed : length * inv, dt, CAPSULE_SPEED_TAU);
      const radius = capsuleBrush(c.radius * aspect, params.brushSize);
      const z01 = depth > 0 ? clamp01((az0 + bz0 + az1 + bz1) * .25 / depth) : 0;
      const amplitude = brushAmplitude(params.brightness, length, radius, speed, dt) * depthAttenuation(z01, params.depthFade) * gain;
      const [r, g, b] = depthTint(...strokeColor(params.hue, params.saturation, mx, my, memory.offset), z01, params.depthFade);
      seg.strokes.push({ ax0, ay0, az0, bx0, by0, bz0, ax1, ay1, az1, bx1, by1, bz1, radius, amplitude, r, g, b, z01, tip: memory.tips[i], length, speed, vx, vy, vz });
      ends[o] = ax1; ends[o + 1] = ay1; ends[o + 2] = az1; ends[o + 3] = bx1; ends[o + 4] = by1; ends[o + 5] = bz1;
    }
    memory.count = n;
  }

  get tracked() { return this.last.size; }
  reset() { this.last.clear(); }
}

// ---------------------------------------------------------------------------
// Scanned surface: the shell paints where it moves
// ---------------------------------------------------------------------------

/** Brush radius of a scan cell in cells (at the default brush size): neighbours overlap into a continuous silhouette. */
export const SCAN_RADIUS_CELLS = 2;
/** Light a cell deposits (normalised units, before brightness, speed and depth) when the shell first covers it. */
export const SCAN_RATE = .035;
/** Depth movement (world units) a cell ignores in one step: a depth camera's noise on a still hand must paint nothing. */
export const SCAN_DEPTH_NOISE = .008;
/** Depth movement (world units, beyond the noise) in one step at which a cell counts as fully changed. */
export const SCAN_DEPTH_STEP = .04;

/** How much a cell that stayed scanned changed, 0..1, from how far its depth moved (world units) this step. */
export function scanWeight(depthMoved: number): number {
  return clamp01((Math.abs(depthMoved) - SCAN_DEPTH_NOISE) / SCAN_DEPTH_STEP);
}
/** Most scan cells turned into strokes per step; beyond it cells are decimated and their light pooled. */
export const SCAN_BUDGET = 512;
/** A scan dot grows to this many times the hand's travel in the step, so consecutive stamps of a fast hand (or a slow frame) still join into one trail. */
export const SCAN_SWEEP = 1;

/** Light a scan cell deposits: `weight` is how much of it changed (0..1); speed boosts it like the brush. */
export function scanAmplitude(brightness: number, weight: number, speed: number): number {
  return Math.max(0, brightness) * SCAN_RATE * clamp01(weight) * (.55 + .75 * clamp01(speed / 1.5));
}

/** Brush radius of a scan cell in world units: `SCAN_RADIUS_CELLS` cells, scaled by the brush size but never under one cell. */
export function scanBrush(cell: number, brushSize: number): number {
  return Math.max(cell, SCAN_RADIUS_CELLS * cell * Math.max(0, brushSize) / DEFAULT_BRUSH_SIZE);
}

/** Radius of a scan dot whose hand travelled `travel` this step, and the amplitude factor that spreads the same light over the larger dot. */
export function scanDotSize(brush: number, travel: number): { radius: number; gain: number } {
  const radius = Math.max(brush, SCAN_SWEEP * Math.max(0, travel));
  return { radius, gain: (brush / radius) ** 2 };
}

/** What the scan paints this step: dot strokes for the cells that changed, silhouette-edge cells for sparkles, and the changed-cell total. */
export interface ScanStrokes { strokes: CapsuleStroke[]; edges: CapsuleStroke[]; covered: number }

export const createScanStrokes = (): ScanStrokes => ({ strokes: [], edges: [], covered: 0 });

/**
 * Turns the scanned surface into strokes: every cell the shell newly covers,
 * or whose depth moved, becomes a dot at the cell's 3D position (weighted by
 * the change), so a moving hand leaves a trail the shape of its silhouette
 * and a still hand leaves nothing. The scan seen first after a gap only
 * records, like the point brush's first dot. Cells on the silhouette edge
 * (a masked cell with an unmasked neighbour inside the grid) are returned for
 * sparkles. Speed, velocity, travel and hue come from the nearest tracked
 * hand's segment; a hand that travelled far this step (a fast sweep, or a
 * slow frame) grows its dots so the stamps join. Allocates only when the
 * scan's size changes.
 */
export class SurfacePainter {
  private width = 0; private height = 0;
  private prevZ = new Float32Array(0); private prevMask = new Uint8Array(0);
  private primed = false;

  /** Forget the previous scan: the next one only records. */
  reset() { this.primed = false; }

  update(surface: SurfaceField | null, segments: readonly StrokeSegment[], aspect: number, depth: number, params: BrushParams, out: ScanStrokes): ScanStrokes {
    out.strokes.length = 0; out.edges.length = 0; out.covered = 0;
    if (!surface) { this.primed = false; return out; }
    const { width, height, z, mask } = surface;
    if (width !== this.width || height !== this.height || z.length !== width * height) {
      this.width = width; this.height = height; this.prevZ = new Float32Array(width * height); this.prevMask = new Uint8Array(width * height); this.primed = false;
    }
    const prevZ = this.prevZ, prevMask = this.prevMask, n = width * height;
    if (this.primed) {
      // Pass 1: how many cells changed, so a wild frame can be decimated to the budget with its light pooled.
      let changed = 0;
      for (let i = 0; i < n; i++) if (mask[i] && (!prevMask[i] || scanWeight((z[i] - prevZ[i]) * depth) > 0)) changed++;
      const stride = Math.max(1, Math.ceil(changed / SCAN_BUDGET));
      const cell = Math.max(aspect / width, 1 / height), brush = scanBrush(cell, params.brushSize);
      const colours = segments.map(s => strokeColor(params.hue, params.saturation, s.vx, s.vy, s.hueOffset));
      const still = strokeColor(params.hue, params.saturation, 0, 0);
      let k = 0;
      for (let row = 0; row < height; row++) for (let col = 0; col < width; col++) {
        const i = row * width + col, m = mask[i];
        if (m) {
          const wx = (col + .5) / width * aspect, y = (row + .5) / height, wz = z[i] * depth, z01 = clamp01(z[i]);
          const weight = prevMask[i] ? scanWeight(wz - prevZ[i] * depth) : 1;
          const edge = (col > 0 && !mask[i - 1]) || (col < width - 1 && !mask[i + 1]) || (row > 0 && !mask[i - width]) || (row < height - 1 && !mask[i + width]);
          if (weight > 0 || edge) {
            // The nearest tracked hand lends its speed, velocity, travel and hue.
            let nearest = -1, best = Infinity;
            for (let h = 0; h < segments.length; h++) { const dx = segments[h].bx - wx, dy = segments[h].by - y, d = dx * dx + dy * dy; if (d < best) { best = d; nearest = h; } }
            const seg = nearest >= 0 ? segments[nearest] : null;
            const vx = seg ? seg.vx : 0, vy = seg ? seg.vy : 0, vz = seg ? seg.vz : 0, speed = seg ? seg.speed : 0;
            const [r, g, b] = depthTint(...(seg ? colours[nearest] : still), z01, params.depthFade);
            if (weight > 0) {
              out.covered += weight;
              if (k++ % stride === 0) {
                const { radius, gain } = scanDotSize(brush, seg ? seg.length : 0);
                out.strokes.push(scanDot(wx, y, wz, radius, scanAmplitude(params.brightness, weight, speed) * depthAttenuation(z01, params.depthFade) * stride * gain, r, g, b, z01, 0, speed, vx, vy, vz));
              }
            }
            if (edge) out.edges.push(scanDot(wx, y, wz, brush, 0, r, g, b, z01, 1, speed, vx, vy, vz));
          }
        }
        prevZ[i] = z[i]; prevMask[i] = m;
      }
    } else {
      prevZ.set(z); prevMask.set(mask); this.primed = true;
    }
    return out;
  }
}

/** A scan cell as a degenerate stroke (all four ends at the cell's world position). */
function scanDot(x: number, y: number, z: number, radius: number, amplitude: number, r: number, g: number, b: number, z01: number, tip: number, speed: number, vx: number, vy: number, vz: number): CapsuleStroke {
  return { ax0: x, ay0: y, az0: z, bx0: x, by0: y, bz0: z, ax1: x, ay1: y, az1: z, bx1: x, by1: y, bz1: z, radius, amplitude, r, g, b, z01, tip, length: 0, speed, vx, vy, vz };
}

/** The strokes that paint this step: the scan's whenever a scan exists (even one that painted nothing), else every hand's capsule sweeps or point brush. */
export function paintingStrokes(scan: ScanStrokes | null, segments: readonly StrokeSegment[], out: CapsuleStroke[] = []): CapsuleStroke[] {
  out.length = 0;
  if (scan) { for (const s of scan.strokes) out.push(s); return out; }
  for (const seg of segments) for (const s of seg.strokes) out.push(s);
  return out;
}

/** Recent stroke energy target 0..1 from the deposit amplitude of one step. */
export function inkTarget(amplitudePerStep: number, dt: number): number {
  return clamp01(amplitudePerStep / Math.max(dt, 1e-3) / INK_FULL_RATE);
}

/** How many sparkles (fractional) a segment sheds this step, before the `sparkle` param scales it. */
export function sparkleRate(length: number, radius: number, dt: number): number {
  return 30 * length / Math.max(radius, 1e-4) + .8 * Math.max(0, dt);
}

// ---------------------------------------------------------------------------
// Projection: the volume → the glass
// ---------------------------------------------------------------------------

/** NDC → the glass in uniform units, the space the accumulation buffer is drawn in. */
const glassX = (ndcX: number, aspect: number) => (ndcX * .5 + .5) * aspect;
const glassY = (ndcY: number) => ndcY * .5 + .5;

/** A stroke segment as the accumulation pass sees it: endpoints on the glass, apparent radius, and where it was in depth. */
export interface ProjectedSegment { ax: number; ay: number; bx: number; by: number; radius: number; scale: number; z01: number }

/** Project both endpoints through the window camera; the brush radius shrinks by the perspective scale at the segment's depth. */
export function projectSegment(seg: { ax: number; ay: number; az: number; bx: number; by: number; bz: number; radius: number }, camera: WindowCamera): ProjectedSegment {
  const a = camera.project({ x: seg.ax, y: seg.ay, z: seg.az }), b = camera.project({ x: seg.bx, y: seg.by, z: seg.bz });
  const zMid = (seg.az + seg.bz) * .5, scale = camera.scale(zMid);
  return {
    ax: glassX(a.x, camera.aspect), ay: glassY(a.y), bx: glassX(b.x, camera.aspect), by: glassY(b.y),
    radius: seg.radius * scale, scale, z01: camera.depth > 0 ? clamp01(zMid / camera.depth) : 0,
  };
}

/** A capsule sweep as the stroke pass sees it: both capsules on the glass, the apparent radius at the sweep's mean depth. */
export interface ProjectedSweep { ax0: number; ay0: number; bx0: number; by0: number; ax1: number; ay1: number; bx1: number; by1: number; radius: number; scale: number; z01: number }

/** Project all four ends of a sweep through the window camera; the brush radius shrinks by the perspective scale at the mean depth. */
export function projectSweep(s: CapsuleStroke, camera: WindowCamera): ProjectedSweep {
  const a0 = camera.project({ x: s.ax0, y: s.ay0, z: s.az0 }), b0 = camera.project({ x: s.bx0, y: s.by0, z: s.bz0 });
  const a1 = camera.project({ x: s.ax1, y: s.ay1, z: s.az1 }), b1 = camera.project({ x: s.bx1, y: s.by1, z: s.bz1 });
  const zMid = (s.az0 + s.bz0 + s.az1 + s.bz1) * .25, scale = camera.scale(zMid);
  return {
    ax0: glassX(a0.x, camera.aspect), ay0: glassY(a0.y), bx0: glassX(b0.x, camera.aspect), by0: glassY(b0.y),
    ax1: glassX(a1.x, camera.aspect), ay1: glassY(a1.y), bx1: glassX(b1.x, camera.aspect), by1: glassY(b1.y),
    radius: s.radius * scale, scale, z01: camera.depth > 0 ? clamp01(zMid / camera.depth) : 0,
  };
}

/** Bounding circle of the scanned silhouette on the glass (world units, at z = 0, which encloses every deeper projection), or null when nothing is scanned. */
export function scanBounds(surface: SurfaceField, aspect: number): { x: number; y: number; r: number } | null {
  const { width, height, mask } = surface;
  let minX = width, maxX = -1, minY = height, maxY = -1;
  for (let row = 0; row < height; row++) for (let col = 0; col < width; col++) if (mask[row * width + col]) {
    if (col < minX) minX = col; if (col > maxX) maxX = col; if (row < minY) minY = row; if (row > maxY) maxY = row;
  }
  if (maxX < 0) return null;
  const x0 = minX / width * aspect, x1 = (maxX + 1) / width * aspect, y0 = minY / height, y1 = (maxY + 1) / height;
  const hx = (x1 - x0) * .5, hy = (y1 - y0) * .5;
  return { x: x0 + hx, y: y0 + hy, r: Math.sqrt(hx * hx + hy * hy) + Math.max(aspect / width, 1 / height) };
}

// ---------------------------------------------------------------------------
// Floor pool: the depth cue
// ---------------------------------------------------------------------------

/** A stroke this high above the floor lights it at half strength. */
export const POOL_HEIGHT = .35;
/** Peak of the pool relative to the stroke amplitude, for a stroke touching the floor. */
export const POOL_GAIN = .18;
/** World radius of the pool for a stroke on the floor, and how much it widens per unit of height. */
export const POOL_RADIUS = .12, POOL_SPREAD = .35;

/** World-space radius and amplitude gain of the pool of light on the floor beneath a stroke `y` above it: wider and fainter as the hand rises. */
export function floorPool(y: number): { radius: number; gain: number } {
  const h = Math.max(0, y);
  return { radius: POOL_RADIUS + POOL_SPREAD * h, gain: POOL_GAIN / (1 + (h / POOL_HEIGHT) ** 2) };
}

/** The pool on the glass: an ellipse (a disc on the floor is seen at a grazing angle) and its gain. */
export interface ProjectedPool { x: number; y: number; rx: number; ry: number; gain: number }

/**
 * Project the pool beneath a segment's midpoint. Its screen height alone
 * encodes depth: the floor meets the glass at the bottom edge and rises
 * toward the horizon at mid-height, which is what makes the stroke's position
 * in the volume readable.
 */
export function projectFloorPool(seg: { ax: number; ay: number; az: number; bx: number; by: number; bz: number }, camera: WindowCamera): ProjectedPool {
  const x = (seg.ax + seg.bx) * .5, y = (seg.ay + seg.by) * .5, z = (seg.az + seg.bz) * .5;
  const p = camera.project({ x, y: 0, z }), s = camera.scale(z), pool = floorPool(y);
  const rx = pool.radius * s;
  // A disc of radius R on the floor spans R·s across the glass and R·s·(s / 2·eye) up it: the derivative of the floor's screen height with depth.
  return { x: glassX(p.x, camera.aspect), y: glassY(p.y), rx, ry: rx * .5 * s / camera.eye, gain: pool.gain };
}

/** Colour of the floor pool: the stroke colour, a touch cooler, as light bounced off a dark floor. Kept saturated: a dim grey reads as dirt, not light. */
export function floorColour(hue: number, saturation: number): [number, number, number] {
  const [r, g, b] = hsv(hue, clamp01(saturation), 1);
  return [r * .92, g * .95, b];
}

// ---------------------------------------------------------------------------
// Depth meter: the `depth` signal
// ---------------------------------------------------------------------------

/** Time constant of the depth meter's memory of recent ink. */
export const DEPTH_TAU = .3;
/** Recent-ink energy below which the depth signal fades toward 0 (nothing recent). */
export const DEPTH_GATE = .01;

/**
 * Energy-weighted mean depth of recent ink: two leaky sums (energy, and
 * energy × depth) with the same memory, so their ratio is the mean depth of
 * what was laid down lately, gated smoothly to 0 once nothing recent remains.
 */
export class InkDepth {
  private energy = 0;
  private weighted = 0;

  update(segments: readonly { amplitude: number; z01: number }[], dt: number) {
    const keep = Math.exp(-Math.max(0, dt) / DEPTH_TAU);
    this.energy *= keep; this.weighted *= keep;
    for (const s of segments) { const a = Math.max(0, s.amplitude); this.energy += a; this.weighted += a * clamp01(s.z01); }
    if (this.energy < 1e-6) { this.energy = 0; this.weighted = 0; }
  }

  /** 0 at the glass … 1 at the back wall; 0 when nothing recent. */
  get value(): number {
    return this.energy > 0 ? clamp01(this.weighted / this.energy) * smoothstep(0, DEPTH_GATE, this.energy) : 0;
  }

  reset() { this.energy = 0; this.weighted = 0; }
}

// ---------------------------------------------------------------------------
// Sparkles
// ---------------------------------------------------------------------------

/** Finite-difference step of the sparkle wind's curl field; the same value `Noise.curl2` defaults to. */
export const CURL_EPS = .01;

/**
 * x component of the divergence-free wind at (x, y, t): ∂n/∂y of the noise
 * potential. `Noise.curl2` computes exactly this but returns a fresh object
 * per call; the sparkle loop needs both components for up to 2000 particles
 * per step, so the two central differences are spelled out here as scalars.
 */
export function curlX(noise: Noise, x: number, y: number, t: number): number {
  return (noise.noise3(x, y + CURL_EPS, t) - noise.noise3(x, y - CURL_EPS, t)) / (2 * CURL_EPS);
}

/** y component of the wind: −∂n/∂x of the noise potential. See `curlX`. */
export function curlY(noise: Noise, x: number, y: number, t: number): number {
  return -((noise.noise3(x + CURL_EPS, y, t) - noise.noise3(x - CURL_EPS, y, t)) / (2 * CURL_EPS));
}

/**
 * A small structure-of-arrays particle system in the volume. Deterministic
 * for a seed: emission uses `rng`, drift uses a seeded curl-noise field in
 * the x/y plane (sampled at a time offset by depth so layers move
 * differently) while z carries an inherited push that relaxes away. Dead or
 * out-of-volume particles are swapped out from the end.
 */
export class SparkleField {
  count = 0;
  readonly x: Float32Array; readonly y: Float32Array; readonly z: Float32Array;
  readonly vx: Float32Array; readonly vy: Float32Array; readonly vz: Float32Array;
  readonly age: Float32Array; readonly life: Float32Array;
  readonly size: Float32Array; readonly phase: Float32Array;
  readonly r: Float32Array; readonly g: Float32Array; readonly b: Float32Array;
  private readonly random: () => number;
  private readonly noise: Noise;
  private carry = 0;

  constructor(readonly capacity: number, seed = 1337) {
    const n = Math.max(0, capacity);
    this.x = new Float32Array(n); this.y = new Float32Array(n); this.z = new Float32Array(n);
    this.vx = new Float32Array(n); this.vy = new Float32Array(n); this.vz = new Float32Array(n);
    this.age = new Float32Array(n); this.life = new Float32Array(n);
    this.size = new Float32Array(n); this.phase = new Float32Array(n);
    this.r = new Float32Array(n); this.g = new Float32Array(n); this.b = new Float32Array(n);
    this.random = rng(seed);
    this.noise = new Noise(seed);
  }

  /** Fraction of the budget alive, 0..1. */
  get alive() { return this.capacity > 0 ? clamp01(this.count / this.capacity) : 0; }

  /** Emit `amount` particles (fractions carry over to later calls) along a 3D segment, within its radius, inheriting some stroke velocity. */
  emit(seg: { ax: number; ay: number; az: number; bx: number; by: number; bz: number; radius: number; vx: number; vy: number; vz: number }, amount: number, colour: readonly [number, number, number]) {
    if (!(amount > 0)) return;
    this.carry += amount;
    while (this.carry >= 1 && this.count < this.capacity) {
      this.carry -= 1;
      this.spawn(seg.ax, seg.ay, seg.az, seg.bx, seg.by, seg.bz, seg.radius, seg.vx, seg.vy, seg.vz, colour);
    }
    this.settle();
  }

  /**
   * Emit `amount` particles from a hand's strokes, choosing a stroke per
   * particle by weight: fingertips `TIP_SPARKLE_BIAS` times more often than
   * any other capsule. A tip sheds along the path its end just travelled
   * (b0 → b1), as does a point brush; other capsules shed along their body.
   */
  emitFrom(strokes: readonly CapsuleStroke[], amount: number, colour: readonly [number, number, number]) {
    if (!(amount > 0) || strokes.length === 0) return;
    let total = 0;
    for (const s of strokes) total += s.tip ? TIP_SPARKLE_BIAS : 1;
    this.carry += amount;
    while (this.carry >= 1 && this.count < this.capacity) {
      this.carry -= 1;
      let pick = this.random() * total, s = strokes[strokes.length - 1];
      for (const candidate of strokes) { pick -= candidate.tip ? TIP_SPARKLE_BIAS : 1; if (pick < 0) { s = candidate; break; } }
      const point = s.ax1 === s.bx1 && s.ay1 === s.by1 && s.az1 === s.bz1;
      if (s.tip || point) this.spawn(s.bx0, s.by0, s.bz0, s.bx1, s.by1, s.bz1, s.radius, s.vx, s.vy, s.vz, colour);
      else this.spawn(s.ax1, s.ay1, s.az1, s.bx1, s.by1, s.bz1, s.radius, s.vx, s.vy, s.vz, colour);
    }
    this.settle();
  }

  /** One particle somewhere along a–b, within `radius`, inheriting some of the velocity. */
  private spawn(ax: number, ay: number, az: number, bx: number, by: number, bz: number, radius: number, vx: number, vy: number, vz: number, colour: readonly [number, number, number]) {
    const i = this.count++;
    const u = this.random(), angle = this.random() * Math.PI * 2, rad = Math.sqrt(this.random()) * radius * .8;
    this.x[i] = ax + (bx - ax) * u + Math.cos(angle) * rad;
    this.y[i] = ay + (by - ay) * u + Math.sin(angle) * rad;
    this.z[i] = az + (bz - az) * u + (this.random() - .5) * radius * .6;
    const kick = .03 + .12 * this.random(), kickAngle = this.random() * Math.PI * 2;
    this.vx[i] = vx * .35 + Math.cos(kickAngle) * kick;
    this.vy[i] = vy * .35 + Math.sin(kickAngle) * kick;
    this.vz[i] = vz * .35;
    this.age[i] = 0; this.life[i] = .7 + 1.8 * this.random();
    const s = this.random(); this.size[i] = 2 + 4 * s * s;
    this.phase[i] = this.random();
    this.r[i] = colour[0]; this.g[i] = colour[1]; this.b[i] = colour[2];
  }

  /** Do not bank emission while full; it would burst out later. */
  private settle() { if (this.count >= this.capacity) this.carry = Math.min(this.carry, 1); }

  /** Advance by `dt`: relax toward a curl-noise wind scaled by `drift`, rise a little, age, and cull outside the volume. Allocates nothing. */
  step(dt: number, time: number, drift: number, aspect: number, depth: number) {
    const k = 1 - Math.exp(-dt / .5);
    const wind = .07 * clamp01(drift);
    const noise = this.noise, t = time * .1;
    for (let i = 0; i < this.count; i++) {
      const px = this.x[i] * 1.6, py = this.y[i] * 1.6, pt = t + this.z[i] * .7;
      const wx = clamp(curlX(noise, px, py, pt), -3, 3) * wind, wy = clamp(curlY(noise, px, py, pt), -3, 3) * wind + .01;
      this.vx[i] += (wx - this.vx[i]) * k; this.vy[i] += (wy - this.vy[i]) * k; this.vz[i] -= this.vz[i] * k;
      this.x[i] += this.vx[i] * dt; this.y[i] += this.vy[i] * dt; this.z[i] += this.vz[i] * dt;
      this.age[i] += dt;
    }
    for (let i = this.count - 1; i >= 0; i--) {
      if (this.age[i] >= this.life[i] || this.x[i] < -.05 || this.x[i] > aspect + .05 || this.y[i] < -.05 || this.y[i] > 1.05 || this.z[i] < -.05 || this.z[i] > depth + .05) this.remove(i);
    }
  }

  /** Brightness 0..1 of particle `i` at `time`: fades with age and twinkles at a rate set by its phase. */
  intensity(i: number, time: number): number {
    const a = clamp01(this.age[i] / Math.max(this.life[i], 1e-3));
    const fade = (1 - a) * Math.sqrt(1 - a);
    const twinkle = .55 + .45 * Math.sin(time * (12 + 10 * this.phase[i]) + this.phase[i] * 6.2832);
    return fade * twinkle;
  }

  private remove(i: number) {
    const j = --this.count;
    if (i === j) return;
    this.x[i] = this.x[j]; this.y[i] = this.y[j]; this.z[i] = this.z[j]; this.vx[i] = this.vx[j]; this.vy[i] = this.vy[j]; this.vz[i] = this.vz[j];
    this.age[i] = this.age[j]; this.life[i] = this.life[j]; this.size[i] = this.size[j]; this.phase[i] = this.phase[j];
    this.r[i] = this.r[j]; this.g[i] = this.g[j]; this.b[i] = this.b[j];
  }

  clear() { this.count = 0; this.carry = 0; }
}

/** Sparkles are a whiter version of the stroke colour. */
export function sparkColour(r: number, g: number, b: number): [number, number, number] {
  return [r + (1 - r) * .4, g + (1 - g) * .4, b + (1 - b) * .4];
}

// ---------------------------------------------------------------------------
// Probe
// ---------------------------------------------------------------------------

/** Reduce the probe readback (R = mean displayed luminance, G = lit fraction, both 0..255 per pixel) to signals in 0..1. */
export function reduceProbe(pixels: ArrayLike<number>, pixelCount: number): { glow: number; coverage: number } {
  let glow = 0, coverage = 0;
  for (let i = 0; i < pixelCount; i++) { glow += pixels[i * 4]; coverage += pixels[i * 4 + 1]; }
  const norm = Math.max(1, pixelCount) * 255;
  return { glow: clamp01(glow / norm), coverage: clamp01(coverage / norm) };
}
