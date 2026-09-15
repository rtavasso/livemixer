export const names = ['vocals', 'space', 'stutter', 'gain'] as const;
export type Control = typeof names[number];
export type Controls = Record<Control, number>;
export const defaults: Controls = { vocals: 1, space: 0, stutter: 0, gain: 1 };
export interface Source { value: number; min: number; max: number }
export function normalize(source: Source | undefined, fallback: number): number {
  if (!source || ![source.value, source.min, source.max].every(Number.isFinite) || source.max <= source.min) return fallback;
  return Math.max(0, Math.min(1, (source.value - source.min) / (source.max - source.min)));
}
export function stutterCount(amount: number): number {
  return !Number.isFinite(amount) || amount <= 0 ? 0 : Math.max(1, Math.min(4, Math.floor(amount * 4 + .5)));
}
export function smooth(previous: number, target: number, elapsedMs: number): number {
  const next = previous + (target - previous) * (1 - Math.exp(-Math.max(0, Math.min(500, elapsedMs)) / 120));
  // Exponential smoothing otherwise never reaches zero, leaving short
  // repeats enabled indefinitely after a gesture has settled.
  return Math.abs(next - target) < .001 ? target : next;
}
