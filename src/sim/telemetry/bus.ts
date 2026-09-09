/**
 * The telemetry bus fans messages out to any number of transports and fans
 * inbound commands back in. It also rate-limits frames so the sim can render
 * at 60 fps while consumers receive a steadier 30 Hz (configurable).
 */
import { parseInbound, type TelemetryFrame, type TelemetryInbound, type TelemetryOutbound, type TelemetrySchema } from './types';

export interface TransportStatus { connected: boolean; detail: string }
export interface Transport {
  readonly id: string;
  open(onInbound: (message: TelemetryInbound) => void): void;
  send(message: TelemetryOutbound): void;
  status(): TransportStatus;
  close(): void;
}

export class TelemetryBus {
  private transports: Transport[] = [];
  private subscribers = new Set<(message: TelemetryOutbound) => void>();
  private inboundHandlers = new Set<(message: TelemetryInbound) => void>();
  private lastFrameMs = -Infinity;
  private schema: TelemetrySchema | null = null;
  lastFrame: TelemetryFrame | null = null;
  sent = 0;
  constructor(public rateHz = 30) {}

  addTransport(transport: Transport) {
    this.transports.push(transport);
    transport.open(message => this.receive(message));
    if (this.schema) transport.send(this.schema);
  }
  removeTransport(id: string) {
    for (const t of this.transports.filter(t => t.id === id)) t.close();
    this.transports = this.transports.filter(t => t.id !== id);
  }
  transportStatus(): { id: string; status: TransportStatus }[] { return this.transports.map(t => ({ id: t.id, status: t.status() })); }

  /** In-page subscription (overlay, tests, devtools). */
  subscribe(fn: (message: TelemetryOutbound) => void): () => void { this.subscribers.add(fn); return () => this.subscribers.delete(fn); }
  onInbound(fn: (message: TelemetryInbound) => void): () => void { this.inboundHandlers.add(fn); return () => this.inboundHandlers.delete(fn); }

  /** Feed a raw inbound payload (string or object) from any channel. */
  receive(raw: unknown) {
    const message = typeof raw === 'object' && raw !== null && 'type' in raw ? parseInbound(raw) : parseInbound(raw);
    if (!message) return;
    if (message.type === 'get-schema' && this.schema) this.broadcast(this.schema);
    if (message.type === 'ping') this.broadcast({ type: 'status', v: 1, level: 'info', message: `pong${message.id !== undefined ? ` ${message.id}` : ''}` });
    for (const fn of this.inboundHandlers) fn(message);
  }

  publishSchema(schema: TelemetrySchema) { this.schema = schema; this.broadcast(schema); }
  publishStatus(level: 'info' | 'warning' | 'error', message: string) { this.broadcast({ type: 'status', v: 1, level, message }); }

  /** Publish a frame if the rate limit allows. The builder runs only when a frame will be sent. */
  publishFrame(nowMs: number, build: () => TelemetryFrame): boolean {
    if (nowMs - this.lastFrameMs < 1000 / this.rateHz - .5) return false;
    this.lastFrameMs = nowMs;
    const frame = build();
    this.lastFrame = frame; this.sent++;
    this.broadcast(frame);
    return true;
  }

  private broadcast(message: TelemetryOutbound) {
    for (const t of this.transports) { try { t.send(message); } catch { /* a broken transport must not stop the show */ } }
    for (const fn of this.subscribers) fn(message);
  }

  close() { for (const t of this.transports) t.close(); this.transports = []; }
}
