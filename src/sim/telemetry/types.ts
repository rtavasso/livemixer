/**
 * Telemetry contract: what leaves the simulation page for the audio system
 * (or any other consumer), and what may come back in.
 *
 * Two outbound message kinds matter:
 *  - `schema`: sent on connect and whenever the active simulation changes.
 *    Describes every parameter and signal with ranges, so a consumer can
 *    build its own mapping UI without hard-coding simulation names.
 *  - `frame`: sent at a fixed rate with the current parameter values, signal
 *    values, conditioned hand data, gesture events since the last frame, and
 *    raw source statistics.
 *
 * Inbound messages let a consumer drive the page (set a parameter, switch
 * simulation, request the schema).
 */
import { z } from 'zod';
import type { GestureEvent } from '../input/gestures';
import type { SourceId } from '../input/types';
import type { AnyParamValue, ParamSpec, SignalSpec } from '../core/types';

export const TELEMETRY_VERSION = 1 as const;
export const BROADCAST_CHANNEL_NAME = 'livemixer-sim';

export interface HandTelemetry {
  id: number;
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  speed: number; radius: number; openness: number; pinch: number; push: number;
  ageMs: number; staleMs: number;
  /** Number of capsules in the hand's solid shape (0 = position and radius only). */
  solid: number;
}

export interface TelemetryFrame {
  type: 'frame';
  v: typeof TELEMETRY_VERSION;
  /** Seconds since the page session started. */
  t: number;
  seq: number;
  sim: { id: string; params: Record<string, AnyParamValue>; signals: Record<string, number> };
  input: {
    source: SourceId;
    presence: number;
    activity: number;
    hands: HandTelemetry[];
    events: GestureEvent[];
    /** Milliseconds since the source last delivered a frame. */
    sourceAgeMs: number;
    stats: Record<string, number>;
    /** Present only when occupancy publishing is enabled. Row 0 = bottom. */
    occupancy?: { width: number; height: number; data: string };
  };
  perf: { fps: number; stepMs: number; renderMs: number };
}

export interface TelemetrySchema {
  type: 'schema';
  v: typeof TELEMETRY_VERSION;
  sim: { id: string; title: string; description: string; params: Record<string, ParamSpec>; signals: Record<string, SignalSpec> };
  sims: { id: string; title: string }[];
  input: { hand: (keyof HandTelemetry)[]; gestures: readonly string[]; sources: readonly SourceId[] };
}

export interface TelemetryStatus { type: 'status'; v: typeof TELEMETRY_VERSION; level: 'info' | 'warning' | 'error'; message: string }

export type TelemetryOutbound = TelemetryFrame | TelemetrySchema | TelemetryStatus;

export const inboundSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('set-param'), name: z.string().min(1), value: z.union([z.number(), z.boolean(), z.string()]) }).strict(),
  z.object({ type: z.literal('set-params'), values: z.record(z.string(), z.union([z.number(), z.boolean(), z.string()])) }).strict(),
  z.object({ type: z.literal('select-sim'), id: z.string().min(1) }).strict(),
  z.object({ type: z.literal('get-schema') }).strict(),
  z.object({ type: z.literal('ping'), id: z.union([z.number(), z.string()]).optional() }).strict(),
]);
export type TelemetryInbound = z.infer<typeof inboundSchema>;

export function parseInbound(raw: unknown): TelemetryInbound | null {
  const value = typeof raw === 'string' ? safeJson(raw) : raw;
  const result = inboundSchema.safeParse(value);
  return result.success ? result.data : null;
}
function safeJson(text: string): unknown { try { return JSON.parse(text); } catch { return null; } }
