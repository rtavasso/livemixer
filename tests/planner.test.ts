import { describe, expect, it } from 'vitest';
import { desireRecipe, dropUncommitted, idleTransport, plan, requestAdvance, startTransport, stopTransport } from '../src/music/planner';
import { boundary, nextBoundary } from '../src/music/transport';
import { PerformanceSession } from '../src/music/session';
import { replayRawControl } from '../src/control/replay';
import type { TraceInput } from '../src/trace';
import { testEnvironment } from './helpers';
const env = testEnvironment();
const started = () => startTransport(idleTransport(), env, 0).state;
describe('musical clock and recipe scheduling', () => {
  it('derives integer boundaries from decoded duration over long runs', () => {
    const clock = { start: .1, duration: 9.60002083333, loopBars: 4, beatsPerBar: 4 };
    expect(boundary(clock, 10000, 1)).toBe(clock.start + 10000 * clock.duration / 4);
    expect(nextBoundary(clock, 12.1, 1).at).toBeGreaterThanOrEqual(12.1);
  });
  it('ramps to the next boundary with sufficient lead; late submissions defer', () => {
    const state = desireRecipe(started(), 'open', 'slider');
    const onTime = plan(state, env, 1.95); expect(onTime.actions).toHaveLength(1);
    expect(onTime.state.committedRecipe).toMatchObject({ start: 2.08, end: 2.1 });
    const late = plan(state, env, 2.04); expect(late.actions).toHaveLength(0); expect(late.state.pendingRecipe!.end).toBe(4.1);
  });
  it('latest uncommitted request wins with no FIFO', () => {
    let state = plan(desireRecipe(started(), 'open', 'slider'), env, .5).state;
    state = plan(desireRecipe(state, 'pulse', 'slider'), env, .6).state;
    state = plan(desireRecipe(state, 'sparse', 'slider'), env, 1.95).state;
    expect(state.pendingRecipe).toBeNull(); expect(state.committedRecipe).toBeNull();
  });
  it('committed reversal finishes atomically before scheduling newest desire', () => {
    let state = plan(desireRecipe(started(), 'open', 'slider'), env, 1.95).state;
    state = desireRecipe(state, 'sparse', 'slider');
    const waiting = plan(state, env, 2.05); expect(waiting.actions).toHaveLength(0); expect(waiting.state.committedRecipe?.recipe).toBe('open');
    const done = plan(waiting.state, env, 2.11).state; expect(done.currentRecipe).toBe('open'); expect(done.pendingRecipe?.recipe).toBe('sparse'); expect(done.pendingRecipe?.end).toBe(4.1);
  });
  it('whole-loop grids defer vocal recipe changes to complete phrases', () => {
    const vocals = testEnvironment(); vocals.manifest.scenes[0].recipeQuantizationBars = 4;
    expect(plan(desireRecipe(started(), 'open', 'slider'), vocals, 1.95).state.pendingRecipe?.end).toBe(8.1);
  });
  it('a main-thread stall never creates a mid-bar catch-up action', () => {
    const state = desireRecipe(started(), 'open', 'slider');
    const result = plan(state, env, 6.09); expect(result.actions).toEqual([]); expect(result.state.pendingRecipe?.end).toBe(8.1);
  });
});
describe('atomic native-tempo scene reset', () => {
  it('commits both sides before fade start and derives the new origin after a stall', () => {
    const state = requestAdvance(started(), 'manual');
    const committed = plan(state, env, 7.47); expect(committed.actions).toHaveLength(1);
    expect(committed.state.committedAdvance).toMatchObject({ fadeStart: 7.6, at: 8.1, recipe: 'sparse', clock: { duration: 9.6 } });
    const after = plan(committed.state, env, 9).state; expect(after.sceneId).toBe('b'); expect(after.clock.start).toBe(8.1); expect(after.clock.duration).toBe(9.6);
  });
  it('defers a late exit and conflicts with already-committed recipe ramps', () => {
    const state = requestAdvance(started(), 'manual');
    expect(plan(state, env, 7.57).state.pendingAdvance?.at).toBe(16.1);
    state.committedRecipe = { type: 'RampRecipe', id: 2, generation: 1, sceneId: 'a', recipe: 'open', start: 8.08, end: 8.1 };
    expect(plan(state, env, 7.47).state.pendingAdvance?.at).toBe(16.1);
  });
  it('freezes outgoing recipes after reset commits; incoming initial recipe is captured', () => {
    let state = requestAdvance(desireRecipe(started(), 'open', 'slider'), 'manual');
    state = plan(state, env, 7.47).state; state = desireRecipe(state, 'sparse', 'slider');
    expect(plan(state, env, 7.7).actions).toEqual([]); expect(state.committedAdvance?.recipe).toBe('open');
    const incoming = plan(state, env, 8.2).state; expect(incoming.currentRecipe).toBe('open'); expect(incoming.pendingRecipe?.end).toBe(10.5);
  });
  it.each(['unready', 'unapproved'])('never fades out for an %s incoming scene', failure => {
    const failed = testEnvironment();
    if (failure === 'unready') delete failed.scenes.b; else failed.edgeErrors['a→b'] = 'Unapproved edge';
    const result = plan(requestAdvance(started(), 'manual'), failed, 7.47);
    expect(result.actions).toEqual([]); expect(result.state.running).toBe(true); expect(result.state.error).toBeTruthy();
  });
  it('drops only uncommitted camera requests on sustained loss', () => {
    const requested = requestAdvance(desireRecipe(started(), 'open', 'camera'), 'camera');
    const dropped = dropUncommitted(requested, 'camera'); expect(dropped.recipeIntent).toBe(false); expect(dropped.desiredRecipe).toBe('open'); expect(dropped.pendingAdvance).toBeNull();
    const committed = plan(requested, env, 7.47).state;
    expect(dropUncommitted(committed, 'camera').committedAdvance).toEqual(committed.committedAdvance);
  });
  it('increments transport generation for stop and restart', () => {
    const first = started(), stopped = stopTransport(first, 1).state, next = startTransport(stopped, env, 2).state;
    expect(stopped.generation).toBeGreaterThan(first.generation); expect(next.generation).toBeGreaterThan(stopped.generation);
  });
});
it('replays the same raw trace into identical actions with recorded audio timing', () => {
  const rows: TraceInput[] = [{ type: 'input', atMs: 0, audioTime: 0, input: { type: 'start' } }];
  for (let at = 0; at < 17000; at += 25) {
    rows.push({ type: 'input', atMs: at, audioTime: at / 1000, input: { type: 'frame', frame: { sequence: at, observedAtMs: at, receivedAtMs: at, source: 'slider', valid: true, values: { openness: at < 1000 || at > 9000 ? .1 : 1 } } } });
    if (at === 5000) rows.push({ type: 'input', atMs: at, audioTime: at / 1000, input: { type: 'advance' } });
    rows.push({ type: 'input', atMs: at, audioTime: at / 1000, input: { type: 'tick' } });
  }
  const actual = new PerformanceSession(env), actions = rows.flatMap(r => actual.dispatch(r.input, r.atMs, r.audioTime));
  expect(replayRawControl(rows, env).actions.map(a => a.action)).toEqual(actions);
  expect(actions.some(a => a.type === 'RampRecipe')).toBe(true); expect(actions.some(a => a.type === 'CommitSceneReset')).toBe(true);
});
