import { createDeck, disposeDeck } from '../src/audio/deck';
import type { LoadedScene } from '../src/audio/assets';
import { dbToGain, type StemId } from '../src/config';
import { testScene } from './helpers';

// Compare the actual looping deck against one non-looping buffer containing three
// copies. Peak/headroom tests alone cannot detect a repeating render-block buzz.
export async function loopFidelity() {
  const results = [];
  for (const sampleRate of [44100, 48000]) for (const playbackRate of [.9, 1, 1.1]) for (const hand of [false, true]) {
    const frames = sampleRate === 48000 ? 48003 : 44107, loops = 3, startFrame = 4800;
    const context = new OfflineAudioContext(2, startFrame + Math.ceil(frames * loops / playbackRate), sampleRate);
    const scene = testScene('loop'); scene.sceneTrimDb = 0;
    for (const r of ['sparse', 'pulse', 'open'] as const) scene.recipes[r] = { other: 0, bass: -6, drums: -9 };
    const buffers: LoadedScene['buffers'] = {}, mixed = new Float32Array(frames);
    for (const [index, id] of (['other', 'bass', 'drums'] as StemId[]).entries()) {
      const buffer = context.createBuffer(1, frames, sampleRate), data = buffer.getChannelData(0);
      const gain = dbToGain(scene.recipes.open[id]!) * (hand ? .5 * (id === 'other' ? .68 : .85) : 1);
      for (let i = 0; i < frames; i++) {
        data[i] = .08 * Math.sin(i * (.024 + index * .017)) + .03 * Math.sin(i * i * .0000007);
        mixed[i] += data[i] * gain;
      }
      buffers[id] = buffer;
    }
    const reference = context.createBuffer(1, frames * loops, sampleRate), refData = reference.getChannelData(0);
    for (let loop = 0; loop < loops; loop++) refData.set(mixed, loop * frames);
    const merger = context.createChannelMerger(2), output = context.createGain();
    output.connect(merger, 0, 0); merger.connect(context.destination);
    const loaded: LoadedScene = { scene, buffers, duration: frames / sampleRate, bytes: 0, fingerprint: '', mediaHashes: {} };
    const deck = createDeck(context, loaded, output, startFrame / sampleRate, 'open', .75, 0, true, playbackRate, { enabled: hand, presence: 0, height: .5, depth: .35 });
    const ref = context.createBufferSource(); ref.buffer = reference; ref.playbackRate.value = playbackRate;
    ref.connect(merger, 0, 1); ref.start(startFrame / sampleRate);
    const rendered = await context.startRendering(), actual = rendered.getChannelData(0), expected = rendered.getChannelData(1);
    const errors = [0, 0, 0]; let nonfinite = 0;
    for (let i = startFrame; i < actual.length - 2; i++) {
      if (!Number.isFinite(actual[i])) nonfinite++;
      // Native interpolation at a discontinuous seam can differ by one sample
      // from a concatenated buffer. Inspect the music throughout each loop.
      const phase = (i - startFrame) * playbackRate % frames;
      if (phase < 3 || phase > frames - 3) continue;
      const loop = Math.min(2, Math.floor((i - startFrame) * playbackRate / frames));
      errors[loop] = Math.max(errors[loop], Math.abs(actual[i] - expected[i]));
    }
    results.push({ sampleRate, playbackRate, hand, errors, nonfinite });
    disposeDeck(deck, context.currentTime); ref.disconnect(); output.disconnect(); merger.disconnect();
  }
  return results;
}
