/**
 * The controls page's connection to the Ableton bridge, without the DOM: a show launcher opens
 * `ableton.html?connect=1`, the operator's last Connect / Disconnect survives a reload, and a dropped
 * bridge is retried every 2 s for as long as the connection is wanted.
 */

/** `?connect=1` (or true / yes / on) connects at load; `?connect=0` (or false / no / off) does not; otherwise null. */
export function parseConnect(search: string): boolean | null {
  let raw: string | null;
  try { raw = new URLSearchParams(search).get('connect'); } catch { return null; }
  if (raw === null) return null;
  const value = raw.trim().toLowerCase();
  if (['', '1', 'true', 'yes', 'on'].includes(value)) return true;
  if (['0', 'false', 'no', 'off'].includes(value)) return false;
  return null;
}

export const WANTED_KEY = 'livemixer-ableton-connect';

/** Whether to connect at load: the URL wins, then the operator's stored choice, else not. */
export function initialWanted(search: string, stored: string | null): boolean {
  return parseConnect(search) ?? stored === '1';
}

/** The part of a WebSocket the link uses (so tests can supply a fake). */
export interface SocketLike {
  readonly readyState: number;
  onopen: ((event: unknown) => void) | null;
  onclose: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  send(data: string): void;
  close(): void;
}

export type LinkState = 'disconnected' | 'connecting' | 'reconnecting' | 'open';

export interface LinkOptions {
  open: () => SocketLike;
  onState: (state: LinkState) => void;
  onOpen?: () => void;
  onMessage?: (data: unknown) => void;
  schedule?: (callback: () => void, ms: number) => unknown;
  cancel?: (handle: unknown) => void;
  retryMs?: number;
}

const OPEN = 1;

export class BridgeLink {
  private socket: SocketLike | null = null;
  private retry: unknown = null;
  private want = false;
  private readonly schedule: (callback: () => void, ms: number) => unknown;
  private readonly cancel: (handle: unknown) => void;

  constructor(private readonly options: LinkOptions) {
    this.schedule = options.schedule ?? ((callback, ms) => setTimeout(callback, ms));
    this.cancel = options.cancel ?? (handle => clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  get wanted(): boolean { return this.want; }
  get open(): boolean { return this.socket?.readyState === OPEN; }

  /** Connect now and keep reconnecting until stop(). Idempotent: never opens a second socket. */
  start(): void {
    this.want = true;
    if (this.socket || this.retry !== null) return;
    this.connect();
  }

  /** Stop wanting the bridge: cancel any retry and close the socket. */
  stop(): void {
    this.want = false;
    if (this.retry !== null) { this.cancel(this.retry); this.retry = null; }
    const socket = this.socket; this.socket = null;
    socket?.close();
    this.options.onState('disconnected');
  }

  /** Send when open; returns whether it was sent. */
  send(message: unknown): boolean {
    if (!this.socket || this.socket.readyState !== OPEN) return false;
    try { this.socket.send(JSON.stringify(message)); return true; } catch { return false; }
  }

  private connect(): void {
    this.retry = null;
    if (!this.want || this.socket) return;
    this.options.onState('connecting');
    let connection: SocketLike;
    try { connection = this.options.open(); } catch { this.scheduleRetry(); return; }
    this.socket = connection;
    connection.onopen = () => {
      if (this.socket !== connection) return;
      this.options.onState('open');
      this.options.onOpen?.();
    };
    connection.onmessage = event => { if (this.socket === connection) this.options.onMessage?.(event.data); };
    connection.onerror = () => { /* a close always follows */ };
    connection.onclose = () => {
      // An orphan (replaced or stopped) socket must not schedule a second reconnect loop.
      if (this.socket !== connection) return;
      this.socket = null;
      if (this.want) this.scheduleRetry();
      else this.options.onState('disconnected');
    };
  }

  private scheduleRetry(): void {
    this.options.onState('reconnecting');
    if (this.retry === null) this.retry = this.schedule(() => this.connect(), this.options.retryMs ?? 2000);
  }
}
