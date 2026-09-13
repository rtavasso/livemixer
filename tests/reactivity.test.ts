import { describe, expect, it } from 'vitest';
import { PerformanceSession, type SessionInput } from '../src/music/session';
import { changeClockRate, beatSeconds } from '../src/music/transport';
import { desireRecipe, dropUncommitted, idleTransport, plan, requestAdvance, startTransport, type ResponseTiming } from '../src/music/planner';
import { RawReplayAdapter, replayRawControl } from '../src/control/replay';
import { TraceRecorder, parseTrace } from '../src/trace';
import { testEnvironment } from './helpers';
const env = testEnvironment();
const started = (timing: ResponseTiming) => startTransport({ ...idleTransport(), timing }, env, 0).state;
describe('reactive playing', () => {
  it('switches recipes and passages at the next beat even in the first loop', () => {
    env.manifest.scenes[0].recipeQuantizationBars = 4;
    const s = started('beat');
    const recipe = plan(desireRecipe(s, 'open', 'manual'), env, .46).state.committedRecipe!;
    const passage = plan(requestAdvance(s, 'manual'), env, .46).state.committedAdvance!;
    expect(recipe.end).toBeCloseTo(.6); expect(passage.at).toBeCloseTo(.6);
    expect(passage.fadeStart).toBeCloseTo(.58); expect(recipe.start).toBeCloseTo(.58);
    expect(passage.recipe).toBe('sparse');
  });
  it('immediate changes keep scheduling lead but take less than 100 ms', () => {
    const s = started('immediate');
    for (const at of [.27, 1.2, 18.42]) {
      const recipe = plan(desireRecipe(s, 'open', 'manual'), env, at).state.committedRecipe!;
      const passage = plan(requestAdvance(s, 'manual'), env, at).state.committedAdvance!;
      expect(recipe.end - at).toBeCloseTo(.08); expect(recipe.start - at).toBeGreaterThanOrEqual(.059);
      expect(passage.at - at).toBeCloseTo(.08);
    }
  });
  it('coalesces uncommitted reversals and never revives canceled vocals on advance', () => {
    let s = plan(desireRecipe(started('beat'), 'open', 'camera'), env, .2).state;
    s = dropUncommitted(s, 'camera');
    const next = plan(requestAdvance(s, 'manual'), env, .46).state.committedAdvance!;
    expect(next.recipe).toBe('sparse');
    s = desireRecipe(s, 'sparse', 'manual'); expect(plan(s, env, .46).actions).toEqual([]);
  });
  it('finishes a committed reversal before applying the latest choice', () => {
    let s = plan(desireRecipe(started('immediate'), 'open', 'manual'), env, .2).state;
    s = desireRecipe(s, 'sparse', 'manual');
    expect(plan(s, env, .25).actions).toEqual([]);
    const next = plan(s, env, .3).state.committedRecipe!;
    expect(next.recipe).toBe('sparse'); expect(next.end).toBeCloseTo(.38);
  });
  it('retains already committed vocals when cancel is followed by advance', () => {
    let s = plan(desireRecipe(started('immediate'), 'open', 'manual'), env, .2).state;
    s = { ...s, recipeIntent: false };
    const a = plan(requestAdvance(s, 'manual'), env, .225).state.committedAdvance!;
    expect(a.recipe).toBe('open'); expect(a.fadeStart).toBeGreaterThanOrEqual(s.committedRecipe!.end);
  });
  it('rebases the musical clock without changing source phase through repeated speed changes', () => {
    let clock = started('beat').clock, speed = 1;
    for (const [at, next] of [[3, 1.1], [9, .9], [81, 1], [999, 1.05]]) {
      const phase = (at - clock.start) / clock.duration;
      clock = changeClockRate(clock, at, speed, next); speed = next;
      expect((at - clock.start) / clock.duration).toBeCloseTo(phase, 10);
      expect(beatSeconds(clock)).toBeCloseTo(.5 / speed);
    }
  });
  it('uses shared render quanta, retains speed across reset/restart, and preserves newest requests', () => {
    const session = new PerformanceSession({ ...env, sampleRate: 44100 });
    const send = (input: SessionInput, at: number) => session.dispatch(input, at * 1000, at);
    send({ type: 'timing', timing: 'beat' }, 0); send({ type: 'start' }, 0);
    send({ type: 'rate', rate: 1.1 }, .4);
    const action = send({ type: 'tick' }, .48)[0];
    expect(action.type).toBe('SetPlaybackRate'); if (action.type !== 'SetPlaybackRate') throw new Error('missing speed action');
    expect(action.at).toBeGreaterThanOrEqual(.6); expect(action.at).toBeLessThan(.603);
    expect(action.at * 44100 / 128).toBeCloseTo(Math.round(action.at * 44100 / 128));
    send({ type: 'rate', rate: .9 }, .5); expect(send({ type: 'tick' }, .55)).toEqual([]);
    send({ type: 'tick' }, .61); expect(session.state.rate).toBe(1.1); expect(session.state.desiredRate).toBe(.9);
    send({ type: 'timing', timing: 'immediate' }, .62); send({ type: 'advance' }, .62);
    const reset = send({ type: 'tick' }, .625)[0]; expect(reset).toMatchObject({ type: 'CommitSceneReset', rate: .9, clock: { duration: 9.6 / .9 } });
    send({ type: 'stop' }, .7); const restart = send({ type: 'start' }, 1)[0];
    expect(restart).toMatchObject({ rate: .9, clock: { duration: 8 / .9 } }); expect(session.state.timing).toBe('immediate');
  });
  it('validates speed controls and round-trips timing and speed through raw replay', () => {
    const session = new PerformanceSession(env), recorder = new TraceRecorder(0, { sampleRate: 44100 });
    for (const rate of [NaN, Infinity, .89, 1.11]) expect(() => session.dispatch({ type: 'rate', rate }, 0, 0)).toThrow();
    const inputs: SessionInput[] = [{ type: 'timing', timing: 'immediate' }, { type: 'mode', mode: 'timbre_only' }, { type: 'start' }, { type: 'rate', rate: 1.1 }, { type: 'frame', frame: { sequence: 0, source: 'slider', valid: true, observedAtMs: 0, receivedAtMs: 0, values: { openness: .5 } } }];
    inputs.forEach(input => recorder.input(input, 0, 0));
    for (let ms = 25; ms <= 1000; ms += 25) recorder.input({ type: 'tick' }, ms, ms / 1000);
    const rows = parseTrace(recorder.jsonl());
    const a = replayRawControl(rows, env), b = replayRawControl(rows, { ...env, sampleRate: 96000 });
    expect(a.actions).toEqual(b.actions); expect(a.session.state.rate).toBe(1.1);
    expect(new RawReplayAdapter(rows, 0).due(0)).toEqual(inputs.map(input => input.type === 'frame' ? { ...input, frame: { ...input.frame, source: 'replay' } } : input));
  });
});
