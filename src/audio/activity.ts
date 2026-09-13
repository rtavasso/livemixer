import { dbToGain, RECIPES, type StemId } from '../config';
import type { LoadedScene } from './assets';
export interface Activity { instrumental: number[]; vocals: number[]; melody: number[]; windowSeconds: number; duration: number; gaps: { start: number; end: number }[] }
const cache = new WeakMap<LoadedScene, Activity>();
export function analyzeActivity(loaded: LoadedScene): Activity {
  const cached = cache.get(loaded); if (cached) return cached;
  const reference = loaded.buffers.other ?? loaded.buffers.bass ?? loaded.buffers.drums;
  if (!reference) return { instrumental: [], vocals: [], melody: [], windowSeconds: .25, duration: loaded.duration, gaps: [] };
  const hop = Math.round(reference.sampleRate * .25), result: Activity = { instrumental: [], vocals: [], melody: [], windowSeconds: hop / reference.sampleRate, duration: loaded.duration, gaps: [] };
  const stems = (Object.entries(loaded.buffers) as [StemId, AudioBuffer][]).filter(([, buffer]) => !!buffer).map(([id, buffer]) => ({ id, data: Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c)), gain: dbToGain(loaded.scene.stems[id]!.trimDb) * Math.max(...RECIPES.map(r => dbToGain(loaded.scene.recipes[r][id] ?? null))) }));
  for (let start = 0; start < reference.length; start += hop) {
    const end = Math.min(reference.length, start + hop); let instrumental = 0, vocals = 0, melody = 0;
    for (let i = start; i < end; i++) for (let channel = 0; channel < 2; channel++) {
      let bed = 0, voice = 0, harmonic = 0;
      for (const stem of stems) { const v = (stem.data[channel % stem.data.length][i] ?? 0) * stem.gain; if (stem.id === 'vocals') voice += v; else bed += v; if (stem.id === 'other') harmonic += v; }
      instrumental += bed * bed; vocals += voice * voice; melody += harmonic * harmonic;
    }
    const count = (end - start) * 2;
    result.instrumental.push(Math.sqrt(instrumental / count)); result.vocals.push(Math.sqrt(vocals / count)); result.melody.push(Math.sqrt(melody / count));
  }
  let gapStart: number | undefined;
  for (let i = 0; i <= result.instrumental.length; i++) {
    if (i < result.instrumental.length && result.instrumental[i] < .0031623) { gapStart ??= i * result.windowSeconds; }
    else if (gapStart !== undefined) { const end = Math.min(loaded.duration, i * result.windowSeconds); if (end - gapStart >= .5) result.gaps.push({ start: gapStart, end }); gapStart = undefined; }
  }
  cache.set(loaded, result); return result;
}
