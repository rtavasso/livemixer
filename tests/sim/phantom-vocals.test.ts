/**
 * Regression: a couple of stereo-depth noise blobs (sent as hands when LeapC tracks none) must never open the
 * vocals. Before the fix, two detections ~11–33 ms apart became a present hand, presence rose above 0.5 and the
 * vocal gate opened fully for ~3 s with an empty box. End to end in software: frames → HandTracker → Governor.
 */
import { describe, expect, it } from 'vitest';
import { HandTracker } from '../../src/sim/input/conditioning';
import { SCREEN_MAPPING } from '../../src/sim/input/mapping';
import type { InputFrame } from '../../src/sim/input/types';
import { Governor } from '../../src/living/governor';

const TICK_MS = 1000 / 60;

/** Run frames observed at `frameTimes` (ms) through a tracker ticked at 60 Hz and a governor fed its presence; returns the largest vocals seen. */
function maxVocals(frameTimes: number[], untilMs = 5000): { vocals: number; presence: number; end: number } {
  const tracker = new HandTracker(SCREEN_MAPPING), governor = new Governor();
  const frames = [...frameTimes].sort((a, b) => a - b);
  let next = 0, seq = 0, vocals = 0, presence = 0, last = 0;
  for (let now = 0; now <= untilMs; now += TICK_MS) {
    while (next < frames.length && frames[next] <= now) {
      const at = frames[next++];
      const frame: InputFrame = { source: 'depth', sequence: seq++, observedAtMs: at, receivedAtMs: at, hands: [{ id: 1, position: { x: .5 + .01 * (seq % 3), y: .5, z: .5 }, confidence: .35 }] };
      tracker.ingest(frame);
    }
    const input = tracker.tick(now);
    presence = Math.max(presence, input.presence);
    last = governor.step({ presence: input.presence, reach: 0, lift: .5, closeness: 0, agitation: 0 }, TICK_MS / 1000).vocals;
    vocals = Math.max(vocals, last);
  }
  return { vocals, presence, end: last };
}
const burst = (count: number, fps: number, startMs = 1000) => Array.from({ length: count }, (_, i) => startMs + i * 1000 / fps);

describe('phantom detections never open the vocals', () => {
  it('two detections 11–33 ms apart (the reported bug)', () => {
    for (const gap of [11, 16, 22, 33]) {
      const r = maxVocals([1000, 1000 + gap]);
      expect(r.presence, `gap ${gap}`).toBe(0);
      expect(r.vocals, `gap ${gap}`).toBe(0);
    }
  });
  it('bursts of 2, 3 and 5 frames at 30 and 90 fps', () => {
    for (const fps of [30, 90]) for (const count of [2, 3, 5]) {
      expect(maxVocals(burst(count, fps)).vocals, `${count} frames at ${fps} fps`).toBe(0);
    }
  });
  it('repeated short bursts with gaps between them', () => {
    const times = [0, 1, 2, 3, 4, 5].flatMap(k => burst(4, 30, 500 + k * 250));  // 100 ms of noise every 250 ms
    expect(maxVocals(times).vocals).toBe(0);
  });
});

describe('a real hand still opens the vocals', () => {
  it('a hand held 0.3 s starts them, a lingering hand opens them fully within about a second', () => {
    expect(maxVocals(burst(Math.round(.3 * 30) + 1, 30)).vocals).toBeGreaterThan(0);
    const steady = burst(90, 90);  // 1 s at 90 fps
    const r = maxVocals(steady, 2000);
    expect(r.vocals).toBe(1);
    // Fully open within ~1 s of the hand appearing (150 ms confirm + 0.3 s hold + 0.4 s rise).
    const tracker = new HandTracker(SCREEN_MAPPING), governor = new Governor();
    let seq = 0, openAt = Infinity;
    for (let now = 0; now <= 1500; now += TICK_MS) {
      tracker.ingest({ source: 'leap', sequence: seq++, observedAtMs: now, receivedAtMs: now, hands: [{ id: 1, position: { x: .5, y: .5, z: .5 }, confidence: 1 }] });
      if (governor.step({ presence: tracker.tick(now).presence }, TICK_MS / 1000).vocals === 1 && openAt === Infinity) openAt = now;
    }
    expect(openAt).toBeLessThan(1000);
  });
});
