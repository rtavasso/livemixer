/**
 * The host: owns the canvas and GL context, the active input source, the hand
 * tracker, the active simulation, and the telemetry bus. It runs the frame
 * loop and is the only place where those pieces meet.
 *
 * Frame:  source.sample → tracker.tick → gestures → N fixed steps → render → signals → telemetry
 */
import type { AnyParamValue, GestureSettingsLike, OccupancyField, Quality, SimContext, SimInput, SimulationInstance } from './contracts';
import { clampSignals, coerceParam, resolveParams } from '../core/params';
import { createGl, describeGpu, fitCanvas } from '../gl/context';
import { DEFAULT_TRACKER_SETTINGS, HandTracker, trackerSettingsSchema, type TrackedInput } from '../input/conditioning';
import { DEFAULT_GESTURE_SETTINGS, detectGestures, emptyGestureMemory, gestureSettingsSchema, GESTURE_TYPES, type GestureEvent, type GestureMemory } from '../input/gestures';
import { calibrateMapping, spaceMappingSchema, stableCapture, type CalibrationCaptures, type SpaceMapping } from '../input/mapping';
import { DepthBridgeSource } from '../input/depth';
import { LeapSource } from '../input/leap';
import { PointerSource } from '../input/pointer';
import { InputRecorder, parseRecording, ReplaySource } from '../input/replay';
import { invalidateQuadCache } from '../gl/quad';
import { SyntheticSource } from '../input/synthetic';
import { WebcamSource } from '../input/webcam';
import { SOURCE_IDS, type HandState, type InputFrame, type InputSource, type SourceId } from '../input/types';
import { encodeOccupancy } from '../input/protocol';
import { TelemetryBus } from '../telemetry/bus';
import { BroadcastTransport, WebSocketTransport, WindowTransport } from '../telemetry/transports';
import type { HandTelemetry, TelemetryFrame, TelemetrySchema } from '../telemetry/types';
import { FixedStepper, RateMeter } from './loop';
import { findSimulation, SIMULATIONS, validateRegistry, type AnySimulation } from './registry';
import { defaultMapping, settingsSchema, SettingsStore, type Settings, type SolidChoice } from './settings';
import type { SimulationOutput } from '../core/output';

export interface HostWarning { atMs: number; message: string }
export interface HostPerf { fps: number; stepMs: number; renderMs: number; steps: number; droppedMs: number }
export interface HostOptions { externalTelemetry?: boolean; fullscreenRoot?: HTMLElement }

export interface HostState {
  simulation: AnySimulation;
  params: Record<string, AnyParamValue>;
  signals: Record<string, number>;
  signalViolations: string[];
  source: InputSource | null;
  sourceId: SourceId;
  tracked: TrackedInput;
  events: GestureEvent[];
  mapping: SpaceMapping;
  calibration: CalibrationCaptures;
  perf: HostPerf;
  warnings: HostWarning[];
  gpu: string;
  dpr: number;
  width: number; height: number;
  quality: Quality;
  /** Which solid the simulation is handed (settings); telemetry always reports the tracker's full state. */
  solid: SolidChoice;
  recording: { active: boolean; frames: number };
  telemetry: { sent: number; rateHz: number; transports: { id: string; status: { connected: boolean; detail: string } }[] };
  contextLost: boolean;
}

const RAW_SAMPLE_WINDOW_MS = 1000;

export class SimHost {
  private output: SimulationOutput | null = null;
  /** Null while stopped, restarting, or recovering from a simulation/GL failure. */
  get latestOutput(): SimulationOutput | null { return this.output; }
  readonly canvas: HTMLCanvasElement;
  readonly settings: SettingsStore;
  readonly bus: TelemetryBus;
  readonly tracker: HandTracker;
  readonly recorder = new InputRecorder();
  readonly sessionOriginMs: number;
  gl!: WebGL2RenderingContext;
  private capabilities!: SimContext['capabilities'];
  private gpu = 'unknown';
  private definition!: AnySimulation;
  private instance: SimulationInstance | null = null;
  /** The context object handed to the live instance; its size fields are updated in place on resize. */
  private simContext: SimContext | null = null;
  private params: Record<string, AnyParamValue> = {};
  private signals: Record<string, number> = {};
  private signalViolations: string[] = [];
  private stepper = new FixedStepper(1000 / 60);
  private simTime = 0;
  private source: InputSource | null = null;
  private sourceId: SourceId;
  private sourceGeneration = 0;
  private replayFrames?: ReturnType<typeof parseRecording>;
  private gestureMemory: GestureMemory = emptyGestureMemory();
  private gestureSettings = DEFAULT_GESTURE_SETTINGS;
  private pendingEvents: GestureEvent[] = [];
  private frameEvents: GestureEvent[] = [];
  private lastEvents: GestureEvent[] = [];
  private tracked: TrackedInput = { hands: [], presence: 0, activity: 0, occupancy: null, volume: null, surface: null, sourceAgeMs: Infinity, discarded: 0, stats: {} };
  private rawSamples: { position: { x: number; y: number; z: number }; atMs: number }[] = [];
  private calibration: CalibrationCaptures = {};
  private warnings: HostWarning[] = [];
  private fps = new RateMeter();
  private perf: HostPerf = { fps: 0, stepMs: 0, renderMs: 0, steps: 0, droppedMs: 0 };
  private raf = 0; private running = false; private contextLost = false;
  /** Pending automatic recreate after a simulation failure. */
  private retryTimer?: ReturnType<typeof setTimeout>;
  private recording = false;
  private telemetrySeq = 0;
  private listeners = new Set<() => void>();
  private resizeObserver?: ResizeObserver;
  private lastOccupancyTelemetry: { width: number; height: number; data: string } | undefined;
  private lastOccupancyField: OccupancyField | null = null;

  constructor(readonly root: HTMLElement, readonly video: HTMLVideoElement, settings: SettingsStore, private readonly now: () => number = () => performance.now(), private readonly options: HostOptions = {}) {
    this.settings = settings;
    this.sessionOriginMs = this.now();
    const problems = validateRegistry();
    if (problems.length) throw new Error(`Simulation registry problems:\n${problems.join('\n')}`);
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'sim-stage';
    this.canvas.setAttribute('aria-label', 'Simulation');
    root.appendChild(this.canvas);
    // The bus exists before anything that may warn (GL capability probing does).
    this.bus = new TelemetryBus(settings.value.telemetry.rateHz);
    this.canvas.addEventListener('webglcontextlost', event => { event.preventDefault(); this.contextLost = true; this.warn('WebGL context lost. Waiting for the browser to restore it.'); this.disposeInstance(); });
    this.canvas.addEventListener('webglcontextrestored', () => { invalidateQuadCache(this.gl); this.contextLost = false; this.warn('WebGL context restored.'); this.setupGl(); this.createInstance(); });
    this.setupGl();
    // A persisted 'replay' has no file to replay at launch; fall back to the pointer.
    this.sourceId = settings.value.source === 'replay' ? 'pointer' : settings.value.source;
    this.tracker = new HandTracker(this.mappingFor(this.sourceId), this.trackerSettingsFor(this.sourceId));
    this.gestureSettings = gestureSettingsSchema.parse({ ...DEFAULT_GESTURE_SETTINGS, ...settings.value.gestures });
    this.bus.onInbound(message => {
      if (message.type === 'set-param') this.setParam(message.name, message.value);
      else if (message.type === 'set-params') for (const [name, value] of Object.entries(message.values)) this.setParam(name, value);
      else if (message.type === 'select-sim') { if (!this.selectSimulation(message.id)) this.bus.publishStatus('warning', `Unknown simulation "${message.id}".`); }
    });
    this.configureTelemetry();
    const initial = findSimulation(settings.value.sim) ?? SIMULATIONS[0];
    this.selectSimulation(initial.id);
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.canvas);
  }

  // ------------------------------------------------------------------ setup

  private setupGl() {
    const { gl, capabilities } = createGl(this.canvas);
    this.gl = gl; this.capabilities = capabilities; this.gpu = describeGpu(gl);
    if (!capabilities.halfFloatColor) this.warn('This GPU cannot render to half-float textures; fluid and glow simulations will run with reduced precision.');
  }

  private mappingFor(source: SourceId): SpaceMapping {
    const stored = this.settings.value.mappings[source];
    return stored ? spaceMappingSchema.parse(stored) : defaultMapping(source);
  }

  /** Tracker settings with per-source allowances: webcam inference can legitimately take a few hundred ms. */
  private trackerSettingsFor(source: SourceId) {
    const base = trackerSettingsSchema.parse({ ...DEFAULT_TRACKER_SETTINGS, ...this.settings.value.tracker });
    return source === 'webcam' ? { ...base, maxFrameAgeMs: Math.max(base.maxFrameAgeMs, 600) } : base;
  }

  private disposeInstance() {
    this.output = null;
    const instance = this.instance;
    this.instance = null; this.simContext = null;
    if (instance) { try { instance.dispose(); } catch (error) { console.warn('[sim] dispose failed', error); } }
  }

  private context(): SimContext {
    const { width, height } = this.canvas;
    return { gl: this.gl, canvas: this.canvas, width, height, aspect: width / Math.max(1, height), depth: this.settings.value.volumeDepth, dpr: this.canvas.width / Math.max(1, this.canvas.clientWidth), quality: this.settings.value.quality, capabilities: this.capabilities, warn: message => this.warn(message) };
  }

  private createInstance() {
    this.disposeInstance();
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = undefined; }
    if (this.contextLost) return;
    fitCanvas(this.canvas, this.settings.value.maxDpr, this.settings.value.quality);
    try {
      this.simTime = 0;
      this.stepper = new FixedStepper(1000 / (this.definition.stepHz ?? 60));
      this.simContext = this.context();
      this.instance = this.definition.create(this.simContext, this.params as never);
      this.signals = {}; this.signalViolations = [];
    } catch (error) { this.warn(`Could not start "${this.definition.title}": ${error instanceof Error ? error.message : String(error)}`); }
    this.notify();
  }

  // ------------------------------------------------------------------ public control

  onChange(fn: () => void): () => void { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  private notify() { for (const fn of this.listeners) fn(); }

  warn(message: string) {
    this.warnings.push({ atMs: this.now() - this.sessionOriginMs, message });
    if (this.warnings.length > 30) this.warnings.shift();
    this.bus?.publishStatus('warning', message);
    console.warn(`[sim] ${message}`);
    this.notify();
  }

  get simulation() { return this.definition; }
  get currentParams(): Readonly<Record<string, AnyParamValue>> { return this.params; }

  selectSimulation(id: string): boolean {
    const definition = findSimulation(id);
    if (!definition) return false;
    this.definition = definition;
    this.params = resolveParams(definition.params, this.settings.value.params[id]) as Record<string, AnyParamValue>;
    this.settings.update(s => { s.sim = id; });
    this.createInstance();
    this.bus.publishSchema(this.schema());
    return true;
  }

  setParam(name: string, value: unknown): boolean {
    const spec = this.definition.params[name];
    if (!spec) return false;
    const coerced = coerceParam(spec, value);
    if (coerced === undefined || coerced === this.params[name]) return false;
    this.params[name] = coerced;
    this.settings.update(s => { s.params[this.definition.id] = { ...(s.params[this.definition.id] ?? {}), [name]: coerced }; });
    try { this.instance?.paramChanged?.(name, coerced); } catch (error) { this.warn(`paramChanged(${name}) failed: ${String(error)}`); }
    this.notify();
    return true;
  }

  resetParams() {
    this.params = resolveParams(this.definition.params, undefined) as Record<string, AnyParamValue>;
    this.settings.update(s => { delete s.params[this.definition.id]; });
    for (const [name, value] of Object.entries(this.params)) { try { this.instance?.paramChanged?.(name, value); } catch { /* reported on next change */ } }
    this.notify();
  }

  setQuality(quality: Quality) { this.settings.update(s => { s.quality = quality; }); this.createInstance(); }
  /** The volume's depth in uniform units; instances are rebuilt because they size their worlds from it. */
  setVolumeDepth(depth: number) { this.settings.update(s => { s.volumeDepth = Math.min(3, Math.max(.25, depth)); }); this.createInstance(); }
  setMaxDpr(dpr: number) { this.settings.update(s => { s.maxDpr = Math.min(3, Math.max(.5, dpr)); }); this.resize(true); }
  /** Takes effect on the next step; the instance keeps running since simulations handle any mix of scan and capsules. */
  setSolid(solid: SolidChoice) { this.settings.update(s => { s.solid = solid; }); this.notify(); }

  /** Atomically restore a validated performance configuration without replacing the host or its subscribers. */
  restoreSettings(value: Settings) {
    const settings = settingsSchema.parse(value);
    if (!findSimulation(settings.sim)) throw new Error(`Unknown simulation "${settings.sim}".`);
    const running = this.running; this.stop();
    this.settings.value = settings;
    this.sourceId = settings.source === 'replay' ? 'pointer' : settings.source;
    this.tracker.mapping = this.mappingFor(this.sourceId); this.tracker.settings = this.trackerSettingsFor(this.sourceId); this.tracker.reset();
    this.gestureSettings = gestureSettingsSchema.parse({ ...DEFAULT_GESTURE_SETTINGS, ...settings.gestures });
    this.configureTelemetry(); this.selectSimulation(settings.sim);
    if (running) this.start();
  }

  async setSource(id: SourceId, options: { recording?: string } = {}): Promise<void> {
    if (!SOURCE_IDS.includes(id)) throw new Error(`Unknown source "${id}".`);
    // Keep parsed replay data through pause/resume; the emitter is rebuilt for the new source generation.
    if (id === 'replay') {
      const frames = options.recording ? parseRecording(options.recording) : this.replayFrames;
      if (!frames?.length) throw new Error('Choose a recording file to replay.');
      this.replayFrames = frames;
    } else this.replayFrames = undefined;
    this.output = null;
    const generation = ++this.sourceGeneration;
    this.source?.stop(); this.source = null;
    this.sourceId = id;
    if (id !== 'replay') this.settings.update(s => { s.source = id; }); // a replay cannot be resumed at launch
    this.tracker.mapping = this.mappingFor(id); this.tracker.settings = this.trackerSettingsFor(id); this.tracker.reset();
    this.gestureMemory = emptyGestureMemory(); this.pendingEvents = []; this.rawSamples = []; this.calibration = {};
    const emit = (frame: InputFrame) => { if (generation === this.sourceGeneration) this.ingest(frame); };
    let source: InputSource;
    switch (id) {
      case 'pointer': source = new PointerSource(this.canvas, emit, this.now); break;
      case 'synthetic': source = new SyntheticSource(emit, this.settings.value.synthetic); break;
      case 'webcam': source = new WebcamSource(this.video, emit); break;
      case 'depth': source = new DepthBridgeSource(this.settings.value.depth.url, emit, this.now); break;
      case 'leap': source = new LeapSource(this.settings.value.leap.url, this.settings.value.leap.box, emit, this.now); break;
      case 'replay': {
        source = new ReplaySource(this.replayFrames!, emit); break;
      }
    }
    this.source = source; this.notify();
    try { await source.start(); } catch (error) { this.warn(error instanceof Error ? error.message : String(error)); }
    this.notify();
  }

  setDepthUrl(url: string) { this.settings.update(s => { s.depth.url = url; }); if (this.sourceId === 'depth') void this.setSource('depth'); }
  setLeapOptions(options: Partial<Settings['leap']>) {
    this.settings.update(s => { if (options.url !== undefined) s.leap.url = options.url; if (options.box) s.leap.box = options.box; });
    if (this.sourceId === 'leap') void this.setSource('leap');
  }
  setSyntheticOptions(options: Partial<Settings['synthetic']>) { this.settings.update(s => { Object.assign(s.synthetic, options); }); if (this.sourceId === 'synthetic') void this.setSource('synthetic'); }

  setMapping(mapping: SpaceMapping) {
    const parsed = spaceMappingSchema.parse(mapping);
    this.tracker.mapping = parsed; this.tracker.reset(); this.gestureMemory = emptyGestureMemory();
    this.settings.update(s => { s.mappings[this.sourceId] = parsed; });
    this.notify();
  }
  resetMapping() { this.settings.update(s => { delete s.mappings[this.sourceId]; }); this.setMapping(defaultMapping(this.sourceId)); this.calibration = {}; }

  /** Capture the primary hand's current SOURCE-frame position for calibration. Throws when the hand is not steady. */
  captureCalibration(kind: keyof CalibrationCaptures) {
    const now = this.now();
    const point = stableCapture(this.rawSamples.filter(s => now - s.atMs <= RAW_SAMPLE_WINDOW_MS));
    this.calibration = { ...this.calibration, [kind]: point };
    this.notify();
  }
  applyCalibration() {
    const base = defaultMapping(this.sourceId);
    this.setMapping(calibrateMapping(base, this.calibration));
  }
  clearCalibration() { this.calibration = {}; this.notify(); }

  setTrackerSettings(patch: Partial<typeof DEFAULT_TRACKER_SETTINGS>) {
    this.settings.update(s => { s.tracker = { ...s.tracker, ...patch }; });
    this.tracker.settings = this.trackerSettingsFor(this.sourceId);
    this.notify();
  }
  setGestureSettings(patch: Partial<GestureSettingsLike>) {
    this.settings.update(s => { s.gestures = { ...s.gestures, ...patch }; });
    this.gestureSettings = gestureSettingsSchema.parse({ ...DEFAULT_GESTURE_SETTINGS, ...this.settings.value.gestures });
    this.notify();
  }

  setTelemetry(patch: Partial<Settings['telemetry']>) { this.settings.update(s => { Object.assign(s.telemetry, patch); }); this.configureTelemetry(); this.notify(); }
  private configureTelemetry() {
    const t = this.settings.value.telemetry;
    this.bus.rateHz = t.rateHz;
    this.bus.removeTransport('broadcast'); this.bus.removeTransport('window'); this.bus.removeTransport('websocket');
    if (this.options.externalTelemetry !== false) {
      if (t.broadcast) this.bus.addTransport(new BroadcastTransport());
      if (t.window) this.bus.addTransport(new WindowTransport());
      if (t.websocketUrl) this.bus.addTransport(new WebSocketTransport(t.websocketUrl));
    }
  }

  startRecording() { this.recorder.clear(); this.recording = true; this.notify(); }
  /** Stops and hands back the recording as Blob parts; the recorder's memory is released. */
  stopRecording(): BlobPart[] { this.recording = false; const parts = this.recorder.parts(); this.recorder.clear(); this.notify(); return parts; }

  toggleFullscreen() {
    // The whole document goes fullscreen so the overlay stays reachable for the operator.
    if (document.fullscreenElement) void document.exitFullscreen();
    else void (this.options.fullscreenRoot ?? document.documentElement).requestFullscreen?.().catch(error => this.warn(`Fullscreen refused: ${String(error)}`));
  }

  // ------------------------------------------------------------------ loop

  start() {
    if (this.running) return;
    this.running = true;
    this.setSource(this.sourceId).catch(error => this.warn(error instanceof Error ? error.message : String(error)));
    const tick = () => { if (!this.running) return; this.raf = requestAnimationFrame(tick); this.frame(); };
    this.raf = requestAnimationFrame(tick);
  }
  stop() {
    this.running = false; this.output = null; this.sourceGeneration++;
    cancelAnimationFrame(this.raf); this.source?.stop();
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = undefined; }
  }
  dispose() { this.stop(); this.disposeInstance(); this.bus.close(); this.resizeObserver?.disconnect(); this.settings.flush(); this.listeners.clear(); this.canvas.remove(); }

  private ingest(frame: InputFrame) {
    if (this.recording) this.recorder.add(frame);
    if (this.tracker.ingest(frame) && frame.hands.length) {
      // Calibration samples follow the tracked primary hand when there is one, else the most confident observation.
      const primaryId = this.tracked.hands[0]?.id;
      const hand = frame.hands.find(h => h.id === primaryId) ?? frame.hands.reduce((best, h) => h.confidence > best.confidence ? h : best, frame.hands[0]);
      const now = frame.receivedAtMs;
      this.rawSamples.push({ position: hand.position, atMs: now });
      while (this.rawSamples.length && now - this.rawSamples[0].atMs > RAW_SAMPLE_WINDOW_MS) this.rawSamples.shift();
    }
  }

  private resize(force = false) {
    if (!fitCanvas(this.canvas, this.settings.value.maxDpr, this.settings.value.quality) && !force) return;
    const { width, height } = this.canvas;
    if (this.simContext) { this.simContext.width = width; this.simContext.height = height; this.simContext.aspect = width / Math.max(1, height); this.simContext.dpr = this.canvas.width / Math.max(1, this.canvas.clientWidth); }
    try { this.instance?.resize?.(width, height); } catch (error) { this.warn(`resize failed: ${String(error)}`); }
    this.notify();
  }

  private frame() {
    const now = this.now();
    this.fps.tick(now);
    this.source?.sample?.(now);
    this.tracked = this.tracker.tick(now);
    const gestures = detectGestures(this.gestureMemory, this.tracked.hands, now, this.gestureSettings);
    this.gestureMemory = gestures.memory;
    if (gestures.events.length) { this.pendingEvents.push(...gestures.events); this.frameEvents.push(...gestures.events); }
    if (!this.instance || this.contextLost) {
      // No picture, but input and telemetry keep flowing so the audio side still hears the room;
      // a failed simulation is retried after a pause.
      this.pendingEvents.length = 0;
      if (this.bus.publishFrame(now, () => this.telemetryFrame(now))) { this.lastEvents = this.frameEvents; this.frameEvents = []; }
      if (!this.contextLost && !this.retryTimer) this.retryTimer = setTimeout(() => { this.retryTimer = undefined; this.warn(`Retrying "${this.definition.title}".`); this.createInstance(); }, 5000);
      return;
    }
    this.resize();
    const { hands, volume, surface } = this.simSolid();
    const primary = hands[0] ?? null;
    const stepStart = this.now();
    let stepped = false;
    let result;
    try {
      result = this.stepper.advance(now, dt => {
        this.simTime += dt;
        const input: SimInput = { time: this.simTime, dt, hands, primary, events: stepped ? [] : this.pendingEvents, presence: this.tracked.presence, activity: this.tracked.activity, occupancy: this.tracked.occupancy, volume, surface };
        this.instance!.step(input, this.params as never);
        stepped = true;
      });
    } catch (error) { this.warn(`step failed: ${error instanceof Error ? error.message : String(error)}`); this.disposeInstance(); return; }
    if (stepped) this.pendingEvents = [];
    const stepEnd = this.now();
    try {
      const { width, height } = this.canvas;
      // Render time follows simulation time (plus the fraction of a step not yet simulated) so the two never drift apart.
      this.instance.render({ time: this.simTime + result.alpha * this.stepper.stepMs / 1000, alpha: result.alpha, width, height, aspect: width / Math.max(1, height), depth: this.settings.value.volumeDepth }, this.params as never);
      const clamped = clampSignals(this.definition.signals, this.instance.signals() as Record<string, number>);
      this.signals = clamped.values; this.signalViolations = clamped.violations;
      this.output = { simId: this.definition.id, atMs: now, signals: { ...this.signals }, input: { presence: this.tracked.presence, activity: this.tracked.activity } };
    } catch (error) { this.warn(`render failed: ${error instanceof Error ? error.message : String(error)}`); this.disposeInstance(); return; }
    const renderEnd = this.now();
    this.perf = { fps: this.fps.value, stepMs: this.perf.stepMs + .1 * (stepEnd - stepStart - this.perf.stepMs), renderMs: this.perf.renderMs + .1 * (renderEnd - stepEnd - this.perf.renderMs), steps: result.steps, droppedMs: result.droppedMs };
    if (this.bus.publishFrame(now, () => this.telemetryFrame(now))) { this.lastEvents = this.frameEvents; this.frameEvents = []; }
  }

  /**
   * The solid the simulation sees this frame, per the `solid` setting. Hands are copied, never
   * mutated: the tracker's state (and telemetry, which reads it) keeps the full description.
   */
  private simSolid(): { hands: HandState[]; volume: TrackedInput['volume']; surface: TrackedInput['surface'] } {
    const t = this.tracked, solid = this.settings.value.solid;
    if (solid === 'scan') return { hands: t.hands.map(h => h.capsules.length ? { ...h, capsules: [] } : h), volume: t.volume, surface: t.surface };
    if (solid === 'skeleton') return { hands: t.hands, volume: null, surface: null };
    return { hands: t.hands, volume: t.volume, surface: t.surface };
  }

  // ------------------------------------------------------------------ telemetry

  schema(): TelemetrySchema {
    return {
      type: 'schema', v: 1,
      sim: { id: this.definition.id, title: this.definition.title, description: this.definition.description, params: this.definition.params, signals: this.definition.signals },
      sims: SIMULATIONS.map(s => ({ id: s.id, title: s.title })),
      input: { hand: ['id', 'x', 'y', 'z', 'vx', 'vy', 'vz', 'speed', 'radius', 'openness', 'pinch', 'push', 'ageMs', 'staleMs', 'solid'], gestures: GESTURE_TYPES, sources: SOURCE_IDS },
    };
  }

  private telemetryFrame(now: number): TelemetryFrame {
    const hands: HandTelemetry[] = this.tracked.hands.map(h => handTelemetry(h));
    let occupancy: TelemetryFrame['input']['occupancy'];
    if (this.settings.value.telemetry.occupancy && this.tracked.occupancy) {
      if (this.tracked.occupancy !== this.lastOccupancyField) { this.lastOccupancyField = this.tracked.occupancy; this.lastOccupancyTelemetry = { width: this.tracked.occupancy.width, height: this.tracked.occupancy.height, data: encodeOccupancy(this.tracked.occupancy) }; }
      occupancy = this.lastOccupancyTelemetry;
    }
    return {
      type: 'frame', v: 1, t: (now - this.sessionOriginMs) / 1000, seq: this.telemetrySeq++,
      sim: { id: this.definition.id, params: { ...this.params }, signals: { ...this.signals } },
      input: { source: this.sourceId, presence: this.tracked.presence, activity: this.tracked.activity, hands, events: this.frameEvents.slice(), sourceAgeMs: Number.isFinite(this.tracked.sourceAgeMs) ? Math.round(this.tracked.sourceAgeMs) : -1, stats: this.tracked.stats, occupancy },
      perf: { fps: Math.round(this.perf.fps), stepMs: round(this.perf.stepMs), renderMs: round(this.perf.renderMs) },
    };
  }

  state(): HostState {
    return {
      simulation: this.definition, params: this.params, signals: this.signals, signalViolations: this.signalViolations,
      source: this.source, sourceId: this.sourceId, tracked: this.tracked, events: this.lastEvents, mapping: this.tracker.mapping, calibration: this.calibration,
      perf: this.perf, warnings: this.warnings, gpu: this.gpu, dpr: this.canvas.width / Math.max(1, this.canvas.clientWidth), width: this.canvas.width, height: this.canvas.height,
      quality: this.settings.value.quality, solid: this.settings.value.solid, recording: { active: this.recording, frames: this.recorder.length },
      telemetry: { sent: this.bus.sent, rateHz: this.bus.rateHz, transports: this.bus.transportStatus() }, contextLost: this.contextLost,
    };
  }
}

function handTelemetry(h: HandState): HandTelemetry {
  return { id: h.id, x: round(h.position.x), y: round(h.position.y), z: round(h.position.z), vx: round(h.velocity.x), vy: round(h.velocity.y), vz: round(h.velocity.z), speed: round(h.speed), radius: round(h.radius), openness: round(h.openness), pinch: round(h.pinch), push: round(h.push), ageMs: Math.round(h.ageMs), staleMs: Math.round(h.staleMs), solid: h.capsules.length };
}
const round = (v: number) => Math.round(v * 1000) / 1000;
