import { describe, expect, it } from 'vitest';
import { defaultPatch, parsePatch, PATCH_KEY, readPatch, savePatch, TARGETS } from '../src/integration/patch';
import { SimulationModulation, STALE_OUTPUT_MS, toSpaceState } from '../src/integration/modulation';
import type { SimulationOutput } from '../src/sim/core/output';
import { SIMULATIONS } from '../src/sim/host/registry';
import { settingsSchema } from '../src/sim/host/settings';
import { PerformanceSession } from '../src/music/session';
import { testManifest } from './helpers';
import { TraceRecorder } from '../src/trace';
import { replayRawControl } from '../src/control/replay';

const patch = () => {
  const p = defaultPatch(settingsSchema.parse({ sim: 'basin' }));
  for (const target of TARGETS) p.routes[target].smoothingMs = 0;
  return p;
};
const frame = (atMs: number, signals = { energy: .8, rotation: -.5, swirl: .4 }): SimulationOutput => ({ simId: 'basin', atMs, signals, input: { presence: 0, activity: 0 } });

describe('portable performance patches', () => {
  it('provides a valid preset for every registered simulation', () => {
    for (const sim of SIMULATIONS) {
      const p = defaultPatch(settingsSchema.parse({ sim: sim.id }));
      expect(parsePatch(JSON.parse(JSON.stringify(p)))).toEqual(p);
      expect(Object.keys(p.settings.params[sim.id])).toEqual(Object.keys(sim.params));
    }
  });
  it('loads earlier material patches with defaults while preserving authored controls and routes', () => {
    for (const [sim, added, authored, value] of [
      ['basin', ['ripples', 'glaze', 'elevation', 'ceramicTexture'], 'viscosity', .45],
      ['veil', ['fabric', 'sheen'], 'opacity', .2],
      ['prism', ['roughness'], 'dispersion', 1],
    ] as const) {
      const p = defaultPatch(settingsSchema.parse({ sim }));
      for (const name of added) delete p.settings.params[sim][name];
      p.settings.params[sim][authored] = value;
      p.routes.engagement.outputMax = .8;
      const restored = parsePatch(JSON.parse(JSON.stringify(p)));
      expect(restored.settings.params[sim][authored]).toBe(value);
      expect(restored.routes).toEqual(p.routes);
      for (const name of added) expect(restored.settings.params[sim][name]).toBeDefined();
    }
  });
  it('rejects unavailable simulations, removed signals, bad parameters and unsupported versions', () => {
    const p = patch();
    expect(() => parsePatch({ ...p, version: 2 })).toThrow();
    expect(() => parsePatch({ ...p, settings: { ...p.settings, sim: 'absent' } })).toThrow(/not installed/);
    p.routes.balance.source = 'signal.absent'; expect(() => parsePatch(p)).toThrow(/Unknown signal/);
    const q = patch(); q.settings.params.basin.absent = 2; expect(() => parsePatch(q)).toThrow(/Invalid parameter/);
    const s = patch(); s.settings.params.basin.ink = Infinity; expect(() => parsePatch(s)).toThrow();
  });
  it('rejects invalid mapping ranges and replay input without an accompanying recording', () => {
    for (const value of [NaN, Infinity, -1, 1.01]) {
      const p = patch(); p.routes.space.outputMax = value; expect(() => parsePatch(p)).toThrow();
    }
    const p = patch(); p.routes.balance.inputMax = p.routes.balance.inputMin; expect(() => parsePatch(p)).toThrow();
    const r = patch(); r.settings.source = 'replay'; expect(() => parsePatch(r)).toThrow(/Replay files/);
  });
  it('keeps the selected simulation configuration, calibration and mappings through storage', () => {
    const data = new Map<string, string>(), storage = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); } };
    const p = patch(); p.settings.volumeDepth = 1.7; p.settings.solid = 'skeleton'; p.settings.params.basin.ink = .07;
    p.routes.balance.outputMin = .9; p.routes.balance.outputMax = .1;
    savePatch(storage, p); expect(readPatch(storage)).toEqual(p);
    storage.setItem(PATCH_KEY, '{broken'); expect(readPatch(storage)).toBeNull();
    expect(readPatch(null)).toBeNull();
  });
});

describe('simulation-driven modulation', () => {
  it('uses the simulated water state even after the hand has left, including signed rotation', () => {
    const mixer = new SimulationModulation(patch());
    expect(mixer.sample(frame(100), 100)).toEqual({ engagement: .8, balance: .25, space: .4 });
    expect(toSpaceState(mixer.sample(frame(125), 125))).toEqual({ enabled: true, presence: .8, height: .25, depth: .4 });
  });
  it('supports narrowed input ranges, inverted output ranges, clamping and constants', () => {
    const p = patch(); p.routes.engagement.inputMax = .1;
    p.routes.balance.outputMin = .9; p.routes.balance.outputMax = .1;
    p.routes.space.source = 'constant'; p.routes.space.outputMin = .65;
    const state = new SimulationModulation(p).sample(frame(100), 100);
    expect(state.engagement).toBe(1); expect(state.balance).toBeCloseTo(.7); expect(state.space).toBe(.65);
  });
  it('releases stale, invalid, future, reordered and wrong-simulation output', () => {
    const invalid: (SimulationOutput | null)[] = [null, { ...frame(100), simId: 'veil' }, { ...frame(100), signals: {} }, frame(99), frame(1e5), { ...frame(100), signals: { energy: NaN, rotation: 0, swirl: 0 } }];
    for (const output of invalid) {
      const mapper = new SimulationModulation(patch()); mapper.sample(frame(100), 100);
      expect(mapper.sample(output, 125).engagement).toBe(0);
    }
    const mapper = new SimulationModulation(patch()); mapper.sample(frame(100), 100);
    expect(mapper.sample(frame(100), 100 + STALE_OUTPUT_MS + 1).engagement).toBe(0);
    expect(mapper.sample(frame(700), 700).engagement).toBe(.8);
  });
  it('smooths by elapsed time independently of sampling cadence', () => {
    const p = patch(); p.routes.engagement.smoothingMs = 200;
    const run = (step: number) => {
      const mapper = new SimulationModulation(p); mapper.sample(frame(0), 0);
      for (let t = step; t < 400; t += step) mapper.sample(frame(t), t);
      return mapper.sample(frame(400), 400).engagement;
    };
    expect(run(20)).toBeCloseTo(.8 * (1 - Math.exp(-2)), 12);
    expect(run(20)).toBeCloseTo(run(50), 12);
  });
  it('resets without inheriting previous engagement and never emits nonfinite controls', () => {
    const mapper = new SimulationModulation(patch()); mapper.sample(frame(100), 100); mapper.reset();
    expect(mapper.sample(null, 150).engagement).toBe(0);
    expect(Object.values(mapper.sample(frame(200), NaN)).every(Number.isFinite)).toBe(true);
  });
  it('records mapped controls and replays the same mixer state without running a renderer', () => {
    const manifest = testManifest(), environment = { manifest, sampleRate: 48000, scenes: Object.fromEntries(manifest.scenes.map(s => [s.id, { duration: 8 }])), edgeErrors: {} };
    const session = new PerformanceSession(environment, 0), trace = new TraceRecorder(0, { sampleRate: 48000 });
    const mapper = new SimulationModulation(patch());
    for (const t of [0, 25, 50]) {
      const event = { type: 'space' as const, state: toSpaceState(mapper.sample(frame(t), t)) };
      session.dispatch(event, t, t / 1000); trace.input(event, t, t / 1000);
    }
    expect(replayRawControl(trace.records, environment).session.space).toEqual(session.space);
  });
});
