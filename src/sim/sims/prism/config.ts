/**
 * Prism tuning shared by the simulation and its tests: quality tiers, the
 * segment cap, the line shape, the per-frame ray budget, and the mapping of a
 * hand in the volume onto the light plane the tracer works in. Pure constants
 * and arithmetic with no WebGL, so a test can reproduce the simulation's exact
 * trace (ray count, beam width, gain, energy floor, wall bounds) without a GL
 * context.
 *
 * The light plane is horizontal: its first coordinate is the volume's x, its
 * second the volume's z (depth into the scene). The 2D tracer calls that
 * second coordinate `y`; everything here calls it `z` to keep the volume's
 * axes straight.
 */
import type { Quality, Vec3 } from '../../core/types';
import type { TraceOptions } from './optics';

/**
 * Hard cap on traced segments per beam; each beam's VBO is sized to this (40 000 × 32 B ≈ 1.3 MB). The adaptive
 * ray budget keeps a real frame well under it, so the cap is a safety net rather than something that is hit.
 */
export const MAX_SEGMENTS = 40000;
export const MAX_POLYGONS = 2;
export const MAX_VERTICES = 8;

export interface QualityTier {
  /** Wavelengths traced per ray. */
  spectrum: number;
  /** `interleave` × `spectrum` entries fill the wavelength table, spread across neighbouring rays. */
  interleave: number;
  /** Multiplier on the `rays` parameter. */
  rayScale: number;
  /** Scene target size relative to the canvas. */
  sceneScale: number;
}

export const QUALITY: Record<Quality, QualityTier> = {
  low: { spectrum: 12, interleave: 5, rayScale: .55, sceneScale: .5 },
  medium: { spectrum: 16, interleave: 4, rayScale: 1, sceneScale: .75 },
  high: { spectrum: 24, interleave: 2, rayScale: 1.25, sceneScale: 1 },
};

/** Defaults of the parameters that decide how much the tracer does; the param specs in `index.ts` read them from here. */
export const TRACE_DEFAULTS = { size: .2, height: .7, glass: 1.52, dispersion: 6, beam: .026, rays: 72, bounces: 4 } as const;

/**
 * Line shape in scene pixels: a Gaussian core, an exponential halo, and the half width of the quad each
 * segment is expanded to. At 3 px the quad edge sits where the halo has fallen to ~1.5% of the core.
 */
export const LINE = { core: 1.0, halo: 2.2, haloGain: .3, halfWidth: 3 } as const;
/** Integral across the line of core + halo, used to normalise the beam so its centre reads ~intensity. */
export const CORE_INTEGRAL = Math.sqrt(Math.PI) * LINE.core + 2 * LINE.halo * LINE.haloGain;

/** The beam's footprint on the floor (the same segments drawn at y = 0), relative to the beam. */
export const FLOOR_LINE_GAIN = .06;

/**
 * Wall splashes: every ray that ends on a wall of the volume leaves a soft disc there. `radius` is in uniform
 * units; `gain` is the disc's peak per unit of ray intensity, normalised by the radius in scene pixels so the
 * wash a beam leaves reads the same at any resolution (an undispersed beam's spot peaks near the beam's own
 * brightness; a fan spreads its rays and lands as a softer band of colour).
 */
export const SPLASH = { radius: .05, gain: 3.5 } as const;

/** Glass rendering: colour, the additive brightness of the nine edges, and the per-face fill (base + edge-on Fresnel term). */
export const GLASS = { color: [.62, .74, .92] as const, edge: .11, faceBase: .01, faceGlance: .07 } as const;

/** Rays across the beam for a `rays` parameter value at a quality tier, scaled by the adaptive budget. */
export function rayCount(rays: number, tier: QualityTier, budget = 1): number {
  return Math.max(4, Math.round(rays * tier.rayScale * budget));
}

/**
 * Next value of the adaptive ray budget: a truncated frame cuts the ray count by 15% (never below a quarter),
 * every clean frame creeps it back up by 1%, so the beam thins instead of clipping and recovers slowly.
 */
export function nextRayBudget(budget: number, truncated: boolean): number {
  return truncated ? Math.max(.25, budget * .85) : Math.min(1, budget + .01);
}

/**
 * Energy below which a ray is not followed. Second-order Fresnel reflections carry ~0.16% of a ray's energy per
 * wavelength and never show; dropping them roughly halves the segment count for a brightness loss under 10%.
 */
export function minEnergyFor(tier: QualityTier): number { return .1 / tier.spectrum; }

/** Full beam width for the `beam` parameter and a hand's openness (0 = fist, 1 = open): 0.35× for a fist, 1× fully open. */
export function beamWidth(base: number, openness: number): number { return base * (.35 + .65 * Math.min(1, Math.max(0, openness))); }

/** Stored intensity per unit energy so the beam centre reads ~intensity regardless of ray count or width. */
export function beamGain(width: number, sceneHeight: number, rays: number): number {
  return Math.max(width * sceneHeight, 1.5) / rays / CORE_INTEGRAL;
}

/** A point in the light plane: x left→right, z into the volume, both in uniform units. */
export interface PlanePoint { x: number; z: number }

/** Centre of prism `index` (0 or 1) in the light plane; the second exists only in twin mode. */
export function prismCentre(index: number, twin: boolean, aspect: number, depth: number, out: PlanePoint): void {
  const cx = aspect / 2, cz = depth / 2;
  if (!twin) { out.x = cx; out.z = cz; return; }
  const apart = Math.min(.28, aspect * .2);
  out.x = index === 0 ? cx - apart : cx + apart; out.z = index === 0 ? cz : cz + .06 * depth;
}

/** Circumradius the glass actually gets: the `size` parameter, held inside the volume however shallow or narrow it is. */
export function prismRadius(size: number, aspect: number, depth: number): number { return Math.min(size, depth * .42, aspect * .42); }

/**
 * A hand in sim space → the light it carries. The beam source is the hand's (x, z) in the horizontal light
 * plane and the plane's height is the hand's y, all in uniform units; pushing in (sim z toward 1) walks the
 * source toward the back wall, and so around or behind the prism.
 */
export function lightPlane(position: Vec3, aspect: number, depth: number, out: Vec3): Vec3 {
  out.x = position.x * aspect; out.y = position.y; out.z = position.z * depth;
  return out;
}

/** Which wall of the volume a point in the light plane lies on: 0 none, 1 left (x = 0), 2 right (x = aspect), 3 front (z = 0, the glass), 4 back (z = depth). */
export function wallOf(x: number, z: number, aspect: number, depth: number, epsilon = 1e-4): number {
  if (x <= epsilon) return 1;
  if (x >= aspect - epsilon) return 2;
  if (z <= epsilon) return 3;
  if (z >= depth - epsilon) return 4;
  return 0;
}

/** The idle source: an ellipse around the prism in the light plane, its radii breathing so the incidence keeps changing. */
export function idleOrbit(angle: number, time: number, aspect: number, depth: number, out: PlanePoint): PlanePoint {
  const breathe = .84 + .06 * Math.sin(time * .21);
  out.x = aspect / 2 + (aspect / 2) * breathe * Math.cos(angle);
  out.z = depth / 2 + (depth / 2) * breathe * Math.sin(angle);
  return out;
}

/**
 * Everything but the spectrum table in the options the simulation hands the tracer each frame. The bounds are
 * the volume's walls exactly: a ray ends where it meets one, and that is where its splash is drawn.
 */
export function traceOptionsFor(tier: QualityTier, spectrum: TraceOptions['spectrum'], params: { glass: number; dispersion: number; bounces: number }, aspect: number, depth: number, cauchyBGlass: number): TraceOptions {
  return {
    spectrum, samplesPerRay: tier.spectrum, glassA: params.glass, glassB: cauchyBGlass * params.dispersion, bounces: params.bounces,
    minEnergy: minEnergyFor(tier), bounds: [0, 0, aspect, depth],
  };
}
