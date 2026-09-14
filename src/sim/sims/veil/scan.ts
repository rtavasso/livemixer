/**
 * The depth camera's scan as a solid for the Veil. Plain TypeScript, no WebGL,
 * deterministic given the sequence of update calls.
 *
 * `SimInput.surface` is a height field over the front face of the volume: for
 * each cell, the sim depth of the nearest scanned point and a mask. A hand is
 * only ever seen from the front, so the scan is a shell, not a closed volume:
 * the cloth treats everything from the scanned front down to SCAN_THICKNESS
 * behind it as solid. A hand approaching the sheet from the front therefore
 * meets it with the shell's back face and pushes the fabric ahead of it; a
 * sheet that swings onto a hand behind it rests on the front face. Whichever
 * face is nearer is the way out, tilted by the local slope so fabric slides
 * off the sides of fingers rather than hanging on them.
 *
 * The scan changes once per camera frame; its per-cell change gives a depth
 * velocity the fabric picks up through friction (the camera cannot tell how
 * the hand moved sideways, so only z is known).
 *
 * All sampling is bilinear over filled cells only (as `sampleSurface` in
 * `gl/surface.ts`), inlined here without allocation because the solver asks
 * for thousands of samples per step.
 */
import type { SurfaceField } from '../../core/types';

/** Solid thickness behind the scanned front, in sim z units (about a hand's depth in a 0.7-deep box). */
export const SCAN_THICKNESS = .08;
/** Largest lateral push per unit of depth exit: caps the slope so a silhouette edge cannot fling fabric sideways. */
export const SCAN_SLOPE_MAX = 1.5;
/** Largest scan depth velocity the fabric follows, sim z per second (a flickering cell must not fling it). */
const SCAN_VZ_MAX = 4;

export class ScanShell {
  /** The current field, or null when there is no scan (or nothing in it). */
  field: SurfaceField | null = null;
  /** Conversion of the volume into the cloth frame: x scaled by `aspect`, z by `depth` and measured from `plane` toward the viewer. */
  aspect = 1; depth = 1; plane = 0;
  /** Bounding box of the scanned cells in world units (x, y) and world z (front of the shell to the back of it); empty when x1 < x0. */
  x0 = 0; x1 = -1; y0 = 0; y1 = -1; z0 = 0; z1 = 0;
  /** Number of filled cells in the current field. */
  filled = 0;
  // Last sample: sim depth, mask 0..1, depth velocity (sim z / s); last slopes: world dz/dx, dz/dy (clamped).
  sz = 1; smask = 0; svz = 0;
  gx = 0; gy = 0;
  private lastField: SurfaceField | null = null;
  private prevZ = new Float32Array(0);
  private prevMask = new Uint8Array(0);
  private vz = new Float32Array(0);
  private sinceChange = 0;

  get active() { return this.field !== null && this.filled > 0; }

  /** Take this step's field (null when the source has none). Recomputes the box and the depth velocity when the field changed. */
  update(field: SurfaceField | null, dt: number, aspect: number, depth: number, plane: number) {
    this.aspect = aspect; this.depth = depth; this.plane = plane;
    this.sinceChange += dt;
    if (!field) { this.field = null; this.lastField = null; this.filled = 0; this.x1 = -1; return; }
    if (field !== this.lastField) {
      const n = field.width * field.height, same = this.lastField !== null && this.lastField.width === field.width && this.lastField.height === field.height;
      if (this.vz.length !== n) { this.vz = new Float32Array(n); this.prevZ = new Float32Array(n); this.prevMask = new Uint8Array(n); }
      const vz = this.vz, prevZ = this.prevZ, prevMask = this.prevMask, mask = field.mask, z = field.z, elapsed = Math.max(1e-3, this.sinceChange);
      let filled = 0, cx0 = field.width, cx1 = -1, cy0 = field.height, cy1 = -1, zMin = 1, zMax = 0;
      for (let row = 0; row < field.height; row++) for (let col = 0; col < field.width; col++) {
        const i = row * field.width + col;
        if (mask[i]) {
          filled++;
          if (col < cx0) cx0 = col; if (col > cx1) cx1 = col; if (row < cy0) cy0 = row; if (row > cy1) cy1 = row;
          if (z[i] < zMin) zMin = z[i]; if (z[i] > zMax) zMax = z[i];
          const v = same && prevMask[i] ? (z[i] - prevZ[i]) / elapsed : 0;
          vz[i] = v > SCAN_VZ_MAX ? SCAN_VZ_MAX : v < -SCAN_VZ_MAX ? -SCAN_VZ_MAX : v;
        } else vz[i] = 0;
      }
      prevZ.set(z); prevMask.set(mask);
      this.filled = filled;
      if (filled) {
        // One cell of margin so bilinear taps at the silhouette are inside the box.
        this.x0 = (cx0 - 1) / field.width * aspect; this.x1 = (cx1 + 2) / field.width * aspect;
        this.y0 = (cy0 - 1) / field.height; this.y1 = (cy1 + 2) / field.height;
        this.z0 = zMin * depth; this.z1 = (zMax + SCAN_THICKNESS) * depth;
      } else this.x1 = -1;
      this.lastField = field; this.sinceChange = 0;
    }
    this.field = field;
  }

  /** Bilinear sample at sim (x, y) into `sz`, `smask`, `svz`: filled cells only pull the depth and velocity. */
  sample(sx: number, sy: number) {
    const f = this.field!, W = f.width, H = f.height, mask = f.mask, z = f.z, vz = this.vz;
    const fx = sx * W - .5, fy = sy * H - .5;
    let x0 = Math.floor(fx), y0 = Math.floor(fy);
    x0 = x0 < 0 ? 0 : x0 > W - 1 ? W - 1 : x0; y0 = y0 < 0 ? 0 : y0 > H - 1 ? H - 1 : y0;
    const x1 = x0 + 1 < W ? x0 + 1 : x0, y1 = y0 + 1 < H ? y0 + 1 : y0;
    let tx = fx - x0, ty = fy - y0;
    tx = tx < 0 ? 0 : tx > 1 ? 1 : tx; ty = ty < 0 ? 0 : ty > 1 ? 1 : ty;
    const i00 = y0 * W + x0, i10 = y0 * W + x1, i01 = y1 * W + x0, i11 = y1 * W + x1;
    const w00 = (1 - tx) * (1 - ty) * mask[i00], w10 = tx * (1 - ty) * mask[i10], w01 = (1 - tx) * ty * mask[i01], w11 = tx * ty * mask[i11];
    const ws = w00 + w10 + w01 + w11;
    this.smask = ws / 255;
    if (ws > 0) { this.sz = (w00 * z[i00] + w10 * z[i10] + w01 * z[i01] + w11 * z[i11]) / ws; this.svz = (w00 * vz[i00] + w10 * vz[i10] + w01 * vz[i01] + w11 * vz[i11]) / ws; }
    else { this.sz = 1; this.svz = 0; }
  }

  /**
   * Slopes of the shell at sim (x, y) in world units (dz/dx, dz/dy), one-sided where a neighbour is unfilled so a
   * silhouette edge has no slope of its own, and clamped to SCAN_SLOPE_MAX. Leaves `sz`/`smask`/`svz` as sampled here.
   */
  slopes(sx: number, sy: number) {
    const f = this.field!, ex = 1 / f.width, ey = 1 / f.height;
    this.sample(sx, sy);
    const zc = this.sz, mc = this.smask, vc = this.svz;
    this.sample(sx + ex, sy); const zr = this.sz, mr = this.smask >= .5 ? 1 : 0;
    this.sample(sx - ex, sy); const zl = this.sz, ml = this.smask >= .5 ? 1 : 0;
    this.sample(sx, sy + ey); const zu = this.sz, mu = this.smask >= .5 ? 1 : 0;
    this.sample(sx, sy - ey); const zd = this.sz, md = this.smask >= .5 ? 1 : 0;
    let gx = mr + ml > 0 ? ((mr ? zr : zc) - (ml ? zl : zc)) / ((mr + ml) * ex) * this.depth / this.aspect : 0;
    let gy = mu + md > 0 ? ((mu ? zu : zc) - (md ? zd : zc)) / ((mu + md) * ey) * this.depth : 0;
    const l = Math.sqrt(gx * gx + gy * gy);
    if (l > SCAN_SLOPE_MAX) { gx *= SCAN_SLOPE_MAX / l; gy *= SCAN_SLOPE_MAX / l; }
    this.gx = gx; this.gy = gy;
    this.sz = zc; this.smask = mc; this.svz = vc;
  }
}
