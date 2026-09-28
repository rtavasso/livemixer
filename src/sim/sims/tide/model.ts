/**
 * CPU side of Tide apart from the school: how hands disturb the water, how busy that makes it
 * (agitation), and the five living signals. Pure and deterministic, so it is unit-tested.
 */
import type { Quality } from '../../core/types';
import { approach, clamp01, smoothstep } from '../../core/math';
import { Follower, PLANE_BAND, PLANE_Z, topFade, type PictureHand } from '../living';

/** Wave grid rows per quality (columns follow the aspect so cells are square). */
export const WAVE_ROWS: Record<Quality, number> = { low: 112, medium: 150, high: 192 };
/** The glow (plankton) buffer is this much finer than the wave grid. */
export const GLOW_SCALE = 1.5;
/** Most disturbances the wave pass takes per step. */
export const MAX_FORCES = 8;
/** Encoding ranges of the packed wave field (height, rate). */
export const HEIGHT_RANGE = .5, RATE_RANGE = 4;

export function waveGrid(quality: Quality, aspect: number) {
  const rows = WAVE_ROWS[quality];
  return { width: Math.max(16, Math.round(rows * aspect)), height: rows };
}

/** Wave substeps per fixed step that keep c·dt/dx ≤ 0.5. */
export function substeps(speed: number, dt: number, rows: number) { return Math.max(1, Math.ceil(speed * dt * rows / .5)); }

/**
 * Disturbances for one step: `vec4(x uv, y uv, radius in uniform units, rate impulse)`, a zero-mean
 * dip-and-ring the wave pass adds to the surface rate.
 */
export class Forces {
  readonly data = new Float32Array(MAX_FORCES * 4);
  count = 0;
  begin() { this.count = 0; }
  add(x: number, y: number, radius: number, impulse: number) {
    if (this.count >= MAX_FORCES || Math.abs(impulse) < 1e-6) return;
    const k = this.count * 4;
    this.data[k] = x; this.data[k + 1] = y; this.data[k + 2] = radius; this.data[k + 3] = impulse;
    this.count++;
  }
}

/** Contact of a single point from its depth, as `pictureHand` computes it for the palm. */
export const pointContact = (z: number) => smoothstep(PLANE_Z - PLANE_BAND, PLANE_Z + PLANE_BAND * .5, z);

const tipScratch: { x: number; y: number; z: number; d: number }[] = [];
/**
 * Fingertips poking through the plane: the free ends of the skeleton's capsules (ends no other
 * capsule starts from), leaving out the thickest capsule (the forearm), farthest from the palm first.
 */
export function fingertips(hand: PictureHand, max: number): { x: number; y: number; z: number; d: number }[] {
  const caps = hand.hand.capsules;
  tipScratch.length = 0;
  if (caps.length < 3 || max <= 0) return tipScratch;
  let thick = 0;
  for (let i = 1; i < caps.length; i++) if (caps[i].radius > caps[thick].radius) thick = i;
  for (let i = 0; i < caps.length; i++) {
    if (i === thick) continue;
    const b = caps[i].b;
    let leaf = true;
    for (let j = 0; j < caps.length && leaf; j++) { const a = caps[j].a; if (Math.abs(a.x - b.x) + Math.abs(a.y - b.y) + Math.abs(a.z - b.z) < 1e-5) leaf = false; }
    if (!leaf) continue;
    const dx = b.x - hand.x, dy = b.y - hand.y;
    tipScratch.push({ x: b.x, y: b.y, z: b.z, d: dx * dx + dy * dy });
  }
  tipScratch.sort((p, q) => q.d - p.d);
  if (tipScratch.length > max) tipScratch.length = max;
  return tipScratch;
}

/** Per-hand memory for the disturbance model: last contact, to detect entering the water. */
export class HandWater {
  private last = new Map<number, number>();
  private seen = new Set<number>();
  /** Summed contact-weighted motion this step, before normalisation. */
  stir = 0;

  /**
   * Turn the hands into disturbances. A hand behind the plane makes a slow breathing source
   * (so a still hand glows softly and blooms outward), a wake proportional to its speed, and a
   * splash as it enters. Deeper reach widens it. The weak top band fades everything out.
   */
  update(hands: readonly PictureHand[], dt: number, time: number, aspect: number, force: number, out: Forces) {
    this.seen.clear(); this.stir = 0;
    for (let h = 0; h < hands.length; h++) {
      const hand = hands[h];
      const fade = topFade(hand.y);
      const contact = hand.contact * fade;
      const prev = this.last.get(hand.id) ?? contact;
      this.last.set(hand.id, contact); this.seen.add(hand.id);
      const entering = Math.max(0, contact - prev) / Math.max(dt, 1e-3);
      this.stir += contact * hand.speed + .12 * entering;
      if (contact < .02) continue;
      // The source stays compact (so it rings at a readable wavelength); reach widens the glow instead.
      const radius = hand.radius * aspect * (.4 + .25 * hand.reach);
      // A still hand breathes a ring outward about once a second: a short kick, then quiet while it spreads.
      const phase = (time * .8 + hand.id * .37) % 1, kick = Math.exp(-(phase / .05) * (phase / .05));
      const impulse = force * dt * contact * (22 * kick - 4 * Math.min(hand.speed, 1.5)) - force * .08 * entering * dt * 6;
      out.add(hand.x, hand.y, radius, impulse);
      // Fingers through the water ring on their own (first hand gets most of the slots).
      const tips = fingertips(hand, h === 0 ? 5 : 1);
      for (const t of tips) {
        const c = pointContact(t.z) * topFade(t.y);
        if (c < .05) continue;
        out.add(t.x, t.y, Math.max(.012, hand.radius * aspect * .22), force * dt * c * (5 * Math.sin(time * 17 + t.x * 40) - 3 * Math.min(hand.speed, 1.5)));
      }
    }
    for (const id of this.last.keys()) if (!this.seen.has(id)) this.last.delete(id);
  }
}

/** Normalised agitation from the stir: contact-weighted speed (uv/s) with a splash term. */
export const agitationFrom = (stir: number) => clamp01(stir / .8);

/** The five living signals, smoothed as the contract asks. */
export class TideSignals {
  presence = 0;
  reach = 0;
  lift = .5;
  private closenessF = new Follower(0, 1, 1.5);
  private agitationF = new Follower(0, .06, .2);

  update(dt: number, presence: number, primary: PictureHand | null, agitation: number, closeness: number) {
    this.presence = clamp01(presence);
    if (primary) { this.reach = approach(this.reach, clamp01(primary.reach), dt, .08); this.lift = clamp01(primary.y); }
    else this.reach = approach(this.reach, 0, dt, 1.2);
    this.closenessF.update(primary ? clamp01(closeness) : 0, dt);
    this.agitationF.update(clamp01(agitation), dt);
  }
  get closeness() { return clamp01(this.closenessF.value); }
  get agitation() { return clamp01(this.agitationF.value); }
  values() { return { presence: this.presence, reach: clamp01(this.reach), lift: clamp01(this.lift), closeness: this.closeness, agitation: this.agitation }; }
}
