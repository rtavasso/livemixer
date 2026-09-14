/**
 * Mouse / touch / pen as a stand-in hand. Development convenience, and a
 * useful fallback for demoing on a laptop.
 *
 * Source frame: screen-normalized, x right, y DOWN. Use SCREEN_MAPPING.
 *  - The hand is present while the pointer moved recently or a button is down.
 *  - z (depth): rest value adjustable with the wheel; primary button pushes to 1.
 *  - Shift or the secondary button closes the hand (openness 0).
 */
import type { InputFrame, InputSource, InputSourceStatus } from './types';

export class PointerSource implements InputSource {
  readonly id = 'pointer' as const;
  readonly frameDescription = 'Screen: x → right, y → down, z = wheel / press';
  private sequence = 0;
  private x = .5; private y = .5; private restZ = .25;
  private lastMoveMs = -Infinity; private down = false; private closed = false; private inside = false;
  private running = false;
  private readonly listeners: [EventTarget, string, (e: Event) => void][] = [];
  /** Milliseconds of stillness after which the pointer hand leaves. Set to Infinity to keep it. */
  idleLeaveMs = 2500;

  constructor(private readonly target: HTMLElement, private readonly emit: (frame: InputFrame) => void, private readonly now: () => number = () => performance.now()) {}

  private listen<K extends keyof HTMLElementEventMap>(el: EventTarget, type: K | string, fn: (e: Event) => void, options?: AddEventListenerOptions) {
    el.addEventListener(type, fn, options); this.listeners.push([el, type, fn]);
  }

  async start() {
    this.stop(); this.running = true;
    const move = (e: Event) => {
      const p = e as PointerEvent, r = this.target.getBoundingClientRect();
      this.x = (p.clientX - r.left) / Math.max(1, r.width); this.y = (p.clientY - r.top) / Math.max(1, r.height);
      this.inside = true; this.lastMoveMs = this.now();
    };
    this.listen(this.target, 'pointermove', move);
    this.listen(this.target, 'pointerdown', e => { const p = e as PointerEvent; move(e); if (p.button === 2) this.closed = true; else this.down = true; });
    this.listen(window, 'pointerup', e => { const p = e as PointerEvent; if (p.button === 2) this.closed = false; else this.down = false; });
    this.listen(this.target, 'pointerleave', () => { this.inside = false; });
    this.listen(this.target, 'contextmenu', e => e.preventDefault());
    this.listen(this.target, 'wheel', e => { const w = e as WheelEvent; this.restZ = Math.min(1, Math.max(0, this.restZ - w.deltaY * .001)); this.lastMoveMs = this.now(); e.preventDefault(); }, { passive: false });
    this.listen(window, 'keydown', e => { if ((e as KeyboardEvent).key === 'Shift') this.closed = true; });
    this.listen(window, 'keyup', e => { if ((e as KeyboardEvent).key === 'Shift') this.closed = false; });
  }

  sample(nowMs: number) {
    if (!this.running) return;
    const present = this.inside && (this.down || nowMs - this.lastMoveMs < this.idleLeaveMs);
    const z = this.down ? 1 : this.restZ;
    this.emit({
      source: 'pointer', sequence: this.sequence++, observedAtMs: nowMs, receivedAtMs: nowMs,
      hands: present ? [{ id: 1, position: { x: this.x, y: this.y, z }, confidence: 1, openness: this.closed ? 0 : 1, pinch: this.closed ? 1 : 0 }] : [],
    });
  }

  stop() {
    this.running = false;
    for (const [el, type, fn] of this.listeners) el.removeEventListener(type, fn);
    this.listeners.length = 0; this.down = false; this.closed = false; this.inside = false;
  }

  status(): InputSourceStatus { return { state: this.running ? 'running' : 'idle', message: this.running ? 'Move the pointer over the canvas. Press to push, wheel for depth, Shift to close the hand.' : 'Pointer source stopped.' }; }
}
