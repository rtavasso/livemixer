/**
 * Position-based cloth for the Veil simulation. Plain TypeScript, no WebGL,
 * fully deterministic (no Math.random, no wall clock), typed arrays only.
 *
 * Space: the solver's own frame — x and y as the volume in uniform units
 * (canvas height = 1, x in [0, aspect], y up with the floor at 0), and z
 * measured from the sheet's resting plane TOWARD THE VIEWER. The sheet hangs
 * in the plane z = 0; a breeze from behind (the window) pushes it to +z and a
 * hand arriving from the viewer's side pushes it to −z. The volume's z runs
 * the other way (into the scene), so `colliders.ts` and the vertex shader
 * convert at the boundary: cloth z = plane − world z.
 *
 * Layout: `cols × rows` points, row 0 is the top (pinned to the rod), row
 * rows−1 is the hem. Point index = row * cols + col.
 *
 * Solver: Verlet integration + Gauss–Seidel distance constraints (structural,
 * shear, bend) + a long-range attachment to each column's pin (keeps a
 * hanging sheet from sagging with few iterations) + sphere colliders with
 * friction so fabric wraps around and trails behind a hand.
 *
 * Working arrays are Float64 (V8 avoids float conversions); the renderer
 * copies into its own Float32 upload buffer.
 */
import { rng } from '../../core/math';

export interface ClothOptions {
  cols: number;
  rows: number;
  /** Rod end points, uniform x. */
  rodX0: number;
  rodX1: number;
  /** Rod height (uniform y) and the hanging rest length of the fabric. */
  top: number;
  length: number;
  /** Fabric rest width divided by the rod span. >1 gathers the sheet into vertical folds. */
  gather: number;
  /** Number of folds seeded across the width so the sheet starts near equilibrium. */
  folds: number;
  /** Height (uniform y) below which no point may be pushed: the room's floor. Default 0. */
  floor?: number;
  seed?: number;
}

export interface ClothStepParams {
  /** Downward acceleration, units/s². */
  gravity: number;
  /** Velocity decay rate, 1/s. */
  damping: number;
  /** 0..1: shear and bend constraint stiffness (structural is always 1). */
  stiffness: number;
  /** Aerodynamic coupling: acceleration per unit of relative air speed along the normal (1/s) and tangentially. */
  dragNormal: number;
  dragTangent: number;
  /** Fraction of the hand's velocity picked up per substep by fabric touching it. */
  friction: number;
  substeps: number;
  iterations: number;
}

/** Colliders are packed 8 floats each: x, y, z, radius, vx, vy, vz, strength (0..1, scales the radius in/out). */
export const COLLIDER_STRIDE = 8;
export const MAX_COLLIDERS = 4;
/** Distance beyond a collider's surface that counts as contact (for the contact signal). */
export const CONTACT_SKIN = .05;
/** Penetration (per substep) at which friction fully couples fabric to the hand; shallower contact slides. */
export const FRICTION_SKIN = .006;
/** Rows over which the horizontal rest spacing eases from the gathered rod to the full fabric width (the "heading"). */
const HEADING_ROWS = 8;

const WIND_COLS = 7, WIND_ROWS = 9;

export class Cloth {
  readonly cols: number;
  readonly rows: number;
  readonly count: number;
  /** Current and previous positions, xyz interleaved. */
  readonly pos: Float64Array;
  readonly prev: Float64Array;
  /** Unit normals, xyz interleaved, refreshed at the start of every step (and on demand). */
  readonly normal: Float64Array;
  readonly invMass: Float64Array;
  /** x of each point's column when hanging straight: the "rest" reference for sway. */
  readonly restX: Float64Array;
  readonly uv: Float32Array;
  readonly indices: Uint16Array;
  /** Wind velocity lattice (windCols × windRows × xyz), bilinearly interpolated over the grid. Row 0 = top. */
  readonly wind: Float64Array;
  readonly windCols = WIND_COLS;
  readonly windRows = WIND_ROWS;

  // Signals, refreshed by step().
  /** Mean |d − rest| / rest over structural constraints. */
  meanStrain = 0;
  /** Mean point speed, units/s. */
  meanSpeed = 0;
  /** Fraction of points within a collider's surface + CONTACT_SKIN. */
  contactFraction = 0;
  /** Mean signed z. */
  meanZ = 0;
  /** Mean |x − restX|. */
  meanAbsDx = 0;

  rodX0: number; rodX1: number;
  top: number; length: number;
  readonly floor: number; readonly gather: number; readonly folds: number;
  private readonly seed: number;
  private dy = 0;
  // Constraints: horizontal/vertical structural, shear, horizontal/vertical bend, long-range attachment.
  private readonly hA: Int32Array; private readonly hB: Int32Array; private readonly hRest: Float64Array; private readonly hWa: Float64Array; private readonly hWb: Float64Array;
  private readonly vA: Int32Array; private readonly vB: Int32Array; private readonly vRest: Float64Array; private readonly vWa: Float64Array; private readonly vWb: Float64Array;
  private readonly sA: Int32Array; private readonly sB: Int32Array; private readonly sRest: Float64Array; private readonly sWa: Float64Array; private readonly sWb: Float64Array;
  private readonly bhA: Int32Array; private readonly bhB: Int32Array; private readonly bhRest: Float64Array; private readonly bhWa: Float64Array; private readonly bhWb: Float64Array;
  private readonly bvA: Int32Array; private readonly bvB: Int32Array; private readonly bvRest: Float64Array; private readonly bvWa: Float64Array; private readonly bvWb: Float64Array;
  private readonly lraMax: Float64Array;
  // Bilinear wind lookup, precomputed per column / row.
  private readonly wu0: Int32Array; private readonly wuf: Float64Array;
  private readonly wv0: Int32Array; private readonly wvf: Float64Array;

  constructor(options: ClothOptions) {
    const cols = Math.max(3, options.cols | 0), rows = Math.max(3, options.rows | 0);
    if (cols * rows > 65535) throw new Error('Cloth grid too large for 16-bit indices.');
    this.cols = cols; this.rows = rows; this.count = cols * rows;
    this.rodX0 = options.rodX0; this.rodX1 = options.rodX1;
    this.top = options.top; this.length = options.length; this.floor = options.floor ?? 0;
    this.gather = Math.max(1, options.gather); this.folds = Math.max(1, options.folds);
    this.seed = options.seed ?? 1;
    const n = this.count;
    this.pos = new Float64Array(n * 3); this.prev = new Float64Array(n * 3); this.normal = new Float64Array(n * 3);
    this.invMass = new Float64Array(n); this.restX = new Float64Array(n); this.uv = new Float32Array(n * 2);
    this.wind = new Float64Array(WIND_COLS * WIND_ROWS * 3);
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) { const i = r * cols + c; this.uv[i * 2] = c / (cols - 1); this.uv[i * 2 + 1] = r / (rows - 1); this.invMass[i] = r === 0 ? 0 : 1; }

    // Constraint topology (fixed order → deterministic Gauss–Seidel).
    const hN = (cols - 1) * rows, vN = cols * (rows - 1), sN = (cols - 1) * (rows - 1), bhN = (cols - 2) * rows, bvN = cols * (rows - 2);
    this.hA = new Int32Array(hN); this.hB = new Int32Array(hN); this.hRest = new Float64Array(hN); this.hWa = new Float64Array(hN); this.hWb = new Float64Array(hN);
    this.vA = new Int32Array(vN); this.vB = new Int32Array(vN); this.vRest = new Float64Array(vN); this.vWa = new Float64Array(vN); this.vWb = new Float64Array(vN);
    this.sA = new Int32Array(sN); this.sB = new Int32Array(sN); this.sRest = new Float64Array(sN); this.sWa = new Float64Array(sN); this.sWb = new Float64Array(sN);
    this.bhA = new Int32Array(bhN); this.bhB = new Int32Array(bhN); this.bhRest = new Float64Array(bhN); this.bhWa = new Float64Array(bhN); this.bhWb = new Float64Array(bhN);
    this.bvA = new Int32Array(bvN); this.bvB = new Int32Array(bvN); this.bvRest = new Float64Array(bvN); this.bvWa = new Float64Array(bvN); this.bvWb = new Float64Array(bvN);
    this.lraMax = new Float64Array(n);
    // Ordering: consecutive constraints never share a point (red-black by column, mod 4 for bend), so the
    // CPU can overlap them instead of stalling on the previous constraint's writes. Vertical constraints run
    // top → bottom (columns are independent, and pin corrections propagate down the sheet in one sweep).
    let h = 0, s = 0, bh = 0;
    for (let r = 0; r < rows; r++) {
      for (let parity = 0; parity < 2; parity++) for (let c = parity; c + 1 < cols; c += 2) { const i = r * cols + c; this.hA[h] = i; this.hB[h] = i + 1; h++; }
      for (let phase = 0; phase < 4; phase++) for (let c = phase; c + 2 < cols; c += 4) { const i = r * cols + c; this.bhA[bh] = i; this.bhB[bh] = i + 2; bh++; }
      if (r + 1 < rows) for (let parity = 0; parity < 2; parity++) for (let c = parity; c + 1 < cols; c += 2) {
        const i = r * cols + c;
        // One diagonal per cell, alternating direction, so the sheet stays symmetric on average at half the cost.
        if ((r + c) & 1) { this.sA[s] = i; this.sB[s] = i + cols + 1; } else { this.sA[s] = i + 1; this.sB[s] = i + cols; }
        s++;
      }
    }
    let v = 0, bv = 0;
    for (let r = 0; r + 1 < rows; r++) for (let c = 0; c < cols; c++) { const i = r * cols + c; this.vA[v] = i; this.vB[v] = i + cols; v++; }
    for (let r = 0; r + 2 < rows; r++) for (let c = 0; c < cols; c++) { const i = r * cols + c; this.bvA[bv] = i; this.bvB[bv] = i + 2 * cols; bv++; }
    weights(this.invMass, this.hA, this.hB, this.hWa, this.hWb); weights(this.invMass, this.vA, this.vB, this.vWa, this.vWb); weights(this.invMass, this.sA, this.sB, this.sWa, this.sWb);
    weights(this.invMass, this.bhA, this.bhB, this.bhWa, this.bhWb); weights(this.invMass, this.bvA, this.bvB, this.bvWa, this.bvWb);

    this.indices = new Uint16Array((cols - 1) * (rows - 1) * 6);
    let k = 0;
    for (let r = 0; r + 1 < rows; r++) for (let c = 0; c + 1 < cols; c++) {
      const i = r * cols + c;
      this.indices[k++] = i; this.indices[k++] = i + cols; this.indices[k++] = i + 1;
      this.indices[k++] = i + 1; this.indices[k++] = i + cols; this.indices[k++] = i + cols + 1;
    }

    this.wu0 = new Int32Array(cols); this.wuf = new Float64Array(cols); this.wv0 = new Int32Array(rows); this.wvf = new Float64Array(rows);
    for (let c = 0; c < cols; c++) { const u = c / (cols - 1) * (WIND_COLS - 1); const i0 = Math.min(WIND_COLS - 2, Math.floor(u)); this.wu0[c] = i0; this.wuf[c] = u - i0; }
    for (let r = 0; r < rows; r++) { const u = r / (rows - 1) * (WIND_ROWS - 1); const j0 = Math.min(WIND_ROWS - 2, Math.floor(u)); this.wv0[r] = j0; this.wvf[r] = u - j0; }

    this.buildRests();
    this.reset();
  }

  /**
   * Move the rod ends (after the canvas aspect changes, or the sheet's depth: a deeper sheet must be larger
   * to fill the view) and optionally re-hang the sheet at a new rod height and length. The sheet reflows
   * with the rod: x and z are scaled about the rod's left end by the new/old span ratio, y about the rod by
   * the new/old length ratio, so every rest length and every fold scale together and the constraints stay
   * as satisfied as they were. Merely moving the pins would leave the whole sheet to swing for seconds,
   * with strain well above resting while it does.
   */
  setExtent(rodX0: number, rodX1: number, top = this.top, length = this.length) {
    const oldX0 = this.rodX0, oldSpan = this.rodX1 - this.rodX0, span = rodX1 - rodX0, oldTop = this.top, oldLength = this.length;
    const ratio = oldSpan > 1e-9 ? span / oldSpan : 1, ratioY = oldLength > 1e-9 ? length / oldLength : 1;
    this.rodX0 = rodX0; this.rodX1 = rodX1; this.top = top; this.length = length;
    this.buildRests();
    const cols = this.cols, pos = this.pos, prev = this.prev;
    for (let r = 0; r < this.rows; r++) for (let c = 0; c < cols; c++) this.restX[r * cols + c] = rodX0 + span * c / (cols - 1);
    for (let i = 0; i < this.count; i++) {
      const o = i * 3;
      pos[o] = rodX0 + (pos[o] - oldX0) * ratio; prev[o] = rodX0 + (prev[o] - oldX0) * ratio;
      pos[o + 1] = top + (pos[o + 1] - oldTop) * ratioY; prev[o + 1] = top + (prev[o + 1] - oldTop) * ratioY;
      pos[o + 2] *= ratio; prev[o + 2] *= ratio;
    }
    for (let c = 0; c < cols; c++) { const i = c * 3; pos[i] = prev[i] = this.restX[c]; pos[i + 1] = prev[i + 1] = this.top; pos[i + 2] = prev[i + 2] = 0; }
  }

  /** Horizontal rest spacing of a row: gathered at the rod, easing to the full fabric width below the heading. */
  private rowDx(r: number): number {
    const span = (this.rodX1 - this.rodX0) / (this.cols - 1);
    const t = Math.min(1, r / HEADING_ROWS);
    return span * (1 + (this.gather - 1) * t * t * (3 - 2 * t));
  }

  private buildRests() {
    const cols = this.cols, rows = this.rows;
    const dy = this.length / (rows - 1);
    this.dy = dy;
    const rowOf = (i: number) => Math.floor(i / cols);
    for (let k = 0; k < this.hA.length; k++) this.hRest[k] = this.rowDx(rowOf(this.hA[k]));
    for (let k = 0; k < this.bhA.length; k++) this.bhRest[k] = 2 * this.rowDx(rowOf(this.bhA[k]));
    for (let k = 0; k < this.sA.length; k++) { const r = Math.min(rowOf(this.sA[k]), rowOf(this.sB[k])); this.sRest[k] = Math.hypot(.5 * (this.rowDx(r) + this.rowDx(r + 1)), dy); }
    this.vRest.fill(dy); this.bvRest.fill(2 * dy);
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) this.lraMax[r * cols + c] = r * dy;
  }

  /** Put the sheet back to its gathered, gently folded rest state. Deterministic. */
  reset() {
    const cols = this.cols, rows = this.rows, span = this.rodX1 - this.rodX0;
    const random = rng(this.seed);
    // Sinusoidal folds whose arc length matches the gathered excess: (πA/λ)² ≈ gather − 1.
    const lambda = span / this.folds, amp = lambda * Math.sqrt(Math.max(0, this.gather - 1)) / Math.PI;
    for (let r = 0; r < rows; r++) {
      const taper = Math.min(1, r / HEADING_ROWS);
      for (let c = 0; c < cols; c++) {
        const i = r * cols + c, u = c / (cols - 1);
        const x = this.rodX0 + span * u, y = this.top - r * this.dy;
        const z = taper * (amp * Math.sin(u * this.folds * Math.PI * 2) + (random() - .5) * .004);
        this.restX[i] = x;
        this.pos[i * 3] = this.prev[i * 3] = x; this.pos[i * 3 + 1] = this.prev[i * 3 + 1] = y; this.pos[i * 3 + 2] = this.prev[i * 3 + 2] = z;
      }
    }
    this.computeNormals();
    this.meanStrain = 0; this.meanSpeed = 0; this.contactFraction = 0; this.meanZ = 0; this.meanAbsDx = 0;
  }

  /** Per-point unit normals from the grid neighbours. Flat sheet facing the viewer → +z. */
  computeNormals(src: Float64Array | Float32Array = this.pos, dst: Float64Array | Float32Array = this.normal, dstStride = 3, dstOffset = 0) {
    const cols = this.cols, rows = this.rows;
    for (let r = 0; r < rows; r++) {
      const rUp = r > 0 ? r - 1 : r, rDown = r + 1 < rows ? r + 1 : r;
      for (let c = 0; c < cols; c++) {
        const cl = c > 0 ? c - 1 : c, cr = c + 1 < cols ? c + 1 : c;
        const a = (r * cols + cr) * 3, b = (r * cols + cl) * 3, u = (rUp * cols + c) * 3, d = (rDown * cols + c) * 3;
        const tx = src[a] - src[b], ty = src[a + 1] - src[b + 1], tz = src[a + 2] - src[b + 2];
        const vx = src[u] - src[d], vy = src[u + 1] - src[d + 1], vz = src[u + 2] - src[d + 2];
        let nx = ty * vz - tz * vy, ny = tz * vx - tx * vz, nz = tx * vy - ty * vx;
        const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
        if (len > 1e-12) { nx /= len; ny /= len; nz /= len; } else { nx = 0; ny = 0; nz = 1; }
        const o = (r * cols + c) * dstStride + dstOffset;
        dst[o] = nx; dst[o + 1] = ny; dst[o + 2] = nz;
      }
    }
  }

  /**
   * Advance by `dt` seconds. `colliders` holds up to `colliderCount` spheres
   * packed with COLLIDER_STRIDE. The wind lattice must already be filled.
   */
  step(dt: number, p: ClothStepParams, colliders: Float32Array | Float64Array, colliderCount: number) {
    const sub = Math.max(1, p.substeps | 0), iterations = Math.max(1, p.iterations | 0);
    const h = dt / sub, h2 = h * h, damp = Math.exp(-p.damping * h);
    const stiff = Math.min(1, Math.max(0, p.stiffness));
    // Per-iteration stiffness so the total correction after `iterations` passes matches the requested k.
    const kShear = 1 - Math.pow(1 - (.25 + .7 * stiff), 1 / iterations);
    const kBend = .08 + .5 * stiff * stiff;
    const pos = this.pos, prev = this.prev, w = this.invMass, nrm = this.normal, wind = this.wind;
    const cols = this.cols, rows = this.rows, n = this.count;
    const wu0 = this.wu0, wuf = this.wuf, wv0 = this.wv0, wvf = this.wvf, wc3 = WIND_COLS * 3;
    const g = p.gravity, dn = p.dragNormal, dtg = p.dragTangent, invH = 1 / h;
    const nCol = Math.min(MAX_COLLIDERS, colliderCount | 0);

    this.computeNormals();
    let speedSum = 0, contacts = 0;
    for (let s = 0; s < sub; s++) {
      // --- integrate (Verlet with aerodynamic wind coupling)
      for (let r = 1; r < rows; r++) {
        const j0 = wv0[r], fv = wvf[r], fv1 = 1 - fv;
        for (let c = 0; c < cols; c++) {
          const i = r * cols + c;
          if (w[i] === 0) continue;
          const o = i * 3;
          const px = pos[o], py = pos[o + 1], pz = pos[o + 2];
          const vx = (px - prev[o]) * damp, vy = (py - prev[o + 1]) * damp, vz = (pz - prev[o + 2]) * damp;
          speedSum += Math.sqrt(vx * vx + vy * vy + vz * vz);
          // wind at this point (bilinear over the lattice)
          const i0 = wu0[c], fu = wuf[c], fu1 = 1 - fu;
          const a = j0 * wc3 + i0 * 3, b = a + 3, cc = a + wc3, d = cc + 3;
          const wx = (wind[a] * fu1 + wind[b] * fu) * fv1 + (wind[cc] * fu1 + wind[d] * fu) * fv;
          const wy = (wind[a + 1] * fu1 + wind[b + 1] * fu) * fv1 + (wind[cc + 1] * fu1 + wind[d + 1] * fu) * fv;
          const wz = (wind[a + 2] * fu1 + wind[b + 2] * fu) * fv1 + (wind[cc + 2] * fu1 + wind[d + 2] * fu) * fv;
          // relative air velocity; the sheet catches air along its normal
          const rx = wx - vx * invH, ry = wy - vy * invH, rz = wz - vz * invH;
          const nx = nrm[o], ny = nrm[o + 1], nz = nrm[o + 2];
          const along = (nx * rx + ny * ry + nz * rz) * dn;
          const ax = along * nx + dtg * rx, ay = along * ny + dtg * ry - g, az = along * nz + dtg * rz;
          prev[o] = px; prev[o + 1] = py; prev[o + 2] = pz;
          pos[o] = px + vx + ax * h2; pos[o + 1] = py + vy + ay * h2; pos[o + 2] = pz + vz + az * h2;
        }
      }
      // --- constraints
      for (let it = 0; it < iterations; it++) {
        solveDistance(pos, this.hA, this.hB, this.hRest, this.hWa, this.hWb, 1);
        solveDistance(pos, this.vA, this.vB, this.vRest, this.vWa, this.vWb, 1);
        solveDistance(pos, this.sA, this.sB, this.sRest, this.sWa, this.sWb, kShear);
        if (it === 0) { solveDistance(pos, this.bhA, this.bhB, this.bhRest, this.bhWa, this.bhWb, kBend); solveDistance(pos, this.bvA, this.bvB, this.bvRest, this.bvWa, this.bvWb, kBend); }
      }
      this.longRangeAttachment();
      // Colliders last, so no point ends a substep inside a hand.
      const count = s === sub - 1;
      for (let k = 0; k < nCol; k++) contacts += this.collide(colliders, k * COLLIDER_STRIDE, h, p.friction, count);
      // Only a hand can push fabric below the floor (the attachment keeps the hem at top − length otherwise).
      if (nCol > 0) { const floor = this.floor; for (let i = cols; i < n; i++) { const o = i * 3 + 1; if (pos[o] < floor) pos[o] = floor; } }
    }
    // --- signals
    this.meanSpeed = speedSum / (sub * n) * invH;
    this.contactFraction = Math.min(1, contacts / n);
    let strain = 0;
    const hA = this.hA, hB = this.hB, hRest = this.hRest, vA = this.vA, vB = this.vB, vRest = this.vRest;
    for (let c = 0; c < hA.length; c++) { const i = hA[c] * 3, j = hB[c] * 3; const dx = pos[j] - pos[i], dy = pos[j + 1] - pos[i + 1], dz = pos[j + 2] - pos[i + 2]; strain += Math.abs(Math.sqrt(dx * dx + dy * dy + dz * dz) - hRest[c]) / hRest[c]; }
    for (let c = 0; c < vA.length; c++) { const i = vA[c] * 3, j = vB[c] * 3; const dx = pos[j] - pos[i], dy = pos[j + 1] - pos[i + 1], dz = pos[j + 2] - pos[i + 2]; strain += Math.abs(Math.sqrt(dx * dx + dy * dy + dz * dz) - vRest[c]) / vRest[c]; }
    this.meanStrain = strain / (hA.length + vA.length);
    let zSum = 0, dxSum = 0;
    const restX = this.restX;
    for (let i = 0; i < n; i++) { zSum += pos[i * 3 + 2]; dxSum += Math.abs(pos[i * 3] - restX[i]); }
    this.meanZ = zSum / n; this.meanAbsDx = dxSum / n;
    if (!Number.isFinite(this.meanZ) || !Number.isFinite(this.meanStrain)) this.reset();
  }

  /** Each point stays within its rest geodesic distance of its column's pin. Pull-only, so folds are untouched. */
  private longRangeAttachment() {
    const pos = this.pos, cols = this.cols, rows = this.rows, lraMax = this.lraMax;
    for (let r = 1; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const i = r * cols + c, o = i * 3, a = c * 3;
        const dx = pos[o] - pos[a], dy = pos[o + 1] - pos[a + 1], dz = pos[o + 2] - pos[a + 2];
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz), max = lraMax[i];
        if (d > max && d > 1e-9) { const s = max / d; pos[o] = pos[a] + dx * s; pos[o + 1] = pos[a + 1] + dy * s; pos[o + 2] = pos[a + 2] + dz * s; }
      }
    }
  }

  /** Push points out of one sphere and couple nearby fabric to the hand's velocity. Returns the contact count when `count` is set. */
  private collide(col: Float32Array | Float64Array, o: number, h: number, friction: number, count: boolean): number {
    const strength = col[o + 7];
    if (strength <= 0) return 0;
    const ease = strength * strength * (3 - 2 * strength);
    const cx = col[o], cy = col[o + 1], cz = col[o + 2], radius = col[o + 3] * ease;
    if (radius <= 1e-4) return 0;
    const tx = col[o + 4] * h, ty = col[o + 5] * h, tz = col[o + 6] * h;
    const pos = this.pos, prev = this.prev, w = this.invMass, n = this.count;
    const reach = radius + CONTACT_SKIN, reach2 = reach * reach, r2 = radius * radius, invPen = 1 / FRICTION_SKIN, mu = friction * ease;
    let contacts = 0;
    for (let i = 0; i < n; i++) {
      if (w[i] === 0) continue;
      const p = i * 3;
      let dx = pos[p] - cx, dy = pos[p + 1] - cy, dz = pos[p + 2] - cz;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 >= reach2) continue;
      if (count) contacts++;
      const d = Math.sqrt(d2);
      if (d < radius) {
        // Friction grows with how hard the hand presses (penetration this substep): grazing fabric slides,
        // fabric the hand pushes into travels with it. Blend the point's displacement toward the hand's.
        const k = mu * Math.min(1, (radius - d) * invPen);
        pos[p] += (tx - (pos[p] - prev[p])) * k;
        pos[p + 1] += (ty - (pos[p + 1] - prev[p + 1])) * k;
        pos[p + 2] += (tz - (pos[p + 2] - prev[p + 2])) * k;
        dx = pos[p] - cx; dy = pos[p + 1] - cy; dz = pos[p + 2] - cz;
      }
      // then project onto the surface (a point at the exact centre is pushed toward the viewer)
      const e2 = dx * dx + dy * dy + dz * dz;
      if (e2 < r2) {
        if (e2 > 1e-14) { const s = radius / Math.sqrt(e2); pos[p] = cx + dx * s; pos[p + 1] = cy + dy * s; pos[p + 2] = cz + dz * s; }
        else pos[p + 2] = cz + radius;
      }
    }
    return contacts;
  }

  /** True when any non-pinned point lies strictly inside the sphere (for tests). */
  anyInside(cx: number, cy: number, cz: number, radius: number, tolerance = 1e-6): boolean {
    const pos = this.pos, r2 = (radius - tolerance) * (radius - tolerance);
    for (let i = 0; i < this.count; i++) {
      if (this.invMass[i] === 0) continue;
      const dx = pos[i * 3] - cx, dy = pos[i * 3 + 1] - cy, dz = pos[i * 3 + 2] - cz;
      if (dx * dx + dy * dy + dz * dz < r2) return true;
    }
    return false;
  }
}

/** Per-constraint correction shares wa/(wa+wb), wb/(wa+wb); zero for pinned pairs. */
function weights(w: Float64Array, A: Int32Array, B: Int32Array, outA: Float64Array, outB: Float64Array) {
  for (let c = 0; c < A.length; c++) { const wa = w[A[c]], wb = w[B[c]], ws = wa + wb; outA[c] = ws > 0 ? wa / ws : 0; outB[c] = ws > 0 ? wb / ws : 0; }
}

/** Gauss–Seidel distance constraints; `k` is the per-pass stiffness. */
function solveDistance(pos: Float64Array, A: Int32Array, B: Int32Array, rest: Float64Array, wa: Float64Array, wb: Float64Array, k: number) {
  const n = A.length;
  for (let c = 0; c < n; c++) {
    const i = A[c] * 3, j = B[c] * 3;
    const dx = pos[j] - pos[i], dy = pos[j + 1] - pos[i + 1], dz = pos[j + 2] - pos[i + 2];
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (d < 1e-9) continue;
    const f = (d - rest[c]) / d * k;
    const sa = f * wa[c], sb = f * wb[c];
    pos[i] += dx * sa; pos[i + 1] += dy * sa; pos[i + 2] += dz * sa;
    pos[j] -= dx * sb; pos[j + 1] -= dy * sb; pos[j + 2] -= dz * sb;
  }
}
