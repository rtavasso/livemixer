import { RECIPES, type Manifest, type RecipeId } from '../config';
import { AudioEngine } from './engine';
import type { LoadedAssets } from './assets';
import type { AudioAction, CommitSceneReset, RampRecipe, StartTransport } from '../music/planner';
export interface RenderedAudio { buffer: AudioBuffer; peak: number; peakDbfs: number; nonfinite: number }
export interface TimedEvent { at: number; action?: AudioAction; openness?: number; bypass?: boolean }
export function measure(buffer: AudioBuffer): RenderedAudio {
  let peak = 0, nonfinite = 0;
  for (let c = 0; c < buffer.numberOfChannels; c++) for (const value of buffer.getChannelData(c)) { if (!Number.isFinite(value)) nonfinite++; else peak = Math.max(peak, Math.abs(value)); }
  return { buffer, peak, peakDbfs: peak ? 20 * Math.log10(peak) : -Infinity, nonfinite };
}
export async function renderEventPlan(manifest: Manifest, assets: LoadedAssets, events: TimedEvent[], duration: number, sampleRate = 48000): Promise<RenderedAudio> {
  const context = new OfflineAudioContext(2, Math.ceil(duration * sampleRate), sampleRate);
  let engine = new AudioEngine(context, manifest, assets);
  const engines = [engine];
  const stopScheduled = (at: number) => {
    for (const deck of engine.decks) {
      const stop = Math.min(at, deck.stopAt ?? Infinity); deck.stopAt = stop;
      for (const stem of Object.values(deck.stems)) stem.source.stop(stop);
    }
  };
  // StopTransport requires a scheduled stop, never pre-render disconnection.
  for (const event of [...events].sort((a, b) => a.at - b.at)) {
    if (event.bypass !== undefined) engine.setBypass(event.bypass);
    if (event.action?.type === 'StopTransport') {
      stopScheduled(event.action.at);
    } else if (event.action) {
      if (event.action.type === 'StartTransport' && engine.decks.length) {
        stopScheduled(event.at);
        const prior = engine; engine = new AudioEngine(context, manifest, assets); engine.openness = prior.openness; engine.bypass = prior.bypass; engines.push(engine);
      }
      engine.execute(event.action);
    }
    if (event.openness !== undefined) engine.continuous(event.openness, event.at);
  }
  const result = measure(await context.startRendering()); engines.forEach(e => e.dispose()); return result;
}
export function startAction(assets: LoadedAssets, id: string, recipe: RecipeId, at = .1): StartTransport {
  const s = assets.scenes[id];
  return { type: 'StartTransport', id: 1, generation: 1, sceneId: id, at, recipe, clock: { start: at, duration: s.duration, loopBars: s.scene.loopBars, beatsPerBar: 4 } };
}
export type Audition = { kind: 'recipe'; sceneId: string; recipe: RecipeId } | { kind: 'seam' | 'sweep'; sceneId: string; recipe: RecipeId } | { kind: 'recipe-transition'; sceneId: string; from: RecipeId; to: RecipeId; bar: number } | { kind: 'scene-transition'; from: string; to: string; outgoing: RecipeId; incoming: RecipeId };
export function auditionPlan(manifest: Manifest, assets: LoadedAssets, audition: Audition): { events: TimedEvent[]; duration: number; focusAt: number } {
  const sceneId = audition.kind === 'scene-transition' ? audition.from : audition.sceneId, loaded = assets.scenes[sceneId], L = loaded.duration;
  const recipe = audition.kind === 'scene-transition' ? audition.outgoing : audition.kind === 'recipe-transition' ? audition.from : audition.recipe;
  const events: TimedEvent[] = [{ at: 0, action: startAction(assets, sceneId, recipe) }]; let duration = L + .15, focusAt = 0;
  if (audition.kind === 'seam') { duration = L * 2 + .15; focusAt = Math.max(0, L - 1); }
  if (audition.kind === 'sweep') {
    for (let i = 0; i <= 120; i++) events.push({ at: .1 + i / 120 * L, openness: .5 - .5 * Math.cos(i / 120 * Math.PI * 4) });
  }
  if (audition.kind === 'recipe-transition') {
    const at = .1 + audition.bar * L / loaded.scene.loopBars;
    const action: RampRecipe = { type: 'RampRecipe', id: 2, generation: 1, sceneId, recipe: audition.to, start: at - manifest.control.recipeRampMs / 1000, end: at };
    events.push({ at: Math.max(0, action.start - .1), action }); duration = at + L / loaded.scene.loopBars + .1; focusAt = Math.max(0, at - 1);
  }
  if (audition.kind === 'scene-transition') {
    const incoming = assets.scenes[audition.to], edge = manifest.edges.find(e => e.from === sceneId && e.to === audition.to);
    if (!edge) throw new Error('No authored edge for this preview.');
    const at = .1 + L, fadeStart = at - L / (loaded.scene.loopBars * 4);
    const action: CommitSceneReset = { type: 'CommitSceneReset', id: 2, generation: 1, from: sceneId, to: audition.to, fadeStart, at, fadeInEnd: at + edge.fadeInMs / 1000, recipe: audition.incoming, clock: { start: at, duration: incoming.duration, loopBars: incoming.scene.loopBars, beatsPerBar: 4 } };
    events.push({ at: fadeStart - .1, action }); duration = at + incoming.duration + .1; focusAt = Math.max(0, fadeStart - 1);
  }
  return { events, duration, focusAt };
}
export function allAuditions(manifest: Manifest): Audition[] {
  const cases: Audition[] = [];
  for (const s of manifest.scenes) for (const from of RECIPES) {
    cases.push({ kind: 'recipe', sceneId: s.id, recipe: from }, { kind: 'seam', sceneId: s.id, recipe: from }, { kind: 'sweep', sceneId: s.id, recipe: from });
    for (const to of RECIPES) if (from !== to) for (let bar = s.recipeQuantizationBars; bar <= s.loopBars; bar += s.recipeQuantizationBars) cases.push({ kind: 'recipe-transition', sceneId: s.id, from, to, bar });
  }
  for (const edge of manifest.edges) for (const outgoing of RECIPES) for (const incoming of RECIPES) cases.push({ kind: 'scene-transition', from: edge.from, to: edge.to, outgoing, incoming });
  return cases;
}
export function encodeWav(buffer: AudioBuffer): Blob {
  const channels = buffer.numberOfChannels, bytes = new ArrayBuffer(44 + buffer.length * channels * 2), view = new DataView(bytes);
  const str = (at: number, s: string) => [...s].forEach((c, i) => view.setUint8(at + i, c.charCodeAt(0)));
  str(0, 'RIFF'); view.setUint32(4, bytes.byteLength - 8, true); str(8, 'WAVEfmt '); view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); view.setUint16(22, channels, true); view.setUint32(24, buffer.sampleRate, true);
  view.setUint32(28, buffer.sampleRate * channels * 2, true); view.setUint16(32, channels * 2, true); view.setUint16(34, 16, true);
  str(36, 'data'); view.setUint32(40, bytes.byteLength - 44, true);
  for (let c = 0; c < channels; c++) buffer.getChannelData(c).forEach((sample, i) => view.setInt16(44 + (i * channels + c) * 2, Math.round(Math.max(-1, Math.min(1, sample)) * 32767), true));
  return new Blob([bytes], { type: 'audio/wav' });
}
