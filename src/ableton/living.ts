/**
 * Living mode for the controls page, without the DOM: governor + hand combiner, and the fail-safe.
 *
 * When telemetry goes stale (no frame for 750 ms, or the input source stalled / never connected), the
 * driver keeps stepping with nobody present and no hands, so the song fades to its instrumental home over
 * the governor's normal times and the effects ease home, and keeps sending those controls. Only after
 * RELEASE_AFTER_MS of staleness does it release Live once (the bridge's fail-safe then holds the same home),
 * and it stays quiet until fresh input returns, starting again from home so nothing jumps.
 */
import { CONTRACT_SIGNALS, Governor, toLiveControls, type LiveControls, type LivingSignals } from '../living/governor';
import { HandCombiner } from '../living/hands';
import type { TelemetryFrame } from '../sim/telemetry/types';

export const STALE_FRAME_MS = 750;
export const STALE_INPUT_MS = 750;
export const RELEASE_AFTER_MS = 30_000;

/** fresh: frames and input are live. input-stale: the simulation runs but its input stalled or never connected. no-frames: no simulation frames. */
export type Freshness = 'fresh' | 'input-stale' | 'no-frames';

export function freshness(frame: TelemetryFrame | null, lastFrameAt: number, now: number): Freshness {
  if (!frame || !(now - lastFrameAt <= STALE_FRAME_MS)) return 'no-frames';
  const age = frame.input?.sourceAgeMs;
  // sourceAgeMs is −1 until the first input frame: never connected counts as stale.
  if (typeof age !== 'number' || !Number.isFinite(age) || age < 0 || age > STALE_INPUT_MS) return 'input-stale';
  return 'fresh';
}

/** The contract signals of a frame. Presence is 0 unless the input is fresh, whatever the simulation still reports. */
export function livingSignals(frame: TelemetryFrame | null, fresh: boolean): LivingSignals {
  const signals: LivingSignals = {};
  if (!frame) return signals;
  for (const key of CONTRACT_SIGNALS) signals[key] = frame.sim?.signals?.[key];
  if (!fresh) signals.presence = 0;
  else if (!Number.isFinite(signals.presence)) signals.presence = frame.input?.presence;
  return signals;
}

export interface LivingStep {
  /** What to send to the bridge this tick: controls, a one-time release, or nothing. */
  message: LiveControls | { type: 'release' } | null;
  signals: LivingSignals;
  state: Freshness;
  /** Milliseconds stale so far (0 when fresh). */
  staleMs: number;
  released: boolean;
}

export class LivingDriver {
  readonly governor: Governor;
  readonly hands: HandCombiner;
  private staleSince: number | null = null;
  private released = false;
  private readonly releaseAfterMs: number;

  constructor(options: { governor?: Governor; hands?: HandCombiner; releaseAfterMs?: number } = {}) {
    this.governor = options.governor ?? new Governor();
    this.hands = options.hands ?? new HandCombiner();
    this.releaseAfterMs = options.releaseAfterMs ?? RELEASE_AFTER_MS;
  }

  /** Advance by dtSeconds. `frame` is the latest frame received at `lastFrameAt` (same clock as `now`). */
  step(frame: TelemetryFrame | null, lastFrameAt: number, now: number, dtSeconds: number): LivingStep {
    const state = freshness(frame, lastFrameAt, now);
    if (state === 'fresh') { this.staleSince = null; this.released = false; }
    else this.staleSince ??= now;
    const staleMs = this.staleSince === null ? 0 : now - this.staleSince;
    const signals = livingSignals(state === 'no-frames' ? null : frame, state === 'fresh');

    if (staleMs >= this.releaseAfterMs) {
      if (this.released) return { message: null, signals, state, staleMs, released: true };
      // Long gone: hand Live back to the bridge's fail-safe once, and start again from home on recovery.
      this.released = true;
      this.governor.release(); this.hands.release();
      return { message: { type: 'release' }, signals, state, staleMs, released: true };
    }

    const axes = this.governor.step(signals, dtSeconds);
    const gestures = this.hands.step(state === 'fresh' ? frame!.input.hands : [], dtSeconds);
    const message = toLiveControls(axes, {}, { ...gestures, swarm: this.governor.swarm });
    return { message, signals, state, staleMs, released: false };
  }

  /** Return home at once (the caller releases Live itself). */
  reset(): void {
    this.governor.release(); this.hands.release();
    this.staleSince = null; this.released = false;
  }
}
