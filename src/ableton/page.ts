/**
 * What the controls page sends, without the DOM: the mode, the values, and every tick's messages.
 *
 * The rule it keeps: vocals (MIDI CC20, Vocal Presence on every song) are never above 0 unless a hand is really
 * present (Living / Simulation, fresh input) or the operator moved the Manual slider. Every mode change starts from
 * home (`defaults`: vocals 0, dry, unity), stale input never sends anything louder than home, and the page starts
 * at home before the first tick, so the first message after a load or a reconnect is home.
 */
import { defaults, names, normalize, smooth, type Control, type Controls, type Source } from './controls';
import { isLivingSchema, type LiveFx } from '../living/governor';
import { freshness, LivingDriver, type LivingStep } from './living';
import type { TelemetryFrame, TelemetrySchema } from '../sim/telemetry/types';

export type Mode = 'living' | 'manual' | 'simulation';
export type ControlsMessage = { type: 'controls'; fx?: LiveFx } & Controls;
export type Outgoing = ControlsMessage | { type: 'release' };

export interface Tick {
  /** In order: at most one release, then the controls to send (none while released and waiting for input). */
  messages: Outgoing[];
  /** Living mode's step, for the display. */
  living: LivingStep | null;
  /** Simulation mode's input state, for the display. */
  simulation: 'stale' | 'connected' | null;
}

export const DEFAULT_ROUTE: Readonly<Record<Control, string>> = Object.freeze({ vocals: 'input.presence', space: 'input.activity', stutter: 'input.activity', gain: 'constant' });

export class ControlsCore {
  private currentMode: Mode;
  /** The operator picked the mode; until then the simulation's schema may pick it. */
  modeChosen = false;
  value: Controls = { ...defaults };
  fx: LiveFx | null = null;
  /** Released to the bridge (Living after a long stall, Simulation while stale): nothing is sent until fresh input. */
  silent = false;
  readonly living: LivingDriver;
  readonly route: Record<Control, string>;
  private stale = false;
  private lastUpdate: number;

  constructor(options: { mode: Mode; now?: number; route?: Partial<Record<Control, string>>; living?: LivingDriver }) {
    this.currentMode = options.mode;
    this.lastUpdate = options.now ?? 0;
    this.route = { ...DEFAULT_ROUTE, ...options.route };
    this.living = options.living ?? new LivingDriver();
  }

  get mode(): Mode { return this.currentMode; }

  /** Change mode. Every change starts from home: no value of the previous mode carries over. */
  setMode(mode: Mode, chosen: boolean): void {
    if (chosen) this.modeChosen = true;
    if (mode === this.currentMode) return;
    this.currentMode = mode;
    this.home();
  }

  /**
   * A simulation schema arrived. Until the operator picks a mode, a living-contract schema selects Living. A schema
   * without the contract leaves the mode alone: Living keeps running on the hand alone (input presence and hand
   * gestures; the missing scene signals count as absent), so rotating through other simulations never drops the
   * page into Manual with the last Living values frozen. Returns whether the mode changed.
   */
  onSchema(schema: Pick<TelemetrySchema, 'sim'>): boolean {
    if (this.modeChosen || !isLivingSchema(schema.sim.signals) || this.currentMode === 'living') return false;
    this.setMode('living', false);
    return true;
  }

  /** The controls message to send now, or null while released. */
  current(): ControlsMessage | null {
    if (this.silent) return null;
    return this.fx ? { type: 'controls', ...this.value, fx: this.fx } : { type: 'controls', ...this.value };
  }

  /** The operator moved a slider (Manual, or a constant route in Simulation). */
  setManual(name: Control, amount: number): ControlsMessage | null {
    if (this.currentMode === 'living' || !Number.isFinite(amount)) return this.current();
    this.value[name] = Math.max(0, Math.min(1, amount));
    return this.current();
  }

  /** Release & reset: home at once, keeping the mode; the caller sends the release. */
  reset(): Outgoing[] {
    this.home();
    return [{ type: 'release' }];
  }

  /** Advance to `now` with the latest frame (received at `lastFrame`, same clock) and schema. */
  tick(frame: TelemetryFrame | null, lastFrame: number, now: number, schema: Pick<TelemetrySchema, 'sim'> | null): Tick {
    const messages: Outgoing[] = [];
    let living: LivingStep | null = null, simulation: Tick['simulation'] = null;
    const elapsed = now - this.lastUpdate;
    if (this.currentMode === 'living') {
      // Stale or absent input never cuts or blasts: the driver fades to home and releases Live once after a long stall.
      living = this.living.step(frame, lastFrame, now, elapsed / 1000);
      const message = living.message;
      if (message?.type === 'controls') {
        this.silent = false;
        this.value = { vocals: message.vocals, space: message.space, stutter: message.stutter, gain: message.gain };
        this.fx = message.fx;
      } else {
        if (message?.type === 'release') messages.push(message);
        this.silent = true; this.fx = null; this.value = { ...defaults };
      }
    } else if (this.currentMode === 'simulation') {
      if (freshness(frame, lastFrame, now) !== 'fresh') {
        // Hand Live to the bridge's fail-safe once and stay quiet until fresh input returns (never reclaim it at home).
        if (!this.stale) messages.push({ type: 'release' });
        this.stale = true; this.silent = true;
        for (const name of names) if (this.route[name] !== 'constant') this.value[name] = defaults[name];
        this.fx = null; simulation = 'stale';
      } else {
        this.stale = false; this.silent = false; simulation = 'connected';
        for (const name of names) {
          const route = this.route[name];
          if (route === 'constant') continue;
          let source: Source | undefined;
          if (route === 'input.presence') source = { value: frame!.input.presence, min: 0, max: 1 };
          else if (route === 'input.activity') source = { value: frame!.input.activity, min: 0, max: 1 };
          else {
            const key = route.slice(7), spec = schema?.sim.id === frame!.sim.id ? schema.sim.signals[key] : undefined;
            if (spec) source = { value: frame!.sim.signals[key], min: spec.min, max: spec.max };
          }
          this.value[name] = smooth(this.value[name], normalize(source, defaults[name]), elapsed);
        }
      }
    }
    this.lastUpdate = now;
    const controls = this.current();
    if (controls) messages.push(controls);
    return { messages, living, simulation };
  }

  private home(): void {
    this.value = { ...defaults }; this.fx = null; this.silent = false; this.stale = false;
    this.living.reset();
  }
}
