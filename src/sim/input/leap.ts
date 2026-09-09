/**
 * Leap Motion Controller through the local Leap Motion / Ultraleap service's
 * JSON WebSocket API (`ws://127.0.0.1:6437/v6.json`). No native code, no
 * bridge process: the service must merely have "Allow Web Apps"
 * (`websockets_enabled`) switched on. Available in V2, Orion 4 and the
 * Gemini 5.0 preview; later Gemini/Hyperion releases dropped this API, for
 * those use `bridge/` with Ultraleap's Python bindings instead.
 *
 * Device coordinates are millimetres with the origin at the device centre:
 * x to the performer's right, y up, z toward the performer (the device lies
 * on the desk with its green light facing the performer). A physical box in
 * those units becomes the source frame: u right, v up, w toward the performer.
 * Use LEAP_MAPPING (which turns "toward the display" into a push).
 */
import { z } from 'zod';
import { ClockMapper } from './protocol';
import type { Capsule, HandObservation, InputFrame, InputSource, InputSourceStatus } from './types';
import type { Vec3 } from '../core/types';

const mm = z.number().finite();
const range = z.tuple([mm, mm]).refine(([a, b]) => b - a >= 20, { message: 'A box side needs at least 20 mm.' });
export const leapBoxSchema = z.object({ x: range, y: range, z: range }).strict();
export type LeapBox = z.infer<typeof leapBoxSchema>;
/**
 * A comfortable reach above the device, measured with a real hand: people hold a hand 15–45 cm
 * up without thinking about it. The proportions (600 × 340 × 240 mm ≈ 1.76 : 1 : 0.7) match a
 * 16:9 volume of depth 0.7, so a solid hand keeps its shape; set *Volume depth* to the box's
 * z/y ratio for other boxes. Calibration in the overlay refines the box per installation.
 */
export const DEFAULT_LEAP_BOX: LeapBox = { x: [-300, 300], y: [100, 440], z: [-120, 120] };

const vec = z.tuple([mm, mm, mm]);
const handSchema = z.object({
  id: z.number().int(),
  type: z.string().optional(),
  palmPosition: vec,
  stabilizedPalmPosition: vec.optional(),
  palmVelocity: vec.optional(),
  palmWidth: mm.positive().optional(),
  wrist: vec.optional(),
  elbow: vec.optional(),
  armWidth: mm.positive().optional(),
  grabStrength: z.number().min(0).max(1).optional(),
  pinchStrength: z.number().min(0).max(1).optional(),
  confidence: z.number().min(0).max(1).optional(),
  timeVisible: z.number().optional(),
}).passthrough();
const pointableSchema = z.object({
  id: z.number().int(),
  handId: z.number().int(),
  type: z.number().int().min(0).max(4).optional(),
  tipPosition: vec,
  stabilizedTipPosition: vec.optional(),
  /** Joints from the wrist outward: carpal (metacarpal base), knuckle, two inter-phalangeal joints, bone tip. */
  carpPosition: vec.optional(),
  mcpPosition: vec.optional(),
  pipPosition: vec.optional(),
  dipPosition: vec.optional(),
  btipPosition: vec.optional(),
  width: mm.positive().optional(),
  extended: z.boolean().optional(),
  tool: z.boolean().optional(),
}).passthrough();
export const leapFrameSchema = z.object({
  id: z.number().int(),
  timestamp: z.number().finite(),
  currentFrameRate: z.number().optional(),
  hands: z.array(handSchema).default([]),
  pointables: z.array(pointableSchema).default([]),
  interactionBox: z.object({ center: vec, size: vec }).optional(),
}).passthrough();
export type LeapFrame = z.infer<typeof leapFrameSchema>;

/** Parse one message. Returns null for greetings, device events, and anything that is not a tracking frame. */
export function parseLeapMessage(text: string): LeapFrame | null {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return null; }
  if (!raw || typeof raw !== 'object' || !('hands' in raw) || !('timestamp' in raw)) return null;
  const result = leapFrameSchema.safeParse(raw);
  return result.success ? result.data : null;
}

const norm = (value: number, [low, high]: [number, number]) => Math.min(1, Math.max(0, (value - low) / (high - low)));
/** Unclamped normalisation for skeleton joints, so a forearm leaving the box keeps its direction. */
const normOpen = (value: number, [low, high]: [number, number]) => (value - low) / (high - low);
const toSource = (p: [number, number, number], box: LeapBox): Vec3 => ({ x: norm(p[0], box.x), y: norm(p[1], box.y), z: norm(p[2], box.z) });
const toSourceOpen = (p: [number, number, number], box: LeapBox): Vec3 => ({ x: normOpen(p[0], box.x), y: normOpen(p[1], box.y), z: normOpen(p[2], box.z) });
const mmToSourceX = (mmValue: number, box: LeapBox) => mmValue / (box.x[1] - box.x[0]);

/**
 * Forearm capsules are cut off this far (mm) past the wrist. Reaching in, the forearm is the part
 * nearest the window camera, so a long one dwarfs the hand; a short stub keeps the wrist solid.
 */
const FOREARM_MM = 70;

/**
 * Build the solid hand: three phalanx capsules per finger (two for the thumb, whose
 * metacarpal Leap reports as zero length), one metacarpal capsule per finger from the
 * carpal base to the knuckle (five of them make the palm), and a forearm capsule from
 * the wrist toward the elbow. Radii are half the reported widths.
 */
export function leapHandCapsules(hand: LeapFrame['hands'][number], fingers: LeapFrame['pointables'], box: LeapBox): Capsule[] {
  const out: Capsule[] = [];
  const seg = (a: [number, number, number], b: [number, number, number], widthMm: number) => {
    const dx = a[0] - b[0], dy = a[1] - b[1], dz = a[2] - b[2];
    if (dx * dx + dy * dy + dz * dz < 1) return; // zero-length bone (thumb metacarpal)
    out.push({ a: toSourceOpen(a, box), b: toSourceOpen(b, box), radius: mmToSourceX(widthMm / 2, box) });
  };
  for (const f of fingers) {
    const width = f.width ?? 16;
    if (f.carpPosition && f.mcpPosition) seg(f.carpPosition, f.mcpPosition, width * 1.15);
    if (f.mcpPosition && f.pipPosition) seg(f.mcpPosition, f.pipPosition, width);
    if (f.pipPosition && f.dipPosition) seg(f.pipPosition, f.dipPosition, width * .9);
    if (f.dipPosition && (f.btipPosition ?? f.tipPosition)) seg(f.dipPosition, f.btipPosition ?? f.tipPosition, width * .8);
  }
  if (hand.wrist && hand.elbow) {
    const d = [hand.elbow[0] - hand.wrist[0], hand.elbow[1] - hand.wrist[1], hand.elbow[2] - hand.wrist[2]];
    const len = Math.sqrt(d[0] * d[0] + d[1] * d[1] + d[2] * d[2]) || 1, cut = Math.min(len, FOREARM_MM) / len;
    seg(hand.wrist, [hand.wrist[0] + d[0] * cut, hand.wrist[1] + d[1] * cut, hand.wrist[2] + d[2] * cut], (hand.armWidth ?? 55) * .85);
  }
  return out;
}

/** Reduce a Leap frame to hand observations in the box-normalized source frame. */
export function leapFrameToHands(frame: LeapFrame, box: LeapBox): HandObservation[] {
  return frame.hands.map(hand => {
    const palm = toSource(hand.stabilizedPalmPosition ?? hand.palmPosition, box);
    const fingers = frame.pointables.filter(p => p.handId === hand.id && !p.tool).sort((a, b) => (a.type ?? 0) - (b.type ?? 0));
    const tips = fingers.map(f => toSource(f.stabilizedTipPosition ?? f.tipPosition, box));
    const all = [palm, ...tips];
    const min = { x: Math.min(...all.map(p => p.x)), y: Math.min(...all.map(p => p.y)), z: Math.min(...all.map(p => p.z)) };
    const max = { x: Math.max(...all.map(p => p.x)), y: Math.max(...all.map(p => p.y)), z: Math.max(...all.map(p => p.z)) };
    const capsules = leapHandCapsules(hand, fingers, box);
    // Leap's `confidence` rates the pose fit, not whether a hand exists: the service only lists hands it is
    // tracking, and some builds report 0 for it. Never let it fall under the tracker's acceptance threshold.
    return { id: hand.id, position: palm, confidence: Math.max(.5, hand.confidence ?? 1), openness: 1 - (hand.grabStrength ?? 0), pinch: hand.pinchStrength ?? 0, extent: { min, max }, points: [...tips, palm], capsules: capsules.length ? capsules : undefined };
  });
}

export class LeapSource implements InputSource {
  readonly id = 'leap' as const;
  readonly frameDescription = 'Leap box: x → your right, y → up, z → toward you (mm ranges in settings)';
  private socket?: WebSocket; private running = false; private generation = 0; private retryMs = 500; private timer?: ReturnType<typeof setTimeout>;
  private readonly clock = new ClockMapper();
  private state: InputSourceStatus = { state: 'idle', message: 'Leap Motion disconnected.' };
  private sequence = 0; private lastFrameId = -1;
  /** Frames received on the current connection. */
  received = 0;
  /** Latest raw palm position of the first hand, mm, for setting up the box. */
  palmMm: [number, number, number] | null = null;

  constructor(public url: string, public box: LeapBox, private readonly emit: (frame: InputFrame) => void, private readonly now: () => number = () => performance.now()) {}

  status() { return this.state; }

  async start() { this.stop(); this.running = true; this.retryMs = 500; this.connect(this.generation); }

  private connect(generation: number) {
    if (!this.running || generation !== this.generation) return;
    this.state = { state: 'starting', message: `Connecting to the Leap service at ${this.url}…` };
    let socket: WebSocket;
    try { socket = new WebSocket(this.url); } catch (error) { this.state = { state: 'error', message: `Invalid Leap URL: ${String(error)}` }; return; }
    this.socket = socket;
    socket.onopen = () => {
      if (generation !== this.generation) return;
      this.retryMs = 500; this.received = 0; this.lastFrameId = -1; this.clock.reset();
      // Keep frames coming when the browser is not the focused window: an installation runs unattended.
      socket.send(JSON.stringify({ background: true })); socket.send(JSON.stringify({ focused: true })); socket.send(JSON.stringify({ enableGestures: false }));
      this.state = { state: 'running', message: 'Connected to the Leap service. Hold a hand above the device.' };
    };
    socket.onmessage = event => {
      if (generation !== this.generation || typeof event.data !== 'string') return;
      const receivedAtMs = this.now();
      const frame = parseLeapMessage(event.data);
      if (!frame) return;
      if (frame.id <= this.lastFrameId) return;
      this.lastFrameId = frame.id; this.received++;
      let observedAtMs = Math.min(this.clock.observe(frame.timestamp / 1e6, receivedAtMs), receivedAtMs);
      // A service clock that stalls or runs slow would make frames look ever later; re-base rather than drop them.
      if (receivedAtMs - observedAtMs > 200) { this.clock.reset(); observedAtMs = Math.min(this.clock.observe(frame.timestamp / 1e6, receivedAtMs), receivedAtMs); }
      const hands = leapFrameToHands(frame, this.box);
      const first = frame.hands[0];
      this.palmMm = first ? [first.palmPosition[0], first.palmPosition[1], first.palmPosition[2]] : null;
      const stats: Record<string, number> = { leapFps: frame.currentFrameRate ?? 0, leapHands: frame.hands.length };
      if (first) { stats.palmX = Math.round(first.palmPosition[0]); stats.palmY = Math.round(first.palmPosition[1]); stats.palmZ = Math.round(first.palmPosition[2]); stats.leapConfidence = first.confidence ?? -1; stats.grab = first.grabStrength ?? -1; }
      this.emit({ source: 'leap', sequence: this.sequence++, observedAtMs, receivedAtMs, hands, stats });
      if (this.received === 1) this.state = { state: 'running', message: 'Leap tracking. Hold a hand above the device.' };
    };
    socket.onerror = () => { if (generation === this.generation) this.state = { state: 'error', message: `Leap service not reachable at ${this.url}. Enable "Allow Web Apps" in the Leap Motion control panel. Retrying…` }; };
    socket.onclose = () => {
      if (generation !== this.generation || !this.running) return;
      this.state = { state: 'error', message: `Leap service disconnected. Reconnecting in ${(this.retryMs / 1000).toFixed(1)} s…` };
      this.timer = setTimeout(() => this.connect(generation), this.retryMs);
      this.retryMs = Math.min(8000, this.retryMs * 2);
    };
  }

  stop() {
    this.generation++; this.running = false;
    if (this.timer) clearTimeout(this.timer); this.timer = undefined;
    if (this.socket) { this.socket.onclose = null; this.socket.onmessage = null; this.socket.onerror = null; try { this.socket.close(); } catch { /* already closed */ } }
    this.socket = undefined; this.palmMm = null;
    this.state = { state: 'idle', message: 'Leap Motion disconnected.' };
  }
}
