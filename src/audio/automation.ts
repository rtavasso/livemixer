// Each envelope exclusively owns one AudioParam. Only one segment is retained.
export class OwnedEnvelope {
  private start = 0; private end = 0; private from: number; private to: number;
  constructor(readonly param: AudioParam, initial: number, at = 0) {
    this.from = this.to = initial; this.start = this.end = at;
    param.setValueAtTime(initial, at);
  }
  valueAt(at: number) {
    if (at >= this.end) return this.to;
    if (at <= this.start) return this.from;
    return this.from + (this.to - this.from) * (at - this.start) / (this.end - this.start);
  }
  ramp(target: number, start: number, end: number, replace = false) {
    if (!Number.isFinite(target) || end < start) throw new Error('Invalid envelope.');
    if (Math.abs(target - this.to) < 1e-6 && !replace) return;
    const held = this.valueAt(start);
    if (replace) {
      if (typeof this.param.cancelAndHoldAtTime === 'function') this.param.cancelAndHoldAtTime(start);
      else {
        this.param.cancelScheduledValues(start);
        // Canceling an in-flight ramp removes its future endpoint too. Reinstall
        // the truncated endpoint as a ramp so the preceding segment stays intact.
        this.param.linearRampToValueAtTime(held, start);
      }
    }
    this.param.setValueAtTime(held, start); this.param.linearRampToValueAtTime(target, end);
    this.from = held; this.to = target; this.start = start; this.end = end;
  }
}
