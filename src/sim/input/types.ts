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

export type SourceId = 'pointer' | 'synthetic' | 'webcam' | 'leap' | 'depth' | 'replay';
export const SOURCE_IDS: readonly SourceId[] = ['pointer', 'synthetic', 'webcam', 'leap', 'depth', 'replay'];

export interface Box3 { min: Vec3; max: Vec3 }

/**
 * A solid segment: the volume within `radius` of the line a–b. Hands are built
 * from these (finger bones, metacarpals, forearm) so simulations can collide
 * with, occlude with, and draw a real 3D body rather than a point. Endpoints
 * are in the same frame as the hand's `position`; `radius` follows the x axis
 * of that frame (like `HandState.radius`).
 */
export interface Capsule { a: Vec3; b: Vec3; radius: number }

/**
 * Foreground occupancy of the tracked volume as voxels, from a depth camera
 * bridge (everything within the depth range is "foreground"). Row-major with
 * x fastest, then y, then z; in the source frame z index 0 is the NEAREST
 * plane to the camera. Values 0..255 = fraction of the voxel filled.
 */
export interface VoxelGrid { nx: number; ny: number; nz: number; data: Uint8Array }

/**
 * The foreground as a depth SURFACE from a depth camera: the 3D scan of whatever is inside
 * the box's depth range (background filtered out), seen from the camera. Row-major, row 0 =
 * TOP (image order), u across. A byte is 0 where no foreground was seen, otherwise
 * 1 + round(254 · w) with w the nearest foreground depth in the cell (0 = near plane,
 * 1 = far plane). This is the representation to use when a real depth map is available.
 */
export interface DepthSurface { width: number; height: number; data: Uint8Array }

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
  /** Optional solid shape of the hand (skeleton sources). Omit when only a position is known. */
  capsules?: Capsule[];
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
  /** Optional 3D foreground occupancy from a depth camera bridge. */
  voxels?: VoxelGrid;
  /** Optional foreground depth surface (the scan) from a depth camera bridge. */
  surface?: DepthSurface;
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
  /**
   * The hand as a solid, in sim space: finger bones, metacarpals and forearm for skeleton
   * sources; empty for sources that only know a position (use `position` + `radius` then).
   * Moves with the smoothed `position` so it never jitters against it.
   */
  capsules: Capsule[];
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
