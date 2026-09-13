export function fullBufferLoopEnd(buffer: Pick<AudioBuffer, 'length' | 'sampleRate'>): number {
  const duration = buffer.length / buffer.sampleRate;
  // Seconds -> frames can round above the buffer end (e.g. 1,038,095 frames
  // at 48 kHz). Chromium's unity-rate loop then repeats its last render block.
  // Keep the endpoint inside the buffer by floating-point precision only: no
  // sample is removed, and all stems retain their native period and phase.
  return duration * buffer.sampleRate > buffer.length ? duration - Number.EPSILON * duration : duration;
}

export function setFullBufferLoop(source: AudioBufferSourceNode, buffer: AudioBuffer) {
  source.buffer = buffer;
  source.loop = true;
  source.loopStart = 0;
  // The default loopEnd=0 takes the same faulty duration conversion in Chromium.
  source.loopEnd = fullBufferLoopEnd(buffer);
}
