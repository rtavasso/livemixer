/**
 * Unattended-running guarantees of the simulation page: a hidden page keeps publishing telemetry,
 * a failed simulation or lost GL context never leaves stale signals on the bus, a lost context is
 * recovered (new canvas, then reload), and a silent input socket is replaced.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TelemetryFrame, TelemetryOutbound } from '../../src/sim/telemetry/types';

// ---------------------------------------------------------------- fakes for the host

const sim = vi.hoisted(() => ({ renderThrows: false, created: 0, steps: 0, renders: 0, signalReads: 0 }));

vi.mock('../../src/sim/host/registry', () => {
  const definition = {
    id: 'fake', title: 'Fake', description: 'Test simulation',
    params: {}, signals: { level: { min: 0, max: 1, description: 'A constant' } },
    create() {
      sim.created++;
      return {
        step() { sim.steps++; },
        render() { sim.renders++; if (sim.renderThrows) { sim.renderThrows = false; throw new Error('boom'); } },
        signals() { sim.signalReads++; return { level: .7 }; },
        dispose() {},
      };
    },
  };
  return { SIMULATIONS: [definition], findSimulation: (id: string) => id === 'fake' ? definition : undefined, validateRegistry: () => [] };
});

const gl = vi.hoisted(() => ({ lostOnCreate: false, creates: 0 }));
vi.mock('../../src/sim/gl/context', () => ({
  createGl: () => { gl.creates++; const lost = gl.lostOnCreate; return { gl: { isContextLost: () => lost }, capabilities: { floatColor: true, halfFloatColor: true, linearFloat: true, maxTextureSize: 4096 } }; },
  describeGpu: () => 'fake gpu',
  fitCanvas: () => false,
}));
vi.mock('../../src/sim/gl/quad', () => ({ invalidateQuadCache: () => {} }));

class FakeCanvas extends EventTarget {
  className = ''; tabIndex = -1; width = 640; height = 360; clientWidth = 640; clientHeight = 360;
  parentNode: unknown = null; replacedWith: FakeCanvas | null = null;
  setAttribute() {}
  replaceWith(next: FakeCanvas) { this.replacedWith = next; next.parentNode = this.parentNode; this.parentNode = null; }
  remove() {}
  focus() {}
}

const page = { hidden: false, canvases: [] as FakeCanvas[] };
let rafQueue: (() => void)[] = [];

function installDom() {
  page.canvases = []; rafQueue = [];
  vi.stubGlobal('document', {
    get hidden() { return page.hidden; },
    activeElement: null,
    createElement: () => { const c = new FakeCanvas(); page.canvases.push(c); return c; },
  });
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  // rAF runs at ~60 Hz while visible; a hidden page never runs it (as in Chrome).
  vi.stubGlobal('requestAnimationFrame', (cb: () => void) => { rafQueue.push(cb); return rafQueue.length; });
  vi.stubGlobal('cancelAnimationFrame', () => { rafQueue = []; });
}
/** Advance time in 16 ms display frames, running queued rAF callbacks only while the page is visible. */
function advance(ms: number) {
  for (let t = 0; t < ms; t += 16) {
    vi.advanceTimersByTime(16);
    if (!page.hidden) { const due = rafQueue; rafQueue = []; for (const cb of due) cb(); }
  }
}

async function makeHost(reload = vi.fn()) {
  const { SimHost } = await import('../../src/sim/host/app');
  const { SettingsStore } = await import('../../src/sim/host/settings');
  const settings = new SettingsStore(null, '?sim=fake&source=synthetic');
  const root = { appendChild: (c: FakeCanvas) => { c.parentNode = root; } };
  const host = new SimHost(root as never, {} as HTMLVideoElement, settings, () => Date.now(), { externalTelemetry: false, reload });
  const frames: TelemetryFrame[] = [];
  host.bus.subscribe((m: TelemetryOutbound) => { if (m.type === 'frame') frames.push(m); });
  return { host, frames, reload };
}

describe('SimHost liveness', () => {
  beforeEach(() => {
    vi.useFakeTimers(); installDom(); page.hidden = false;
    Object.assign(sim, { renderThrows: false, created: 0, steps: 0, renders: 0, signalReads: 0 });
    Object.assign(gl, { lostOnCreate: false, creates: 0 });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it('keeps stepping and publishing telemetry while the page is hidden, without rendering', async () => {
    const { host, frames } = await makeHost();
    page.hidden = true;
    host.start();
    advance(2000);
    expect(sim.renders).toBe(0);
    expect(sim.steps).toBeGreaterThan(60);
    // ~30 Hz telemetry from the background tick
    expect(frames.length).toBeGreaterThanOrEqual(50);
    expect(frames.at(-1)!.sim.signals).toEqual({ level: .7 });
    expect(host.latestOutput).not.toBeNull();
    host.dispose();
  });

  it('hands back to rAF when visible again: one frame per display frame, no background frames', async () => {
    const { host, frames } = await makeHost();
    page.hidden = true; host.start(); advance(500);
    page.hidden = false; advance(100); // rAF resumes
    const reads = sim.signalReads, renders = sim.renders, sent = frames.length;
    advance(1600); // 100 display frames
    expect(sim.renders - renders).toBeGreaterThanOrEqual(95);
    // every frame that read signals rendered too: the background ticker stayed out of the way
    expect(sim.signalReads - reads).toBe(sim.renders - renders);
    expect(frames.length - sent).toBeGreaterThanOrEqual(30); // 30 Hz bus on a 16 ms test display: every third frame
    host.dispose();
  });

  it('stop() halts the background ticker too', async () => {
    const { host, frames } = await makeHost();
    page.hidden = true; host.start(); advance(300);
    host.stop();
    const sent = frames.length; advance(1000);
    expect(frames.length).toBe(sent);
    host.dispose();
  });

  it('clears signals when a failing simulation is disposed, then recreates it after 5 s', async () => {
    const { host, frames } = await makeHost();
    host.start(); advance(200);
    expect(host.state().signals).toEqual({ level: .7 });
    sim.renderThrows = true; advance(100);
    expect(host.state().signals).toEqual({});
    expect(frames.at(-1)!.sim.signals).toEqual({});
    const created = sim.created;
    advance(5200);
    expect(sim.created).toBe(created + 1);
    expect(frames.at(-1)!.sim.signals).toEqual({ level: .7 });
    host.dispose();
  });

  it('on a lost WebGL context: clears signals, builds a new canvas after 10 s, reloads if that is lost too', async () => {
    const { host, frames, reload } = await makeHost();
    host.start(); advance(200);
    const first = host.canvas as unknown as FakeCanvas;
    first.dispatchEvent(new Event('webglcontextlost', { cancelable: true }));
    advance(100);
    expect(host.state().contextLost).toBe(true);
    expect(frames.at(-1)!.sim.signals).toEqual({});
    advance(9000);
    expect(host.canvas).toBe(first); // still waiting for the browser
    advance(1200);
    const second = host.canvas as unknown as FakeCanvas;
    expect(second).not.toBe(first);
    expect(first.replacedWith).toBe(second);
    expect(host.state().contextLost).toBe(false);
    advance(100);
    expect(frames.at(-1)!.sim.signals).toEqual({ level: .7 });
    expect(reload).not.toHaveBeenCalled();
    // The old canvas no longer drives the host.
    first.dispatchEvent(new Event('webglcontextlost', { cancelable: true }));
    expect(host.state().contextLost).toBe(false);
    // Lost again soon after the replacement: the GPU is not coming back in this page.
    second.dispatchEvent(new Event('webglcontextlost', { cancelable: true }));
    advance(10_500);
    expect(reload).toHaveBeenCalledTimes(1);
    host.dispose();
  });

  it('a context the browser restores in time needs no new canvas', async () => {
    const { host, reload } = await makeHost();
    host.start(); advance(200);
    const first = host.canvas as unknown as FakeCanvas;
    first.dispatchEvent(new Event('webglcontextlost', { cancelable: true }));
    advance(3000);
    first.dispatchEvent(new Event('webglcontextrestored'));
    advance(12_000);
    expect(host.canvas).toBe(first);
    expect(host.state().signals).toEqual({ level: .7 });
    expect(reload).not.toHaveBeenCalled();
    host.dispose();
  });
});

// ---------------------------------------------------------------- silent-socket watchdog

class FakeSocket {
  static instances: FakeSocket[] = [];
  onopen: (() => void) | null = null; onclose: (() => void) | null = null; onerror: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  closed = false;
  constructor(readonly url: string) { FakeSocket.instances.push(this); }
  send() {}
  close() { this.closed = true; }
  open() { this.onopen?.(); }
  message(data: unknown) { this.onmessage?.({ data: JSON.stringify(data) }); }
}

describe('input socket watchdog', () => {
  beforeEach(() => { vi.useFakeTimers(); FakeSocket.instances = []; vi.stubGlobal('WebSocket', FakeSocket); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it('depth bridge: an open socket that sends no frame for 5 s is dropped and reconnected', async () => {
    const { DepthBridgeSource } = await import('../../src/sim/input/depth');
    const source = new DepthBridgeSource('ws://bridge', () => {}, () => Date.now());
    await source.start();
    const first = FakeSocket.instances[0];
    first.open();
    first.message({ type: 'hello', v: 1, source: 'test' }); // a hello is not a frame
    vi.advanceTimersByTime(4000);
    expect(first.closed).toBe(false);
    vi.advanceTimersByTime(2000);
    expect(first.closed).toBe(true);
    expect(first.onclose).toBeNull(); // abandoned without waiting for a close handshake
    expect(source.status().message).toMatch(/No frames/);
    vi.advanceTimersByTime(600);
    expect(FakeSocket.instances).toHaveLength(2);
    source.stop();
  });

  it('depth bridge: frames keep the socket alive', async () => {
    const { DepthBridgeSource } = await import('../../src/sim/input/depth');
    const frames: unknown[] = [];
    const source = new DepthBridgeSource('ws://bridge', f => frames.push(f), () => Date.now());
    await source.start();
    const socket = FakeSocket.instances[0];
    socket.open();
    for (let i = 0; i < 20; i++) { vi.advanceTimersByTime(1000); socket.message({ type: 'frame', seq: i, t: i, hands: [] }); }
    expect(frames).toHaveLength(20);
    expect(socket.closed).toBe(false);
    expect(FakeSocket.instances).toHaveLength(1);
    source.stop();
  });

  it('depth bridge: a handshake that never completes is retried too', async () => {
    const { DepthBridgeSource } = await import('../../src/sim/input/depth');
    const source = new DepthBridgeSource('ws://bridge', () => {}, () => Date.now());
    await source.start();
    vi.advanceTimersByTime(6500);
    expect(FakeSocket.instances[0].closed).toBe(true);
    expect(FakeSocket.instances.length).toBeGreaterThanOrEqual(2);
    source.stop();
  });

  it('leap: silence reconnects, frames do not, and stop() ends the watchdog', async () => {
    const { LeapSource, DEFAULT_LEAP_BOX } = await import('../../src/sim/input/leap');
    const source = new LeapSource('ws://leap', DEFAULT_LEAP_BOX, () => {}, () => Date.now());
    await source.start();
    const first = FakeSocket.instances[0];
    first.open();
    for (let i = 1; i <= 10; i++) { vi.advanceTimersByTime(1000); first.message({ id: i, timestamp: i * 1e6, hands: [], pointables: [] }); }
    expect(first.closed).toBe(false);
    vi.advanceTimersByTime(6000);
    expect(first.closed).toBe(true);
    vi.advanceTimersByTime(600);
    expect(FakeSocket.instances).toHaveLength(2);
    source.stop();
    const count = FakeSocket.instances.length;
    vi.advanceTimersByTime(60_000);
    expect(FakeSocket.instances).toHaveLength(count);
  });
});
