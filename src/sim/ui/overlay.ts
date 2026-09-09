/**
 * Operator overlay: choose a simulation and source, tune parameters, map
 * and calibrate the physical box, watch hands and signals, and configure
 * where telemetry goes. Hidden with H for the installation itself.
 *
 * The overlay never touches simulation state directly; it only calls host
 * methods and re-renders from `host.state()`.
 */
import type { AnyParamValue, ParamSpec } from '../core/types';
import type { SimHost, HostState } from '../host/app';
import { SIMULATIONS } from '../host/registry';
import { AXES, type Axis, type CalibrationCaptures, type SpaceMapping } from '../input/mapping';
import { SOURCE_IDS, type SourceId } from '../input/types';

type Child = Node | string | null | undefined | false;
function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string | boolean | number | ((e: Event) => void)> = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (typeof value === 'function') node.addEventListener(key.replace(/^on/, ''), value);
    else if (typeof value === 'boolean') { if (value) node.setAttribute(key, ''); }
    else node.setAttribute(key, String(value));
  }
  for (const child of children) if (child) node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  return node;
}
const fmt = (v: number, digits = 2) => Number.isFinite(v) ? v.toFixed(digits) : '–';
const SOURCE_LABELS: Record<SourceId, string> = { pointer: 'Pointer (mouse / touch)', synthetic: 'Synthetic performer', webcam: 'Webcam hand tracking', leap: 'Leap Motion (local service)', depth: 'Depth camera bridge', replay: 'Replay recording' };

export class Overlay {
  private timer?: ReturnType<typeof setInterval>;
  private builtSim = ''; private builtSource: SourceId | '' = '';
  private paramsBox = el('div'); private sourceBox = el('div'); private signalsBox = el('div');
  private status = el('div', { class: 'status' }); private hands = el('div'); private events = el('div', { class: 'events' });
  private presence = el('span'); private activity = el('span');
  private minimap = el('canvas', { class: 'minimap', width: 320, height: 180 });
  /** Top-down view of the volume: x across, z (depth into the scene) upward. */
  private topmap = el('canvas', { class: 'minimap topmap', width: 320, height: 70 });
  private fps = el('div', { class: 'fps' }); private warnings = el('div', { class: 'warnings' });
  private telemetryStatus = el('div', { class: 'status' }); private lastFrame = el('pre'); private showFrame = false;
  private mappingBox = el('div'); private calibrationStatus = el('div', { class: 'status' });
  private diagnostics = el('div', { class: 'status' });
  private simSelect = el('select'); private sourceSelect = el('select');
  private paramOutputs = new Map<string, HTMLOutputElement | HTMLInputElement>();
  private signalBars = new Map<string, { bar: HTMLSpanElement; out: HTMLOutputElement; row: HTMLElement }>();
  private captureOrder: (keyof CalibrationCaptures)[] = ['bottomLeft', 'topRight'];

  constructor(private readonly root: HTMLElement, private readonly host: SimHost, private readonly video: HTMLVideoElement) {
    this.build();
    host.onChange(() => this.syncStructure());
  }

  get visible() { return !this.root.hidden; }
  set visible(value: boolean) {
    this.root.hidden = !value;
    if (value) { this.syncStructure(); this.update(); if (!this.timer) this.timer = setInterval(() => this.update(), 100); }
    else if (this.timer) { clearInterval(this.timer); this.timer = undefined; }
    this.video.hidden = !(value && this.host.state().sourceId === 'webcam');
  }

  selectByIndex(index: number) { const sim = SIMULATIONS[index]; if (sim) this.host.selectSimulation(sim.id); }

  /** Keyboard-driven calibration: captures the next corner, then applies. */
  captureNext() {
    const captures = this.host.state().calibration;
    const next = this.captureOrder.find(k => !captures[k]);
    try {
      if (next) { this.host.captureCalibration(next); const remaining = this.captureOrder.filter(k => !this.host.state().calibration[k]); this.calibrationStatus.textContent = remaining.length ? `Captured ${label(next)}. Next: ${label(remaining[0])} (press C).` : 'Both corners captured. Press C again to apply.'; }
      else { this.host.applyCalibration(); this.host.clearCalibration(); this.calibrationStatus.textContent = 'Calibration applied to this source.'; }
      this.calibrationStatus.className = 'status ok';
    } catch (error) { this.calibrationStatus.textContent = error instanceof Error ? error.message : String(error); this.calibrationStatus.className = 'status error'; }
  }

  // ------------------------------------------------------------------ structure

  private build() {
    for (const sim of SIMULATIONS) this.simSelect.appendChild(el('option', { value: sim.id }, sim.title));
    this.simSelect.addEventListener('change', () => this.host.selectSimulation(this.simSelect.value));
    for (const id of SOURCE_IDS) this.sourceSelect.appendChild(el('option', { value: id }, SOURCE_LABELS[id]));
    this.sourceSelect.addEventListener('change', () => { const id = this.sourceSelect.value as SourceId; if (id === 'replay') { this.sourceSelect.value = this.host.state().sourceId; this.status.textContent = 'Load a recording with the button below to replay it.'; return; } void this.host.setSource(id).then(() => this.syncStructure()); });
    this.root.replaceChildren(
      el('div', { class: 'head' }, el('div', {}, el('h1', {}, 'Simulations'), el('div', { class: 'hint' }, el('kbd', {}, 'H'), ' overlay · ', el('kbd', {}, 'F'), ' fullscreen · ', el('kbd', {}, 'C'), ' calibrate · ', el('kbd', {}, '1–9'), ' switch')), this.fps),
      el('div', { class: 'row' }, el('button', { onclick: () => this.host.toggleFullscreen() }, 'Fullscreen'), el('button', { onclick: () => { this.visible = false; } }, 'Hide overlay')),
      el('details', { open: true }, el('summary', {}, el('h2', {}, 'Simulation')), el('div', { class: 'row' }, el('label', {}, this.simSelect)), this.paramsBox),
      el('details', { open: true }, el('summary', {}, el('h2', {}, 'Input'), el('span', { class: 'badge' }, this.presence, ' · ', this.activity)),
        el('div', { class: 'row' }, el('label', {}, this.sourceSelect)), this.status, this.sourceBox, this.minimap, this.topmap, this.hands, this.events),
      el('details', {}, el('summary', {}, el('h2', {}, 'Mapping & calibration')), this.mappingBox, this.calibrationStatus),
      el('details', { open: true }, el('summary', {}, el('h2', {}, 'Signals → audio')), this.signalsBox),
      el('details', {}, el('summary', {}, el('h2', {}, 'Telemetry')), this.telemetrySection(), this.telemetryStatus, this.lastFrame),
      el('details', {}, el('summary', {}, el('h2', {}, 'Diagnostics')), this.diagnosticsSection(), this.diagnostics, this.warnings),
    );
    this.syncStructure();
  }

  private syncStructure() {
    const s = this.host.state();
    if (s.simulation.id !== this.builtSim) { this.builtSim = s.simulation.id; this.simSelect.value = s.simulation.id; this.buildParams(s); this.buildSignals(s); }
    else this.syncParamValues(s);
    if (s.sourceId !== this.builtSource) { this.builtSource = s.sourceId; this.sourceSelect.value = s.sourceId; this.buildSource(s); this.buildMapping(s); this.video.hidden = !(this.visible && s.sourceId === 'webcam'); }
    this.syncMappingValues(s);
  }

  private buildParams(s: HostState) {
    this.paramOutputs.clear();
    const rows: Node[] = [el('p', {}, s.simulation.description)];
    for (const [name, spec] of Object.entries(s.simulation.params)) rows.push(this.paramRow(name, spec, s.params[name]));
    rows.push(el('div', { class: 'row' }, el('button', { onclick: () => { this.host.resetParams(); this.syncParamValues(this.host.state()); } }, 'Reset parameters')));
    this.paramsBox.replaceChildren(...rows);
  }

  private paramRow(name: string, spec: ParamSpec, value: AnyParamValue): HTMLElement {
    const title = spec.description ? `${spec.label ?? name}: ${spec.description}` : (spec.label ?? name);
    const nameEl = el('span', { class: 'name', title }, spec.label ?? name);
    switch (spec.kind) {
      case 'number': {
        const range = el('input', { type: 'range', min: spec.min, max: spec.max, step: spec.step ?? (spec.max - spec.min) / 200, value: Number(value) });
        const out = el('output', {}, `${fmt(Number(value), decimals(spec.step))}${spec.unit ? ` ${spec.unit}` : ''}`);
        range.addEventListener('input', () => { this.host.setParam(name, Number(range.value)); out.textContent = `${fmt(Number(range.value), decimals(spec.step))}${spec.unit ? ` ${spec.unit}` : ''}`; });
        this.paramOutputs.set(name, range);
        return el('div', { class: 'param' }, nameEl, range, out);
      }
      case 'boolean': {
        const box = el('input', { type: 'checkbox' }); box.checked = Boolean(value);
        box.addEventListener('change', () => this.host.setParam(name, box.checked));
        this.paramOutputs.set(name, box);
        return el('div', { class: 'param wide' }, nameEl, el('label', {}, box));
      }
      case 'select': {
        const select = el('select'); for (const o of spec.options) select.appendChild(el('option', { value: o }, o)); select.value = String(value);
        select.addEventListener('change', () => this.host.setParam(name, select.value));
        this.paramOutputs.set(name, select as unknown as HTMLInputElement);
        return el('div', { class: 'param wide' }, nameEl, select);
      }
      case 'color': {
        const input = el('input', { type: 'color', value: String(value) });
        input.addEventListener('input', () => this.host.setParam(name, input.value));
        this.paramOutputs.set(name, input);
        return el('div', { class: 'param wide' }, nameEl, input);
      }
    }
  }

  private syncParamValues(s: HostState) {
    for (const [name, control] of this.paramOutputs) {
      if (document.activeElement === control) continue;
      const value = s.params[name];
      if (control instanceof HTMLInputElement && control.type === 'checkbox') control.checked = Boolean(value);
      else if (String(control.value) !== String(value)) { control.value = String(value); control.dispatchEvent(new Event('input')); }
    }
  }

  private buildSignals(s: HostState) {
    this.signalBars.clear();
    const rows: Node[] = [];
    for (const [name, spec] of Object.entries(s.simulation.signals)) {
      const bar = el('span'), out = el('output', {}, '0');
      const row = el('div', { class: 'signal', title: `${spec.description} [${spec.min}, ${spec.max}]${spec.unit ? ` ${spec.unit}` : ''}` }, el('span', { class: 'name' }, name), el('div', { class: 'bar' }, bar), out);
      this.signalBars.set(name, { bar, out, row }); rows.push(row);
    }
    if (!rows.length) rows.push(el('p', { class: 'hint' }, 'This simulation declares no signals.'));
    this.signalsBox.replaceChildren(...rows);
  }

  private buildSource(s: HostState) {
    const nodes: Node[] = [];
    const settings = this.host.settings.value;
    if (s.sourceId === 'depth') {
      const url = el('input', { type: 'text', value: settings.depth.url, placeholder: 'ws://127.0.0.1:8765' });
      nodes.push(el('div', { class: 'row' }, el('label', {}, 'Bridge WebSocket URL', url), el('button', { onclick: () => this.host.setDepthUrl(url.value) }, 'Connect')));
      nodes.push(el('p', { class: 'hint' }, 'Run bridge/depth_bridge.py next to the camera. See bridge/README.md.'));
    }
    if (s.sourceId === 'leap') {
      const url = el('input', { type: 'text', value: settings.leap.url, placeholder: 'ws://127.0.0.1:6437/v6.json' });
      const box = settings.leap.box;
      const num = (v: number) => el('input', { type: 'number', step: 10, value: v });
      const inputs = { x: [num(box.x[0]), num(box.x[1])], y: [num(box.y[0]), num(box.y[1])], z: [num(box.z[0]), num(box.z[1])] } as const;
      const apply = () => {
        try {
          const read = (pair: readonly [HTMLInputElement, HTMLInputElement]): [number, number] => [Number(pair[0].value), Number(pair[1].value)];
          this.host.setLeapOptions({ url: url.value.trim(), box: { x: read(inputs.x), y: read(inputs.y), z: read(inputs.z) } });
        } catch (error) { this.host.warn(error instanceof Error ? error.message : String(error)); }
      };
      nodes.push(el('div', { class: 'row' }, el('label', {}, 'Leap service WebSocket URL', url)));
      nodes.push(el('p', { class: 'hint' }, 'Physical box in millimetres from the device centre: x to your right, y up, z toward you. Read the palm position in the stats line to set it, then fine-tune with calibration.'));
      for (const axis of ['x', 'y', 'z'] as const) nodes.push(el('div', { class: 'row inline' }, el('label', {}, `${axis} min`, inputs[axis][0]), el('label', {}, `${axis} max`, inputs[axis][1])));
      const ratio = () => (box.z[1] - box.z[0]) / Math.max(1, box.y[1] - box.y[0]);
      nodes.push(el('div', { class: 'row' }, el('button', { class: 'primary', onclick: apply }, 'Apply & reconnect'), el('button', { title: 'Sets Volume depth to the box depth ÷ height so a solid hand keeps its proportions.', onclick: () => { this.host.setVolumeDepth(ratio()); this.host.warn(`Volume depth set to ${ratio().toFixed(2)} to match the Leap box.`); } }, `Match volume depth (${ratio().toFixed(2)})`)));
      nodes.push(el('p', { class: 'hint' }, 'Needs "Allow Web Apps" enabled in the Leap Motion control panel (the service then listens on port 6437). Keep the box proportions like the display (width : height : depth ≈ aspect : 1 : volume depth) so the solid hand is not stretched.'));
    }
    if (s.sourceId === 'synthetic') {
      const hands = el('select'); hands.append(el('option', { value: '1' }, '1 hand'), el('option', { value: '2' }, '2 hands')); hands.value = String(settings.synthetic.hands);
      const speed = el('input', { type: 'range', min: .2, max: 3, step: .1, value: settings.synthetic.speed });
      hands.addEventListener('change', () => this.host.setSyntheticOptions({ hands: Number(hands.value) as 1 | 2 }));
      speed.addEventListener('change', () => this.host.setSyntheticOptions({ speed: Number(speed.value) }));
      nodes.push(el('div', { class: 'row' }, el('label', {}, 'Hands', hands), el('label', {}, 'Speed', speed)));
    }
    if (s.sourceId === 'webcam') nodes.push(el('p', { class: 'hint' }, 'Show one open hand. Depth comes from apparent hand size; calibrate withdrawn/pushed in Mapping.'));
    if (s.sourceId === 'pointer') nodes.push(el('p', { class: 'hint' }, 'Move over the canvas. Press to push in, wheel adjusts resting depth, Shift closes the hand. The hand leaves after 2.5 s of stillness.'));
    const record = el('button', { onclick: () => { if (this.host.state().recording.active) { download('sim-input-recording.jsonl', this.host.stopRecording(), 'application/x-ndjson'); record.textContent = 'Record input'; } else { this.host.startRecording(); record.textContent = 'Stop & save'; } } }, s.recording.active ? 'Stop & save' : 'Record input');
    const file = el('input', { type: 'file', accept: '.jsonl,.txt,application/x-ndjson' });
    file.addEventListener('change', async () => { const f = file.files?.[0]; if (!f) return; try { await this.host.setSource('replay', { recording: await f.text() }); } catch (error) { this.host.warn(error instanceof Error ? error.message : String(error)); } finally { file.value = ''; } });
    nodes.push(el('div', { class: 'row' }, record, el('label', { class: 'file-button' }, 'Replay recording…', file)));
    this.sourceBox.replaceChildren(...nodes);
  }

  private mappingInputs: Record<Axis, { from: HTMLSelectElement; low: HTMLInputElement; high: HTMLInputElement; mirror: HTMLInputElement }> | null = null;
  private buildMapping(s: HostState) {
    const inputs = {} as NonNullable<typeof this.mappingInputs>;
    const rows: Node[] = [el('p', { class: 'hint' }, s.source?.frameDescription ?? ''), el('div', { class: 'axis' }, el('span', { class: 'lbl' }, 'sim'), el('span', { class: 'lbl' }, 'source'), el('span', { class: 'lbl' }, 'low → 0'), el('span', { class: 'lbl' }, 'high → 1'), el('span', { class: 'lbl' }, 'mirror'))];
    for (const axis of AXES) {
      const from = el('select'); for (const a of AXES) from.appendChild(el('option', { value: a }, a));
      const low = el('input', { type: 'number', step: .01, min: -1, max: 2 }), high = el('input', { type: 'number', step: .01, min: -1, max: 2 }), mirror = el('input', { type: 'checkbox' });
      const apply = () => { try { this.host.setMapping(this.readMapping()); this.calibrationStatus.textContent = ''; } catch (error) { this.calibrationStatus.textContent = error instanceof Error ? error.message : String(error); this.calibrationStatus.className = 'status error'; } };
      for (const c of [from, low, high, mirror]) c.addEventListener('change', apply);
      inputs[axis] = { from, low, high, mirror };
      rows.push(el('div', { class: 'axis' }, el('span', {}, axis), from, low, high, mirror));
    }
    this.mappingInputs = inputs;
    const capture = (kind: keyof CalibrationCaptures) => el('button', { onclick: () => { try { this.host.captureCalibration(kind); this.calibrationStatus.textContent = `Captured ${label(kind)}.`; this.calibrationStatus.className = 'status ok'; } catch (error) { this.calibrationStatus.textContent = error instanceof Error ? error.message : String(error); this.calibrationStatus.className = 'status error'; } } }, label(kind));
    rows.push(el('p', { class: 'hint' }, 'Hold the hand at each corner of the intended play area and capture; then apply. Depth captures are optional.'));
    rows.push(el('div', { class: 'row' }, capture('bottomLeft'), capture('topRight'), capture('withdrawn'), capture('pushed')));
    rows.push(el('div', { class: 'row' }, el('button', { class: 'primary', onclick: () => { try { this.host.applyCalibration(); this.host.clearCalibration(); this.calibrationStatus.textContent = 'Calibration applied.'; this.calibrationStatus.className = 'status ok'; } catch (error) { this.calibrationStatus.textContent = error instanceof Error ? error.message : String(error); this.calibrationStatus.className = 'status error'; } } }, 'Apply calibration'), el('button', { onclick: () => { this.host.resetMapping(); this.calibrationStatus.textContent = 'Mapping reset to the source default.'; this.calibrationStatus.className = 'status'; } }, 'Reset mapping')));
    this.mappingBox.replaceChildren(...rows);
    this.syncMappingValues(s);
  }
  private readMapping(): SpaceMapping {
    const m = this.mappingInputs!;
    const read = (axis: Axis) => ({ from: m[axis].from.value as Axis, low: Number(m[axis].low.value), high: Number(m[axis].high.value), mirror: m[axis].mirror.checked });
    return { x: read('x'), y: read('y'), z: read('z') };
  }
  private syncMappingValues(s: HostState) {
    if (!this.mappingInputs) return;
    for (const axis of AXES) {
      const i = this.mappingInputs[axis], m = s.mapping[axis];
      if ([i.from, i.low, i.high, i.mirror].includes(document.activeElement as HTMLInputElement)) continue;
      i.from.value = m.from; i.low.value = String(m.low); i.high.value = String(m.high); i.mirror.checked = m.mirror;
    }
  }

  private telemetrySection(): HTMLElement {
    const t = this.host.settings.value.telemetry;
    const rate = el('input', { type: 'number', min: 1, max: 120, value: t.rateHz });
    const broadcast = el('input', { type: 'checkbox' }); broadcast.checked = t.broadcast;
    const win = el('input', { type: 'checkbox' }); win.checked = t.window;
    const occupancy = el('input', { type: 'checkbox' }); occupancy.checked = t.occupancy;
    const url = el('input', { type: 'text', value: t.websocketUrl, placeholder: 'ws://127.0.0.1:9000 (audio process)' });
    rate.addEventListener('change', () => this.host.setTelemetry({ rateHz: Number(rate.value) }));
    broadcast.addEventListener('change', () => this.host.setTelemetry({ broadcast: broadcast.checked }));
    win.addEventListener('change', () => this.host.setTelemetry({ window: win.checked }));
    occupancy.addEventListener('change', () => this.host.setTelemetry({ occupancy: occupancy.checked }));
    const show = el('button', { onclick: () => { this.showFrame = !this.showFrame; show.textContent = this.showFrame ? 'Hide last frame' : 'Show last frame'; this.lastFrame.hidden = !this.showFrame; } }, 'Show last frame');
    this.lastFrame.hidden = true;
    return el('div', {},
      el('p', { class: 'hint' }, 'Frames carry parameters, signals, hands, gestures and source stats. The audio project subscribes to any of these channels.'),
      el('div', { class: 'row inline' }, el('label', {}, 'Rate (Hz)', rate), el('label', {}, broadcast, 'BroadcastChannel'), el('label', {}, win, 'Window'), el('label', {}, occupancy, 'Occupancy')),
      el('div', { class: 'row' }, el('label', {}, 'WebSocket (page connects out)', url), el('button', { onclick: () => this.host.setTelemetry({ websocketUrl: url.value.trim() }) }, 'Apply')),
      el('div', { class: 'row' }, show, el('button', { onclick: () => download('sim-schema.json', JSON.stringify(this.host.schema(), null, 2)) }, 'Download schema')),
    );
  }

  private diagnosticsSection(): HTMLElement {
    const settings = this.host.settings.value;
    const quality = el('select'); for (const q of ['low', 'medium', 'high']) quality.appendChild(el('option', { value: q }, q)); quality.value = settings.quality;
    quality.addEventListener('change', () => this.host.setQuality(quality.value as 'low' | 'medium' | 'high'));
    const dpr = el('select'); for (const d of ['1', '1.25', '1.5', '2']) dpr.appendChild(el('option', { value: d }, `${d}×`)); dpr.value = String(settings.maxDpr);
    dpr.addEventListener('change', () => this.host.setMaxDpr(Number(dpr.value)));
    const depth = el('input', { type: 'number', min: .25, max: 3, step: .05, value: settings.volumeDepth });
    depth.addEventListener('change', () => this.host.setVolumeDepth(Number(depth.value)));
    const tracker = this.host.tracker.settings;
    const num = (key: 'enterMs' | 'leaveMs' | 'minCutoff' | 'beta', step: number) => { const i = el('input', { type: 'number', step, value: tracker[key] }); i.addEventListener('change', () => this.host.setTrackerSettings({ [key]: Number(i.value) })); return el('label', {}, key, i); };
    return el('div', {},
      el('div', { class: 'row' }, el('label', {}, 'Quality', quality), el('label', {}, 'Max pixel ratio', dpr), el('label', {}, 'Volume depth', depth)),
      el('p', { class: 'hint' }, 'Volume depth is the z size of the 3D space in units of the canvas height; hands live inside it.'),
      el('div', { class: 'row' }, num('enterMs', 10), num('leaveMs', 10), num('minCutoff', .1), num('beta', .005)),
      el('p', { class: 'hint' }, 'enter/leave: presence hysteresis. minCutoff lower = calmer at rest; beta higher = less lag when moving.'),
    );
  }

  // ------------------------------------------------------------------ dynamic values

  private update() {
    if (!this.visible) return;
    const s = this.host.state();
    this.fps.textContent = `${Math.round(s.perf.fps)} fps · step ${fmt(s.perf.stepMs, 1)} ms · draw ${fmt(s.perf.renderMs, 1)} ms${s.perf.droppedMs > 0 ? ` · dropped ${Math.round(s.perf.droppedMs)} ms` : ''}`;
    this.presence.textContent = `presence ${fmt(s.tracked.presence)}`; this.activity.textContent = `activity ${fmt(s.tracked.activity)}`;
    const st = s.source?.status();
    const age = Number.isFinite(s.tracked.sourceAgeMs) ? `${Math.round(s.tracked.sourceAgeMs)} ms ago` : 'no frames yet';
    const stats = Object.entries(s.tracked.stats).map(([k, v]) => `${k} ${Number.isInteger(v) ? v : v.toFixed(2)}`).join(' · ');
    this.status.textContent = `${st?.message ?? 'No source.'}\nLast frame ${age} · discarded ${s.tracked.discarded}${s.recording.active ? ` · recording ${s.recording.frames} frames` : ''}${stats ? `\n${stats}` : ''}`;
    this.status.className = `status${st?.state === 'error' ? ' error' : st?.state === 'running' ? ' ok' : ''}`;
    this.hands.replaceChildren(s.tracked.hands.length ? el('table', {}, el('tr', {}, ...['hand', 'x', 'y', 'z', 'speed', 'open', 'push', 'age'].map(h => el('th', {}, h))), ...s.tracked.hands.map(h => el('tr', {}, el('td', {}, `#${h.id}`), el('td', {}, fmt(h.position.x)), el('td', {}, fmt(h.position.y)), el('td', {}, fmt(h.position.z)), el('td', {}, fmt(h.speed)), el('td', {}, fmt(h.openness, 1)), el('td', {}, fmt(h.push)), el('td', {}, `${(h.ageMs / 1000).toFixed(1)}s`)))) : el('p', { class: 'hint' }, 'No hand present.'));
    if (s.events.length) this.events.replaceChildren(...s.events.slice(-8).map(e => el('span', {}, `${e.type}${'direction' in e ? ` ${e.direction}` : ''} #${e.handId}`)));
    for (const [name, { bar, out, row }] of this.signalBars) {
      const spec = s.simulation.signals[name], v = s.signals[name] ?? spec.min;
      bar.style.width = `${Math.round(100 * (v - spec.min) / (spec.max - spec.min))}%`; out.textContent = fmt(v, 3);
      row.classList.toggle('violation', s.signalViolations.some(x => x.startsWith(`${name}=`)));
    }
    this.drawMinimap(s);
    this.telemetryStatus.textContent = `${s.telemetry.sent} frames sent at ${s.telemetry.rateHz} Hz\n${s.telemetry.transports.map(t => `${t.status.connected ? '●' : '○'} ${t.id}: ${t.status.detail}`).join('\n') || 'No transports enabled.'}`;
    if (this.showFrame && this.host.bus.lastFrame) this.lastFrame.textContent = JSON.stringify(this.host.bus.lastFrame, null, 1);
    this.diagnostics.textContent = `${s.gpu}\n${s.width}×${s.height} @ ${s.dpr.toFixed(2)}× · quality ${s.quality}${s.contextLost ? '\nWebGL context lost' : ''}`;
    this.warnings.replaceChildren(...s.warnings.slice(-8).reverse().map(w => el('div', {}, `${(w.atMs / 1000).toFixed(1)}s ${w.message}`)));
  }

  private drawMinimap(s: HostState) {
    const c = this.minimap, ctx = c.getContext('2d');
    if (!ctx) return;
    const w = c.width, h = c.height;
    ctx.fillStyle = '#070908'; ctx.fillRect(0, 0, w, h);
    const scan = s.tracked.surface;
    if (scan) {
      // The depth scan: nearer cells brighter.
      const cw = w / scan.width, ch = h / scan.height;
      for (let row = 0; row < scan.height; row++) for (let col = 0; col < scan.width; col++) {
        const i = row * scan.width + col; if (!scan.mask[i]) continue;
        const near = 1 - Math.min(1, Math.max(0, scan.z[i]));
        ctx.fillStyle = `rgba(150, 200, 255, ${.15 + .7 * near})`; ctx.fillRect(col * cw, h - (row + 1) * ch, cw + .5, ch + .5);
      }
    }
    const occ = s.tracked.occupancy;
    if (occ && !scan) {
      const cw = w / occ.width, ch = h / occ.height;
      for (let row = 0; row < occ.height; row++) for (let col = 0; col < occ.width; col++) {
        const v = occ.data[row * occ.width + col]; if (v < 8) continue;
        ctx.fillStyle = `rgba(120, 160, 120, ${(v / 255) * .6})`; ctx.fillRect(col * cw, h - (row + 1) * ch, cw + .5, ch + .5);
      }
    }
    ctx.strokeStyle = '#2c342f'; ctx.strokeRect(.5, .5, w - 1, h - 1);
    for (const hand of s.tracked.hands) {
      // Front view: nearer hands (z → 0) draw larger, as the window camera would show them.
      const x = hand.position.x * w, y = (1 - hand.position.y) * h, size = 4 + 10 * (1 - hand.position.z);
      ctx.strokeStyle = 'rgba(185, 236, 128, .5)'; ctx.strokeRect(hand.extent.min.x * w, (1 - hand.extent.max.y) * h, (hand.extent.max.x - hand.extent.min.x) * w, (hand.extent.max.y - hand.extent.min.y) * h);
      // The solid shape, when the source knows it: each capsule as a stroke of its own thickness.
      ctx.strokeStyle = 'rgba(185, 236, 128, .8)'; ctx.lineCap = 'round';
      for (const c of hand.capsules) { ctx.lineWidth = Math.max(1, c.radius * 2 * w); ctx.beginPath(); ctx.moveTo(c.a.x * w, (1 - c.a.y) * h); ctx.lineTo(c.b.x * w, (1 - c.b.y) * h); ctx.stroke(); }
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(x, y, size, 0, Math.PI * 2); ctx.fillStyle = `rgba(185, 236, 128, ${.4 + .6 * hand.openness})`; ctx.fill();
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + hand.velocity.x * w * .25, y - hand.velocity.y * h * .25); ctx.strokeStyle = '#e5e9e4'; ctx.stroke();
      ctx.fillStyle = '#9aa79e'; ctx.fillText(`#${hand.id}`, x + 8, y - 8);
    }
    // Top view: x across, depth upward (the glass at the bottom edge, the back wall at the top).
    const t = this.topmap, tc = t.getContext('2d');
    if (!tc) return;
    tc.fillStyle = '#070908'; tc.fillRect(0, 0, t.width, t.height);
    tc.strokeStyle = '#2c342f'; tc.strokeRect(.5, .5, t.width - 1, t.height - 1);
    tc.fillStyle = '#4a5a4c'; tc.fillText('glass', 4, t.height - 4); tc.fillText('back', 4, 10);
    if (scan) {
      // Top view of the scan: for each column, the nearest scanned depth.
      tc.fillStyle = 'rgba(150, 200, 255, .8)';
      for (let col = 0; col < scan.width; col++) {
        let nearest = Infinity;
        for (let row = 0; row < scan.height; row++) { const i = row * scan.width + col; if (scan.mask[i]) nearest = Math.min(nearest, scan.z[i]); }
        if (nearest !== Infinity) tc.fillRect(col * t.width / scan.width, (1 - nearest) * t.height - 1, t.width / scan.width + .5, 2);
      }
    }
    for (const hand of s.tracked.hands) {
      const x = hand.position.x * t.width, y = (1 - hand.position.z) * t.height;
      tc.strokeStyle = 'rgba(185, 236, 128, .8)'; tc.lineCap = 'round';
      for (const c of hand.capsules) { tc.lineWidth = Math.max(1, c.radius * 2 * t.width); tc.beginPath(); tc.moveTo(c.a.x * t.width, (1 - c.a.z) * t.height); tc.lineTo(c.b.x * t.width, (1 - c.b.z) * t.height); tc.stroke(); }
      tc.lineWidth = 1;
      tc.beginPath(); tc.arc(x, y, 4, 0, Math.PI * 2); tc.fillStyle = `rgba(185, 236, 128, ${.4 + .6 * hand.openness})`; tc.fill();
      tc.beginPath(); tc.moveTo(x, y); tc.lineTo(x + hand.velocity.x * t.width * .25, y - hand.velocity.z * t.height * .25); tc.strokeStyle = '#e5e9e4'; tc.stroke();
    }
  }
}

function label(kind: keyof CalibrationCaptures): string { return { bottomLeft: 'bottom-left', topRight: 'top-right', withdrawn: 'withdrawn', pushed: 'pushed in' }[kind]; }
function decimals(step?: number): number { if (!step) return 2; const s = String(step); return s.includes('.') ? Math.min(4, s.split('.')[1].length) : 0; }
function download(name: string, content: string | BlobPart[], type = 'application/json') {
  const blob = new Blob(typeof content === 'string' ? [content] : content, { type }), url = URL.createObjectURL(blob), a = document.createElement('a');
  a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
