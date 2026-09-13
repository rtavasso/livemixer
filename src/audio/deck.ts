import { dbToGain, STEMS, type RecipeId, type StemId } from '../config';
import { cutoffFor } from '../music/mapping';
import type { LoadedScene } from './assets';
import { OwnedEnvelope } from './automation';
import { SpaceMix } from './space';
import { setFullBufferLoop } from './loop';
import { idleSpace, type SpaceState } from '../control/space';
export interface StemNodes { source: AudioBufferSourceNode; trim: GainNode; recipe: GainNode; envelope: OwnedEnvelope; meter: AnalyserNode }
export interface Deck {
  loaded: LoadedScene; start: number; stems: Partial<Record<StemId, StemNodes>>;
  filter: BiquadFilterNode; cutoff: OwnedEnvelope; instrumental: GainNode; dry: GainNode; wet: GainNode; sum: GainNode; trim: GainNode;
  fade: GainNode; fadeEnvelope: OwnedEnvelope; disposed: boolean; stopAt?: number;
  space: SpaceMix; manual: GainNode; manualEnvelope: OwnedEnvelope;
}
export function createDeck(context: BaseAudioContext, loaded: LoadedScene, output: AudioNode, at: number, recipe: RecipeId, openness: number, fadeInMs = 0, bypass = false, rate = 1, spaceState: SpaceState = idleSpace()): Deck {
  const scene = loaded.scene, sum = context.createGain(), trim = context.createGain(), fade = context.createGain();
  const manual = context.createGain(), manualEnvelope = new OwnedEnvelope(manual.gain, spaceState.enabled ? 0 : 1, at);
  trim.gain.value = dbToGain(scene.sceneTrimDb); sum.connect(manual).connect(trim).connect(fade).connect(output);
  const space = new SpaceMix(context, loaded, trim, at, rate);
  const filter = context.createBiquadFilter(); filter.type = 'lowpass'; filter.Q.value = scene.filter.q;
  const instrumental = context.createGain(), wholeBed = scene.filter.target === 'instrumental';
  const dry = context.createGain(), wet = context.createGain();
  // Keep attacks and harmonics audible even at the darkest setting.
  dry.gain.value = .35; wet.gain.value = .65;
  if (wholeBed) {
    dry.connect(sum); wet.connect(sum);
    if (bypass) instrumental.connect(sum);
    else { instrumental.connect(dry); instrumental.connect(filter).connect(wet); }
  }
  const cutoff = new OwnedEnvelope(filter.frequency, cutoffFor(openness, scene.filter.minHz, scene.filter.maxHz, context.sampleRate), at);
  const fadeEnvelope = new OwnedEnvelope(fade.gain, fadeInMs ? 0 : 1, at);
  if (fadeInMs) fadeEnvelope.ramp(1, at, at + fadeInMs / 1000);
  const deck: Deck = { loaded, start: at, stems: {}, filter, cutoff, instrumental, dry, wet, sum, trim, fade, fadeEnvelope, space, manual, manualEnvelope, disposed: false };
  try {
    for (const id of STEMS) {
      const buffer = loaded.buffers[id]; if (!buffer) continue;
      const source = context.createBufferSource(), staticTrim = context.createGain(), recipeGain = context.createGain(), meter = context.createAnalyser();
      setFullBufferLoop(source, buffer); source.playbackRate.value = rate;
      staticTrim.gain.value = dbToGain(scene.stems[id]!.trimDb); meter.fftSize = 256;
      const envelope = new OwnedEnvelope(recipeGain.gain, dbToGain(scene.recipes[recipe][id]!), at);
      source.connect(staticTrim);
      space.attach(id, source, at);
      if (!wholeBed && id === scene.anchorStem && !bypass) staticTrim.connect(filter).connect(recipeGain); else staticTrim.connect(recipeGain);
      recipeGain.connect(meter).connect(wholeBed && id !== 'vocals' ? instrumental : sum);
      deck.stems[id] = { source, trim: staticTrim, recipe: recipeGain, envelope, meter };
    }
    space.update(spaceState, at, true);
    // Graph creation completes before scheduling any source. Every stem shares T and offset 0.
    for (const node of Object.values(deck.stems)) node.source.start(at, 0);
    return deck;
  } catch (error) { disposeDeck(deck, context.currentTime); throw error; }
}
export function setFilterBypass(deck: Deck, bypass: boolean) {
  if (deck.loaded.scene.filter.target === 'instrumental') {
    deck.instrumental.disconnect(); deck.filter.disconnect();
    if (bypass) deck.instrumental.connect(deck.sum);
    else { deck.instrumental.connect(deck.dry); deck.instrumental.connect(deck.filter).connect(deck.wet); }
    return;
  }
  const anchor = deck.stems[deck.loaded.scene.anchorStem]!;
  anchor.trim.disconnect(); deck.filter.disconnect();
  if (bypass) anchor.trim.connect(anchor.recipe);
  else anchor.trim.connect(deck.filter).connect(anchor.recipe);
}
export function rampRecipe(deck: Deck, recipe: RecipeId, start: number, end: number) {
  for (const id of STEMS) deck.stems[id]?.envelope.ramp(dbToGain(deck.loaded.scene.recipes[recipe][id]!), start, end);
}
export function updateFilter(deck: Deck, u: number, now: number, rampMs: number) {
  if (deck.stopAt !== undefined && now >= deck.stopAt) return;
  const f = deck.loaded.scene.filter, target = cutoffFor(u, f.minHz, f.maxHz, deck.filter.context.sampleRate);
  if (Math.abs(deck.cutoff.valueAt(now + rampMs / 1000) - target) > .5) deck.cutoff.ramp(target, now, now + rampMs / 1000, true);
}
export function updateSpace(deck: Deck, state: SpaceState, now: number) {
  if (deck.disposed || (deck.stopAt !== undefined && now >= deck.stopAt)) return;
  const at = Math.max(now, deck.start);
  deck.manualEnvelope.ramp(state.enabled ? 0 : 1, at, at + .12, true);
  deck.space.update(state, at);
}
export function scheduleDeckExit(deck: Deck, start: number, at: number) {
  deck.fadeEnvelope.ramp(0, start, at); deck.stopAt = at;
  for (const stem of Object.values(deck.stems)) stem.source.stop(at);
}
export function disposeDeck(deck: Deck, now: number) {
  if (deck.disposed) return;
  deck.disposed = true;
  for (const stem of Object.values(deck.stems)) {
    try { stem.source.stop(now); } catch { /* Single-use sources may already have ended. */ }
    stem.source.disconnect(); stem.trim.disconnect(); stem.recipe.disconnect(); stem.meter.disconnect();
  }
  deck.filter.disconnect(); deck.instrumental.disconnect(); deck.dry.disconnect(); deck.wet.disconnect(); deck.sum.disconnect(); deck.trim.disconnect(); deck.fade.disconnect();
  deck.space.dispose(); deck.manual.disconnect();
}
