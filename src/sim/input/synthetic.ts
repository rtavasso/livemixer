/**
 * A scripted performer for demos, soak tests, and browser tests: one or two
 * hands sweeping figure-eights, occasionally leaving the box, occasionally
 * pushing in, with a soft occupancy blob around each. Fully deterministic
 * from `nowMs`, so tests can drive it with a fake clock.
 *
 * Source frame: image-like, x right, y down. Use IMAGE_MAPPING.
 */
import type { Capsule, DepthSurface, HandObservation, InputFrame, InputSource, InputSourceStatus, OccupancyGrid } from './types';
import type { Vec3 } from '../core/types';

export interface SyntheticOptions { hands: 1 | 2; speed: number; occupancy: boolean; absences: boolean; /** Emit a depth-camera style scan of the hands. */ surface: boolean }
export const DEFAULT_SYNTHETIC: SyntheticOptions = { hands: 1, speed: 1, occupancy: true, absences: true, surface: true };

export class SyntheticSource implements InputSource {
  readonly id = 'synthetic' as const;
  readonly frameDescription = 'Image-like: x → right, y → down, z = scripted pushes';
  private sequence = 0; private running = false; private originMs = 0;
  options: SyntheticOptions;
  constructor(private readonly emit: (frame: InputFrame) => void, options: Partial<SyntheticOptions> = {}) { this.options = { ...DEFAULT_SYNTHETIC, ...options }; }
  async start() { this.running = true; this.originMs = -1; }
  stop() { this.running = false; }
  status(): InputSourceStatus { return { state: this.running ? 'running' : 'idle', message: this.running ? `Scripted performer: ${this.options.hands} hand(s) at ${this.options.speed.toFixed(1)}× speed.` : 'Synthetic source stopped.' }; }

  sample(nowMs: number) {
    if (!this.running) return;
    if (this.originMs < 0) this.originMs = nowMs;
    const t = (nowMs - this.originMs) / 1000 * this.options.speed;
    const hands: HandObservation[] = [];
    const cycle = 14; // seconds: present for 11, absent for 3
    const phase = t % cycle;
    const present = !this.options.absences || phase < 11;
    if (present) {
      for (let i = 0; i < this.options.hands; i++) {
        const offset = i * Math.PI;
        const x = .5 + .32 * Math.sin(t * .7 + offset);
        const y = .5 + .22 * Math.sin(t * 1.4 + offset) * Math.cos(t * .3);
        const push = Math.max(0, Math.sin(t * .45 + i)) ** 6; // brief pushes
        const z = .25 + .7 * push;
        const openness = .5 + .5 * Math.sin(t * .35 + i * 1.7);
        const r = .05 + .02 * Math.sin(t * .9);
        hands.push({ id: i + 1, position: { x, y, z }, confidence: 1, openness, pinch: 0, extent: { min: { x: x - r, y: y - r * 1.4, z }, max: { x: x + r, y: y + r * 1.4, z } }, capsules: syntheticHandCapsules({ x, y, z }, openness, r, i === 1) });
      }
    }
    const occupancy = this.options.occupancy ? blobGrid(hands, 32, 24) : undefined;
    const surface = this.options.surface ? surfaceFromCapsules(hands.flatMap(h => h.capsules ?? []), 128, 96) : undefined;
    this.emit({ source: 'synthetic', sequence: this.sequence++, observedAtMs: nowMs, receivedAtMs: nowMs, hands, occupancy, surface, stats: { synthetic: 1 } });
  }
}

/**
 * A procedural skeleton in the image-like source frame (x right, y down, z depth): a palm of
 * four metacarpals fanning up from the wrist, five fingers of three bones that curl with
 * `openness` (1 = straight, 0 = fist), a thumb to the side, and a forearm going down.
 * Sizes follow the hand's half-width `r`; a mirrored hand is the other hand.
 */
export function syntheticHandCapsules(palm: Vec3, openness: number, r: number, mirrored = false): Capsule[] {
  const out: Capsule[] = [];
  const side = mirrored ? -1 : 1;
  const wrist = { x: palm.x, y: palm.y + r * 1.1, z: palm.z };
  const curl = (1 - openness) * 1.9; // radians of bend at each joint when closed
  const seg = (a: Vec3, b: Vec3, radius: number) => out.push({ a, b, radius });
  // Forearm.
  seg(wrist, { x: palm.x + side * r * .3, y: palm.y + r * 3.2, z: palm.z + r * .4 }, r * .34);
  // Four fingers: metacarpal from the wrist to the knuckle, then three phalanges bending about z.
  for (let f = 0; f < 4; f++) {
    const spread = (f - 1.5) * .42 * side;
    const knuckle = { x: palm.x + Math.sin(spread) * r * .95, y: palm.y - Math.cos(spread) * r * .9, z: palm.z };
    seg(wrist, knuckle, r * .2);
    let p = knuckle, angle = spread, dz = 0;
    const lengths = [.62, .42, .32].map(l => l * r * (f === 3 ? .8 : 1));
    for (let b = 0; b < 3; b++) {
      dz += curl * .6;
      const cos = Math.cos(dz), sin = Math.sin(dz);
      const q = { x: p.x + Math.sin(angle) * lengths[b] * cos, y: p.y - Math.cos(angle) * lengths[b] * cos, z: p.z + lengths[b] * sin };
      seg(p, q, r * (.17 - b * .02)); p = q;
    }
  }
  // Thumb: two bones off the side of the palm.
  const t0 = { x: palm.x + side * r * .9, y: palm.y + r * .3, z: palm.z };
  const t1 = { x: t0.x + side * r * .5 * (1 - .5 * (1 - openness)), y: t0.y - r * .45, z: palm.z + r * .2 * (1 - openness) };
  const t2 = { x: t1.x + side * r * .3, y: t1.y - r * .35, z: t1.z + r * .15 * (1 - openness) };
  seg(t0, t1, r * .2); seg(t1, t2, r * .17);
  return out;
}

/**
 * What a depth camera in front of the performer would scan of these solids: for each cell of the
 * image, the nearest front surface of any capsule (a shell, exactly like a real scan). Byte layout
 * follows `DepthSurface`: 0 = nothing, otherwise 1 + round(254 · w).
 */
export function surfaceFromCapsules(capsules: Capsule[], width: number, height: number): DepthSurface {
  const data = new Uint8Array(width * height);
  for (const c of capsules) {
    const r = c.radius;
    const minX = Math.max(0, Math.floor((Math.min(c.a.x, c.b.x) - r) * width)), maxX = Math.min(width - 1, Math.ceil((Math.max(c.a.x, c.b.x) + r) * width));
    const minY = Math.max(0, Math.floor((Math.min(c.a.y, c.b.y) - r) * height)), maxY = Math.min(height - 1, Math.ceil((Math.max(c.a.y, c.b.y) + r) * height));
    const abx = c.b.x - c.a.x, aby = c.b.y - c.a.y, abz = c.b.z - c.a.z, len2 = abx * abx + aby * aby;
    for (let row = minY; row <= maxY; row++) for (let col = minX; col <= maxX; col++) {
      const u = (col + .5) / width, v = (row + .5) / height;
      const t = len2 > 1e-12 ? Math.max(0, Math.min(1, ((u - c.a.x) * abx + (v - c.a.y) * aby) / len2)) : 0;
      const dx = u - (c.a.x + abx * t), dy = v - (c.a.y + aby * t), d2 = dx * dx + dy * dy;
      if (d2 >= r * r) continue;
      const w = Math.max(0, Math.min(1, c.a.z + abz * t - Math.sqrt(r * r - d2)));
      const value = 1 + Math.round(254 * w), i = row * width + col;
      if (data[i] === 0 || value < data[i]) data[i] = value;
    }
  }
  return { width, height, data };
}

function blobGrid(hands: HandObservation[], width: number, height: number): OccupancyGrid {
  const data = new Uint8Array(width * height);
  for (let row = 0; row < height; row++) for (let col = 0; col < width; col++) {
    const u = (col + .5) / width, v = (row + .5) / height;
    let value = 0;
    for (const h of hands) {
      const dx = (u - h.position.x) / .07, dy = (v - h.position.y) / .1;
      value = Math.max(value, Math.exp(-(dx * dx + dy * dy)));
    }
    data[row * width + col] = Math.round(255 * value);
  }
  return { width, height, data };
}
