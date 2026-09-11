/**
 * Turns raw, jittery, intermittently missing observations into stable
 * `HandState`s the simulations can trust.
 *
 *  - Presence hysteresis: a hand must be seen for `enterMs` before it exists and
 *    is kept for `leaveMs` after the last observation, so a dropped frame does
 *    not make a curtain snap back or a light trail break.
 *  - One-Euro filtering of position: minimal lag when the hand moves, minimal
 *    jitter when it rests. Velocity is derived from the filtered position.
 *  - Deterministic: all time comes in through arguments, never from Date/performance.
 */
import { z } from 'zod';
import type { OccupancyField, SurfaceField, Vec3, VolumeField } from '../core/types';
import { mapObservation, mapOccupancy, mapSurface, mapVoxels, type SpaceMapping } from './mapping';
import type { Box3, Capsule, HandObservation, HandState, InputFrame } from './types';

export const trackerSettingsSchema = z.object({
  /** Observations below this confidence are ignored. */
  minConfidence: z.number().min(0).max(1).default(.3),
  /** Continuous observation required before a hand is present. */
  enterMs: z.number().min(0).default(60),
  /** Grace period without observations before a hand leaves. */
  leaveMs: z.number().min(0).default(220),
  /** Frames older than this on arrival are discarded. */
  maxFrameAgeMs: z.number().positive().default(250),
  /** One-Euro: cutoff at rest (Hz). Lower = smoother at rest. */
  minCutoff: z.number().positive().default(1.2),
  /** One-Euro: speed coefficient. Higher = less lag when moving. */
  beta: z.number().min(0).default(.02),
  /** One-Euro: derivative cutoff (Hz). */
  derivativeCutoff: z.number().positive().default(1),
  /** Time constant for the velocity estimate (seconds). */
  velocityTau: z.number().positive().default(.06),
  /** Presence rise / fall time constants (seconds). */
  presenceRiseTau: z.number().positive().default(.08),
  presenceFallTau: z.number().positive().default(.6),
  /** Activity (motion energy) time constant and the speed that counts as "fully active". */
  activityTau: z.number().positive().default(.25),
  activityFullSpeed: z.number().positive().default(1.5),
  /** Occupancy field resolution in sim space. */
  occupancyWidth: z.number().int().min(4).max(256).default(64),
  occupancyHeight: z.number().int().min(4).max(256).default(48),
  /** Volume field resolution in sim space (depth-camera voxels). */
  volumeNx: z.number().int().min(4).max(128).default(48),
  volumeNy: z.number().int().min(4).max(128).default(32),
  volumeNz: z.number().int().min(4).max(128).default(24),
  /** Surface field resolution in sim space (depth-camera scan). */
  /** The scan is resampled to this grid; 192×144 keeps finger-level detail from a bridge sending 160×120 or more. */
  surfaceWidth: z.number().int().min(8).max(512).default(192),
  surfaceHeight: z.number().int().min(8).max(512).default(144),
}).strict();
export type TrackerSettings = z.infer<typeof trackerSettingsSchema>;
export const DEFAULT_TRACKER_SETTINGS: TrackerSettings = trackerSettingsSchema.parse({});

/** One-Euro filter (Casiez et al. 2012) for a scalar. */
export class OneEuro {
  private x: number | null = null;
  private dx = 0;
  constructor(private readonly minCutoff: number, private readonly beta: number, private readonly dCutoff: number) {}
  private static alpha(cutoff: number, dt: number) { const tau = 1 / (2 * Math.PI * cutoff); return 1 / (1 + tau / dt); }
  reset(value: number) { this.x = value; this.dx = 0; }
  filter(value: number, dt: number): number {
    if (this.x === null || dt <= 0) { this.x = value; return value; }
    const ad = OneEuro.alpha(this.dCutoff, dt);
    const dx = (value - this.x) / dt;
    this.dx += ad * (dx - this.dx);
    const cutoff = this.minCutoff + this.beta * Math.abs(this.dx);
    const a = OneEuro.alpha(cutoff, dt);
    this.x += a * (value - this.x);
    return this.x;
  }
  get value() { return this.x; }
}

interface Track {
  id: number;
  firstSeenMs: number;
  lastSeenMs: number;
  present: boolean;
  filters: [OneEuro, OneEuro, OneEuro];
  pushFilter: OneEuro;
  position: Vec3;
  velocity: Vec3;
  extent: Box3;
  openness: number;
  pinch: number;
  confidence: number;
  push: number;
  points: Vec3[];
  /** Raw observed capsules (sim space) and the raw position they were observed with. */
  capsules: Capsule[];
  rawPosition: Vec3;
  lastFilterMs: number;
  /** Running estimate of the source's observation interval for this hand, ms. */
  intervalMs: number;
}

export interface TrackedInput {
  hands: HandState[];
  presence: number;
  activity: number;
  occupancy: OccupancyField | null;
  volume: VolumeField | null;
  surface: SurfaceField | null;
  /** Milliseconds since the last accepted frame, or Infinity before the first. */
  sourceAgeMs: number;
  /** Frames dropped as stale/out of order since the last reset. */
  discarded: number;
  stats: Record<string, number>;
}

export class HandTracker {
  private tracks = new Map<number, Track>();
  private sequence = -1;
  private lastFrameMs = -Infinity;
  private lastTickMs: number | null = null;
  private presence = 0;
  private activity = 0;
  private occupancy: OccupancyField | null = null;
  private occupancyAtMs = -Infinity;
  private volume: VolumeField | null = null;
  private volumeAtMs = -Infinity;
  private surface: SurfaceField | null = null;
  private surfaceAtMs = -Infinity;
  private stats: Record<string, number> = {};
  discarded = 0;

  constructor(public mapping: SpaceMapping, public settings: TrackerSettings = DEFAULT_TRACKER_SETTINGS) {}

  /** Forget everything, e.g. when the source or mapping changes. */
  reset() {
    this.tracks.clear(); this.sequence = -1; this.lastFrameMs = -Infinity; this.lastTickMs = null;
    this.presence = 0; this.activity = 0; this.occupancy = null; this.volume = null; this.surface = null; this.stats = {}; this.discarded = 0;
  }

  /** Ingest a frame. Returns false when the frame was discarded. */
  ingest(frame: InputFrame): boolean {
    const s = this.settings;
    const stale = frame.receivedAtMs - frame.observedAtMs > s.maxFrameAgeMs;
    if (frame.sequence <= this.sequence || stale || !Number.isFinite(frame.observedAtMs)) { this.discarded++; return false; }
    this.sequence = frame.sequence;
    const now = frame.receivedAtMs;
    this.lastFrameMs = now;
    if (frame.stats) this.stats = { ...frame.stats };
    for (const raw of frame.hands) {
      if (raw.confidence < s.minConfidence || !isFinitePoint(raw.position)) continue;
      const o = mapObservation(this.mapping, raw);
      this.observe(o, now);
    }
    if (frame.occupancy) { this.occupancy = mapOccupancy(this.mapping, frame.occupancy, s.occupancyWidth, s.occupancyHeight); this.occupancyAtMs = now; }
    if (frame.voxels) { this.volume = mapVoxels(this.mapping, frame.voxels, s.volumeNx, s.volumeNy, s.volumeNz); this.volumeAtMs = now; }
    if (frame.surface) { this.surface = mapSurface(this.mapping, frame.surface, s.surfaceWidth, s.surfaceHeight); this.surfaceAtMs = now; }
    return true;
  }

  private observe(o: HandObservation, now: number) {
    const s = this.settings;
    let track = this.tracks.get(o.id);
    if (!track) {
      const mk = () => new OneEuro(s.minCutoff, s.beta, s.derivativeCutoff);
      track = { id: o.id, firstSeenMs: now, lastSeenMs: now, present: false, filters: [mk(), mk(), mk()], pushFilter: new OneEuro(4, .1, 1), position: { ...o.position }, velocity: { x: 0, y: 0, z: 0 }, extent: defaultExtent(o.position), openness: o.openness ?? 1, pinch: o.pinch ?? 0, confidence: o.confidence, push: o.position.z, points: o.points ?? [], capsules: o.capsules ?? [], rawPosition: { ...o.position }, lastFilterMs: now, intervalMs: 33 };
      track.filters.forEach((f, i) => f.reset([o.position.x, o.position.y, o.position.z][i]));
      track.pushFilter.reset(o.position.z);
      this.tracks.set(o.id, track);
      return;
    }
    const dt = Math.max(1e-3, (now - track.lastFilterMs) / 1000);
    track.intervalMs += .2 * ((now - track.lastSeenMs) - track.intervalMs);
    const previous = track.position;
    const position = { x: track.filters[0].filter(o.position.x, dt), y: track.filters[1].filter(o.position.y, dt), z: track.filters[2].filter(o.position.z, dt) };
    const instantaneous = { x: (position.x - previous.x) / dt, y: (position.y - previous.y) / dt, z: (position.z - previous.z) / dt };
    const k = 1 - Math.exp(-dt / s.velocityTau);
    track.velocity = { x: track.velocity.x + k * (instantaneous.x - track.velocity.x), y: track.velocity.y + k * (instantaneous.y - track.velocity.y), z: track.velocity.z + k * (instantaneous.z - track.velocity.z) };
    track.position = position;
    track.push = track.pushFilter.filter(o.position.z, dt);
    track.extent = o.extent ?? defaultExtent(position);
    track.openness = o.openness ?? track.openness;
    track.pinch = o.pinch ?? track.pinch;
    track.confidence = o.confidence;
    track.points = o.points ?? track.points;
    track.capsules = o.capsules ?? track.capsules; track.rawPosition = o.position;
    track.lastSeenMs = now; track.lastFilterMs = now;
  }

  /** Advance presence state to `now` and produce the current conditioned input. */
  tick(now: number): TrackedInput {
    const s = this.settings;
    const dt = this.lastTickMs === null ? 0 : Math.max(0, Math.min(.25, (now - this.lastTickMs) / 1000));
    this.lastTickMs = now;
    const hands: HandState[] = [];
    let maxSpeed = 0;
    for (const [id, t] of this.tracks) {
      const sinceSeen = now - t.lastSeenMs;
      if (sinceSeen > s.leaveMs) { this.tracks.delete(id); continue; }
      // An unconfirmed track (seen once) gets no leave grace: a single noise blob must not become a hand.
      if (!t.present && sinceSeen > Math.max(2 * s.enterMs, 3 * t.intervalMs)) { this.tracks.delete(id); continue; }
      if (!t.present && now - t.firstSeenMs >= s.enterMs && t.lastSeenMs > t.firstSeenMs) t.present = true;
      if (!t.present) continue;
      // Decay velocity only when the hand is overdue relative to its own observation rate, so a
      // 30 Hz source sampled by a 60 Hz display keeps its true speed while a real dropout coasts to rest.
      const overdueMs = sinceSeen - 1.5 * t.intervalMs;
      if (overdueMs > 0 && dt > 0) {
        const k = 1 - Math.exp(-dt / s.velocityTau);
        t.velocity = { x: t.velocity.x * (1 - k), y: t.velocity.y * (1 - k), z: t.velocity.z * (1 - k) };
      }
      const speed = Math.hypot(t.velocity.x, t.velocity.y);
      maxSpeed = Math.max(maxSpeed, speed);
      const ex = t.extent.max.x - t.extent.min.x, ey = t.extent.max.y - t.extent.min.y;
      // The solid shape rides on the smoothed position: shift every raw capsule by (smoothed − raw).
      const dx = t.position.x - t.rawPosition.x, dy = t.position.y - t.rawPosition.y, dz = t.position.z - t.rawPosition.z;
      const capsules = t.capsules.length ? t.capsules.map(c => ({ a: { x: c.a.x + dx, y: c.a.y + dy, z: c.a.z + dz }, b: { x: c.b.x + dx, y: c.b.y + dy, z: c.b.z + dz }, radius: c.radius })) : [];
      hands.push({ id, position: t.position, velocity: t.velocity, speed, extent: t.extent, radius: Math.max(.02, Math.max(ex, ey) / 2), openness: t.openness, pinch: t.pinch, confidence: t.confidence, ageMs: now - t.firstSeenMs, staleMs: sinceSeen, push: t.push, points: t.points, capsules });
    }
    hands.sort((a, b) => b.ageMs - a.ageMs || a.id - b.id);
    const target = hands.length ? 1 : 0;
    this.presence += (target - this.presence) * (dt > 0 ? 1 - Math.exp(-dt / (target > this.presence ? s.presenceRiseTau : s.presenceFallTau)) : 0);
    const activityTarget = Math.min(1, maxSpeed / s.activityFullSpeed);
    this.activity += (activityTarget - this.activity) * (dt > 0 ? 1 - Math.exp(-dt / s.activityTau) : 0);
    if (this.occupancy && now - this.occupancyAtMs > s.leaveMs * 2) this.occupancy = null;
    if (this.volume && now - this.volumeAtMs > s.leaveMs * 2) this.volume = null;
    if (this.surface && now - this.surfaceAtMs > s.leaveMs * 2) this.surface = null;
    return { hands, presence: this.presence, activity: this.activity, occupancy: this.occupancy, volume: this.volume, surface: this.surface, sourceAgeMs: now - this.lastFrameMs, discarded: this.discarded, stats: this.stats };
  }
}

function isFinitePoint(p: Vec3) { return Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z); }
function defaultExtent(p: Vec3): Box3 { return { min: { x: p.x - .04, y: p.y - .06, z: p.z }, max: { x: p.x + .04, y: p.y + .06, z: p.z } }; }
