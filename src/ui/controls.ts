import { describeRecipes } from './recipes';
import { RECIPES, STEMS, type Manifest, type Scene } from '../config';
export const escapeHtml = (value: unknown) => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
export function element<T extends HTMLElement = HTMLElement>(id: string): T { const node = document.getElementById(id); if (!node) throw new Error(`Missing UI element ${id}`); return node as T; }
export const button = (id: string) => element<HTMLButtonElement>(id);
export const input = (id: string) => element<HTMLInputElement>(id);
export const select = (id: string) => element<HTMLSelectElement>(id);
export function mount() {
  element('app').innerHTML = `
  <header><div><span class="eyebrow">LOCAL STEM INSTRUMENT</span><h1>Live Mixer<span class="version">v0.1</span></h1></div><div id="context-state" class="chip">Stopped</div></header>
  <div id="error" role="alert" hidden></div>
  <section class="load-row" aria-label="Audio collection">
    <div><strong id="collection">Loading your music…</strong><div id="load-status" class="subtle">Preparing synchronized audio</div></div>
    <div class="actions"><button id="load-prepared" hidden>Load prepared song</button><button id="load-fixtures">Load test scenes</button><label class="file-button">Open saved mix folder<input id="folder" type="file" webkitdirectory multiple /></label><label class="file-button">Open manifest<input id="manifest-file" type="file" accept=".json" /></label></div>
  </section>
  <div class="mode-row"><label><input id="authoring" type="checkbox" checked /> Authoring mode</label><span id="approval-status">Unapproved material may be auditioned.</span><span id="memory" class="subtle"></span></div>
  <section class="transport panel" aria-label="Transport">
    <div class="transport-top"><div><span class="eyebrow">ACTIVE SCENE</span><h2 id="scene-name">—</h2><div id="scene-meta" class="subtle">All sources run at their native speed</div></div><div class="actions"><button id="start" class="primary" disabled>Start audio</button><button id="stop" disabled>Stop</button><button id="next" disabled>Next scene →</button></div></div>
    <div id="phase" class="phase" role="progressbar" aria-label="Loop phase" aria-valuemin="0" aria-valuemax="100"><span></span></div>
    <div class="transport-bottom"><span id="bar">Stopped</span><span id="boundary">Next boundary —</span><span id="transition">No scene transition</span></div>
  </section>
  <div class="workspace">
    <section class="panel control-panel" aria-label="Openness control">
      <div class="section-heading"><h2>Openness</h2><label>Input <select id="adapter"><option value="slider">Slider</option><option value="camera">Camera</option><option value="replay">Raw replay</option></select></label></div>
      <div class="value-row"><output id="smooth-value">0.300</output><span id="cutoff">— Hz</span></div>
      <input id="openness" class="openness" type="range" min="0" max="1" step="0.001" value="0.3" aria-label="Openness" />
      <div class="range-labels"><span>Darker / sparse</span><span>Clearer / open</span></div>
      <div class="input-details"><span id="raw-value">Raw 0.300</span><span id="tracking">Valid</span><span id="age">Age 0 ms</span></div>
      <div class="setting-row"><label>Mapping <select id="mapping"><option value="combined">Combined</option><option value="timbre_only">Timbre only</option><option value="structure_only">Structure only</option></select></label><label><input id="bypass" type="checkbox" /> Filter bypass</label></div>
      <div class="setting-row"><label><input id="hold" type="checkbox" /> Enable hold-to-advance</label><label><input id="metronome" type="checkbox" /> Metronome</label></div>
      <progress id="hold-progress" max="1" value="0" aria-label="Advance hold progress"></progress><div id="gesture" class="subtle">Advance disarmed · hold below 0.75 to rearm</div>
      <div id="camera-panel" hidden><div class="camera-preview"><video id="video" muted playsinline></video><canvas id="landmarks" width="640" height="480"></canvas></div><div id="camera-status" class="subtle">Lean a visible open hand left and right. No microphone is used.</div><div class="actions"><button id="camera-start">Start camera</button><button id="camera-stop">Stop camera</button><button id="cal-low">Capture low</button><button id="cal-high">Capture high</button></div><p id="calibration" class="subtle">Hold each endpoint still for ½ second; use a comfortable 30–120° sweep.</p></div>
    </section>
    <section class="panel" aria-label="Arrangement">
      <div class="section-heading"><h2>Arrangement</h2><button id="cancel">Cancel pending</button></div>
      <div class="recipe-state"><div><span>Current</span><strong id="current-recipe">sparse</strong></div><div><span>Desired</span><strong id="desired-recipe">sparse</strong></div><div><span>Pending</span><strong id="pending-recipe">—</strong></div><div><span>Committed</span><strong id="committed-recipe">—</strong></div></div>
      <div class="recipe-buttons">${RECIPES.map(r => `<button data-recipe="${r}">${r}</button>`).join('')}</div>
      <p class="subtle">Recipe gains arrive together on the approved grid. Muted stems continue in phase.</p>
      <div id="stem-meters"></div><div class="master-meter"><span>Output</span><meter id="master-meter" min="0" max="1" low=".3" high=".89" optimum=".2" value="0"></meter><span id="peak">−∞ dBFS</span></div>
      <p id="nodes" class="subtle">0 decks · 0 sources</p>
    </section>
  </div>
  <section class="panel" aria-label="Trace and replay"><div class="section-heading"><h2>Trace & replay</h2><span id="trace-state" class="subtle">Recording locally</span></div><div class="actions"><button id="trace-export">Export trace</button><label class="file-button">Open raw trace<input id="trace-file" type="file" accept=".jsonl,.json" /></label><button id="replay-start" disabled>Play raw replay</button><button id="replay-verify" disabled>Verify decision replay</button><button id="config-export">Export configuration</button></div><p id="replay-status" class="subtle">Raw replay passes through the same smoothing, dwell, and musical planner. Decision verification uses the recorded timing simulation.</p></section>
  <section id="author-panel" class="panel author-panel" aria-label="Authoring"><div class="section-heading"><h2>Passage sound</h2><label>Scene <select id="edit-scene"></select></label></div>
    <p class="subtle">Stop playback to edit. Review all recipes, the filter sweep, seams, every directed recipe change at each allowed bar, and all nine combinations per scene edge.</p>
    <fieldset id="author-fields"><div id="scene-editor"></div><div class="actions"><button id="apply-editor">Apply & revalidate</button><button id="approve-scene">Save manual scene approval</button></div><label class="review-confirm"><input id="review-scene" type="checkbox" /> I have listened to and approved every required recipe, boundary, seam, and filter setting.</label>
    <details><summary>Full manifest editor</summary><textarea id="manifest-editor" spellcheck="false" aria-label="Manifest JSON"></textarea><button id="apply-json">Apply manifest JSON</button></details>
    <hr /><div class="setting-row"><label>Preview <select id="audition-case"></select></label><button id="render-preview">Render & audition</button><button id="stop-preview">Stop audition</button><button id="download-preview" disabled>Save audition WAV</button></div><p id="audition-status" class="subtle">Choose any required audition case. Audio previews include the complete shared graph.</p>
    <div class="setting-row"><label>Edge <select id="edit-edge"></select></label><label>Notes <input id="edge-notes" type="text" /></label><button id="approve-edge">Save manual edge approval</button></div><label class="review-confirm"><input id="review-edge" type="checkbox" /> I have listened to and approved all outgoing/incoming recipe combinations for this edge.</label>
    <hr /><div class="actions"><button id="render-all">Measure every permitted path</button><button id="cancel-render" disabled>Cancel rendering</button><button id="report-export" disabled>Export measurements</button></div><p id="render-status" class="subtle">Checks sample peaks below −1 dBFS and finite samples. Listening approval remains manual.</p></fieldset>
  </section>
  <footer>Local processing · no cross-song overlap · no tempo or pitch conversion</footer>`;
}
export function renderEditor(scene: Scene, manifest: Manifest) {
  element('scene-editor').innerHTML = `<div class="editor-grid"><label>Scene trim (dB)<input id="scene-trim" type="number" min="-120" max="0" step=".5" value="${scene.sceneTrimDb}" /></label><label>Master trim (dB)<input id="master-trim" type="number" min="-120" max="0" step=".5" value="${manifest.masterTrimDb}" /></label><label>Filter low (Hz)<input id="filter-min" type="number" min="1" value="${scene.filter.minHz}" /></label><label>Filter high (Hz)<input id="filter-max" type="number" min="1" value="${scene.filter.maxHz}" /></label><label>Filter Q (API units)<input id="filter-q" type="number" step=".1" value="${scene.filter.q}" /></label></div>
    <table><thead><tr><th>Stem</th><th>Static trim, dB</th>${RECIPES.map((r, i) => `<th>${escapeHtml(describeRecipes(scene).find(p => p.ids.includes(r))!.label)}<br><small>Slot ${i + 1}, dB</small></th>`).join('')}</tr></thead><tbody>${STEMS.filter(id => scene.stems[id]).map(id => `<tr><th>${id}${id === scene.anchorStem ? ' · anchor' : ''}</th><td><input type="number" min="-120" max="0" step=".5" id="trim-${id}" aria-label="${id} static trim" value="${scene.stems[id]!.trimDb}" /></td>${RECIPES.map(r => `<td><input type="text" inputmode="decimal" id="gain-${r}-${id}" aria-label="${r} ${id} gain" value="${scene.recipes[r][id] ?? 'mute'}" /></td>`).join('')}</tr>`).join('')}</tbody></table><p class="subtle">Use “mute” for silence. Gains are at most 0 dB.</p><label class="notes">Approval notes<textarea id="scene-notes">${escapeHtml(scene.approval.notes)}</textarea></label>`;
  element<HTMLTextAreaElement>('manifest-editor').value = JSON.stringify(manifest, null, 2);
  input('review-scene').checked = false;
}
export function readEditor(scene: Scene, manifest: Manifest): Manifest {
  const draft = structuredClone(manifest), next = draft.scenes.find(s => s.id === scene.id)!;
  next.sceneTrimDb = Number(input('scene-trim').value); draft.masterTrimDb = Number(input('master-trim').value);
  next.filter = { ...next.filter, minHz: Number(input('filter-min').value), maxHz: Number(input('filter-max').value), q: Number(input('filter-q').value) };
  next.approval.notes = element<HTMLTextAreaElement>('scene-notes').value;
  for (const id of STEMS) if (next.stems[id]) {
    next.stems[id]!.trimDb = Number(input(`trim-${id}`).value);
    for (const recipe of RECIPES) { const text = input(`gain-${recipe}-${id}`).value.trim(); next.recipes[recipe][id] = /^(mute|null)$/i.test(text) ? null : text === '' ? NaN : Number(text); }
  }
  return draft;
}
