/**
 * Murmuration: the CPU flock and its mood (no GL; deterministic; unit-tested).
 *
 * Motes live in "uniform" units (picture height = 1, width = aspect) so distances are round on
 * screen; `x / aspect, y` is the picture uv. Each mote also carries a small depth `z` (0 far … 1
 * near) used only for size/brightness parallax: it follows the large-scale stream function, so a
 * folding ribbon tilts in depth coherently.
 *
 * Per step, O(n):
 *  1. a uniform grid (counting sort, with a cell-ordered copy of the state) indexes the motes;
 *     every `NB_STRIDE` steps each mote samples at most ~`MAX_EXAMINE` candidates from its 3×3
 *     cells (in proportion to their occupancy) for separation / alignment / cohesion, and scales
 *     the sample up to a density estimate: above `RHO_0` cohesion turns into pressure, so dense
 *     knots spread into sheets instead of collapsing;
 *  2. a coarse grid of a slowly evolving noise stream function gives a divergence-free flow the
 *     flock steers toward, plus a wandering attractor that keeps it one body: the idle flock
 *     stretches into folding ribbons and sheets rather than a blob;
 *  3. hands: attraction from a distance, repulsion inside a ring at hand radius + margin; with
 *     boldness the ring becomes an orbiting halo, and long stillness (`hold`) tightens it; a fast
 *     hand near the flock tears it apart with an outward impulse and fear loosens the flock so it
 *     re-forms over several seconds. Each hand shapes its gathered halo (scaled by boldness): a
 *     fist (`grip`) pulls it into a small, dense, brighter ball; a palm turned up lifts the halo's
 *     centre above the hand, turned down settles it below (`palmUp`). Both arrive smoothed.
 *
 * Fear is driven by the hand's speed near the flock (the threat), not by the flock's own
 * turbulence, so the tearing impulse cannot excite itself: flock agitation enters the mood only at
 * a weight that stays below the startle level on its own.
 */
import type { SimInput } from '../../core/types';
import { approach, clamp01, rng, smoothstep } from '../../core/math';
import { Noise } from '../../core/noise';
import { beatPulse } from '../../core/music';
import { Follower, Mood, pictureHands, topFade, type PictureHand } from '../living';

/** Neighbour radius and grid cell size (uniform units). */
export const R_NEIGHBOUR = .045;
/** Separation radius. */
export const R_SEPARATE = .007;
const INV_CELL = 1 / R_NEIGHBOUR;
/** Neighbour candidates examined per mote at most: bounds the cost inside dense knots. */
export const MAX_EXAMINE = 20;
/** Steps between neighbourhood refreshes of one mote. */
export const NB_STRIDE = 3;
/** Preferred speed, uniform units per second. */
export const CRUISE = .2;
/** Neighbours within `R_NEIGHBOUR` the flock settles at: denser than this, cohesion becomes pressure. */
export const RHO_0 = 60;
/** Closeness: flock share within `CLOSE_RADII` hand radii of the primary hand that counts as "fully wrapped". */
export const CLOSE_RADII = 2.5;
export const HALO_SHARE = .7;
/** Radius around a fast hand within which it frightens and scatters the flock (uniform units). */
export const THREAT_RADIUS = .38;
/** Soft inset from the active-area edge the flock is steered inside (uniform units). */
const EDGE_MARGIN = .06;
const FLOW_COLS = 20, FLOW_ROWS = 12;

export interface MurmurationParams {
  /** 0 = cohesive, clumpy flock … 1 = motes follow the large-scale flow (ribbons). */
  flow: number;
  /** Strength of the hands' pull. */
  attraction: number;
  /** How far a fist shrinks the gathered halo (0 = no effect … 0.8 = to a fifth of its radius). */
  gripTighten: number;
  /** How far (picture heights) a palm turned fully up lifts the halo above the hand, or fully down sinks it below. */
  palmLift: number;
}
export const DEFAULT_MURMURATION: MurmurationParams = { flow: .55, attraction: 1, gripTighten: .55, palmLift: .11 };

/** A hand's smoothed shape for the halo: `grip` 0 open … 1 fist, `palmUp` 1 up … −1 down. */
export interface HandShape { grip: number; palmUp: number }

/** exp(−u) for u ≥ 0, to a few per cent: cheap enough for the per-mote hand loop. */
function fastExpNeg(u: number) { return 1 / (1 + u * (1 + u * (.5 + u * .1666667))); }

export interface Area { x0: number; y0: number; x1: number; y1: number }

/** The flock itself. */
export class Flock {
  readonly n: number;
  aspect: number;
  readonly px: Float32Array; readonly py: Float32Array; readonly pz: Float32Array;
  readonly vx: Float32Array; readonly vy: Float32Array;
  /** Estimated neighbours within the neighbour radius (density, clamped), and the per-mote brightness for drawing. */
  readonly density: Uint8Array;
  readonly bright: Float32Array;
  /** Per-mote constant 0..1 hash (tint, depth offset). */
  readonly hash: Float32Array;
  private readonly random: () => number;
  private readonly noise: Noise;
  // Grid.
  private cols = 1; private rows = 1;
  private cellStart = new Int32Array(2);
  private cellCount = new Int32Array(1);
  private readonly cellOf: Int32Array;
  private readonly sorted: Int32Array;
  // Flow (stream function ψ and its velocity at the nodes).
  private readonly psi = new Float32Array((FLOW_COLS + 1) * (FLOW_ROWS + 1));
  private readonly flowX = new Float32Array((FLOW_COLS + 1) * (FLOW_ROWS + 1));
  private readonly flowY = new Float32Array((FLOW_COLS + 1) * (FLOW_ROWS + 1));

  /** Statistics of the last step. */
  stats = { agitation: 0, closeShare: 0, nearShare: 0, meanSpeed: 0, disorder: 0, excess: 0 };

  constructor(count: number, aspect: number, seed = 7) {
    this.n = Math.max(1, Math.floor(count));
    this.aspect = aspect;
    const n = this.n;
    this.px = new Float32Array(n); this.py = new Float32Array(n); this.pz = new Float32Array(n);
    this.vx = new Float32Array(n); this.vy = new Float32Array(n);
    this.density = new Uint8Array(n); this.bright = new Float32Array(n);
    this.hash = new Float32Array(n);
    this.cellOf = new Int32Array(n); this.sorted = new Int32Array(n); this.nb = new Float32Array(n * 8); this.cellData = new Float32Array(n * 4);
    this.random = rng(seed);
    this.noise = new Noise(seed * 31 + 5);
    const r = this.random;
    // Start as a loose, elongated cloud drifting one way.
    for (let i = 0; i < n; i++) {
      const a = r() * Math.PI * 2, d = Math.sqrt(r());
      this.px[i] = aspect * .5 + Math.cos(a) * d * .35 * aspect * .5;
      this.py[i] = .5 + Math.sin(a) * d * .18;
      this.pz[i] = r();
      this.vx[i] = CRUISE * (.8 + .4 * r()); this.vy[i] = CRUISE * (r() - .5) * .5;
      this.hash[i] = r();
      this.bright[i] = .6;
    }
    this.resizeGrid();
  }

  /** The picture's aspect changed: stretch x so the motes keep their uv. */
  setAspect(aspect: number) {
    if (!(aspect > 0) || aspect === this.aspect) return;
    const s = aspect / this.aspect;
    for (let i = 0; i < this.n; i++) { this.px[i] *= s; this.vx[i] *= s; }
    this.aspect = aspect;
    this.resizeGrid();
  }

  private resizeGrid() {
    this.cols = Math.max(1, Math.ceil(this.aspect / R_NEIGHBOUR));
    this.rows = Math.max(1, Math.ceil(1 / R_NEIGHBOUR));
    this.cellStart = new Int32Array(this.cols * this.rows + 1);
    this.cellCount = new Int32Array(this.cols * this.rows);
  }

  private buildGrid() {
    const { n, cols, rows, cellCount, cellStart, cellOf, sorted, px, py } = this;
    cellCount.fill(0);
    for (let i = 0; i < n; i++) {
      let cx = (px[i] * INV_CELL) | 0, cy = (py[i] * INV_CELL) | 0;
      if (cx < 0) cx = 0; else if (cx >= cols) cx = cols - 1;
      if (cy < 0) cy = 0; else if (cy >= rows) cy = rows - 1;
      const c = cy * cols + cx;
      cellOf[i] = c; cellCount[c]++;
    }
    let s = 0;
    for (let c = 0; c < cols * rows; c++) { cellStart[c] = s; s += cellCount[c]; }
    cellStart[cols * rows] = s;
    // Fill using cellCount as a cursor, then restore it.
    const cd = this.cellData, vx = this.vx, vy = this.vy;
    for (let i = 0; i < n; i++) {
      const c = cellOf[i], q = cellStart[c] + --cellCount[c];
      sorted[q] = i;
      // A cell-ordered copy of the state: the neighbour search then reads memory sequentially.
      const o = q * 4; cd[o] = px[i]; cd[o + 1] = py[i]; cd[o + 2] = vx[i]; cd[o + 3] = vy[i];
    }
    for (let c = 0; c < cols * rows; c++) cellCount[c] = cellStart[c + 1] - cellStart[c];
  }

  private buildFlow(time: number) {
    const { psi, flowX, flowY, noise, aspect } = this;
    const W = FLOW_COLS + 1, H = FLOW_ROWS + 1;
    const hx = aspect / FLOW_COLS, hy = 1 / FLOW_ROWS;
    const t1 = time * .045, t2 = time * .07;
    for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
      const x = i * hx, y = j * hy;
      psi[j * W + i] = noise.noise3(x * 1.5, y * 1.5, t1) + .45 * noise.noise3(x * 3.1 + 11.3, y * 3.1 - 4.1, t2);
    }
    for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
      const i0 = i > 0 ? i - 1 : i, i1 = i < W - 1 ? i + 1 : i, j0 = j > 0 ? j - 1 : j, j1 = j < H - 1 ? j + 1 : j;
      const dpx = (psi[j * W + i1] - psi[j * W + i0]) / ((i1 - i0) * hx);
      const dpy = (psi[j1 * W + i] - psi[j0 * W + i]) / ((j1 - j0) * hy);
      // Divergence-free: v = (∂ψ/∂y, −∂ψ/∂x).
      flowX[j * W + i] = dpy; flowY[j * W + i] = -dpx;
    }
  }

  /**
   * Advance by `dt`. `hands` are in picture uv. `mood` is read, never written here.
   */
  step(dt: number, time: number, hands: readonly PictureHand[], primaryId: number | null, mood: FlockMood, params: MurmurationParams, area: Area, shapes?: readonly HandShape[]) {
    const { n, aspect, px, py, pz, vx, vy, density, bright, hash, sorted, cellStart, cellOf, cols, rows, psi, flowX, flowY } = this;
    this.buildGrid();
    this.buildFlow(time);
    const random = this.random;
    const W = FLOW_COLS + 1;
    const fxs = FLOW_COLS / aspect, fys = FLOW_ROWS;
    const flowGain = .09;

    const fear = mood.fear, bold = mood.boldness, hold = mood.hold, pulse = mood.pulse;
    // Weights. `flow` trades cohesion for following the large-scale field.
    const calm = 1 - .85 * fear;
    const wFlow = (.5 + 1.3 * params.flow) * (1 - .6 * bold * mood.presence);
    const wCohesion = (2.2 - 1.4 * params.flow) * calm * (1 + .35 * pulse);
    const wAlign = 1.6 * calm;
    const wSep = .004;
    // A held flock may pack tighter: the halo thins toward a ring.
    const invRho0 = 1 / (RHO_0 * (1 + .35 * hold * bold * mood.presence));
    const ringCos = Math.cos(time * .35), ringSin = Math.sin(time * .35);
    // Wandering attractor(s): keep the flock one body that sweeps across the picture.
    const ax0 = area.x0 * aspect + EDGE_MARGIN, ax1 = area.x1 * aspect - EDGE_MARGIN;
    const ay0 = area.y0 + EDGE_MARGIN, ay1 = area.y1 - EDGE_MARGIN * 1.4;
    const acx = (ax0 + ax1) * .5, acy = (ay0 + ay1) * .5, arx = Math.max(0, (ax1 - ax0) * .5), ary = Math.max(0, (ay1 - ay0) * .5);
    const attX = acx + arx * .55 * Math.sin(time * .071) + arx * .15 * Math.sin(time * .23 + 1),
      attY = acy + ary * .45 * Math.sin(time * .113 + .7);
    const wAttract = .7 * (1 - .7 * fear) * (1 - .8 * bold * mood.presence);
    const attractFree = .18 + .06 * Math.sin(time * .05);

    // Hands in uniform units (up to 4).
    const hc = Math.min(4, hands.length);
    const hX = this.hX, hY = this.hY, hR = this.hR, hRing = this.hRing, hPull = this.hPull, hThreat = this.hThreat, hGlow = this.hGlow, hW = this.hW;
    const hCY = this.hCY, hGrip = this.hGrip, hSettle = this.hSettle;
    let packMax = 0;
    let primaryIndex = -1;
    for (let k = 0; k < hc; k++) {
      const h = hands[k];
      const weight = topFade(h.y);
      hX[k] = h.x * aspect; hY[k] = h.y; hR[k] = h.radius * aspect; hW[k] = weight;
      // Ring at the hand's edge plus a margin; long stillness draws it in, the beat breathes it.
      // A shy flock circles at a distance; boldness brings the ring in to the hand.
      hRing[k] = (hR[k] * (1.05 - .2 * hold) + (.05 - .025 * hold) * (1 - .4 * bold)) * (1 + .05 * pulse) + .1 * (1 - bold) + .06 * fear;
      // The gathered halo takes the hand's shape (only as far as the flock trusts it, so a fast hand still tears it).
      const shape = shapes?.[k], trust = bold * weight;
      const grip = shape ? clamp01(shape.grip) * trust : 0, palm = shape ? Math.max(-1, Math.min(1, shape.palmUp)) * trust : 0;
      hGrip[k] = grip;
      hRing[k] *= 1 - params.gripTighten * grip;
      // Halo centre: lifted above the hand for a palm turned up, sunk below it for a palm turned down.
      hCY[k] = hY[k] + params.palmLift * palm;
      hSettle[k] = palm < 0 ? -palm : 0;
      if (grip > packMax) packMax = grip;
      hPull[k] = params.attraction * (.35 + .9 * bold) * (1 - fear) * (1 + .8 * h.reach) * weight;
      hThreat[k] = mood.threat * (h.id === primaryId ? 1 : .6);
      hGlow[k] = h.contact * weight;
      if (h.id === primaryId) primaryIndex = k;
    }
    // A fist packs its ball denser than the flock otherwise likes.
    const invRho0g = packMax > 0 ? invRho0 / (1 + 1.5 * packMax) : invRho0;
    const closeR = primaryIndex >= 0 ? CLOSE_RADII * hR[primaryIndex] : 0, closeR2 = closeR * closeR;
    const threatR2 = THREAT_RADIUS * THREAT_RADIUS;
    let closeCount = 0, nearCount = 0;
    let disorder = 0, speedSum = 0;

    const R2 = R_NEIGHBOUR * R_NEIGHBOUR, S2 = R_SEPARATE * R_SEPARATE;
    const nb = this.nb, cd = this.cellData, cellList = this.cellList;
    // Each mote refreshes its neighbourhood every NB_STRIDE steps (staggered): flock statistics are smooth.
    const phase = this.frame++ % NB_STRIDE;
    let slot = 0;
    for (let i = 0; i < n; i++) {
      const x = px[i], y = py[i];
      let vxi = vx[i], vyi = vy[i];
      // Neighbours.
      const c = cellOf[i], cx = c % cols, cy = (c - cx) / cols;
      let cnt: number, sx: number, sy: number, svx: number, svy: number, sepx: number, sepy: number, rho: number;
      const o8 = i * 8;
      const refresh = slot === phase;
      if (++slot === NB_STRIDE) slot = 0;
      if (refresh) {
        cnt = 0; sx = 0; sy = 0; svx = 0; svy = 0; sepx = 0; sepy = 0;
        // The 3×3 cells around, and how many motes they hold.
        let cells = 0, total = 0;
        for (let oy = -1; oy <= 1; oy++) {
          const yy = cy + oy; if (yy < 0 || yy >= rows) continue;
          for (let ox = -1; ox <= 1; ox++) {
            const xx = cx + ox; if (xx < 0 || xx >= cols) continue;
            const cc = yy * cols + xx, len = cellStart[cc + 1] - cellStart[cc];
            if (len === 0) continue;
            cellList[cells++] = cc; total += len;
          }
        }
        // Examine every candidate, or a sample proportional to each cell's share (unbiased centroid).
        const share = total > MAX_EXAMINE ? MAX_EXAMINE / total : 1;
        let examined = 0;
        for (let k = 0; k < cells; k++) {
          const cc = cellList[k], start = cellStart[cc], end = cellStart[cc + 1], len = end - start;
          const take = share < 1 ? (len * share + .999) | 0 : len;
          // Start at a per-mote offset so a sample does not always favour the same motes.
          let q = take < len ? start + ((((i * 40503 + k * 9973) & 0xffff) * len) >>> 16) : start;
          for (let m = 0; m < take; m++) {
            const j = sorted[q], o = q * 4;
            if (++q === end) q = start;
            if (j === i) continue;
            examined++;
            const dx = cd[o] - x, dy = cd[o + 1] - y, d2 = dx * dx + dy * dy;
            if (d2 > R2) continue;
            cnt++; sx += dx; sy += dy; svx += cd[o + 2]; svy += cd[o + 3];
            if (d2 < S2) { const kk = (S2 - d2) / (S2 * (d2 + 1e-5)); sepx -= dx * kk; sepy -= dy * kk; }
          }
        }
        // Estimated neighbours within R (the sample scaled up to the whole neighbourhood).
        rho = examined > 0 ? cnt * (total - 1) / examined : 0;
        nb[o8] = sx; nb[o8 + 1] = sy; nb[o8 + 2] = svx; nb[o8 + 3] = svy; nb[o8 + 4] = sepx; nb[o8 + 5] = sepy; nb[o8 + 6] = cnt; nb[o8 + 7] = rho;
        density[i] = rho > 255 ? 255 : rho;
      } else {
        // Between refreshes a mote reuses its last neighbourhood.
        sx = nb[o8]; sy = nb[o8 + 1]; svx = nb[o8 + 2]; svy = nb[o8 + 3]; sepx = nb[o8 + 4]; sepy = nb[o8 + 5]; cnt = nb[o8 + 6]; rho = nb[o8 + 7];
      }
      let ax = 0, ay = 0;
      if (cnt > 0) {
        const ic = 1 / cnt;
        // Cohesion turns into pressure where the flock is denser than it likes: toward the local
        // centroid when sparse, away from it (down the density gradient) when packed.
        const pr = rho * invRho0g, coh = wCohesion * (1 - pr * pr);
        ax += coh * sx * ic + wAlign * (svx * ic - vxi) + wSep * sepx;
        ay += coh * sy * ic + wAlign * (svy * ic - vyi) + wSep * sepy;
        const dvx = vxi - svx * ic, dvy = vyi - svy * ic;
        disorder += Math.sqrt(dvx * dvx + dvy * dvy);
      }
      // Hands.
      let glow = 0, held = 0, heldX = 0, heldY = 0, heldGrip = 0;
      for (let k = 0; k < hc; k++) {
        const dx = hX[k] - x, dhy = hY[k] - y, d2 = dx * dx + dhy * dhy;
        if (k === primaryIndex) { if (d2 < closeR2) closeCount++; if (d2 < threatR2) nearCount++; }
        const w = hW[k];
        if (w <= 0) continue;
        // The halo forms around its centre (the hand, shifted by the palm's facing).
        const dy = hCY[k] - y, dc2 = dx * dx + dy * dy, d = Math.sqrt(dc2) + 1e-6;
        const nx = dx / d, ny = dy / d, ring = hRing[k];
        // Pull from a distance, easing to zero at the ring; push out inside it.
        if (d > ring) {
          const reachOut = .45 + .7 * bold;
          const pull = hPull[k] * fastExpNeg((d - ring) / reachOut) * Math.min(1, (d - ring) / .06);
          ax += nx * pull; ay += ny * pull;
        } else {
          const push = (5 + 6 * fear) * (ring - d) / ring * w;
          ax -= nx * push; ay -= ny * push;
        }
        // Halo: with boldness the ring holds them and they orbit.
        const outside = d > ring ? d - ring : 0;
        const local = fastExpNeg(outside / (.1 + .1 * bold));
        const b = bold * w * local;
        if (b > held) { held = b; heldX = nx; heldY = ny; heldGrip = hGrip[k]; }
        const stiff = 1 + hGrip[k], settle = 1 - .35 * hSettle[k];
        if (b > 1e-3) {
          const vr = vxi * nx + vyi * ny;
          // A well-damped radial spring to the ring (no bobbing in and out).
          // A fist holds its ball on a stiffer spring.
          const k = (2.5 + 5 * hold) * stiff, radial = k * (d - ring) - 1.6 * Math.sqrt(k) * vr;
          ax += b * nx * radial; ay += b * ny * radial;
          // Everyone orbits the same way (counter-streams would read as turbulence).
          const tx2 = -ny, ty2 = nx;
          // A palm turned down lets the halo settle: a slower orbit.
          const vt = vxi * tx2 + vyi * ty2, target = CRUISE * (.9 + .5 * hold) * settle;
          ax += b * 2.2 * (target - vt) * tx2; ay += b * 2.2 * (target - vt) * ty2;
        }
        // A fast hand near the flock tears it apart.
        const th = hThreat[k];
        if (th > 1e-3 && d2 < threatR2) {
          const dh = Math.sqrt(d2) + 1e-6, hx = dx / dh, hy = dhy / dh;
          const f = th * 16 * (1 - dh / THREAT_RADIUS) * w;
          const jitter = .6 * (random() - .5);
          ax -= (hx + jitter * hy) * f; ay -= (hy - jitter * hx) * f;
        }
        glow += hGlow[k] * fastExpNeg(outside / .08);
      }
      // Flow field (bilinear) and its stream function for depth.
      let gx = x * fxs, gy = y * fys;
      if (gx < 0) gx = 0; else if (gx > FLOW_COLS - 1e-4) gx = FLOW_COLS - 1e-4;
      if (gy < 0) gy = 0; else if (gy > FLOW_ROWS - 1e-4) gy = FLOW_ROWS - 1e-4;
      const gi = gx | 0, gj = gy | 0, tx = gx - gi, ty = gy - gj, g = gj * W + gi;
      const w00 = (1 - tx) * (1 - ty), w10 = tx * (1 - ty), w01 = (1 - tx) * ty, w11 = tx * ty;
      const fvx = flowGain * (flowX[g] * w00 + flowX[g + 1] * w10 + flowX[g + W] * w01 + flowX[g + W + 1] * w11);
      const fvy = flowGain * (flowY[g] * w00 + flowY[g + 1] * w10 + flowY[g + W] * w01 + flowY[g + W + 1] * w11);
      const ps = psi[g] * w00 + psi[g + 1] * w10 + psi[g + W] * w01 + psi[g + W + 1] * w11;
      // Motes held in a halo leave the large currents.
      const wf = wFlow * (1 - .85 * held);
      ax += wf * (fvx - vxi); ay += wf * (fvy - vyi);
      // Attractor.
      {
        const dx = attX - x, dy = attY - y, d = Math.sqrt(dx * dx + dy * dy) + 1e-6;
        if (d > attractFree) { const k = wAttract * (d - attractFree) / d; ax += dx * k; ay += dy * k; }
      }
      // Stay inside the active area, softly.
      if (x < ax0) ax += 6 * (ax0 - x) - (vxi < 0 ? 1.5 * vxi : 0); else if (x > ax1) ax -= 6 * (x - ax1) + (vxi > 0 ? 1.5 * vxi : 0);
      if (y < ay0) ay += 6 * (ay0 - y) - (vyi < 0 ? 1.5 * vyi : 0); else if (y > ay1) ay -= 6 * (y - ay1) + (vyi > 0 ? 1.5 * vyi : 0);
      // Speed: relax toward the cruise speed.
      const sp = Math.sqrt(vxi * vxi + vyi * vyi) + 1e-6;
      const cruise = CRUISE * (1 + .3 * pulse * (1 - mood.presence));
      const relax = 1.4 * (cruise - sp) / sp;
      ax += relax * vxi; ay += relax * vyi;
      vxi += ax * dt; vyi += ay * dt;
      const sp2 = vxi * vxi + vyi * vyi;
      if (sp2 > 2.25) { const s = 1.5 / Math.sqrt(sp2); vxi *= s; vyi *= s; }
      vx[i] = vxi; vy[i] = vyi;
      let nxp = x + vxi * dt, nyp = y + vyi * dt;
      // Hard bounds just outside the picture so nothing can run away.
      if (nxp < -.05) { nxp = -.05; vx[i] = Math.abs(vxi); } else if (nxp > aspect + .05) { nxp = aspect + .05; vx[i] = -Math.abs(vxi); }
      if (nyp < -.05) { nyp = -.05; vy[i] = Math.abs(vyi); } else if (nyp > 1.05) { nyp = 1.05; vy[i] = -Math.abs(vyi); }
      px[i] = nxp; py[i] = nyp;
      // Depth follows the stream function (coherent tilt of the folds) plus a per-mote offset.
      // Held in a halo, depth follows the angle around the hand instead: a slowly turning tilted ring.
      const zFlow = .5 + .38 * ps + .18 * (hash[i] - .5);
      const zRing = .5 - .42 * (heldX * ringCos + heldY * ringSin) + .1 * (hash[i] - .5);
      const zTarget = zFlow + (zRing - zFlow) * held;
      pz[i] += (zTarget - pz[i]) * Math.min(1, dt * 1.2);
      const spd = Math.sqrt(vx[i] * vx[i] + vy[i] * vy[i]);
      speedSum += spd;
      // Brightness: density, a glint of speed, the hand's glow on contact.
      const dens = rho > 30 ? 1 : rho / 30;
      const fast = spd > CRUISE ? Math.min(1, (spd - CRUISE) / CRUISE) : 0;
      bright[i] = (.5 + .5 * dens + .35 * fast) * (1 + 1.6 * (glow > 1 ? 1 : glow)) * (1 + .45 * heldGrip * held);
    }
    // Agitation: the flock's velocity dispersion — local disorder (velocity against the
    // neighbourhood's mean) and speed above the expected cruise (a scattered flock runs fast).
    const meanSpeed = speedSum / n;
    const expected = CRUISE * (1 + .45 * hold * bold);
    const excess = Math.max(0, meanSpeed / expected - 1.1);
    const dis = disorder / n / expected;
    this.stats.disorder = dis; this.stats.excess = excess;
    this.stats.agitation = clamp01((dis - .3) / .9 + excess * 1.5);
    this.stats.closeShare = primaryIndex >= 0 ? closeCount / n : 0;
    this.stats.nearShare = primaryIndex >= 0 ? nearCount / n : 0;
    this.stats.meanSpeed = meanSpeed;
  }
  /** Cached neighbourhood sums (dx, dy, vx, vy, sepx, sepy, count, density estimate) per mote, refreshed every NB_STRIDE steps. */
  private readonly nb: Float32Array;
  private readonly cellList = new Int32Array(9);
  private readonly cellData: Float32Array;
  private frame = 0;
  private readonly hX = new Float32Array(4); private readonly hY = new Float32Array(4); private readonly hR = new Float32Array(4);
  private readonly hRing = new Float32Array(4); private readonly hPull = new Float32Array(4); private readonly hThreat = new Float32Array(4);
  private readonly hGlow = new Float32Array(4); private readonly hW = new Float32Array(4);
  private readonly hCY = new Float32Array(4); private readonly hGrip = new Float32Array(4); private readonly hSettle = new Float32Array(4);

  /** Pack for drawing: uv x, uv y, depth, brightness per mote. */
  pack(out: Float32Array) {
    const { n, px, py, pz, bright, aspect } = this;
    const ia = 1 / aspect;
    for (let i = 0, o = 0; i < n; i++, o += 4) { out[o] = px[i] * ia; out[o + 1] = py[i]; out[o + 2] = pz[i]; out[o + 3] = bright[i]; }
  }
}

export interface FlockMood { fear: number; boldness: number; hold: number; threat: number; presence: number; pulse: number }

/**
 * The whole simulation minus drawing: flock, mood, hold, threat and the five signals.
 */
export class MurmurationState {
  flock: Flock;
  readonly mood = new Mood();
  /** 0..1 how long the hand has been held still and trusted: tightens the halo into a ring. */
  hold = 0;
  private holdFor = 0;
  /** 0..1 how frightening the hand is right now (speed near the flock). */
  threat = 0;
  pulse = 0;
  private readonly closenessF = new Follower(0, 1, 1.5);
  private readonly agitationF = new Follower(0, .15, .25);
  private reach = 0;
  private lift = .5;
  private presence = 0;
  /** Each hand's grip and palm facing, smoothed (by hand id) so a flickering tracker never pops the halo. */
  private readonly shapeF = new Map<number, { grip: Follower; palm: Follower }>();
  private readonly shapes: HandShape[] = [];

  constructor(count: number, aspect: number, readonly seed = 7) { this.flock = new Flock(count, aspect, seed); }

  /** Rebuild the flock at a new size (param change). */
  setCount(count: number) { if (Math.floor(count) !== this.flock.n) this.flock = new Flock(count, this.flock.aspect, this.seed); }

  step(input: SimInput, params: MurmurationParams, area: Area = { x0: 0, y0: 0, x1: 1, y1: 1 }) {
    const dt = input.dt;
    const { hands, primary } = pictureHands(input);
    this.presence = clamp01(input.presence);
    // Beat breath: a soft pulse with Live's beat, or a slow free-running breath.
    const beat = input.music ? beatPulse(input.music) : 0;
    this.pulse = input.music && input.music.playing ? beat : .5 + .5 * Math.sin(input.time * Math.PI * 2 / 7.5);

    const speed = primary ? primary.speed : 0;
    const stillness = 1 - clamp01(speed / .6);
    // Threat: speed near the flock (using last step's share of the flock around the hand).
    const near = smoothstep(.02, .15, this.flock.stats.nearShare);
    const threatNow = primary ? smoothstep(.45, 1.3, speed) * near * topFade(primary.y) : 0;
    this.threat = threatNow > this.threat ? threatNow : approach(this.threat, threatNow, dt, .15);
    const agitation = this.agitationF.value;
    // Fear mainly from the threat; the flock's own turbulence alone stays below the startle level.
    this.mood.update(dt, { presence: this.presence, stillness, agitation: clamp01(.95 * this.threat + .25 * agitation) });
    const calmHold = primary && this.mood.boldness > .7 && stillness > .8;
    this.holdFor = calmHold ? this.holdFor + dt : Math.max(0, this.holdFor - 3 * dt);
    this.hold = approach(this.hold, smoothstep(4, 12, this.holdFor), dt, .8);

    const mood: FlockMood = { fear: this.mood.fear, boldness: this.mood.boldness * (primary ? 1 : 0), hold: this.hold, threat: this.threat, presence: primary ? 1 : 0, pulse: this.pulse };
    this.updateShapes(hands, dt);
    this.flock.step(dt, input.time, hands, primary ? primary.id : null, mood, params, area, this.shapes);

    // Signals.
    if (primary) { this.reach = approach(this.reach, primary.reach, dt, .08); this.lift = clamp01(primary.y); }
    else this.reach = approach(this.reach, 0, dt, 2.5);
    this.closenessF.update(primary ? clamp01(this.flock.stats.closeShare / HALO_SHARE) : 0, dt);
    this.agitationF.update(this.flock.stats.agitation, dt);
  }

  private updateShapes(hands: readonly PictureHand[], dt: number) {
    for (const id of [...this.shapeF.keys()]) if (!hands.some(h => h.id === id)) this.shapeF.delete(id);
    this.shapes.length = hands.length;
    hands.forEach((h, k) => {
      let f = this.shapeF.get(h.id);
      // Grip closes in a quarter second and opens a little slower; the palm turns over half a second.
      if (!f) { f = { grip: new Follower(0, .25, .4), palm: new Follower(0, .5, .5) }; this.shapeF.set(h.id, f); }
      this.shapes[k] = { grip: f.grip.update(clamp01(h.grip), dt), palmUp: f.palm.update(Math.max(-1, Math.min(1, h.palmUp)), dt) };
    });
  }

  signals() {
    return { presence: this.presence, reach: clamp01(this.reach), lift: clamp01(this.lift), closeness: clamp01(this.closenessF.value), agitation: clamp01(this.agitationF.value) };
  }
}
