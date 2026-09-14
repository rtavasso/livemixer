import type { Quality } from '../core/types';

/** Bound full-screen shading and render-target memory independently of the
 * monitor's Retina scale. Medium is the Intel laptop budget; high is opt-in.
 * Simulation grids stay fixed, so resizing never trades away physical detail.
 */
export const PIXEL_BUDGET: Record<Quality, number> = {
  low: 800 * 600, medium: 1280 * 800, high: 1920 * 1080,
};

export function renderSize(cssWidth: number, cssHeight: number, maxDpr: number, deviceDpr: number, quality: Quality) {
  const w = Math.max(1, cssWidth), h = Math.max(1, cssHeight);
  const dpr = Math.min(maxDpr, deviceDpr || 1, Math.sqrt(PIXEL_BUDGET[quality] / (w * h)));
  return { width: Math.max(1, Math.floor(w * dpr)), height: Math.max(1, Math.floor(h * dpr)), dpr };
}
