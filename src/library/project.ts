import { Zip, ZipPassThrough, strToU8 } from 'fflate';
import { z } from 'zod';
import { STEMS, validateManifest, type Manifest, type StemId } from '../config';
import { createClip } from './catalog';
import type { LibraryClip, LibrarySong, SongAnalysis } from './types';
const finite = z.number().finite();
const stats = z.object({ peakDbfs: finite.nullable(), rmsDbfs: finite.nullable(), crestDb: finite, clippedSamples: finite.nonnegative(), nonfinite: finite.nonnegative(), dc: finite, silentFraction: finite.min(0).max(1), peaks: z.array(finite.nonnegative()).max(2048) });
const analysisSchema = z.object({ version: z.literal(1), stems: z.record(z.enum(STEMS), stats), tempo: z.object({ bpm: finite.positive().nullable(), alternatives: z.array(finite.positive()).max(10), strength: finite, windowBpms: z.array(finite.positive()).max(10) }), key: z.object({ label: z.string(), alternatives: z.array(z.string()).max(10), separation: finite, chroma: z.array(finite.nonnegative()).length(12) }), range: z.object({ start: finite.nonnegative(), duration: finite.nonnegative() }) });
const songSchema = z.object({ id: z.string(), signature: z.string(), bpm: finite.min(20).max(300).optional(), key: z.string().optional(), gridOffset: finite.nonnegative(), startBar: finite.int().positive(), loopBars: z.union([z.literal(4), z.literal(8)]), notes: z.string(), assignment: z.record(z.enum(STEMS), z.string()), analysis: analysisSchema.optional() });
const projectSchema = z.object({ version: z.literal(1), kind: z.literal('livemixer-library'), songs: z.array(songSchema).max(1000), clips: z.array(z.object({ id: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/), songId: z.string(), startFrame: finite.int().nonnegative(), bpm: finite.min(20).max(300), loopBars: z.union([z.literal(4), z.literal(8)]), vocals: z.boolean(), label: z.string() })).max(50), repeatPath: z.boolean(), edgeNotes: z.record(z.string()), performance: z.unknown().optional() });
export function saveProject(songs: LibrarySong[], clips: LibraryClip[], repeatPath: boolean, edgeNotes: Record<string, string>, performance?: Manifest) {
  return JSON.stringify({ version: 1, kind: 'livemixer-library', songs: songs.map(s => ({ id: s.id, signature: s.signature, bpm: s.bpm, key: s.key, gridOffset: s.gridOffset, startBar: s.startBar, loopBars: s.loopBars, notes: s.notes, analysis: s.analysis, assignment: Object.fromEntries(Object.entries(s.stems).map(([stem, file]) => [stem, file.name])) })), clips: clips.map(c => ({ id: c.id, songId: c.songId, startFrame: c.startFrame, bpm: c.scene.loopBars * 240 * c.scene.sourceSampleRate / c.scene.sourceFrameCount, loopBars: c.scene.loopBars, vocals: !!c.files.vocals, label: c.scene.label })), repeatPath, edgeNotes, performance }, null, 2);
}
export async function restoreProject(value: unknown, songs: LibrarySong[], inspect: (song: LibrarySong) => Promise<LibrarySong>) {
  const project = projectSchema.parse(value), updates: LibrarySong[] = [];
  for (const saved of project.songs) {
    const original = songs.find(s => s.id === saved.id);
    if (!original || original.signature !== saved.signature) throw new Error('Select the same unchanged library folder before restoring this project. File names, sizes, or modification times differ.');
    const stems: LibrarySong['stems'] = {};
    for (const [stem, name] of Object.entries(saved.assignment)) { const file = original.files.find(f => f.name === name); if (!file) throw new Error(`Missing saved stem ${name}.`); stems[stem as StemId] = file; }
    const next = { ...original, stems, issues: [], bpm: saved.bpm, key: saved.key, gridOffset: saved.gridOffset, startBar: saved.startBar, loopBars: saved.loopBars, notes: saved.notes, analysis: saved.analysis as SongAnalysis | undefined };
    await inspect(next); updates.push(next);
  }
  if (new Set(project.clips.map(c => c.id)).size !== project.clips.length) throw new Error('Duplicate clip IDs in library project.');
  const clips = project.clips.map(saved => {
    const song = updates.find(s => s.id === saved.songId); if (!song?.metadata.other) throw new Error('Saved clip source is missing.');
    const source = { ...song, gridOffset: saved.startFrame / song.metadata.other.sampleRate, startBar: 1, bpm: saved.bpm, loopBars: saved.loopBars };
    const clip = createClip(source, saved.id, saved.vocals); clip.scene.label = saved.label; return clip;
  });
  const performance = project.performance ? validateManifest(project.performance) : undefined;
  return { songs: updates, clips: performance ? applyPerformanceConfig(clips, performance) : clips, repeatPath: project.repeatPath, edgeNotes: project.edgeNotes, performance };
}
export function applyPerformanceConfig(clips: LibraryClip[], manifest: Manifest): LibraryClip[] {
  const media = new Map<string, Blob>();
  for (const clip of clips) for (const stem of STEMS) if (clip.files[stem]) media.set(clip.scene.stems[stem]!.file, clip.files[stem]!);
  return manifest.path.map(id => {
    const prior = clips.find(c => c.id === id), scene = manifest.scenes.find(s => s.id === id)!;
    if (!prior || scene.sourceFrameCount !== prior.scene.sourceFrameCount || scene.sourceSampleRate !== prior.scene.sourceSampleRate) throw new Error('The instrument changed a library source length or identity. Export that instrument configuration separately.');
    const files: LibraryClip['files'] = {};
    for (const stem of STEMS) if (scene.stems[stem]) { const blob = media.get(scene.stems[stem]!.file); if (!blob) throw new Error('An edited scene refers to media outside this library project.'); files[stem] = blob; }
    return { ...prior, scene: structuredClone(scene), files };
  });
}
export async function exportMixZip(manifest: Manifest, clips: LibraryClip[]): Promise<Blob> {
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  const zip = new Zip((error, data) => { if (error) throw error; chunks.push(new Uint8Array(data)); });
  const config = new ZipPassThrough('manifest.json'); zip.add(config); config.push(strToU8(JSON.stringify(manifest, null, 2) + '\n'), true);
  const written = new Set<string>();
  for (const clip of clips) for (const stem of STEMS) {
    const blob = clip.files[stem]; if (!blob) continue;
    const path = clip.scene.stems[stem]!.file;
    if (!/^[a-zA-Z0-9_-]+\/(other|bass|drums|vocals)\.wav$/.test(path)) throw new Error('Library ZIP media paths must use scene_id/stem.wav.');
    if (written.has(path)) continue; written.add(path);
    const entry = new ZipPassThrough(path); zip.add(entry);
    for (let offset = 0; offset < blob.size; offset += 1024 * 1024) entry.push(new Uint8Array(await blob.slice(offset, offset + 1024 * 1024).arrayBuffer()), offset + 1024 * 1024 >= blob.size);
  }
  zip.end(); return new Blob(chunks, { type: 'application/zip' });
}
