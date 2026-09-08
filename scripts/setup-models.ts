import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const url = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';
const expected = 'fbc2a30080c3c557093b5ddfc334698132eb341044ccee322ccf8bcf3607cde1';
const path = 'public/models/hand_landmarker.task';
await mkdir('public/models/wasm', { recursive: true });
let bytes: Buffer | undefined;
try { bytes = await readFile(path); } catch { /* First setup downloads the pinned version. */ }
if (!bytes || createHash('sha256').update(bytes).digest('hex') !== expected) {
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`Model download failed: HTTP ${response.status}`);
  bytes = Buffer.from(await response.arrayBuffer());
  if (createHash('sha256').update(bytes).digest('hex') !== expected) throw new Error('Pinned model checksum mismatch; no file was installed.');
  await writeFile(path, bytes);
}
await cp('node_modules/@mediapipe/tasks-vision/wasm', 'public/models/wasm', { recursive: true });
const pkg = JSON.parse(await readFile('node_modules/@mediapipe/tasks-vision/package.json', 'utf8'));
await writeFile('public/models/assets.json', JSON.stringify({ package: '@mediapipe/tasks-vision', version: pkg.version, modelUrl: url, modelSha256: expected }, null, 2) + '\n');
console.log(`Local model verified; matching WASM copied from @mediapipe/tasks-vision ${pkg.version}.`);
