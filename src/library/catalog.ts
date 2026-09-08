import { DEFAULT_CONTROL, STEMS, validateManifest, type Manifest, type StemId } from '../config';
import { cropWav, inspectWav } from './wav';
import type { LibraryClip, LibrarySong } from './types';
export function identifyStem(name: string): { stem?: StemId; prefix: string } {
  const base = name.replace(/\.wav$/i, ''), match = base.match(/^(.*?)(?:[\s_.-]*)(other|bass|drums?|vocals?|instrumental|accompaniment)$/i);
  if (!match) return { prefix: base };
  const raw = match[2].toLowerCase();
  const stem: StemId = raw === 'bass' ? 'bass' : raw.startsWith('drum') ? 'drums' : raw.startsWith('vocal') ? 'vocals' : 'other';
  return { stem, prefix: match[1].replace(/[\s_.-]+$/, '') };
}
export function libraryId(path: string) {
  let hash = 2166136261; for (const c of path) hash = Math.imul(hash ^ c.charCodeAt(0), 16777619);
  return `song_${(hash >>> 0).toString(16)}`;
}
export function groupLibrary(files: File[]): LibrarySong[] {
  const groups = new Map<string, LibrarySong>();
  for (const file of files.filter(f => /\.wav$/i.test(f.name))) {
    const path = file.webkitRelativePath || file.name, parts = path.replaceAll('\\', '/').split('/'), parent = parts.slice(0, -1).join('/'), found = identifyStem(file.name);
    // Handles both Demucs-style folders and SongName_bass.wav flat libraries.
    const directory = found.prefix && found.stem ? `${parent}/${found.prefix}` : parent || 'Selected files';
    let song = groups.get(directory);
    if (!song) { song = { id: libraryId(directory), label: directory.split('/').filter(Boolean).at(-1) || 'Untitled song', directory, files: [], stems: {}, metadata: {}, issues: [], signature: '', gridOffset: 0, startBar: 1, loopBars: 4, notes: '' }; groups.set(directory, song); }
    song.files.push(file);
    if (found.stem && !song.stems[found.stem]) song.stems[found.stem] = file;
    else if (found.stem) song.issues.push(`Duplicate ${found.stem}; choose its file in Stem assignment.`);
  }
  return [...groups.values()].map(song => ({ ...song, signature: song.files.map(f => `${f.name}:${f.size}:${f.lastModified}`).sort().join('|') })).sort((a, b) => a.label.localeCompare(b.label));
}
export async function inspectSong(song: LibrarySong) {
  song.metadata = {}; song.issues = song.issues.filter(issue => issue.startsWith('Duplicate '));
  const used = new Set<File>();
  for (const stem of STEMS) {
    const file = song.stems[stem]; if (!file) continue;
    if (used.has(file)) song.issues.push(`${file.name} is assigned to more than one role.`); used.add(file);
    try { song.metadata[stem] = await inspectWav(file); } catch (error) { song.issues.push(`${stem}: ${String(error)}`); }
  }
  for (const stem of ['other', 'bass', 'drums'] as StemId[]) if (!song.stems[stem]) song.issues.push(`Missing ${stem}. Assign its file below.`);
  const metadata = Object.values(song.metadata), first = metadata[0];
  if (first && metadata.some(m => m.sampleRate !== first.sampleRate || m.frames !== first.frames)) song.issues.push('Stems have unequal source rates or frame counts. Align/export the group before building a scene.');
  return song;
}
export function selection(song: LibrarySong) {
  const info = song.metadata.other ?? Object.values(song.metadata)[0];
  if (!info) throw new Error('No readable WAV metadata.');
  const bpm = song.bpm ?? song.analysis?.tempo.bpm ?? 120;
  if (!Number.isFinite(bpm) || bpm < 20 || bpm > 300 || !Number.isFinite(song.gridOffset) || song.gridOffset < 0 || !Number.isInteger(song.startBar) || song.startBar < 1) throw new Error('Use a BPM between 20 and 300, a nonnegative downbeat offset, and a whole start bar ≥1.');
  const startSeconds = song.gridOffset + (song.startBar - 1) * 240 / bpm;
  const startFrame = Math.round(startSeconds * info.sampleRate), frameCount = Math.round(song.loopBars * 240 / bpm * info.sampleRate);
  if (startFrame + frameCount > info.frames) throw new Error('This complete passage extends beyond the source. Choose an earlier bar or shorter loop.');
  return { startFrame, frameCount, sampleRate: info.sampleRate, duration: frameCount / info.sampleRate, startSeconds: startFrame / info.sampleRate, bpm };
}
export function createClip(song: LibrarySong, id: string, includeVocals = false): LibraryClip {
  if (song.issues.length) throw new Error(song.issues.join('\n'));
  const range = selection(song), files: LibraryClip['files'] = {}, stems: LibraryClip['scene']['stems'] = {};
  for (const stem of STEMS) {
    if (stem === 'vocals' && !includeVocals) continue;
    const file = song.stems[stem], info = song.metadata[stem]; if (!file || !info) continue;
    files[stem] = cropWav(file, info, range.startFrame, range.frameCount); stems[stem] = { file: `${id}/${stem}.wav`, trimDb: 0 };
  }
  const vocals = !!stems.vocals;
  const scene: LibraryClip['scene'] = {
    id, sourceSongId: song.id, label: `${song.label} · bars ${song.startBar}–${song.startBar + song.loopBars - 1}`, sourceSampleRate: range.sampleRate, sourceFrameCount: range.frameCount,
    loopBars: song.loopBars, beatsPerBar: 4, nominalBpm: range.bpm, keyLabel: song.key || song.analysis?.key.label || '', recipeQuantizationBars: vocals ? song.loopBars : 1, anchorStem: 'other', stems,
    recipes: { sparse: { other: 0, bass: null, drums: null, ...(vocals ? { vocals: null } : {}) }, pulse: { other: 0, bass: -6, drums: -10, ...(vocals ? { vocals: null } : {}) }, open: { other: 0, bass: -2, drums: -3, ...(vocals ? { vocals: -8 } : {}) } },
    filter: { minHz: 800, maxHz: 8000, q: 0 }, sceneTrimDb: -3,
    approval: { recipes: false, recipeTransitions: false, loopSeam: false, filterRange: false, notes: `${song.notes}\nLibrary selection at ${range.startSeconds.toFixed(6)} s. Verify the downbeat, tempo, seams, and all recipe changes by listening.`.trim() },
  };
  return { id, songId: song.id, scene, startFrame: range.startFrame, files };
}
export function clipsManifest(clips: LibraryClip[], repeatPath: boolean, notes: Record<string, string> = {}, prior?: Manifest): Manifest {
  const path = clips.map(c => c.id), pairs = path.slice(0, -1).map((from, i) => [from, path[i + 1]]);
  if (repeatPath && path.length > 1) pairs.push([path.at(-1)!, path[0]]);
  return validateManifest({ version: 1, label: prior?.label ?? 'My authored library mix', scenes: clips.map(c => c.scene), path, repeatPath: repeatPath && path.length > 1, masterTrimDb: prior?.masterTrimDb ?? -9, control: prior?.control ?? DEFAULT_CONTROL,
    edges: pairs.map(([from, to]) => {
      const reviewed = prior?.edges.find(e => e.from === from && e.to === to);
      return { from, to, kind: 'fade_to_zero_reset', fadeOutBeats: 1, fadeInMs: 10, approved: false, ...reviewed, notes: notes[`${from}→${to}`] ?? reviewed?.notes ?? 'Review the outgoing ending and incoming downbeat in all nine recipe combinations.' };
    }) });
}
export function candidateConnections(from: LibrarySong, songs: LibrarySong[]) {
  const bpm = from.bpm ?? from.analysis?.tempo.bpm;
  const energy = from.analysis?.stems.other?.rmsDbfs;
  return songs.filter(s => s.id !== from.id).map(song => {
    const nextBpm = song.bpm ?? song.analysis?.tempo.bpm, nextEnergy = song.analysis?.stems.other?.rmsDbfs;
    const tempoDelta = bpm && nextBpm ? 100 * (nextBpm / bpm - 1) : null, energyDelta = energy != null && nextEnergy != null ? nextEnergy - energy : null;
    return { song, tempoDelta, energyDelta, score: (tempoDelta === null ? 30 : Math.abs(tempoDelta)) + (energyDelta === null ? 10 : Math.abs(energyDelta)) };
  }).sort((a, b) => a.score - b.score || a.song.label.localeCompare(b.song.label)).slice(0, 6);
}
