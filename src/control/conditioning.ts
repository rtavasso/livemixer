import { DEFAULT_CONTROL, type ControlSettings } from '../config';
import type { Adapter, ControlFrame, Landmark } from './types';
export const clamp = (u: number) => Math.max(0, Math.min(1, u));
export const unwrap = (angle: number, around: number) => around + Math.atan2(Math.sin(angle - around), Math.cos(angle - around));
export function handTilt(points: Landmark[], width: number, height: number): number | null {
  const a = points[0], b = points[9];
  if (!a || !b || ![a.x, a.y, b.x, b.y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return null;
  if ([a.x, a.y, b.x, b.y].some(v => v < -.1 || v > 1.1)) return null;
  const vx = (b.x - a.x) * width, vy = -(b.y - a.y) * height;
  if (Math.hypot(vx, vy) < Math.max(12, Math.min(width, height) * .025)) return null;
  return Math.atan2(vx, vy);
}
export interface Calibration { neutral: number; low: number; high: number }
export function calibrate(low: number, high: number): Calibration {
  if (![low, high].every(Number.isFinite)) throw new Error('Capture both calibration endpoints.');
  const h = unwrap(high, low), span = Math.abs(h - low);
  if (span < Math.PI / 6 || span > Math.PI * 2 / 3) throw new Error('Calibration needs a comfortable 30–120° sweep; avoid an ambiguous wrap.');
  return { neutral: (low + h) / 2, low, high: h };
}
export function calibratedOpenness(angle: number, calibration: Calibration): number | null {
  const a = unwrap(angle, calibration.neutral);
  if (Math.abs(a - calibration.neutral) >= Math.PI * .8) return null;
  return clamp((a - calibration.low) / (calibration.high - calibration.low));
}
export function stableCapture(samples: { angle: number; at: number }[]): number {
  if (samples.length < 6 || samples.at(-1)!.at - samples[0].at < 450) throw new Error('Hold still with a visible hand for at least half a second.');
  const angles = samples.map(s => unwrap(s.angle, samples[0].angle));
  if (Math.max(...angles) - Math.min(...angles) > Math.PI / 24) throw new Error('Calibration hold is moving. Hold still and capture again.');
  return angles.reduce((a, b) => a + b, 0) / angles.length;
}
export interface Conditioned {
  raw: number; smooth: number; valid: boolean; structural: boolean; sustainedLoss: boolean;
  ageMs: number; discarded?: string;
}
export class Conditioner {
  private sequence = -1;
  private observed = -Infinity;
  private lastAt: number;
  private lastValid: number;
  private lossStart: number | null = null;
  private lossValue: number;
  private validSince: number | null = null;
  private hasLost: boolean;
  private raw: number;
  private smooth: number;
  constructor(readonly source: Adapter, atMs: number, seed = .3, readonly settings: ControlSettings = DEFAULT_CONTROL) {
    this.lastAt = this.lastValid = atMs; this.lossValue = this.raw = this.smooth = seed;
    this.hasLost = source === 'camera';
  }
  private state(now: number, valid: boolean, structural: boolean, discarded?: string): Conditioned {
    return { raw: this.raw, smooth: this.smooth, valid, structural, sustainedLoss: this.lossStart !== null && now - this.lossStart >= this.settings.lossHoldMs, ageMs: Math.max(0, now - this.observed), discarded };
  }
  frame(frame: ControlFrame): Conditioned {
    const now = frame.receivedAtMs, s = this.settings;
    if (![frame.observedAtMs, now, frame.sequence, frame.values.openness].every(Number.isFinite) || frame.sequence <= this.sequence || frame.observedAtMs < this.observed || now < frame.observedAtMs || now < this.lastAt || now - frame.observedAtMs > s.maxFrameAgeMs || frame.source !== this.source) {
      return { ...this.tick(Math.max(this.lastAt, Number.isFinite(now) ? now : this.lastAt)), discarded: 'Out-of-order, stale, or malformed control frame', structural: false };
    }
    this.sequence = frame.sequence; this.observed = frame.observedAtMs;
    if (!frame.valid) return this.lose(now);
    if (now - this.lastValid > s.maxFrameAgeMs && this.lossStart === null) this.lose(this.lastValid + s.maxFrameAgeMs);
    this.raw = clamp(frame.values.openness); this.lastValid = now;
    if (this.validSince === null) this.validSince = now;
    const ready = !this.hasLost || now - this.validSince >= s.reacquireMs;
    const dt = Math.max(0, Math.min(now - this.lastAt, s.maxFrameAgeMs));
    if (ready) {
      this.smooth += (1 - Math.exp(-dt / s.smoothingMs)) * (this.raw - this.smooth);
      this.lossStart = null; this.hasLost = false;
    }
    this.lastAt = now;
    return this.state(now, true, ready);
  }
  private lose(now: number): Conditioned {
    if (this.lossStart === null) { this.lossStart = now; this.lossValue = this.smooth; }
    this.hasLost = true; this.validSince = null;
    const t = clamp((now - this.lossStart - this.settings.lossHoldMs) / this.settings.neutralReturnMs);
    this.smooth = this.lossValue + (this.settings.neutral - this.lossValue) * t;
    this.lastAt = now;
    return this.state(now, false, false);
  }
  tick(now: number): Conditioned {
    if (now - this.lastValid > this.settings.maxFrameAgeMs) return this.lose(now);
    if (this.lossStart !== null) {
      const t = clamp((now - this.lossStart - this.settings.lossHoldMs) / this.settings.neutralReturnMs);
      this.smooth = this.lossValue + (this.settings.neutral - this.lossValue) * t;
      return this.state(now, this.validSince !== null, false);
    }
    return this.state(now, true, !this.hasLost);
  }
}
