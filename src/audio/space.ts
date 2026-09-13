import { dbToGain, RECIPES, type StemId } from '../config';
import { idleSpace, type SpaceState } from '../control/space';
import type { LoadedScene } from './assets';
import { OwnedEnvelope } from './automation';

const impulses = new WeakMap<BaseAudioContext, AudioBuffer>();
function roomImpulse(context: BaseAudioContext) {
  let buffer = impulses.get(context); if (buffer) return buffer;
  buffer = context.createBuffer(2, Math.ceil(context.sampleRate * 3.2), context.sampleRate);
  // Seeded, decorrelated diffuse reflections. No synthetic sound is played on its own.
  let seed = 19381;
  for (let channel = 0; channel < 2; channel++) {
    const samples = buffer.getChannelData(channel);
    for (let i = 0; i < samples.length; i++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const t = i / context.sampleRate;
      samples[i] = (seed / 4294967296 * 2 - 1) * Math.exp(-t * 2.1) * Math.min(1, t / .025);
    }
  }
  impulses.set(context, buffer); return buffer;
}
export class SpaceMix {
  readonly input: GainNode; readonly output: GainNode; readonly blend: OwnedEnvelope;
  readonly meters: Partial<Record<StemId, AnalyserNode>> = {};
  readonly levels: Partial<Record<StemId, OwnedEnvelope>> = {};
  private nodes: AudioNode[] = [];
  private dry: OwnedEnvelope; private send: OwnedEnvelope;
  private delay?: DelayNode; private sendNode: GainNode;
  private state = idleSpace();
  constructor(readonly context: BaseAudioContext, readonly loaded: LoadedScene, destination: AudioNode, at: number, private rate: number) {
    const node = <T extends AudioNode>(value: T) => { this.nodes.push(value); return value; };
    this.input = node(context.createGain()); this.output = node(context.createGain());
    const headroom = node(context.createGain()); headroom.gain.value = .5;
    this.output.connect(headroom).connect(destination);
    this.blend = new OwnedEnvelope(this.output.gain, 0, at);
    const dry = node(context.createGain()), send = node(context.createGain());
    this.dry = new OwnedEnvelope(dry.gain, 1, at); this.send = new OwnedEnvelope(send.gain, 0, at);
    this.input.connect(dry).connect(this.output); this.input.connect(send);
    this.sendNode = send;
  }
  private prepareEffects() {
    if (this.delay) return;
    const context = this.context, node = <T extends AudioNode>(value: T) => { this.nodes.push(value); return value; };
    // Feedback graphs process even silent blocks. Only allocate them when Hand space
    // is used, so manual playback and legacy authoring renders retain their cost.
    const highpass = node(context.createBiquadFilter()); highpass.type = 'highpass'; highpass.frequency.value = 220; highpass.Q.value = 0;
    this.sendNode.connect(highpass);
    this.delay = node(context.createDelay(2)); this.delay.delayTime.value = this.beatDelay(this.rate);
    const lowpass = node(context.createBiquadFilter()); lowpass.type = 'lowpass'; lowpass.frequency.value = 3600; lowpass.Q.value = 0;
    const feedback = node(context.createGain()); feedback.gain.value = .36;
    const echo = node(context.createGain()); echo.gain.value = .5;
    highpass.connect(this.delay).connect(lowpass); lowpass.connect(feedback).connect(this.delay); lowpass.connect(echo).connect(this.output);
    const reverb = node(context.createConvolver()); reverb.buffer = roomImpulse(context);
    const cloud = node(context.createGain()); cloud.gain.value = .72;
    highpass.connect(reverb); lowpass.connect(reverb); reverb.connect(cloud).connect(this.output);
  }
  attach(id: StemId, source: AudioBufferSourceNode, at: number) {
    const trim = this.context.createGain(), level = this.context.createGain(), meter = this.context.createAnalyser();
    // Honor authored trims and the loudest permitted level for each stem. Recipe mutes
    // cannot accidentally remove the instrumental effects source during a vocal rest.
    const ceiling = Math.max(...RECIPES.map(r => dbToGain(this.loaded.scene.recipes[r][id] ?? null)));
    trim.gain.value = dbToGain(this.loaded.scene.stems[id]!.trimDb) * ceiling;
    meter.fftSize = 256;
    source.connect(trim).connect(meter).connect(level).connect(this.input);
    this.meters[id] = meter;
    this.levels[id] = new OwnedEnvelope(level.gain, this.level(id, this.state), at);
    this.nodes.push(trim, level, meter);
  }
  private level(id: StemId, s: SpaceState) {
    if (id === 'vocals') return s.presence * (.3 + .7 * s.height);
    if (id === 'bass') return .85;
    if (id === 'drums') return .85 * (1 - s.presence) + s.presence * (1 - .5 * s.height);
    return .68 * (1 - s.presence) + s.presence * (.45 + .55 * s.height);
  }
  update(state: SpaceState, at: number, instant = false) {
    if (state.enabled) this.prepareEffects();
    const release = state.presence < this.state.presence;
    const end = at + (instant ? 0 : release ? .65 : .09);
    this.blend.ramp(state.enabled ? 1 : 0, at, at + (instant ? 0 : .12), true);
    for (const [id, envelope] of Object.entries(this.levels)) {
      const value = this.level(id as StemId, state);
      if (Math.abs(envelope.valueAt(end) - value) > .0001) envelope.ramp(value, at, end, true);
    }
    const dry = 1 - state.presence * state.depth * .3, send = state.presence * (.22 + .7 * state.depth);
    if (Math.abs(this.dry.valueAt(end) - dry) > .0001) this.dry.ramp(dry, at, end, true);
    // Removing the hand closes the send; existing delay/reverb tails finish naturally.
    if (Math.abs(this.send.valueAt(end) - send) > .0001) this.send.ramp(send, at, end, true);
    this.state = { ...state };
  }
  private beatDelay(rate: number) { return Math.max(.08, Math.min(1.5, this.loaded.duration / (this.loaded.scene.loopBars * this.loaded.scene.beatsPerBar) / rate * .75)); }
  setRate(rate: number, at: number) { this.rate = rate; if (this.delay) { this.delay.delayTime.cancelScheduledValues(at); this.delay.delayTime.setTargetAtTime(this.beatDelay(rate), at, .08); } }
  dispose() { for (const node of this.nodes) node.disconnect(); this.nodes = []; }
}
