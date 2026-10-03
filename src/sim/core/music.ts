/**
 * The music clock: Live's song position relayed to the simulation page.
 *
 * The Ableton bridge reports the arrangement position in beats about ten times a second, without
 * the tempo. `MusicClockEstimator` keeps the latest report, estimates the tempo from successive
 * reports (ignoring jumps such as a locate or a loop), and extrapolates the position between
 * reports so a pulse drawn at 60 fps stays smooth. It forgets everything when reports stop.
 *
 * Reports may also carry Live's output meter levels (~10 Hz). Each channel is followed by an
 * envelope (fast attack, slower release) integrated in time between reports, divided by a slowly
 * tracked recent peak (auto-gain: quiet and loud songs both reach ~1), and the rhythm envelope's
 * jumps above its slow average give an onset pulse.
 * Deterministic: all time arrives through arguments.
 */
export interface MusicClock {
  /** Live's transport is running. */
  playing: boolean;
  /** Song position in quarter-note beats, extrapolated to now. */
  beat: number;
  /** Estimated tempo in beats per minute. */
  bpm: number;
  /**
   * Latest output meter levels (0..1) as reported, or null/absent when the sender has none or they
   * are stale. A missing group falls back to the main level (and main to the louder group).
   */
  levels?: MusicLevels | null;
  /** Smoothed dynamics derived from the levels; null exactly when `levels` is. */
  dynamics?: MusicDynamics | null;
}

export interface MusicLevels { main: number; rhythm: number; melodic: number }

export interface MusicDynamics {
  /** Envelope-followed levels (attack `LEVEL_ATTACK_MS`, release `LEVEL_RELEASE_MS`). */
  envelope: MusicLevels;
  /** Envelope over its slowly tracked recent peak: ~0 silent … ~1 at the song's loudest. */
  energy: MusicLevels;
  /** 0..1: rises on a jump of the rhythm envelope above its slow average, decays over ~`ONSET_DECAY_MS`. */
  onset: number;
}

/** What a sender reports: each 0..1; −1 or absent when that group does not exist. */
export type MusicLevelsReport = Partial<MusicLevels>;

/** Reports older than this are ignored: the clock becomes null. Levels go stale by the same rule. */
export const MUSIC_STALE_MS = 3000;
const MIN_BPM = 40, MAX_BPM = 220;
export const LEVEL_ATTACK_MS = 40, LEVEL_RELEASE_MS = 250;
/** Release of the auto-gain peak tracker: a quieter song is turned up over a few seconds. */
export const PEAK_RELEASE_MS = 6000;
/** The auto-gain never divides by less than this, so silence and meter noise stay near zero. */
export const PEAK_FLOOR = .12;
/** Time constant of the slow average an onset must jump above. */
export const ONSET_AVERAGE_MS = 600;
export const ONSET_DECAY_MS = 200;
/** Jump (of the rhythm envelope over its slow average, relative to the peak) that starts / saturates an onset. */
const ONSET_FROM = .03, ONSET_FULL = .2;
/** Integration sub-step: reports and samples at any cadence give (nearly) the same envelope. */
const LEVEL_STEP_MS = 10;

const CHANNELS = ['main', 'rhythm', 'melodic'] as const;
const triple = (v = 0): MusicLevels => ({ main: v, rhythm: v, melodic: v });

/** A usable level or null (absent, negative = no such group, not finite). */
function level(v: number | undefined): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.min(1.5, v) : null;
}

/** The levels a report carries, with fallbacks for missing groups, or null when it carries none. */
export function resolveLevels(report: MusicLevelsReport | null | undefined): MusicLevels | null {
  if (!report) return null;
  const m = level(report.main), r = level(report.rhythm), me = level(report.melodic);
  if (m === null && r === null && me === null) return null;
  const main = m ?? Math.max(r ?? 0, me ?? 0);
  return { main, rhythm: r ?? main, melodic: me ?? main };
}

/**
 * Envelope followers, auto-gain and onset for the three level channels (the onset reads rhythm). Advanced explicitly in
 * time; the input holds its last value between reports.
 */
export class LevelDynamics {
  private target: MusicLevels = triple();
  private readonly env: MusicLevels = triple();
  private readonly peak: MusicLevels = triple();
  private slow = 0;
  private onset = 0;
  private atMs: number | null = null;

  /** Advance to `nowMs` on the previous input, then take `levels` as the input. */
  set(levels: MusicLevels, nowMs: number) { this.advance(nowMs); this.target = { ...levels }; }

  advance(nowMs: number) {
    if (this.atMs === null) { this.atMs = nowMs; return; }
    let remaining = nowMs - this.atMs;
    if (!(remaining > 0)) return;
    this.atMs = nowMs;
    // Everything but the peak has settled after ~2 s: a stall need not be integrated finely.
    remaining = Math.min(remaining, 2000);
    while (remaining > 0) {
      const dt = Math.min(LEVEL_STEP_MS, remaining);
      remaining -= dt;
      const kA = 1 - Math.exp(-dt / LEVEL_ATTACK_MS), kR = 1 - Math.exp(-dt / LEVEL_RELEASE_MS), kP = 1 - Math.exp(-dt / PEAK_RELEASE_MS);
      for (const c of CHANNELS) {
        const t = this.target[c], e = this.env[c];
        const v = this.env[c] = e + (t - e) * (t > e ? kA : kR);
        const p = this.peak[c];
        this.peak[c] = v > p ? v : p + (v - p) * kP;
      }
      // Onset: while the rhythm envelope is rising (attack), how far it stands above its slow
      // average, relative to the song's peak. On the release the pulse only decays.
      const r = this.env.rhythm, rising = this.target.rhythm > r + 1e-4;
      this.slow += (r - this.slow) * (1 - Math.exp(-dt / ONSET_AVERAGE_MS));
      const jump = rising ? (r - this.slow) / Math.max(PEAK_FLOOR, this.peak.rhythm) : 0;
      const hit = jump <= ONSET_FROM ? 0 : jump >= ONSET_FULL ? 1 : (jump - ONSET_FROM) / (ONSET_FULL - ONSET_FROM);
      const decayed = this.onset * Math.exp(-dt / ONSET_DECAY_MS);
      // Rises within ~25 ms (no click), falls by the decay.
      this.onset = hit > decayed ? decayed + (hit - decayed) * Math.min(1, dt / 25) : decayed;
    }
  }

  value(): MusicDynamics {
    const energy = triple();
    for (const c of CHANNELS) energy[c] = Math.min(1, this.env[c] / Math.max(PEAK_FLOOR, this.peak[c]));
    return { envelope: { ...this.env }, energy, onset: this.onset };
  }
}

export class MusicClockEstimator {
  private last: { beat: number; playing: boolean; atMs: number } | null = null;
  private bpm = 120;
  private confident = false;
  private levels: { value: MusicLevels; atMs: number } | null = null;
  private dynamics = new LevelDynamics();

  /**
   * A report from Live. `bpm`, when the sender knows it, overrides the estimate. `levels` are the
   * output meters; a report without them leaves the last levels to go stale.
   */
  report(beat: number, playing: boolean, atMs: number, bpm?: number, levels?: MusicLevelsReport | null) {
    if (!Number.isFinite(beat) || !Number.isFinite(atMs)) return;
    const resolved = resolveLevels(levels);
    if (resolved) {
      // After a gap the dynamics start over (a new song level, no onset from the jump out of silence history).
      if (!this.levels || atMs - this.levels.atMs > MUSIC_STALE_MS) this.dynamics = new LevelDynamics();
      this.dynamics.set(resolved, atMs);
      this.levels = { value: resolved, atMs };
    }
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

  /** The clock at `nowMs`, or null when nothing recent has arrived. Advances the level dynamics. */
  sample(nowMs: number): MusicClock | null {
    const last = this.last;
    if (!last || nowMs - last.atMs > MUSIC_STALE_MS) return null;
    const ahead = last.playing ? Math.max(0, nowMs - last.atMs) / 60000 * this.bpm : 0;
    let levels: MusicLevels | null = null, dynamics: MusicDynamics | null = null;
    if (this.levels && nowMs - this.levels.atMs <= MUSIC_STALE_MS) {
      this.dynamics.advance(nowMs);
      levels = { ...this.levels.value };
      dynamics = this.dynamics.value();
    }
    return { playing: last.playing, beat: last.beat + ahead, bpm: this.bpm, levels, dynamics };
  }

  reset() { this.last = null; this.confident = false; this.levels = null; this.dynamics = new LevelDynamics(); }
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
