import { dbToGain, STEMS, type RecipeId, type StemId } from '../config';
import { cutoffFor } from '../music/mapping';
import type { LoadedScene } from './assets';
import { OwnedEnvelope } from './automation';
export interface StemNodes { source: AudioBufferSourceNode; trim: GainNode; recipe: GainNode; envelope: OwnedEnvelope; meter: AnalyserNode }
export interface Deck {
  loaded: LoadedScene; start: number; stems: Partial<Record<StemId, StemNodes>>;
  filter: BiquadFilterNode; cutoff: OwnedEnvelope; instrumental: GainNode; sum: GainNode; trim: GainNode;
  fade: GainNode; fadeEnvelope: OwnedEnvelope; disposed: boolean; stopAt?: number;
}
export function createDeck(context: BaseAudioContext, loaded: LoadedScene, output: AudioNode, at: number, recipe: RecipeId, openness: number, fadeInMs = 0, bypass = false): Deck {
  const scene = loaded.scene, sum = context.createGain(), trim = context.createGain(), fade = context.createGain();
  trim.gain.value = dbToGain(scene.sceneTrimDb); sum.connect(trim).connect(fade).connect(output);
  const filter = context.createBiquadFilter(); filter.type = 'lowpass'; filter.Q.value = scene.filter.q;
  const instrumental = context.createGain(), wholeBed = scene.filter.target === 'instrumental';
  if (wholeBed) { if (bypass) instrumental.connect(sum); else instrumental.connect(filter).connect(sum); }
  const cutoff = new OwnedEnvelope(filter.frequency, cutoffFor(openness, scene.filter.minHz, scene.filter.maxHz, context.sampleRate), at);
  const fadeEnvelope = new OwnedEnvelope(fade.gain, fadeInMs ? 0 : 1, at);
  if (fadeInMs) fadeEnvelope.ramp(1, at, at + fadeInMs / 1000);
  const deck: Deck = { loaded, start: at, stems: {}, filter, cutoff, instrumental, sum, trim, fade, fadeEnvelope, disposed: false };
  try {
    for (const id of STEMS) {
      const buffer = loaded.buffers[id]; if (!buffer) continue;
      const source = context.createBufferSource(), staticTrim = context.createGain(), recipeGain = context.createGain(), meter = context.createAnalyser();
      source.buffer = buffer; source.loop = true; source.loopStart = 0; source.loopEnd = loaded.duration; source.playbackRate.value = 1;
      staticTrim.gain.value = dbToGain(scene.stems[id]!.trimDb); meter.fftSize = 256;
      const envelope = new OwnedEnvelope(recipeGain.gain, dbToGain(scene.recipes[recipe][id]!), at);
      source.connect(staticTrim);
      if (!wholeBed && id === scene.anchorStem && !bypass) staticTrim.connect(filter).connect(recipeGain); else staticTrim.connect(recipeGain);
      recipeGain.connect(meter).connect(wholeBed && id !== 'vocals' ? instrumental : sum);
      deck.stems[id] = { source, trim: staticTrim, recipe: recipeGain, envelope, meter };
    }
    // Graph creation completes before scheduling any source. Every stem shares T and offset 0.
    for (const node of Object.values(deck.stems)) node.source.start(at, 0);
    return deck;
  } catch (error) { disposeDeck(deck, context.currentTime); throw error; }
}
export function setFilterBypass(deck: Deck, bypass: boolean) {
  if (deck.loaded.scene.filter.target === 'instrumental') {
    deck.instrumental.disconnect(); deck.filter.disconnect();
    if (bypass) deck.instrumental.connect(deck.sum); else deck.instrumental.connect(deck.filter).connect(deck.sum);
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
  deck.filter.disconnect(); deck.instrumental.disconnect(); deck.sum.disconnect(); deck.trim.disconnect(); deck.fade.disconnect();
}
