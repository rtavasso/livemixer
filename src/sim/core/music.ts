/**
 * The music clock: Live's song position relayed to the simulation page.
 *
 * The Ableton bridge reports the arrangement position in beats about ten times a second, without
 * the tempo. `MusicClockEstimator` keeps the latest report, estimates the tempo from successive
 * reports (ignoring jumps such as a locate or a loop), and extrapolates the position between
 * reports so a pulse drawn at 60 fps stays smooth. It forgets everything when reports stop.
 * Deterministic: all time arrives through arguments.
 */
export interface MusicClock {
  /** Live's transport is running. */
  playing: boolean;
  /** Song position in quarter-note beats, extrapolated to now. */
  beat: number;
  /** Estimated tempo in beats per minute. */
  bpm: number;
}

/** Reports older than this are ignored: the clock becomes null. */
export const MUSIC_STALE_MS = 3000;
const MIN_BPM = 40, MAX_BPM = 220;

export class MusicClockEstimator {
  private last: { beat: number; playing: boolean; atMs: number } | null = null;
  private bpm = 120;
  private confident = false;

  /** A report from Live. `bpm`, when the sender knows it, overrides the estimate. */
  report(beat: number, playing: boolean, atMs: number, bpm?: number) {
    if (!Number.isFinite(beat) || !Number.isFinite(atMs)) return;
    if (bpm !== undefined && Number.isFinite(bpm) && bpm >= MIN_BPM && bpm <= MAX_BPM) { this.bpm = bpm; this.confident = true; }
    else if (this.last && playing && this.last.playing) {
      const dtMin = (atMs - this.last.atMs) / 60000, dBeat = beat - this.last.beat;
      if (dtMin > 0.0005) {
        const measured = dBeat / dtMin;
        // A locate, loop or tempo jump gives an implausible rate: skip it rather than chase it.
        if (measured >= MIN_BPM && measured <= MAX_BPM) {
          this.bpm = this.confident ? this.bpm + .25 * (measured - this.bpm) : measured;
          this.confident = true;
        }
      }
    }
    this.last = { beat, playing, atMs };
  }

  /** The clock at `nowMs`, or null when nothing recent has arrived. */
  sample(nowMs: number): MusicClock | null {
    const last = this.last;
    if (!last || nowMs - last.atMs > MUSIC_STALE_MS) return null;
    const ahead = last.playing ? Math.max(0, nowMs - last.atMs) / 60000 * this.bpm : 0;
    return { playing: last.playing, beat: last.beat + ahead, bpm: this.bpm };
  }

  reset() { this.last = null; this.confident = false; }
}

/**
 * A soft pulse on each beat: 1 at the beat, decaying with `decay` (fraction of a beat to fall to
 * ~5 %). Zero without a running clock.
 */
export function beatPulse(clock: MusicClock | null | undefined, decay = .35): number {
  if (!clock || !clock.playing) return 0;
  const phase = clock.beat - Math.floor(clock.beat);
  return Math.exp(-3 * phase / Math.max(.05, decay));
}
