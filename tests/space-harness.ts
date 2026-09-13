import { loadAssets, urlReader, type LoadedAssets, type LoadedScene } from '../src/audio/assets';
import { measure, renderEventPlan, startAction, type TimedEvent } from '../src/audio/offline';
import { createDeck, disposeDeck, scheduleDeckExit, updateSpace } from '../src/audio/deck';
import { validateManifest, type StemId } from '../src/config';
import type { SpaceState } from '../src/control/space';
import { testManifest, testScene } from './helpers';
const rate = 24000;
const hand = (presence = 1, height = .5, depth = .5): SpaceState => ({ enabled: true, presence, height, depth });
const rms = (samples: Float32Array, from = 0, to = samples.length) => {
  let sum = 0; for (let i = from; i < to; i++) sum += samples[i] ** 2;
  return Math.sqrt(sum / (to - from));
};
function difference(a: AudioBuffer, b: AudioBuffer, from = 0, to = a.length) {
  const x = a.getChannelData(0), y = b.getChannelData(0); let sum = 0;
  for (let i = from; i < to; i++) sum += (x[i] - y[i]) ** 2;
  return Math.sqrt(sum / (to - from));
}
function synthetic(context: BaseAudioContext, vocal = false): LoadedScene {
  const scene = testScene('a'); scene.sourceSampleRate = rate; scene.sourceFrameCount = rate * 4;
  scene.sceneTrimDb = -3; scene.stems.vocals = { file: 'v.wav', trimDb: 0 };
  for (const r of ['sparse', 'pulse', 'open'] as const) scene.recipes[r] = { other: 0, bass: -3, drums: -6, vocals: r === 'open' ? -3 : null };
  const buffers: LoadedScene['buffers'] = {};
  for (const id of ['other', 'bass', 'drums', 'vocals'] as StemId[]) {
    const buffer = context.createBuffer(1, rate * 4, rate), samples = buffer.getChannelData(0);
    for (let i = 0; i < samples.length; i++) {
      const t = i / rate, pulse = Math.exp(-(t % .5) * 18);
      samples[i] = id === 'vocals' ? vocal ? .15 * Math.sin(2 * Math.PI * 880 * t) : 0 : id === 'bass' ? .2 * Math.sin(2 * Math.PI * 110 * t) : id === 'drums' ? .2 * pulse * Math.sin(2 * Math.PI * 2300 * t) : .18 * (.35 + .65 * pulse) * Math.sin(2 * Math.PI * 440 * t);
    }
    buffers[id] = buffer;
  }
  return { scene, buffers, duration: 4, bytes: 0, fingerprint: '', mediaHashes: {} };
}
export async function spaceSynthetic() {
  const context = new OfflineAudioContext(2, rate, rate), silent = synthetic(context), singing = synthetic(context, true);
  const manifest = testManifest(); manifest.scenes = [silent.scene]; manifest.path = ['a']; manifest.edges = []; manifest.masterTrimDb = -3;
  const assets = (loaded: LoadedScene): LoadedAssets => ({ scenes: { a: loaded }, fingerprint: '', decodedBytes: 0, edgeFingerprints: {} });
  const render = (state: SpaceState, loaded = silent, events: TimedEvent[] = []) => renderEventPlan(manifest, assets(loaded), [{ at: 0, space: state }, { at: .05, action: startAction(assets(loaded), 'a', 'sparse', .05) }, ...events], 4, rate);
  const bed = await render(hand(0)), clear = await render(hand(1, 0, 0)), cloud = await render(hand(1, 1, 1)), lift = await render(hand(1, 1, 0));
  const voiceOff = await render(hand(0), singing), voiceOn = await render(hand(1, 1, 1), singing);
  const stopped = await render(hand(1, 1, 1), singing, [{ at: 2, action: { type: 'StopTransport', id: 2, generation: 2, at: 2 } }]);
  const exit = await render(hand(1, 1, 1), silent, [{ at: 1, space: hand(0, 1, 1) }]);
  return { entryDifference: difference(bed.buffer, clear.buffer, rate, rate * 2), heightDifference: difference(clear.buffer, lift.buffer, rate, rate * 2), depthDifference: difference(lift.buffer, cloud.buffer, rate, rate * 2),
    inactiveVocalLeak: difference(bed.buffer, voiceOff.buffer), activeVocalDifference: difference(cloud.buffer, voiceOn.buffer, rate, rate * 2),
    stopTail: rms(stopped.buffer.getChannelData(0), 2 * rate), releaseDifference: difference(exit.buffer, bed.buffer, Math.floor(1.8 * rate), 2 * rate), settledDifference: difference(exit.buffer, bed.buffer, Math.floor(3.7 * rate)),
    peakDbfs: Math.max(...[bed, clear, cloud, lift, voiceOff, voiceOn, exit].map(r => r.peakDbfs)), nonfinite: [bed, clear, cloud, lift, voiceOff, voiceOn, exit, stopped].reduce((n, r) => n + r.nonfinite, 0) };
}
export async function spaceTailAndReset() {
  const context = new OfflineAudioContext(2, rate * 5, rate), loaded = synthetic(context);
  // One brief instrumental event, then complete silence: only real effect tails can remain.
  for (const buffer of Object.values(loaded.buffers)) buffer.getChannelData(0).fill(0, rate / 4);
  const deck = createDeck(context, loaded, context.destination, 0, 'sparse', 1, 0, false, 1, hand(1, .8, 1));
  updateSpace(deck, hand(0, .8, 1), .3); scheduleDeckExit(deck, 2.98, 3);
  const rendered = measure(await context.startRendering()); disposeDeck(deck, 5);
  return { naturalTail: rms(rendered.buffer.getChannelData(0), rate, rate * 2), afterExit: rms(rendered.buffer.getChannelData(0), rate * 3), disposed: deck.disposed, peakDbfs: rendered.peakDbfs, nonfinite: rendered.nonfinite };
}
export async function sunSpace() {
  const context = new OfflineAudioContext(2, rate, rate), url = new URL('/scenes/love-supreme-sun/manifest.json', location.href);
  const manifest = validateManifest(await (await fetch(url)).json()), assets = await loadAssets(context, manifest, urlReader(url.href));
  const results = [];
  for (const id of manifest.path) {
    const loaded = assets.scenes[id], original = loaded.buffers.vocals;
    // A whole passage of vocal silence is a stronger regression than finding one quiet syllable.
    if (original) loaded.buffers.vocals = context.createBuffer(original.numberOfChannels, original.length, original.sampleRate);
    const render = (state: SpaceState) => renderEventPlan(manifest, assets, [{ at: 0, space: state }, { at: .05, action: startAction(assets, id, 'sparse', .05) }], loaded.duration + 1, rate);
    const bed = await render(hand(0)), low = await render(hand(1, 0, 0)), high = await render(hand(1, 1, 0)), cloud = await render(hand(1, 1, 1));
    loaded.buffers.vocals = original;
    const voices = await render(hand(1, 1, 1));
    results.push({ id, entryDifference: difference(bed.buffer, low.buffer, rate), heightDifference: difference(low.buffer, high.buffer, rate), depthDifference: difference(high.buffer, cloud.buffer, rate),
      voiceDifference: difference(cloud.buffer, voices.buffer, rate), nonfinite: [bed, low, high, cloud, voices].reduce((n, r) => n + r.nonfinite, 0), peakDbfs: Math.max(...[bed, low, high, cloud, voices].map(r => r.peakDbfs)) });
  }
  return results;
}
