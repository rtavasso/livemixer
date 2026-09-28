/**
 * Hologram calibration screen. Blacks out the picture and shows one X at a
 * time; the performer holds a fingertip on it until the ring fills, nine
 * times, then once with the finger pulled back from the picture. The host
 * fits the plane (`fitHologram`) and switches the source to the hologram
 * water mapping. Afterwards the screen shows where it thinks the fingertip is,
 * so the alignment can be checked against the real finger before leaving.
 *
 * It opens on the ACTIVE AREA step: a rectangle outline the performer sizes
 * to the part of the display the hologram actually shows (Tab selects an
 * edge, arrows move it, Enter confirms; saved in settings). The X's are then
 * placed inside that area, though their screen coordinates stay those of the
 * whole picture, which is what the water sees.
 *
 * Keys while open: Esc leaves (keeping any calibration already applied),
 * Backspace re-does the previous X, R starts over.
 */
import type { SimHost } from '../host/app';
import { applyAffine, type HologramFit, type HologramPair } from '../input/hologram';
import type { Vec3 } from '../core/types';

type Area = { x0: number; y0: number; x1: number; y1: number };
/** Nine targets inside the active area, at 15 / 50 / 85 % of it. */
function targetsIn(area: Area): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  for (const fy of [.15, .5, .85]) for (const fx of [.15, .5, .85]) out.push({ x: area.x0 + fx * (area.x1 - area.x0), y: area.y0 + fy * (area.y1 - area.y0) });
  return out;
}
const PULL_BACK_TARGET = 4; // the centre X
const EDGES = ['top', 'bottom', 'left', 'right'] as const;
type Edge = typeof EDGES[number];
/** The finger must be held steady for this long before a capture. */
const HOLD_MS = 900;
/** After a capture, the finger must leave the spot (source units) or this much time must pass before the next one. */
const LEAVE_DISTANCE = .04, LEAVE_MS = 1500;

type Phase = 'area' | 'touch' | 'pullback' | 'verify';

export class HologramCalibration {
  readonly root: HTMLElement;
  private svg: SVGSVGElement;
  private cross: SVGGElement; private ring: SVGCircleElement; private ringBack: SVGCircleElement; private cursor: SVGCircleElement;
  private areaRect: SVGRectElement; private edgeLine: SVGLineElement;
  private edge: Edge = 'top';
  private targets: { x: number; y: number }[] = [];
  private title: HTMLElement; private detail: HTMLElement; private status: HTMLElement;
  private pairs: HologramPair[] = [];
  private phase: Phase = 'area';
  private steadySince: number | null = null; private steadyAt: Vec3 | null = null;
  private lastCapture: { point: Vec3; atMs: number } | null = null;
  private fit: HologramFit | null = null;
  private raf = 0; private open = false;

  constructor(private readonly host: SimHost, parent: HTMLElement = document.body) {
    const ns = 'http://www.w3.org/2000/svg';
    const svgEl = <K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>) => { const n = document.createElementNS(ns, tag); for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v)); return n; };
    this.root = document.createElement('div'); this.root.className = 'sim-hologram'; this.root.hidden = true;
    this.svg = svgEl('svg', { width: '100%', height: '100%' });
    this.cross = svgEl('g', { class: 'cross' });
    this.cross.append(svgEl('line', { x1: -22, y1: -22, x2: 22, y2: 22 }), svgEl('line', { x1: -22, y1: 22, x2: 22, y2: -22 }));
    this.ringBack = svgEl('circle', { r: 34, class: 'ring back' });
    this.ring = svgEl('circle', { r: 34, class: 'ring fill', 'stroke-dasharray': `${2 * Math.PI * 34}`, 'stroke-dashoffset': `${2 * Math.PI * 34}` });
    this.cursor = svgEl('circle', { r: 9, class: 'cursor' }); this.cursor.setAttribute('visibility', 'hidden');
    this.areaRect = svgEl('rect', { class: 'area' }); this.edgeLine = svgEl('line', { class: 'edge' });
    this.svg.append(this.areaRect, this.edgeLine, this.ringBack, this.ring, this.cross, this.cursor);
    this.title = document.createElement('div'); this.title.className = 'title';
    this.detail = document.createElement('div'); this.detail.className = 'detail';
    this.status = document.createElement('div'); this.status.className = 'status';
    const text = document.createElement('div'); text.className = 'text'; text.append(this.title, this.detail, this.status);
    this.root.append(this.svg, text);
    parent.append(this.root);
  }

  get isOpen() { return this.open; }
  toggle() { if (this.open) this.close(); else this.show(); }

  show() {
    if (this.open) return;
    this.open = true; this.root.hidden = false;
    document.addEventListener('keydown', this.keydown, true);
    this.restart();
    const tick = () => { if (!this.open) return; this.raf = requestAnimationFrame(tick); this.frame(); };
    this.raf = requestAnimationFrame(tick);
  }
  close() {
    if (!this.open) return;
    this.open = false; this.root.hidden = true;
    document.removeEventListener('keydown', this.keydown, true);
    cancelAnimationFrame(this.raf);
  }
  dispose() { this.close(); this.root.remove(); }

  private restart() {
    this.pairs = []; this.fit = null; this.lastCapture = null; this.steadySince = null; this.steadyAt = null;
    this.phase = 'area'; this.edge = 'top';
    this.status.textContent = ''; this.status.className = 'status';
    this.render();
  }

  private keydown = (event: KeyboardEvent) => {
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement || event.target instanceof HTMLTextAreaElement) return;
    const key = event.key.toLowerCase();
    if (this.phase === 'area' && this.areaKey(event, key)) { event.preventDefault(); event.stopPropagation(); return; }
    if (key === 'escape') this.close();
    else if (key === 'r') this.restart();
    else if (key === 'backspace') { if (this.phase === 'pullback') this.phase = 'touch'; else if (this.phase === 'touch' && this.pairs.length) this.pairs.pop(); else if (this.phase === 'touch') this.phase = 'area'; else return; this.lastCapture = null; this.render(); }
    else if (key === 'x') this.close();
    else return;
    event.preventDefault(); event.stopPropagation();
  };

  /** Active-area keys: Tab selects an edge, arrows move it (Shift: finely), Enter confirms. Returns whether the key was used. */
  private areaKey(event: KeyboardEvent, key: string): boolean {
    const area = { ...this.host.hologramArea };
    const step = event.shiftKey ? .002 : .01;
    if (key === 'tab') { this.edge = EDGES[(EDGES.indexOf(this.edge) + (event.shiftKey ? EDGES.length - 1 : 1)) % EDGES.length]; this.render(); return true; }
    if (key === 'enter') { this.targets = targetsIn(this.host.hologramArea); this.phase = 'touch'; this.render(); return true; }
    if (key === '0') { this.host.setHologramArea({ x0: 0, y0: 0, x1: 1, y1: 1 }); this.render(); return true; }
    const delta = key === 'arrowup' || key === 'arrowleft' ? -step : key === 'arrowdown' || key === 'arrowright' ? step : 0;
    if (!delta) return false;
    const vertical = key === 'arrowup' || key === 'arrowdown';
    if (vertical && (this.edge === 'top' || this.edge === 'bottom')) { if (this.edge === 'top') area.y0 += delta; else area.y1 += delta; }
    else if (!vertical && (this.edge === 'left' || this.edge === 'right')) { if (this.edge === 'left') area.x0 += delta; else area.x1 += delta; }
    else return true; // an arrow across the selected edge does nothing
    this.host.setHologramArea(area); this.render(); return true;
  }

  /** Per animation frame: watch the fingertip, fill the ring while it holds still, capture, advance. */
  private frame() {
    const now = performance.now();
    const tip = this.host.latestFingertip();
    if (this.phase === 'area') return;
    if (this.phase === 'verify') { this.showCursor(tip); return; }
    this.cursor.setAttribute('visibility', 'hidden');
    if (!tip) { this.steadySince = null; this.steadyAt = null; this.setRing(0); this.status.textContent = 'No fingertip in view.'; this.status.className = 'status'; return; }
    const left = !this.lastCapture || Math.hypot(tip.x - this.lastCapture.point.x, tip.y - this.lastCapture.point.y, tip.z - this.lastCapture.point.z) > LEAVE_DISTANCE || now - this.lastCapture.atMs > LEAVE_MS;
    if (!left) { this.setRing(0); this.status.textContent = 'Captured. Move to the next X.'; this.status.className = 'status ok'; return; }
    if (!this.steadyAt || !this.steadySince || Math.hypot(tip.x - this.steadyAt.x, tip.y - this.steadyAt.y, tip.z - this.steadyAt.z) > .03) { this.steadySince = now; this.steadyAt = tip; }
    const held = now - this.steadySince;
    this.setRing(Math.min(1, held / HOLD_MS));
    this.status.textContent = `Fingertip at ${tip.x.toFixed(2)}, ${tip.y.toFixed(2)}, ${tip.z.toFixed(2)} (source frame). Hold still…`; this.status.className = 'status';
    if (held < HOLD_MS) return;
    let point: Vec3;
    try { point = this.host.captureFingertip(); } catch (error) { this.status.textContent = error instanceof Error ? error.message : String(error); this.steadySince = now; return; }
    this.lastCapture = { point, atMs: now }; this.steadySince = null; this.steadyAt = null;
    if (this.phase === 'touch') {
      this.pairs.push({ screen: this.targets[this.pairs.length], point });
      if (this.pairs.length === this.targets.length) this.phase = 'pullback';
    } else if (this.phase === 'pullback') {
      try {
        this.fit = this.host.applyHologram(this.pairs, point);
        this.phase = 'verify';
      } catch (error) {
        this.status.textContent = `${error instanceof Error ? error.message : String(error)} Press R to start over, Backspace to redo the pull-back.`; this.status.className = 'status error';
        return;
      }
    }
    this.render();
  }

  private setRing(fraction: number) { this.ring.setAttribute('stroke-dashoffset', String(2 * Math.PI * 34 * (1 - fraction))); }

  private place(target: { x: number; y: number }) {
    const w = this.root.clientWidth, h = this.root.clientHeight;
    const x = target.x * w, y = target.y * h;
    this.cross.setAttribute('transform', `translate(${x} ${y})`);
    for (const c of [this.ring, this.ringBack]) { c.setAttribute('cx', String(x)); c.setAttribute('cy', String(y)); }
  }

  private showCursor(tip: Vec3 | null) {
    const fit = this.fit;
    if (!tip || !fit) { this.cursor.setAttribute('visibility', 'hidden'); this.status.textContent = fit ? 'No fingertip in view.' : ''; return; }
    const h = applyAffine(fit.affine, tip);
    const w = this.root.clientWidth, hh = this.root.clientHeight;
    this.cursor.setAttribute('visibility', 'visible');
    this.cursor.setAttribute('cx', String(h.x * w)); this.cursor.setAttribute('cy', String(h.y * hh));
    const touching = Math.abs(h.z) < .15;
    this.cursor.setAttribute('r', String(touching ? 10 : 6 + 10 * Math.min(1, Math.max(0, h.z))));
    this.cursor.setAttribute('class', touching ? 'cursor touching' : 'cursor');
    this.status.textContent = `Fingertip on the picture at ${(h.x * 100).toFixed(0)}%, ${(h.y * 100).toFixed(0)}%; ${touching ? 'touching' : h.z > 0 ? `${(h.z * 100).toFixed(0)}% of the pull-back distance in front` : 'behind the picture'}.`;
    this.status.className = 'status';
  }

  private renderArea() {
    const a = this.host.hologramArea, w = this.root.clientWidth, h = this.root.clientHeight;
    const x = a.x0 * w, y = a.y0 * h, rw = (a.x1 - a.x0) * w, rh = (a.y1 - a.y0) * h;
    for (const [k, v] of Object.entries({ x, y, width: rw, height: rh })) this.areaRect.setAttribute(k, String(v));
    const line = { top: [x, y, x + rw, y], bottom: [x, y + rh, x + rw, y + rh], left: [x, y, x, y + rh], right: [x + rw, y, x + rw, y + rh] }[this.edge];
    ['x1', 'y1', 'x2', 'y2'].forEach((k, i) => this.edgeLine.setAttribute(k, String(line[i])));
    const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
    this.status.textContent = `Area: ${pct(a.x0)}–${pct(a.x1)} across, ${pct(a.y0)}–${pct(a.y1)} down. Selected edge: ${this.edge}.`;
    this.status.className = 'status';
  }

  private render() {
    const n = this.pairs.length;
    const areaVisible = this.phase === 'area';
    this.areaRect.setAttribute('visibility', areaVisible ? 'visible' : 'hidden'); this.edgeLine.setAttribute('visibility', areaVisible ? 'visible' : 'hidden');
    const crossVisible = !areaVisible;
    for (const node of [this.cross, this.ring, this.ringBack]) node.setAttribute('visibility', crossVisible ? 'visible' : 'hidden');
    if (this.phase === 'area') {
      this.svg.classList.remove('pullback', 'verify');
      this.title.textContent = 'Size the outline to the part of the picture the hologram shows';
      this.detail.textContent = 'Tab selects an edge (top, bottom, left, right), arrow keys move it (Shift for fine steps), 0 resets to the whole picture, Enter confirms. The X\u2019s are placed inside it.';
      this.renderArea();
    } else if (this.phase === 'touch') {
      this.place(this.targets[n]);
      this.svg.classList.remove('pullback', 'verify');
      this.title.textContent = `Touch the X with your fingertip (${n + 1} of ${this.targets.length})`;
      this.detail.textContent = 'Hold it on the picture until the ring fills. Backspace redoes the previous X, R starts over, Esc leaves.';
    } else if (this.phase === 'pullback') {
      this.place(this.targets[PULL_BACK_TARGET]);
      this.svg.classList.add('pullback'); this.svg.classList.remove('verify');
      this.title.textContent = 'Now hold your fingertip about 10 cm in front of the centre X';
      this.detail.textContent = 'This sets how far "above the water" a raised finger is. Hold still until the ring fills.';
    } else {
      this.svg.classList.add('verify'); this.svg.classList.remove('pullback');
      this.setRing(0);
      const fit = this.fit!;
      const worst = fit.residuals.reduce((best, r, i) => r > fit.residuals[best] ? i : best, 0);
      this.title.textContent = `Calibrated: mean error ${(fit.rmsError * 100).toFixed(1)}% of the picture width`;
      this.detail.textContent = `Worst touch was X ${worst + 1} at ${(fit.residuals[worst] * 100).toFixed(1)}%. The dot shows where the picture thinks your fingertip is; it turns bright on touch. R to redo, Esc when it looks right.`;
      this.place(this.targets[PULL_BACK_TARGET]);
    }
  }
}
