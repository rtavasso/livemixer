import { type Manifest, type RecipeId } from '../config';
import { changeClockRate, beatSeconds, nextBoundary, type SceneClock } from './transport';
import type { Adapter } from '../control/types';
export type RequestSource = Adapter | 'manual';
export type ResponseTiming = 'beat' | 'immediate' | 'authored';
interface Command { id: number; generation: number }
export interface RampRecipe extends Command { type: 'RampRecipe'; sceneId: string; recipe: RecipeId; start: number; end: number }
export interface CommitSceneReset extends Command { type: 'CommitSceneReset'; from: string; to: string; fadeStart: number; at: number; fadeInEnd: number; recipe: RecipeId; clock: SceneClock; rate?: number }
export interface StartTransport extends Command { type: 'StartTransport'; sceneId: string; at: number; recipe: RecipeId; clock: SceneClock; rate?: number }
export interface StopTransport extends Command { type: 'StopTransport'; at: number }
export interface SetPlaybackRate extends Command { type: 'SetPlaybackRate'; sceneId: string; at: number; rate: number; clock: SceneClock }
export type AudioAction = SetPlaybackRate | RampRecipe | CommitSceneReset | StartTransport | StopTransport;
export interface Readiness { duration: number; error?: string }
export interface PlannerEnvironment { sampleRate?: number; scenePreparationMs?: number; manifest: Manifest; scenes: Record<string, Readiness>; edgeErrors: Record<string, string | undefined> }
export const edgeKey = (from: string, to: string) => `${from}→${to}`;
export interface TransportState {
  timing?: ResponseTiming; rate?: number; desiredRate?: number; committedRate?: SetPlaybackRate | null;
  running: boolean; generation: number; nextId: number; sceneId: string; clock: SceneClock;
  currentRecipe: RecipeId; desiredRecipe: RecipeId; desiredSource: RequestSource; recipeIntent: boolean;
  pendingRecipe: Omit<RampRecipe, 'id' | 'generation' | 'type'> | null;
  committedRecipe: RampRecipe | null;
  pendingAdvance: { source: RequestSource; to?: string; at?: number; fadeStart?: number } | null;
  committedAdvance: CommitSceneReset | null; error?: string;
}
export const idleTransport = (generation = 0): TransportState => ({ running: false, generation, nextId: 1, sceneId: '', clock: { start: 0, duration: 1, loopBars: 4, beatsPerBar: 4 }, currentRecipe: 'sparse', desiredRecipe: 'sparse', desiredSource: 'manual', recipeIntent: false, pendingRecipe: null, committedRecipe: null, pendingAdvance: null, committedAdvance: null });
export function startTransport(previous: TransportState, env: PlannerEnvironment, now: number, sceneId = env.manifest.path[0], recipe: RecipeId = 'sparse'): { state: TransportState; actions: AudioAction[] } {
  const ready = env.scenes[sceneId], scene = env.manifest.scenes.find(s => s.id === sceneId);
  if (!scene || !ready || ready.error) return { state: { ...previous, error: ready?.error ?? `Scene ${sceneId} is not ready.` }, actions: [] };
  const state = idleTransport(previous.generation + 1), at = now + .1;
  const rate = previous.desiredRate ?? 1;
  state.timing = previous.timing; state.rate = state.desiredRate = rate;
  state.running = true; state.sceneId = sceneId; state.currentRecipe = state.desiredRecipe = recipe;
  state.clock = { start: at, duration: ready.duration / rate, loopBars: scene.loopBars, beatsPerBar: scene.beatsPerBar };
  return { state: { ...state, nextId: 2 }, actions: [{ type: 'StartTransport', id: 1, generation: state.generation, sceneId, at, recipe, clock: state.clock, ...(rate === 1 ? {} : { rate }) }] };
}
export function stopTransport(state: TransportState, now: number): { state: TransportState; actions: AudioAction[] } {
  const generation = state.generation + 1;
  return { state: { ...idleTransport(generation), timing: state.timing, rate: state.desiredRate ?? 1, desiredRate: state.desiredRate ?? 1 }, actions: [{ type: 'StopTransport', id: state.nextId, generation, at: now }] };
}
export function desireRecipe(state: TransportState, recipe: RecipeId, source: RequestSource): TransportState {
  return { ...state, desiredRecipe: recipe, desiredSource: source, recipeIntent: true, pendingRecipe: null };
}
export function requestAdvance(state: TransportState, source: RequestSource): TransportState {
  return !state.running || state.pendingAdvance || state.committedAdvance ? state : { ...state, pendingAdvance: { source }, error: undefined };
}
export function dropUncommitted(state: TransportState, source: RequestSource): TransportState {
  return { ...state, pendingRecipe: state.desiredSource === source ? null : state.pendingRecipe, recipeIntent: state.desiredSource === source ? false : state.recipeIntent, pendingAdvance: state.pendingAdvance?.source === source ? null : state.pendingAdvance };
}
// This reducer reads only its arguments. Timers and browser epochs belong to adapters.
export function plan(previous: TransportState, env: PlannerEnvironment, now: number): { state: TransportState; actions: AudioAction[] } {
  const s: TransportState = { ...previous }, actions: AudioAction[] = [];
  if (!s.running) return { state: s, actions };
  if (s.committedRecipe && now >= s.committedRecipe.end) { s.currentRecipe = s.committedRecipe.recipe; s.committedRecipe = null; }
  if (s.committedRate && now >= s.committedRate.at) { s.rate = s.committedRate.rate; s.clock = s.committedRate.clock; s.committedRate = null; }
  if (s.committedAdvance && now >= s.committedAdvance.at) {
    const a = s.committedAdvance;
    s.sceneId = a.to; s.clock = a.clock; s.currentRecipe = a.recipe; s.rate = a.rate ?? 1;
    s.committedAdvance = null; s.committedRecipe = null; s.pendingRecipe = null;
  }
  if (s.committedAdvance || s.committedRate) return { state: s, actions };
  const cfg = env.manifest.control, lead = cfg.minimumLeadMs / 1000, ahead = cfg.lookaheadMs / 1000;
  const scene = env.manifest.scenes.find(v => v.id === s.sceneId)!;
  const timing = s.timing ?? 'authored', rate = s.rate ?? 1, desiredRate = s.desiredRate ?? 1;
  const responseAt = (earliest: number, bars: number) => timing === 'immediate' ? earliest : nextBoundary(s.clock, earliest, timing === 'beat' ? 1 / s.clock.beatsPerBar : bars).at;
  if (s.pendingAdvance) {
    const index = env.manifest.path.indexOf(s.sceneId), nextIndex = index + 1;
    const to = env.manifest.path[nextIndex] ?? (env.manifest.repeatPath ? env.manifest.path[0] : undefined);
    const edge = env.manifest.edges.find(e => e.from === s.sceneId && e.to === to);
    const error = !to ? 'End of the authored path.' : !edge ? 'The next path edge is missing.' : env.scenes[to]?.error ?? (!env.scenes[to] ? 'Incoming buffers are not ready.' : env.edgeErrors[edgeKey(s.sceneId, to)]);
    if (error || !to || !edge) { s.error = error; s.pendingAdvance = null; }
    else {
      const fade = timing === 'authored' ? beatSeconds(s.clock) : .02;
      const preparation = (env.scenePreparationMs ?? 0) / 1000;
      const earliest = Math.max(now + lead + preparation + (timing === 'authored' ? 0 : .01) + fade, timing === 'authored' ? s.clock.start + s.clock.duration : s.clock.start, (s.committedRecipe?.end ?? -Infinity) + fade);
      const at = responseAt(earliest, scene.loopBars), fadeStart = at - fade;
      s.pendingAdvance = { ...s.pendingAdvance, to, at, fadeStart }; s.error = undefined;
      if (fadeStart <= now + ahead + preparation + 1e-9) {
        const incoming = env.manifest.scenes.find(v => v.id === to)!;
        const action: CommitSceneReset = { type: 'CommitSceneReset', id: s.nextId++, generation: s.generation, from: s.sceneId, to, fadeStart, at, fadeInEnd: at + edge.fadeInMs / 1000, recipe: s.recipeIntent ? s.desiredRecipe : s.committedRecipe?.recipe ?? s.currentRecipe, ...(desiredRate === 1 ? {} : { rate: desiredRate }), clock: { start: at, duration: env.scenes[to].duration / desiredRate, loopBars: incoming.loopBars, beatsPerBar: incoming.beatsPerBar } };
        s.committedAdvance = action; s.pendingAdvance = null; s.pendingRecipe = null;
        actions.push(action); return { state: s, actions };
      }
    }
  }
  if (s.committedRecipe) return { state: s, actions };
  if (rate !== desiredRate) {
    // k-rate parameters update on render quanta; give every stem one shared time.
    const quantum = 128 / (env.sampleRate ?? 48000);
    const at = Math.ceil(responseAt(Math.max(now + lead + .01, s.clock.start), scene.recipeQuantizationBars) / quantum) * quantum;
    if (at <= now + ahead + 1e-9) {
      const action: SetPlaybackRate = { type: 'SetPlaybackRate', id: s.nextId++, generation: s.generation, sceneId: s.sceneId, at, rate: desiredRate, clock: changeClockRate(s.clock, at, rate, desiredRate) };
      s.committedRate = action; actions.push(action);
    }
    return { state: s, actions };
  }
  if (!s.recipeIntent || s.desiredRecipe === s.currentRecipe) { s.pendingRecipe = null; return { state: s, actions }; }
  if (env.scenes[s.sceneId]?.error) { s.error = env.scenes[s.sceneId].error; return { state: s, actions }; }
  const ramp = cfg.recipeRampMs / 1000;
  const at = responseAt(Math.max(now + lead + ramp + (timing === 'authored' ? 0 : .01), s.clock.start + ramp), scene.recipeQuantizationBars);
  s.pendingRecipe = { sceneId: s.sceneId, recipe: s.desiredRecipe, start: at - ramp, end: at };
  if (at - ramp <= now + ahead + 1e-9) {
    const action: RampRecipe = { ...s.pendingRecipe, type: 'RampRecipe', id: s.nextId++, generation: s.generation };
    s.committedRecipe = action; s.pendingRecipe = null; actions.push(action);
  }
  return { state: s, actions };
}
