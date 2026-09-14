import type { SpaceState } from '../control/space';
import type { SimulationOutput } from '../sim/core/output';
import { TARGETS, type MixTarget, type PerformancePatch } from './patch';

export type MixControls = Record<MixTarget, number>;
export const STALE_OUTPUT_MS = 500;
const idle = (): MixControls => ({ engagement: 0, balance: .5, space: .35 });
const unit = (value: number) => Math.max(0, Math.min(1, value));

/** A deterministic, clock-driven mapper. It never touches the DOM, sensors, or AudioNodes. */
export class SimulationModulation {
  private controls = idle();
  private lastSample = -Infinity;
  private lastOutput = -Infinity;
  constructor(readonly patch: PerformancePatch) {}
  reset() { this.controls = idle(); this.lastSample = this.lastOutput = -Infinity; }
  sample(frame: SimulationOutput | null, nowMs: number): MixControls {
    if (!Number.isFinite(nowMs) || nowMs < this.lastSample) return { ...this.controls };
    const dt = Number.isFinite(this.lastSample) ? Math.min(100, nowMs - this.lastSample) : 0;
    this.lastSample = nowMs;
    const targets = this.targets(frame, nowMs);
    if (!targets) {
      // Close the audio send using the engine's existing release envelope. Never keep stale engagement.
      this.controls.engagement = 0;
      return { ...this.controls };
    }
    this.lastOutput = frame!.atMs;
    for (const target of TARGETS) {
      const tau = this.patch.routes[target].smoothingMs;
      const alpha = tau === 0 ? 1 : 1 - Math.exp(-dt / tau);
      this.controls[target] = unit(this.controls[target] + alpha * (targets[target] - this.controls[target]));
    }
    return { ...this.controls };
  }
  private targets(frame: SimulationOutput | null, now: number): MixControls | null {
    if (!frame || frame.simId !== this.patch.settings.sim || !Number.isFinite(frame.atMs)
      || frame.atMs > now || now - frame.atMs > STALE_OUTPUT_MS || frame.atMs < this.lastOutput) return null;
    const values = {} as MixControls;
    for (const target of TARGETS) {
      const r = this.patch.routes[target];
      const value = r.source === 'constant' ? r.inputMin : r.source === 'input.presence' ? frame.input.presence
        : r.source === 'input.activity' ? frame.input.activity : frame.signals[r.source.slice('signal.'.length)];
      if (!Number.isFinite(value)) return null;
      const normalized = unit((value - r.inputMin) / (r.inputMax - r.inputMin));
      values[target] = unit(r.outputMin + normalized * (r.outputMax - r.outputMin));
    }
    return values;
  }
}

/** The adapter to the existing continuous mix graph. Scheduling, headroom and ramps remain owned by audio. */
export function toSpaceState(controls: MixControls): SpaceState {
  return { enabled: true, presence: controls.engagement, height: controls.balance, depth: controls.space };
}
