import { mkdir, writeFile } from 'node:fs/promises';
import { DEFAULT_CONTROL, validateManifest, type Manifest, type Scene, type StemId } from '../src/config';
const rate = 24000;
function wav(samples: Float32Array) {
  const bytes = Buffer.alloc(44 + samples.length * 2);
  bytes.write('RIFF', 0); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(rate, 24); bytes.writeUInt32LE(rate * 2, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(samples.length * 2, 40);
  samples.forEach((v, i) => bytes.writeInt16LE(Math.round(Math.max(-1, Math.min(1, v)) * 32767), 44 + i * 2)); return bytes;
}
const scenes: Scene[] = [];
for (const [index, bpm, pitch] of [[0, 120, 220], [1, 100, 300]] as const) {
  const id = `fixture_${index + 1}`, duration = 16 * 60 / bpm, frames = Math.round(duration * rate), dir = `public/fixtures/${id}`;
  await mkdir(dir, { recursive: true });
  const stems: Scene['stems'] = {};
  for (const stem of ['other', 'bass', 'drums'] as StemId[]) {
    const signal = new Float32Array(frames);
    for (let i = 0; i < frames; i++) {
      const t = i / rate, beatPhase = (t * bpm / 60) % 1, marker = i % Math.round(rate * 60 / bpm) === 0 ? .08 : 0;
      signal[i] = stem === 'other' ? .055 * (Math.sin(2 * Math.PI * pitch * t) + .6 * Math.sin(2 * Math.PI * pitch * 3 * t) + .3 * Math.sin(2 * Math.PI * pitch * 9 * t)) + marker
        : stem === 'bass' ? .10 * Math.sin(2 * Math.PI * pitch / 4 * t) * (.6 + .4 * Math.exp(-beatPhase * 8)) + marker
          : .12 * Math.sin(2 * Math.PI * 70 * t) * Math.exp(-beatPhase * 35) + .025 * Math.sin(2 * Math.PI * 4100 * t) * Math.exp(-(beatPhase % .5) * 60) + marker;
    }
    await writeFile(`${dir}/${stem}.wav`, wav(signal));
    stems[stem] = { file: `${id}/${stem}.wav`, trimDb: 0 };
  }
  scenes.push({ id, sourceSongId: `synthetic-${index}`, label: `TEST ${index + 1} · ${bpm} BPM / ${pitch} Hz`, sourceSampleRate: rate, sourceFrameCount: frames, loopBars: 4, beatsPerBar: 4, nominalBpm: bpm, recipeQuantizationBars: 1, anchorStem: 'other', stems,
    recipes: { sparse: { other: 0, bass: null, drums: null }, pulse: { other: 0, bass: -6, drums: -10 }, open: { other: 0, bass: -2, drums: -3 } },
    filter: { minHz: 800, maxHz: 8000, q: 0 }, sceneTrimDb: -3,
    approval: { recipes: false, recipeTransitions: false, loopSeam: false, filterRange: false, notes: 'Synthetic engineering fixture only. No musical approval implied.' } });
}
const manifest: Manifest = validateManifest({ version: 1, label: 'Engineering fixtures · synthetic audio', scenes, path: scenes.map(s => s.id), repeatPath: true,
  edges: [[0, 1], [1, 0]].map(([a, b]) => ({ from: scenes[a].id, to: scenes[b].id, kind: 'fade_to_zero_reset', fadeOutBeats: 1, fadeInMs: 10, approved: false, notes: 'Synthetic reset test; not a reviewed musical edge.' })), masterTrimDb: -9, control: DEFAULT_CONTROL });
await writeFile('public/fixtures/manifest.json', JSON.stringify(manifest, null, 2) + '\n');
console.log('Generated two clearly labeled synthetic scenes (120 and 100 BPM). Approval remains false.');
