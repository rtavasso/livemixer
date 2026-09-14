import { describe, expect, it } from 'vitest';
import { FixedStepper, RateMeter } from '../../src/sim/host/loop';
import { clampSignals, coerceParam, defaultParams, hexToRgb, resolveParams } from '../../src/sim/core/params';
import { approach, hsv, rng, smoothstep, toUniform } from '../../src/sim/core/math';
import { Noise } from '../../src/sim/core/noise';
import { SIMULATIONS, validateRegistry } from '../../src/sim/host/registry';
import { applyUrlOverrides, parseSettings, SettingsStore } from '../../src/sim/host/settings';

describe('fixed stepper', () => {
  it('steps at a constant rate regardless of frame timing', () => {
    const stepper = new FixedStepper(1000 / 60, 12);
    let steps = 0, total = 0;
    stepper.advance(0, () => {});
    for (const now of [16, 33, 50, 51, 120, 200]) { const r = stepper.advance(now, dt => { steps++; total += dt; }); expect(r.alpha).toBeGreaterThanOrEqual(0); expect(r.alpha).toBeLessThan(1); }
    expect(steps).toBe(12); expect(total).toBeCloseTo(12 / 60, 6);
  });
  it('caps the backlog after a stall and reports dropped time', () => {
    const stepper = new FixedStepper(10, 4, 250);
    stepper.advance(0, () => {});
    let steps = 0;
    const r = stepper.advance(5000, () => steps++);
    expect(steps).toBe(4); expect(r.droppedMs).toBeGreaterThan(4900);
    expect(stepper.advance(5010, () => steps++).steps).toBe(1);
  });
  it('rejects a non-positive step and ignores clock going backwards', () => {
    expect(() => new FixedStepper(0)).toThrow();
    const stepper = new FixedStepper(10); stepper.advance(100, () => {});
    expect(stepper.advance(50, () => { throw new Error('should not step'); }).steps).toBe(0);
  });
  it('rate meter converges on the frame rate', () => {
    const meter = new RateMeter(.2);
    for (let i = 0; i <= 120; i++) meter.tick(i * 1000 / 60);
    expect(meter.value).toBeCloseTo(60, 0);
  });
});

describe('params', () => {
  const specs = {
    size: { kind: 'number', default: .5, min: 0, max: 1, step: .1 },
    on: { kind: 'boolean', default: true },
    mode: { kind: 'select', default: 'a', options: ['a', 'b'] },
    tint: { kind: 'color', default: '#ff0000' },
  } as const;
  it('produces defaults and coerces untrusted input', () => {
    expect(defaultParams(specs)).toEqual({ size: .5, on: true, mode: 'a', tint: '#ff0000' });
    expect(coerceParam(specs.size, '0.74')).toBeCloseTo(.7, 9);
    expect(coerceParam(specs.size, 9)).toBe(1); expect(coerceParam(specs.size, 'x')).toBeUndefined(); expect(coerceParam(specs.size, NaN)).toBeUndefined();
    expect(coerceParam(specs.on, 'false')).toBe(false); expect(coerceParam(specs.on, 'maybe')).toBeUndefined();
    expect(coerceParam(specs.mode, 'b')).toBe('b'); expect(coerceParam(specs.mode, 'c')).toBeUndefined();
    expect(coerceParam(specs.tint, '#ABCDEF')).toBe('#abcdef'); expect(coerceParam(specs.tint, 'red')).toBeUndefined();
  });
  it('resolves overrides while dropping invalid ones', () => {
    expect(resolveParams(specs, { size: 2, on: 'true', mode: 'zzz', extra: 1 })).toEqual({ size: 1, on: true, mode: 'a', tint: '#ff0000' });
  });
  it('clamps signals and reports violations', () => {
    const result = clampSignals({ a: { min: 0, max: 1, description: 'a' }, b: { min: -1, max: 1, description: 'b' } }, { a: 1.5, b: NaN });
    expect(result.values).toEqual({ a: 1, b: -1 }); expect(result.violations).toHaveLength(2);
  });
  it('parses colours', () => { expect(hexToRgb('#ff8000')).toEqual([1, 128 / 255, 0]); });
});

describe('math and noise', () => {
  it('approach is frame-rate independent', () => {
    let a = 0; for (let i = 0; i < 10; i++) a = approach(a, 1, .01, .1);
    const b = approach(0, 1, .1, .1);
    expect(a).toBeCloseTo(b, 6);
  });
  it('helpers behave', () => {
    expect(smoothstep(0, 1, .5)).toBe(.5); expect(toUniform({ x: .5, y: .5 }, 2)).toEqual({ x: 1, y: .5 });
    expect(hsv(0, 1, 1)).toEqual([1, 0, 0]); expect(hsv(1 / 3, 1, 1)[1]).toBe(1);
    const r1 = rng(7), r2 = rng(7); expect(r1()).toBe(r2()); expect(r1()).not.toBe(r1());
  });
  it('noise is deterministic, bounded, and curl is divergence-free-ish', () => {
    const n = new Noise(3), m = new Noise(3);
    expect(n.noise3(.3, .7, 1.1)).toBe(m.noise3(.3, .7, 1.1));
    for (let i = 0; i < 200; i++) { const v = n.fbm3(i * .13, i * .07, .5); expect(Math.abs(v)).toBeLessThanOrEqual(1); }
    const eps = 1e-3, x = 1.3, y = 2.1;
    const div = (n.curl2(x + eps, y, 0).x - n.curl2(x - eps, y, 0).x) / (2 * eps) + (n.curl2(x, y + eps, 0).y - n.curl2(x, y - eps, 0).y) / (2 * eps);
    expect(Math.abs(div)).toBeLessThan(.5);
  });
});

describe('registry', () => {
  it('has unique, well-formed simulations', () => { expect(validateRegistry()).toEqual([]); expect(SIMULATIONS.length).toBeGreaterThanOrEqual(5); });
  it('flags bad definitions', () => {
    const bad = [{ id: 'Bad Id', title: '', description: '', params: { 'bad-name': { kind: 'number', default: 5, min: 0, max: 1 } }, signals: { s: { min: 1, max: 0, description: '' } }, stepHz: 1, create: () => { throw new Error(); } }] as never;
    expect(validateRegistry(bad).length).toBeGreaterThanOrEqual(5);
  });
});

describe('settings', () => {
  it('falls back per key on invalid stored data', () => {
    const s = parseSettings({ sim: 'basin', quality: 'ultra', maxDpr: 'x', solid: 'bogus', telemetry: { rateHz: 20 } });
    expect(s.sim).toBe('basin'); expect(s.quality).toBe('medium'); expect(s.maxDpr).toBe(1.25); expect(s.solid).toBe('both'); expect(s.telemetry.rateHz).toBe(20);
    expect(parseSettings({ solid: 'scan' }).solid).toBe('scan');
  });
  it('applies URL overrides', () => {
    const s = applyUrlOverrides(parseSettings({}), '?sim=prism&source=depth&bridge=ws://cam:1&ws=ws://audio:2&overlay=0&quality=low&dpr=1&rate=15&solid=skeleton');
    expect(s).toMatchObject({ sim: 'prism', source: 'depth', overlay: false, quality: 'low', maxDpr: 1, solid: 'skeleton', depth: { url: 'ws://cam:1' }, telemetry: { websocketUrl: 'ws://audio:2', rateHz: 15 } });
    expect(applyUrlOverrides(parseSettings({}), '?solid=nope').solid).toBe('both');
  });
  it('persists through a storage shim', () => {
    const store: Record<string, string> = {};
    const storage = { getItem: (k: string) => store[k] ?? null, setItem: (k: string, v: string) => { store[k] = v; } };
    const a = new SettingsStore(storage); a.update(s => { s.sim = 'veil'; }); a.flush();
    expect(new SettingsStore(storage).value.sim).toBe('veil');
  });
});
