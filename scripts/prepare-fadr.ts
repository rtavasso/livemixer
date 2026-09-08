import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { parseArgs } from 'node:util';
import { STEMS, type StemId } from '../src/config';
import { analyzeSong } from '../src/library/analysis';
import { clipsManifest, createClip, groupLibrary, inspectSong } from '../src/library/catalog';
import { saveProject } from '../src/library/project';
import { inspectWav } from '../src/library/wav';

// All generated media stays under ignored public/scenes. Originals are read only.
const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  id: { type: 'string' }, label: { type: 'string' }, bpm: { type: 'string' },
  start: { type: 'string' }, starts: { type: 'string' }, bars: { type: 'string', default: '8' }, reuse: { type: 'boolean', default: false },
} });
if (positionals.length !== 1 || !values.id || !/^[a-z0-9][a-z0-9_-]{0,60}$/.test(values.id)) {
  throw new Error('Usage: npm run prepare:fadr -- "stem folder" --id song-id [--label "Artist — Song"] [--bpm 120 --start 32 --bars 8] [--reuse]');
}
const folder = resolve(positionals[0]), id = values.id, label = values.label ?? id;
const output = resolve('public/scenes', id), sourceDir = join(output, 'source');
if (values.start !== undefined && values.starts !== undefined) throw new Error('Use --start or --starts, not both.');
const starts = (values.starts ?? values.start)?.split(',').map(Number);
if (starts && (!starts.length || starts.length > 50 || starts.some(n => !Number.isFinite(n) || n < 0))) throw new Error('Use 1–50 nonnegative comma-separated start times.');
const bars = Number(values.bars), bpm = values.bpm === undefined ? undefined : Number(values.bpm), start = starts?.[0];
if (![4, 8].includes(bars) || (bpm !== undefined && (!Number.isFinite(bpm) || bpm < 20 || bpm > 300)) || (start !== undefined && (!Number.isFinite(start) || start < 0))) throw new Error('Use 4 or 8 bars, BPM 20–300, and a nonnegative start in seconds.');
if ((bpm === undefined) !== (start === undefined)) throw new Error('Supply both --bpm and --start to create an excerpt, or neither to analyze the full song first.');
const names = await readdir(folder);
function find(role: string) {
  const matches = names.filter(name => name.toLowerCase().startsWith(`${role} - `) && /\.(mp3|wav)$/i.test(name));
  if (matches.length !== 1) throw new Error(`Expected one "${role} - … .mp3/.wav" file; found ${matches.length}.`);
  return join(folder, matches[0]);
}
const inputs = { bass: find('bass'), drums: find('drums'), vocals: find('vocals'), guitar: find('guitar'), piano: find('piano'), remainder: find('pro-other') };
const inventory = await Promise.all(Object.entries(inputs).map(async ([role, path]) => ({ role, name: path.slice(folder.length + 1), sha256: createHash('sha256').update(await readFile(path)).digest('hex') })));
const fingerprint = createHash('sha256').update(JSON.stringify(inventory)).digest('hex');
let exists = false; try { await stat(output); exists = true; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
if (exists && !values.reuse) throw new Error(`Output already exists: ${output}. Choose another --id, or --reuse to reuse verified sources and regenerate this draft.`);
if (values.reuse) {
  const prior = JSON.parse(await readFile(join(output, 'preparation.local.json'), 'utf8'));
  if (prior.fingerprint !== fingerprint) throw new Error('Source audio changed. Use a new --id to prepare a separate collection.');
} else {
  await mkdir(sourceDir, { recursive: true });
  const run = (args: string[]) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-n', ...args], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  // Decode every component at its native rate, including MP3 delay/padding metadata.
  // Float WAV keeps decoder overshoots and summing headroom, without normalization.
  for (const [role, path] of Object.entries(inputs)) {
    console.log(`Decoding ${role}…`);
    run(['-i', path, '-map', '0:a:0', '-map_metadata', '-1', '-c:a', 'pcm_f32le', join(sourceDir, `${role}.wav`)]);
  }
  const metadata = await Promise.all(Object.keys(inputs).map(async role => inspectWav(new Blob([await readFile(join(sourceDir, `${role}.wav`))]))));
  const first = metadata[0];
  if (metadata.some(info => info.frames !== first.frames || info.sampleRate !== first.sampleRate || info.channels !== first.channels)) throw new Error('Decoded sources have unequal frames, rates, or channels. No padding, trimming, or resampling was applied; align the source group first.');
  console.log(`Summing guitar + piano + Pro-other; ${first.frames} aligned frames at ${first.sampleRate} Hz.`);
  run(['-i', join(sourceDir, 'guitar.wav'), '-i', join(sourceDir, 'piano.wav'), '-i', join(sourceDir, 'remainder.wav'), '-filter_complex', '[0:a][1:a][2:a]amix=inputs=3:normalize=0:duration=longest[out]', '-map', '[out]', '-map_metadata', '-1', '-c:a', 'pcm_f32le', join(sourceDir, 'other.wav')]);
  await writeFile(join(output, 'preparation.local.json'), JSON.stringify({ version: 1, fingerprint, inventory, conversion: 'Native-rate float WAV; other = guitar + piano + Pro-other, unity sum. Instrumental reference excluded.', sampleRate: first.sampleRate, frames: first.frames, duration: first.duration }, null, 2));
}
const files: File[] = [];
for (const stem of STEMS) files.push(new File([await readFile(join(sourceDir, `${stem}.wav`))], `${label}_${stem}.wav`, { type: 'audio/wav', lastModified: 0 }));
const song = groupLibrary(files)[0]; await inspectSong(song);
if (song.issues.length) throw new Error(song.issues.join('\n'));
if (values.reuse) {
  song.analysis = JSON.parse(await readFile(join(output, 'analysis.local.json'), 'utf8'));
} else {
  song.analysis = await analyzeSong(Object.fromEntries(STEMS.map(stem => [stem, { file: song.stems[stem]!, info: song.metadata[stem]! }])), stem => console.log(`Analyzing ${stem}…`));
  await writeFile(join(output, 'analysis.local.json'), JSON.stringify(song.analysis, null, 2));
}
console.log(JSON.stringify({ duration: song.metadata.other!.duration, tempoEstimate: song.analysis!.tempo, keyEstimate: song.analysis!.key.label, levels: Object.fromEntries(STEMS.map(stem => { const s = song.analysis!.stems[stem]!; return [stem, { peakDbfs: s.peakDbfs, rmsDbfs: s.rmsDbfs, nonfinite: s.nonfinite }]; })) }, null, 2));
if (bpm !== undefined && start !== undefined) {
  song.bpm = bpm; song.gridOffset = start; song.loopBars = bars as 4 | 8;
  song.notes = 'Prepared from Fadr exports. Harmonic stem = guitar + piano + Pro-other; Instrumental reference excluded. Grid, phrase boundaries, and loop seam are draft selections awaiting listening review.';
  const clips = starts!.map((time, index) => {
  const clip = createClip({ ...song, gridOffset: time }, `${id}_passage_${index + 1}`, true);
  clip.scene.label = `${label} / ${index + 1} / ${Math.floor(time / 60)}:${String(Math.floor(time % 60)).padStart(2, '0')}`;
  // Keep the room's instrumental bed present in every recipe. Open invites vocals.
  clip.scene.recipes = { sparse: { other: 0, bass: -3, drums: -6, vocals: null }, pulse: { other: 0, bass: -3, drums: -6, vocals: null }, open: { other: 0, bass: -3, drums: -6, vocals: -3 } };
  clip.scene.filter = { minHz: 180, maxHz: 12000, q: 0, target: 'instrumental' };
  clip.scene.sceneTrimDb = -3;
  return clip;
  });
  const repeat = clips.length > 1;
  const manifest = clipsManifest(clips, repeat); manifest.label = `${label} · ${clips.length} musical passage${clips.length > 1 ? 's' : ''}`; manifest.masterTrimDb = -6;
  for (const clip of clips) for (const stem of STEMS) {
    await mkdir(join(output, clip.id), { recursive: true });
    await writeFile(join(output, clip.scene.stems[stem]!.file), new Uint8Array(await clip.files[stem]!.arrayBuffer()));
  }
  await writeFile(join(output, 'manifest.json'), JSON.stringify(manifest, null, 2));
  await writeFile(join(output, 'project.json'), saveProject([song], clips, repeat, {}, manifest));
  await writeFile(join(output, 'library.json'), JSON.stringify({ version: 1, label, files: STEMS.map((stem: StemId) => ({ name: `${label}_${stem}.wav`, path: `source/${stem}.wav`, lastModified: 0 })), project: 'project.json' }, null, 2));
  await writeFile(resolve('public/scenes/default.local.json'), JSON.stringify({ collection: id }, null, 2));
  console.log(`Prepared unapproved draft: http://127.0.0.1:4178/?collection=${id}`);
} else console.log('Analysis saved. Select BPM and excerpt start, then rerun with --reuse --bpm … --start … to create a playable draft.');
