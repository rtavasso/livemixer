/**
 * Afterglow — pure CPU logic, kept free of WebGL so it can be unit-tested:
 * decay maths, the brush (radius, amplitude and colour of one stroke
 * segment), the stroke tracker that turns hands into splat segments, the
 * sparkle particle field, and the probe reduction that turns a 16×16
 * readback into signals.
 *
 * Units: everything here is in "uniform" space (canvas height = 1, width =
 * aspect) so circles are round and speeds are comparable across axes. The
 * accumulation buffer stores normalised light where 1.0 is roughly "white";
 * the renderer applies an exposure before tone-mapping.
 */
import type { HandState } from '../../input/types';
import { clamp, clamp01, hsv, rng } from '../../core/math';
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
// Brush
// ---------------------------------------------------------------------------

export interface BrushParams { brushSize: number; brightness: number; saturation: number; hue: number }

/** Brush radius in uniform units: scales with the hand blob, gently with speed, and swells when the hand pushes in. */
export function brushRadius(brushSize: number, handRadius: number, speed: number, push = 0): number {
  const size = .55 + .45 * clamp(handRadius / REFERENCE_HAND_RADIUS, .3, 2.5);
  return brushSize * size * (1 + .3 * clamp01(speed / 1.5)) * (1 + .5 * clamp01(push));
}

/**
 * Light a segment deposits at its centre line (normalised units). The travel
 * term makes a stroke's total brightness independent of how many steps it
 * took; the dwell term lets a still hand slowly brighten its spot; speed and
 * push boost both.
 */
export function brushAmplitude(brightness: number, length: number, radius: number, speed: number, push: number, dt: number): number {
  const travel = TRAVEL_RATE * length / Math.max(radius, 1e-4);
  const dwell = DWELL_RATE * Math.max(0, dt);
  const boost = (.55 + .75 * clamp01(speed / 1.5)) * (1 + .8 * clamp01(push));
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

/** Light a segment adds at a point: the brush kernel plus a tighter warm-white core. Mirrors the GPU pass. */
export function segmentLight(seg: { ax: number; ay: number; bx: number; by: number; radius: number; amplitude: number }, px: number, py: number): { colour: number; white: number } {
  const w = brushKernel(segmentDistance(px, py, seg.ax, seg.ay, seg.bx, seg.by) / Math.max(seg.radius, 1e-6));
  return { colour: seg.amplitude * w, white: seg.amplitude * .35 * w * w * w };
}

// ---------------------------------------------------------------------------
// Strokes: hands → segments
// ---------------------------------------------------------------------------

export interface StrokeSegment {
  ax: number; ay: number; bx: number; by: number;
  radius: number; amplitude: number;
  r: number; g: number; b: number;
  length: number; speed: number; vx: number; vy: number; push: number;
}

/** Remembers where each hand was last step so every step yields a segment (a dot for a hand seen for the first time). */
export class StrokeTracker {
  private readonly last = new Map<number, { x: number; y: number; offset: number }>();
  private seen = 0;

  update(hands: readonly HandState[], aspect: number, dt: number, params: BrushParams): StrokeSegment[] {
    const out: StrokeSegment[] = [];
    const present = new Set<number>();
    for (const hand of hands) {
      present.add(hand.id);
      const x = hand.position.x * aspect, y = hand.position.y;
      let prev = this.last.get(hand.id);
      if (!prev) { prev = { x, y, offset: HUE_OFFSETS[this.seen++ % HUE_OFFSETS.length] }; this.last.set(hand.id, prev); }
      const vx = hand.velocity.x * aspect, vy = hand.velocity.y;
      const speed = Math.hypot(vx, vy);
      const dx = x - prev.x, dy = y - prev.y;
      const length = Math.hypot(dx, dy);
      const radius = brushRadius(params.brushSize, hand.radius * aspect, speed, hand.push);
      const amplitude = brushAmplitude(params.brightness, length, radius, speed, hand.push, dt);
      const [r, g, b] = strokeColor(params.hue, params.saturation, dx, dy, prev.offset);
      out.push({ ax: prev.x, ay: prev.y, bx: x, by: y, radius, amplitude, r, g, b, length, speed, vx, vy, push: hand.push });
      prev.x = x; prev.y = y;
    }
    for (const id of this.last.keys()) if (!present.has(id)) this.last.delete(id);
    return out;
  }
  get tracked() { return this.last.size; }
  reset() { this.last.clear(); }
}

/** Recent stroke energy target 0..1 from the deposit amplitude of one step. */
export function inkTarget(amplitudePerStep: number, dt: number): number {
  return clamp01(amplitudePerStep / Math.max(dt, 1e-3) / INK_FULL_RATE);
}

/** How many sparkles (fractional) a segment sheds this step, before the `sparkle` param scales it. */
export function sparkleRate(length: number, radius: number, push: number, dt: number): number {
  return 30 * length / Math.max(radius, 1e-4) + 2 * Math.max(0, dt) * (.4 + clamp01(push));
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
 * A small structure-of-arrays particle system. Deterministic for a seed:
 * emission uses `rng`, drift uses a seeded curl-noise field. Dead or
 * off-screen particles are swapped out from the end.
 */
export class SparkleField {
  count = 0;
  readonly x: Float32Array; readonly y: Float32Array;
  readonly vx: Float32Array; readonly vy: Float32Array;
  readonly age: Float32Array; readonly life: Float32Array;
  readonly size: Float32Array; readonly phase: Float32Array;
  readonly r: Float32Array; readonly g: Float32Array; readonly b: Float32Array;
  private readonly random: () => number;
  private readonly noise: Noise;
  private carry = 0;

  constructor(readonly capacity: number, seed = 1337) {
    const n = Math.max(0, capacity);
    this.x = new Float32Array(n); this.y = new Float32Array(n);
    this.vx = new Float32Array(n); this.vy = new Float32Array(n);
    this.age = new Float32Array(n); this.life = new Float32Array(n);
    this.size = new Float32Array(n); this.phase = new Float32Array(n);
    this.r = new Float32Array(n); this.g = new Float32Array(n); this.b = new Float32Array(n);
    this.random = rng(seed);
    this.noise = new Noise(seed);
  }

  /** Fraction of the budget alive, 0..1. */
  get alive() { return this.capacity > 0 ? clamp01(this.count / this.capacity) : 0; }

  /** Emit `amount` particles (fractions carry over to later calls) along a segment, within its radius, inheriting some stroke velocity. */
  emit(seg: { ax: number; ay: number; bx: number; by: number; radius: number; vx: number; vy: number }, amount: number, colour: readonly [number, number, number]) {
    if (!(amount > 0)) return;
    this.carry += amount;
    while (this.carry >= 1 && this.count < this.capacity) {
      this.carry -= 1;
      const i = this.count++;
      const u = this.random(), angle = this.random() * Math.PI * 2, rad = Math.sqrt(this.random()) * seg.radius * .8;
      this.x[i] = seg.ax + (seg.bx - seg.ax) * u + Math.cos(angle) * rad;
      this.y[i] = seg.ay + (seg.by - seg.ay) * u + Math.sin(angle) * rad;
      const kick = .03 + .12 * this.random(), kickAngle = this.random() * Math.PI * 2;
      this.vx[i] = seg.vx * .35 + Math.cos(kickAngle) * kick;
      this.vy[i] = seg.vy * .35 + Math.sin(kickAngle) * kick;
      this.age[i] = 0; this.life[i] = .7 + 1.8 * this.random();
      const s = this.random(); this.size[i] = 2 + 4 * s * s;
      this.phase[i] = this.random();
      this.r[i] = colour[0]; this.g[i] = colour[1]; this.b[i] = colour[2];
    }
    // Do not bank emission while full; it would burst out later.
    if (this.count >= this.capacity) this.carry = Math.min(this.carry, 1);
  }

  /** Advance by `dt`: relax toward a curl-noise wind scaled by `drift`, rise a little, age, and cull. Allocates nothing. */
  step(dt: number, time: number, drift: number, aspect: number) {
    const k = 1 - Math.exp(-dt / .5);
    const wind = .07 * clamp01(drift);
    const noise = this.noise, t = time * .1;
    for (let i = 0; i < this.count; i++) {
      const px = this.x[i] * 1.6, py = this.y[i] * 1.6;
      const wx = clamp(curlX(noise, px, py, t), -3, 3) * wind, wy = clamp(curlY(noise, px, py, t), -3, 3) * wind + .01;
      this.vx[i] += (wx - this.vx[i]) * k; this.vy[i] += (wy - this.vy[i]) * k;
      this.x[i] += this.vx[i] * dt; this.y[i] += this.vy[i] * dt;
      this.age[i] += dt;
    }
    for (let i = this.count - 1; i >= 0; i--) {
      if (this.age[i] >= this.life[i] || this.x[i] < -.05 || this.x[i] > aspect + .05 || this.y[i] < -.05 || this.y[i] > 1.05) this.remove(i);
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
    this.x[i] = this.x[j]; this.y[i] = this.y[j]; this.vx[i] = this.vx[j]; this.vy[i] = this.vy[j];
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
