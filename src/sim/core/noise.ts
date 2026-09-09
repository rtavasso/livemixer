/**
 * Small deterministic 2D/3D value-gradient noise for wind fields and organic drift.
 * Not simplex-quality but cheap, seedable, and dependency-free.
 */
import { rng } from './math';

const lerp = (a: number, b: number, t: number) => a + t * (b - a);

export class Noise {
  private readonly perm = new Uint8Array(512);
  constructor(seed = 1) {
    const random = rng(seed);
    const p = Array.from({ length: 256 }, (_, i) => i);
    for (let i = 255; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [p[i], p[j]] = [p[j], p[i]]; }
    for (let i = 0; i < 512; i++) this.perm[i] = p[i & 255];
  }
  private static fade(t: number) { return t * t * t * (t * (t * 6 - 15) + 10); }
  private static grad3(hash: number, x: number, y: number, z: number) {
    const h = hash & 15, u = h < 8 ? x : y, v = h < 4 ? y : h === 12 || h === 14 ? x : z;
    return ((h & 1) === 0 ? u : -u) + ((h & 2) === 0 ? v : -v);
  }
  /** Perlin gradient noise in roughly [-1, 1]. */
  noise3(x: number, y: number, z: number): number {
    const X = Math.floor(x) & 255, Y = Math.floor(y) & 255, Z = Math.floor(z) & 255;
    x -= Math.floor(x); y -= Math.floor(y); z -= Math.floor(z);
    const u = Noise.fade(x), v = Noise.fade(y), w = Noise.fade(z), p = this.perm;
    const A = p[X] + Y, AA = p[A] + Z, AB = p[A + 1] + Z, B = p[X + 1] + Y, BA = p[B] + Z, BB = p[B + 1] + Z;
    return lerp(
      lerp(lerp(Noise.grad3(p[AA], x, y, z), Noise.grad3(p[BA], x - 1, y, z), u), lerp(Noise.grad3(p[AB], x, y - 1, z), Noise.grad3(p[BB], x - 1, y - 1, z), u), v),
      lerp(lerp(Noise.grad3(p[AA + 1], x, y, z - 1), Noise.grad3(p[BA + 1], x - 1, y, z - 1), u), lerp(Noise.grad3(p[AB + 1], x, y - 1, z - 1), Noise.grad3(p[BB + 1], x - 1, y - 1, z - 1), u), v),
      w,
    );
  }
  noise2(x: number, y: number) { return this.noise3(x, y, 0); }
  /** Fractal sum of `octaves` layers. */
  fbm3(x: number, y: number, z: number, octaves = 3, lacunarity = 2, gain = .5): number {
    let sum = 0, amp = 1, norm = 0;
    for (let i = 0; i < octaves; i++) { sum += amp * this.noise3(x, y, z); norm += amp; x *= lacunarity; y *= lacunarity; z *= lacunarity; amp *= gain; }
    return sum / norm;
  }
  /** Divergence-free 2D field from the curl of a noise potential; great for wind that swirls without piling up. */
  curl2(x: number, y: number, t: number, eps = .01): { x: number; y: number } {
    const dx = (this.noise3(x + eps, y, t) - this.noise3(x - eps, y, t)) / (2 * eps);
    const dy = (this.noise3(x, y + eps, t) - this.noise3(x, y - eps, t)) / (2 * eps);
    return { x: dy, y: -dx };
  }
}
