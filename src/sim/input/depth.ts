/**
 * WebSocket client for the depth-camera bridge (see protocol.ts and bridge/).
 * Reconnects with backoff, validates every message, maps the bridge clock
 * onto the page clock, and emits generic input frames.
 *
 * Source frame: the bridge's normalized bounding box, camera-image oriented
 * (u right, v down, w = depth into the box). Use DEPTH_MAPPING, then calibrate.
 */
import { bridgeFrameToInput, ClockMapper, parseBridgeMessage, type BridgeHello } from './protocol';
import type { InputFrame, InputSource, InputSourceStatus } from './types';

export class DepthBridgeSource implements InputSource {
  readonly id = 'depth' as const;
  readonly frameDescription = 'Depth bridge box: u → camera right, v → camera down, w → deeper into the box';
  private socket?: WebSocket; private running = false; private generation = 0; private retryMs = 500; private timer?: ReturnType<typeof setTimeout>;
  private readonly clock = new ClockMapper();
  private state: InputSourceStatus = { state: 'idle', message: 'Depth bridge disconnected.' };
  private lastSequence = -1;
  /** Frames are numbered locally so a bridge restart (seq back to 0) does not look like reordering to the tracker. */
  private sequence = 0;
  hello: BridgeHello | null = null;
  /** Frames received on the current connection. */
  received = 0;

  constructor(public url: string, private readonly emit: (frame: InputFrame) => void, private readonly now: () => number = () => performance.now()) {}

  status() { return this.state; }

  async start() {
    this.stop(); this.running = true; this.retryMs = 500;
    this.connect(this.generation);
  }

  private connect(generation: number) {
    if (!this.running || generation !== this.generation) return;
    this.state = { state: 'starting', message: `Connecting to ${this.url}…` };
    let socket: WebSocket;
    try { socket = new WebSocket(this.url); } catch (error) { this.state = { state: 'error', message: `Invalid bridge URL: ${String(error)}` }; return; }
    this.socket = socket;
    socket.onopen = () => { if (generation !== this.generation) return; this.retryMs = 500; this.received = 0; this.lastSequence = -1; this.clock.reset(); this.state = { state: 'running', message: 'Connected. Waiting for the bridge hello…' }; };
    socket.onmessage = event => {
      if (generation !== this.generation || typeof event.data !== 'string') return;
      const receivedAtMs = this.now();
      try {
        const message = parseBridgeMessage(event.data);
        if (message.type === 'hello') { this.hello = message; this.state = { state: 'running', message: `Bridge "${message.source}" ready${message.fps ? ` at ${message.fps} fps` : ''}.` }; return; }
        if (message.type === 'status') { this.state = { state: message.level === 'error' ? 'error' : 'running', message: `Bridge: ${message.message}` }; return; }
        if (message.seq <= this.lastSequence) return; // duplicate or reordered; the tracker would drop it too
        this.lastSequence = message.seq; this.received++;
        let observedAtMs = Math.min(this.clock.observe(message.t, receivedAtMs), receivedAtMs);
        // A bridge clock that stalls or runs slow would make every frame look stale; start the estimate over.
        if (receivedAtMs - observedAtMs > 1000) { this.clock.reset(); observedAtMs = receivedAtMs; }
        this.emit({ ...bridgeFrameToInput(message, observedAtMs, receivedAtMs, this.hello), sequence: this.sequence++ });
      } catch (error) { this.state = { state: 'running', message: error instanceof Error ? error.message : String(error) }; }
    };
    socket.onerror = () => { if (generation === this.generation) this.state = { state: 'error', message: `Bridge connection failed (${this.url}). Retrying…` }; };
    socket.onclose = () => {
      if (generation !== this.generation || !this.running) return;
      this.hello = null;
      this.state = { state: 'error', message: `Bridge disconnected. Reconnecting in ${(this.retryMs / 1000).toFixed(1)} s…` };
      this.timer = setTimeout(() => this.connect(generation), this.retryMs);
      this.retryMs = Math.min(8000, this.retryMs * 2);
    };
  }

  stop() {
    this.generation++; this.running = false;
    if (this.timer) clearTimeout(this.timer); this.timer = undefined;
    if (this.socket) { this.socket.onclose = null; this.socket.onmessage = null; this.socket.onerror = null; try { this.socket.close(); } catch { /* already closed */ } }
    this.socket = undefined; this.hello = null;
    this.state = { state: 'idle', message: 'Depth bridge disconnected.' };
  }
}
