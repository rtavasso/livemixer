import { describe, it, expect } from 'vitest';
import { ControlsCore, type ControlsMessage, type Mode, type Outgoing } from '../src/ableton/page';
import { RELEASE_AFTER_MS } from '../src/ableton/living';
import { bridgeStatus } from '../src/ableton/controls';
import type { HandTelemetry, TelemetryFrame, TelemetrySchema } from '../src/sim/telemetry/types';

const TICK = 100;
const hand = (id: number): HandTelemetry => ({
  id, x: .5, y: .8, z: .5, vx: 0, vy: 0, vz: 0, speed: 0, radius: .05, openness: .1, pinch: 0, push: 0, palmUp: 1, ageMs: 0, staleMs: 0, solid: 0,
} as HandTelemetry);
const LIVING_SIGNALS = { presence: 1, reach: .6, lift: .8, closeness: .7, agitation: 0 };
function frameOf(options: { presence?: number; sourceAgeMs?: number; signals?: Record<string, number>; id?: string } = {}): TelemetryFrame {
  const presence = options.presence ?? 1;
  return {
    type: 'frame', v: 1, t: 0, seq: 0,
    sim: { id: options.id ?? 'murmuration', params: {}, signals: options.signals ?? { ...LIVING_SIGNALS, presence } },
    input: { source: 'leap', presence, activity: .5, hands: presence > 0 ? [hand(1)] : [], events: [], sourceAgeMs: options.sourceAgeMs ?? 10, stats: {} },
    perf: { fps: 60, stepMs: 1, renderMs: 1 },
  } as unknown as TelemetryFrame;
}
const schemaOf = (signals: Record<string, unknown>, id = 'murmuration') =>
  ({ sim: { id, title: id, description: '', params: {}, signals } } as unknown as TelemetrySchema);
const LIVING_SCHEMA = schemaOf(Object.fromEntries(Object.keys(LIVING_SIGNALS).map(k => [k, { min: 0, max: 1 }])));
const TRAILS_SCHEMA = schemaOf({ energy: { min: 0, max: 1 } }, 'trails');

const controlsIn = (messages: Outgoing[]) => messages.filter((m): m is ControlsMessage => m.type === 'controls');
const maxVocals = (messages: Outgoing[]) => Math.max(0, ...controlsIn(messages).map(m => m.vocals));

/** Drives the core like the page: a tick every 100 ms; `frame` (when given) arrives just before the tick. */
class Page {
  now = 1000; frame: TelemetryFrame | null = null; lastFrame = -Infinity; schema: TelemetrySchema | null = null;
  sent: Outgoing[] = [];
  constructor(public core = new ControlsCore({ mode: 'living', now: 1000 })) {}
  tick(frame?: TelemetryFrame | null): Outgoing[] {
    this.now += TICK;
    if (frame) { this.frame = frame; this.lastFrame = this.now; }
    const { messages } = this.core.tick(this.frame, this.lastFrame, this.now, this.schema);
    this.sent.push(...messages);
    return messages;
  }
  run(seconds: number, frame: () => TelemetryFrame | null | undefined): Outgoing[] {
    const out: Outgoing[] = [];
    for (let i = 0; i < seconds * 1000 / TICK; i++) out.push(...this.tick(frame()));
    return out;
  }
}

describe('controls page decisions (ControlsCore)', () => {
  it('starts at home in every mode: the first message is never the manual vocals', () => {
    for (const mode of ['living', 'manual', 'simulation'] as Mode[]) {
      const core = new ControlsCore({ mode, now: 0 });
      expect(core.current()?.vocals ?? 0).toBe(0);
    }
    const page = new Page();
    const first = controlsIn(page.tick());
    expect(first).toHaveLength(1);
    expect(first[0].vocals).toBe(0);
  });

  it('Living opens vocals only with a fresh hand, and never without one', () => {
    const page = new Page();
    expect(maxVocals(page.run(5, () => frameOf({ presence: 0 })))).toBe(0);
    expect(maxVocals(page.run(5, () => frameOf({ presence: 1, sourceAgeMs: 5000 })))).toBe(0); // stalled input
    expect(maxVocals(page.run(5, () => frameOf({ presence: 1, sourceAgeMs: -1 })))).toBe(0); // never connected
    expect(maxVocals(page.run(5, () => frameOf({ presence: 1 })))).toBeGreaterThan(.9);
  });

  it('a schema without the living contract keeps Living (on the hand alone) instead of freezing the last value in Manual', () => {
    const page = new Page();
    page.schema = LIVING_SCHEMA; page.core.onSchema(LIVING_SCHEMA);
    expect(maxVocals(page.run(5, () => frameOf()))).toBeGreaterThan(.9);
    // Rotation to trails: no contract signals.
    page.schema = TRAILS_SCHEMA;
    expect(page.core.onSchema(TRAILS_SCHEMA)).toBe(false);
    expect(page.core.mode).toBe('living');
    // The hand leaves: vocals fade to 0 and stay there.
    const after = page.run(10, () => frameOf({ id: 'trails', presence: 0, signals: { energy: .4 } }));
    expect(controlsIn(after).at(-1)!.vocals).toBe(0);
    expect(maxVocals(page.run(30, () => frameOf({ id: 'trails', presence: 0, signals: { energy: .4 } })))).toBe(0);
  });

  it('a living schema selects Living only while the operator has not chosen', () => {
    const core = new ControlsCore({ mode: 'manual', now: 0 });
    expect(core.onSchema(LIVING_SCHEMA)).toBe(true);
    expect(core.mode).toBe('living');
    core.setMode('manual', true);
    expect(core.onSchema(LIVING_SCHEMA)).toBe(false);
    expect(core.mode).toBe('manual');
  });

  it('leaving Living with a hand present goes home: Manual sends vocals 0 and no fx', () => {
    const page = new Page();
    expect(maxVocals(page.run(5, () => frameOf()))).toBeGreaterThan(.9);
    page.core.setMode('manual', true);
    const manual = page.run(3, () => frameOf());
    expect(maxVocals(manual)).toBe(0);
    expect(controlsIn(manual).every(m => m.fx === undefined && m.space === 0 && m.stutter === 0 && m.gain === 1)).toBe(true);
    page.core.setMode('simulation', true);
    page.core.setMode('living', true);
    // Back to Living with nobody present: home again, not the old value.
    expect(controlsIn(page.tick(frameOf({ presence: 0 })))[0].vocals).toBe(0);
  });

  it('Simulation mode releases once when stale and never reclaims Live (no vocals 1 while stale)', () => {
    const page = new Page(new ControlsCore({ mode: 'simulation', now: 1000 }));
    const stale = page.run(5, () => null);
    expect(stale.filter(m => m.type === 'release')).toHaveLength(1);
    expect(controlsIn(stale)).toHaveLength(0);
    // Fresh input with a hand: vocals follow presence.
    expect(maxVocals(page.run(2, () => frameOf({ presence: 1 })))).toBeGreaterThan(.5);
    // Input stalls again: one release, then silence, never vocals.
    const again = page.run(5, () => frameOf({ presence: 1, sourceAgeMs: 5000 }));
    expect(again.filter(m => m.type === 'release')).toHaveLength(1);
    expect(controlsIn(again)).toHaveLength(0);
    expect(page.core.value.vocals).toBe(0);
  });

  it('Simulation falls back to vocals 0 when a routed signal is missing', () => {
    const page = new Page(new ControlsCore({ mode: 'simulation', now: 1000, route: { vocals: 'signal.nope' } }));
    expect(maxVocals(page.run(3, () => frameOf({ presence: 1 })))).toBe(0);
  });

  it('Release & reset goes home in every mode', () => {
    const page = new Page();
    page.run(5, () => frameOf());
    expect(page.core.reset()).toEqual([{ type: 'release' }]);
    expect(page.core.current()).toEqual({ type: 'controls', vocals: 0, space: 0, stutter: 0, gain: 1 });
  });

  it('every mode transition with and without hands keeps vocals at 0 unless a fresh hand is in Living or Simulation', () => {
    const modes: Mode[] = ['living', 'manual', 'simulation'];
    for (const from of modes) for (const to of modes) {
      const page = new Page(new ControlsCore({ mode: from, now: 1000 }));
      page.run(3, () => frameOf());
      page.core.setMode(to, true);
      const quiet = page.run(4, () => frameOf({ presence: 0 }));
      const stalled = page.run(4, () => frameOf({ presence: 1, sourceAgeMs: 9999 }));
      // Staying in a hand mode fades (no cut) from the hand that was there; any change of mode starts from home.
      if (from !== to) expect(maxVocals(quiet), `${from} → ${to}`).toBe(0);
      expect(controlsIn(quiet).at(-1)?.vocals ?? 0, `${from} → ${to}`).toBe(0);
      expect(maxVocals(stalled), `${from} → ${to} stalled`).toBe(0);
    }
  });

  it('Living releases once after a long stall and sends nothing more until input returns', () => {
    const page = new Page();
    page.run(2, () => frameOf());
    const stalled = page.run(RELEASE_AFTER_MS / 1000 + 5, () => null);
    expect(stalled.filter(m => m.type === 'release')).toHaveLength(1);
    expect(page.core.current()).toBeNull();
    expect(maxVocals(stalled.slice(50))).toBe(0); // after the 750 ms staleness and the 2.5 s fade
  });
});

describe('bridge status text', () => {
  it('says Live connected only with Live bound and MIDI open', () => {
    expect(bridgeStatus({ type: 'status', live: true, midi: true, midiPort: 'IAC Driver LiveMixer', owner: true })).toMatchObject({ text: 'Live connected', ready: true });
    expect(bridgeStatus({ type: 'status', live: true })).toMatchObject({ text: 'Live connected', ready: true, owner: null, vocalsInLive: null }); // older bridge
    expect(bridgeStatus({ type: 'status', live: false, midi: true })).toMatchObject({ text: 'Bridge connected · waiting for Live device', ready: false });
  });
  it('names a missing MIDI port', () => {
    expect(bridgeStatus({ type: 'status', live: true, midi: false, midiPort: 'IAC Driver LiveMixer' }))
      .toMatchObject({ text: 'MIDI port not available: IAC Driver LiveMixer', ready: false });
    expect(bridgeStatus({ type: 'status', live: true, midi: false }).text).toBe('MIDI port not available: unknown');
  });
  it('says another window is in charge, and keeps saying it when a later status omits owner', () => {
    const first = bridgeStatus({ type: 'status', live: true, midi: true, owner: false });
    expect(first).toMatchObject({ text: 'Another control window is in charge', ready: false, owner: false });
    expect(bridgeStatus({ type: 'status', live: true, midi: true }, first.owner).text).toBe('Another control window is in charge');
    expect(bridgeStatus({ type: 'status', live: true, midi: true, owner: true }, first.owner).text).toBe('Live connected');
  });
  it('reads vocals in Live from the Utility gain (> −0.5 audible)', () => {
    expect(bridgeStatus({ type: 'status', live: true, state: { amount: 0 } }).vocalsInLive).toBe(true);
    expect(bridgeStatus({ type: 'status', live: true, state: { amount: -1 } }).vocalsInLive).toBe(false);
    expect(bridgeStatus({ type: 'status', live: true, state: { amount: -.6 } }).vocalsInLive).toBe(false);
    expect(bridgeStatus({ type: 'status', live: true, state: { beat: 3 } }).vocalsInLive).toBeNull();
    expect(bridgeStatus(null).text).toBe('Bridge connected · waiting for Live device');
  });
});
