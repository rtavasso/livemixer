export interface WavInfo { sampleRate: number; frames: number; channels: number; bits: number; format: number; blockAlign: number; dataOffset: number; dataBytes: number; duration: number }
const textAt = (v: DataView, at: number, size: number) => Array.from({ length: size }, (_, i) => String.fromCharCode(v.getUint8(at + i))).join('');
// Read chunk headers with slices: importing a 50-song library never decodes it all.
export async function inspectWav(file: Blob): Promise<WavInfo> {
  const header = new DataView(await file.slice(0, 12).arrayBuffer());
  if (header.byteLength < 12 || textAt(header, 0, 4) !== 'RIFF' || textAt(header, 8, 4) !== 'WAVE') throw new Error('Use PCM or float WAV stems (RIFF format).');
  let sampleRate = 0, channels = 0, bits = 0, format = 0, blockAlign = 0, dataOffset = 0, dataBytes = 0;
  for (let at = 12; at + 8 <= file.size;) {
    const h = new DataView(await file.slice(at, at + 8).arrayBuffer()), bytes = h.getUint32(4, true), id = textAt(h, 0, 4);
    if (at + 8 + bytes > file.size) throw new Error('Truncated WAV data.');
    if (id === 'fmt ') {
      const v = new DataView(await file.slice(at + 8, at + 8 + Math.min(bytes, 64)).arrayBuffer());
      if (v.byteLength < 16) throw new Error('Invalid WAV format chunk.');
      format = v.getUint16(0, true); channels = v.getUint16(2, true); sampleRate = v.getUint32(4, true); blockAlign = v.getUint16(12, true); bits = v.getUint16(14, true);
      if (format === 65534 && v.byteLength >= 40) format = v.getUint16(24, true);
    }
    if (id === 'data') { if (dataOffset) throw new Error('Multiple WAV data chunks are not supported by the library cutter.'); dataOffset = at + 8; dataBytes = bytes; }
    at += 8 + bytes + bytes % 2;
  }
  if (![1, 3].includes(format) || ![1, 2].includes(channels) || sampleRate < 8000 || sampleRate > 192000 || ![16, 24, 32, 64].includes(bits) || (format === 1 && bits === 64) || (format === 3 && bits !== 32 && bits !== 64) || blockAlign !== bits / 8 * channels || !dataBytes || dataBytes % blockAlign) throw new Error('Supported: mono/stereo PCM 16/24/32-bit or float 32/64-bit WAV, 8–192 kHz.');
  const frames = dataBytes / blockAlign;
  return { sampleRate, frames, channels, bits, format, blockAlign, dataOffset, dataBytes, duration: frames / sampleRate };
}
export function pcmValue(v: DataView, at: number, info: Pick<WavInfo, 'bits' | 'format'>): number {
  if (info.format === 3) return info.bits === 32 ? v.getFloat32(at, true) : v.getFloat64(at, true);
  if (info.bits === 16) return v.getInt16(at, true) / 32768;
  if (info.bits === 32) return v.getInt32(at, true) / 2147483648;
  const raw = v.getUint8(at) | v.getUint8(at + 1) << 8 | v.getUint8(at + 2) << 16;
  return (raw & 0x800000 ? raw - 0x1000000 : raw) / 8388608;
}
export function cropWav(file: Blob, info: WavInfo, startFrame: number, frameCount: number): Blob {
  if (!Number.isInteger(startFrame) || !Number.isInteger(frameCount) || startFrame < 0 || frameCount <= 0 || startFrame + frameCount > info.frames) throw new Error('Selected passage is outside the aligned source.');
  const dataBytes = frameCount * info.blockAlign, header = new ArrayBuffer(44), v = new DataView(header);
  const str = (at: number, text: string) => [...text].forEach((c, i) => v.setUint8(at + i, c.charCodeAt(0)));
  str(0, 'RIFF'); v.setUint32(4, 36 + dataBytes + dataBytes % 2, true); str(8, 'WAVEfmt '); v.setUint32(16, 16, true); v.setUint16(20, info.format, true); v.setUint16(22, info.channels, true);
  v.setUint32(24, info.sampleRate, true); v.setUint32(28, info.sampleRate * info.blockAlign, true); v.setUint16(32, info.blockAlign, true); v.setUint16(34, info.bits, true); str(36, 'data'); v.setUint32(40, dataBytes, true);
  const start = info.dataOffset + startFrame * info.blockAlign;
  return new Blob([header, file.slice(start, start + dataBytes), ...(dataBytes % 2 ? [new Uint8Array(1)] : [])], { type: 'audio/wav' });
}
