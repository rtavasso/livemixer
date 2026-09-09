/**
 * A scripted performer for demos, soak tests, and browser tests: one or two
 * hands sweeping figure-eights, occasionally leaving the box, occasionally
 * pushing in, with a soft occupancy blob around each. Fully deterministic
 * from `nowMs`, so tests can drive it with a fake clock.
 *
 * Source frame: image-like, x right, y down. Use IMAGE_MAPPING.
 */
import type { HandObservation, InputFrame, InputSource, InputSourceStatus, OccupancyGrid } from './types';

export interface SyntheticOptions { hands: 1 | 2; speed: number; occupancy: boolean; absences: boolean }
export const DEFAULT_SYNTHETIC: SyntheticOptions = { hands: 1, speed: 1, occupancy: true, absences: true };

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
        hands.push({ id: i + 1, position: { x, y, z }, confidence: 1, openness, pinch: 0, extent: { min: { x: x - r, y: y - r * 1.4, z }, max: { x: x + r, y: y + r * 1.4, z } } });
      }
    }
    const occupancy = this.options.occupancy ? blobGrid(hands, 32, 24) : undefined;
    this.emit({ source: 'synthetic', sequence: this.sequence++, observedAtMs: nowMs, receivedAtMs: nowMs, hands, occupancy, stats: { synthetic: 1 } });
  }
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
