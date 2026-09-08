import { dbToGain, type Manifest } from '../config';
import type { AudioAction, TransportState } from '../music/planner';
import { beatSeconds } from '../music/transport';
import type { LoadedAssets } from './assets';
import { createDeck, disposeDeck, rampRecipe, scheduleDeckExit, setFilterBypass, updateFilter, type Deck } from './deck';
export class LateSubmissionError extends Error {}
export class AudioEngine {
  readonly master: GainNode; readonly meter: AnalyserNode;
  readonly decks: Deck[] = [];
  generation = 0; openness = .3; bypass = false; metronome = false;
  private lastCommandId = 0; private lastBeatKey = ''; private clicks: OscillatorNode[] = [];
  constructor(readonly context: BaseAudioContext, readonly manifest: Manifest, readonly assets: LoadedAssets, destination: AudioNode = context.destination) {
    this.master = context.createGain(); this.master.gain.value = dbToGain(manifest.masterTrimDb);
    this.meter = context.createAnalyser(); this.meter.fftSize = 512;
    this.master.connect(this.meter).connect(destination);
  }
  execute(action: AudioAction) {
    if (action.generation < this.generation) return;
    if (action.type === 'StopTransport') { this.stop(action.at); this.generation = action.generation; return; }
    if (action.type === 'StartTransport') {
      if (action.generation === this.generation && action.id <= this.lastCommandId) return;
      this.stop(this.context.currentTime); this.generation = action.generation;
      this.decks.push(createDeck(this.context, this.assets.scenes[action.sceneId], this.master, action.at, action.recipe, this.openness, 10, this.bypass));
      this.lastCommandId = action.id; return;
    }
    if (action.generation !== this.generation || action.id <= this.lastCommandId) return;
    if (action.type === 'RampRecipe') {
      this.requireLead(action.start);
      const deck = this.decks.find(d => d.loaded.scene.id === action.sceneId && d.stopAt === undefined);
      if (!deck) throw new Error('Recipe deck is no longer available.');
      rampRecipe(deck, action.recipe, action.start, action.end);
    } else {
      this.requireLead(action.fadeStart);
      const outgoing = this.decks.find(d => d.loaded.scene.id === action.from && d.stopAt === undefined);
      if (!outgoing) throw new Error('Outgoing deck is no longer available.');
      // Prepare/schedule incoming first: allocation failures cannot fade the outgoing deck.
      const incoming = createDeck(this.context, this.assets.scenes[action.to], this.master, action.at, action.recipe, this.openness, (action.fadeInEnd - action.at) * 1000, this.bypass);
      try { this.requireLead(action.fadeStart); scheduleDeckExit(outgoing, action.fadeStart, action.at); this.decks.push(incoming); }
      catch (error) { disposeDeck(incoming, this.context.currentTime); throw error; }
    }
    this.lastCommandId = action.id;
  }
  private requireLead(at: number) {
    if (this.context instanceof AudioContext && at - this.context.currentTime < this.manifest.control.minimumLeadMs / 1000 - 1e-9) throw new LateSubmissionError('Audio submission missed its lead time; the pending request will use the next eligible boundary.');
  }
  continuous(u: number, now = this.context.currentTime) {
    this.openness = u;
    for (const deck of this.decks) updateFilter(deck, u, Math.max(now, deck.start), this.manifest.control.parameterRampMs);
  }
  setBypass(bypass: boolean) { this.bypass = bypass; this.decks.forEach(d => setFilterBypass(d, bypass)); }
  collect(now = this.context.currentTime) {
    for (let i = this.decks.length - 1; i >= 0; i--) if (this.decks[i].stopAt !== undefined && now >= this.decks[i].stopAt! + .05) { disposeDeck(this.decks[i], now); this.decks.splice(i, 1); }
  }
  tickMetronome(state: TransportState, now: number) {
    if (!this.metronome || !state.running) return;
    const step = beatSeconds(state.clock), index = Math.max(0, Math.ceil((now + .05 - state.clock.start) / step));
    const at = state.clock.start + index * step, key = `${state.generation}:${state.clock.start}:${index}`;
    if (key === this.lastBeatKey || at > now + .15 || (state.committedAdvance && at >= state.committedAdvance.at)) return;
    this.lastBeatKey = key;
    const osc = this.context.createOscillator(), gain = this.context.createGain();
    osc.frequency.value = index % 4 === 0 ? 1400 : 900;
    gain.gain.setValueAtTime(.04, at); gain.gain.exponentialRampToValueAtTime(.0001, at + .025);
    osc.connect(gain).connect(this.master); osc.start(at); osc.stop(at + .03); this.clicks.push(osc);
    osc.onended = () => { osc.disconnect(); gain.disconnect(); this.clicks = this.clicks.filter(c => c !== osc); };
  }
  stop(now = this.context.currentTime) {
    for (const deck of this.decks) disposeDeck(deck, now);
    this.decks.length = 0; this.lastCommandId = 0; this.lastBeatKey = '';
    for (const click of this.clicks) { try { click.stop(now); } catch { /* ended */ } click.disconnect(); }
    this.clicks = [];
  }
  dispose() { this.stop(); this.master.disconnect(); this.meter.disconnect(); }
}
