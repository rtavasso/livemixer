/**
 * Concrete transports. All are best-effort: a consumer being absent must
 * never affect the picture on the wall.
 *
 *  - BroadcastChannel: another tab in the same browser profile (the simplest
 *    way to prototype the audio side as a second page).
 *  - WebSocket: a separate process (Max/MSP, SuperCollider, Python, Node).
 *    The page connects OUT to a server the consumer runs; reconnects forever.
 *  - Window: postMessage to a parent/opener when the sim is embedded.
 */
import type { Transport, TransportStatus } from './bus';
import { BROADCAST_CHANNEL_NAME, type TelemetryInbound, type TelemetryOutbound } from './types';

export class BroadcastTransport implements Transport {
  readonly id = 'broadcast';
  private channel?: BroadcastChannel;
  constructor(private readonly name = BROADCAST_CHANNEL_NAME) {}
  open(onInbound: (message: TelemetryInbound) => void) {
    if (typeof BroadcastChannel === 'undefined') return;
    this.channel = new BroadcastChannel(this.name);
    this.channel.onmessage = event => { if (event.data && typeof event.data === 'object' && event.data.direction === 'inbound') onInbound(event.data.message); };
  }
  send(message: TelemetryOutbound) { this.channel?.postMessage({ direction: 'outbound', message }); }
  status(): TransportStatus { return { connected: !!this.channel, detail: this.channel ? `channel "${this.name}"` : 'BroadcastChannel unavailable' }; }
  close() { this.channel?.close(); this.channel = undefined; }
}

export class WebSocketTransport implements Transport {
  readonly id = 'websocket';
  private socket?: WebSocket; private timer?: ReturnType<typeof setTimeout>; private retryMs = 500; private closed = false;
  private onInbound?: (message: TelemetryInbound) => void;
  private detail = 'not connected';
  private queueSchema?: TelemetryOutbound;
  constructor(public url: string) {}
  open(onInbound: (message: TelemetryInbound) => void) { this.onInbound = onInbound; this.closed = false; this.connect(); }
  private connect() {
    if (this.closed) return;
    let socket: WebSocket;
    try { socket = new WebSocket(this.url); } catch (error) { this.detail = `invalid URL: ${String(error)}`; return; }
    this.socket = socket; this.detail = `connecting to ${this.url}`;
    socket.onopen = () => { this.retryMs = 500; this.detail = `connected to ${this.url}`; if (this.queueSchema) socket.send(JSON.stringify(this.queueSchema)); };
    socket.onmessage = event => { if (typeof event.data === 'string') { try { const parsed = JSON.parse(event.data); this.onInbound?.(parsed); } catch { /* ignore */ } } };
    socket.onerror = () => { this.detail = `connection failed (${this.url})`; };
    socket.onclose = () => {
      if (this.closed) return;
      this.detail = `disconnected; retrying in ${(this.retryMs / 1000).toFixed(1)} s`;
      this.timer = setTimeout(() => this.connect(), this.retryMs); this.retryMs = Math.min(8000, this.retryMs * 2);
    };
  }
  send(message: TelemetryOutbound) {
    if (message.type === 'schema') this.queueSchema = message; // replayed on (re)connect
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message));
  }
  status(): TransportStatus { return { connected: this.socket?.readyState === WebSocket.OPEN, detail: this.detail }; }
  close() { this.closed = true; if (this.timer) clearTimeout(this.timer); if (this.socket) { this.socket.onclose = null; try { this.socket.close(); } catch { /* ignore */ } } this.socket = undefined; this.detail = 'closed'; }
}

export class WindowTransport implements Transport {
  readonly id = 'window';
  private listener?: (event: MessageEvent) => void;
  private target(): Window | null { return window.parent !== window ? window.parent : window.opener ?? null; }
  open(onInbound: (message: TelemetryInbound) => void) {
    this.listener = event => { if (event.data && typeof event.data === 'object' && event.data.channel === BROADCAST_CHANNEL_NAME && event.data.direction === 'inbound') onInbound(event.data.message); };
    window.addEventListener('message', this.listener);
  }
  /** Embedding pages may be on another origin (a Max/MSP jweb, a kiosk shell), hence the wildcard target. */
  send(message: TelemetryOutbound) { this.target()?.postMessage({ channel: BROADCAST_CHANNEL_NAME, direction: 'outbound', message }, '*'); }
  status(): TransportStatus { const t = this.target(); return { connected: !!t, detail: t ? 'posting to the embedding window' : 'not embedded' }; }
  close() { if (this.listener) window.removeEventListener('message', this.listener); }
}
