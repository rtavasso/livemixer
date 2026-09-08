import type { ControlFrame } from './types';
export class SliderAdapter {
  private sequence = 0;
  value = .3;
  sample(atMs: number): ControlFrame { return { sequence: this.sequence++, observedAtMs: atMs, receivedAtMs: atMs, valid: true, values: { openness: this.value }, source: 'slider' }; }
}
