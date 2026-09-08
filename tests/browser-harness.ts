import { dbToGain, validateManifest, type Manifest, type RecipeId, type StemId } from '../src/config';
import { loadAssets, urlReader, type LoadedAssets, type LoadedScene } from '../src/audio/assets';
import { createDeck, rampRecipe, scheduleDeckExit, setFilterBypass, updateFilter } from '../src/audio/deck';
import { AudioEngine } from '../src/audio/engine';
import { allAuditions, auditionPlan, renderEventPlan } from '../src/audio/offline';
import { OwnedEnvelope } from '../src/audio/automation';
import { testManifest, testScene } from './helpers';
const rate = 48000;
export async function instrumentalTone() {
  const render = async (u: number, bypass: boolean) => {
    const context = new OfflineAudioContext(2, rate, rate);
    const loaded = bufferScene(context, 'tone', rate, () => 0);
    loaded.scene.filter = { minHz: 180, maxHz: 12000, q: 0, target: 'instrumental' };
    loaded.scene.stems.vocals = { file: 'vocals.wav', trimDb: 0 };
    for (const recipe of ['sparse', 'pulse', 'open'] as const) loaded.scene.recipes[recipe].vocals = 0;
    for (const id of ['other', 'bass', 'drums', 'vocals'] as const) {
      const buffer = context.createBuffer(2, rate, rate), data = buffer.getChannelData(id === 'vocals' ? 1 : 0);
      for (let i = 0; i < rate; i++) data[i] = .08 * Math.sin(2 * Math.PI * 4000 * i / rate);
      loaded.buffers[id] = buffer;
    }
    const deck = createDeck(context, loaded, context.destination, 0, 'open', u);
    setFilterBypass(deck, true); setFilterBypass(deck, bypass);
    const audio = await context.startRendering();
    return [0, 1].map(channel => {
      const samples = audio.getChannelData(channel).slice(rate / 4);
      return Math.sqrt(samples.reduce((sum, v) => sum + v * v, 0) / samples.length);
    });
  };
  return { low: await render(0, false), high: await render(1, false), bypass: await render(0, true) };
}
function bufferScene(context: BaseAudioContext, id: string, frames: number, signal: (frame: number, stem: StemId) => number): LoadedScene {
  const scene = testScene(id); scene.sourceFrameCount = frames; scene.sceneTrimDb = 0;
  for (const r of ['sparse', 'pulse', 'open'] as RecipeId[]) scene.recipes[r] = { other: 0, bass: 0, drums: 0 };
  const buffers: LoadedScene['buffers'] = {};
  for (const id of ['other', 'bass', 'drums'] as StemId[]) {
    const b = context.createBuffer(1, frames, rate); b.getChannelData(0).forEach((_, i, a) => a[i] = signal(i, id)); buffers[id] = b;
  }
  return { scene, buffers, duration: frames / rate, bytes: frames * 12, fingerprint: '', mediaHashes: {} };
}
export async function alignment() {
  const length = 9600, loops = 20, start = .1, context = new OfflineAudioContext(3, length * loops + rate * start, rate);
  const loaded = bufferScene(context, 'markers', length, i => i === 127 || i === 4001 ? .5 : 0);
  const silentOutput = context.createGain(), merger = context.createChannelMerger(3); merger.connect(context.destination);
  const deck = createDeck(context, loaded, silentOutput, start, 'open', .3, 0, true);
  Object.values(deck.stems).forEach((stem, i) => stem.recipe.connect(merger, 0, i));
  const rendered = await context.startRendering();
  const positions = Array.from({ length: 3 }, (_, c) => Array.from(rendered.getChannelData(c)).flatMap((v, i) => v > .49 ? [i] : []));
  return { positions, expected: Array.from({ length: loops }, (_, i) => [rate * start + i * length + 127, rate * start + i * length + 4001]).flat(), playbackRates: Object.values(deck.stems).map(s => s.source.playbackRate.value) };
}
export async function mutePhase() {
  const length = 24000, context = new OfflineAudioContext(1, rate * 2, rate);
  const loaded = bufferScene(context, 'phase', length, i => .1 * Math.sin(2 * Math.PI * i / length * 137));
  loaded.scene.recipes.sparse.bass = null;
  const output = context.createGain(), deck = createDeck(context, loaded, output, .1, 'sparse', .3, 0, true);
  deck.stems.bass!.recipe.connect(context.destination);
  rampRecipe(deck, 'open', .88, .9);
  const rendered = await context.startRendering(), actual = rendered.getChannelData(0), original = loaded.buffers.bass!.getChannelData(0);
  let error = 0, before = 0;
  for (let i = rate; i < actual.length; i++) error = Math.max(error, Math.abs(actual[i] - original[(i - rate * .1) % length]));
  for (let i = 0; i < Math.floor(rate * .88); i++) before = Math.max(before, Math.abs(actual[i]));
  return { error, before };
}
export async function nativeReset() {
  const context = new OfflineAudioContext(2, rate * 3, rate), merger = context.createChannelMerger(2); merger.connect(context.destination);
  const old = bufferScene(context, 'old', 24000, () => .1), next = bufferScene(context, 'next', 28800, i => i === 480 ? .3 : .03);
  const oldOut = context.createGain(), newOut = context.createGain(); oldOut.connect(merger, 0, 0); newOut.connect(merger, 0, 1);
  const outgoing = createDeck(context, old, oldOut, .1, 'open', .3, 0, true), incoming = createDeck(context, next, newOut, 1.1, 'open', .3, 10, true);
  scheduleDeckExit(outgoing, 1.1 - old.duration / 16, 1.1);
  for (let t = .2; t <= 1.2; t += .025) updateFilter(outgoing, t % 1, t, 30);
  const rendered = await context.startRendering(), a = rendered.getChannelData(0), b = rendered.getChannelData(1), at = Math.round(1.1 * rate);
  let oldAfter = 0, newBefore = 0, overlap = 0;
  for (let i = 0; i < a.length; i++) { if (i >= at) oldAfter = Math.max(oldAfter, Math.abs(a[i])); if (i < at) newBefore = Math.max(newBefore, Math.abs(b[i])); if (Math.abs(a[i]) > 1e-7 && Math.abs(b[i]) > 1e-7) overlap++; }
  return { oldAfter, newBefore, overlap, nativeDuration: incoming.loaded.duration, newMarkers: Array.from(b).flatMap((v, i) => v > .8 ? [i] : []).slice(0, 3) };
}
export async function ownership() {
  const context = new OfflineAudioContext(1, rate * 2, rate), loaded = bufferScene(context, 'owned', 24000, () => .1), deck = createDeck(context, loaded, context.destination, .1, 'sparse', .3);
  loaded.scene.recipes.open.bass = -6; rampRecipe(deck, 'open', .48, .5); scheduleDeckExit(deck, .9, 1);
  for (let t = .2; t <= 1.2; t += .01) updateFilter(deck, t % 1, t, 30);
  const values = { recipe: deck.stems.bass!.envelope.valueAt(.5), expected: dbToGain(-6), fade: deck.fadeEnvelope.valueAt(1) };
  const rendered = await context.startRendering();
  return { ...values, afterPeak: Math.max(...rendered.getChannelData(0).slice(rate, rate + 2000).map(Math.abs)) };
}
export async function fallbackEnvelope() {
  const context = new OfflineAudioContext(1, rate, rate), source = context.createConstantSource(), gain = context.createGain();
  Object.defineProperty(gain.gain, 'cancelAndHoldAtTime', { value: undefined });
  const e = new OwnedEnvelope(gain.gain, 0); source.connect(gain).connect(context.destination); source.start();
  e.ramp(1, 0, .5); const held = e.valueAt(.25); e.ramp(0, .25, .5, true);
  const rendered = await context.startRendering(), data = rendered.getChannelData(0);
  return { held, actual: data[12000], before: data[11999], after: data[12001], end: data[24000] };
}
export async function stopRestart() {
  const context = new AudioContext(), m = testManifest(), loaded = bufferScene(context, 'a', 24000, () => .02);
  const assets: LoadedAssets = { scenes: { a: loaded }, decodedBytes: 0, fingerprint: '', edgeFingerprints: {} };
  const engine = new AudioEngine(context, m, assets), clock = { start: context.currentTime + .1, duration: .5, loopBars: 4, beatsPerBar: 4 };
  engine.execute({ type: 'StartTransport', id: 1, generation: 1, sceneId: 'a', at: clock.start, recipe: 'sparse', clock }); const old = engine.decks[0];
  engine.execute({ type: 'StopTransport', id: 2, generation: 2, at: context.currentTime });
  engine.execute({ type: 'StartTransport', id: 1, generation: 3, sceneId: 'a', at: clock.start, recipe: 'open', clock });
  engine.execute({ type: 'RampRecipe', id: 9, generation: 1, sceneId: 'a', recipe: 'sparse', start: .4, end: .5 });
  const result = { oldDisposed: old.disposed, decks: engine.decks.length, sources: Object.keys(engine.decks[0].stems).length, generation: engine.generation };
  engine.dispose(); await context.close(); return result;
}
export async function fixtureAssets(sampleRate = rate): Promise<{ manifest: Manifest; assets: LoadedAssets }> {
  const url = new URL('/fixtures/manifest.json', location.href), manifest = validateManifest(await (await fetch(url)).json());
  const context = new OfflineAudioContext(2, 1, sampleRate), assets = await loadAssets(context, manifest, urlReader(url.href));
  return { manifest, assets };
}
export async function fixtureHeadroom() {
  const { manifest, assets } = await fixtureAssets(); const cases = allAuditions(manifest); let worst = -Infinity, nonfinite = 0;
  for (const audition of cases) {
    const plan = auditionPlan(manifest, assets, audition), result = await renderEventPlan(manifest, assets, plan.events, plan.duration, rate);
    worst = Math.max(worst, result.peakDbfs); nonfinite += result.nonfinite;
  }
  return { cases: cases.length, worstDbfs: worst, nonfinite, decodedBytes: assets.decodedBytes };
}
export async function workerSmoke() {
  const worker = new Worker('/models/hand.worker.js');
  return new Promise<{ valid: boolean; sequence: number; observedAtMs: number; landmarks: number }>((resolve, reject) => {
    const timeout = setTimeout(() => { worker.terminate(); reject(new Error('Worker test timed out')); }, 30000);
    worker.onerror = e => { clearTimeout(timeout); worker.terminate(); reject(new Error(e.message)); };
    worker.onmessage = async ({ data }) => {
      if (data.type === 'ready') { const canvas = new OffscreenCanvas(640, 480), ctx = canvas.getContext('2d')!; ctx.fillStyle = '#777'; ctx.fillRect(0, 0, 640, 480); const bitmap = canvas.transferToImageBitmap(); worker.postMessage({ type: 'frame', sequence: 17, observedAtMs: 1234, bitmap }, [bitmap]); }
      if (data.type === 'result') { clearTimeout(timeout); worker.terminate(); resolve({ valid: true, sequence: data.sequence, observedAtMs: data.observedAtMs, landmarks: data.landmarks.length }); }
      if (data.type === 'error' || data.type === 'frame-error') { clearTimeout(timeout); worker.terminate(); reject(new Error(data.message)); }
    };
    worker.postMessage({ type: 'init', wasmRoot: new URL('/models/wasm', location.href).href, modelUrl: new URL('/models/hand_landmarker.task', location.href).href });
  });
}
