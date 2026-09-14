import './style.css';
import { edgeApprovalError, sceneApprovalError, sha256, stableJson, validateManifest, type Manifest, type RecipeId } from './config';
import { loadAssets, localReader, urlReader, type LoadedAssets, type ReadMedia } from './audio/assets';
import { AudioEngine, LateSubmissionError } from './audio/engine';
import { allAuditions, auditionPlan, encodeWav, renderEventPlan, type Audition, type RenderedAudio } from './audio/offline';
import { CameraAdapter } from './control/camera';
import { calibrate, stableCapture } from './control/conditioning';
import { RawReplayAdapter, replayRawControl } from './control/replay';
import { SliderAdapter } from './control/slider';
import type { Adapter, MappingMode } from './control/types';
import { edgeKey, type PlannerEnvironment, type ResponseTiming } from './music/planner';
import { PerformanceSession, type SessionInput } from './music/session';
import { TraceRecorder, download, parseTrace, type TraceRecord } from './trace';
import { button, element, escapeHtml, input, mount, readEditor, renderEditor, select } from './ui/controls';
import { diagnostics, renderStemMeters } from './ui/diagnostics';
import { LibraryWorkspace } from './library/workspace';
import { preparedCollection } from './library/prepared';
import { mountPerformance, updatePerformance, vocalChoices } from './ui/performance';
import { SpacePanel, type PlayMode } from './ui/space';
import { SimulationPanel } from './ui/simulation';
import { analyzeActivity } from './audio/activity';

mount();
mountPerformance();
const context = new AudioContext({ latencyHint: 'interactive' });
let manifest: Manifest, assets: LoadedAssets, reader: ReadMedia, engine: AudioEngine, session: PerformanceSession, trace: TraceRecorder;
let loading = false, authoring = true, timer: ReturnType<typeof setInterval> | undefined, lastScene = '', loadGeneration = 0;
let engineering = false;
let previewSource: AudioBufferSourceNode | undefined, renderedPreview: RenderedAudio | undefined;
let cases: Audition[] = [], rendering = false, cancelRendering = false;
let measurements: Record<string, unknown> | undefined;
let importedTrace: TraceRecord[] | undefined, replay: RawReplayAdapter | undefined;
let low: number | undefined, high: number | undefined;
const slider = new SliderAdapter();
const camera = new CameraAdapter(element<HTMLVideoElement>('video'), frame => { if (session?.source === 'camera') dispatch({ type: 'frame', frame }, frame.receivedAtMs); }, message => setText('camera-status', message));
const spacePanel = new SpacePanel(state => dispatch({ type: 'space', state }), enabled => {
  if (enabled && session) { switchAdapter('slider'); dispatch({ type: 'mode', mode: 'timbre_only' }); dispatch({ type: 'hold', enabled: false }); }
});
const simulationPanel = new SimulationPanel();
const launch = new URLSearchParams(location.search);
const requestedMode = launch.get('play');
let playMode: PlayMode = requestedMode === 'space' || requestedMode === 'manual' || requestedMode === 'simulation'
  ? requestedMode : launch.get('fixtures') === '1' ? 'manual' : 'simulation';
let lastSimulationState = '';
function setPlayMode(mode: PlayMode) {
  playMode = mode; lastSimulationState = '';
  spacePanel.setEnabled(mode === 'space', mode);
  if (mode === 'simulation') {
    camera.stop();
    if (session) { switchAdapter('slider'); dispatch({ type: 'mode', mode: 'timbre_only' }); dispatch({ type: 'hold', enabled: false }); }
    dispatch({ type: 'space', state: simulationPanel.sample(performance.now(), session?.state.running ?? false) });
  }
  simulationPanel.setActive(mode === 'simulation');
}
select('play-mode').onchange = () => setPlayMode(select('play-mode').value as PlayMode);
const library = new LibraryWorkspace(context, {
  beforeAudition: () => { if (session?.state.running) dispatch({ type: 'stop' }); stopPreview(); },
  loadPerformance: async (config, media, edge) => {
    if (session?.state.running) dispatch({ type: 'stop' });
    await load(config, media, true); library.show('instrument');
    if (edge) {
      library.show('setup'); element<HTMLDetailsElement>('setup-authoring').open = true;
      const index = cases.findIndex(c => c.kind === 'scene-transition' && `${c.from}→${c.to}` === edge);
      if (index >= 0) select('audition-case').value = String(index);
      element('author-panel').scrollIntoView({ behavior: 'smooth' });
    }
  }, error: showError, playbackChanged: () => updateAvailability(),
});
function setText(id: string, text: string) { element(id).textContent = text; }
function showError(error?: unknown) {
  const box = element('error'); box.hidden = !error; box.textContent = error ? error instanceof Error ? error.message : String(error) : '';
  if (error && trace) trace.add('error', performance.now(), { message: box.textContent });
}
function environment(): PlannerEnvironment {
  return { sampleRate: context.sampleRate, manifest, scenes: Object.fromEntries(Object.entries(assets.scenes).map(([id, loaded]) => [id, { duration: loaded.duration, error: authoring ? undefined : sceneApprovalError(loaded.scene, loaded.fingerprint) }])), edgeErrors: Object.fromEntries(manifest.edges.map(edge => [edgeKey(edge.from, edge.to), authoring ? undefined : edgeApprovalError(edge, assets.edgeFingerprints[edgeKey(edge.from, edge.to)])])) };
}
function newTrace() {
  importedTrace = undefined;
  select('adapter').value = session.source; select('mapping').value = session.mode;
  input('hold').checked = session.holdEnabled; input('bypass').checked = session.filterBypass; input('metronome').checked = session.metronome;
  select('response-timing').value = session.state.timing ?? 'authored'; input('playback-rate').value = String(session.state.desiredRate ?? 1);
  engine.setBypass(session.filterBypass); engine.metronome = session.metronome;
  if (session.source !== 'camera') { camera.stop(); element('camera-panel').hidden = true; }
  trace = new TraceRecorder(session.originMs, { configFingerprint: assets.fingerprint, inputMode: session.source, sampleRate: context.sampleRate, authoring, readiness: session.environment.scenes, edgeErrors: session.environment.edgeErrors });
  trace.add('clock-map', performance.now(), { audioTime: context.currentTime, generation: session.state.generation });
  spacePanel.reset(); setPlayMode(playMode);
  if (!engineering) {
    dispatch({ type: 'timing', timing: 'beat' });
    dispatch({ type: 'mode', mode: 'timbre_only' });
    if (session.source === 'slider') { slider.value = .75; input('openness').value = '.75'; const now = performance.now(); dispatch({ type: 'frame', frame: slider.sample(now) }, now); }
  }
}
function stopPreview() { if (previewSource) { try { previewSource.stop(); } catch { /* already ended */ } previewSource.disconnect(); previewSource = undefined; } }
async function refreshFingerprint() {
  assets.fingerprint = await sha256(stableJson({ manifest, fingerprints: Object.fromEntries(Object.entries(assets.scenes).map(([id, s]) => [id, s.fingerprint])) }));
  session = new PerformanceSession(environment(), performance.now()); switchAdapter('slider'); newTrace();
  library.syncPerformance(manifest);
}
function guardStopped() { if (session?.state.running || loading || rendering) throw new Error('Stop playback and wait for loading/rendering before editing.'); }
function handle(id: string, action: () => void | Promise<void>) {
  button(id).onclick = () => { showError(); Promise.resolve().then(action).catch(showError); };
}
function updateAvailability() {
  const running = session?.state.running ?? false, blocked = !session || !!session.environment.scenes[authoring ? select('edit-scene').value : manifest.path[0]]?.error;
  button('start').disabled = loading || rendering || running || blocked;
  button('stop').disabled = !running;
  button('stop-all').disabled = !running && !library.auditioning && !previewSource;
  const endOfPath = session && !manifest.repeatPath && manifest.path.indexOf(session.state.sceneId) === manifest.path.length - 1;
  button('next').disabled = !running || !!endOfPath || !!session?.state.pendingAdvance || !!session?.state.committedAdvance;
  select('performance-scene').disabled = running || loading || rendering || !authoring;
  input('authoring').disabled = running || loading || rendering;
  element<HTMLFieldSetElement>('author-fields').disabled = running || loading || rendering;
  select('edit-scene').disabled = running || loading || rendering;
  input('folder').disabled = input('manifest-file').disabled = running || loading || rendering;
  button('load-fixtures').disabled = button('load-prepared').disabled = running || loading || rendering;
  button('cancel-render').disabled = !rendering;
  // Cancel remains available while the rest of the authoring form is disabled.
  if (rendering) { element<HTMLFieldSetElement>('author-fields').disabled = false; element('author-fields').querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('button,input,select,textarea').forEach(n => n.disabled = n.id !== 'cancel-render'); }
  else element('author-fields').querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('button,input,select,textarea').forEach(n => n.disabled = false);
  button('cancel-render').disabled = !rendering; button('report-export').disabled = !measurements; button('download-preview').disabled = !renderedPreview;
  button('replay-start').disabled = !importedTrace || running || loading || rendering;
  button('replay-verify').disabled = !importedTrace || loading || rendering;
  simulationPanel.updateTransport();
}
function updateScene() {
  const id = session.state.running ? session.state.sceneId : authoring ? select('edit-scene').value || manifest.path[0] : manifest.path[0], loaded = assets.scenes[id];
  if (!loaded) return;
  setText('scene-name', loaded.scene.label);
  setText('scene-meta', `Passage ${manifest.path.indexOf(id) + 1} of ${manifest.path.length} · ${(session.state.running ? session.state.clock.duration : loaded.duration / (session.state.desiredRate ?? 1)).toFixed(1)}-second loop${authoring ? ' · draft for listening' : ''}`);
  select('performance-scene').value = id;
  setText('context-state', library.auditioning ? 'Previewing selection' : previewSource ? 'Playing audio check' : session.state.running ? 'Audio running' : 'Ready to play');
  updatePerformance(session, loaded.scene, context.currentTime);
  spacePanel.showActivity(loaded);
  if (lastScene !== id) { lastScene = id; renderStemMeters(engine, id); }
}
function updateApproval() {
  const errors = [...Object.entries(assets.scenes).map(([, a]) => sceneApprovalError(a.scene, a.fingerprint)), ...manifest.edges.map(e => edgeApprovalError(e, assets.edgeFingerprints[edgeKey(e.from, e.to)]))].filter(Boolean);
  setText('approval-status', authoring ? `AUTHORING · ${errors.length ? `${errors.length} reviews incomplete or stale` : 'all reviews current'}` : errors.length ? `Performance gate · ${errors[0]}` : 'PERFORMANCE · approved scenes and path');
  element('author-panel').hidden = !authoring;
}
function refreshEditor() {
  const scene = manifest.scenes.find(s => s.id === select('edit-scene').value)!;
  renderEditor(scene, manifest); updateScene(); updateAvailability();
}
function refreshEdge() {
  const edge = manifest.edges[Number(select('edit-edge').value)]; input('edge-notes').value = edge?.notes ?? ''; input('review-edge').checked = false;
}
function populate() {
  const old = select('edit-scene').value;
  select('edit-scene').innerHTML = manifest.path.map(id => `<option value="${escapeHtml(id)}">${escapeHtml(assets.scenes[id].scene.label)}</option>`).join('');
  if (assets.scenes[old]) select('edit-scene').value = old;
  select('performance-scene').innerHTML = select('edit-scene').innerHTML;
  select('edit-edge').innerHTML = manifest.edges.map((e, i) => `<option value="${i}">${escapeHtml(e.from)} → ${escapeHtml(e.to)}</option>`).join('');
  cases = allAuditions(manifest);
  select('audition-case').innerHTML = cases.map((c, i) => `<option value="${i}">${escapeHtml(c.kind === 'scene-transition' ? `${c.from} ${c.outgoing} → ${c.to} ${c.incoming}` : c.kind === 'recipe-transition' ? `${c.sceneId}: ${c.from} → ${c.to}, boundary ${c.bar}` : `${c.sceneId}: ${c.kind} / ${c.recipe}`)}</option>`).join('');
  setText('collection', manifest.label); setText('memory', `${(assets.decodedBytes / 1024 / 1024).toFixed(1)} MiB decoded · ${context.sampleRate.toLocaleString()} Hz`);
  element('empty-state').hidden = true;
  element('content-notice').hidden = !engineering;
  setText('content-notice', 'Engineering tones are loaded. These are sine-tone test signals, not musical passages. Load prepared music to return to the song.');
  refreshEditor(); refreshEdge(); updateApproval();
}
async function load(inputManifest: unknown, mediaReader: ReadMedia, mode: boolean) {
  guardStopped(); const candidate = validateManifest(inputManifest), generation = ++loadGeneration;
  loading = true; simulationPanel.setSuspended(true); stopPreview(); camera.stop(); spacePanel.disconnect(); if (timer) clearInterval(timer); updateAvailability();
  try {
    const loaded = await loadAssets(context, candidate, mediaReader, message => setText('load-status', message));
    if (generation !== loadGeneration) return;
    // Do this while stopped/loading, never on the timing-critical passage-change tick.
    for (const scene of Object.values(loaded.scenes)) analyzeActivity(scene);
    engine?.dispose(); manifest = candidate; assets = loaded; reader = mediaReader; authoring = mode; input('authoring').checked = authoring;
    engineering = manifest.scenes.every(scene => scene.id.startsWith('fixture_'));
    engine = new AudioEngine(context, manifest, assets); session = new PerformanceSession(environment(), performance.now());
    select('adapter').value = 'slider'; select('mapping').value = 'combined'; input('hold').checked = input('bypass').checked = input('metronome').checked = false;
    element('camera-panel').hidden = true; replay = undefined; lastScene = ''; renderedPreview = undefined; measurements = undefined;
    newTrace(); populate(); library.syncPerformance(manifest); setText('load-status', 'Ready · all synchronized stems decoded'); showError();
  } catch (error) { setText('load-status', 'Load failed · previous collection retained if available'); throw error; }
  finally { loading = false; simulationPanel.setSuspended(false); if (session) timer = setInterval(tick, manifest.control.schedulerIntervalMs); updateAvailability(); }
}
function dispatch(inputEvent: SessionInput, at = performance.now(), audio = context.currentTime) {
  if (!session) return;
  const previous = session.state;
  trace.input(inputEvent, at, audio);
  const actions = session.dispatch(inputEvent, at, audio);
  engine.setSpace(session.space, audio);
  if (inputEvent.type === 'stop') spacePanel.reset();
  if (inputEvent.type === 'bypass') { engine.setBypass(session.filterBypass); input('bypass').checked = session.filterBypass; }
  if (inputEvent.type === 'metronome') { engine.metronome = session.metronome; input('metronome').checked = session.metronome; }
  if (inputEvent.type === 'timing') select('response-timing').value = session.state.timing ?? 'authored';
  if (inputEvent.type === 'rate') input('playback-rate').value = String(session.state.desiredRate ?? 1);
  if (inputEvent.type === 'mode') select('mapping').value = session.mode;
  if (inputEvent.type === 'hold') input('hold').checked = session.holdEnabled;
  try {
    for (const action of actions) { engine.execute(action); trace.add('committed-action', at, { action, audioTime: audio }); }
  } catch (error) {
    session.state = error instanceof LateSubmissionError ? { ...previous, error: error.message } : { ...previous, pendingAdvance: null, pendingRecipe: null, error: String(error) }; showError(error);
    trace.add('scheduling-error', at, { message: String(error), generation: previous.generation });
  }
  if (session.state.desiredRecipe !== previous.desiredRecipe) trace.add('desired', at, { recipe: session.state.desiredRecipe, source: session.state.desiredSource });
  if (session.conditioned.discarded && inputEvent.type === 'frame') trace.add('discarded-data', at, { reason: session.conditioned.discarded, sequence: inputEvent.frame.sequence });
  if (stableJson([session.state.pendingRecipe, session.state.pendingAdvance]) !== stableJson([previous.pendingRecipe, previous.pendingAdvance])) trace.add('tentative', at, { recipe: session.state.pendingRecipe, advance: session.state.pendingAdvance });
  if (session.state.clock.start !== previous.clock.start) trace.add('scene-origin', at, { sceneId: session.state.sceneId, clock: session.state.clock, generation: session.state.generation });
  if (session.state.error && session.state.error !== previous.error) showError(session.state.error);
  engine.continuous(session.timbre);
  updateAvailability();
}
function tick() {
  if (!session || loading) return;
  // The legacy panel may emit controls using its own current timestamp. Capture the tick clock afterward.
  if (playMode !== 'simulation' || session.source === 'replay') spacePanel.tick(engine, session.state.running, session.source === 'replay' ? session.space : undefined);
  const now = performance.now();
  if (playMode === 'simulation' && session.source !== 'replay') {
    const state = simulationPanel.sample(now, session.state.running), key = JSON.stringify(state);
    if (key !== lastSimulationState) { lastSimulationState = key; dispatch({ type: 'space', state }, now); }
  }
  if (session.source === 'slider') dispatch({ type: 'frame', frame: slider.sample(now) }, now);
  if (session.source === 'replay' && replay) {
    for (const event of replay.due(now)) dispatch(event.type === 'frame' ? { ...event, frame: { ...event.frame, receivedAtMs: now } } : event, now);
    if (replay.done) { replay = undefined; setText('replay-status', 'Raw replay finished. Last state held; Stop ends playback.'); }
  }
  dispatch({ type: 'tick' }, now); engine.collect(); engine.tickMetronome(session.state, context.currentTime);
  diagnostics(session, engine, context.currentTime); updateScene();
  setText('trace-state', `${trace.records.length.toLocaleString()} records${trace.dropped ? ` · ${trace.dropped} omitted (limit reached)` : ''}`);
  drawLandmarks();
}
function drawLandmarks() {
  if (session.source !== 'camera') return;
  const canvas = element<HTMLCanvasElement>('landmarks'), ctx = canvas.getContext('2d')!; ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (session.conditioned.ageMs > manifest.control.maxFrameAgeMs) return;
  ctx.fillStyle = '#b9ec80'; ctx.strokeStyle = '#b9ec80'; ctx.lineWidth = 3;
  for (const p of camera.landmarks) { ctx.beginPath(); ctx.arc(p.x * canvas.width, p.y * canvas.height, 4, 0, Math.PI * 2); ctx.fill(); }
  if (camera.landmarks[9]) { ctx.beginPath(); ctx.moveTo(camera.landmarks[0].x * canvas.width, camera.landmarks[0].y * canvas.height); ctx.lineTo(camera.landmarks[9].x * canvas.width, camera.landmarks[9].y * canvas.height); ctx.stroke(); }
}
async function startAudio() { library.stopAudition(); stopPreview(); await context.resume(); trace.add('clock-map', performance.now(), { audioTime: context.currentTime, generation: session.state.generation + 1 }); dispatch({ type: 'start', sceneId: authoring ? select('edit-scene').value : manifest.path[0] }); }
handle('start', startAudio);
handle('stop-all', () => { replay = undefined; if (session) dispatch({ type: 'stop' }); library.stopAudition(); stopPreview(); updateAvailability(); });
handle('stop', () => { replay = undefined; dispatch({ type: 'stop' }); stopPreview(); });
handle('next', () => dispatch({ type: 'advance' })); handle('cancel', () => dispatch({ type: 'cancel' }));
handle('vocal-toggle', () => {
  const s = session.state, scene = assets.scenes[s.sceneId]?.scene;
  if (!s.running || !scene) return;
  const { instrumental, vocal } = vocalChoices(scene);
  if (!instrumental || !vocal) return;
  const desired = s.recipeIntent ? s.desiredRecipe : s.committedRecipe?.recipe ?? s.currentRecipe;
  dispatch({ type: 'recipe', recipe: scene.recipes[desired].vocals == null ? vocal : instrumental });
});
document.querySelectorAll<HTMLButtonElement>('[data-recipe]').forEach(b => b.onclick = () => dispatch({ type: 'recipe', recipe: b.dataset.recipe as RecipeId }));
input('openness').oninput = () => { const value = Number(input('openness').value); if (session?.source !== 'slider') switchAdapter('slider'); slider.value = value; input('openness').value = String(value); };
function switchAdapter(source: Adapter) {
  if (!session) return;
  if (source !== 'slider' && playMode === 'simulation') setPlayMode('manual');
  if (source !== 'camera') camera.stop();
  if (source !== 'replay') replay = undefined;
  if (source === 'slider') { slider.value = session.conditioned.smooth; input('openness').value = String(slider.value); }
  select('adapter').value = source; element('camera-panel').hidden = source !== 'camera'; dispatch({ type: 'adapter', source });
}
select('adapter').onchange = () => switchAdapter(select('adapter').value as Adapter);
select('mapping').onchange = () => dispatch({ type: 'mode', mode: select('mapping').value as MappingMode });
input('hold').onchange = () => dispatch({ type: 'hold', enabled: input('hold').checked });
input('bypass').onchange = () => dispatch({ type: 'bypass', enabled: input('bypass').checked });
input('metronome').onchange = () => dispatch({ type: 'metronome', enabled: input('metronome').checked });
handle('camera-start', async () => { switchAdapter('camera'); await camera.start(); });
handle('camera-stop', () => { camera.stop(); setText('camera-status', 'Camera stopped. Playback continues with tracking-loss fallback.'); });
function capture(which: 'low' | 'high') {
  const samples = camera.samples.filter(s => performance.now() - s.at < 750);
  const angle = stableCapture(samples);
  if (which === 'low') low = angle; else high = angle;
  camera.calibration = null; dispatch({ type: 'calibration' });
  if (low !== undefined && high !== undefined) { camera.calibration = calibrate(low, high); setText('calibration', `Calibrated · ${Math.abs(camera.calibration.high - camera.calibration.low) * 180 / Math.PI | 0}° sweep. Hold low to rearm advancement.`); }
  else setText('calibration', `${which} captured. Capture the other endpoint.`);
}
handle('cal-low', () => capture('low')); handle('cal-high', () => capture('high'));
handle('load-fixtures', async () => { const url = new URL('/fixtures/manifest.json', location.href); const response = await fetch(url); if (!response.ok) throw new Error('Generate fixtures with npm run fixtures.'); await load(await response.json(), urlReader(url.href), true); library.show('instrument'); });
input('folder').onchange = async () => {
  try { const files = Array.from(input('folder').files ?? []), manifests = files.filter(f => f.name.endsWith('.json'));
    const preferred = manifests.filter(f => /^(manifest|scene_manifest)(\.local)?\.json$/.test(f.name));
    const file = preferred.length === 1 ? preferred[0] : manifests.length === 1 ? manifests[0] : undefined;
    if (!file) throw new Error('Select a folder with one manifest.json and its synchronized WAV files.');
    await load(JSON.parse(await file.text()), localReader(files), false);
  } catch (error) { showError(error); } finally { input('folder').value = ''; }
};
input('manifest-file').onchange = async () => {
  try { const file = input('manifest-file').files?.[0]; if (!file) return;
    await load(JSON.parse(await file.text()), urlReader(new URL('/scenes/', location.href).href), false);
  } catch (error) { showError(error); } finally { input('manifest-file').value = ''; }
};
input('authoring').onchange = () => {
  try { guardStopped(); authoring = input('authoring').checked; session = new PerformanceSession(environment(), performance.now()); newTrace(); updateApproval(); updateAvailability(); }
  catch (error) { showError(error); }
};
select('edit-scene').onchange = refreshEditor; select('edit-edge').onchange = refreshEdge;
select('response-timing').onchange = () => dispatch({ type: 'timing', timing: select('response-timing').value as ResponseTiming });
input('playback-rate').oninput = () => dispatch({ type: 'rate', rate: Number(input('playback-rate').value) });
handle('rate-reset', () => dispatch({ type: 'rate', rate: 1 }));
select('performance-scene').onchange = () => { select('edit-scene').value = select('performance-scene').value; refreshEditor(); };
handle('apply-editor', async () => { guardStopped(); await load(readEditor(manifest.scenes.find(s => s.id === select('edit-scene').value)!, manifest), reader, true); });
handle('apply-json', async () => { guardStopped(); await load(JSON.parse(element<HTMLTextAreaElement>('manifest-editor').value), reader, true); });
handle('approve-scene', async () => {
  guardStopped(); if (!input('review-scene').checked) throw new Error('Confirm the listening review before saving approval.');
  const scene = manifest.scenes.find(s => s.id === select('edit-scene').value)!;
  const draft = validateManifest(readEditor(scene, manifest));
  if (stableJson({ ...draft, scenes: draft.scenes.map(s => ({ ...s, approval: {} })) }) !== stableJson({ ...manifest, scenes: manifest.scenes.map(s => ({ ...s, approval: {} })) })) throw new Error('Apply and revalidate playback edits, then audition them before approving.');
  scene.approval = { recipes: true, recipeTransitions: true, loopSeam: true, filterRange: true, reviewedFingerprint: assets.scenes[scene.id].fingerprint, notes: element<HTMLTextAreaElement>('scene-notes').value };
  await refreshFingerprint();
  updateApproval(); refreshEditor(); setText('load-status', 'Scene approval saved in memory. Export configuration to keep it.');
});
handle('approve-edge', async () => {
  guardStopped(); if (!input('review-edge').checked) throw new Error('Confirm all nine edge combinations before approving.');
  const edge = manifest.edges[Number(select('edit-edge').value)]; if (!edge) throw new Error('No edge selected.');
  for (const id of [edge.from, edge.to]) { const a = assets.scenes[id], error = sceneApprovalError(a.scene, a.fingerprint); if (error) throw new Error(`Approve both scenes first. ${error}`); }
  edge.approved = true; edge.notes = input('edge-notes').value; edge.reviewedFingerprint = assets.edgeFingerprints[edgeKey(edge.from, edge.to)];
  await refreshFingerprint();
  updateApproval(); refreshEdge(); element<HTMLTextAreaElement>('manifest-editor').value = JSON.stringify(manifest, null, 2); setText('load-status', 'Edge approval saved in memory. Export configuration to keep it.');
});
handle('config-export', () => download('manifest.json', JSON.stringify(manifest, null, 2) + '\n'));
handle('trace-export', () => download('livemixer-trace.jsonl', trace.jsonl(), 'application/x-ndjson'));
input('trace-file').onchange = async () => {
  try { const file = input('trace-file').files?.[0]; if (!file) return; const records = parseTrace(await file.text());
    if (records[0].configFingerprint !== assets.fingerprint) throw new Error('Trace configuration fingerprint differs from the loaded collection. Load the exact configuration and media.');
    importedTrace = records; updateAvailability(); setText('replay-status', `Loaded ${records.length.toLocaleString()} trace records.`);
  } catch (error) { showError(error); } finally { input('trace-file').value = ''; }
};
handle('replay-start', async () => {
  guardStopped(); if (!importedTrace) return; library.stopAudition(); stopPreview(); await context.resume(); dispatch({ type: 'stop' }); switchAdapter('replay'); replay = new RawReplayAdapter(importedTrace, performance.now());
  setText('replay-status', 'Playing raw-control replay. Live structural timing follows the current audio clock.');
});
handle('replay-verify', () => {
  if (!importedTrace) return;
  const env = { ...environment(), scenes: importedTrace[0].readiness as PlannerEnvironment['scenes'], edgeErrors: importedTrace[0].edgeErrors as PlannerEnvironment['edgeErrors'] };
  const result = replayRawControl(importedTrace, env), recorded = importedTrace.filter(r => r.type === 'committed-action').map(r => r.action);
  if (stableJson(result.actions.map(a => a.action)) !== stableJson(recorded)) throw new Error('Decision replay differs from the recorded event plan. See trace errors and timing metadata.');
  setText('replay-status', `Deterministic raw-control verification passed: ${recorded.length} identical audio actions using the recorded timing simulation.`);
});
handle('render-preview', async () => {
  guardStopped(); library.stopAudition(); stopPreview(); await context.resume(); rendering = true; updateAvailability();
  try {
    const audition = cases[Number(select('audition-case').value)], plan = auditionPlan(manifest, assets, audition);
    setText('audition-status', 'Rendering audition…');
    renderedPreview = await renderEventPlan(manifest, assets, plan.events, plan.duration, context.sampleRate);
    previewSource = context.createBufferSource(); previewSource.buffer = renderedPreview.buffer; previewSource.connect(context.destination); previewSource.start(context.currentTime + .05, plan.focusAt);
    const activePreview = previewSource; activePreview.onended = () => { if (previewSource === activePreview) { activePreview.disconnect(); previewSource = undefined; updateAvailability(); } };
    setText('audition-status', `Audition playing · sample peak ${renderedPreview.peakDbfs.toFixed(2)} dBFS · ${renderedPreview.nonfinite} nonfinite samples. WAV export contains the full render.`);
  } finally { rendering = false; updateAvailability(); }
});
handle('stop-preview', stopPreview); handle('download-preview', () => { if (renderedPreview) download('livemixer-audition.wav', encodeWav(renderedPreview.buffer)); });
handle('render-all', async () => {
  guardStopped(); stopPreview(); rendering = true; cancelRendering = false; updateAvailability();
  const results: Record<string, unknown>[] = [];
  try {
    for (let i = 0; i < cases.length && !cancelRendering; i++) {
      setText('render-status', `Rendering ${i + 1}/${cases.length}…`);
      const plan = auditionPlan(manifest, assets, cases[i]), result = await renderEventPlan(manifest, assets, plan.events, plan.duration, context.sampleRate);
      results.push({ audition: cases[i], peakDbfs: result.peakDbfs, peak: result.peak, nonfinite: result.nonfinite, passed: result.nonfinite === 0 && result.peakDbfs < -1 });
      await new Promise<void>(resolve => setTimeout(resolve, 0));
    }
    measurements = { configFingerprint: assets.fingerprint, sampleRate: context.sampleRate, browser: navigator.userAgent, platform: navigator.platform, completed: !cancelRendering && results.length === cases.length, criterion: 'Sample peak below -1 dBFS and no nonfinite samples; not true peak or musical approval', results };
    const failures = results.filter(r => !r.passed).length;
    setText('render-status', `${cancelRendering ? 'Canceled' : 'Complete'} · ${results.length}/${cases.length} cases · ${failures} failed · highest sample peak ${Math.max(...results.map(r => r.peakDbfs as number)).toFixed(2)} dBFS. Export measurements to retain this result.`);
  } finally { rendering = false; updateAvailability(); }
});
handle('cancel-render', () => { cancelRendering = true; }); handle('report-export', () => { if (measurements) download('acceptance-measurements.json', JSON.stringify(measurements, null, 2)); });
context.onstatechange = () => {
  setText('context-state', `Audio ${context.state}`);
  if (session && context.state !== 'running' && session.state.running) { dispatch({ type: 'stop' }); showError('Audio context was suspended. Transport stopped; Start audio establishes a fresh clock mapping.'); }
};
document.addEventListener('visibilitychange', () => {
  if (document.hidden && playMode === 'simulation') {
    lastSimulationState = '';
    dispatch({ type: 'space', state: simulationPanel.sample(performance.now(), session?.state.running ?? false) });
  }
});
window.addEventListener('pagehide', () => { simulationPanel.dispose(); spacePanel.dispose(); camera.stop(); library.stopAudition(); engine?.dispose(); stopPreview(); if (timer) clearInterval(timer); void context.close(); });
async function openInitialCollection() {
  let prepared = preparedCollection(location.search);
  const fixtures = new URLSearchParams(location.search).get('fixtures') === '1';
  if (!prepared && !fixtures) {
    const response = await fetch('/scenes/default.local.json');
    if (response.ok && response.headers.get('content-type')?.includes('application/json')) {
      const config: unknown = await response.json();
      if (!config || typeof config !== 'object' || !('collection' in config) || typeof config.collection !== 'string') throw new Error('Invalid default collection. Choose music in Library & mix builder.');
      prepared = preparedCollection(`?collection=${encodeURIComponent(config.collection)}`);
    } else if (!response.ok && response.status !== 404) throw new Error(`Could not load local music: HTTP ${response.status}`);
    if (!prepared) { element('empty-state').hidden = false; setText('collection', 'Choose your music'); setText('load-status', 'Open Library & mix builder to begin.'); return; }
  }
  const base = new URL(prepared ?? '/fixtures/', location.href);
  const open = async () => {
    const url = new URL('manifest.json', base), response = await fetch(url);
    if (!response.ok) throw new Error(prepared ? 'Prepared collection is missing. Run prepare:fadr for this collection, or load the test scenes.' : 'Run npm run fixtures, then reload.');
    await load(await response.json(), urlReader(url.href), true);
  };
  if (prepared) {
    setText('collection', 'Loading prepared stems...');
    button('load-prepared').hidden = false; handle('load-prepared', open); library.configurePrepared(base);
  }
  await open();
}
setPlayMode(playMode);
void openInitialCollection().catch(showError);

/** Inspection hook shared by integration tests and the performance diagnostics console. */
declare global { interface Window { livemixerPerformance: { simulation: SimulationPanel; session: () => PerformanceSession | undefined; engine: () => AudioEngine | undefined } } }
window.livemixerPerformance = { simulation: simulationPanel, session: () => session, engine: () => engine };
