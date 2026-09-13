import { STEMS, type Manifest, type StemId } from '../config';
import type { ReadMedia } from '../audio/assets';
import { download } from '../trace';
import { button, element, escapeHtml, input, select } from '../ui/controls';
import { candidateConnections, clipsManifest, createClip, groupLibrary, inspectSong, selection } from './catalog';
import { applyPerformanceConfig, exportMixZip, restoreProject, saveProject } from './project';
import type { LibraryClip, LibrarySong, SongAnalysis } from './types';
import { fetchPreparedLibrary } from './prepared';
import { setFullBufferLoop } from '../audio/loop';
interface Callbacks { beforeAudition: () => void; loadPerformance: (manifest: Manifest, read: ReadMedia, edge?: string) => Promise<void>; error: (error: unknown) => void; playbackChanged?: () => void }
const durationText = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
const db = (value: number | null | undefined) => value == null ? '−∞' : value.toFixed(1);
export class LibraryWorkspace {
  songs: LibrarySong[] = []; clips: LibraryClip[] = []; edgeNotes: Record<string, string> = {};
  private performance?: Manifest;
  private preparedLoaded = false;
  private selected = ''; private counter = 0; private worker?: Worker; private jobs: LibrarySong[] = []; private analyzing = false; private busy = false;
  private sources: AudioBufferSourceNode[] = []; private gains: Partial<Record<StemId, GainNode>> = {}; private auditionGeneration = 0;
  private previewLoading = false;
  private metronome = false; private metronomeGain?: GainNode;
  private readonly active = new Set<StemId>(['other', 'bass', 'drums']);
  constructor(readonly context: AudioContext, readonly callbacks: Callbacks) {
    const app = element('app'), header = app.querySelector('header')!, error = element('error'), setup = document.createElement('div'), instrument = document.createElement('div'); instrument.id = 'instrument-view';
    setup.id = 'setup-view'; setup.hidden = true; setup.append(element('studio-tools'));
    for (const child of Array.from(app.children)) if (child !== header && child !== error) instrument.append(child);
    const nav = document.createElement('nav'); nav.className = 'surface-tabs'; nav.setAttribute('aria-label', 'Workspace');
    nav.innerHTML = '<button id="instrument-tab" class="active" aria-pressed="true">Play</button><button id="library-tab" aria-pressed="false">Build mix</button><button id="setup-tab" aria-pressed="false">Setup</button><button id="stop-all" class="nav-stop" disabled>Stop all audio</button>';
    app.append(nav, error, instrument, setup); const root = document.createElement('div'); root.id = 'library-view'; root.hidden = true; app.append(root);
    root.innerHTML = `
    <section class="panel library-intro"><div><h2>Build a mix</h2><p class="subtle">Choose song sections, listen to their stems, then arrange the order you want to play.</p></div><div class="actions"><label class="file-button">Open songs folder (WAV)<input id="library-folder" type="file" webkitdirectory multiple /></label></div></section>
    <section id="prepared-source" class="panel prepared-source" hidden><div><h3>Use the full song behind your passages</h3><p id="prepared-source-help">Your passages are already ready in Play. Open the full-length stems here to see waveforms and choose different sections.</p></div><button id="library-prepared" class="primary" hidden>Open full song & waveforms</button></section>
    <details id="library-project-tools" class="panel"><summary>Save or reopen a project</summary><p class="subtle">Save your passage choices and order. To reopen a project, open its song folder first. Export audio below when you want to keep a playable copy.</p><div class="actions"><button id="library-save" disabled>Save project</button><label class="file-button">Open saved project<input id="library-project" type="file" accept=".json" /></label></div></details>
    <button id="library-fixtures" hidden>Synthetic tone library (test only)</button>
    <div id="library-error" role="alert" hidden></div>
    <div class="library-toolbar"><input id="library-search" type="search" placeholder="Find a song…" aria-label="Find a song" /><span id="library-count" class="subtle">No songs imported</span><button id="analyze-all">Analyze missing songs</button><button id="analyze-cancel" disabled>Cancel analysis</button></div>
    <p id="analysis-progress" class="subtle" aria-live="polite">Open a songs folder, or use the full song above. Then choose a song from the list.</p>
    <div class="library-columns"><aside class="panel song-browser" aria-label="Songs"><div id="song-list"><p class="subtle">One folder per song, or names such as SongName_bass.wav. Assign unusual filenames in the inspector.</p></div></aside>
    <section class="panel song-inspector" aria-label="Song inspector"><div id="song-detail"><div class="library-empty"><h2>Choose a song to inspect</h2><p>Compare stem levels and rhythm, mark a downbeat, and audition a complete loop before adding it to your mix.</p></div></div></section></div>
    <section class="panel mix-builder" aria-label="Mix path"><div class="section-heading"><div><h2>Playing order <span id="clip-count" class="subtle">0 passages</span></h2><p class="subtle">Add passages below in the order you want. In Play, each passage loops until you press Next passage.</p></div><label><input id="path-repeat" type="checkbox" /> Repeat path</label></div>
    <div id="mix-path"><p class="subtle">Add a reviewed-length passage from the inspector to begin.</p></div><div class="actions"><button id="mix-load" class="primary" disabled>Use this mix in Play</button><button id="mix-export" disabled>Save mix with audio (ZIP)</button></div><p id="mix-status" class="subtle">Use this mix in Play loads these passages into the playing controls. It does not start playback.</p></section>`;
    button('instrument-tab').onclick = () => this.show('instrument'); button('library-tab').onclick = () => this.show('library'); button('setup-tab').onclick = () => this.show('setup');
    element('setup-tests').append(button('library-fixtures')); button('library-fixtures').hidden = false;
    button('library-fixtures').textContent = 'Synthetic tone library (test only)';
    const handle = (id: string, fn: () => void | Promise<void>) => button(id).onclick = () => { this.error(); Promise.resolve().then(fn).catch(e => this.error(e)); };
    input('library-folder').onchange = async () => { try { await this.importFiles(Array.from(input('library-folder').files ?? [])); } catch (e) { this.error(e); } finally { input('library-folder').value = ''; } };
    input('library-search').oninput = () => this.renderList();
    handle('library-fixtures', async () => {
      const manifest = await (await fetch('/fixtures/manifest.json')).json() as Manifest, files: File[] = [];
      for (const scene of manifest.scenes) for (const stem of STEMS) if (scene.stems[stem]) {
        const asset = scene.stems[stem]!, file = new File([await (await fetch(`/fixtures/${asset.file}`)).blob()], `${scene.id}_${stem}.wav`, { type: 'audio/wav', lastModified: 0 }); files.push(file);
      }
      await this.importFiles(files); this.show('library');
    });
    handle('analyze-all', () => this.analyze(this.songs.filter(s => !s.analysis))); handle('analyze-cancel', () => this.cancelAnalysis());
    handle('library-save', () => download('livemixer-library-project.json', saveProject(this.songs, this.clips, input('path-repeat').checked, this.edgeNotes, this.clips.length ? clipsManifest(this.clips, input('path-repeat').checked, this.edgeNotes, this.performance) : undefined)));
    input('library-project').onchange = async () => {
      try { if (this.busy) throw new Error('Wait for the current import or export.'); const file = input('library-project').files?.[0]; if (!file) return; this.cancelAnalysis(); this.stopAudition();
        const restored = await restoreProject(JSON.parse(await file.text()), this.songs, inspectSong); this.songs = restored.songs; this.clips = restored.clips; this.performance = restored.performance; this.edgeNotes = restored.edgeNotes; input('path-repeat').checked = restored.repeatPath; this.counter = this.clips.length;
        this.selected = this.songs[0]?.id ?? ''; this.renderList(); this.renderDetail(); this.renderPath(); this.status('Project restored. Listening approvals are deliberately not inferred from library analysis.');
      } catch (e) { this.error(e); } finally { input('library-project').value = ''; }
    };
    input('path-repeat').onchange = () => this.renderPath();
    handle('mix-load', () => this.loadMix()); handle('mix-export', async () => {
      if (this.busy) return; this.busy = true; this.renderPath();
      try { const clips = [...this.clips], manifest = clipsManifest(clips, input('path-repeat').checked, this.edgeNotes, this.performance); element('mix-status').textContent = 'Packing aligned WAV excerpts…'; download('livemixer-mix.zip', await exportMixZip(manifest, clips)); element('mix-status').textContent = 'ZIP exported. Extract it and open its folder in Setup.'; }
      finally { this.busy = false; this.renderPath(); }
    });
  }
  configurePrepared(base: URL) {
    element('prepared-source').hidden = false;
    const trigger = button('library-prepared'); trigger.hidden = false;
    trigger.onclick = async () => {
      if (this.busy || this.preparedLoaded) return;
      this.error(); this.busy = true; trigger.disabled = true;
      this.cancelAnalysis(false); this.stopAudition(); this.renderPath();
      try {
        const prepared = await fetchPreparedLibrary(base, message => this.status(message));
        const songs = groupLibrary(prepared.files);
        const restored = await restoreProject(prepared.project, songs, inspectSong);
        this.songs = restored.songs; this.clips = restored.clips; this.performance = restored.performance;
        this.edgeNotes = restored.edgeNotes; input('path-repeat').checked = restored.repeatPath;
        this.selected = this.songs[0]?.id ?? ''; this.counter = this.clips.length;
        this.renderList(); this.renderDetail();
        this.preparedLoaded = true;
        trigger.textContent = 'Full song is open'; element('prepared-source-help').textContent = 'Waveforms, analysis and your saved passages are open below. Change the selection to try another section; use this mix in Play when ready.';
        this.status(`Full song opened: ${this.songs.map(song => song.label).join(', ')}. ${this.clips.length} saved passages are in the playing order.`);
      } catch (error) { this.error(error); this.status('Prepared song could not be loaded. Previous library retained.'); }
      finally { this.busy = false; trigger.disabled = this.preparedLoaded; this.renderList(); this.renderPath(); }
    };
  }
  show(surface: 'instrument' | 'library' | 'setup') {
    element('instrument-view').hidden = surface !== 'instrument'; element('library-view').hidden = surface !== 'library'; element('setup-view').hidden = surface !== 'setup';
    for (const name of ['instrument', 'library', 'setup']) { button(`${name}-tab`).classList.toggle('active', surface === name); button(`${name}-tab`).setAttribute('aria-pressed', String(surface === name)); }
    if (surface === 'library') this.drawWaveforms();
  }
  get auditioning() { return this.previewLoading || this.sources.length > 0; }
  private error(error?: unknown) { const el = element('library-error'); el.hidden = !error; el.textContent = error ? error instanceof Error ? error.message : String(error) : ''; }
  private status(message: string) { element('analysis-progress').textContent = message; }
  async importFiles(files: File[]) {
    if (this.busy) throw new Error('Wait for the current import or export.');
    this.cancelAnalysis(); this.stopAudition(); this.busy = true;
    try {
      const songs = groupLibrary(files); if (!songs.length) throw new Error('No WAV files found. Select the folder containing your demixed WAV stems.');
      if (songs.length > 1000) throw new Error('Import up to 1,000 song folders at once.');
      for (let i = 0; i < songs.length; i++) { this.status(`Reading headers ${i + 1}/${songs.length} · ${songs[i].label}`); await inspectSong(songs[i]); }
      this.preparedLoaded = false; button('library-prepared').disabled = false; button('library-prepared').textContent = 'Open full song & waveforms';
      element('prepared-source-help').textContent = 'Opens the original full-song stems and saved passages, replacing the library below. Your mix in Play stays as it is.';
      this.songs = songs; this.clips = []; this.performance = undefined; this.edgeNotes = {}; this.selected = songs[0].id; this.counter = 0; this.renderList(); this.renderDetail(); this.renderPath();
      const ignored = files.filter(f => !/\.wav$/i.test(f.name)).length;
      this.status(`${songs.length} songs indexed from WAV headers. ${ignored ? `${ignored} non-WAV files skipped. ` : ''}Analyze a selection or the whole library when ready.`);
    } finally { this.busy = false; this.renderList(); this.renderPath(); }
  }
  private renderList() {
    const query = input('library-search').value.toLowerCase(), songs = this.songs.filter(s => `${s.label} ${s.key ?? s.analysis?.key.label ?? ''}`.toLowerCase().includes(query));
    element('library-count').textContent = `${songs.length}/${this.songs.length} songs · ${this.songs.filter(s => s.analysis).length} analyzed`;
    element('song-list').innerHTML = songs.map(s => `<button class="song-card ${s.id === this.selected ? 'selected' : ''}" data-song="${s.id}"><strong>${escapeHtml(s.label)}</strong><span>${Object.keys(s.stems).length} stems · ${durationText(Object.values(s.metadata)[0]?.duration ?? 0)}${s.issues.length ? ' · needs attention' : ' · aligned'}</span><span>${s.bpm ?? s.analysis?.tempo.bpm ?? '—'} BPM · ${escapeHtml(s.key || s.analysis?.key.label || 'Not analyzed')}</span></button>`).join('') || '<p class="subtle">No songs match this search.</p>';
    element('song-list').querySelectorAll<HTMLButtonElement>('[data-song]').forEach(b => b.onclick = () => this.choose(b.dataset.song!));
    button('library-save').disabled = !this.songs.length || this.busy;
    button('analyze-all').disabled = !this.songs.some(s => !s.analysis) || this.analyzing || this.busy; button('analyze-cancel').disabled = !this.analyzing;
  }
  private choose(id: string) { this.stopAudition(); this.selected = id; this.error(); this.renderList(); this.renderDetail(); }
  private get song() { return this.songs.find(s => s.id === this.selected); }
  private renderDetail() {
    const s = this.song; if (!s) return;
    const a = s.analysis, meta = s.metadata.other ?? Object.values(s.metadata)[0], chosenBpm = s.bpm ?? a?.tempo.bpm ?? 120;
    element('song-detail').innerHTML = `<div class="section-heading"><div><h2>${escapeHtml(s.label)}</h2><span class="subtle">${meta ? `${durationText(meta.duration)} · ${meta.sampleRate.toLocaleString()} Hz` : 'Assign readable WAV stems'} · ${escapeHtml(s.directory)}</span></div><button id="analyze-selected" ${this.analyzing ? 'disabled' : ''}>${a ? 'Analyze again' : 'Analyze song'}</button></div>
    ${s.issues.length ? `<div class="library-warning">${s.issues.map(escapeHtml).join('<br>')}</div>` : '<div class="subtle">Matching source sample rates and frame counts. Listening must still establish source alignment and usable seams.</div>'}
    <details class="song-analysis"><summary>Tempo, key & analysis details</summary><div class="analysis-cards"><div><span>Tempo estimate</span><strong>${a?.tempo.bpm ?? '—'}<small> BPM</small></strong><p>${a ? `Other peaks: ${a.tempo.alternatives.join(', ') || 'none'}<br>Window estimates: ${a.tempo.windowBpms.join(' / ') || 'unresolved'}` : 'Analyze the drums to estimate pulse.'}</p></div><div><span>Tonal estimate</span><strong>${escapeHtml(a?.key.label ?? '—')}</strong><p>${a ? escapeHtml(a.key.alternatives.join(' · ')) : 'Analyze the harmonic anchor for pitch-class emphasis.'}</p></div></div>
    ${a ? `<p class="subtle">Tempo and key are tentative estimates from ${a.range.start.toFixed(1)}–${(a.range.start + a.range.duration).toFixed(1)} s. Check half/double tempo, local chords, and drift by listening. Levels below cover the complete files.</p><div class="chroma" aria-label="Pitch-class emphasis">${a.key.chroma.map((v, i) => `<div title="${['C','C♯','D','E♭','E','F','F♯','G','A♭','A','B♭','B'][i]}"><span style="height:${Math.max(1, v * 46)}px"></span><small>${['C','C♯','D','E♭','E','F','F♯','G','A♭','A','B♭','B'][i]}</small></div>`).join('')}</div>` : ''}
    ${a ? `<div class="analysis-table"><table><thead><tr><th>Stem</th><th>Peak dBFS</th><th>RMS dBFS</th><th>Crest dB</th><th>Quiet</th></tr></thead><tbody>${STEMS.filter(id => a.stems[id]).map(id => { const stats = a.stems[id]!; return `<tr><th>${id}</th><td>${db(stats.peakDbfs)}</td><td>${db(stats.rmsDbfs)}</td><td>${stats.crestDb.toFixed(1)}</td><td>${(stats.silentFraction * 100).toFixed(0)}%${stats.nonfinite ? ' / invalid samples' : ''}${stats.clippedSamples ? ' / near full scale' : ''}</td></tr>`; }).join('')}</tbody></table></div>` : ''}
    </details><h3>Listen to the stems</h3><p class="subtle">Checkboxes turn stems on or off during Preview selection. Solo lets you hear one stem.</p><div class="waveforms">${STEMS.filter(id => s.stems[id]).map(id => { return `<div class="waveform-row"><div><label><input type="checkbox" data-solo-stem="${id}" ${this.active.has(id) ? 'checked' : ''} /> ${id}</label><button class="solo-button" data-solo="${id}">Solo</button></div><canvas id="wave-${id}" width="1000" height="70" aria-label="${id} waveform; click to choose a start bar"></canvas></div>`; }).join('')}</div>
    <h3>Choose a section</h3><div class="selection-grid"><label>Grid BPM<input id="library-bpm" type="number" min="20" max="300" step=".1" value="${chosenBpm}" /></label><label>Downbeat offset, s<input id="library-offset" type="number" min="0" step=".001" value="${s.gridOffset}" /></label><label>Start bar<input id="library-bar" type="number" min="1" step="1" value="${s.startBar}" /></label><label>Loop length<select id="library-bars"><option value="4" ${s.loopBars === 4 ? 'selected' : ''}>4 bars</option><option value="8" ${s.loopBars === 8 ? 'selected' : ''}>8 bars</option></select></label><label>Key annotation<input id="library-key" type="text" value="${escapeHtml(s.key ?? '')}" placeholder="Optional; reviewed by ear" /></label></div>
    <p id="selection-status" class="subtle"></p><div class="actions"><button id="library-audition">Preview selection</button><button id="library-stop">Stop preview</button><button id="library-add" class="primary">Add passage to mix</button><label><input id="library-click" type="checkbox" ${this.metronome ? 'checked' : ''} /> Grid metronome</label><label><input id="library-vocals" type="checkbox" ${!s.stems.vocals ? 'disabled' : ''} /> Make vocals available in Play</label></div><p class="subtle">Set the first downbeat by ear. All exports use the same frame range in every stem, without changing pitch or tempo.</p>
    <details><summary>Notes & stem assignments</summary><label class="notes">Song / passage notes<textarea id="library-notes">${escapeHtml(s.notes)}</textarea></label>
    <details><summary>Stem assignment</summary><div class="stem-assignment">${STEMS.map(id => `<label>${id}<select data-assign="${id}"><option value="">Omitted</option>${s.files.map((f, i) => `<option value="${i}" ${s.stems[id] === f ? 'selected' : ''}>${escapeHtml(f.name)}</option>`).join('')}</select></label>`).join('')}</div><button id="apply-assignment">Apply assignments</button></details>
    </details><div class="connection-hints"><h3>Candidate next songs</h3><p class="subtle">Ordered by estimated tempo and anchor-level difference. These are planning hints for a reset transition; they do not establish stem or chord compatibility.</p>${candidateConnections(s, this.songs).map(c => `<button data-candidate="${c.song.id}"><strong>${escapeHtml(c.song.label)}</strong><span>${c.tempoDelta === null ? 'Tempo unmeasured' : `${c.tempoDelta >= 0 ? '+' : ''}${c.tempoDelta.toFixed(1)}% tempo`} · ${c.energyDelta === null ? 'level unmeasured' : `${c.energyDelta >= 0 ? '+' : ''}${c.energyDelta.toFixed(1)} dB anchor RMS`} · ${escapeHtml(c.song.key || c.song.analysis?.key.label || 'key unmeasured')}</span></button>`).join('') || '<p class="subtle">Import another song to compare candidates.</p>'}</div>`;
    button('analyze-selected').onclick = () => this.analyze([s]);
    for (const id of ['library-bpm', 'library-offset', 'library-bar', 'library-bars', 'library-key', 'library-notes']) element(id).onchange = () => { this.readSelection(); this.drawWaveforms(); this.selectionStatus(); this.renderList(); };
    element('song-detail').querySelectorAll<HTMLInputElement>('[data-solo-stem]').forEach(checkbox => checkbox.onchange = () => { const id = checkbox.dataset.soloStem as StemId; if (checkbox.checked) this.active.add(id); else this.active.delete(id); this.applyAuditionGains(); });
    element('song-detail').querySelectorAll<HTMLButtonElement>('[data-solo]').forEach(b => b.onclick = () => { this.active.clear(); this.active.add(b.dataset.solo as StemId); element('song-detail').querySelectorAll<HTMLInputElement>('[data-solo-stem]').forEach(c => c.checked = this.active.has(c.dataset.soloStem as StemId)); this.applyAuditionGains(); });
    element('song-detail').querySelectorAll<HTMLButtonElement>('[data-candidate]').forEach(b => b.onclick = () => this.choose(b.dataset.candidate!));
    button('library-stop').onclick = () => this.stopAudition();
    input('library-click').onchange = () => { this.metronome = input('library-click').checked; this.metronomeGain?.gain.setTargetAtTime(this.metronome ? .05 : 0, this.context.currentTime, .01); };
    button('library-audition').onclick = () => this.audition().catch(e => { this.stopAudition(); this.error(e); });
    button('library-add').onclick = () => { try { this.readSelection(); if (this.clips.length >= 50) throw new Error('A performance path supports up to 50 prepared scenes.');
      let id: string; do { id = `${s.id}_clip_${++this.counter}`; } while (this.clips.some(c => c.id === id));
      this.clips.push(createClip(s, id, input('library-vocals').checked)); this.renderPath(); element('selection-status').textContent = 'Passage added. Connect and reorder it in the mix path below.';
    } catch (e) { this.error(e); } };
    button('apply-assignment').onclick = async () => {
      try { this.stopAudition(); this.cancelAnalysis(); s.stems = {}; s.issues = [];
        element('song-detail').querySelectorAll<HTMLSelectElement>('[data-assign]').forEach(el => { if (el.value !== '') s.stems[el.dataset.assign as StemId] = s.files[Number(el.value)]; });
        s.analysis = undefined; await inspectSong(s); this.renderDetail(); this.renderList();
      } catch (e) { this.error(e); }
    };
    for (const id of STEMS) if (document.getElementById(`wave-${id}`)) element<HTMLCanvasElement>(`wave-${id}`).onclick = event => {
      const canvas = event.currentTarget as HTMLCanvasElement, rect = canvas.getBoundingClientRect(); this.readSelection();
      if (meta) { s.startBar = Math.max(1, 1 + Math.round(((event.clientX - rect.left) / rect.width * meta.duration - s.gridOffset) / (240 / (s.bpm ?? 120)))); input('library-bar').value = String(s.startBar); this.drawWaveforms(); this.selectionStatus(); }
    };
    this.selectionStatus(); this.drawWaveforms();
  }
  private readSelection() {
    const s = this.song; if (!s) return;
    s.bpm = Number(input('library-bpm').value); s.gridOffset = Number(input('library-offset').value); s.startBar = Number(input('library-bar').value); s.loopBars = Number(select('library-bars').value) as 4 | 8;
    s.key = input('library-key').value; s.notes = element<HTMLTextAreaElement>('library-notes').value;
  }
  private selectionStatus() {
    const s = this.song; if (!s) return;
    try { const r = selection(s); element('selection-status').textContent = `${r.startSeconds.toFixed(3)}–${(r.startSeconds + r.duration).toFixed(3)} s · ${r.frameCount.toLocaleString()} aligned source frames · ${s.loopBars} bars`; button('library-add').disabled = !!s.issues.length; button('library-audition').disabled = !!s.issues.length; }
    catch (e) { element('selection-status').textContent = String(e); button('library-add').disabled = button('library-audition').disabled = true; }
  }
  private drawWaveforms() {
    const s = this.song; if (!s) return; const meta = s.metadata.other ?? Object.values(s.metadata)[0]; let range: ReturnType<typeof selection> | undefined;
    try { range = selection(s); } catch { /* Invalid selections remain visibly explained. */ }
    for (const id of STEMS) {
      const canvas = document.getElementById(`wave-${id}`) as HTMLCanvasElement | null; if (!canvas) continue;
      const ctx = canvas.getContext('2d')!, w = canvas.width, h = canvas.height; ctx.clearRect(0, 0, w, h); ctx.fillStyle = '#101512'; ctx.fillRect(0, 0, w, h);
      const peaks = s.analysis?.stems[id]?.peaks ?? []; ctx.fillStyle = id === 'other' ? '#b9ec80' : id === 'bass' ? '#8bbcc9' : id === 'drums' ? '#e3c281' : '#c5a4d7';
      for (let i = 0; i < peaks.length; i++) { const height = Math.min(1, Math.sqrt(peaks[i])) * (h - 8); ctx.fillRect(i * w / peaks.length, (h - height) / 2, Math.max(1, w / peaks.length), Math.max(1, height)); }
      if (range && meta) { const x = range.startSeconds / meta.duration * w, width = range.duration / meta.duration * w; ctx.fillStyle = '#ffffff22'; ctx.fillRect(x, 0, width, h); ctx.strokeStyle = '#ffffff'; ctx.strokeRect(x + .5, .5, width - 1, h - 1); }
    }
  }
  private analyze(songs: LibrarySong[]) {
    if (this.analyzing || !songs.length) return; this.jobs = [...songs]; this.analyzing = true;
    this.worker = new Worker(new URL('./analysis.worker.ts', import.meta.url), { type: 'module' });
    this.worker.onerror = event => { this.error(event.message); this.cancelAnalysis(); };
    this.worker.onmessage = ({ data }) => {
      const song = this.songs.find(s => s.id === data.id);
      if (data.type === 'progress') this.status(`Analyzing ${song?.label ?? ''} / ${data.stem} · ${this.jobs.length} songs remaining`);
      if (data.type === 'done') { if (song) song.analysis = data.analysis as SongAnalysis; this.renderList(); if (song?.id === this.selected) this.renderDetail(); this.nextAnalysis(); }
      if (data.type === 'error') { this.error(data.message); this.nextAnalysis(); }
    };
    this.renderList(); this.nextAnalysis();
  }
  private nextAnalysis() {
    const song = this.jobs.shift(); if (!song) { this.cancelAnalysis(false); this.status(`Analysis complete · ${this.songs.filter(s => s.analysis).length}/${this.songs.length} songs. Estimates still need listening review.`); return; }
    const stems = Object.fromEntries(STEMS.filter(s => song.stems[s] && song.metadata[s]).map(s => [s, { file: song.stems[s], info: song.metadata[s] }]));
    this.worker!.postMessage({ id: song.id, stems });
  }
  private cancelAnalysis(message = true) { this.worker?.terminate(); this.worker = undefined; this.jobs = []; this.analyzing = false; this.renderList(); if (document.getElementById('analyze-selected')) button('analyze-selected').disabled = false; if (message) this.status('Analysis canceled. Completed song analyses are retained.'); }
  stopAudition() {
    if (this.auditioning && document.getElementById('selection-status')) element('selection-status').textContent = 'Preview stopped.';
    this.previewLoading = false;
    this.auditionGeneration++; for (const source of this.sources) { try { source.stop(); } catch { /* ended */ } source.disconnect(); }
    Object.values(this.gains).forEach(g => g.disconnect()); this.sources = []; this.gains = {};
    this.metronomeGain?.disconnect(); this.metronomeGain = undefined; this.callbacks.playbackChanged?.();
  }
  private applyAuditionGains() { const now = this.context.currentTime; for (const id of STEMS) if (this.gains[id]) this.gains[id]!.gain.setTargetAtTime(this.active.has(id) ? .25 : 0, now, .01); }
  private async audition() {
    const s = this.song; if (!s) return; this.readSelection(); this.stopAudition(); this.callbacks.beforeAudition(); const generation = this.auditionGeneration; this.previewLoading = true;
    element('selection-status').textContent = 'Loading preview...'; this.callbacks.playbackChanged?.(); await this.context.resume();
    if (generation !== this.auditionGeneration) return;
    const clip = createClip(s, 'audition', !!s.stems.vocals), buffers: Partial<Record<StemId, AudioBuffer>> = {};
    for (const id of STEMS) if (clip.files[id]) {
      const buffer = await this.context.decodeAudioData(await clip.files[id]!.arrayBuffer());
      if (generation !== this.auditionGeneration) return;
      for (let channel = 0; channel < buffer.numberOfChannels; channel++) if (buffer.getChannelData(channel).some(v => !Number.isFinite(v))) throw new Error(`${id}: selected audio contains nonfinite samples.`);
      buffers[id] = buffer;
    }
    if (generation !== this.auditionGeneration) return;
    const lengths = Object.values(buffers).map(b => b.length); if (new Set(lengths).size !== 1) throw new Error('Decoded selection stems have different lengths.');
    this.previewLoading = false;
    const at = this.context.currentTime + .1;
    for (const id of STEMS) if (buffers[id]) {
      const source = this.context.createBufferSource(), gain = this.context.createGain(); setFullBufferLoop(source, buffers[id]!); source.playbackRate.value = 1;
      gain.gain.value = this.active.has(id) ? .25 : 0; source.connect(gain).connect(this.context.destination); this.sources.push(source); this.gains[id] = gain;
    }
    const clickBuffer = this.context.createBuffer(1, lengths[0], this.context.sampleRate), samples = clickBuffer.getChannelData(0);
    for (let beat = 0; beat < s.loopBars * 4; beat++) {
      const start = Math.round(beat * samples.length / (s.loopBars * 4)), hz = beat % 4 === 0 ? 1400 : 900;
      for (let i = 0; i < this.context.sampleRate * .025 && start + i < samples.length; i++) samples[start + i] = Math.sin(2 * Math.PI * hz * i / this.context.sampleRate) * Math.exp(-i / (this.context.sampleRate * .005));
    }
    const click = this.context.createBufferSource(); setFullBufferLoop(click, clickBuffer); this.metronomeGain = this.context.createGain(); this.metronomeGain.gain.value = this.metronome ? .05 : 0;
    click.connect(this.metronomeGain).connect(this.context.destination); this.sources.push(click);
    this.sources.forEach(s => s.start(at, 0)); this.callbacks.playbackChanged?.(); element('selection-status').textContent = 'Audition looping · all stems remain in phase while solo/mute changes their gains · −12 dB audition gain per stem';
  }
  private renderPath() {
    element('clip-count').textContent = `${this.clips.length} passages`;
    const repeat = input('path-repeat').checked && this.clips.length > 1;
    element('mix-path').innerHTML = this.clips.map((c, i) => {
      const next = this.clips[i + 1] ?? (repeat ? this.clips[0] : undefined), key = next ? `${c.id}→${next.id}` : '';
      return `<div class="path-card"><span class="path-number">${i + 1}</span><div><strong>${escapeHtml(c.scene.label)}</strong><span>${c.scene.nominalBpm?.toFixed(1)} BPM · ${c.scene.loopBars} bars · ${escapeHtml(c.scene.keyLabel || 'key unreviewed')} · ${Object.keys(c.files).join(' / ')}</span></div><div class="actions"><button data-move="${i}" data-direction="-1" aria-label="Move passage ${i + 1} up" ${i === 0 ? 'disabled' : ''}>↑</button><button data-move="${i}" data-direction="1" aria-label="Move passage ${i + 1} down" ${i === this.clips.length - 1 ? 'disabled' : ''}>↓</button><button data-remove="${i}">Remove</button></div></div>${next ? `<div class="path-edge"><span>↓ Next passage</span><input type="text" data-edge-note="${escapeHtml(key)}" value="${escapeHtml(this.edgeNotes[key] ?? '')}" placeholder="Connection notes / what to listen for" aria-label="Connection ${i + 1} notes" /><button data-review-edge="${escapeHtml(key)}">Audio checks</button></div>` : ''}`;
    }).join('') || '<p class="subtle">Add a passage from a song above. The path is independent of library sort order.</p>';
    element('mix-path').querySelectorAll<HTMLButtonElement>('[data-move]').forEach(b => b.onclick = () => { const at = Number(b.dataset.move), to = at + Number(b.dataset.direction); [this.clips[at], this.clips[to]] = [this.clips[to], this.clips[at]]; this.renderPath(); });
    element('mix-path').querySelectorAll<HTMLButtonElement>('[data-remove]').forEach(b => b.onclick = () => { this.clips.splice(Number(b.dataset.remove), 1); this.renderPath(); });
    element('mix-path').querySelectorAll<HTMLInputElement>('[data-edge-note]').forEach(el => el.onchange = () => this.edgeNotes[el.dataset.edgeNote!] = el.value);
    element('mix-path').querySelectorAll<HTMLButtonElement>('[data-review-edge]').forEach(b => b.onclick = () => this.loadMix(b.dataset.reviewEdge).catch(e => this.error(e)));
    button('mix-load').disabled = button('mix-export').disabled = !this.clips.length || this.busy;
    const seconds = this.clips.reduce((n, c) => n + c.scene.sourceFrameCount / c.scene.sourceSampleRate, 0), bytes = this.clips.reduce((n, c) => n + Object.values(c.files).reduce((sum, b) => sum + b.size, 0), 0);
    if (this.clips.length && !this.busy) element('mix-status').textContent = `${durationText(seconds)} of selected audio · ${(bytes / 1024 / 1024).toFixed(1)} MiB WAV excerpts · Press Use this mix in Play to load this order. Each passage loops until you move on.`;
  }
  private async loadMix(edge?: string) {
    if (this.busy) return; const manifest = clipsManifest(this.clips, input('path-repeat').checked, this.edgeNotes, this.performance), media = new Map<string, Blob>();
    for (const clip of this.clips) for (const stem of STEMS) if (clip.files[stem]) media.set(clip.scene.stems[stem]!.file, clip.files[stem]!);
    this.stopAudition(); this.busy = true; this.renderPath();
    try { await this.callbacks.loadPerformance(manifest, async path => { const blob = media.get(path); if (!blob) throw new Error(`Missing prepared excerpt ${path}`); return blob.arrayBuffer(); }, edge); }
    finally { this.busy = false; this.renderPath(); }
  }
  syncPerformance(manifest: Manifest) {
    if (!this.clips.length || !manifest.path.every(id => this.clips.some(c => c.id === id))) return;
    try {
      this.clips = applyPerformanceConfig(this.clips, manifest); this.performance = structuredClone(manifest);
      input('path-repeat').checked = manifest.repeatPath;
      for (const edge of manifest.edges) this.edgeNotes[`${edge.from}→${edge.to}`] = edge.notes;
      this.renderPath();
    } catch (error) { this.error(error); }
  }
}
