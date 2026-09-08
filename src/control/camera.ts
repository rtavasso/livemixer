import { calibratedOpenness, handTilt, type Calibration } from './conditioning';
import type { ControlFrame, Landmark } from './types';
export class CameraAdapter {
  private worker?: Worker; private stream?: MediaStream; private busy = false; private running = false;
  private sequence = 0; private raf = 0; private lastVideoTime = -1; private generation = 0;
  private lastResultSequence = -1; private pendingAt = 0;
  calibration: Calibration | null = null;
  landmarks: Landmark[] = []; angle: number | null = null;
  samples: { angle: number; at: number }[] = [];
  constructor(readonly video: HTMLVideoElement, readonly onFrame: (frame: ControlFrame) => void, readonly onStatus: (message: string) => void) {}
  async start() {
    this.stop(); const generation = this.generation;
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('Camera requires localhost or HTTPS.');
      const stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30 } }, audio: false });
      if (generation !== this.generation) { stream.getTracks().forEach(t => t.stop()); return; }
      this.stream = stream; this.video.srcObject = stream; await this.video.play();
      if (generation !== this.generation) return;
      this.onStatus('Loading local hand model…');
      const worker = this.worker = new Worker('/models/hand.worker.js');
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Camera model initialization timed out. Run npm run setup:models.')), 30_000);
        worker.onerror = event => { clearTimeout(timeout); reject(new Error(event.message || 'Camera worker failed.')); };
        worker.onmessage = ({ data }) => {
          if (data.type === 'ready') { clearTimeout(timeout); resolve(); }
          if (data.type === 'error') { clearTimeout(timeout); reject(new Error(data.message)); }
        };
        worker.postMessage({ type: 'init', wasmRoot: new URL('/models/wasm', location.href).href, modelUrl: new URL('/models/hand_landmarker.task', location.href).href });
      });
      if (generation !== this.generation) { worker.terminate(); return; }
      this.running = true; this.onStatus('Camera ready. Capture low and high positions.');
      worker.onerror = event => { this.onStatus(event.message || 'Camera worker failed.'); this.stop(); };
      worker.onmessage = ({ data }) => {
        if (generation !== this.generation) return;
        this.busy = false;
        if (data.type !== 'result' && data.type !== 'frame-error') return;
        const receivedAtMs = performance.now();
        const fresh = data.sequence > this.lastResultSequence && receivedAtMs - data.observedAtMs <= 200;
        if (fresh) {
          this.lastResultSequence = data.sequence;
          this.landmarks = data.landmarks ?? []; this.angle = handTilt(this.landmarks, data.width, data.height);
          if (this.angle !== null) this.samples.push({ angle: this.angle, at: receivedAtMs }); else this.samples = [];
          this.samples = this.samples.filter(s => receivedAtMs - s.at < 750);
        }
        const openness = fresh && this.angle !== null && this.calibration ? calibratedOpenness(this.angle, this.calibration) : null;
        this.onFrame({ sequence: data.sequence, observedAtMs: data.observedAtMs, receivedAtMs, valid: openness !== null && fresh, values: { openness: openness ?? .3 }, source: 'camera' });
        if (data.type === 'frame-error') this.onStatus(data.message);
      };
      this.loop(generation);
    } catch (error) { if (generation === this.generation) { this.stop(); throw error; } }
  }
  private loop(generation: number) {
    if (!this.running || generation !== this.generation) return;
    this.raf = requestAnimationFrame(() => this.loop(generation));
    if (this.busy) {
      if (performance.now() - this.pendingAt > 5000) { this.onStatus('Camera inference stalled. Restart the camera.'); this.stop(); }
      return;
    }
    if (this.video.readyState < 2 || this.video.currentTime === this.lastVideoTime) return;
    this.lastVideoTime = this.video.currentTime; this.busy = true;
    const observedAtMs = this.pendingAt = performance.now(), sequence = this.sequence++;
    createImageBitmap(this.video).then(bitmap => {
      if (generation !== this.generation || !this.worker) { bitmap.close(); return; }
      this.worker.postMessage({ type: 'frame', bitmap, sequence, observedAtMs }, [bitmap]);
    }).catch(error => { this.busy = false; this.onStatus(String(error)); });
  }
  stop() {
    this.generation++; this.running = false; this.busy = false; cancelAnimationFrame(this.raf);
    this.worker?.terminate(); this.worker = undefined;
    this.stream?.getTracks().forEach(t => t.stop()); this.stream = undefined; this.video.srcObject = null;
    this.landmarks = []; this.samples = []; this.angle = null; this.lastVideoTime = -1;
  }
}
