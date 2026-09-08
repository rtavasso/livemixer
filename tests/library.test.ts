import { describe, expect, it } from 'vitest';
import { analyzeWav, keyFromChroma, keyFromSignal, tempoFromSignal } from '../src/library/analysis';
import { clipsManifest, createClip, groupLibrary, identifyStem, inspectSong, selection } from '../src/library/catalog';
import { cropWav, inspectWav, pcmValue } from '../src/library/wav';
import { exportMixZip, restoreProject, saveProject } from '../src/library/project';
import { unzipSync, strFromU8 } from 'fflate';
function wavFile(name: string, frames = 64000, rate = 8000, signal = (i: number) => Math.sin(i / 10) * .1) {
  const bytes = new ArrayBuffer(44 + frames * 2), v = new DataView(bytes), str = (at: number, s: string) => [...s].forEach((c, i) => v.setUint8(at + i, c.charCodeAt(0)));
  str(0, 'RIFF'); v.setUint32(4, bytes.byteLength - 8, true); str(8, 'WAVEfmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); str(36, 'data'); v.setUint32(40, frames * 2, true);
  for (let i = 0; i < frames; i++) v.setInt16(44 + i * 2, Math.round(signal(i) * 32767), true);
  return new File([bytes], name, { type: 'audio/wav', lastModified: 0 });
}
const songFiles = (prefix = 'Example') => ['other', 'bass', 'drums'].map(stem => wavFile(`${prefix}_${stem}.wav`));
describe('library import and synchronized cropping', () => {
  it('groups 50 flat-named songs without decoding the whole collection', () => {
    const files = Array.from({ length: 50 }, (_, i) => songFiles(`Song ${i}`)).flat(), songs = groupLibrary(files);
    expect(songs).toHaveLength(50); expect(songs.every(s => Object.keys(s.stems).length === 3)).toBe(true); expect(new Set(songs.map(s => s.id)).size).toBe(50);
    expect(identifyStem('A Track - Drums.wav')).toEqual({ stem: 'drums', prefix: 'A Track' });
  });
  it('groups folder-based Demucs exports', () => {
    const files = songFiles().map(f => { const stem = identifyStem(f.name).stem; const file = new File([f], `${stem}.wav`); Object.defineProperty(file, 'webkitRelativePath', { value: `Library/Track One/${stem}.wav` }); return file; });
    const songs = groupLibrary(files); expect(songs).toHaveLength(1); expect(songs[0].label).toBe('Track One');
  });
  it('validates source headers, reports unaligned stems, and rejects oversized cuts', async () => {
    const [song] = groupLibrary(songFiles()); await inspectSong(song); expect(song.issues).toEqual([]);
    expect(selection(song).frameCount).toBe(64000); song.startBar = 2; expect(() => selection(song)).toThrow(/beyond/);
    song.stems.bass = wavFile('bass.wav', 64001); await inspectSong(song); expect(song.issues.join()).toContain('unequal');
  });
  it('cuts identical source frames without changing their sample values', async () => {
    const file = wavFile('marker.wav'), info = await inspectWav(file), clip = cropWav(file, info, 123, 1000), output = await inspectWav(clip);
    expect(output.frames).toBe(1000); expect(output.sampleRate).toBe(info.sampleRate);
    expect(new Uint8Array(await clip.slice(44).arrayBuffer())).toEqual(new Uint8Array(await file.slice(44 + 123 * 2, 44 + 1123 * 2).arrayBuffer()));
  });
  it('preserves 24-bit sign and floating-point PCM values', () => {
    const raw = new DataView(new ArrayBuffer(8)); raw.setUint8(2, 0x80); expect(pcmValue(raw, 0, { bits: 24, format: 1 })).toBe(-1);
    raw.setFloat32(0, .75, true); expect(pcmValue(raw, 0, { bits: 32, format: 3 })).toBe(.75);
  });
});
describe('local analysis', () => {
  it('finds a known 120 BPM impulse rhythm and rejects silence', () => {
    const rate = 8000, signal = Float32Array.from({ length: rate * 16 }, (_, i) => i % 4000 < 80 ? .8 : 0);
    expect(tempoFromSignal(signal, rate).bpm).toBeCloseTo(120, 0); expect(tempoFromSignal(new Float32Array(rate * 8), rate).bpm).toBeNull();
  });
  it('estimates a C-major triad and marks empty tonal data uncertain', () => {
    const rate = 8000, signal = Float32Array.from({ length: rate * 4 }, (_, i) => [261.6256, 329.6276, 391.9954].reduce((sum, hz) => sum + .1 * Math.sin(2 * Math.PI * hz * i / rate), 0));
    expect(keyFromSignal(signal, rate).label).toBe('C major'); expect(keyFromSignal(new Float32Array(rate), rate).label).toBe('Uncertain');
    const noThird = Array(12).fill(0); noThird[9] = 1; noThird[4] = .6; noThird[11] = .3; expect(keyFromChroma(noThird).label).toBe('Uncertain');
  });
  it('measures whole-file levels and bounded waveform data', async () => {
    const file = wavFile('constant.wav', 8000, 8000, () => .25), result = await analyzeWav(file, await inspectWav(file), true);
    expect(result.stats.rmsDbfs).toBeCloseTo(-12.04, 2); expect(result.stats.peakDbfs).toBeCloseTo(-12.04, 2); expect(result.stats.dc).toBeCloseTo(.25, 4); expect(result.stats.peaks).toHaveLength(768); expect(result.stats.nonfinite).toBe(0);
  });
});
it('exports playable excerpts and restores an authored path without setting approvals', async () => {
  const songs = groupLibrary([...songFiles('A'), ...songFiles('B')]); for (const song of songs) await inspectSong(song);
  const clips = songs.map((s, i) => createClip(s, `clip_${i}`)); const manifest = clipsManifest(clips, true);
  expect(manifest.edges).toHaveLength(2); expect(manifest.edges.every(e => !e.approved)).toBe(true);
  const zip = unzipSync(new Uint8Array(await (await exportMixZip(manifest, clips)).arrayBuffer()));
  expect(Object.keys(zip)).toHaveLength(7); expect(JSON.parse(strFromU8(zip['manifest.json'])).path).toEqual(['clip_0', 'clip_1']);
  const saved = saveProject(songs, clips, true, {}), restored = await restoreProject(JSON.parse(saved), songs, inspectSong);
  expect(restored.clips.map(c => c.id)).toEqual(['clip_0', 'clip_1']); expect(restored.clips[0].scene.approval.recipes).toBe(false);
  const changed = JSON.parse(saved); changed.songs[0].signature = 'changed'; await expect(restoreProject(changed, songs, inspectSong)).rejects.toThrow(/unchanged/);
});
