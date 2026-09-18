/**
 * Shallows — CPU-side model. Pure and free of WebGL so it can be unit-tested:
 * the field's size and the plane mapping, the solver's stability bounds, the
 * forcing kernels and the stamps that carry hands into the wave pass, splash
 * detection, the ambient swell, probe decoding and signal shaping.
 *
 * The water is the volume's horizontal plane seen from straight above and it
 * fills the screen. PLANE coordinates are uniform units (canvas height = 1):
 * x = sim x · aspect in [0, aspect], y = sim z in [0, 1] (the glass edge at the
 * bottom of the screen, the back wall at the top). Sim y is the hand's HEIGHT;
 * the surface sits at the `level` parameter. The hand geometry (footprints,
 * shadows, the scan) is Basin's, which works in a centred square grid;
 * `gridToPlaneX/Y` carry it onto the plane.
 *
 * Physics: a damped linear wave equation for the surface height h,
 *   h_tt = c² ∇²h − settle · h_t + ν ∇²h_t
 * The ν term damps a wave of wavenumber k at ν k² / 2, so short ripples die in
 * a couple of seconds while `settle` alone decides how long the long slosh
 * keeps rocking between the reflecting screen edges.
 */
import type { Quality } from '../../core/types';
import { clamp, clamp01, rng } from '../../core/math';
import { domainScale, stirStrength, type Footprints, type ScanMeasure } from '../basin/model';

// ---------------------------------------------------------------------------
// Field
// ---------------------------------------------------------------------------

export const ROWS_BY_QUALITY: Record<Quality, number> = { low: 192, medium: 256, high: 384 };

/** Grid for a canvas: `ROWS_BY_QUALITY` rows of square cells, an even number of columns, bounded for extreme canvases. */
export function fieldSize(quality: Quality, aspect: number): { width: number; height: number } {
  const height = ROWS_BY_QUALITY[quality];
  return { width: 2 * Math.round(height * clamp(aspect, .4, 3) / 2), height };
}

/** Basin grid uv → plane (uniform units). Lengths scale by `domainScale(aspect)`. */
export const gridToPlaneX = (gx: number, aspect: number) => (gx - .5) * domainScale(aspect) + aspect * .5;
export const gridToPlaneY = (gy: number, aspect: number) => (gy - .5) * domainScale(aspect) + .5;

// ---------------------------------------------------------------------------
// Stability. The wave pass uses the isotropic nine-point Laplacian, whose
// largest eigenvalue is 16/3 per cell², so symplectic Euler is stable for a
// Courant number c·dt/dx below √3/2 ≈ 0.87 and the explicit ν term for a
// diffusion number ν·dt/dx² below 3/8. Both are kept well inside.
// ---------------------------------------------------------------------------

export const COURANT_MAX = .7, DIFFUSION_MAX = .2, MAX_SUBSTEPS = 8;
/** Stored ranges (the packed RGBA8 fallback spans exactly these; the float path clamps to them too). */
export const HEIGHT_RANGE = .05, VELOCITY_RANGE = .6;
/** A weak pull of the height toward rest (1/s): removes what the not-quite-zero-mean segment stamps add. */
export const HEIGHT_RELAX = .05;

/** Wave passes per fixed step so the Courant number stays under the bound. */
export const substepsFor = (speed: number, dt: number, rows: number) => clamp(Math.ceil(speed * dt * rows / COURANT_MAX), 1, MAX_SUBSTEPS);
/** The speed actually simulated: the requested one unless even `MAX_SUBSTEPS` could not keep it stable. */
export const effectiveSpeed = (speed: number, dt: number, rows: number) => Math.min(speed, COURANT_MAX * MAX_SUBSTEPS / (dt * rows));

/** ν from the `ripples` parameter (0 = ripples vanish at once … 1 = they travel far), geometric between the ends. */
const NU_SHORT = 2e-4, NU_LONG = 1.5e-5;
export const rippleViscosity = (ripples: number) => NU_SHORT * Math.pow(NU_LONG / NU_SHORT, clamp01(ripples));

/** Amplitude decay rate (1/s) of a wave of wavenumber k (rad per uniform unit). */
export const dampingRate = (k: number, settle: number, nu: number) => (settle + HEIGHT_RELAX + nu * k * k) * .5;

// ---------------------------------------------------------------------------
// Forcing kernels, in units of the stamp radius (q = r²). Mirrored in the wave
// shader. Both integrate to zero over the plane: a body moves water, it does
// not make any.
// ---------------------------------------------------------------------------

/** A dip ringed by a raised rim (or the reverse): vertical pushes and splashes. */
export const pressKernel = (q: number) => (1 - q) * Math.exp(-q);
/** Water piled up ahead of a body moving with (ux, uy) and drawn down behind it. */
export const dipoleKernel = (dx: number, dy: number, ux: number, uy: number) => (dx * ux + dy * uy) * Math.exp(-(dx * dx + dy * dy));

export const MAX_STAMPS = 32;
const STAMP_RADIUS_MIN = .032;
/** The scan acts as one round body; a whole forearm in the water must not become a paddle the width of the screen. */
const SCAN_RADIUS_MAX = .06;

/**
 * This step's forcing, packed for the wave pass: `seg` a.xy b.xy (plane), `vel` the velocity at a
 * and at b (plane units/s, force gain applied), `meta` radius (plane), grip 0..1, vertical
 * acceleration while gripped (negative = pressing down), instantaneous impulse. Allocates nothing per step.
 */
export class Stamps {
  readonly seg = new Float32Array(MAX_STAMPS * 4);
  readonly vel = new Float32Array(MAX_STAMPS * 4);
  readonly meta = new Float32Array(MAX_STAMPS * 4);
  count = 0;

  begin() { this.count = 0; }

  /** Every wet footprint Basin found (grid uv) as a moving body; `press` is the hand's vertical acceleration on the water. */
  addFootprints(fp: Footprints, aspect: number, force: number, press: number) {
    const s = domainScale(aspect), k = s * force;
    for (let i = 0; i < fp.count && this.count < MAX_STAMPS; i++) {
      const src = i * 4, o = this.count++ * 4;
      this.seg[o] = gridToPlaneX(fp.seg[src], aspect); this.seg[o + 1] = gridToPlaneY(fp.seg[src + 1], aspect);
      this.seg[o + 2] = gridToPlaneX(fp.seg[src + 2], aspect); this.seg[o + 3] = gridToPlaneY(fp.seg[src + 3], aspect);
      this.vel[o] = fp.vel[src] * k; this.vel[o + 1] = fp.vel[src + 1] * k; this.vel[o + 2] = fp.vel[src + 2] * k; this.vel[o + 3] = fp.vel[src + 3] * k;
      this.meta[o] = Math.max(STAMP_RADIUS_MIN, fp.meta[src] * s); this.meta[o + 1] = fp.meta[src + 1]; this.meta[o + 2] = press; this.meta[o + 3] = 0;
    }
  }

  /** The scan's wet part as one round body at its centroid, moving with it. */
  addScan(scan: ScanMeasure, vx: number, vy: number, aspect: number, force: number, press: number) {
    if (!scan.wet || this.count >= MAX_STAMPS) return;
    const s = domainScale(aspect), o = this.count++ * 4, x = gridToPlaneX(scan.cx, aspect), y = gridToPlaneY(scan.cy, aspect);
    this.seg[o] = x; this.seg[o + 1] = y; this.seg[o + 2] = x; this.seg[o + 3] = y;
    this.vel[o] = vx * s * force; this.vel[o + 1] = vy * s * force; this.vel[o + 2] = this.vel[o]; this.vel[o + 3] = this.vel[o + 1];
    this.meta[o] = clamp(scan.wetRadius * s, STAMP_RADIUS_MIN, SCAN_RADIUS_MAX); this.meta[o + 1] = stirStrength(clamp01(scan.wet / scan.total * 5)); this.meta[o + 2] = press; this.meta[o + 3] = 0;
  }

  /** A one-off vertical impulse at a plane point (negative = a dip with a raised rim). */
  addImpulse(x: number, y: number, radius: number, impulse: number) {
    if (this.count >= MAX_STAMPS || Math.abs(impulse) < 1e-5) return;
    const o = this.count++ * 4;
    this.seg[o] = x; this.seg[o + 1] = y; this.seg[o + 2] = x; this.seg[o + 3] = y;
    this.vel[o] = 0; this.vel[o + 1] = 0; this.vel[o + 2] = 0; this.vel[o + 3] = 0;
    this.meta[o] = Math.max(STAMP_RADIUS_MIN, radius); this.meta[o + 1] = 0; this.meta[o + 2] = 0; this.meta[o + 3] = impulse;
  }
}

// ---------------------------------------------------------------------------
// Splashes: a body whose underside crosses the surface going down.
// ---------------------------------------------------------------------------

export const SPLASH_COOLDOWN = .5;
/** Descent (uniform units/s) at which a plunge is as hard as it gets. */
export const SPLASH_FULL = 1.2;

export class SplashDetector {
  private readonly prev = new Map<number, number>();
  private readonly last = new Map<number, number>();
  get tracked() { return this.prev.size; }

  /**
   * `clearance` is the underside's height above the surface (≤ 0 once it touches), `descent` the
   * downward speed. Returns the splash strength, 0.3 (a slow dip) … 1 (a plunge), or 0 when there is
   * none. A body first seen already under the surface does not splash.
   */
  update(id: number, clearance: number, descent: number, time: number): number {
    const before = this.prev.get(id);
    this.prev.set(id, clearance);
    if (before === undefined || before <= 0 || clearance > 0) return 0;
    if (time - (this.last.get(id) ?? -Infinity) < SPLASH_COOLDOWN) return 0;
    this.last.set(id, time);
    return .3 + .7 * clamp01(descent / SPLASH_FULL);
  }

  /** Drop every body whose id is not in `ids`. */
  retain(ids: ReadonlySet<number>) {
    for (const id of this.prev.keys()) if (!ids.has(id)) { this.prev.delete(id); this.last.delete(id); }
  }
}

// ---------------------------------------------------------------------------
// Swell: the fine wind ripples real water always carries, which is what draws
// the caustic network when nobody is there. Each is a travelling sine, an exact
// solution of the same linear wave equation, so it superposes on the simulated
// field; the composite adds its analytic slope and curvature to the field's at
// full screen resolution (the grid could not carry wavelengths this short).
// Phases are integrated here and wrapped, never handed to a shader as raw time.
// ---------------------------------------------------------------------------

/** Direction (rad), wavelength (uniform units), curvature weight, pace (its own speed relative to the others). */
export const SWELL_WAVES: readonly (readonly [number, number, number, number])[] = [
  [.10, .34, 1, 1], [.95, .27, 1, .93], [-.55, .21, .9, 1.07], [1.70, .165, .8, .9], [.40, .13, .6, 1.1],
  [-1.20, .105, .45, .97], [2.30, .085, .3, 1.05], [.75, .07, .22, .88], [-.20, .058, .15, 1.12], [1.35, .047, .1, 1],
];
/** Curvature amplitude A·k² of each wave at breeze = 1 and weight = 1, and the ripples' speed as a share of the wave speed. */
export const SWELL_CURVATURE = 6.6, SWELL_PACE = .5;

export class Swell {
  /** Per wave: k.x, k.y (rad per uniform unit), amplitude (uniform units), phase (rad, wrapped). */
  readonly data = new Float32Array(SWELL_WAVES.length * 4);
  private readonly phase = new Float64Array(SWELL_WAVES.length);
  constructor(seed: number) { const r = rng(seed); for (let i = 0; i < this.phase.length; i++) this.phase[i] = r() * 2 * Math.PI; this.update(0, 0, 0); }
  update(breeze: number, speed: number, dt: number): Float32Array {
    for (let i = 0; i < SWELL_WAVES.length; i++) {
      const [angle, wavelength, weight, pace] = SWELL_WAVES[i], k = 2 * Math.PI / wavelength, o = i * 4;
      this.phase[i] = (this.phase[i] + speed * SWELL_PACE * pace * k * dt) % (2 * Math.PI);
      this.data[o] = k * Math.cos(angle); this.data[o + 1] = k * Math.sin(angle); this.data[o + 2] = clamp01(breeze) * SWELL_CURVATURE * weight / (k * k); this.data[o + 3] = this.phase[i];
    }
    return this.data;
  }
}

// ---------------------------------------------------------------------------
// Probe: a 16×16 image of the field read back asynchronously. Per texel the
// mean height (signed), mean |h_t| and mean |∇²h| of its part of the plane.
// ---------------------------------------------------------------------------

export const PROBE_SIZE = 16;
export const PROBE_SUB = 4;
/** Full-scale values for the 8-bit encodings. Must match shaders.ts. */
export const PROBE_ENC = { height: .02, speed: .4, curvature: 60 } as const;

export const encodeProbeTexel = (height: number, speed: number, curvature: number): [number, number, number, number] => [
  Math.round(clamp(128 + 127 * (height / PROBE_ENC.height), 1, 255)), Math.round(clamp01(speed / PROBE_ENC.speed) * 255), Math.round(clamp01(curvature / PROBE_ENC.curvature) * 255), 255,
];

export interface Measures {
  /** Mean |h_t|, uniform units per second. */
  speed: number;
  /** Mean |∇²h|, 1 per uniform unit: large for short ripples, negligible for the slosh. */
  curvature: number;
  /** First moments of the height about the centre: mean of h·(2u − 1) across, and of h·(2v − 1) from the glass to the back. */
  tiltX: number; tiltZ: number;
}

/** Decode a probe readback (RGBA8, row-major from the bottom row, PROBE_SIZE²). */
export function decodeProbe(bytes: ArrayLike<number>): Measures {
  let speed = 0, curvature = 0, tiltX = 0, tiltZ = 0;
  const n = PROBE_SIZE, inv = 1 / (n * n);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const o = (j * n + i) * 4, h = (bytes[o] - 128) / 127 * PROBE_ENC.height;
    speed += bytes[o + 1]; curvature += bytes[o + 2];
    tiltX += h * ((i + .5) / n * 2 - 1); tiltZ += h * ((j + .5) / n * 2 - 1);
  }
  return { speed: speed * inv / 255 * PROBE_ENC.speed, curvature: curvature * inv / 255 * PROBE_ENC.curvature, tiltX: tiltX * inv + 0, tiltZ: tiltZ * inv + 0 };
}

// ---------------------------------------------------------------------------
// Signals
// ---------------------------------------------------------------------------

export interface RawSignals { energy: number; sloshX: number; sloshZ: number; ripple: number; immersion: number }
export interface ShallowsSignals extends RawSignals { calm: number }

/** Scales at which each signal reads about 0.63 (energy, ripple) or 0.76 (slosh). */
export const ENERGY_SCALE = .02, RIPPLE_SCALE = 1.2, SLOSH_SCALE = .0006;

/** Saturating curve: 0 at 0, ~0.63 at `scale`, → 1. */
const soft = (x: number, scale: number) => 1 - Math.exp(-Math.max(0, x) / scale);

export function measuresToSignals(m: Measures, immersion = 0): RawSignals {
  return {
    energy: soft(m.speed, ENERGY_SCALE),
    sloshX: clamp(Math.tanh(m.tiltX / SLOSH_SCALE), -1, 1),
    sloshZ: clamp(Math.tanh(m.tiltZ / SLOSH_SCALE), -1, 1),
    ripple: soft(m.curvature, RIPPLE_SCALE),
    immersion: clamp01(immersion),
  };
}

/** Exponential smoothing so the audio side sees stable values; `calm` follows a slower energy. The slosh is left nearly raw: it is already slow. */
export class SignalSmoother {
  readonly values: ShallowsSignals = { energy: 0, sloshX: 0, sloshZ: 0, ripple: 0, immersion: 0, calm: 1 };
  private slowEnergy = 0;
  constructor(private readonly tau = { energy: .15, slosh: .08, ripple: .2, immersion: .12, calm: 1.5 }) {}
  update(raw: RawSignals, dt: number): ShallowsSignals {
    const k = (tau: number) => (dt <= 0 ? 0 : 1 - Math.exp(-dt / tau));
    const v = this.values;
    v.energy = clamp01(v.energy + (raw.energy - v.energy) * k(this.tau.energy));
    v.sloshX = clamp(v.sloshX + (raw.sloshX - v.sloshX) * k(this.tau.slosh), -1, 1);
    v.sloshZ = clamp(v.sloshZ + (raw.sloshZ - v.sloshZ) * k(this.tau.slosh), -1, 1);
    v.ripple = clamp01(v.ripple + (raw.ripple - v.ripple) * k(this.tau.ripple));
    v.immersion = clamp01(v.immersion + (raw.immersion - v.immersion) * k(this.tau.immersion));
    this.slowEnergy = clamp01(this.slowEnergy + (raw.energy - this.slowEnergy) * k(this.tau.calm));
    v.calm = clamp01(1 - this.slowEnergy);
    return v;
  }
}
