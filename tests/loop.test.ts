import { expect, it } from 'vitest';
import { fullBufferLoopEnd } from '../src/audio/loop';

it('keeps loop endpoints within the decoded frames without dropping a sample', () => {
  for (const sampleRate of [8000, 16000, 24000, 44100, 48000, 96000, 192000]) {
    for (const length of [1, 127, 128, 24002, 44107, 48003, 953750, 1038095, 16777215]) {
      const end = fullBufferLoopEnd({ length, sampleRate });
      expect(end * sampleRate).toBeLessThanOrEqual(length);
      expect(length - end * sampleRate).toBeLessThan(.000001);
      if (length / sampleRate * sampleRate === length) expect(end).toBe(length / sampleRate);
    }
  }
});
