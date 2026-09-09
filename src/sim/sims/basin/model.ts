/**
 * Basin — CPU-side model. Everything here is pure and free of WebGL so it can
 * be unit-tested: bowl geometry and the sim-space → grid mapping, palettes,
 * probe encoding/decoding and the analytic probe weights, signal shaping and
 * smoothing, and the ink-drop scheduler that turns gesture events into drops.
 *
 * Grid space: the fluid lives on a square grid whose uv ∈ [0, 1]² covers a
 * square of side `domain = min(1, aspect)` uniform units centred on the
 * canvas (uniform units: canvas height = 1, width = aspect). The bowl is a
 * circle of radius `bowl` (grid uv) at (0.5, 0.5). On a landscape display the
 * domain is exactly one uniform unit, so `bowl` is a radius in uniform units;
 * on a portrait display it shrinks so the bowl always fits.
 */
import type { Quality } from '../../core/types';
import type { HandState } from '../../input/types';
import type { GestureEvent } from '../../input/gestures';
import { clamp, clamp01, rng } from '../../core/math';

// ---------------------------------------------------------------------------
// Quality → resources
// ---------------------------------------------------------------------------

export const GRID_BY_QUALITY: Record<Quality, number> = { low: 160, medium: 256, high: 320 };
export const JACOBI_BY_QUALITY: Record<Quality, number> = { low: 16, medium: 24, high: 32 };

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

export interface GridPoint { x: number; y: number }
export interface GridHand { x: number; y: number; vx: number; vy: number; radius: number; push: number }

/** Side of the grid domain in uniform units: the shorter canvas side. */
export const domainScale = (aspect: number) => Math.min(1, Math.max(1e-3, aspect));

/** Sim-space point (each axis spans the canvas) → grid uv. */
export function simToGrid(p: { x: number; y: number }, aspect: number): GridPoint {
  const s = domainScale(aspect);
  return { x: (p.x * aspect - aspect * .5) / s + .5, y: (p.y - .5) / s + .5 };
}

/** Sim-space velocity (sim units/s) → grid uv per second. */
export function simVelocityToGrid(v: { x: number; y: number }, aspect: number): GridPoint {
  const s = domainScale(aspect);
  return { x: v.x * aspect / s, y: v.y / s };
}

/** A conditioned hand in grid units: position, velocity, splat radius (clamped to something sensible). Writes into `out` when given (no allocation per step). */
export function handToGrid(hand: Pick<HandState, 'position' | 'velocity' | 'radius' | 'push'>, aspect: number, out: GridHand = { x: 0, y: 0, vx: 0, vy: 0, radius: 0, push: 0 }): GridHand {
  const s = domainScale(aspect);
  out.x = (hand.position.x * aspect - aspect * .5) / s + .5; out.y = (hand.position.y - .5) / s + .5;
  out.vx = hand.velocity.x * aspect / s; out.vy = hand.velocity.y / s;
  out.radius = clamp(hand.radius * aspect / s * .8, .035, .16);
  out.push = clamp01(hand.push);
  return out;
}

export const bowlDistance = (p: GridPoint) => Math.hypot(p.x - .5, p.y - .5);
export const insideBowl = (p: GridPoint, bowl: number) => bowlDistance(p) <= bowl;

/** Pull a point inside the bowl (used to keep drops from landing on the rim). */
export function clampToBowl(p: GridPoint, bowl: number, margin = .08): GridPoint {
  const d = bowlDistance(p), limit = Math.max(.01, bowl - margin);
  if (d <= limit) return p;
  const k = limit / d;
  return { x: .5 + (p.x - .5) * k, y: .5 + (p.y - .5) * k };
}

// ---------------------------------------------------------------------------
// Shader time. `u_time` is never handed to a shader raw: fp32 loses the
// fractional part of a large time, so after hours the caustic hash coarsens and
// the drift phases stall. Every time-dependent term is a phase or a lattice
// offset that is periodic in the shader, and the CPU reduces it modulo that
// period so the look is seamless across the wrap and identical forever.
// ---------------------------------------------------------------------------

/** Period of the composite's lattice hash (`hash` does `mod(p, CAUSTIC_PERIOD)`). Must match shaders.ts. */
export const CAUSTIC_PERIOD = 64;
/** Lattice units per second that the two caustic layers scroll: (a.x, a.y, b.x, b.y). Must match the composite. */
export const CAUSTIC_RATES: readonly [number, number, number, number] = [.05, -.035, -.04, .045];
/** Frequency ratio of the second value-noise octave in `causticLayer`. Must match shaders.ts. */
export const CAUSTIC_LACUNARITY = 2.13;
/** Cycles per second of the four idle-drift phases in the advect shader. Must match shaders.ts. */
export const DRIFT_RATES: readonly [number, number, number, number] = [.021, -.017, .019, .013];

/** `x` reduced into [0, period) (the `+ 0` turns a -0 remainder into +0). */
export const wrap = (x: number, period: number) => { const m = x % period; return m < 0 ? m + period : m + 0; };

/**
 * Caustic scroll offsets for the composite: [0..3] first octave, [4..7] second
 * octave (the first scaled by the lacunarity), each in [0, CAUSTIC_PERIOD).
 * Each octave wraps on its own so both stay continuous across the wrap.
 */
export function causticOffsets(time: number, out = new Float32Array(8)): Float32Array {
  for (let k = 0; k < 4; k++) {
    const x = time * CAUSTIC_RATES[k];
    out[k] = wrap(x, CAUSTIC_PERIOD);
    out[k + 4] = wrap(x * CAUSTIC_LACUNARITY, CAUSTIC_PERIOD);
  }
  return out;
}

/** Idle-drift phases in cycles, each in [0, 1): the shader multiplies by 2π, so the wrap is invisible. */
export function driftPhases(time: number, out = new Float32Array(4)): Float32Array {
  for (let k = 0; k < 4; k++) out[k] = wrap(time * DRIFT_RATES[k], 1);
  return out;
}

// ---------------------------------------------------------------------------
// RGBA8 fallback ("packed") dissipation. A byte only changes when the step is
// at least half a quantum, so a per-step multiplicative decay of a small value
// is rounded away and the water would never calm (nor the ink fade). In packed
// mode the decay is applied every STRIDE steps with the compound factor, and
// never by less than PACKED_MIN_STEP quanta, so any value still reaches zero.
// ---------------------------------------------------------------------------

/** Velocity full scale of the packed encoding. Must match `VS` in shaders.ts. */
export const PACKED_VELOCITY_SCALE = 4;
/** Steps between dissipation updates in packed mode: velocity and dye. */
export const PACKED_DECAY_STRIDE = 4, PACKED_FADE_STRIDE = 8;
/** Minimum decrement per update, as a fraction of the stored range: more than half a quantum so rounding cannot undo it. */
export const PACKED_MIN_STEP = .6 / 255;

/** Multiplicative factor for this step: `exp(-rate·dt)` in float mode; in packed mode 1 off-stride and the compound factor on-stride. */
export function dissipation(rate: number, dt: number, packed: boolean, step: number, stride: number): number {
  if (!packed) return Math.exp(-rate * dt);
  return step % stride === 0 ? Math.exp(-rate * dt * stride) : 1;
}
/** Subtractive floor for this step (packed mode only, on-stride), in the stored quantity's units. */
export function dissipationFloor(packed: boolean, step: number, stride: number, scale: number): number {
  return packed && step % stride === 0 ? PACKED_MIN_STEP * scale : 0;
}

// ---------------------------------------------------------------------------
// Palettes: linear-ish RGB of the ink colours. Dense ink tends toward these.
// ---------------------------------------------------------------------------

export type Rgb = readonly [number, number, number];
export const PALETTES: Record<string, readonly Rgb[]> = {
  indigo: [[.16, .22, .95], [.05, .62, .92], [.42, .18, .85]],
  ember: [[.95, .18, .06], [.98, .52, .08], [.92, .78, .22]],
  lagoon: [[.04, .68, .62], [.35, .92, .70], [.85, .78, .38]],
  sumi: [[.92, .90, .84], [.55, .58, .62], [.30, .34, .48]],
  orchid: [[.90, .16, .62], [.52, .22, .92], [.98, .62, .48]],
};
export const PALETTE_NAMES = Object.keys(PALETTES) as readonly string[];
export const DEFAULT_PALETTE = 'indigo';

export function resolvePalette(name: string): readonly Rgb[] {
  return PALETTES[name] ?? PALETTES[DEFAULT_PALETTE];
}

// ---------------------------------------------------------------------------
// Probe: a PROBE_SIZE² RGBA8 target; each texel is the masked mean over
// PROBE_SUB² sample points of (speed, |curl|, angular momentum, ink coverage).
// The shader and `probeWeights` must agree on the sample pattern.
// ---------------------------------------------------------------------------

export const PROBE_SIZE = 16;
export const PROBE_SUB = 4;
/** Full-scale values for the 8-bit encodings. Must match shaders.ts. */
export const PROBE_ENC = { speed: 1.5, curl: 40, angular: .6 } as const;

/** Signed encoding with an exactly representable zero at 128/255. */
export const encodeSigned = (x: number, scale: number) => Math.round(clamp(128 + 127 * (x / scale), 0, 255));
export const decodeSigned = (byte: number, scale: number) => (byte - 128) / 127 * scale;
export const encodeUnsigned = (x: number, scale: number) => Math.round(clamp01(x / scale) * 255);
export const decodeUnsigned = (byte: number, scale: number) => byte / 255 * scale;

/** Per probe texel: fraction of its sample points inside the bowl (the averaging weight). */
export function probeWeights(bowl: number, size = PROBE_SIZE, sub = PROBE_SUB): Float32Array {
  const w = new Float32Array(size * size);
  for (let j = 0; j < size; j++) for (let i = 0; i < size; i++) {
    let n = 0;
    for (let sy = 0; sy < sub; sy++) for (let sx = 0; sx < sub; sx++) {
      const x = (i + (sx + .5) / sub) / size, y = (j + (sy + .5) / sub) / size;
      if (insideBowl({ x, y }, bowl)) n++;
    }
    w[j * size + i] = n / (sub * sub);
  }
  return w;
}

export interface Measures {
  /** Mean speed inside the bowl, grid uv per second. */
  speed: number;
  /** Mean |curl|, 1/s. */
  curl: number;
  /** Mean angular momentum about the centre: positive = counter-clockwise. */
  angular: number;
  /** Mean ink coverage 0..1. */
  ink: number;
}

/** Decode a probe readback (RGBA8, row-major, PROBE_SIZE²) into bowl-wide means. */
export function decodeProbe(bytes: ArrayLike<number>, weights: Float32Array): Measures {
  let speed = 0, curl = 0, angular = 0, ink = 0, total = 0;
  for (let k = 0; k < weights.length; k++) {
    const w = weights[k];
    if (w <= 0) continue;
    const o = k * 4;
    speed += w * decodeUnsigned(bytes[o], PROBE_ENC.speed);
    curl += w * decodeUnsigned(bytes[o + 1], PROBE_ENC.curl);
    angular += w * decodeSigned(bytes[o + 2], PROBE_ENC.angular);
    ink += w * decodeUnsigned(bytes[o + 3], 1);
    total += w;
  }
  if (total <= 0) return { speed: 0, curl: 0, angular: 0, ink: 0 };
  return { speed: speed / total, curl: curl / total, angular: angular / total, ink: ink / total };
}

// ---------------------------------------------------------------------------
// Signals
// ---------------------------------------------------------------------------

export interface RawSignals { energy: number; swirl: number; rotation: number; ink: number }
export interface BasinSignals extends RawSignals { calm: number }

/** Saturating curve: 0 at 0, ~0.63 at `scale`, → 1. */
const soft = (x: number, scale: number) => 1 - Math.exp(-Math.max(0, x) / scale);

/** Map physical means to the declared 0..1 / -1..1 ranges. */
export function measuresToSignals(m: Measures): RawSignals {
  return {
    energy: soft(m.speed, .09),
    swirl: soft(m.curl, 5),
    rotation: clamp(Math.tanh(m.angular / .035), -1, 1),
    ink: clamp01(m.ink),
  };
}

/** Exponential smoothing so the audio side sees stable values; `calm` follows a slower energy. */
export class SignalSmoother {
  readonly values: BasinSignals = { energy: 0, swirl: 0, rotation: 0, ink: 0, calm: 1 };
  private slowEnergy = 0;
  constructor(private readonly tau = { energy: .15, swirl: .2, rotation: .35, ink: .4, calm: 1.2 }) {}
  update(raw: RawSignals, dt: number): BasinSignals {
    const k = (tau: number) => (dt <= 0 ? 0 : 1 - Math.exp(-dt / tau));
    const v = this.values;
    v.energy = clamp01(v.energy + (raw.energy - v.energy) * k(this.tau.energy));
    v.swirl = clamp01(v.swirl + (raw.swirl - v.swirl) * k(this.tau.swirl));
    v.rotation = clamp(v.rotation + (raw.rotation - v.rotation) * k(this.tau.rotation), -1, 1);
    v.ink = clamp01(v.ink + (raw.ink - v.ink) * k(this.tau.ink));
    this.slowEnergy = clamp01(this.slowEnergy + (raw.energy - this.slowEnergy) * k(this.tau.calm));
    v.calm = clamp01(1 - this.slowEnergy);
    return v;
  }
}

// ---------------------------------------------------------------------------
// Ink drops
// ---------------------------------------------------------------------------

export interface Drop {
  /** Grid uv. */
  x: number; y: number;
  /** Grid uv. */
  radius: number;
  color: Rgb;
  /** Dye concentration added at the centre. */
  amount: number;
  /** Radial velocity impulse, grid uv per second at the ring. 0 for a gentle bead. */
  impulse: number;
}

export interface DropContext {
  time: number;
  events: readonly GestureEvent[];
  hands: readonly HandState[];
  aspect: number;
  bowl: number;
  /** Drop radius scale from the `ink` param, grid uv. */
  ink: number;
  palette: string;
  dropOnEnter: boolean;
  /** Current smoothed ink coverage signal, for the idle re-seeding rule. */
  inkLevel: number;
}

const PUSH_ON = .62, PUSH_OFF = .45, PUSH_COOLDOWN = .8;
const IDLE_AFTER = 14, IDLE_INK_BELOW = .05, IDLE_SPACING = 9;

/**
 * Turns events and hand state into ink drops. Deterministic given its inputs
 * (seeded rng for colour and size variation). Rules:
 *  - `enter` (when `dropOnEnter`) → a bead where the hand arrived.
 *  - `push` gesture, or `hand.push` crossing PUSH_ON with hysteresis → a bead plus a radial impulse.
 *  - Nobody for IDLE_AFTER seconds and hardly any ink left → a lone bead so the bowl never goes dead.
 */
export class DropScheduler {
  private readonly random: () => number;
  private index = 0;
  private readonly pushed = new Map<number, { on: boolean; lastMs: number }>();
  // Scratch sets reused across calls so a step allocates nothing when nothing happens.
  private readonly pushedNow = new Set<number>();
  private readonly seen = new Set<number>();
  private lastHandTime = -Infinity;
  private lastDropTime = -Infinity;
  constructor(seed = 7) { this.random = rng(seed); }

  /** Beads scattered inside the bowl for the first frame. */
  initial(count: number, bowl: number, palette: string, ink: number): Drop[] {
    const drops: Drop[] = [];
    for (let i = 0; i < count; i++) {
      const a = this.random() * Math.PI * 2, r = bowl * (.15 + .5 * Math.sqrt(this.random()));
      drops.push(this.make({ x: .5 + Math.cos(a) * r, y: .5 + Math.sin(a) * r }, bowl, palette, ink, 1.1, 0));
    }
    return drops;
  }

  /** Appends this step's drops to `drops` (a fresh array when omitted) and returns it. */
  update(ctx: DropContext, drops: Drop[] = []): Drop[] {
    const pushedNow = this.pushedNow, seen = this.seen;
    pushedNow.clear(); seen.clear();
    let added = 0;
    for (const e of ctx.events) {
      if (e.type === 'enter' && ctx.dropOnEnter) {
        const p = simToGrid(e.position, ctx.aspect);
        if (insideBowl(p, ctx.bowl)) { drops.push(this.make(p, ctx.bowl, ctx.palette, ctx.ink, .9, 0)); added++; }
      } else if (e.type === 'push') {
        const p = simToGrid(e.position, ctx.aspect);
        pushedNow.add(e.handId);
        const s = this.pushed.get(e.handId) ?? { on: false, lastMs: -Infinity };
        s.on = true; s.lastMs = ctx.time; this.pushed.set(e.handId, s);
        if (insideBowl(p, ctx.bowl)) { drops.push(this.make(p, ctx.bowl, ctx.palette, ctx.ink, 1.2, .25 + .35 * clamp01(e.depth))); added++; }
      }
    }
    if (ctx.hands.length) this.lastHandTime = ctx.time;
    for (const hand of ctx.hands) {
      seen.add(hand.id);
      let s = this.pushed.get(hand.id);
      if (!s) { s = { on: hand.push >= PUSH_ON, lastMs: -Infinity }; this.pushed.set(hand.id, s); continue; }
      if (!s.on && hand.push >= PUSH_ON) {
        s.on = true;
        if (!pushedNow.has(hand.id) && ctx.time - s.lastMs >= PUSH_COOLDOWN) {
          s.lastMs = ctx.time;
          const p = simToGrid(hand.position, ctx.aspect);
          if (insideBowl(p, ctx.bowl)) { drops.push(this.make(p, ctx.bowl, ctx.palette, ctx.ink, 1.1, .3)); added++; }
        }
      } else if (s.on && hand.push <= PUSH_OFF) s.on = false;
    }
    if (this.pushed.size) for (const id of this.pushed.keys()) if (!seen.has(id) && !pushedNow.has(id)) this.pushed.delete(id);
    if (!ctx.hands.length && ctx.time - this.lastHandTime > IDLE_AFTER && ctx.inkLevel < IDLE_INK_BELOW && ctx.time - this.lastDropTime > IDLE_SPACING) {
      const a = this.random() * Math.PI * 2, r = ctx.bowl * (.1 + .45 * Math.sqrt(this.random()));
      drops.push(this.make({ x: .5 + Math.cos(a) * r, y: .5 + Math.sin(a) * r }, ctx.bowl, ctx.palette, ctx.ink, 1, 0)); added++;
    }
    if (added) this.lastDropTime = ctx.time;
    return drops;
  }

  private make(p: GridPoint, bowl: number, palette: string, ink: number, amount: number, impulse: number): Drop {
    const colors = resolvePalette(palette);
    const base = colors[this.index++ % colors.length];
    const tint = .85 + .3 * this.random();
    const q = clampToBowl(p, bowl);
    return { x: q.x, y: q.y, radius: ink * (.8 + .4 * this.random()), color: [clamp01(base[0] * tint), clamp01(base[1] * tint), clamp01(base[2] * tint)], amount, impulse };
  }
}
