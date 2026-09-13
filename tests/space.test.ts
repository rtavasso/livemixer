import { describe, expect, it } from 'vitest';
import { defaultBounds, HandSpace, positionInSpace, validBounds, validateSpace } from '../src/control/space';
import { PerformanceSession } from '../src/music/session';
import { RawReplayAdapter, replayRawControl } from '../src/control/replay';
import { testEnvironment } from './helpers';
import type { TraceRecord } from '../src/trace';
import { analyzeActivity } from '../src/audio/activity';
import type { LoadedScene } from '../src/audio/assets';

describe('continuous hand space', () => {
  it('maps comfortable palm positions, including reversed depth, without finger gestures', () => {
    expect(positionInSpace({ id: 1, x: 0, y: 120, z: 150 }, defaultBounds)).toEqual({ presence: 1, height: 0, depth: 0 });
    expect(positionInSpace({ id: 1, x: 0, y: 420, z: -150 }, defaultBounds)).toEqual({ presence: 1, height: 1, depth: 1 });
    expect(positionInSpace({ id: 1, x: 0, y: 270, z: 150 }, { ...defaultBounds, front: -150, back: 150 })?.depth).toBe(1);
  });
  it('fades through a soft boundary and rejects nonfinite positions', () => {
    expect(positionInSpace({ id: 1, x: 212.5, y: 270, z: 0 }, defaultBounds)?.presence).toBe(.5);
    expect(positionInSpace({ id: 1, x: 230, y: 270, z: 0 }, defaultBounds)).toBeNull();
    expect(positionInSpace({ id: 1, x: NaN, y: 270, z: 0 }, defaultBounds)).toBeNull();
    expect(validBounds({ ...defaultBounds, top: 110 })).toBe(false);
    expect(validBounds({ ...defaultBounds, front: 150, back: 150 })).toBe(false);
    expect(() => validateSpace({ enabled: true, presence: 1, height: Infinity, depth: 0 })).toThrow();
  });
  it('holds a still hand indefinitely and tolerates a brief dropout before releasing', () => {
    const hand = new HandSpace(), palm = { id: 1, x: 0, y: 270, z: 0, visibleMs: 100 };
    for (let t = 0; t < 10000; t += 100) expect(hand.observe([palm], t).presence).toBe(1);
    expect(hand.observe([], 10000).presence).toBe(1);
    expect(hand.sample(10140).presence).toBe(1);
    expect(hand.sample(10300).presence).toBe(0);
    expect(hand.observe([palm], 10400).presence).toBe(1);
  });
  it('retains the first participant when another hand arrives or briefly occludes it', () => {
    const hand = new HandSpace(), a = { id: 1, x: 0, y: 120, z: 0, type: 0, visibleMs: 100 }, b = { id: 2, x: 0, y: 420, z: 0, type: 1, visibleMs: 100 };
    hand.observe([a], 0); expect(hand.observe([b, a], 100).height).toBe(0);
    expect(hand.observe([b], 200).height).toBe(0);
    expect(hand.observe([b], 351).height).toBe(0);
    expect(hand.observe([b], 800).height).toBe(1);
  });
  it('records and replays hand-space state without turning hand position into recipe requests', () => {
    const state = { enabled: true, presence: 1, height: .8, depth: .9 }, session = new PerformanceSession(testEnvironment());
    expect(session.dispatch({ type: 'space', state }, 0, 0)).toEqual([]);
    session.dispatch({ type: 'start' }, 0, 0); const recipe = session.state.currentRecipe;
    session.dispatch({ type: 'space', state: { ...state, height: 0 } }, 100, .1);
    expect(session.state.currentRecipe).toBe(recipe);
    const records = [{ type: 'input', atMs: 0, audioTime: 0, input: { type: 'frame', frame: { sequence: 1, observedAtMs: 0, receivedAtMs: 0, valid: true, source: 'slider', values: { openness: .3 } } } }, { type: 'input', atMs: 10, audioTime: .01, input: { type: 'space', state } }] as TraceRecord[];
    expect(replayRawControl(records, testEnvironment()).session.space).toEqual(state);
    expect(new RawReplayAdapter(records, 1000).due(1020).at(-1)).toEqual({ type: 'space', state });
  });
  it('distinguishes vocal rests from whole instrumental gaps in the passage analysis', () => {
    const scene = testEnvironment().manifest.scenes[0]; scene.stems.vocals = { file: 'v.wav', trimDb: 0 }; scene.recipes.open.vocals = 0;
    const buffer = (active: number) => { const data = new Float32Array(1000); data.fill(.1, 0, active); return { sampleRate: 1000, length: 1000, numberOfChannels: 1, getChannelData: () => data } as unknown as AudioBuffer; };
    const loaded: LoadedScene = { scene, buffers: { other: buffer(500), vocals: buffer(250) }, duration: 1, bytes: 0, fingerprint: '', mediaHashes: {} };
    const result = analyzeActivity(loaded);
    expect(result.instrumental.map(v => v > .003)).toEqual([true, true, false, false]);
    expect(result.vocals.map(v => v > .003)).toEqual([true, false, false, false]);
    expect(result.gaps).toEqual([{ start: .5, end: 1 }]); expect(analyzeActivity(loaded)).toBe(result);
  });
  it('leaves a bounded preparation margin for hand-space passage effects without waiting for a phrase', () => {
    const session = new PerformanceSession(testEnvironment());
    session.dispatch({ type: 'space', state: { enabled: true, presence: 1, height: 1, depth: 1 } }, 0, 0);
    session.dispatch({ type: 'timing', timing: 'immediate' }, 0, 0);
    session.dispatch({ type: 'start' }, 0, 0); session.dispatch({ type: 'advance' }, 200, .2);
    const reset = session.dispatch({ type: 'tick' }, 200, .2).find(a => a.type === 'CommitSceneReset');
    expect(reset?.type).toBe('CommitSceneReset');
    if (reset?.type === 'CommitSceneReset') { expect(reset.at - .2).toBeCloseTo(.155); expect(reset.fadeStart - .2).toBeCloseTo(.135); }
  });
});
