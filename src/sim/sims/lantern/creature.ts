/**
 * The Lantern's body and mind: one jellyfish bell with verlet tentacles, in the picture plane.
 * Plain TypeScript, no WebGL, deterministic given its seed and the sequence of `step` calls.
 *
 * Frame: "uniform" picture units, x across 0..aspect, y up 0..1 (canvas height = 1), so the bell
 * is round on screen. Hands arrive as `PictureHand`s (uv) and are converted here.
 *
 * Body
 *  - The bell is a rigid frame (origin at the centre of the rim, `heading` = angle of its apex
 *    from straight up) whose width contracts in pulses. The contraction's RISE is the jet: each
 *    contraction adds velocity along the heading, so its swimming follows the pulse clock.
 *  - The pulse clock is a phase that free-runs at ~70 bpm and, when Live's transport is running,
 *    is pulled (never jumped) onto the music: one contraction every `pulseBeats` beats.
 *  - Tentacles and oral arms are verlet chains rooted on the rim / in the cavity. Water drag,
 *    a little weight and a travelling undulation keep them alive; hand capsules push them out
 *    (with friction, so they drape and slide over fingers rather than bounce).
 *
 * Mind (the shared `Mood`)
 *  - Wanders slowly inside the active area, away from the edges and the weak top band.
 *  - With boldness it drifts to just above a still hand so the tentacles fall over it.
 *  - A slow hand in contact with the bell strokes it (glow rises); a fast approach pokes it
 *    (flinch: snap contraction, dim, recoil); fear sends it to the far corner, dim.
 */
import { approach, clamp, clamp01, rng, smoothstep } from '../../core/math';
import type { MusicClock } from '../../core/music';
import { DEFAULT_MOOD, Follower, Mood, PLANE_BAND, PLANE_Z, type PictureHand } from '../living';

export interface LanternParams {
  /** Bell half-width, canvas-height units. */
  size: number;
  tentacles: number;
  /** Tentacle length, canvas-height units. */
  length: number;
  /** Beats per contraction. */
  pulseBeats: number;
  glow: number;
}
export const DEFAULT_LANTERN: LanternParams = { size: .12, tentacles: 16, length: .42, pulseBeats: 2, glow: 1 };

export interface LanternStepInput {
  dt: number;
  hands: readonly PictureHand[];
  primary: PictureHand | null;
  presence: number;
  music?: MusicClock | null;
}

/** Active area in uv (x0, y0, x1, y1), y up: `areaUniform(ctx.activeArea)`. */
export type Area = readonly [number, number, number, number];

export const MAX_TENTACLES = 20;
export const ARM_COUNT = 4;
export const TENTACLE_POINTS = 22;
export const ARM_POINTS = 12;
/** Free-running pulse tempo without music. */
export const IDLE_BPM = 70;
/** Capsules the solver keeps per step (hands × bones). */
export const MAX_CAPSULES = 48;
const CAPSULE_PAD = .008;
const ITERATIONS = 4;

export interface Chain {
  kind: 'tentacle' | 'arm';
  n: number;
  x: Float64Array; y: Float64Array; px: Float64Array; py: Float64Array;
  /** Rest length of each segment. */
  rest: number;
  /** Root in the bell frame, as fractions: u of the bell width, v of the bell height. */
  rootU: number; rootV: number;
  phase: number;
  /** 1 in front of the bell, lower behind it (drawn dimmer). */
  depth: number;
  /** Points of this chain currently touching a hand. */
  touching: number;
}

/** The contraction envelope over one pulse: a quick squeeze peaking at 18 % of the period, then a long relaxation. */
export function contraction(phase: number): number {
  const p = phase - Math.floor(phase);
  if (p < .18) return smoothstep(0, .18, p);
  return Math.pow(1 - smoothstep(.18, .97, p), 1.4);
}

const wrapHalf = (v: number) => v - Math.round(v);

export class Lantern {
  // Bell state.
  x: number; y: number; vx = 0; vy = 0;
  heading = 0; turn = 0;
  /** Pulse phase 0..1 (a contraction starts at 0). */
  phase = 0;
  /** Current contraction 0..1 (pulse or flinch). */
  squeeze = 0;
  width = DEFAULT_LANTERN.size; height = DEFAULT_LANTERN.size * .95;
  readonly chains: Chain[] = [];

  // Mind.
  readonly mood = new Mood();
  flinch = 0;
  private flinchCooldown = 0;
  readonly stroke = new Follower(0, .5, 2.5);
  /** Overall light 0..~2, eased. */
  readonly glow = new Follower(.7, .6, .5);
  /** How much the fear dims it (0..1), eased. */
  readonly dim = new Follower(0, .3, 2);
  private wanderX: number; private wanderY: number; private wanderTimer = 0;
  private fleeing = false; private fleeX = 0; private fleeY = 0;
  targetX: number; targetY: number;

  // Signals.
  reach = 0; lift = 0;
  readonly closeness = new Follower(0, 1, 1.5);
  readonly agitation = new Follower(0, .08, .2);
  presence = 0;
  contactFraction = 0;

  aspect: number;
  private area: Area = [0, 0, 1, 1];
  private readonly random: () => number;
  private tentacleCount = 0; private tentacleLength = 0;
  private time = 0;
  private readonly caps = new Float64Array(MAX_CAPSULES * 6);
  /** Per capsule bounding box (padded by its radius): x0, y0, x1, y1; and one around all of them. */
  private readonly boxes = new Float64Array(MAX_CAPSULES * 4);
  private readonly allBox = new Float64Array(4);
  private capCount = 0;

  constructor(aspect = 16 / 9, seed = 7, params: Partial<LanternParams> = {}) {
    this.aspect = aspect;
    this.random = rng(seed);
    this.x = aspect * .5; this.y = .55;
    this.wanderX = this.x; this.wanderY = this.y; this.targetX = this.x; this.targetY = this.y;
    this.phase = this.random();
    this.rebuild({ ...DEFAULT_LANTERN, ...params });
  }

  /** The canvas aspect and active area (uv, y up). Call before each step; cheap. */
  setFrame(aspect: number, area: Area) {
    if (aspect !== this.aspect) {
      // Keep the creature at the same place on the picture.
      const s = aspect / this.aspect;
      this.x *= s; this.wanderX *= s; this.fleeX *= s;
      for (const c of this.chains) for (let i = 0; i < c.n; i++) { c.x[i] *= s; c.px[i] *= s; }
      this.aspect = aspect;
    }
    this.area = area;
  }

  /** Bell bounds for the rim origin, uniform units. */
  bounds() {
    const [u0, v0, u1, v1] = this.area, a = this.aspect, w = this.width, h = this.height;
    let x0 = u0 * a + w + .07, x1 = u1 * a - w - .07;
    let y0 = v0 + .08 + .5 * this.tentacleLength, y1 = v1 - (v1 - v0) * .07 - h - .06;
    if (x0 > x1) x0 = x1 = (u0 + u1) * .5 * a;
    if (y0 > y1) y0 = y1 = (v0 + v1) * .5;
    return { x0, y0, x1, y1 };
  }

  /** Rebuild the tentacles when their count or length changes. */
  private rebuild(p: LanternParams) {
    const count = clamp(Math.round(p.tentacles), 1, MAX_TENTACLES);
    if (count === this.tentacleCount && Math.abs(p.length - this.tentacleLength) < 1e-6 && this.chains.length) return;
    this.tentacleCount = count; this.tentacleLength = p.length;
    this.chains.length = 0;
    const make = (kind: Chain['kind'], n: number, rest: number, rootU: number, rootV: number, depth: number): Chain => {
      const c: Chain = { kind, n, x: new Float64Array(n), y: new Float64Array(n), px: new Float64Array(n), py: new Float64Array(n), rest, rootU, rootV, phase: this.random() * Math.PI * 2, depth, touching: 0 };
      const [rx, ry] = this.local(rootU * this.width, rootV * this.height);
      for (let i = 0; i < n; i++) { c.x[i] = c.px[i] = rx + (this.random() - .5) * 1e-3; c.y[i] = c.py[i] = ry - i * rest; }
      return c;
    };
    for (let k = 0; k < count; k++) {
      // Spread across the rim, alternating in front of / behind the bell for a hint of a ring.
      const s = count === 1 ? 0 : -1 + 2 * k / (count - 1);
      const u = Math.sin(s * Math.PI * .5) * .94;
      const front = k % 2 === 0;
      const len = p.length * (.55 + .6 * this.random()) * (front ? 1 : .85);
      this.chains.push(make('tentacle', TENTACLE_POINTS, len / (TENTACLE_POINTS - 1), u, -.02, front ? 1 : .55));
    }
    for (let k = 0; k < ARM_COUNT; k++) {
      const u = (-1 + 2 * k / (ARM_COUNT - 1)) * .22;
      const len = p.length * (.42 + .16 * this.random());
      this.chains.push(make('arm', ARM_POINTS, len / (ARM_POINTS - 1), u, .15, .85));
    }
  }

  /** Bell frame → world: u across (right of the apex), v along the apex. */
  local(u: number, v: number): [number, number] {
    const s = Math.sin(this.heading), c = Math.cos(this.heading);
    return [this.x + u * c + v * s, this.y - u * s + v * c];
  }

  /** Centre of the bell's body (for distances and glow). */
  centre(): [number, number] { return this.local(0, this.height * .45); }

  step(input: LanternStepInput, params: LanternParams) {
    const dt = input.dt;
    this.time += dt;
    this.rebuild(params);
    this.presence = input.presence;
    const a = this.aspect;
    const primary = input.primary;
    this.packCapsules(input.hands);

    // --- Sense the primary hand ---------------------------------------------------------------
    const [cx, cy] = this.centre();
    let handDist = Infinity, handR = 0, hx = 0, hy = 0, hvx = 0, hvy = 0, speedU = 0, still = 1;
    if (primary) {
      hx = primary.x * a; hy = primary.y; hvx = primary.vx * a; hvy = primary.vy;
      handR = primary.radius * a;
      speedU = Math.sqrt(hvx * hvx + hvy * hvy);
      still = 1 - clamp01(primary.speed / .6);
      handDist = this.nearestHand(cx, cy, hx, hy);
      this.reach = approach(this.reach, primary.reach, dt, .1);
      this.lift = approach(this.lift, clamp01(primary.y), dt, .1);
    } else {
      this.reach = approach(this.reach, 0, dt, 2);
    }
    const bellR = this.width * 1.05;
    const near = primary ? 1 - smoothstep(bellR, .6, handDist) : 0;

    // Stroke and poke.
    this.flinchCooldown = Math.max(0, this.flinchCooldown - dt);
    let stroking = 0;
    if (primary && handDist < bellR + .04) {
      const dx = cx - hx, dy = cy - hy, d = Math.sqrt(dx * dx + dy * dy) || 1;
      const approachSpeed = (hvx * dx + hvy * dy) / d;
      if (approachSpeed > .75 && this.flinchCooldown <= 0) {
        this.flinch = 1; this.flinchCooldown = .6;
        this.vx += dx / d * .22; this.vy += dy / d * .22;
        this.turn += (dx * Math.cos(this.heading) - dy * Math.sin(this.heading)) / d * 1.5;
      } else if (speedU > .02 && speedU < .5) stroking = 1;
    }
    this.flinch = approach(this.flinch, 0, dt, .45);
    this.stroke.update(stroking, dt);

    // Agitation: hand speed, weighted toward the creature, and flinching.
    const handAgitation = primary ? clamp01(speedU / 1.3) * (.45 + .55 * near) : 0;
    this.agitation.update(clamp01(Math.max(handAgitation, this.flinch * .9)), dt);
    this.mood.update(dt, { presence: primary ? input.presence : 0, stillness: primary ? still : 1, agitation: this.agitation.value }, DEFAULT_MOOD);
    const { fear, boldness } = this.mood;

    // --- Where to go --------------------------------------------------------------------------
    const b = this.bounds();
    this.wanderTimer -= dt;
    const wdx = this.wanderX - this.x, wdy = this.wanderY - this.y;
    if (this.wanderTimer <= 0 || wdx * wdx + wdy * wdy < .03 * .03) {
      this.wanderX = b.x0 + (b.x1 - b.x0) * (.1 + .8 * this.random());
      this.wanderY = b.y0 + (b.y1 - b.y0) * (.2 + .7 * this.random());
      this.wanderTimer = 8 + 7 * this.random();
    }
    let tx = this.wanderX, ty = this.wanderY;
    const come = primary ? smoothstep(.1, .6, boldness) : 0;
    if (come > 0) {
      // Just above the hand, so the rim sits over the fingertips and the tentacles fall across it.
      const ax = clamp(hx, b.x0, b.x1), ay = clamp(hy + primary!.radius * 1.7 + .02, b.y0, b.y1);
      tx += (ax - tx) * come; ty += (ay - ty) * come;
    }
    if (fear > .3 && !this.fleeing) {
      this.fleeing = true;
      const refX = primary ? hx : cx, refY = primary ? hy : cy;
      let best = -1;
      for (const [qx, qy] of [[b.x0, b.y0], [b.x1, b.y0], [b.x0, b.y1], [b.x1, b.y1]]) {
        const d = (qx - refX) ** 2 + (qy - refY) ** 2;
        if (d > best) { best = d; this.fleeX = qx; this.fleeY = qy; }
      }
    } else if (fear < .08) this.fleeing = false;
    const flee = this.fleeing ? smoothstep(.05, .35, fear) : 0;
    tx += (this.fleeX - tx) * flee; ty += (this.fleeY - ty) * flee;
    this.targetX = tx; this.targetY = ty;

    // --- Pulse clock ---------------------------------------------------------------------------
    const beats = Math.max(1, Math.round(params.pulseBeats)) / (fear > .5 ? 2 : 1);
    const beatsPerPulse = Math.max(.5, beats);
    const music = input.music && input.music.playing ? input.music : null;
    const rate = (music ? music.bpm : IDLE_BPM) / 60 / beatsPerPulse;
    let bend = 1;
    if (music) bend = 1 + clamp(wrapHalf(music.beat / beatsPerPulse - this.phase) * 2.5, -.6, .6);
    const previousSqueeze = this.squeeze;
    this.phase = (this.phase + dt * rate * bend) % 1;
    const pulse = contraction(this.phase);
    this.squeeze = Math.max(pulse * (.8 + .2 * boldness), this.flinch > .02 ? Math.min(1, this.flinch * 1.4) : 0);
    this.width = params.size * (1 - .2 * this.squeeze);
    this.height = params.size * .95 * (1 + .1 * this.squeeze);

    // --- Swim ------------------------------------------------------------------------------------
    let dx = tx - this.x, dy = ty - this.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    // Edges push back softly (the hard clamp below is only a safety net).
    const m = .08;
    const ex = smoothstep(b.x0 + m, b.x0 - .02, this.x) - smoothstep(b.x1 - m, b.x1 + .02, this.x);
    const ey = smoothstep(b.y0 + m, b.y0 - .02, this.y) - smoothstep(b.y1 - m, b.y1 + .02, this.y);
    // Desired heading: toward the target when far, upright and resting when there.
    const arrived = smoothstep(.1, .03, dist);
    let want = Math.atan2(dx + ex * .3, dy + ey * .3);
    want = want * (1 - arrived) + Math.sin(this.time * .23) * .18 * arrived;
    want = clamp(want, -1.25 - .6 * flee, 1.25 + .6 * flee);
    const err = wrapHalf((want - this.heading) / (Math.PI * 2)) * Math.PI * 2;
    this.turn += (err * .8 - this.turn * 1.8) * dt;
    this.heading += this.turn * dt;

    // Jet: the rising part of each contraction pushes along the apex.
    const push = Math.max(0, this.squeeze - previousSqueeze);
    const hs = Math.sin(this.heading), hc = Math.cos(this.heading);
    const facing = dist > 1e-6 ? Math.max(0, (hs * dx + hc * dy) / dist) : 0;
    const effort = (.3 + .7 * smoothstep(.03, .25, dist)) * (.35 + .65 * facing) * (1 + 1.2 * flee);
    const jet = push * .075 * effort;
    this.vx += hs * jet; this.vy += hc * jet;
    // A gentle current toward the target (fins and water), sinking a little, and the edges.
    if (dist > 1e-6) { dx /= dist; dy /= dist; }
    const pull = .22 * Math.min(dist, .35) * (1 + boldness * come + flee);
    this.vx += (dx * pull + ex * .35) * dt;
    this.vy += (dy * pull + ey * .35 - .006) * dt;
    this.bellHandPush(dt);
    const drag = Math.exp(-dt * 1.3);
    this.vx *= drag; this.vy *= drag;
    this.x += this.vx * dt; this.y += this.vy * dt;
    if (this.x < b.x0) { this.x = b.x0; this.vx = Math.max(0, this.vx); }
    if (this.x > b.x1) { this.x = b.x1; this.vx = Math.min(0, this.vx); }
    if (this.y < b.y0) { this.y = b.y0; this.vy = Math.max(0, this.vy); }
    if (this.y > b.y1) { this.y = b.y1; this.vy = Math.min(0, this.vy); }

    // --- Tentacles ---------------------------------------------------------------------------
    const touched = this.stepChains(dt);
    const total = this.chains.reduce((s, c) => s + c.n - 1, 0);
    this.contactFraction = clamp01(touched / Math.max(1, total * .12));

    // --- Light and signals -----------------------------------------------------------------------
    this.dim.update(clamp01(smoothstep(.05, .5, fear) + (this.fleeing ? .3 : 0)), dt);
    const light = (.55 + .3 * input.presence + .45 * this.stroke.value + .12 * pulse) * (1 - .6 * this.dim.value) * (1 - .55 * this.flinch);
    this.glow.update(light, dt);
    const proximity = primary ? 1 - smoothstep(bellR + handR * .5, .5, handDist) : 0;
    this.closeness.update(primary ? clamp01(.8 * proximity + .4 * this.contactFraction) : 0, dt);
  }

  /** Distance from a point to the nearest part of the hands (capsules, or the primary's position). */
  private nearestHand(px: number, py: number, hx: number, hy: number): number {
    let best = Math.sqrt((px - hx) ** 2 + (py - hy) ** 2);
    const caps = this.caps;
    for (let k = 0; k < this.capCount; k++) {
      const o = k * 6;
      const d = segmentDistance(px, py, caps[o], caps[o + 1], caps[o + 2], caps[o + 3]) - caps[o + 4];
      if (d < best) best = Math.max(0, d);
    }
    return best;
  }

  /** Hands → 2D capsules in uniform units: a.x, a.y, b.x, b.y, radius, strength. */
  private packCapsules(hands: readonly PictureHand[]) {
    const a = this.aspect, caps = this.caps;
    let n = 0;
    for (const h of hands) {
      const list = h.hand.capsules;
      if (list.length) {
        for (const c of list) {
          if (n >= MAX_CAPSULES) break;
          const o = n * 6;
          caps[o] = c.a.x * a; caps[o + 1] = c.a.y; caps[o + 2] = c.b.x * a; caps[o + 3] = c.b.y;
          caps[o + 4] = c.radius * a + CAPSULE_PAD;
          // A bone through the picture holds the tentacles firmly; one hovering in front only brushes them.
          caps[o + 5] = .2 + .8 * smoothstep(PLANE_Z - PLANE_BAND, PLANE_Z, Math.max(c.a.z, c.b.z));
          n++;
        }
      } else if (n < MAX_CAPSULES) {
        const o = n * 6;
        caps[o] = caps[o + 2] = h.x * a; caps[o + 1] = caps[o + 3] = h.y;
        caps[o + 4] = h.radius * a * .8 + CAPSULE_PAD;
        caps[o + 5] = .2 + .8 * h.contact;
        n++;
      }
    }
    this.capCount = n;
    const box = this.boxes, all = this.allBox;
    all[0] = all[1] = Infinity; all[2] = all[3] = -Infinity;
    for (let k = 0; k < n; k++) {
      const o = k * 6, r = caps[o + 4], q = k * 4;
      box[q] = Math.min(caps[o], caps[o + 2]) - r; box[q + 1] = Math.min(caps[o + 1], caps[o + 3]) - r;
      box[q + 2] = Math.max(caps[o], caps[o + 2]) + r; box[q + 3] = Math.max(caps[o + 1], caps[o + 3]) + r;
      all[0] = Math.min(all[0], box[q]); all[1] = Math.min(all[1], box[q + 1]); all[2] = Math.max(all[2], box[q + 2]); all[3] = Math.max(all[3], box[q + 3]);
    }
  }

  /** The bell body is pushed softly off the hand. */
  private bellHandPush(dt: number) {
    const [cx, cy] = this.centre();
    const r = this.width * .9, caps = this.caps;
    for (let k = 0; k < this.capCount; k++) {
      const o = k * 6;
      closest(cx, cy, caps[o], caps[o + 1], caps[o + 2], caps[o + 3]);
      const dx = cx - Q[0], dy = cy - Q[1], d = Math.sqrt(dx * dx + dy * dy), R = r + caps[o + 4];
      if (d < R && d > 1e-6) {
        const pen = (R - d) * caps[o + 5];
        this.vx += dx / d * pen * 6 * dt; this.vy += dy / d * pen * 6 * dt;
      }
    }
  }

  /** Verlet chains; returns how many points are touching a hand. */
  private stepChains(dt: number): number {
    const caps = this.caps, capCount = this.capCount, box = this.boxes, all = this.allBox;
    const damping = Math.exp(-dt * 2.6), dt2 = dt * dt;
    let touched = 0;
    for (const c of this.chains) {
      const arm = c.kind === 'arm';
      const [rx, ry] = this.local(c.rootU * this.width, c.rootV * this.height);
      const weight = arm ? .16 : .22;
      // Undulation, travelling down the chain, and a kick from each contraction.
      const hs = Math.sin(this.heading), hc = Math.cos(this.heading);
      for (let i = 1; i < c.n; i++) {
        const f = i / (c.n - 1);
        const vx = (c.x[i] - c.px[i]) * damping, vy = (c.y[i] - c.py[i]) * damping;
        const wave = (Math.sin(this.time * (arm ? 1.1 : 1.6) - f * (arm ? 5 : 6) + c.phase) + .5 * Math.sin(this.time * .7 - f * 3 + c.phase * 1.7)) * (arm ? .22 : .3) * f;
        // Perpendicular to the bell axis.
        const ax = hc * wave, ay = -hs * wave - weight;
        c.px[i] = c.x[i]; c.py[i] = c.y[i];
        c.x[i] += vx + ax * dt2; c.y[i] += vy + ay * dt2;
      }
      c.x[0] = c.px[0] = rx; c.y[0] = c.py[0] = ry;
      for (let it = 0; it < ITERATIONS; it++) {
        for (let i = 0; i < c.n - 1; i++) {
          const dx = c.x[i + 1] - c.x[i], dy = c.y[i + 1] - c.y[i];
          const d = Math.sqrt(dx * dx + dy * dy) || 1e-9;
          const diff = (d - c.rest) / d;
          if (i === 0) { c.x[1] -= dx * diff; c.y[1] -= dy * diff; }
          else { c.x[i] += dx * diff * .5; c.y[i] += dy * diff * .5; c.x[i + 1] -= dx * diff * .5; c.y[i + 1] -= dy * diff * .5; }
        }
        // A little stiffness near the root so tentacles leave the rim smoothly.
        for (let i = 0; i < Math.min(4, c.n - 2); i++) {
          const mx = (c.x[i] + c.x[i + 2]) * .5, my = (c.y[i] + c.y[i + 2]) * .5;
          const k = .12 * (1 - i / 4);
          c.x[i + 1] += (mx - c.x[i + 1]) * k; c.y[i + 1] += (my - c.y[i + 1]) * k;
        }
      }
      // Hands: push points out of the capsules; friction lets them drape and slide slowly.
      c.touching = 0;
      if (capCount) for (let i = 1; i < c.n; i++) {
        const px = c.x[i], py = c.y[i];
        if (px < all[0] || px > all[2] || py < all[1] || py > all[3]) continue;
        for (let k = 0; k < capCount; k++) {
          const q = k * 4;
          if (c.x[i] < box[q] || c.x[i] > box[q + 2] || c.y[i] < box[q + 1] || c.y[i] > box[q + 3]) continue;
          const o = k * 6, R = caps[o + 4];
          closest(c.x[i], c.y[i], caps[o], caps[o + 1], caps[o + 2], caps[o + 3]);
          let dx = c.x[i] - Q[0], dy = c.y[i] - Q[1];
          const d2 = dx * dx + dy * dy;
          if (d2 >= R * R) continue;
          let d = Math.sqrt(d2);
          if (d < 1e-7) { dx = 0; dy = 1; d = 0; } else { dx /= d; dy /= d; }
          const pen = (R - d) * caps[o + 5];
          c.x[i] += dx * pen; c.y[i] += dy * pen;
          if (caps[o + 5] > .5) c.touching++;
        }
        if (c.x[i] !== px || c.y[i] !== py) { c.px[i] += (c.x[i] - c.px[i]) * .35; c.py[i] += (c.y[i] - c.py[i]) * .35; }
      }
      touched += c.touching;
    }
    return touched;
  }
}

/** Scratch for `closest`: hot loops must not allocate. */
const Q = new Float64Array(2);
/** Closest point on segment a–b to p, written to `Q`. */
function closest(px: number, py: number, ax: number, ay: number, bx: number, by: number) {
  const abx = bx - ax, aby = by - ay, l2 = abx * abx + aby * aby;
  const t = l2 > 1e-14 ? clamp01(((px - ax) * abx + (py - ay) * aby) / l2) : 0;
  Q[0] = ax + abx * t; Q[1] = ay + aby * t;
}
/** Distance from p to segment a–b. */
export function segmentDistance(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  closest(px, py, ax, ay, bx, by);
  const dx = px - Q[0], dy = py - Q[1];
  return Math.sqrt(dx * dx + dy * dy);
}
