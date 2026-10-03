import { describe, it, expect } from 'vitest';
import { freshness, livingSignals, LivingDriver, RELEASE_AFTER_MS, type LivingStep } from '../src/ableton/living';
import { GESTURE_HOME, type LiveControls } from '../src/living/governor';
import type { HandTelemetry, TelemetryFrame } from '../src/sim/telemetry/types';

const TICK = 100;
const hand = (pose: Partial<HandTelemetry> & { id: number }): HandTelemetry => ({
  x: .5, y: .8, z: .5, vx: 0, vy: 0, vz: 0, speed: 0, radius: .05, openness: .1, pinch: 0, push: 0, palmUp: 1, ageMs: 0, staleMs: 0, solid: 0, ...pose,
});
function frameOf(options: { presence?: number; sourceAgeMs?: number; hands?: HandTelemetry[]; signals?: Record<string, number> } = {}): TelemetryFrame {
  const presence = options.presence ?? 1;
  return {
    type: 'frame', v: 1, t: 0, seq: 0,
    sim: { id: 'test', params: {}, signals: options.signals ?? { presence, reach: .6, lift: .8, closeness: .7, agitation: 0 } },
    input: { source: 'mouse', presence, activity: 0, hands: options.hands ?? [hand({ id: 1 })], events: [], sourceAgeMs: options.sourceAgeMs ?? 10, stats: {} },
    perf: { fps: 60, stepMs: 1, renderMs: 1 },
  } as unknown as TelemetryFrame;
}
const controls = (step: LivingStep) => { expect(step.message?.type).toBe('controls'); return step.message as LiveControls; };

/** Drives the driver like the page: a tick every 100 ms, frames arriving while `frameAt(t)` returns one. */
class Page {
  driver = new LivingDriver();
  now = 0; frame: TelemetryFrame | null = null; lastFrame = -Infinity;
  tick(frame: TelemetryFrame | null | undefined): LivingStep {
    this.now += TICK;
    if (frame) { this.frame = frame; this.lastFrame = this.now; }
    return this.driver.step(this.frame, this.lastFrame, this.now, TICK / 1000);
  }
  run(seconds: number, frame: () => TelemetryFrame | null | undefined): LivingStep[] {
    return Array.from({ length: Math.round(seconds * 1000 / TICK) }, () => this.tick(frame()));
  }
}

describe('living freshness', () => {
  it('is stale without frames, with old frames, and with stalled or never-connected input', () => {
    expect(freshness(null, 0, 0)).toBe('no-frames');
    expect(freshness(frameOf(), 0, 751)).toBe('no-frames');
    expect(freshness(frameOf(), 0, 700)).toBe('fresh');
    expect(freshness(frameOf({ sourceAgeMs: -1 }), 0, 0)).toBe('input-stale');
    expect(freshness(frameOf({ sourceAgeMs: 900 }), 0, 0)).toBe('input-stale');
    expect(freshness(frameOf({ sourceAgeMs: NaN }), 0, 0)).toBe('input-stale');
  });
  it('treats presence as 0 when input is stale, whatever the simulation still reports', () => {
    const frozen = frameOf({ sourceAgeMs: 5000 });
    expect(livingSignals(frozen, false).presence).toBe(0);
    expect(livingSignals(frozen, false).reach).toBe(.6);
    expect(livingSignals(frameOf(), true).presence).toBe(1);
    expect(livingSignals(frameOf({ presence: .4, signals: {} }), true).presence).toBe(.4);
    expect(livingSignals(null, false)).toEqual({});
  });
});

describe('living fail-safe', () => {
  it('fades vocals to the instrumental home over seconds when frames stop, never jumping or blasting', () => {
    const page = new Page();
    const before = page.run(3, () => frameOf());
    expect(controls(before.at(-1)!).vocals).toBe(1);
    const after = page.run(5, () => undefined).map(controls);
    const vocals = after.map(c => c.vocals);
    for (let i = 1; i < vocals.length; i++) {
      expect(vocals[i]).toBeLessThanOrEqual(vocals[i - 1]);
      expect(vocals[i - 1] - vocals[i]).toBeLessThan(.06);
    }
    // Still above zero a second into the stall (the fade takes the governor's 2.5 s release), home by the end.
    expect(vocals[Math.round(1750 / TICK)]).toBeGreaterThan(.3);
    expect(vocals.at(-1)).toBe(0);
    const last = after.at(-1)!;
    expect(last.fx.dive).toBeLessThan(.02);
    expect(last.fx.muffleRhythm).toBeCloseTo(GESTURE_HOME.muffleRhythm, 2);
    expect(last.fx.tiltMelodic).toBeCloseTo(GESTURE_HOME.tiltMelodic, 2);
  });

  it('eases the hand gestures home rather than snapping them', () => {
    const page = new Page();
    page.run(3, () => frameOf());
    const held = controls(page.tick(frameOf())).fx.muffleRhythm;
    expect(held).toBeGreaterThan(.5);
    const firstStale = page.run(.9, () => undefined).map(controls).at(-1)!;
    expect(firstStale.fx.muffleRhythm).toBeGreaterThan(.1);
  });

  it('fades the same way when the input stalls but the simulation keeps sending frozen signals', () => {
    const page = new Page();
    page.run(3, () => frameOf());
    const vocals = page.run(5, () => frameOf({ sourceAgeMs: 5000 })).map(s => controls(s).vocals);
    expect(vocals[2]).toBeGreaterThan(.5);
    expect(vocals.at(-1)).toBe(0);
  });

  it('holds home with vocals off when the input never connected (sourceAgeMs −1)', () => {
    const page = new Page();
    const steps = page.run(3, () => frameOf({ sourceAgeMs: -1 }));
    for (const step of steps) {
      expect(step.state).toBe('input-stale');
      expect(controls(step).vocals).toBe(0);
    }
  });

  it('releases once after a long stall, then stays quiet until input returns', () => {
    const page = new Page();
    page.run(2, () => frameOf());
    const steps = page.run(RELEASE_AFTER_MS / 1000 + 5, () => undefined);
    const releases = steps.filter(s => s.message?.type === 'release');
    expect(releases).toHaveLength(1);
    const at = steps.findIndex(s => s.message?.type === 'release');
    expect((at + 1) * TICK).toBeGreaterThanOrEqual(RELEASE_AFTER_MS);
    expect(steps.slice(0, at).every(s => s.message?.type === 'controls')).toBe(true);
    expect(steps.slice(at + 1).every(s => s.message === null)).toBe(true);
  });

  it('recovers from a long stall without a jump: the song starts again from home', () => {
    const page = new Page();
    page.run(2, () => frameOf());
    page.run(RELEASE_AFTER_MS / 1000 + 1, () => undefined);
    const back = page.run(2, () => frameOf()).map(controls);
    expect(back[0].vocals).toBeLessThan(.3);
    expect(back[0].fx.dive).toBeLessThan(.2);
    for (let i = 1; i < back.length; i++) expect(Math.abs(back[i].vocals - back[i - 1].vocals)).toBeLessThan(.3);
    expect(back.at(-1)!.vocals).toBe(1);
  });

  it('recovers from a short stall from where the fade had got to', () => {
    const page = new Page();
    page.run(3, () => frameOf());
    const faded = controls(page.run(1, () => undefined).at(-1)!).vocals;
    const back = controls(page.tick(frameOf())).vocals;
    expect(back).toBeGreaterThanOrEqual(faded);
    expect(back - faded).toBeLessThan(.3);
  });
});
