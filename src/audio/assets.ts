import { edgeFingerprint, sceneFingerprint, sha256, stableJson, STEMS, type Manifest, type Scene, type StemId } from '../config';
export interface LoadedScene { scene: Scene; buffers: Partial<Record<StemId, AudioBuffer>>; duration: number; fingerprint: string; mediaHashes: Partial<Record<StemId, string>>; bytes: number }
export interface LoadedAssets { scenes: Record<string, LoadedScene>; edgeFingerprints: Record<string, string>; fingerprint: string; decodedBytes: number }
export type ReadMedia = (path: string) => Promise<ArrayBuffer>;
export function urlReader(baseUrl: string): ReadMedia {
  return async path => {
    const response = await fetch(new URL(path, baseUrl));
    if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
    return response.arrayBuffer();
  };
}
export function localReader(files: File[]): ReadMedia {
  return async path => {
    const normalized = decodeURIComponent(path).replaceAll('\\', '/').replace(/^\.\//, '').replace(/^\//, '');
    const matches = files.filter(f => { const p = (f.webkitRelativePath || f.name).replaceAll('\\', '/'); return p === normalized || p.endsWith('/' + normalized); });
    const selected = matches.length ? matches : files.filter(f => f.name === normalized.split('/').at(-1));
    if (selected.length !== 1) throw new Error(`${path}: ${selected.length ? 'ambiguous file name; retain folder structure' : 'file missing from selected folder'}.`);
    return selected[0].arrayBuffer();
  };
}
// Inspect WAV source metadata before decodeAudioData resamples it.
export function wavMetadata(bytes: ArrayBuffer): { sampleRate: number; frames: number; channels: number } {
  const v = new DataView(bytes), text = (at: number, n: number) => String.fromCharCode(...new Uint8Array(bytes, at, n));
  if (bytes.byteLength < 44 || text(0, 4) !== 'RIFF' || text(8, 4) !== 'WAVE') throw new Error('Expected a RIFF WAV file.');
  let sampleRate = 0, align = 0, channels = 0, dataSize = 0;
  for (let p = 12; p + 8 <= v.byteLength;) {
    const size = v.getUint32(p + 4, true), id = text(p, 4);
    if (p + 8 + size > v.byteLength) throw new Error('Truncated WAV chunk.');
    if (id === 'fmt ' && size >= 16) { channels = v.getUint16(p + 10, true); sampleRate = v.getUint32(p + 12, true); align = v.getUint16(p + 20, true); }
    if (id === 'data') dataSize += size;
    p += 8 + size + size % 2;
  }
  if (!sampleRate || !align || !channels || channels > 2 || !dataSize || dataSize % align) throw new Error('WAV must have valid mono/stereo sample data.');
  return { sampleRate, channels, frames: dataSize / align };
}
export function validateDecoded(scene: Scene, buffers: AudioBuffer[]): number {
  if (!buffers.length || buffers.some(b => b.length !== buffers[0].length || b.sampleRate !== buffers[0].sampleRate)) throw new Error(`${scene.label}: decoded stems have different lengths or rates.`);
  const duration = buffers[0].length / buffers[0].sampleRate;
  const tolerance = 2 / buffers[0].sampleRate + 1 / scene.sourceSampleRate;
  if (Math.abs(duration - scene.sourceFrameCount / scene.sourceSampleRate) > tolerance) throw new Error(`${scene.label}: decoded duration does not match source metadata.`);
  return duration;
}
export async function loadAssets(context: BaseAudioContext, manifest: Manifest, read: ReadMedia, progress: (message: string) => void = () => {}): Promise<LoadedAssets> {
  const scenes: Record<string, LoadedScene> = {}; let decodedBytes = 0;
  for (const scene of manifest.scenes) {
    const buffers: LoadedScene['buffers'] = {}, mediaHashes: LoadedScene['mediaHashes'] = {}; let bytes = 0;
    for (const id of STEMS) {
      const asset = scene.stems[id]; if (!asset) continue;
      progress(`Loading ${scene.label} / ${id}…`);
      let media: ArrayBuffer, metadata: ReturnType<typeof wavMetadata>;
      try { media = await read(asset.file); metadata = wavMetadata(media); }
      catch (error) { throw new Error(`${scene.label} / ${id} (${asset.file}): ${error instanceof Error ? error.message : String(error)}`); }
      if (metadata.sampleRate !== scene.sourceSampleRate || metadata.frames !== scene.sourceFrameCount) throw new Error(`${scene.label} / ${id}: WAV source rate/frame count differs from manifest (${metadata.sampleRate} Hz, ${metadata.frames} frames).`);
      mediaHashes[id] = await sha256(media);
      let buffer: AudioBuffer;
      try { buffer = await context.decodeAudioData(media.slice(0)); }
      catch (error) { throw new Error(`${scene.label} / ${id} (${asset.file}): audio decode failed: ${String(error)}`); }
      for (let c = 0; c < buffer.numberOfChannels; c++) if (buffer.getChannelData(c).some(v => !Number.isFinite(v))) throw new Error(`${scene.label} / ${id}: nonfinite audio samples.`);
      buffers[id] = buffer; bytes += buffer.length * buffer.numberOfChannels * 4;
    }
    const duration = validateDecoded(scene, Object.values(buffers)); decodedBytes += bytes;
    if (decodedBytes > 512 * 1024 * 1024) throw new Error('Decoded audio exceeds the 512 MiB local demo limit. Use shorter excerpts.');
    scenes[scene.id] = { scene, buffers, duration, bytes, mediaHashes, fingerprint: await sceneFingerprint(scene, mediaHashes, manifest.masterTrimDb, manifest.control) };
  }
  const fingerprints = Object.fromEntries(Object.entries(scenes).map(([id, scene]) => [id, scene.fingerprint]));
  const edgeFingerprints: Record<string, string> = {};
  for (const edge of manifest.edges) edgeFingerprints[`${edge.from}→${edge.to}`] = await edgeFingerprint(edge, fingerprints);
  return { scenes, edgeFingerprints, decodedBytes, fingerprint: await sha256(stableJson({ manifest, fingerprints })) };
}
