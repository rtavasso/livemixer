/**
 * Macro gesture detection over conditioned hands. Pure and deterministic:
 * `detectGestures(memory, hands, nowMs)` returns new memory plus the events
 * that fired. Events are coarse on purpose; the installation responds to
 * whole-arm motion, not fingertip precision.
 */
import { z } from 'zod';
import type { Vec3 } from '../core/types';
import type { HandState } from './types';

export const gestureSettingsSchema = z.object({
  /** Minimum planar speed (sim units/s) for a swipe, and the minimum travel to confirm it. */
  swipeSpeed: z.number().positive().default(1.6),
  swipeDistance: z.number().positive().default(.22),
  /** Refractory period after a swipe before the same hand can swipe again. */
  swipeCooldownMs: z.number().min(0).default(500),
  /** z must rise by at least this much within `pushWindowMs` to count as a push. */
  pushDelta: z.number().positive().default(.25),
  pushWindowMs: z.number().positive().default(350),
  pushCooldownMs: z.number().min(0).default(600),
  /** Hold: planar speed below this for `holdMs` fires once; moving faster than `holdReleaseSpeed` re-arms. */
  holdSpeed: z.number().positive().default(.12),
  holdMs: z.number().positive().default(900),
  holdReleaseSpeed: z.number().positive().default(.35),
  /** Grab/release hysteresis on openness. */
  grabBelow: z.number().min(0).max(1).default(.35),
  releaseAbove: z.number().min(0).max(1).default(.55),
}).strict();
export type GestureSettings = z.infer<typeof gestureSettingsSchema>;
export const DEFAULT_GESTURE_SETTINGS: GestureSettings = gestureSettingsSchema.parse({});

export type SwipeDirection = 'left' | 'right' | 'up' | 'down';
export type GestureEvent =
  | { type: 'enter'; handId: number; atMs: number; position: Vec3 }
  | { type: 'leave'; handId: number; atMs: number; position: Vec3; durationMs: number }
  | { type: 'swipe'; handId: number; atMs: number; position: Vec3; direction: SwipeDirection; speed: number }
  | { type: 'push'; handId: number; atMs: number; position: Vec3; depth: number }
  | { type: 'hold'; handId: number; atMs: number; position: Vec3; durationMs: number }
  | { type: 'grab'; handId: number; atMs: number; position: Vec3 }
  | { type: 'release'; handId: number; atMs: number; position: Vec3 };
export const GESTURE_TYPES = ['enter', 'leave', 'swipe', 'push', 'hold', 'grab', 'release'] as const;

interface HandMemory {
  enteredMs: number;
  lastPosition: Vec3;
  /** A swipe fires once per fast segment: the hand must slow below `swipeSpeed` to re-arm. */
  swipeOrigin: Vec3; swipeStartMs: number; lastSwipeMs: number; swipeArmed: boolean;
  zHistory: { z: number; atMs: number }[]; lastPushMs: number;
  stillSinceMs: number | null; holdFired: boolean;
  grabbed: boolean;
}
export interface GestureMemory { hands: Map<number, HandMemory> }
export const emptyGestureMemory = (): GestureMemory => ({ hands: new Map() });

export function detectGestures(memory: GestureMemory, hands: readonly HandState[], nowMs: number, settings: GestureSettings = DEFAULT_GESTURE_SETTINGS): { memory: GestureMemory; events: GestureEvent[] } {
  const events: GestureEvent[] = [];
  const next = new Map<number, HandMemory>();
  for (const hand of hands) {
    const p = hand.position;
    let m = memory.hands.get(hand.id);
    if (!m) {
      m = { enteredMs: nowMs, lastPosition: p, swipeOrigin: p, swipeStartMs: nowMs, lastSwipeMs: -Infinity, swipeArmed: true, zHistory: [], lastPushMs: -Infinity, stillSinceMs: null, holdFired: false, grabbed: false };
      events.push({ type: 'enter', handId: hand.id, atMs: nowMs, position: p });
    } else {
      m = { ...m, zHistory: m.zHistory.slice() };
    }
    // Swipe: track the origin of the current fast segment; fire when it has travelled far enough.
    if (hand.speed < settings.swipeSpeed) { m.swipeOrigin = p; m.swipeStartMs = nowMs; m.swipeArmed = true; }
    else if (m.swipeArmed) {
      const dx = p.x - m.swipeOrigin.x, dy = p.y - m.swipeOrigin.y;
      if (Math.hypot(dx, dy) >= settings.swipeDistance && nowMs - m.lastSwipeMs >= settings.swipeCooldownMs) {
        const direction: SwipeDirection = Math.abs(dx) >= Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'up' : 'down');
        events.push({ type: 'swipe', handId: hand.id, atMs: nowMs, position: p, direction, speed: hand.speed });
        m.lastSwipeMs = nowMs; m.swipeOrigin = p; m.swipeStartMs = nowMs; m.swipeArmed = false;
      }
    }
    // Push: z rises quickly relative to the window's minimum.
    m.zHistory.push({ z: hand.push, atMs: nowMs });
    while (m.zHistory.length && nowMs - m.zHistory[0].atMs > settings.pushWindowMs) m.zHistory.shift();
    const zMin = Math.min(...m.zHistory.map(h => h.z));
    if (hand.push - zMin >= settings.pushDelta && nowMs - m.lastPushMs >= settings.pushCooldownMs) {
      events.push({ type: 'push', handId: hand.id, atMs: nowMs, position: p, depth: hand.push });
      m.lastPushMs = nowMs; m.zHistory = [{ z: hand.push, atMs: nowMs }];
    }
    // Hold: still for a while, fires once until the hand moves again.
    if (hand.speed <= settings.holdSpeed) {
      if (m.stillSinceMs === null) m.stillSinceMs = nowMs;
      if (!m.holdFired && nowMs - m.stillSinceMs >= settings.holdMs) { events.push({ type: 'hold', handId: hand.id, atMs: nowMs, position: p, durationMs: nowMs - m.stillSinceMs }); m.holdFired = true; }
    } else if (hand.speed >= settings.holdReleaseSpeed) { m.stillSinceMs = null; m.holdFired = false; }
    // Grab/release on openness with hysteresis.
    if (!m.grabbed && hand.openness <= settings.grabBelow) { m.grabbed = true; events.push({ type: 'grab', handId: hand.id, atMs: nowMs, position: p }); }
    else if (m.grabbed && hand.openness >= settings.releaseAbove) { m.grabbed = false; events.push({ type: 'release', handId: hand.id, atMs: nowMs, position: p }); }
    m.lastPosition = p;
    next.set(hand.id, m);
  }
  for (const [id, m] of memory.hands) if (!next.has(id)) events.push({ type: 'leave', handId: id, atMs: nowMs, position: m.lastPosition, durationMs: nowMs - m.enteredMs });
  return { memory: { hands: next }, events };
}
