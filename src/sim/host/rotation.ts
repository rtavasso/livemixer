/**
 * Timer rotation between simulations for a long show.
 *
 * Every `intervalMs` the next simulation in the list becomes due. The change waits until the box
 * has been empty (presence below `emptyBelow`) for `quietMs`, so nobody's encounter is cut off,
 * then fades the picture to black over `fadeMs`, switches, and fades back in. A hand arriving
 * during the fade-out cancels it and the picture returns; the change is attempted again at the
 * next quiet moment. Deterministic: time and presence arrive through `tick`.
 *
 * Launch with `sim.html?rotate=MINUTES&rotation=tide,lantern,murmuration`.
 */
export interface RotationSettings {
  ids: string[];
  intervalMs: number;
  quietMs: number;
  fadeMs: number;
  emptyBelow: number;
}
export interface RotationTick {
  /** Picture opacity to apply (0..1). */
  opacity: number;
  /** Set on the tick at which the host should switch to this simulation (at black). */
  switchTo: string | null;
}

type Phase = 'showing' | 'fading-out' | 'fading-in';

export class SimRotation {
  private phase: Phase = 'showing';
  private index: number;
  private shownSinceMs: number | null = null;
  private emptySinceMs: number | null = null;
  private phaseStartMs = 0;
  private opacity = 1;

  constructor(readonly settings: RotationSettings, currentId: string) {
    const at = settings.ids.indexOf(currentId);
    this.index = at >= 0 ? at : 0;
  }

  /** The simulation that should be showing now (the first of the list when the current one is not in it). */
  get current(): string { return this.settings.ids[this.index]; }

  tick(nowMs: number, presence: number): RotationTick {
    const s = this.settings;
    if (this.shownSinceMs === null) this.shownSinceMs = nowMs;
    const empty = presence < s.emptyBelow;
    this.emptySinceMs = empty ? this.emptySinceMs ?? nowMs : null;
    let switchTo: string | null = null;
    if (this.phase === 'showing') {
      this.opacity = 1;
      const due = s.ids.length > 1 && nowMs - this.shownSinceMs >= s.intervalMs;
      if (due && this.emptySinceMs !== null && nowMs - this.emptySinceMs >= s.quietMs) { this.phase = 'fading-out'; this.phaseStartMs = nowMs; }
    } else if (this.phase === 'fading-out') {
      if (!empty) { this.phase = 'fading-in'; this.phaseStartMs = nowMs - (1 - this.opacity) * s.fadeMs; }
      else {
        this.opacity = Math.max(0, 1 - (nowMs - this.phaseStartMs) / s.fadeMs);
        if (this.opacity === 0) {
          this.index = (this.index + 1) % s.ids.length; switchTo = this.current;
          this.shownSinceMs = nowMs; this.phase = 'fading-in'; this.phaseStartMs = nowMs;
        }
      }
    }
    if (this.phase === 'fading-in') {
      this.opacity = Math.min(1, (nowMs - this.phaseStartMs) / s.fadeMs);
      if (this.opacity === 1) this.phase = 'showing';
    }
    return { opacity: this.opacity, switchTo };
  }
}

/** Rotation settings from the page URL, or null when `rotate` is absent or invalid. */
export function rotationFromUrl(search: string, knownIds: readonly string[]): RotationSettings | null {
  const params = new URLSearchParams(search);
  const minutes = Number(params.get('rotate'));
  if (!params.has('rotate') || !Number.isFinite(minutes) || minutes <= 0) return null;
  const requested = (params.get('rotation') ?? 'tide,lantern,murmuration').split(',').map(s => s.trim()).filter(Boolean);
  const ids = requested.filter(id => knownIds.includes(id));
  if (ids.length < 2) return null;
  return { ids, intervalMs: minutes * 60_000, quietMs: 4000, fadeMs: 2500, emptyBelow: .05 };
}
