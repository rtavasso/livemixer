import { readdir, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { wavMetadata } from '../src/audio/assets';
const root = process.argv[2];
if (!root) throw new Error('Usage: npm run inspect:stems -- "D:/My scene folder"');
async function inspect(dir: string): Promise<void> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await inspect(path);
    else if (entry.name.toLowerCase().endsWith('.wav')) {
      try {
        const bytes = await readFile(path), m = wavMetadata(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
        console.log(JSON.stringify({ file: path, sourceSampleRate: m.sampleRate, sourceFrameCount: m.frames, channels: m.channels, seconds: m.frames / m.sampleRate, fourBarBpm: 16 * 60 * m.sampleRate / m.frames }));
      } catch (error) { console.error(`${path}: ${String(error)}`); process.exitCode = 1; }
    }
  }
}
await inspect(resolve(root));
