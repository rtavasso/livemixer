/**
 * Wire protocol between a native depth-camera bridge process and the browser.
 *
 * The bridge watches a physical bounding box in front of the camera, finds
 * matter inside it (a hand, an arm, a whole person), and streams compact JSON
 * text frames over a WebSocket. Everything is normalized to the box, so the
 * browser never needs camera intrinsics: `pos` is [u, v, w] in [0, 1] where
 * u/v follow the camera image (right, down) and w is depth INTO the box
 * (0 = nearest plane, 1 = farthest plane).
 *
 * Conventions the schema cannot express:
 *  - Every `pos`, `extent` and `points` coordinate is expected in [0, 1]; the
 *    bridge clamps, and the browser's axis mapping clamps again, so a small
 *    overshoot is harmless rather than fatal.
 *  - The occupancy grid spans the SAME box as `pos` (the bridge's region of
 *    interest and depth range), not the whole camera image, so the browser
 *    can invert one set of axis maps for both.
 *  - `seq` only has to increase; a single global counter shared by all
 *    clients is fine. The client resets its expectation on every connection.
 *  - `hello.box` is informational: `z` is `[near, far]` in metres, `x`/`y`
 *    the metric extents of the region at the near plane if known.
 *  - Bridges in Python must serialise with `allow_nan=False`; a NaN in
 *    `stats` is invalid JSON and the whole frame would be dropped.
 *
 * See bridge/README.md for the reference implementation and docs/SIMULATIONS.md
 * for the full description. The schema here is the single source of truth and
 * the Python bridge has a fixture test against the same sample messages.
 */
import { z } from 'zod';
import type { HandObservation, InputFrame, OccupancyGrid } from './types';

export const PROTOCOL_VERSION = 1;

const unit = z.number().finite();
const vec = z.tuple([unit, unit, unit]);

export const bridgeHelloSchema = z.object({
  type: z.literal('hello'),
  version: z.literal(PROTOCOL_VERSION),
  /** Bridge implementation name, e.g. "realsense", "kinect", "synthetic". */
  source: z.string().min(1),
  /** The physical box in camera metres: [min, max] per axis. Informational. */
  box: z.object({ x: z.tuple([unit, unit]), y: z.tuple([unit, unit]), z: z.tuple([unit, unit]) }),
  /** Nominal capture rate. */
  fps: z.number().positive().optional(),
  /** Occupancy grid size when the bridge sends one. */
  occupancy: z.object({ width: z.number().int().min(1).max(256), height: z.number().int().min(1).max(256) }).optional(),
}).strict();

export const bridgeHandSchema = z.object({
  id: z.number().int().nonnegative(),
  pos: vec,
  conf: unit.min(0).max(1).default(1),
  /** [[minU, minV, minW], [maxU, maxV, maxW]] */
  extent: z.tuple([vec, vec]).optional(),
  /** Bridges that fit a hand model can send these; blob trackers omit them. */
  openness: unit.min(0).max(1).optional(),
  pinch: unit.min(0).max(1).optional(),
  /** Optional sample points on the blob surface, same normalization as pos. */
  points: z.array(vec).max(256).optional(),
}).strict();

export const bridgeFrameSchema = z.object({
  type: z.literal('frame'),
  /** Strictly increasing; a global counter is fine (see the conventions above). */
  seq: z.number().int().nonnegative(),
  /** Bridge monotonic clock in seconds. Any origin; the client estimates the offset. */
  t: unit,
  hands: z.array(bridgeHandSchema).max(16),
  /** Base64 of width*height bytes, row-major over the box (not the whole image), row 0 = top. */
  occupancy: z.string().optional(),
  stats: z.record(z.string(), unit).optional(),
}).strict();

export const bridgeStatusSchema = z.object({ type: z.literal('status'), level: z.enum(['info', 'warning', 'error']).default('info'), message: z.string() }).strict();

export const bridgeMessageSchema = z.discriminatedUnion('type', [bridgeHelloSchema, bridgeFrameSchema, bridgeStatusSchema]);
export type BridgeHello = z.infer<typeof bridgeHelloSchema>;
export type BridgeFrame = z.infer<typeof bridgeFrameSchema>;
export type BridgeHand = z.infer<typeof bridgeHandSchema>;
export type BridgeMessage = z.infer<typeof bridgeMessageSchema>;

export function parseBridgeMessage(text: string): BridgeMessage {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { throw new Error('Bridge sent invalid JSON.'); }
  const result = bridgeMessageSchema.safeParse(raw);
  if (!result.success) throw new Error(`Bridge message rejected: ${result.error.issues.map(i => `${i.path.join('.') || 'message'}: ${i.message}`).join('; ')}`);
  return result.data;
}

export function decodeOccupancy(base64: string, width: number, height: number): OccupancyGrid {
  const binary = atob(base64);
  if (binary.length !== width * height) throw new Error(`Occupancy payload has ${binary.length} bytes; expected ${width * height}.`);
  const data = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) data[i] = binary.charCodeAt(i);
  return { width, height, data };
}

export function encodeOccupancy(grid: OccupancyGrid): string {
  let s = '';
  for (let i = 0; i < grid.data.length; i++) s += String.fromCharCode(grid.data[i]);
  return btoa(s);
}

const v3 = (t: [number, number, number]) => ({ x: t[0], y: t[1], z: t[2] });

/** Convert a validated bridge frame into the generic input contract. */
export function bridgeFrameToInput(frame: BridgeFrame, observedAtMs: number, receivedAtMs: number, hello: BridgeHello | null): InputFrame {
  const hands: HandObservation[] = frame.hands.map(h => ({
    id: h.id, position: v3(h.pos), confidence: h.conf,
    extent: h.extent ? { min: v3(h.extent[0]), max: v3(h.extent[1]) } : undefined,
    openness: h.openness, pinch: h.pinch, points: h.points?.map(v3),
  }));
  const occupancy = frame.occupancy && hello?.occupancy ? decodeOccupancy(frame.occupancy, hello.occupancy.width, hello.occupancy.height) : undefined;
  return { source: 'depth', sequence: frame.seq, observedAtMs, receivedAtMs, hands, occupancy, stats: frame.stats };
}

/**
 * Estimates the constant offset between the bridge clock and the page clock
 * with a sliding minimum of (received - sent). The minimum over a window
 * approximates the fixed transport delay; jitter above it is treated as lateness.
 */
export class ClockMapper {
  private samples: { offset: number; atMs: number }[] = [];
  constructor(private readonly windowMs = 5000) {}
  observe(bridgeSeconds: number, receivedAtMs: number): number {
    const offset = receivedAtMs - bridgeSeconds * 1000;
    this.samples.push({ offset, atMs: receivedAtMs });
    while (this.samples.length && receivedAtMs - this.samples[0].atMs > this.windowMs) this.samples.shift();
    let min = Infinity;
    for (const s of this.samples) min = Math.min(min, s.offset);
    return bridgeSeconds * 1000 + min;
  }
  reset() { this.samples = []; }
}
