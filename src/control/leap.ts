import type { Palm } from './space';
export type LeapProfile = 'responsive' | 'bright-room' | 'balanced';
export interface LeapHealth {
  cameraFps?: number; trackingFps?: number; deviceStatus?: number;
  profile?: string; hintsAccepted?: boolean; receivedFps: number;
  frameAgeMs: number; lastReceived: number; rejected: number; palms: number;
}
export class LeapAdapter {
  private events?: EventSource;
  private sequence = -1;
  private arrivals: number[] = [];
  health: LeapHealth = { receivedFps: 0, frameAgeMs: 0, lastReceived: -Infinity, rejected: 0, palms: 0 };
  constructor(readonly onFrame: (palms: Palm[], now: number) => void, readonly onStatus: (message: string, failed: boolean) => void) {}
  start(profile: LeapProfile = 'responsive') {
    this.stop(); this.sequence = -1; this.arrivals = [];
    this.health = { receivedFps: 0, frameAgeMs: 0, lastReceived: -Infinity, rejected: 0, palms: 0 };
    const events = this.events = new EventSource(`/api/leap/events?profile=${profile}`);
    this.onStatus('Connecting to Leap...', false);
    events.onmessage = event => {
      if (events !== this.events) return;
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'error') { this.stop(); this.onStatus(data.message, true); return; }
        if (data.type === 'status') { this.onStatus(data.message, false); return; }
        if (data.type === 'health') {
          for (const key of ['cameraFps', 'trackingFps', 'deviceStatus'] as const) {
            if (data[key] === null) delete this.health[key];
            else if (Number.isFinite(data[key]) && data[key] >= 0) this.health[key] = data[key];
          }
          if (typeof data.profile === 'string') this.health.profile = data.profile;
          if (typeof data.hintsAccepted === 'boolean') this.health.hintsAccepted = data.hintsAccepted;
          return;
        }
        if (data.type !== 'frame' || !Number.isSafeInteger(data.sequence) || data.sequence <= this.sequence) return;
        this.sequence = data.sequence;
        if (Number.isFinite(data.trackingFps) && data.trackingFps > 0) this.health.trackingFps = data.trackingFps;
        const age = Date.now() - data.sentAtMs + data.ageMs;
        // Slow native tracking can legitimately deliver useful frames just over
        // 200 ms old. Allow one measured frame interval, with a hard 400 ms cap.
        const ageLimit = Math.max(200, Math.min(400, 150 + 1000 / (this.health.trackingFps ?? 30)));
        if (!Number.isFinite(age) || age < -100 || age > ageLimit || !Array.isArray(data.palms)) { this.health.rejected++; return; }
        const palms: Palm[] = data.palms.filter((p: Palm) => p && Number.isSafeInteger(p.id) && [p.x, p.y, p.z].every(Number.isFinite));
        if (data.palms.length && !palms.length) { this.health.rejected++; return; }
        const now = performance.now();
        this.arrivals = this.arrivals.filter(t => now - t < 2000); this.arrivals.push(now);
        this.health.receivedFps = this.arrivals.length > 1 ? (this.arrivals.length - 1) * 1000 / (now - this.arrivals[0]) : 0;
        this.health.lastReceived = now; this.health.frameAgeMs = age; this.health.palms = palms.length;
        this.onFrame(palms, now);
        this.onStatus(palms.length ? 'Leap is tracking your hand.' : 'Leap is ready. Reach into the space.', false);
      } catch { this.health.rejected++; this.onStatus('An invalid Leap frame was ignored. Waiting for fresh tracking.', false); }
    };
    events.onerror = () => { if (events !== this.events) return; this.stop(); this.onStatus('Leap connection lost. Reconnect when the sensor is ready.', true); };
  }
  stop() { this.events?.close(); this.events = undefined; }
}
