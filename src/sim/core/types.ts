/**
 * Core contracts for the installation simulation scaffold.
 *
 * A simulation is a pure consumer of `SimInput` (conditioned hand data in a
 * canonical "sim space") and a producer of rendered frames plus named numeric
 * `signals` that the audio side reads. Everything a simulation exposes to the
 * outside world is declared statically in its `SimulationDefinition`, so the
 * host can build UI, validate values, and publish a machine-readable schema
 * without knowing anything about the simulation internals.
 *
 * Sim space is a VOLUME, and hands live in it:
 *   x in [0, 1]  left → right as seen by the viewer, spanning the full canvas width
 *   y in [0, 1]  bottom → top, spanning the full canvas height
 *   z in [0, 1]  depth INTO the scene: 0 = at the glass (nearest the viewer), 1 = the back wall
 *
 * In uniform units (canvas height = 1) the volume is `[0, aspect] × [0, 1] × [0, depth]`
 * (`toUniform3` in math.ts); `depth` comes from the host settings. The display is the
 * front face, a window into the volume: `windowCamera` in camera.ts is the shared
 * perspective camera whose frustum passes exactly through that face, so a point at
 * z = 0 lands where a 2D drawing would and deeper points shrink toward the centre.
 * A simulation may use any camera it likes (top-down for a bowl on a table, say);
 * the hand's x, y, z are world coordinates either way.
 */
import type { HandState } from '../input/types';
import type { GestureEvent } from '../input/gestures';

export interface Vec2 { x: number; y: number }
export interface Vec3 { x: number; y: number; z: number }

// ---------------------------------------------------------------------------
// Parameters: values the installation author or the audio side may set.
// ---------------------------------------------------------------------------

interface ParamBase { label?: string; description?: string }
export interface NumberParam extends ParamBase { kind: 'number'; default: number; min: number; max: number; step?: number; unit?: string }
export interface BooleanParam extends ParamBase { kind: 'boolean'; default: boolean }
export interface SelectParam extends ParamBase { kind: 'select'; default: string; options: readonly string[] }
export interface ColorParam extends ParamBase { kind: 'color'; default: string }
export type ParamSpec = NumberParam | BooleanParam | SelectParam | ColorParam;
export type ParamSpecs = Record<string, ParamSpec>;

export type ParamValue<S extends ParamSpec> = S extends NumberParam ? number : S extends BooleanParam ? boolean : string;
export type ParamValues<P extends ParamSpecs> = { [K in keyof P]: ParamValue<P[K]> };
export type AnyParamValue = number | boolean | string;

// ---------------------------------------------------------------------------
// Signals: numeric outputs the simulation promises to publish every frame.
// ---------------------------------------------------------------------------

export interface SignalSpec {
  /** Inclusive range the value stays within. The host clamps and warns in dev when exceeded. */
  min: number;
  max: number;
  unit?: string;
  description: string;
  /** Suggested smoothing time for consumers, in seconds. Purely advisory. */
  smoothing?: number;
}
export type SignalSpecs = Record<string, SignalSpec>;
export type SignalValues<S extends SignalSpecs> = { [K in keyof S]: number };

// ---------------------------------------------------------------------------
// Per-step input.
// ---------------------------------------------------------------------------

export interface OccupancyField {
  /** Grid columns (x) and rows (y). Row 0 is the BOTTOM of sim space, matching y. */
  width: number;
  height: number;
  /** Row-major, 0..255 = how much of the cell is filled by tracked matter. */
  data: Uint8Array;
}

export interface SimInput {
  /** Seconds since the simulation instance was created. */
  time: number;
  /** Fixed step length in seconds. */
  dt: number;
  /** Hands that are currently present, conditioned and in sim space. */
  hands: readonly HandState[];
  /** The oldest present hand, or null. Most simulations only need this. */
  primary: HandState | null;
  /** Gesture events that occurred since the previous step. */
  events: readonly GestureEvent[];
  /** 0..1 smoothed "anything is here" value. Rises quickly on entry, falls slowly. */
  presence: number;
  /** 0..1 smoothed motion energy across all hands. */
  activity: number;
  /** Optional occupancy of the tracked volume, in sim space. Present when the source provides it. */
  occupancy: OccupancyField | null;
}

// ---------------------------------------------------------------------------
// Runtime context and lifecycle.
// ---------------------------------------------------------------------------

export type Quality = 'low' | 'medium' | 'high';

export interface GlCapabilities {
  /** RGBA16F render targets are available (EXT_color_buffer_float or half-float variant). */
  halfFloatColor: boolean;
  /** RGBA32F render targets are available. */
  floatColor: boolean;
  /** Float textures can use LINEAR filtering. */
  linearFloat: boolean;
  maxTextureSize: number;
}

export interface SimContext {
  gl: WebGL2RenderingContext;
  canvas: HTMLCanvasElement;
  /** Drawing-buffer size in device pixels. The host updates these fields in place before calling `resize`. */
  width: number;
  height: number;
  /** width / height. Kept current like width/height. */
  aspect: number;
  /** Depth of the volume in uniform units (canvas height = 1). Constant for the life of the instance. */
  depth: number;
  dpr: number;
  quality: Quality;
  capabilities: GlCapabilities;
  /** Report a non-fatal problem to the host (shown in the overlay, sent to telemetry). */
  warn(message: string): void;
}

export interface RenderFrame {
  /** Seconds since the instance was created, at render time. */
  time: number;
  /** Fraction of a fixed step elapsed since the last `step`, for interpolation. */
  alpha: number;
  width: number;
  height: number;
  aspect: number;
  /** Volume depth in uniform units, same as `SimContext.depth`. */
  depth: number;
}

export interface SimulationInstance<P extends ParamSpecs = ParamSpecs, S extends SignalSpecs = SignalSpecs> {
  /** Advance the physics by one fixed step. Called 0..N times per frame. */
  step(input: SimInput, params: ParamValues<P>): void;
  /** Draw the current state to the default framebuffer. Called once per frame. */
  render(frame: RenderFrame, params: ParamValues<P>): void;
  /** Current values of every declared signal. Must be cheap: called once per frame. */
  signals(): SignalValues<S>;
  /** Drawing buffer size changed. The context's width/height/aspect are already updated. */
  resize?(width: number, height: number): void;
  /** A parameter changed. Use for expensive re-initialisation only; ordinary params are read on each step. */
  paramChanged?(name: keyof P & string, value: AnyParamValue): void;
  /** Release GPU resources. The instance is never used again. */
  dispose(): void;
}

export interface SimulationDefinition<P extends ParamSpecs = ParamSpecs, S extends SignalSpecs = SignalSpecs> {
  /** URL-safe identifier, unique across the registry. */
  id: string;
  title: string;
  description: string;
  params: P;
  signals: S;
  /** Physics rate. Defaults to 60. */
  stepHz?: number;
  /** Build GPU resources. `params` holds the resolved initial values (defaults merged with saved overrides). */
  create(context: SimContext, params: ParamValues<P>): SimulationInstance<P, S>;
}

/** Identity helper that preserves the literal param/signal types for inference. */
export function defineSimulation<P extends ParamSpecs, S extends SignalSpecs>(definition: SimulationDefinition<P, S>): SimulationDefinition<P, S> {
  return definition;
}
