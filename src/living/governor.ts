/**
 * The living-installation governor: turns a simulation's slow state into the
 * song's position away from home. Pure and deterministic (no DOM, no clock):
 * the caller supplies elapsed time. "Slow sound, fast light": every axis moves
 * with 0.4–3 s time constants, so a brief spike in the simulation barely moves
 * the mix.
 *
 * Home: vocals gated off (instrumental), arrangement .5 (original balance),
 * depth 0 (unfiltered), space 0 (dry). See docs/LIVING-MUSIC.md.
 */

/** The signals every living simulation publishes, all 0..1. */
export const CONTRACT_SIGNALS = ['presence', 'reach', 'lift', 'closeness', 'agitation'] as const;
export type ContractSignal = typeof CONTRACT_SIGNALS[number];
export type LivingSignals = Partial<Record<ContractSignal, number>>;

export const AXES = ['vocals', 'arrangement', 'depth', 'space', 'allowance'] as const;
export type Axis = typeof AXES[number];
export type Axes = Record<Axis, number>;

export interface GovernorConfig {
  /** Allowance with nobody close: how far a stranger may move the song. */
  baseAllowance: number;
  /** Fraction of allowance removed by full agitation. */
  agitationPull: number;
  /** Smoothing of agitation before it reduces allowance (s): a flick does not collapse the song. */
  agitationTau: number;
  /** Presence at which the vocal gate starts to open / is fully open. */
  gateLow: number;
  gateHigh: number;
  /** Vocal gate ramp times (s, full scale, linear). */
  vocalRise: number;
  vocalRelease: number;
  arrangementTau: number;
  depthTau: number;
  spaceRise: number;
  spaceFall: number;
  /** Ceilings: the largest excursion from home (fraction of the axis' full range). */
  arrangementCeiling: number;
  depthCeiling: number;
  spaceCeiling: number;
  /** Swarm (scene turbulence) rise / fall time constants (s). */
  swarmRise: number;
  swarmFall: number;
}

export const DEFAULT_GOVERNOR: GovernorConfig = {
  baseAllowance: .35, agitationPull: .7, agitationTau: .6,
  gateLow: .15, gateHigh: .5, vocalRise: .4, vocalRelease: 2.5,
  arrangementTau: 1.5, depthTau: .8, spaceRise: 2.5, spaceFall: 3,
  arrangementCeiling: 1, depthCeiling: 1, spaceCeiling: 1,
  swarmRise: .08, swarmFall: .5,
};

export const HOME: Readonly<Axes> = Object.freeze({ vocals: 0, arrangement: .5, depth: 0, space: 0, allowance: DEFAULT_GOVERNOR.baseAllowance });

const unit = (value: number) => Math.max(0, Math.min(1, value));
/** A signal value, or the fallback when it is missing, NaN or infinite. */
const read = (signals: LivingSignals | null | undefined, key: ContractSignal, fallback: number): number => {
  const value = signals && typeof signals === 'object' ? (signals as Record<string, unknown>)[key] : undefined;
  return typeof value === 'number' && Number.isFinite(value) ? unit(value) : fallback;
};
const approach = (value: number, target: number, dt: number, tau: number) =>
  tau <= 0 ? target : target + (value - target) * Math.exp(-dt / tau);
const smoothstep = (low: number, high: number, x: number) => {
  const t = unit((x - low) / Math.max(1e-6, high - low));
  return t * t * (3 - 2 * t);
};

export class Governor {
  readonly config: GovernorConfig;
  private axes: Axes;
  private agitation = 0;
  /**
   * The scene's turbulence as a sound of its own (fx `swarm`): fast attack, gentle release, at full strength and not
   * gated by the hand, so a flock still swirling after the hand leaves is heard swirling. Home on release.
   */
  swarm = 0;

  constructor(config: Partial<GovernorConfig> = {}) {
    this.config = { ...DEFAULT_GOVERNOR, ...config };
    this.axes = this.home();
  }

  /** Home for this configuration. */
  home(): Axes { return { ...HOME, allowance: unit(this.config.baseAllowance) }; }

  /** Current axes without advancing time. */
  get value(): Axes { return { ...this.axes }; }

  /** Return to home at once (the caller has released Live, which fades on its side). */
  release(): Axes { this.axes = this.home(); this.agitation = 0; this.swarm = 0; return this.value; }

  /** Advance by dtSeconds toward the state the signals ask for. Missing or invalid signals count as absent. */
  step(signals: LivingSignals | null | undefined, dtSeconds: number): Axes {
    const c = this.config;
    const dt = Number.isFinite(dtSeconds) ? Math.max(0, Math.min(5, dtSeconds)) : 0;
    const presence = read(signals, 'presence', 0);
    // Absent hand: every axis target is home, whatever the other signals still report.
    const reach = read(signals, 'reach', 0) * presence;
    const lift = .5 + (read(signals, 'lift', .5) - .5) * presence;
    const closeness = read(signals, 'closeness', 0) * presence;
    this.agitation = approach(this.agitation, read(signals, 'agitation', 0) * presence, dt, c.agitationTau);
    const turbulence = read(signals, 'agitation', 0);
    this.swarm = approach(this.swarm, turbulence, dt, turbulence > this.swarm ? c.swarmRise : c.swarmFall);
    if (this.swarm < 2e-3) this.swarm = 0;

    const base = unit(c.baseAllowance);
    const allowance = unit((base + (1 - base) * closeness) * (1 - unit(c.agitationPull) * this.agitation));

    const a = this.axes;
    const gate = smoothstep(c.gateLow, c.gateHigh, presence);
    const rate = gate > a.vocals ? 1 / Math.max(1e-3, c.vocalRise) : 1 / Math.max(1e-3, c.vocalRelease);
    a.vocals = gate > a.vocals ? Math.min(gate, a.vocals + rate * dt) : Math.max(gate, a.vocals - rate * dt);

    const arrangement = .5 + .5 * (lift - .5) * 2 * allowance * unit(c.arrangementCeiling);
    a.arrangement = approach(a.arrangement, arrangement, dt, c.arrangementTau);
    // Dive is a gesture: full strength at once, never scaled by allowance (docs/superpowers/specs/2026-10-02-hand-gesture-audio-design.md).
    a.depth = approach(a.depth, reach * unit(c.depthCeiling), dt, c.depthTau);
    // Space follows closeness, with allowance as its ceiling (agitation pulls it home too).
    const space = Math.min(closeness, allowance) * unit(c.spaceCeiling);
    a.space = approach(a.space, space, dt, space > a.space ? c.spaceRise : c.spaceFall);
    a.allowance = allowance;

    for (const key of AXES) {
      const home = key === 'allowance' ? base : HOME[key];
      a[key] = Number.isFinite(a[key]) ? unit(a[key]) : home;
      // Exponential approach never lands exactly: snap to home so Live sees true zero.
      if (key !== 'allowance' && Math.abs(a[key] - home) < 2e-3) a[key] = home;
    }
    return this.value;
  }
}

export interface LiveMapping {
  /** Main reverb (CC21, already capped to 20% wet in Live) at full space. */
  mainSpace: number;
  /** TEXTURE FX Auto Filter Dive at full depth. */
  diveCeiling: number;
  /** Halo send (TEXTURE FX send B) at full space. */
  haloCeiling: number;
  /** Dub echo sends at full space: low, a continuous tail, never thrown. */
  dubCeiling: number;
}
export const DEFAULT_MAPPING: LiveMapping = { mainSpace: .5, diveCeiling: .8, haloCeiling: .6, dubCeiling: .3 };

/** Hand-gesture values (src/living/hands.ts) and the scene's swarm (Governor.swarm), in the bridge's /fx/values order after the first five. */
export const GESTURE_KEYS = ['muffleRhythm', 'muffleMelodic', 'tiltRhythm', 'tiltMelodic', 'levelRhythm', 'levelMelodic', 'freeze', 'bloom', 'span', 'whoosh', 'swarm'] as const;
export type GestureKey = typeof GESTURE_KEYS[number];
export type GestureFx = Record<GestureKey, number>;
/** Home: open, flat, unity level, unfrozen, normal width. */
export const GESTURE_HOME: Readonly<GestureFx> = Object.freeze({
  muffleRhythm: 0, muffleMelodic: 0, tiltRhythm: .5, tiltMelodic: .5, levelRhythm: .5, levelMelodic: .5, freeze: 0, bloom: 0, span: .5, whoosh: 0, swarm: 0,
});

export interface LiveFx extends GestureFx { flicker: number; dub: number; dive: number; halo: number; balance: number }
export interface LiveControls { type: 'controls'; vocals: number; space: number; stutter: number; gain: number; fx: LiveFx }

const safe = (value: number, fallback: number) => Number.isFinite(value) ? unit(value) : fallback;

/** The bridge message for a set of axes and hand gestures (missing or invalid gestures are home). Flicker and stutter stay at 0. */
export function toLiveControls(axes: Axes, mapping: Partial<LiveMapping> = {}, gestures: Partial<GestureFx> = {}): LiveControls {
  const m = { ...DEFAULT_MAPPING, ...mapping };
  const space = safe(axes.space, 0), depth = safe(axes.depth, 0);
  return {
    type: 'controls',
    vocals: safe(axes.vocals, 0),
    space: unit(space * safe(m.mainSpace, 0)),
    stutter: 0,
    gain: 1,
    fx: {
      flicker: 0,
      dub: unit(space * safe(m.dubCeiling, 0)),
      dive: unit(depth * safe(m.diveCeiling, 0)),
      halo: unit(space * safe(m.haloCeiling, 0)),
      balance: safe(axes.arrangement, .5),
      ...Object.fromEntries(GESTURE_KEYS.map(key => [key, safe(gestures?.[key] as number, GESTURE_HOME[key])])) as GestureFx,
    },
  };
}

/** True when a simulation schema publishes every contract signal. */
export function isLivingSchema(signals: Record<string, unknown> | null | undefined): boolean {
  return !!signals && CONTRACT_SIGNALS.every(key => key in signals);
}
