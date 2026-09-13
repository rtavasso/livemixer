export interface SpaceState { enabled: boolean; presence: number; height: number; depth: number }
export const idleSpace = (): SpaceState => ({ enabled: false, presence: 0, height: .5, depth: .35 });
export const unit = (value: number) => Math.max(0, Math.min(1, value));
export function validateSpace(value: SpaceState): SpaceState {
  if (typeof value.enabled !== 'boolean' || ![value.presence, value.height, value.depth].every(v => Number.isFinite(v) && v >= 0 && v <= 1)) throw new Error('Invalid hand-space controls.');
  return { ...value };
}
export interface Palm { id: number; x: number; y: number; z: number; type?: number; visibleMs?: number }
export interface SpaceBounds { width: number; bottom: number; top: number; front: number; back: number }
// Millimeters relative to an upward-facing Leap. Negative Z points deeper into the box.
export const defaultBounds: SpaceBounds = { width: 400, bottom: 120, top: 420, front: 150, back: -150 };
export function validBounds(b: SpaceBounds) {
  return Object.values(b).every(Number.isFinite) && b.width >= 100 && b.width <= 610 && b.bottom >= 100 && b.top <= 600 && b.top - b.bottom >= 100 && Math.abs(b.front) <= 600 && Math.abs(b.back) <= 600 && Math.abs(b.front - b.back) >= 100 && Math.abs(b.front - b.back) <= 610;
}
export function positionInSpace(p: Palm, b: SpaceBounds): Omit<SpaceState, 'enabled'> | null {
  if (![p.x, p.y, p.z].every(Number.isFinite)) return null;
  const height = (p.y - b.bottom) / (b.top - b.bottom), depth = (p.z - b.front) / (b.back - b.front);
  // Soft 25 mm edge: the entire useful range is reachable before disengaging.
  const outside = Math.max(Math.abs(p.x) - b.width / 2, b.bottom - p.y, p.y - b.top, Math.min(b.front, b.back) - p.z, p.z - Math.max(b.front, b.back), 0);
  return outside >= 25 ? null : { presence: 1 - outside / 25, height: unit(height), depth: unit(depth) };
}
export class HandSpace {
  state: SpaceState = { ...idleSpace(), enabled: true };
  bounds = { ...defaultBounds };
  private palm?: Palm;
  private candidate?: { palm: Palm; at: number };
  private lastSeen = -Infinity;
  private lastFrame = -Infinity;
  private lastSample = -Infinity;
  private interval = 1000 / 30;
  private target = { height: .5, depth: .35 };
  private presence = 0;
  private outside = false;
  private rejected = 0;
  private distance(a: Palm, b: Palm) { return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z); }
  get graceMs() { return Math.max(300, Math.min(650, this.interval * 3.5)); }
  get status() {
    return this.outside ? 'outside' : this.state.presence > 0 ? this.lastFrame > this.lastSeen ? 'holding' : 'tracking' : this.candidate ? 'acquiring' : 'searching';
  }
  get rejectedJumps() { return this.rejected; }
  observe(palms: Palm[], now: number, trackingFps?: number) {
    if (!Number.isFinite(now) || now <= this.lastFrame) return this.sample(now);
    this.sample(now);
    if (Number.isFinite(this.lastFrame)) {
      const dt = now - this.lastFrame;
      // Do not let a stalled connection inflate the normal frame cadence.
      if (dt < 250) this.interval += .25 * (dt - this.interval);
    }
    if (trackingFps !== undefined && Number.isFinite(trackingFps) && trackingFps > 0) this.interval = Math.max(this.interval, Math.min(250, 1000 / trackingFps));
    this.lastFrame = now;
    const valid = palms.filter(p => Number.isSafeInteger(p.id) && [p.x, p.y, p.z].every(Number.isFinite));
    const inside = valid.map(palm => ({ palm, position: positionInSpace(palm, this.bounds) })).filter(p => p.position !== null);
    const same = inside.find(p => p.palm.id === this.palm?.id);
    const recent = this.palm && now - this.lastSeen < this.graceMs + 300;
    // Leap assigns a new ID after occlusion. Rejoin a nearby hand of the same
    // chirality instead of waiting for the old ID to expire and switching voices.
    const nearby = recent ? inside.filter(p => (p.palm.type === undefined || this.palm!.type === undefined || p.palm.type === this.palm!.type) && this.distance(p.palm, this.palm!) < 120)
      .sort((a, b) => this.distance(a.palm, this.palm!) - this.distance(b.palm, this.palm!))[0] : undefined;
    const chosen = same ?? nearby ?? (!recent ? inside.find(p => p.palm.id === this.candidate?.palm.id) ?? inside[0] : undefined);
    this.outside = !!this.palm && valid.some(p => p.id === this.palm!.id && !positionInSpace(p, this.bounds));
    if (this.outside && !chosen) { this.presence = 0; this.candidate = undefined; return this.sample(now); }
    if (!chosen) { this.candidate = undefined; return this.sample(now); }
    const jump = recent && this.distance(chosen.palm, this.palm!) > 100 + Math.min(250, now - this.lastSeen) * 1.2;
    const acquisition = !recent && !(chosen.palm.visibleMs !== undefined && chosen.palm.visibleMs >= 100);
    if (jump || acquisition) {
      const confirmed = this.candidate && now - this.candidate.at <= Math.max(250, this.interval * 2.5)
        && this.distance(chosen.palm, this.candidate.palm) < 100;
      if (!confirmed) { this.candidate = { palm: { ...chosen.palm }, at: now }; if (jump) this.rejected++; return this.sample(now); }
    }
    this.candidate = undefined; this.outside = false;
    const entering = this.state.presence === 0;
    this.palm = { ...chosen.palm }; this.lastSeen = now; this.presence = chosen.position!.presence;
    for (const axis of ['height', 'depth'] as const) {
      // Ignore tiny resting tremors; larger intentional moves use the fast filter.
      if (Math.abs(chosen.position![axis] - this.target[axis]) > .006) this.target[axis] = chosen.position![axis];
      if (entering) this.state[axis] = this.target[axis];
    }
    return this.sample(now);
  }
  sample(now: number) {
    if (!Number.isFinite(now) || now < this.lastSample) return { ...this.state };
    const dt = Number.isFinite(this.lastSample) ? Math.min(100, now - this.lastSample) : 0;
    this.lastSample = now;
    const fresh = now - this.lastSeen <= this.graceMs;
    if (fresh) for (const axis of ['height', 'depth'] as const) {
      const delta = this.target[axis] - this.state[axis], tau = Math.abs(delta) > .06 ? 25 : 85;
      this.state[axis] = unit(this.state[axis] + delta * (1 - Math.exp(-dt / tau)));
    }
    // Preserve position during loss; never invent motion or drift to the center.
    this.state.presence = fresh ? this.presence : 0;
    return { ...this.state };
  }
  reset() {
    this.lastSeen = this.lastFrame = this.lastSample = -Infinity; this.palm = this.candidate = undefined;
    this.interval = 1000 / 30; this.presence = 0; this.outside = false; this.rejected = 0;
    this.state = { ...this.state, presence: 0 }; this.target = { height: this.state.height, depth: this.state.depth };
  }
}
