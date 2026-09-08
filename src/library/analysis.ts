import type { KeyEstimate, SongAnalysis, StemAnalysis, TempoEstimate } from './types';
import { pcmValue, type WavInfo } from './wav';
import type { StemId } from '../config';
export const ANALYSIS_VERSION = 1;
const NOTES = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];
export function tempoFromSignal(signal: Float32Array, rate: number): TempoEstimate {
  const hop = Math.max(1, Math.round(rate / 100)), envelope: number[] = [];
  for (let at = 0; at + hop <= signal.length; at += hop) { let sum = 0; for (let j = 0; j < hop; j++) sum += signal[at + j] ** 2; envelope.push(Math.sqrt(sum / hop)); }
  const envRate = rate / hop, onset = envelope.map((v, i) => Math.max(0, v - (envelope[i - 1] ?? v)));
  const estimate = (values: number[]) => {
    const min = Math.floor(60 * envRate / 180), max = Math.ceil(60 * envRate / 60), scores: { lag: number; score: number }[] = [];
    for (let lag = min; lag <= max; lag++) {
      let numerator = 0, a = 0, b = 0;
      for (let i = lag; i < values.length; i++) { numerator += values[i] * values[i - lag]; a += values[i] ** 2; b += values[i - lag] ** 2; }
      scores.push({ lag, score: a * b > 1e-15 ? numerator / Math.sqrt(a * b) : 0 });
    }
    const peaks = scores.filter((s, i) => s.score > .12 && s.score >= (scores[i - 1]?.score ?? 0) && s.score >= (scores[i + 1]?.score ?? 0)).map(s => {
      const i = s.lag - min, left = scores[i - 1]?.score ?? s.score, right = scores[i + 1]?.score ?? s.score;
      const denominator = left - 2 * s.score + right, offset = denominator ? Math.max(-.5, Math.min(.5, .5 * (left - right) / denominator)) : 0;
      return { bpm: 60 * envRate / (s.lag + offset), strength: s.score, rank: s.score * Math.exp(-.15 * Math.log2((60 * envRate / s.lag) / 120) ** 2) };
    }).sort((a, b) => b.rank - a.rank);
    return peaks;
  };
  const peaks = estimate(onset), best = peaks[0];
  const windowBpms = Array.from({ length: 3 }, (_, i) => estimate(onset.slice(Math.floor(onset.length * i / 3), Math.floor(onset.length * (i + 1) / 3)))[0]?.bpm).filter((v): v is number => v !== undefined).map(v => Math.round(v * 10) / 10);
  return { bpm: best ? Math.round(best.bpm * 10) / 10 : null, alternatives: peaks.slice(1, 4).map(p => Math.round(p.bpm * 10) / 10), strength: best?.strength ?? 0, windowBpms };
}
export function fft(real: Float64Array, imag: Float64Array) {
  const n = real.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit;
    if (i < j) { [real[i], real[j]] = [real[j], real[i]]; [imag[i], imag[j]] = [imag[j], imag[i]]; }
  }
  for (let length = 2; length <= n; length <<= 1) {
    const angle = -2 * Math.PI / length, stepR = Math.cos(angle), stepI = Math.sin(angle);
    for (let at = 0; at < n; at += length) {
      let wr = 1, wi = 0;
      for (let j = 0; j < length / 2; j++) {
        const a = at + j, b = a + length / 2, vr = real[b] * wr - imag[b] * wi, vi = real[b] * wi + imag[b] * wr;
        real[b] = real[a] - vr; imag[b] = imag[a] - vi; real[a] += vr; imag[a] += vi;
        const next = wr * stepR - wi * stepI; wi = wr * stepI + wi * stepR; wr = next;
      }
    }
  }
}
export function keyFromChroma(chroma: number[]): KeyEstimate {
  // Deliberately small diatonic/triad-weighted templates; this is an estimate, not chord compatibility.
  const profiles = { major: [5, 0, 3, 0, 4, 2, 0, 4, 0, 2, 0, 2], minor: [5, 0, 2, 4, 0, 2, 0, 4, 3, 0, 2, 0] };
  const mean = chroma.reduce((a, b) => a + b, 0) / 12, norm = Math.sqrt(chroma.reduce((a, b) => a + (b - mean) ** 2, 0));
  const candidates: { label: string; score: number; root: number; mode: string }[] = [];
  for (let root = 0; root < 12; root++) for (const [mode, profile] of Object.entries(profiles)) {
    const m = profile.reduce((a, b) => a + b, 0) / 12, d = Math.sqrt(profile.reduce((a, b) => a + (b - m) ** 2, 0));
    const score = chroma.reduce((sum, value, index) => sum + (value - mean) * (profile[(index - root + 12) % 12] - m), 0) / (norm * d || 1);
    candidates.push({ label: `${NOTES[root]} ${mode}`, score, root, mode });
  }
  candidates.sort((a, b) => b.score - a.score);
  const max = Math.max(...chroma), normalized = chroma.map(v => max > 0 ? v / max : 0), separation = candidates[0].score - candidates[1].score;
  const best = candidates[0], third = (best.root + (best.mode === 'major' ? 4 : 3)) % 12;
  const usable = max > 0 && best.score > .35 && normalized.filter(v => v > .15).length >= 3 && normalized[third] > .15 && separation > .02;
  return { label: usable ? candidates[0].label : 'Uncertain', alternatives: candidates.slice(0, 3).map(c => c.label), separation, chroma: normalized };
}
export function keyFromSignal(signal: Float32Array, rate: number): KeyEstimate {
  const size = 4096, real = new Float64Array(size), imag = new Float64Array(size), chroma = Array(12).fill(0), powers = new Float64Array(size / 2);
  for (let at = 0; at + size <= signal.length; at += 2048) {
    for (let i = 0; i < size; i++) { real[i] = signal[at + i] * (.5 - .5 * Math.cos(2 * Math.PI * i / (size - 1))); imag[i] = 0; }
    fft(real, imag);
    for (let i = 1; i < size / 2; i++) powers[i] = Math.hypot(real[i], imag[i]);
    for (let i = Math.ceil(55 * size / rate); i < Math.min(size / 2 - 1, 3000 * size / rate); i++) {
      if (powers[i] < powers[i - 1] || powers[i] < powers[i + 1] || powers[i] < .01) continue;
      const left = Math.log(powers[i - 1] + 1e-12), mid = Math.log(powers[i] + 1e-12), right = Math.log(powers[i + 1] + 1e-12);
      const offset = Math.max(-.5, Math.min(.5, .5 * (left - right) / (left - 2 * mid + right || 1)));
      const midi = 69 + 12 * Math.log2((i + offset) * rate / size / 440), nearest = Math.round(midi), weight = Math.cos((midi - nearest) * Math.PI) ** 2;
      chroma[(nearest % 12 + 12) % 12] += Math.sqrt(powers[i]) * weight;
    }
  }
  return keyFromChroma(chroma);
}
export async function analyzeWav(file: Blob, info: WavInfo, needSignal: boolean): Promise<{ stats: StemAnalysis; signal: Float32Array; signalRate: number; range: { start: number; duration: number } }> {
  const bins = 768, peaks = Array(bins).fill(0), chunkFrames = Math.max(1, Math.floor(4 * 1024 * 1024 / info.blockAlign));
  const rangeDuration = Math.min(120, info.duration), startFrame = Math.floor(Math.max(0, (info.duration - rangeDuration) / 2) * info.sampleRate), endFrame = Math.min(info.frames, startFrame + Math.round(rangeDuration * info.sampleRate));
  const stride = Math.max(1, Math.round(info.sampleRate / 8000)), signal = new Float32Array(needSignal ? Math.ceil((endFrame - startFrame) / stride) : 0);
  let peak = 0, sumSquares = 0, sum = 0, clippedSamples = 0, nonfinite = 0, silentFrames = 0, downSum = 0, downCount = 0, downIndex = 0;
  for (let first = 0; first < info.frames; first += chunkFrames) {
    const count = Math.min(chunkFrames, info.frames - first), bytes = new DataView(await file.slice(info.dataOffset + first * info.blockAlign, info.dataOffset + (first + count) * info.blockAlign).arrayBuffer());
    for (let i = 0; i < count; i++) {
      let mono = 0, energy = 0, framePeak = 0;
      for (let channel = 0; channel < info.channels; channel++) {
        let value = pcmValue(bytes, i * info.blockAlign + channel * info.bits / 8, info);
        if (!Number.isFinite(value)) { nonfinite++; value = 0; }
        const abs = Math.abs(value); peak = Math.max(peak, abs); framePeak = Math.max(framePeak, abs);
        sumSquares += value ** 2; sum += value; energy += value ** 2; mono += value / info.channels;
        if (abs >= .9999) clippedSamples++;
      }
      const frame = first + i, bin = Math.min(bins - 1, Math.floor(frame / info.frames * bins)); peaks[bin] = Math.max(peaks[bin], framePeak);
      if (energy / info.channels < 1e-5) silentFrames++;
      if (needSignal && frame >= startFrame && frame < endFrame) {
        downSum += mono; downCount++;
        if (downCount === stride || frame === endFrame - 1) { signal[downIndex++] = downSum / downCount; downSum = downCount = 0; }
      }
    }
  }
  const rms = Math.sqrt(sumSquares / (info.frames * info.channels));
  return { stats: { peakDbfs: peak ? 20 * Math.log10(peak) : null, rmsDbfs: rms ? 20 * Math.log10(rms) : null, crestDb: rms && peak ? 20 * Math.log10(peak / rms) : 0, clippedSamples, nonfinite, dc: sum / (info.frames * info.channels), silentFraction: silentFrames / info.frames, peaks }, signal, signalRate: info.sampleRate / stride, range: { start: startFrame / info.sampleRate, duration: (endFrame - startFrame) / info.sampleRate } };
}
export async function analyzeSong(stems: Partial<Record<StemId, { file: Blob; info: WavInfo }>>, progress: (stem: string) => void = () => {}): Promise<SongAnalysis> {
  const analysis: SongAnalysis = { version: ANALYSIS_VERSION, stems: {}, tempo: { bpm: null, alternatives: [], strength: 0, windowBpms: [] }, key: { label: 'Uncertain', alternatives: [], separation: 0, chroma: Array(12).fill(0) }, range: { start: 0, duration: 0 } };
  for (const [id, value] of Object.entries(stems) as [StemId, { file: Blob; info: WavInfo }][]) {
    progress(id); const tonal = id === (stems.other ? 'other' : 'bass'), rhythm = id === (stems.drums ? 'drums' : 'other');
    const result = await analyzeWav(value.file, value.info, tonal || rhythm); analysis.stems[id] = result.stats;
    if (rhythm) analysis.tempo = tempoFromSignal(result.signal, result.signalRate);
    if (tonal) analysis.key = keyFromSignal(result.signal, result.signalRate);
    if (tonal || rhythm) analysis.range = result.range;
  }
  return analysis;
}
