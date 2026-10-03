/**
 * The hand combiner: turns the telemetry hands of each frame into the gesture
 * values of the living controls (muffle, tilt and level per half, freeze,
 * bloom, span, whoosh). Pure and deterministic like the governor: no DOM, no
 * clock, the caller supplies elapsed time. Every gesture acts at full strength;
 * the Live device only ramps. See
 * docs/superpowers/specs/2026-10-02-hand-gesture-audio-design.md ("Combiner rules").
 *
 * One hand conducts the whole song; with two, the hand farther left on the
 * picture drives the rhythm half and the other the melodic half. With three or
 * more, the two hands present longest are used (ties: lower id), so a passer-by
 * cannot steal a half from someone already playing.
 */
import type { HandTelemetry } from '../sim/telemetry/types';
import { GESTURE_HOME, GESTURE_KEYS, type GestureFx } from './governor';

export interface HandConfig {
  /** Per-hand smoothing of grip, palm and speed (s): rising (closing, palm up, faster) and falling. */
  rise: number;
  fall: number;
  /** Position smoothing (s), symmetric so the spotlight answers up and down alike. */
  positionTau: number;
  /** Two hands swap halves only after crossing by more than this (picture widths). */
  crossMargin: number;
  /** Crossfade when the hands in play change (s); to no hands it is homeTime instead. */
  handover: number;
  homeTime: number;
  /** Freeze: larger grip ≥ freezeOn for freezeHold seconds; ends at ≤ freezeOff or after freezeCap seconds, then re-arms at ≤ freezeOff. */
  freezeOn: number;
  freezeOff: number;
  freezeHold: number;
  freezeCap: number;
  /** Release swell after a freeze (decay time constant, s). */
  bloomTau: number;
  /** Swipe one-shot: any hand's speed (sim units/s) crossing this fires; decay τ and minimum spacing (s). */
  whooshSpeed: number;
  whooshTau: number;
  whooshCooldown: number;
  /** One hand: heights within this of the middle leave both levels at .5. */
  deadZone: number;
  /** Two hands: span is .5 at this distance (picture units), 0 / 1 at ∓spanRange from it. */
  spanCenter: number;
  spanRange: number;
}

export const DEFAULT_HANDS: HandConfig = {
  rise: .15, fall: .3, positionTau: .15, crossMargin: .08, handover: .5, homeTime: 1,
  freezeOn: .7, freezeOff: .4, freezeHold: .4, freezeCap: 6, bloomTau: .8,
  whooshSpeed: 1.6, whooshTau: .4, whooshCooldown: .8, deadZone: .08, spanCenter: .35, spanRange: .25,
};

interface Tracked { grip: number; palm: number; x: number; y: number; speed: number; age: number }

const unit = (value: number) => Math.max(0, Math.min(1, value));
const finite = (value: unknown, fallback: number) => typeof value === 'number' && Number.isFinite(value) ? value : fallback;
const approach = (value: number, target: number, dt: number, tau: number) =>
  tau <= 0 ? target : target + (value - target) * Math.exp(-dt / tau);
const ease = (value: number, target: number, dt: number, c: HandConfig) => approach(value, target, dt, target > value ? c.rise : c.fall);
/** Height to level with a dead zone around the middle, rescaled so it stays continuous and still reaches 0 and 1. */
const spotlight = (y: number, dead: number) => {
  const off = y - .5, room = Math.max(1e-6, .5 - dead);
  return .5 + Math.sign(off) * .5 * unit((Math.abs(off) - dead) / room);
};

export class HandCombiner {
  readonly config: HandConfig;
  private hands = new Map<number, Tracked>();
  private rhythmId: number | null = null;
  /** Identity of the current form (which hands, which halves); a change starts a crossfade from `from`. */
  private formKey = '';
  private from: GestureFx = { ...GESTURE_HOME };
  private fade = 1;
  private fadeTime = 0;
  private out: GestureFx = { ...GESTURE_HOME };
  private holding = 0;
  private frozenFor = -1;
  private armed = true;
  private bloom = 0;
  private whoosh = 0;
  private sinceWhoosh = Infinity;
  private fast = false;

  constructor(config: Partial<HandConfig> = {}) { this.config = { ...DEFAULT_HANDS, ...config }; }

  /** Current values without advancing time. */
  get value(): GestureFx { return { ...this.out }; }

  /** Forget every hand and return home at once (the caller has released Live). */
  release(): GestureFx {
    this.hands.clear(); this.rhythmId = null; this.formKey = ''; this.from = { ...GESTURE_HOME }; this.fade = 1; this.fadeTime = 0;
    this.holding = 0; this.frozenFor = -1; this.armed = true; this.bloom = 0; this.whoosh = 0; this.sinceWhoosh = Infinity; this.fast = false;
    this.out = { ...GESTURE_HOME };
    return this.value;
  }

  /** Advance by dtSeconds with this frame's hands. Hands without a finite id and position are ignored. */
  step(input: readonly HandTelemetry[] | null | undefined, dtSeconds: number): GestureFx {
    const c = this.config;
    const dt = Number.isFinite(dtSeconds) ? Math.max(0, Math.min(5, dtSeconds)) : 0;

    // Per-hand smoothing by id. A new hand starts open, sideways and still, so it eases in instead of snapping.
    const seen = new Set<number>();
    for (const hand of Array.isArray(input) ? input : []) {
      if (!hand || !Number.isFinite(hand.id) || !Number.isFinite(hand.x) || !Number.isFinite(hand.y) || seen.has(hand.id)) continue;
      seen.add(hand.id);
      const grip = unit(1 - finite(hand.openness, 1)), palm = Math.max(-1, Math.min(1, finite(hand.palmUp, 0)));
      const speed = Math.max(0, finite(hand.speed, 0)), x = unit(hand.x), y = unit(hand.y);
      const t = this.hands.get(hand.id);
      if (!t) { this.hands.set(hand.id, { grip: ease(0, grip, dt, c), palm: ease(0, palm, dt, c), x, y, speed: ease(0, speed, dt, c), age: dt }); continue; }
      t.grip = ease(t.grip, grip, dt, c); t.palm = ease(t.palm, palm, dt, c); t.speed = ease(t.speed, speed, dt, c);
      t.x = approach(t.x, x, dt, c.positionTau); t.y = approach(t.y, y, dt, c.positionTau); t.age += dt;
    }
    for (const id of [...this.hands.keys()]) if (!seen.has(id)) this.hands.delete(id);

    // The two hands present longest play; the left one is rhythm, swapping only on a clear crossing.
    const playing = [...this.hands].sort(([a, p], [b, q]) => q.age - p.age || a - b).slice(0, 2);
    let target: GestureFx = { ...GESTURE_HOME };
    if (playing.length === 1) {
      const [, h] = playing[0], tilt = .5 + .5 * h.palm, level = spotlight(h.y, c.deadZone);
      target = { ...target, muffleRhythm: h.grip, muffleMelodic: h.grip, tiltRhythm: tilt, tiltMelodic: tilt, levelRhythm: 1 - level, levelMelodic: level };
      this.rhythmId = null;
    } else if (playing.length === 2) {
      let [[rid, r], [mid, m]] = playing[0][1].x <= playing[1][1].x ? playing : [playing[1], playing[0]];
      const kept = this.rhythmId === mid ? [mid, m, rid, r] as const : this.rhythmId === rid ? [rid, r, mid, m] as const : null;
      // Keep the current rhythm hand unless it is now right of the other by more than the margin.
      if (kept && kept[1].x <= kept[3].x + c.crossMargin) [rid, r, mid, m] = kept;
      this.rhythmId = rid;
      const distance = Math.hypot(r.x - m.x, r.y - m.y);
      target = {
        ...target, muffleRhythm: r.grip, muffleMelodic: m.grip, tiltRhythm: .5 + .5 * r.palm, tiltMelodic: .5 + .5 * m.palm,
        levelRhythm: r.y, levelMelodic: m.y, span: .5 + .5 * Math.max(-1, Math.min(1, (distance - c.spanCenter) / Math.max(1e-6, c.spanRange))),
      };
    } else this.rhythmId = null;

    // Handover: a change of hands or halves crossfades from the last output, so nothing jumps.
    const key = playing.length === 2 ? `${this.rhythmId}|${playing.map(([id]) => id).filter(id => id !== this.rhythmId)}` : playing.map(([id]) => id).join();
    if (key !== this.formKey) {
      this.formKey = key; this.from = { ...this.out }; this.fade = 0;
      this.fadeTime = playing.length ? c.handover : c.homeTime;
    }
    this.fade = this.fadeTime > 0 ? Math.min(1, this.fade + dt / this.fadeTime) : 1;

    // Freeze: hold a fist to grab the moment; open (or the cap) ends it and fires the bloom.
    const grip = playing.reduce((most, [, h]) => Math.max(most, h.grip), 0);
    this.bloom = approach(this.bloom, 0, dt, c.bloomTau);
    if (this.frozenFor >= 0) {
      this.frozenFor += dt;
      if (grip <= c.freezeOff || this.frozenFor >= c.freezeCap) { this.frozenFor = -1; this.armed = false; this.bloom = 1; }
    }
    if (grip <= c.freezeOff) this.armed = true;
    if (this.frozenFor < 0) {
      this.holding = this.armed && grip >= c.freezeOn ? this.holding + dt : 0;
      if (this.holding >= c.freezeHold) { this.frozenFor = 0; this.holding = 0; }
    }

    // Whoosh: one per swipe (speed must fall below the threshold again), at most once per cooldown.
    const speed = [...this.hands.values()].reduce((most, h) => Math.max(most, h.speed), 0);
    this.whoosh = approach(this.whoosh, 0, dt, c.whooshTau); this.sinceWhoosh += dt;
    if (speed >= c.whooshSpeed) {
      if (!this.fast && this.sinceWhoosh >= c.whooshCooldown) { this.whoosh = 1; this.sinceWhoosh = 0; }
      this.fast = true;
    } else this.fast = false;

    const out = {} as GestureFx;
    for (const k of GESTURE_KEYS) {
      const v = this.from[k] + (target[k] - this.from[k]) * this.fade;
      out[k] = Number.isFinite(v) ? unit(v) : GESTURE_HOME[k];
    }
    out.freeze = this.frozenFor >= 0 ? 1 : 0; out.bloom = unit(this.bloom); out.whoosh = unit(this.whoosh);
    // Exponential decays never land exactly: snap to home so Live sees true rest.
    for (const k of GESTURE_KEYS) if (Math.abs(out[k] - GESTURE_HOME[k]) < 2e-3) out[k] = GESTURE_HOME[k];
    if (out.bloom === 0) this.bloom = 0;
    if (out.whoosh === 0) this.whoosh = 0;
    this.out = out;
    return this.value;
  }
}
