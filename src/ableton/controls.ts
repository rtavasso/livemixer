export const names = ['vocals', 'space', 'stutter', 'gain'] as const;
export type Control = typeof names[number];
export type Controls = Record<Control, number>;
/**
 * Home for every mode: vocals off (instrumental), dry, no repeat, unity gain. Nothing automatic ever sends more
 * vocals than this; only the operator's own slider (Manual) or a fresh hand (Living / Simulation) raises them.
 */
export const defaults: Readonly<Controls> = Object.freeze({ vocals: 0, space: 0, stutter: 0, gain: 1 });
export interface Source { value: number; min: number; max: number }
export function normalize(source: Source | undefined, fallback: number): number {
  if (!source || ![source.value, source.min, source.max].every(Number.isFinite) || source.max <= source.min) return fallback;
  return Math.max(0, Math.min(1, (source.value - source.min) / (source.max - source.min)));
}
export function stutterCount(amount: number): number {
  return !Number.isFinite(amount) || amount <= 0 ? 0 : Math.max(1, Math.min(4, Math.floor(amount * 4 + .5)));
}
export function smooth(previous: number, target: number, elapsedMs: number): number {
  const next = previous + (target - previous) * (1 - Math.exp(-Math.max(0, Math.min(500, elapsedMs)) / 120));
  // Exponential smoothing otherwise never reaches zero, leaving short
  // repeats enabled indefinitely after a gesture has settled.
  return Math.abs(next - target) < .001 ? target : next;
}
/** Live's output meters as the bridge relays them (Living FX `/livemixer/levels`): 0..1, −1 when a group is absent. */
export interface MusicLevels { main: number; rhythm: number; melodic: number }

/**
 * The simulation-page message relaying Live's transport (and, when the bridge has them, its output meters so the
 * simulations can pulse with the audio) from a bridge status, or null when unusable.
 */
export function musicRelay(state: unknown, levels?: unknown): { direction: 'inbound'; message: { type: 'music'; beat: number; playing: boolean; levels?: MusicLevels } } | null {
  if (!state || typeof state !== 'object') return null;
  const { beat, playing } = state as { beat?: unknown; playing?: unknown };
  if (typeof beat !== 'number' || !Number.isFinite(beat)) return null;
  const message: { type: 'music'; beat: number; playing: boolean; levels?: MusicLevels } = { type: 'music', beat, playing: Boolean(playing) };
  const l = levels as Partial<MusicLevels> | null | undefined;
  if (l && typeof l === 'object' && [l.main, l.rhythm, l.melodic].every(v => typeof v === 'number' && Number.isFinite(v))) {
    message.levels = { main: l.main as number, rhythm: l.rhythm as number, melodic: l.melodic as number };
  }
  return { direction: 'inbound', message };
}

/** What the controls page shows for a bridge status message. Every field may be absent (an older bridge). */
export interface BridgeStatusView {
  text: string;
  /** Live connected, MIDI out open, and this window in charge. */
  ready: boolean;
  /** This window's ownership, carried over from earlier statuses when the field is absent. */
  owner: boolean | null;
  /** Whether Live's Vocal Presence is audible (Living FX `state.amount` > −0.5), or null when not reported. */
  vocalsInLive: boolean | null;
}

/** Utility Gain (Live 11, −1..1, 0 = 0 dB) above this counts as vocals audible. */
export const VOCALS_AUDIBLE_GAIN = -.5;

export function bridgeStatus(message: unknown, previousOwner: boolean | null = null): BridgeStatusView {
  const m = (message && typeof message === 'object' ? message : {}) as { live?: unknown; midi?: unknown; midiPort?: unknown; owner?: unknown; state?: unknown };
  const owner = typeof m.owner === 'boolean' ? m.owner : previousOwner;
  const midi = m.midi !== false; // absent (older bridge) counts as open
  const live = Boolean(m.live);
  const amount = m.state && typeof m.state === 'object' ? (m.state as { amount?: unknown }).amount : undefined;
  const vocalsInLive = typeof amount === 'number' && Number.isFinite(amount) ? amount > VOCALS_AUDIBLE_GAIN : null;
  const port = typeof m.midiPort === 'string' && m.midiPort ? m.midiPort : 'unknown';
  const text = owner === false ? 'Another control window is in charge'
    : !midi ? `MIDI port not available: ${port}`
    : live ? 'Live connected'
    : 'Bridge connected · waiting for Live device';
  return { text, ready: live && midi && owner !== false, owner, vocalsInLive };
}
