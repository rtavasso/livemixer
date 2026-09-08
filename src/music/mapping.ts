import { DEFAULT_CONTROL, type ControlSettings, type RecipeId } from '../config';
export function candidateRecipe(u: number, accepted: RecipeId): RecipeId {
  if (u > .72) return 'open';
  if (u < .28) return 'sparse';
  if (accepted === 'sparse' && u > .38) return 'pulse';
  if (accepted === 'open' && u < .62) return 'pulse';
  return accepted;
}
export interface MappingState { desired: RecipeId; candidate: RecipeId | null; since: number | null }
export const initialMapping = (desired: RecipeId = 'sparse'): MappingState => ({ desired, candidate: null, since: null });
export function mapRecipe(state: MappingState, u: number, atMs: number, valid: boolean, dwellMs = 120): MappingState {
  if (!valid) return initialMapping(state.desired);
  const candidate = candidateRecipe(u, state.desired);
  if (candidate === state.desired) return initialMapping(state.desired);
  const since = candidate === state.candidate ? state.since! : atMs;
  return atMs - since >= dwellMs ? initialMapping(candidate) : { ...state, candidate, since };
}
export interface GestureState { armed: boolean; highSince: number | null; lowSince: number | null; progress: number }
export const disarmed = (): GestureState => ({ armed: false, highSince: null, lowSince: null, progress: 0 });
export function advanceGesture(state: GestureState, input: { u: number; atMs: number; valid: boolean; enabled: boolean; eligible: boolean; busy: boolean }, s: ControlSettings = DEFAULT_CONTROL): { state: GestureState; advance: boolean } {
  if (!input.valid || !input.enabled) return { state: disarmed(), advance: false };
  const next = { ...state };
  if (input.u < s.rearmThreshold) {
    next.lowSince ??= input.atMs;
    if (input.atMs - next.lowSince >= s.rearmMs) next.armed = true;
  } else next.lowSince = null;
  if (!next.armed || !input.eligible || input.busy || input.u <= s.highThreshold) { next.highSince = null; next.progress = 0; }
  else {
    next.highSince ??= input.atMs;
    next.progress = Math.min(1, (input.atMs - next.highSince) / s.highHoldMs);
    if (next.progress >= 1) return { state: disarmed(), advance: true };
  }
  return { state: next, advance: false };
}
export function cutoffFor(u: number, minHz: number, maxHz: number, sampleRate: number) {
  const high = Math.min(maxHz, .45 * sampleRate), low = Math.min(minHz, high);
  return low * (high / low) ** Math.max(0, Math.min(1, u));
}
