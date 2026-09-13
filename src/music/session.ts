import { Conditioner, type Conditioned } from '../control/conditioning';
import type { Adapter, ControlFrame, MappingMode } from '../control/types';
import { advanceGesture, disarmed, initialMapping, mapRecipe } from './mapping';
import { desireRecipe, dropUncommitted, idleTransport, plan, requestAdvance, startTransport, stopTransport, type AudioAction, type PlannerEnvironment, type RequestSource, type ResponseTiming, type TransportState } from './planner';
import type { RecipeId } from '../config';
import { idleSpace, validateSpace, type SpaceState } from '../control/space';
export type SessionInput =
  | { type: 'space'; state: SpaceState }
  | { type: 'frame'; frame: ControlFrame }
  | { type: 'adapter'; source: Adapter }
  | { type: 'timing'; timing: ResponseTiming }
  | { type: 'rate'; rate: number }
  | { type: 'mode'; mode: MappingMode }
  | { type: 'hold'; enabled: boolean }
  | { type: 'bypass'; enabled: boolean }
  | { type: 'metronome'; enabled: boolean }
  | { type: 'calibration' }
  | { type: 'recipe'; recipe: RecipeId }
  | { type: 'advance' }
  | { type: 'cancel' }
  | { type: 'start'; sceneId?: string; recipe?: RecipeId }
  | { type: 'stop' }
  | { type: 'tick' };
export class PerformanceSession {
  state: TransportState = idleTransport();
  mapping = initialMapping(); gesture = disarmed(); source: Adapter = 'slider'; mode: MappingMode = 'combined'; holdEnabled = false;
  filterBypass = false; metronome = false;
  space = idleSpace();
  conditioner: Conditioner; conditioned: Conditioned;
  private lastSceneStart = -1;
  private manualRecipeValue: number | null = null;
  constructor(readonly environment: PlannerEnvironment, readonly originMs = 0) {
    this.conditioner = new Conditioner('slider', originMs, .3, environment.manifest.control);
    this.conditioned = { raw: .3, smooth: .3, valid: true, structural: true, sustainedLoss: false, ageMs: 0 };
  }
  dispatch(input: SessionInput, atMs: number, audioTime: number): AudioAction[] {
    if (input.type === 'space') { this.space = validateSpace(input.state); return []; }
    const settings = this.environment.manifest.control;
    if (input.type === 'start') {
      this.manualRecipeValue = null;
      this.mapping = initialMapping(input.recipe); this.gesture = disarmed();
      const result = startTransport(this.state, this.environment, audioTime, input.sceneId, input.recipe);
      this.state = result.state; this.lastSceneStart = this.state.clock.start; return result.actions;
    }
    if (input.type === 'stop') {
      const result = stopTransport(this.state, audioTime); this.state = result.state;
      this.mapping = initialMapping(); this.gesture = disarmed(); return result.actions;
    }
    if (input.type === 'adapter') {
      this.manualRecipeValue = null;
      this.state = dropUncommitted(this.state, this.source);
      this.source = input.source; this.conditioner = new Conditioner(input.source, atMs, this.conditioned.smooth, settings);
      this.mapping = initialMapping(this.mapping.desired); this.gesture = disarmed();
    }
    if (input.type === 'mode') { this.mode = input.mode; this.mapping = initialMapping(this.mapping.desired); this.state = dropUncommitted(this.state, this.source); }
    if (input.type === 'timing') {
      if (!['beat', 'immediate', 'authored'].includes(input.timing)) throw new Error('Unknown response timing.');
      this.state = { ...this.state, timing: input.timing, pendingRecipe: null };
    }
    if (input.type === 'rate') {
      if (!Number.isFinite(input.rate) || input.rate < .9 || input.rate > 1.1) throw new Error('Speed must be between 90% and 110%.');
      this.state = { ...this.state, desiredRate: input.rate, pendingRecipe: null };
    }
    if (input.type === 'hold') { this.holdEnabled = input.enabled; this.gesture = disarmed(); }
    if (input.type === 'bypass') this.filterBypass = input.enabled;
    if (input.type === 'metronome') this.metronome = input.enabled;
    if (input.type === 'calibration') { this.gesture = disarmed(); this.mapping = initialMapping(this.mapping.desired); this.conditioner = new Conditioner(this.source, atMs, this.conditioned.smooth, settings); }
    if (input.type === 'recipe') {
      this.manualRecipeValue = this.conditioned.raw;
      this.mapping = initialMapping(input.recipe); this.state = desireRecipe(this.state, input.recipe, 'manual');
    }
    if (input.type === 'advance') this.state = requestAdvance(this.state, 'manual');
    if (input.type === 'cancel') { this.state = { ...this.state, pendingAdvance: null, pendingRecipe: null, recipeIntent: false }; }
    if (input.type === 'frame') {
      this.conditioned = this.conditioner.frame(input.frame);
      const valid = this.conditioned.structural && !this.conditioned.discarded;
      if (valid && this.manualRecipeValue !== null && Math.abs(this.conditioned.raw - this.manualRecipeValue) > .05) this.manualRecipeValue = null;
      if (!this.space.enabled && this.mode !== 'timbre_only' && this.manualRecipeValue === null) {
        const previous = this.mapping.desired;
        this.mapping = mapRecipe(this.mapping, this.conditioned.smooth, atMs, valid, settings.recipeDwellMs);
        if (this.mapping.desired !== previous || (valid && !this.state.recipeIntent && this.state.desiredSource === this.source)) this.state = desireRecipe(this.state, this.mapping.desired, this.source);
      }
      const result = advanceGesture(this.gesture, { u: this.conditioned.smooth, atMs, valid, enabled: this.holdEnabled && !this.space.enabled, eligible: this.state.running && audioTime >= this.state.clock.start + ((this.state.timing ?? 'authored') === 'authored' ? this.state.clock.duration : 0), busy: !!(this.state.pendingAdvance || this.state.committedAdvance) }, settings);
      this.gesture = result.state;
      if (result.advance) this.state = requestAdvance(this.state, this.source);
    }
    if (input.type === 'tick') this.conditioned = this.conditioner.tick(atMs);
    if (!this.conditioned.structural) { this.mapping = initialMapping(this.mapping.desired); this.gesture = disarmed(); }
    if (this.conditioned.sustainedLoss && this.source !== 'slider') this.state = dropUncommitted(this.state, this.source as RequestSource);
    if (input.type === 'tick') {
      // Convolution preparation must finish before the outgoing fade is submitted.
      // This affects discrete passage changes only; palm modulation stays continuous.
      const result = plan(this.state, this.space.enabled ? { ...this.environment, scenePreparationMs: 75 } : this.environment, audioTime); this.state = result.state;
      if (this.lastSceneStart !== this.state.clock.start) { this.gesture = disarmed(); this.lastSceneStart = this.state.clock.start; }
      return result.actions;
    }
    return [];
  }
  get timbre() { return this.mode === 'structure_only' ? .3 : this.conditioned.smooth; }
}
