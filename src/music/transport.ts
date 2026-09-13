export interface SceneClock { start: number; duration: number; loopBars: number; beatsPerBar: number }
export function changeClockRate(clock: SceneClock, at: number, oldRate: number, rate: number): SceneClock {
  const duration = clock.duration * oldRate / rate;
  return { ...clock, duration, start: at - (at - clock.start) * duration / clock.duration };
}
export const beatSeconds = (clock: SceneClock) => clock.duration / (clock.loopBars * clock.beatsPerBar);
export const boundary = (clock: SceneClock, index: number, quantumBars: number) => clock.start + index * quantumBars * clock.duration / clock.loopBars;
export function nextBoundary(clock: SceneClock, earliest: number, quantumBars: number) {
  const step = quantumBars * clock.duration / clock.loopBars;
  const index = Math.max(1, Math.ceil((earliest - clock.start) / step - 1e-10));
  return { index, at: boundary(clock, index, quantumBars) };
}
export function phase(clock: SceneClock, now: number) {
  const elapsed = Math.max(0, now - clock.start), loops = Math.floor(elapsed / clock.duration);
  const fraction = (elapsed / clock.duration) % 1;
  return { loops, fraction, bar: 1 + Math.floor(fraction * clock.loopBars), beat: 1 + Math.floor(fraction * clock.loopBars * clock.beatsPerBar) % clock.beatsPerBar };
}
