/**
 * Probe of the controls page itself (src/ableton/main.ts) with a fake DOM, WebSocket and BroadcastChannel: what it
 * really sends to the bridge on load, on mode changes and while input is stale, and what its status line says.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HandTelemetry } from '../src/sim/telemetry/types';

class FakeElement {
  value = ''; textContent = ''; innerHTML = ''; hidden = false; disabled = false;
  style: Record<string, string> = {}; dataset: Record<string, string> = {};
  private listeners: Record<string, ((event: unknown) => void)[]> = {};
  constructor(readonly id: string) {}
  addEventListener(type: string, fn: (event: unknown) => void) { (this.listeners[type] ??= []).push(fn); }
  replaceChildren() { /* options are not inspected */ }
  dispatch(type: string) { for (const fn of this.listeners[type] ?? []) fn({ target: this }); }
}
class FakeSocket {
  static all: FakeSocket[] = [];
  readyState = 0; sent: any[] = [];
  onopen: ((e: unknown) => void) | null = null; onclose: ((e: unknown) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null; onmessage: ((e: { data: unknown }) => void) | null = null;
  constructor(readonly url: string) { FakeSocket.all.push(this); }
  send(data: string) { this.sent.push(JSON.parse(data)); }
  close() { this.readyState = 3; this.onclose?.({}); }
  accept() { this.readyState = 1; this.onopen?.({}); }
  receive(message: unknown) { this.onmessage?.({ data: JSON.stringify(message) }); }
}
class FakeChannel {
  static all: FakeChannel[] = [];
  posted: any[] = []; onmessage: ((event: { data: unknown }) => void) | null = null;
  constructor(readonly name: string) { FakeChannel.all.push(this); }
  postMessage(message: unknown) { this.posted.push(message); }
  close() { /* nothing */ }
  /** A message from the simulation page. */
  deliver(message: unknown) { this.onmessage?.({ data: { direction: 'outbound', message } }); }
}

const hand: HandTelemetry = { id: 1, x: .5, y: .8, z: .5, vx: 0, vy: 0, vz: 0, speed: 0, radius: .05, openness: .1, pinch: 0, push: 0, palmUp: 1, ageMs: 0, staleMs: 0, solid: 0 } as HandTelemetry;
const contract = { presence: { min: 0, max: 1 }, reach: { min: 0, max: 1 }, lift: { min: 0, max: 1 }, closeness: { min: 0, max: 1 }, agitation: { min: 0, max: 1 } };
const schema = (id: string, signals: Record<string, unknown>) => ({ type: 'schema', v: 1, sim: { id, title: id, description: '', params: {}, signals } });
const frame = (id: string, presence: number, signals?: Record<string, number>) => ({
  type: 'frame', v: 1, t: 0, seq: 0,
  sim: { id, params: {}, signals: signals ?? { presence, reach: .6, lift: .8, closeness: .7, agitation: 0 } },
  input: { source: 'leap', presence, activity: .5, hands: presence > 0 ? [hand] : [], events: [], sourceAgeMs: 10, stats: {} },
  perf: { fps: 60, stepMs: 1, renderMs: 1 },
});

let elements: Map<string, FakeElement>;
async function load(search: string) {
  elements = new Map();
  const el = (id: string) => { let e = elements.get(id); if (!e) { e = new FakeElement(id); elements.set(id, e); } return e; };
  const storage = new Map<string, string>();
  vi.stubGlobal('document', { querySelector: (s: string) => el(s.replace('#', '')), getElementById: el, querySelectorAll: () => [] });
  vi.stubGlobal('window', { addEventListener: () => {} });
  vi.stubGlobal('location', { search });
  vi.stubGlobal('localStorage', { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => storage.set(k, v) });
  vi.stubGlobal('Option', class { constructor(public text: string, public value: string) {} });
  vi.stubGlobal('WebSocket', FakeSocket);
  vi.stubGlobal('BroadcastChannel', FakeChannel);
  FakeSocket.all = []; FakeChannel.all = [];
  vi.resetModules();
  await import('../src/ableton/main');
  return { socket: () => FakeSocket.all.at(-1)!, channel: FakeChannel.all[0], el };
}
const controls = (socket: FakeSocket) => socket.sent.filter(m => m.type === 'controls');
/** Advance time in 100 ms ticks, delivering `next()` (when not null) from the simulation each tick. */
function run(ms: number, channel: FakeChannel, next: () => unknown) {
  for (let t = 0; t < ms; t += 100) { const f = next(); if (f) channel.deliver(f); vi.advanceTimersByTime(100); }
}

beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance'] }); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('controls page (main.ts probe)', () => {
  it('sends Living home (vocals 0) as the very first message after a load', async () => {
    const { socket, el } = await load('?connect=1');
    expect(el('mode').value).toBe('living');
    socket().accept();
    expect(socket().sent[0]).toMatchObject({ type: 'controls', vocals: 0 });
    run(500, FakeChannel.all[0], () => null);
    expect(Math.max(...controls(socket()).map(m => m.vocals))).toBe(0);
  });

  it('a manual-start page connected by hand also starts at vocals 0', async () => {
    const { socket, el } = await load('');
    el('connect').dispatch('click');
    socket().accept();
    expect(socket().sent[0]).toMatchObject({ type: 'controls', vocals: 0 });
  });

  it('a non-living sim with a hand present keeps Living, and leaving Living goes home (vocals 0)', async () => {
    const { socket, channel, el } = await load('?connect=1');
    socket().accept();
    channel.deliver(schema('murmuration', contract));
    run(5000, channel, () => frame('murmuration', 1));
    expect(controls(socket()).at(-1).vocals).toBeGreaterThan(.9);
    // Rotation to trails: no contract. The page must not freeze vocals 1 in Manual.
    channel.deliver(schema('trails', { energy: { min: 0, max: 1 } }));
    expect(el('mode').value).toBe('living');
    socket().sent = [];
    run(10_000, channel, () => frame('trails', 0, { energy: .3 }));
    expect(controls(socket()).at(-1).vocals).toBe(0);
    // A hand again, then the operator switches to Manual: home at once.
    run(5000, channel, () => frame('trails', 1, { energy: .3 }));
    el('mode').value = 'manual'; el('mode').dispatch('change');
    socket().sent = [];
    run(1000, channel, () => frame('trails', 1, { energy: .3 }));
    expect(controls(socket()).length).toBeGreaterThan(0);
    expect(controls(socket()).every(m => m.vocals === 0 && m.fx === undefined)).toBe(true);
  });

  it('Simulation mode never sends vocals while its input is stale', async () => {
    const { socket, channel, el } = await load('?connect=1');
    socket().accept();
    socket().sent = [];
    el('mode').value = 'simulation'; el('mode').dispatch('change');
    run(3000, channel, () => null);
    expect(socket().sent.filter(m => m.type === 'release')).toHaveLength(1);
    expect(controls(socket()).filter(m => m.vocals > 0)).toHaveLength(0);
  });

  it('shows MIDI and ownership problems and the vocals readout', async () => {
    const { socket, el } = await load('?connect=1');
    socket().accept();
    socket().receive({ type: 'status', live: true, midi: false, midiPort: 'IAC Driver LiveMixer' });
    expect(el('status').textContent).toBe('MIDI port not available: IAC Driver LiveMixer');
    expect(el('status').dataset.ready).toBe('false');
    socket().receive({ type: 'status', live: true, midi: true, owner: false });
    expect(el('status').textContent).toBe('Another control window is in charge');
    socket().receive({ type: 'status', live: true, midi: true });
    expect(el('status').textContent).toBe('Another control window is in charge');
    socket().receive({ type: 'status', live: true, midi: true, owner: true, state: { beat: 1, playing: true, amount: -1 } });
    expect(el('status').textContent).toBe('Live connected');
    expect(el('status').dataset.ready).toBe('true');
    expect(el('vocals-live').hidden).toBe(false);
    expect(el('vocals-live').textContent).toBe('Vocals in Live: off');
    socket().receive({ type: 'status', live: true }); // older bridge
    expect(el('status').textContent).toBe('Live connected');
    expect(el('vocals-live').hidden).toBe(true);
  });
});
