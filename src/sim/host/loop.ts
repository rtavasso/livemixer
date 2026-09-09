/**
 * Fixed-timestep accumulator. Physics steps happen at a constant rate no
 * matter how the display frames fall; the renderer receives `alpha` for
 * interpolation. When the page stalls (tab hidden, GC pause) the backlog is
 * capped so the simulation never enters a catch-up spiral; dropped time is
 * reported so the host can mention it.
 */
export interface StepResult { steps: number; alpha: number; droppedMs: number }

export class FixedStepper {
  private accumulator = 0;
  private lastMs: number | null = null;
  constructor(public stepMs: number, public maxStepsPerFrame = 4, public maxFrameMs = 250) {
    if (!(stepMs > 0)) throw new Error('Step length must be positive.');
  }
  reset() { this.accumulator = 0; this.lastMs = null; }
  advance(nowMs: number, step: (dtSeconds: number) => void): StepResult {
    if (this.lastMs === null) { this.lastMs = nowMs; return { steps: 0, alpha: 0, droppedMs: 0 }; }
    let elapsed = nowMs - this.lastMs;
    this.lastMs = nowMs;
    if (elapsed < 0) elapsed = 0;
    let droppedMs = 0;
    if (elapsed > this.maxFrameMs) { droppedMs += elapsed - this.maxFrameMs; elapsed = this.maxFrameMs; }
    this.accumulator += elapsed;
    const cap = this.maxStepsPerFrame * this.stepMs;
    if (this.accumulator > cap) { droppedMs += this.accumulator - cap; this.accumulator = cap; }
    let steps = 0;
    const dt = this.stepMs / 1000;
    // The epsilon keeps exact multiples (a 60 Hz display feeding a 60 Hz step) from losing a step to rounding.
    while (this.accumulator >= this.stepMs - 1e-6) { step(dt); this.accumulator -= this.stepMs; steps++; }
    return { steps, alpha: Math.max(0, Math.min(1, this.accumulator / this.stepMs)), droppedMs };
  }
}

/** Exponential moving average of a rate, for fps readouts. */
export class RateMeter {
  private lastMs: number | null = null;
  value = 0;
  constructor(private readonly tau = .5) {}
  tick(nowMs: number) {
    if (this.lastMs !== null) {
      const dt = Math.max(1e-3, (nowMs - this.lastMs) / 1000);
      const instantaneous = 1 / dt;
      const k = 1 - Math.exp(-dt / this.tau);
      this.value += k * (instantaneous - this.value);
    }
    this.lastMs = nowMs;
  }
}
