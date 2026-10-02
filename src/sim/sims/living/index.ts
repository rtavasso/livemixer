/**
 * Shared ground for the living simulations (Tide, Lantern, Murmuration).
 *
 * The box is an upright Pepper's-ghost picture that the visitor reaches through. Each living
 * simulation declares `hologramFrame: 'wall'`, so a hologram-calibrated source arrives as:
 *
 *   sim x = across the picture (0 left … 1 right)
 *   sim y = up the picture (0 bottom … 1 top)
 *   sim z = depth, with the picture plane at 0.5: the viewer's side toward 0, through it toward 1
 *
 * Uncalibrated sources (pointer, synthetic) read the same way: the pointer hovers at z = 0.25 and
 * a press pushes to z = 1, i.e. through the picture. Drawing is therefore in picture space: a sim
 * point (x, y) is uv (x, y) on the canvas.
 *
 * Every living simulation publishes the same five signals (`LIVING_SIGNALS`), so the musical
 * governor and the Ableton mapping are written once. See docs/LIVING.md.
 */
import type { SignalSpecs, SimInput } from '../../core/types';
import type { HandState } from '../../input/types';
import { approach, clamp01, smoothstep } from '../../core/math';

export const LIVING_SIGNALS = {
  presence: { min: 0, max: 1, description: 'A hand is in the box (tracker presence, smoothed).' },
  reach: { min: 0, max: 1, description: 'How far the primary hand has pushed through the picture plane: 0 in front of it, 1 fully through.' },
  lift: { min: 0, max: 1, description: 'Height of the primary hand on the picture: 0 bottom, 1 top (last known).' },
  closeness: { min: 0, max: 1, description: 'How near the creature(s) are to the hand; slow. Gates how far the music may move from the original mix.' },
  agitation: { min: 0, max: 1, description: 'Turbulence of the scene; fast. Pulls the music back toward the original mix.' },
} as const satisfies SignalSpecs;

export type LivingSignals = Record<keyof typeof LIVING_SIGNALS, number>;

/** Where the picture plane sits on the sim z axis, and the soft band around it (sim z units; 0.1 ≈ 2 cm with a 10 cm pull-back). */
export const PLANE_Z = .5;
export const PLANE_BAND = .1;

export interface PictureHand {
  id: number;
  /** Position on the picture, uv (y up). */
  x: number; y: number;
  /** Velocity across the picture, uv units per second. */
  vx: number; vy: number;
  speed: number;
  /** 0 in front of the plane → 1 at the plane → stays 1 behind it: "is touching the picture". */
  contact: number;
  /** 0 until the plane, rising to 1 at full depth behind it: "how far through". */
  reach: number;
  /** Approximate size on the picture (uv x units). */
  radius: number;
  /** 0 open hand … 1 fist (1 − openness). Sources that cannot tell read as an open hand. */
  grip: number;
  /** Palm facing: 1 palm up … −1 palm down; 0 sideways or when the source cannot tell. */
  palmUp: number;
  hand: HandState;
}

/** The hand as the picture sees it. */
export function pictureHand(hand: HandState): PictureHand {
  const z = hand.position.z;
  return {
    id: hand.id, x: hand.position.x, y: hand.position.y, vx: hand.velocity.x, vy: hand.velocity.y, speed: hand.speed,
    contact: smoothstep(PLANE_Z - PLANE_BAND, PLANE_Z + PLANE_BAND * .5, z),
    reach: smoothstep(PLANE_Z - PLANE_BAND, 1, z),
    radius: Math.max(.03, Math.min(.2, hand.radius)),
    grip: clamp01(1 - hand.openness), palmUp: Math.max(-1, Math.min(1, hand.palmUp)), hand,
  };
}

/** Every present hand, and the primary one. */
export function pictureHands(input: SimInput): { hands: PictureHand[]; primary: PictureHand | null } {
  const hands = input.hands.map(pictureHand);
  const primary = input.primary ? hands.find(h => h.id === input.primary!.id) ?? null : null;
  return { hands, primary };
}

/**
 * The Leap is weakest at the picture's top edge (~46 cm above it): interaction fades out over the
 * top `band` of the picture so nothing important depends on it.
 */
export function topFade(y: number, band = .06): number { return 1 - smoothstep(1 - band, 1, y); }

/**
 * The creatures' mood, shared by all three simulations.
 *
 * - `fear` jumps with agitation and relaxes over several seconds of calm (faster when familiar).
 * - `boldness` is the willingness to come to the hand: it grows only while a hand is present,
 *   fairly still and fear is low, after a patience delay that shrinks with familiarity.
 * - `familiarity` (habituation) grows while a visitor stays calm with the creatures and fades
 *   when the box is empty for a while, so each new visitor starts fresh.
 *
 * Deterministic: time arrives through `dt`.
 */
export interface MoodInput {
  /** 0..1 a hand is here. */
  presence: number;
  /** 0..1 how still the hand is (1 = still). */
  stillness: number;
  /** 0..1 turbulence right now. */
  agitation: number;
}
export interface MoodSettings {
  /** Seconds of stillness before creatures approach a stranger. */
  patience: number;
  /** Seconds for fear to relax (to ~37 %) with no familiarity. */
  calmTime: number;
  /** Agitation above this frightens. */
  startle: number;
}
export const DEFAULT_MOOD: MoodSettings = { patience: 2.5, calmTime: 6, startle: .35 };

export class Mood {
  fear = 0;
  boldness = 0;
  familiarity = 0;
  private stillFor = 0;

  update(dt: number, input: MoodInput, settings: MoodSettings = DEFAULT_MOOD) {
    const { presence, stillness, agitation } = input;
    // Fear: fast attack from agitation above the startle level, slow release.
    const scare = clamp01((agitation - settings.startle) / Math.max(.05, 1 - settings.startle));
    if (scare > this.fear) this.fear = approach(this.fear, scare, dt, .12);
    else this.fear = approach(this.fear, 0, dt, settings.calmTime * (1 - .5 * this.familiarity));
    // Patience: time spent present, still and unafraid.
    const calm = presence > .5 && stillness > .6 && this.fear < .25;
    this.stillFor = calm ? this.stillFor + dt : Math.max(0, this.stillFor - 3 * dt);
    const wait = settings.patience * (1 - .6 * this.familiarity);
    const want = presence > .5 && this.stillFor >= wait ? (1 - this.fear) : 0;
    // Approach takes a couple of seconds; fleeing is quick.
    this.boldness = approach(this.boldness, want * (presence > .5 ? 1 : 0), dt, want > this.boldness ? 1.6 : .35);
    this.boldness = Math.min(this.boldness, 1 - this.fear);
    // Habituation: a minute of calm company makes creatures trust faster; an empty box forgets over ~1.5 minutes.
    if (presence > .5) this.familiarity = approach(this.familiarity, this.boldness > .5 ? 1 : this.familiarity, dt, 60);
    else this.familiarity = approach(this.familiarity, 0, dt, 90);
  }
}

/** A value that follows a target with separate rise and fall time constants (seconds). */
export class Follower {
  constructor(public value = 0, private readonly rise = .2, private readonly fall = .6) {}
  update(target: number, dt: number) { this.value = approach(this.value, target, dt, target > this.value ? this.rise : this.fall); return this.value; }
}

/**
 * GLSL for the ghost frame: emissive light on true black, faded to black at the calibrated
 * hologram active area and over the weak top band, then tone-mapped. Uniforms: `u_area`
 * (x0, y0, x1, y1 of the active area in uv, y UP) and `u_edge` (soft edge width in uv).
 */
export function ghostFrameGlsl(): string {
  return `
uniform vec4 u_area;
uniform float u_edge;
float ghostMask(vec2 uv) {
  float e = max(u_edge, 1e-3);
  float mx = smoothstep(u_area.x, u_area.x + e, uv.x) * (1.0 - smoothstep(u_area.z - e, u_area.z, uv.x));
  float my = smoothstep(u_area.y, u_area.y + e, uv.y) * (1.0 - smoothstep(u_area.w - e * 1.6, u_area.w, uv.y));
  return mx * my;
}
vec3 ghostTone(vec3 c) { c = vec3(1.0) - exp(-max(c, vec3(0.0))); return pow(c, vec3(1.0 / 2.2)); }
`;
}

/** The active area as the `u_area` uniform (uv, y up) from the context's screen-space area (y down). */
export function areaUniform(area: { x0: number; y0: number; x1: number; y1: number } | undefined): [number, number, number, number] {
  if (!area) return [0, 0, 1, 1];
  return [area.x0, 1 - area.y1, area.x1, 1 - area.y0];
}
