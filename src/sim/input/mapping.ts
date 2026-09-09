/**
 * Physical → simulation space mapping.
 *
 * A source reports positions in its own normalized frame. `SpaceMapping`
 * describes, for each sim axis, which source axis feeds it and which source
 * interval [low, high] maps onto sim [0, 1]. `low > high` is allowed and
 * mirrors the axis; `mirror` flips it again on top of that so a calibration
 * captured in one orientation can be reused with the display turned around.
 *
 * The mapping is a plain data object so it can live in settings, be edited in
 * the overlay, and be published in telemetry.
 */
import { z } from 'zod';
import type { Box3, Capsule, DepthSurface, HandObservation, OccupancyGrid, VoxelGrid } from './types';
import type { OccupancyField, SurfaceField, Vec3, VolumeField } from '../core/types';

export type Axis = 'x' | 'y' | 'z';
export const AXES: readonly Axis[] = ['x', 'y', 'z'];

export const axisMapSchema = z.object({
  from: z.enum(['x', 'y', 'z']),
  low: z.number().finite().min(-1).max(2),
  high: z.number().finite().min(-1).max(2),
  mirror: z.boolean().default(false),
}).strict();
export const spaceMappingSchema = z.object({ x: axisMapSchema, y: axisMapSchema, z: axisMapSchema }).strict()
  .refine(m => AXES.every(a => Math.abs(m[a].high - m[a].low) > 1e-3), { message: 'Each mapped axis needs a non-empty source interval.' });

export type AxisMap = z.infer<typeof axisMapSchema>;
export type SpaceMapping = z.infer<typeof spaceMappingSchema>;

/** Identity: sim x/y/z = source x/y/z with y flipped so image-down becomes sim-up. */
export const IMAGE_MAPPING: SpaceMapping = {
  x: { from: 'x', low: 0, high: 1, mirror: true },   // cameras see a mirror image of the person facing the display
  y: { from: 'y', low: 1, high: 0, mirror: false },  // image y grows downward; sim y grows upward
  z: { from: 'z', low: 0, high: 1, mirror: false },
};
/** Screen-oriented sources (pointer) are already left→right / top→bottom without mirroring. */
export const SCREEN_MAPPING: SpaceMapping = {
  x: { from: 'x', low: 0, high: 1, mirror: false },
  y: { from: 'y', low: 1, high: 0, mirror: false },
  z: { from: 'z', low: 0, high: 1, mirror: false },
};
/** The depth bridge already normalizes its bounding box; its frame is camera-oriented like an image. */
export const DEPTH_MAPPING: SpaceMapping = IMAGE_MAPPING;
/**
 * Leap Motion on the desk between performer and display: source x already runs to the
 * performer's right, y up; source z runs toward the performer, so "pushed in" (toward the
 * display) is source z = 0.
 */
export const LEAP_MAPPING: SpaceMapping = {
  x: { from: 'x', low: 0, high: 1, mirror: false },
  y: { from: 'y', low: 0, high: 1, mirror: false },
  z: { from: 'z', low: 1, high: 0, mirror: false },
};

export function mapAxis(map: AxisMap, value: number): number {
  let t = (value - map.low) / (map.high - map.low);
  if (map.mirror) t = 1 - t;
  return Math.min(1, Math.max(0, t));
}

export function mapPoint(mapping: SpaceMapping, p: Vec3): Vec3 {
  return { x: mapAxis(mapping.x, p[mapping.x.from]), y: mapAxis(mapping.y, p[mapping.y.from]), z: mapAxis(mapping.z, p[mapping.z.from]) };
}

/** Map a source-frame box; corners may swap under mirroring so min/max are recomputed. */
export function mapBox(mapping: SpaceMapping, box: Box3): Box3 {
  const a = mapPoint(mapping, box.min), b = mapPoint(mapping, box.max);
  return { min: { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), z: Math.min(a.z, b.z) }, max: { x: Math.max(a.x, b.x), y: Math.max(a.y, b.y), z: Math.max(a.z, b.z) } };
}

/** Scale factor from a source axis interval onto sim [0, 1] (radii are scaled by the sim x axis's source). */
export function axisScale(map: AxisMap): number { return 1 / Math.abs(map.high - map.low); }

export function mapCapsule(mapping: SpaceMapping, c: Capsule): Capsule {
  return { a: mapPoint(mapping, c.a), b: mapPoint(mapping, c.b), radius: c.radius * axisScale(mapping.x) };
}

export function mapObservation(mapping: SpaceMapping, o: HandObservation): HandObservation {
  return { ...o, position: mapPoint(mapping, o.position), extent: o.extent ? mapBox(mapping, o.extent) : undefined, points: o.points?.map(p => mapPoint(mapping, p)), capsules: o.capsules?.map(c => mapCapsule(mapping, c)) };
}

/**
 * Resample a source-frame depth surface (row 0 = top, bytes = nearest depth) into a
 * sim-space surface field (row 0 = bottom, z in sim units). A surface is a height field
 * over the camera's image plane, so it only survives mappings that keep x→x, y→y, z→z
 * (any interval or mirror is fine); an axis swap returns null.
 */
export function mapSurface(mapping: SpaceMapping, surface: DepthSurface, width: number, height: number): SurfaceField | null {
  if (mapping.x.from !== 'x' || mapping.y.from !== 'y' || mapping.z.from !== 'z') return null;
  const z = new Float32Array(width * height).fill(1), mask = new Uint8Array(width * height);
  const sw = surface.width, sh = surface.height, data = surface.data;
  for (let row = 0; row < height; row++) {
    const simY = (row + .5) / height, sy = invertAxis(mapping.y, simY);
    if (sy < 0 || sy >= 1) continue;
    // Bilinear over the source cells, weighting only filled ones, so the field is smooth and empty
    // neighbours never pull a depth toward the far plane.
    const fy = sy * sh - .5, y0 = Math.max(0, Math.min(sh - 1, Math.floor(fy))), y1 = Math.min(sh - 1, y0 + 1), ty = Math.max(0, Math.min(1, fy - y0));
    for (let col = 0; col < width; col++) {
      const simX = (col + .5) / width, sx = invertAxis(mapping.x, simX);
      if (sx < 0 || sx >= 1) continue;
      const fx = sx * sw - .5, x0 = Math.max(0, Math.min(sw - 1, Math.floor(fx))), x1 = Math.min(sw - 1, x0 + 1), tx = Math.max(0, Math.min(1, fx - x0));
      let sum = 0, weight = 0, filled = 0;
      const tap = (gx: number, gy: number, wgt: number) => { const v = data[gy * sw + gx]; if (v === 0) return; sum += wgt * (v - 1) / 254; weight += wgt; filled += wgt; };
      tap(x0, y0, (1 - tx) * (1 - ty)); tap(x1, y0, tx * (1 - ty)); tap(x0, y1, (1 - tx) * ty); tap(x1, y1, tx * ty);
      if (filled < .5) continue; // the cell is mostly outside the scanned silhouette
      z[row * width + col] = mapAxis(mapping.z, sum / weight); mask[row * width + col] = 255;
    }
  }
  return { width, height, z, mask };
}

/**
 * Resample a source-frame voxel grid (z index 0 = nearest the camera) into a
 * sim-space volume (z index 0 = the glass), honouring all three axis maps.
 */
export function mapVoxels(mapping: SpaceMapping, grid: VoxelGrid, nx: number, ny: number, nz: number): VolumeField {
  const data = new Uint8Array(nx * ny * nz);
  const source: Record<Axis, number> = { x: .5, y: .5, z: .5 };
  for (let k = 0; k < nz; k++) {
    const simZ = (k + .5) / nz;
    for (let j = 0; j < ny; j++) {
      const simY = (j + .5) / ny;
      for (let i = 0; i < nx; i++) {
        const simX = (i + .5) / nx;
        source[mapping.x.from] = invertAxis(mapping.x, simX);
        source[mapping.y.from] = invertAxis(mapping.y, simY);
        source[mapping.z.from] = invertAxis(mapping.z, simZ);
        const sx = source.x, sy = source.y, sz = source.z;
        if (sx < 0 || sx >= 1 || sy < 0 || sy >= 1 || sz < 0 || sz >= 1) continue;
        const gx = Math.min(grid.nx - 1, Math.floor(sx * grid.nx)), gy = Math.min(grid.ny - 1, Math.floor(sy * grid.ny)), gz = Math.min(grid.nz - 1, Math.floor(sz * grid.nz));
        data[(k * ny + j) * nx + i] = grid.data[(gz * grid.ny + gy) * grid.nx + gx];
      }
    }
  }
  return { nx, ny, nz, data };
}

/**
 * Resample a source-frame occupancy grid (row 0 = top) into a sim-space field
 * (row 0 = bottom) of the requested size, honouring the x/y axis maps. The z
 * axis map is ignored; occupancy is a 2D projection.
 */
/** Inverse of `mapAxis`: sim coordinate → source coordinate. */
function invertAxis(map: AxisMap, t: number): number { if (map.mirror) t = 1 - t; return map.low + t * (map.high - map.low); }

export function mapOccupancy(mapping: SpaceMapping, grid: OccupancyGrid, width: number, height: number): OccupancyField {
  const data = new Uint8Array(width * height);
  // For each sim cell, find the source-frame coordinate by inverting the axis maps. One reused
  // scratch object: this runs for every cell of every frame.
  const source: Record<Axis, number> = { x: .5, y: .5, z: .5 };
  for (let row = 0; row < height; row++) {
    const simY = (row + .5) / height;
    for (let col = 0; col < width; col++) {
      const simX = (col + .5) / width;
      source.x = .5; source.y = .5; source.z = .5;
      source[mapping.x.from] = invertAxis(mapping.x, simX);
      source[mapping.y.from] = invertAxis(mapping.y, simY);
      const sx = source.x, sy = source.y;
      if (sx < 0 || sx >= 1 || sy < 0 || sy >= 1) continue;
      const gx = Math.min(grid.width - 1, Math.floor(sx * grid.width));
      const gy = Math.min(grid.height - 1, Math.floor(sy * grid.height));
      data[row * width + col] = grid.data[gy * grid.width + gx];
    }
  }
  return { width, height, data };
}

/**
 * Two-corner calibration. The performer holds a hand at the sim-space
 * bottom-left corner, then the top-right corner (and optionally at the
 * withdrawn and pushed-in depth extremes). Each capture is a source-frame
 * point; the result is a mapping that sends those points to the sim corners
 * while keeping the axis assignment of `base`.
 */
export interface CalibrationCaptures { bottomLeft?: Vec3; topRight?: Vec3; withdrawn?: Vec3; pushed?: Vec3 }

export function calibrateMapping(base: SpaceMapping, captures: CalibrationCaptures): SpaceMapping {
  const result: SpaceMapping = { x: { ...base.x }, y: { ...base.y }, z: { ...base.z } };
  const set = (axis: Axis, lowPoint: Vec3 | undefined, highPoint: Vec3 | undefined) => {
    if (!lowPoint || !highPoint) return;
    const from = base[axis].from;
    const low = lowPoint[from], high = highPoint[from];
    if (Math.abs(high - low) < .05) throw new Error(`Calibration span on sim ${axis} (source ${from}) is too small. Hold the corners farther apart.`);
    result[axis] = { from, low, high, mirror: false };
  };
  set('x', captures.bottomLeft, captures.topRight);
  set('y', captures.bottomLeft, captures.topRight);
  set('z', captures.withdrawn, captures.pushed);
  return spaceMappingSchema.parse(result);
}

/** Average a short burst of samples and reject a capture that moved. */
export function stableCapture(samples: { position: Vec3; atMs: number }[], minSamples = 8, minSpanMs = 400, maxWander = .04): Vec3 {
  if (samples.length < minSamples || samples[samples.length - 1].atMs - samples[0].atMs < minSpanMs) throw new Error('Hold still with the hand in view for at least half a second, then capture.');
  const mean = { x: 0, y: 0, z: 0 };
  for (const s of samples) { mean.x += s.position.x; mean.y += s.position.y; mean.z += s.position.z; }
  mean.x /= samples.length; mean.y /= samples.length; mean.z /= samples.length;
  for (const s of samples) if (Math.hypot(s.position.x - mean.x, s.position.y - mean.y) > maxWander) throw new Error('The hand moved during capture. Hold still and capture again.');
  return mean;
}
