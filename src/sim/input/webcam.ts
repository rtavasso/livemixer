/**
 * Ordinary RGB webcam through the repository's local MediaPipe hand worker
 * (`/models/hand.worker.js`, bundled by `npm run build:worker`). This is the
 * "rehearsal" source: a real hand, no depth camera required. Depth is
 * approximated from apparent palm size, which the mapping's z interval turns
 * into a usable push axis after a quick calibration.
 *
 * Source frame: image, x right, y down (unmirrored camera view). Use IMAGE_MAPPING.
 */
import type { HandObservation, InputFrame, InputSource, InputSourceStatus } from './types';

interface Landmark { x: number; y: number; z?: number }

export class WebcamSource implements InputSource {
  readonly id = 'webcam' as const;
  readonly frameDescription = 'Camera image: x → right, y → down, z = apparent hand size';
  private worker?: Worker; private stream?: MediaStream; private busy = false; private running = false;
  private sequence = 0; private raf = 0; private lastVideoTime = -1; private generation = 0; private pendingAt = 0;
  private state: InputSourceStatus = { state: 'idle', message: 'Webcam stopped.' };
  /** Latest landmarks, for the overlay preview. */
  landmarks: Landmark[] = [];

  constructor(readonly video: HTMLVideoElement, private readonly emit: (frame: InputFrame) => void) {}

  status() { return this.state; }

  async start() {
    this.stop(); const generation = this.generation;
    this.state = { state: 'starting', message: 'Requesting camera…' };
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('Camera requires localhost or HTTPS.');
      const stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30 } }, audio: false });
      if (generation !== this.generation) { stream.getTracks().forEach(t => t.stop()); return; }
      this.stream = stream; this.video.srcObject = stream; await this.video.play();
      if (generation !== this.generation) return;
      this.state = { state: 'starting', message: 'Loading local hand model…' };
      const worker = this.worker = new Worker('/models/hand.worker.js');
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Hand model initialization timed out. Run npm run setup:models.')), 30_000);
        worker.onerror = event => { clearTimeout(timeout); reject(new Error(event.message || 'Hand worker failed.')); };
        worker.onmessage = ({ data }) => {
          if (data.type === 'ready') { clearTimeout(timeout); resolve(); }
          if (data.type === 'error') { clearTimeout(timeout); reject(new Error(data.message)); }
        };
        worker.postMessage({ type: 'init', wasmRoot: new URL('/models/wasm', location.href).href, modelUrl: new URL('/models/hand_landmarker.task', location.href).href });
      });
      if (generation !== this.generation) { worker.terminate(); return; }
      this.running = true; this.state = { state: 'running', message: 'Webcam tracking. Show an open hand.' };
      worker.onerror = event => { this.state = { state: 'error', message: event.message || 'Hand worker failed.' }; this.stop(); };
      worker.onmessage = ({ data }) => {
        if (generation !== this.generation) return;
        this.busy = false;
        if (data.type !== 'result' && data.type !== 'frame-error') return;
        const receivedAtMs = performance.now();
        this.landmarks = data.landmarks ?? [];
        const hand = data.type === 'result' ? landmarksToObservation(this.landmarks, data.width, data.height) : null;
        this.emit({ source: 'webcam', sequence: data.sequence, observedAtMs: data.observedAtMs, receivedAtMs, hands: hand ? [hand] : [], stats: { inferenceMs: receivedAtMs - data.observedAtMs } });
        if (data.type === 'frame-error') this.state = { state: 'running', message: data.message };
      };
      this.loop(generation);
    } catch (error) {
      if (generation === this.generation) { this.stop(); this.state = { state: 'error', message: error instanceof Error ? error.message : String(error) }; throw error; }
    }
  }

  private loop(generation: number) {
    if (!this.running || generation !== this.generation) return;
    this.raf = requestAnimationFrame(() => this.loop(generation));
    if (this.busy) { if (performance.now() - this.pendingAt > 5000) { this.state = { state: 'error', message: 'Hand inference stalled. Restart the webcam.' }; this.stop(); } return; }
    if (this.video.readyState < 2 || this.video.currentTime === this.lastVideoTime) return;
    this.lastVideoTime = this.video.currentTime; this.busy = true;
    const observedAtMs = this.pendingAt = performance.now(), sequence = this.sequence++;
    createImageBitmap(this.video).then(bitmap => {
      if (generation !== this.generation || !this.worker) { bitmap.close(); return; }
      this.worker.postMessage({ type: 'frame', bitmap, sequence, observedAtMs }, [bitmap]);
    }).catch(error => { this.busy = false; this.state = { state: 'running', message: String(error) }; });
  }

  stop() {
    this.generation++; this.running = false; this.busy = false; cancelAnimationFrame(this.raf);
    this.worker?.terminate(); this.worker = undefined;
    this.stream?.getTracks().forEach(t => t.stop()); this.stream = undefined; this.video.srcObject = null;
    this.landmarks = []; this.lastVideoTime = -1;
    if (this.state.state !== 'error') this.state = { state: 'idle', message: 'Webcam stopped.' };
  }
}

const WRIST = 0, THUMB_TIP = 4, INDEX_MCP = 5, INDEX_TIP = 8, MIDDLE_MCP = 9, MIDDLE_TIP = 12, RING_MCP = 13, RING_TIP = 16, PINKY_MCP = 17, PINKY_TIP = 20;

/**
 * Reduce 21 MediaPipe landmarks to one observation. Returns null for an
 * implausible hand. All geometry is done in pixel units so the aspect ratio
 * does not distort distances.
 */
export function landmarksToObservation(points: Landmark[], width: number, height: number): HandObservation | null {
  if (points.length < 21 || !(width > 0 && height > 0)) return null;
  if (points.some(p => !Number.isFinite(p.x) || !Number.isFinite(p.y) || p.x < -.2 || p.x > 1.2 || p.y < -.2 || p.y > 1.2)) return null;
  const px = (i: number) => ({ x: points[i].x * width, y: points[i].y * height });
  const dist = (a: number, b: number) => { const p = px(a), q = px(b); return Math.hypot(p.x - q.x, p.y - q.y); };
  const palm = dist(WRIST, MIDDLE_MCP);
  if (palm < Math.max(8, Math.min(width, height) * .02)) return null;
  const palmIds = [WRIST, INDEX_MCP, MIDDLE_MCP, RING_MCP, PINKY_MCP];
  const centre = palmIds.reduce((acc, i) => ({ x: acc.x + points[i].x / palmIds.length, y: acc.y + points[i].y / palmIds.length }), { x: 0, y: 0 });
  // Finger extension: tip distance from the wrist relative to the knuckle distance. ~1.0 when curled, ~1.8+ when straight.
  const fingers: [number, number][] = [[INDEX_MCP, INDEX_TIP], [MIDDLE_MCP, MIDDLE_TIP], [RING_MCP, RING_TIP], [PINKY_MCP, PINKY_TIP]];
  const extension = fingers.reduce((sum, [mcp, tip]) => sum + dist(WRIST, tip) / Math.max(1e-3, dist(WRIST, mcp)), 0) / fingers.length;
  const openness = clamp01((extension - 1.15) / .7);
  const pinch = clamp01(1 - (dist(THUMB_TIP, INDEX_TIP) / palm - .2) / .6);
  // Apparent size as a depth proxy: a palm spanning ~8% of the frame is "far" (z=0), ~30% is "near" (z=1).
  const size = palm / Math.min(width, height);
  const z = clamp01((size - .08) / .22);
  let minX = 1, minY = 1, maxX = 0, maxY = 0;
  for (const p of points) { minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y); }
  return {
    id: 1, position: { x: centre.x, y: centre.y, z }, confidence: 1, openness, pinch,
    extent: { min: { x: minX, y: minY, z }, max: { x: maxX, y: maxY, z } },
    points: [WRIST, THUMB_TIP, INDEX_TIP, MIDDLE_TIP, RING_TIP, PINKY_TIP].map(i => ({ x: points[i].x, y: points[i].y, z })),
  };
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
