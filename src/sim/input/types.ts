/**
 * Input contracts.
 *
 * Sources (pointer, webcam, depth bridge, replay, synthetic) emit `InputFrame`s
 * containing raw `HandObservation`s in the SOURCE's own normalized frame:
 * every axis in [0, 1], with whatever orientation is natural for that source
 * (image x rightwards, image y downwards for cameras; a metric bounding box
 * for the depth bridge). A `SpaceMapping` converts the source frame into sim
 * space, and the `HandTracker` conditions the result into stable `HandState`s.
 */
import type { Vec3 } from '../core/types';

export type SourceId = 'pointer' | 'synthetic' | 'webcam' | 'depth' | 'replay';
export const SOURCE_IDS: readonly SourceId[] = ['pointer', 'synthetic', 'webcam', 'depth', 'replay'];

export interface Box3 { min: Vec3; max: Vec3 }

/** One tracked hand (or any tracked blob) in the source frame. */
export interface HandObservation {
  /** Stable while the source keeps tracking the same hand. */
  id: number;
  /** Source frame, each axis in [0, 1]. Sources without depth report z = 0.5. */
  position: Vec3;
  /** 0..1. Below the tracker's threshold the observation is ignored. */
  confidence: number;
  /** Bounding box of the hand/blob in the source frame. */
  extent?: Box3;
  /** 0 = fist, 1 = fully open. Only landmark sources know this. */
  openness?: number;
  /** 0 = apart, 1 = thumb and index touching. Only landmark sources know this. */
  pinch?: number;
  /** Optional point set (landmarks, contour samples) in the source frame. */
  points?: Vec3[];
}

/** Optional occupancy grid in the source frame. Row 0 is the TOP row (image order); column 0 is the left. */
export interface OccupancyGrid { width: number; height: number; data: Uint8Array }

export interface InputFrame {
  source: SourceId;
  sequence: number;
  /** Producer timestamp in the `performance.now()` domain of this page. */
  observedAtMs: number;
  receivedAtMs: number;
  hands: HandObservation[];
  occupancy?: OccupancyGrid;
  /** Free-form source telemetry (fps, blob pixel counts, bridge latency). Forwarded to the audio side. */
  stats?: Record<string, number>;
}

/** A conditioned hand in sim space. */
export interface HandState {
  id: number;
  /** Sim space, smoothed. */
  position: Vec3;
  /** Sim units per second, smoothed. */
  velocity: Vec3;
  /** |velocity| in the x/y plane, sim units per second. */
  speed: number;
  /** Sim-space bounding box. Falls back to a small box around the position. */
  extent: Box3;
  /**
   * Approximate hand size: half of the larger extent (x extent in sim-x units, y extent in sim-y
   * units, whichever is bigger). Good enough for a brush or a soft collider; for a precise shape
   * use `extent`. `uniformRadius(radius, aspect)` treats it as an x-axis measure.
   */
  radius: number;
  openness: number;
  pinch: number;
  confidence: number;
  /** Milliseconds since this hand first became present. */
  ageMs: number;
  /** Milliseconds since the last fresh observation. */
  staleMs: number;
  /** Depth "push" amount: z position smoothed with a faster filter, for tap-like responses. */
  push: number;
  points: Vec3[];
}

export interface InputSourceStatus {
  state: 'idle' | 'starting' | 'running' | 'error';
  message: string;
}

/** Every source implements this. The host owns exactly one active source at a time. */
export interface InputSource {
  readonly id: SourceId;
  /** Human-readable orientation of the source frame, shown in the mapping UI. */
  readonly frameDescription: string;
  start(): Promise<void>;
  stop(): void;
  status(): InputSourceStatus;
  /** Optional per-animation-frame hook for sources that sample rather than push (pointer, synthetic). */
  sample?(nowMs: number): void;
}
