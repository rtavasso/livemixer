/**
 * Prism tuning shared by the simulation and its tests: quality tiers, the
 * segment cap, the line shape and the per-frame ray budget. Pure constants and
 * arithmetic with no WebGL, so a test can reproduce the simulation's exact
 * trace (ray count, beam width, gain, energy floor) without a GL context.
 */
import type { Quality } from '../../core/types';
import type { TraceOptions } from './optics';

/**
 * Hard cap on traced segments per frame; the VBO is sized to this (40 000 × 32 B ≈ 1.3 MB). The adaptive
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
export const TRACE_DEFAULTS = { size: .18, glass: 1.52, dispersion: 6, beam: .016, rays: 72, bounces: 4 } as const;

/**
 * Line shape in scene pixels: a Gaussian core, an exponential halo, and the half width of the quad each
 * segment is expanded to. At 3 px the quad edge sits where the halo has fallen to ~1.5% of the core.
 */
export const LINE = { core: 1.0, halo: 2.2, haloGain: .3, halfWidth: 3 } as const;
/** Integral across the line of core + halo, used to normalise the beam so its centre reads ~intensity. */
export const CORE_INTEGRAL = Math.sqrt(Math.PI) * LINE.core + 2 * LINE.halo * LINE.haloGain;

/** Rays are clipped this far outside the picture (uniform units) so nothing ends visibly short of the edge. */
export const BOUNDS_MARGIN = .05;

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

/** Full beam width for the `beam` parameter and a hand's push (0..1): 0.7× at rest, 2.5× fully pushed. */
export function beamWidth(base: number, push: number): number { return base * (.7 + 1.8 * push); }

/** Stored intensity per unit energy so the beam centre reads ~intensity regardless of ray count or width. */
export function beamGain(width: number, sceneHeight: number, rays: number): number {
  return Math.max(width * sceneHeight, 1.5) / rays / CORE_INTEGRAL;
}

/** Centre of prism `index` (0 or 1) for a canvas of the given aspect; the second exists only in twin mode. */
export function prismCentre(index: number, twin: boolean, aspect: number, out: { x: number; y: number }): void {
  const cx = aspect / 2;
  if (!twin) { out.x = cx; out.y = .5; return; }
  out.x = index === 0 ? cx - .28 : cx + .28; out.y = index === 0 ? .5 : .56;
}

/** Everything but the spectrum table in the options the simulation hands the tracer each frame. */
export function traceOptionsFor(tier: QualityTier, spectrum: TraceOptions['spectrum'], params: { glass: number; dispersion: number; bounces: number }, aspect: number, cauchyBGlass: number): TraceOptions {
  return {
    spectrum, samplesPerRay: tier.spectrum, glassA: params.glass, glassB: cauchyBGlass * params.dispersion, bounces: params.bounces,
    minEnergy: minEnergyFor(tier), bounds: [-BOUNDS_MARGIN, -BOUNDS_MARGIN, aspect + BOUNDS_MARGIN, 1 + BOUNDS_MARGIN],
  };
}
