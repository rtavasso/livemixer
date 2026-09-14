/**
 * Breeze for the Veil: a divergence-free lateral field (curl of scrolled
 * noise) plus a broad, slowly travelling push along z, with a slow gust
 * envelope. Sampled on a coarse lattice the cloth interpolates over.
 * Deterministic given the seed and the sequence of update calls.
 *
 * `Noise.noise3` costs about a microsecond, so the lattice is refreshed only
 * every `stride` updates (the field is smooth enough that 30 Hz is plenty);
 * the gust envelope is cheap and advances every call.
 */
import { approach, clamp01, smoothstep } from '../../core/math';
import { Noise } from '../../core/noise';

export interface WindOptions { cols: number; rows: number; seed?: number; stride?: number }

export interface WindUpdate {
  time: number;
  dt: number;
  /** 0..1 breeze strength. */
  wind: number;
  /** 0..1 how often and how hard gusts arrive. */
  gustiness: number;
  /** Extra restlessness (e.g. from hand activity), 0..1. */
  turbulence: number;
  /** Lattice extent in uniform units. */
  x0: number; x1: number; top: number; length: number;
}

export class WindField {
  readonly cols: number;
  readonly rows: number;
  /** cols × rows × xyz, row 0 = top. */
  readonly data: Float64Array;
  /** Current gust envelope, 0..1. */
  gust = 0;
  /** Current mean speed of the field, units/s. */
  speed = 0;
  private readonly noise: Noise;
  private readonly stride: number;
  private calls = 0;

  constructor(options: WindOptions) {
    this.cols = options.cols; this.rows = options.rows;
    this.data = new Float64Array(this.cols * this.rows * 3);
    this.noise = new Noise(options.seed ?? 7);
    this.stride = Math.max(1, options.stride ?? 2);
  }

  /** Advance the gust envelope; refresh the lattice every `stride` calls. Returns true when the lattice changed. */
  update(u: WindUpdate): boolean {
    const noise = this.noise, t = u.time;
    // Gust envelope: a slow noise crosses a threshold set by `gustiness`; attack faster than decay.
    // fbm3 rarely leaves ±0.5, so stretch it to use the whole 0..1 range.
    const raw = clamp01(.5 + 1.1 * noise.fbm3(t * .09, 3.7, 9.1, 2));
    const threshold = 1 - .62 * clamp01(u.gustiness);
    const target = u.gustiness > 0 ? smoothstep(threshold, Math.min(1, threshold + .3), raw) : 0;
    this.gust = approach(this.gust, target, u.dt, target > this.gust ? .5 : 1.6);
    const breathing = .55 + .45 * (.5 + .5 * noise.noise3(t * .17, 21.5, 4.2));
    const speed = clamp01(u.wind) * .55 * breathing * (1 + 2.6 * this.gust) + .12 * clamp01(u.turbulence);
    this.speed = speed;
    if (this.calls++ % this.stride !== 0) return false;
    const turb = 1 + 1.5 * this.gust + 2 * clamp01(u.turbulence);
    const cols = this.cols, rows = this.rows, data = this.data;
    for (let j = 0; j < rows; j++) {
      const y = u.top - u.length * j / (rows - 1);
      for (let i = 0; i < cols; i++) {
        const x = u.x0 + (u.x1 - u.x0) * i / (cols - 1);
        const c = noise.curl2(x * 1.1 + t * .12, y * 1.1, t * .28);
        // Broad billow wave that travels across the sheet, plus a cheap finer flutter that grows with turbulence.
        const billow = .55 + .45 * noise.noise3(x * .8 - t * .5, y * .6 + 3.1, t * .15 + 5.5);
        const flutter = Math.sin(x * 7.3 + t * 2.1) * Math.cos(y * 5.9 - t * 1.4 + x) * .16 * turb;
        const o = (j * cols + i) * 3;
        data[o] = speed * (.14 * c.x + .2 * flutter);
        data[o + 1] = speed * .1 * c.y;
        data[o + 2] = speed * (billow + flutter);
      }
    }
    return true;
  }
}
