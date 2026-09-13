import { HandSpace, defaultBounds, idleSpace, unit, validBounds, type SpaceState } from '../control/space';
import { LeapAdapter, type LeapProfile } from '../control/leap';
import { download } from '../trace';
import type { AudioEngine } from '../audio/engine';
import type { LoadedScene } from '../audio/assets';
import { analyzeActivity } from '../audio/activity';
import { button, element, escapeHtml, input, select } from './controls';

export class SpacePanel {
  readonly hand = new HandSpace();
  private leap: LeapAdapter;
  private mouse = { ...idleSpace(), enabled: true };
  private activePointer: number | null = null;
  private connected = false;
  private lastSent = '';
  private meterSamples = new Float32Array(256);
  private analyzedScene?: LoadedScene;
  private healthAt = -Infinity;
  private healthHistory: Record<string, unknown>[] = [];
  constructor(readonly change: (state: SpaceState) => void, readonly modeChanged: (enabled: boolean) => void) {
    const workspace = document.querySelector<HTMLElement>('.workspace')!;
    workspace.id = 'manual-playing';
    const mode = document.createElement('div'); mode.className = 'play-mode';
    mode.innerHTML = '<label>Play with <select id="play-mode" aria-label="Play with"><option value="space">Hand space</option><option value="manual">Manual controls</option></select></label><span class="subtle">The instrumental keeps playing when nobody is interacting.</span>';
    const panel = document.createElement('section'); panel.id = 'space-panel'; panel.className = 'panel space-panel'; panel.setAttribute('aria-label', 'Hand space');
    panel.innerHTML = `
      <div class="section-heading"><div><span class="eyebrow">REACH INTO THE MUSIC</span><h2>Shape the song</h2></div><label>Input <select id="space-input" aria-label="Hand space input"><option value="mouse">Mouse / touch preview</option><option value="leap">Leap Motion</option></select></label></div>
      <p class="performance-help">Lift to bring melody forward. Reach deeper to leave echoes and a soft cloud of sound. The instruments respond even when the singer is silent.</p>
      <div id="leap-actions" hidden><div class="actions"><button id="leap-connect">Connect Leap</button><button id="leap-disconnect" disabled>Disconnect</button><span id="leap-status" class="subtle" role="status">Place the sensor flat, facing up.</span></div><p id="leap-quality" class="subtle"></p></div>
      <div class="space-layout"><div>
        <div id="space-pad" class="space-pad" tabindex="0" role="group" aria-label="Hand space preview" aria-describedby="space-pad-help">
          <span class="space-label top">MELODY FORWARD</span><span class="space-label bottom">RHYTHM FORWARD</span>
          <span class="space-label left">Clear</span><span class="space-label right">Echo / cloud</span>
          <span id="space-cursor" class="space-cursor"></span><span id="space-invitation">Move here to try it</span>
        </div>
        <p id="space-pad-help" class="subtle">Move your pointer inside; move out to withdraw. On touch, drag and release. Or focus here: Space enters, arrows move, Escape withdraws.</p>
      </div><div class="space-readout">
        <span id="space-presence" class="chip">Instrumental bed</span>
        <h3 id="space-sound">Ready for your hand</h3>
        <p id="space-material" class="subtle">Start audio to hear your movement.</p>
        <label>Height <output id="space-height-value">50%</output><input id="space-height" aria-label="Hand height" type="range" min="0" max="1" step=".01" value=".5"></label>
        <label>Depth <output id="space-depth-value">35%</output><input id="space-depth" aria-label="Hand depth" type="range" min="0" max="1" step=".01" value=".35"></label>
        <button id="space-presence-toggle">Keep hand in space</button><p class="subtle">A still hand holds its sound. Withdrawing lets the echoes finish.</p>
      </div></div>`;
    workspace.before(mode, panel);
    // Speed remains available in either playing mode.
    element('phase').before(document.querySelector('.speed-control')!);
    const setup = document.createElement('details'); setup.className = 'panel setup-section'; setup.id = 'setup-space';
    setup.innerHTML = `<summary>Hand space & Leap bounds</summary><p class="subtle">For a sensor lying flat, facing up. Values are millimeters from its center. Start with a comfortable central volume inside your shaded enclosure. Changes save on this browser.</p>
      <div class="space-bounds">${([['width', 'Width', 100, 610], ['bottom', 'Bottom height', 100, 500], ['top', 'Top height', 200, 600], ['front', 'Front Z', -600, 600], ['back', 'Back Z', -600, 600]] as const).map(([key, label, min, max]) => `<label>${label}<input id="space-bound-${key}" type="number" min="${min}" max="${max}" step="10" value="${defaultBounds[key]}"></label>`).join('')}</div>
      <div class="actions"><button id="space-bounds-save">Apply bounds</button><button id="space-bounds-reset">Reset bounds</button></div><p id="space-bounds-status" class="subtle" role="status">Width 40 cm; height 12-42 cm; depth 30 cm. Swap Front Z and Back Z if reaching deeper moves toward Clear.</p>
      <p class="subtle">The instrumental and any available vocals feed the same effects. Bass keeps a dry foundation. The hand mix uses each stem's loudest saved level and its trim, with extra output headroom. Manual recipe buttons apply in Manual controls.</p>`;
    const tracking = document.createElement('div');
    tracking.innerHTML = `<h3>Tracking stability</h3><label>Tracking preset <select id="leap-profile"><option value="bright-room">Bright room</option><option value="responsive">Responsive</option><option value="balanced">Service default</option></select></label>
      <p class="subtle">Bright room requests stronger light robustness; Responsive prioritizes hand motion. Presets apply when connecting. The sensor decides which requests it supports.</p>
      <p id="leap-details" class="subtle">Connect Leap to see camera speed, tracking speed, frame age and device warnings.</p>
      <p class="subtle">Small resting tremors are smoothed. Brief gaps hold the last position for 300-650 ms, adapted to the frame rate. Nearby hands can retain control when the sensor changes their ID. A confirmed move out of the box withdraws immediately.</p>
      <button id="leap-report">Save tracking report</button><span id="leap-report-status" class="subtle" role="status"></span>`;
    setup.append(tracking);
    const material = document.createElement('div'); material.id = 'space-activity'; setup.append(material);
    element('studio-tools').querySelector('.setup-intro')!.after(setup);
    try { const saved = JSON.parse(localStorage.getItem('livemixer.space-bounds') ?? 'null'); if (saved && validBounds(saved)) this.hand.bounds = saved; } catch { /* Defaults remain available when storage is unavailable. */ }
    this.writeBounds();
    try { const preset = localStorage.getItem('livemixer.leap-profile'); if (preset && ['responsive', 'bright-room', 'balanced'].includes(preset)) select('leap-profile').value = preset; } catch { /* Keep the visible default. */ }
    select('leap-profile').onchange = () => {
      try { localStorage.setItem('livemixer.leap-profile', select('leap-profile').value); } catch { /* Applies for this session. */ }
      if (this.connected) { this.disconnect(); element('leap-status').textContent = 'Preset changed. Connect Leap to apply it.'; }
    };
    button('leap-report').onclick = () => {
      download('tracking-report.json', JSON.stringify({ version: 1, createdAt: new Date().toISOString(), browser: navigator.userAgent,
        profile: select('leap-profile').value, bounds: this.hand.bounds, connected: this.connected,
        readings: this.healthHistory, note: 'Local diagnostic metrics only. No camera images or palm coordinates. Empty-scene speed does not measure hand detection accuracy.' }, null, 2));
      element('leap-report-status').textContent = ` Saved ${this.healthHistory.length} recent readings.`;
    };
    button('space-bounds-save').onclick = () => {
      const bounds = Object.fromEntries(Object.keys(defaultBounds).map(key => [key, Number(input(`space-bound-${key}`).value)])) as unknown as typeof defaultBounds;
      if (!validBounds(bounds)) { element('space-bounds-status').textContent = 'Use width 100-610 mm, heights within 100-600 mm, and at least 100 mm of height and depth. Depth cannot exceed 610 mm.'; return; }
      this.hand.bounds = bounds; this.hand.reset();
      try { localStorage.setItem('livemixer.space-bounds', JSON.stringify(bounds)); element('space-bounds-status').textContent = 'Bounds saved. Reach through the space to check both directions.'; }
      catch { element('space-bounds-status').textContent = 'Bounds applied for this session. Browser storage is unavailable.'; }
    };
    button('space-bounds-reset').onclick = () => { this.hand.bounds = { ...defaultBounds }; this.writeBounds(); button('space-bounds-save').click(); };
    this.leap = new LeapAdapter((palms, now) => { this.hand.observe(palms, now, this.leap.health.trackingFps); }, (message, failed) => {
      element('leap-status').textContent = message;
      if (failed) { this.connected = false; this.hand.reset(); }
      button('leap-connect').disabled = this.connected; button('leap-disconnect').disabled = !this.connected;
    });
    button('leap-connect').onclick = () => { this.connected = true; this.hand.reset(); this.healthHistory = []; this.leap.start(select('leap-profile').value as LeapProfile); };
    button('leap-disconnect').onclick = () => this.disconnect();
    select('space-input').onchange = () => {
      this.disconnect(); this.withdraw();
      const leap = this.isLeap;
      element('leap-actions').hidden = !leap; input('space-height').disabled = input('space-depth').disabled = leap;
      button('space-presence-toggle').hidden = leap;
      element('space-pad-help').textContent = leap ? 'The dot follows your palm: height is vertical; depth is horizontal. Hold still to keep the sound.' : 'Move your pointer inside; move out to withdraw. On touch, drag and release. Or focus here: Space enters, arrows move, Escape withdraws.';
      element('space-pad').tabIndex = leap ? -1 : 0;
    };
    select('play-mode').onchange = () => this.setEnabled(select('play-mode').value === 'space');
    const pad = element('space-pad');
    const move = (event: PointerEvent) => {
      if (this.isLeap || (event.pointerType !== 'mouse' && this.activePointer !== event.pointerId)) return;
      const rect = pad.getBoundingClientRect();
      const depth = (event.clientX - rect.left - 24) / (rect.width - 48), height = 1 - (event.clientY - rect.top - 24) / (rect.height - 48);
      this.mouse = { enabled: true, presence: 1, height: unit(height), depth: unit(depth) };
    };
    pad.onpointermove = move; pad.onpointerenter = move;
    pad.onpointerdown = event => { if (this.isLeap || this.activePointer !== null) return; this.activePointer = event.pointerId; pad.setPointerCapture(event.pointerId); move(event); };
    pad.onpointerup = event => { if (this.activePointer === event.pointerId) { this.activePointer = null; if (event.pointerType !== 'mouse') this.withdraw(); if (pad.hasPointerCapture(event.pointerId)) pad.releasePointerCapture(event.pointerId); } };
    pad.onpointerleave = () => this.withdraw(); pad.onpointercancel = () => this.withdraw(); pad.onlostpointercapture = event => { if (event.pointerType !== 'mouse') this.withdraw(); };
    pad.onkeydown = event => {
      if (this.isLeap) return;
      const changes: Record<string, [number, number]> = { ArrowUp: [.05, 0], ArrowDown: [-.05, 0], ArrowLeft: [0, -.05], ArrowRight: [0, .05] };
      if (event.key === 'Escape') { event.preventDefault(); this.withdraw(); }
      else if (event.key === ' ') { event.preventDefault(); this.mouse.presence = this.mouse.presence ? 0 : 1; }
      else if (changes[event.key]) { event.preventDefault(); const [h, d] = changes[event.key]; this.mouse = { enabled: true, presence: 1, height: unit(this.mouse.height + h), depth: unit(this.mouse.depth + d) }; }
    };
    for (const key of ['height', 'depth'] as const) input(`space-${key}`).oninput = () => { if (!this.isLeap) this.mouse = { ...this.mouse, [key]: Number(input(`space-${key}`).value), presence: 1 }; };
    button('space-presence-toggle').onclick = () => { this.mouse.presence = this.mouse.presence ? 0 : 1; };
    window.addEventListener('blur', () => { if (!this.isLeap) this.withdraw(); });
    document.addEventListener('visibilitychange', () => { if (document.hidden) this.withdraw(); });
  }
  private writeBounds() { for (const [key, value] of Object.entries(this.hand.bounds)) input(`space-bound-${key}`).value = String(value); }
  showActivity(loaded: LoadedScene) {
    if (this.analyzedScene === loaded) return;
    this.analyzedScene = loaded; const analysis = analyzeActivity(loaded), threshold = .0031623;
    const rows = ([['Instrumental bed', analysis.instrumental], ['Melody / harmony', analysis.melody], ['Vocals', analysis.vocals]] as const).map(([label, values]) => {
      const coverage = values.length ? values.filter(v => v >= threshold).length / values.length : 0;
      return `<div class="activity-row"><span>${label}</span><div class="activity-strip" role="img" aria-label="${label}: ${Math.round(coverage * 100)}% signal coverage">${values.map(v => `<i class="${v >= threshold ? 'has-signal' : ''}"></i>`).join('')}</div><output>${Math.round(coverage * 100)}%</output></div>`;
    }).join('');
    element('space-activity').innerHTML = `<h3>Material in this passage</h3><p class="subtle">${escapeHtml(loaded.scene.label)}. Green marks signal above -50 dBFS in quarter-second windows, after saved stem levels. This flags gaps; it does not judge musical quality.</p>${rows}<p class="subtle">${analysis.gaps.length ? `Quiet instrumental gaps: ${analysis.gaps.map(g => `${g.start.toFixed(1)}-${g.end.toFixed(1)} s`).join(', ')}. Effects can ring out here, but cannot create new notes from silence.` : 'No instrumental gaps of half a second or longer detected. The accompaniment supplies the effects during vocal rests.'}</p>`;
  }
  get enabled() { return select('play-mode').value === 'space'; }
  private get isLeap() { return select('space-input').value === 'leap'; }
  setEnabled(enabled: boolean) {
    select('play-mode').value = enabled ? 'space' : 'manual';
    element('space-panel').hidden = !enabled; element('manual-playing').hidden = enabled;
    if (!enabled) { this.disconnect(); this.withdraw(); }
    this.lastSent = ''; this.modeChanged(enabled);
    this.change({ ...idleSpace(), enabled });
  }
  private withdraw() { this.mouse.presence = 0; this.activePointer = null; }
  reset() { this.withdraw(); this.hand.reset(); this.lastSent = ''; }
  disconnect() {
    this.leap.stop(); this.connected = false; this.hand.reset();
    element('leap-status').textContent = 'Leap disconnected. The instrumental bed continues.';
    button('leap-connect').disabled = false; button('leap-disconnect').disabled = true;
  }
  tick(engine: AudioEngine | undefined, running: boolean, replayState?: SpaceState) {
    if (replayState) {
      select('play-mode').value = replayState.enabled ? 'space' : 'manual';
      element('space-panel').hidden = !replayState.enabled; element('manual-playing').hidden = replayState.enabled;
    }
    const state = replayState ?? { ...(this.isLeap ? this.hand.sample(performance.now()) : this.mouse), enabled: this.enabled };
    this.updateHealth();
    const key = JSON.stringify(state);
    if (!replayState && key !== this.lastSent) { this.lastSent = key; this.change(state); }
    const present = state.presence > .05;
    element('space-presence').textContent = present ? 'Hand in space' : 'Instrumental bed';
    element('space-pad').classList.toggle('engaged', present);
    element('space-cursor').style.left = `calc(24px + (100% - 48px) * ${state.depth})`;
    element('space-cursor').style.top = `calc(24px + (100% - 48px) * ${1 - state.height})`;
    element('space-invitation').hidden = present;
    element('space-invitation').textContent = this.isLeap ? this.connected ? 'Reach into the space' : 'Connect Leap to begin' : 'Move here to try it';
    element('space-sound').textContent = !running ? 'Start audio to play' : !present ? 'The room keeps playing' : state.depth > .65 ? 'Echoes & cloud' : state.height > .65 ? 'Melody in the foreground' : state.height < .35 ? 'Rhythm in the foreground' : 'Shaping the song';
    for (const axis of ['height', 'depth'] as const) { input(`space-${axis}`).value = String(state[axis]); element(`space-${axis}-value`).textContent = `${Math.round(state[axis] * 100)}%`; }
    button('space-presence-toggle').textContent = present ? 'Withdraw hand' : 'Keep hand in space';
    const deck = engine?.decks.find(d => d.stopAt === undefined), vocal = deck?.space.meters.vocals;
    let vocalRms = 0;
    if (vocal) { vocal.getFloatTimeDomainData(this.meterSamples); vocalRms = Math.sqrt(this.meterSamples.reduce((sum, v) => sum + v * v, 0) / this.meterSamples.length); }
    const voiceAvailable = deck && Object.values(deck.loaded.scene.recipes).some(r => r.vocals != null);
    element('space-material').textContent = !running ? 'Start audio to hear your movement.' : !present ? 'Instrumental playing. Reach in whenever you like.' : !voiceAvailable ? 'This passage is instrumental. Its instruments are responding.' : vocalRms > .002 ? 'Voice + instruments are responding together.' : 'The instruments are responding. Vocals join whenever the singer returns.';
  }
  private updateHealth() {
    const now = performance.now(); if (now - this.healthAt < 250) return; this.healthAt = now;
    if (!this.connected) { element('leap-quality').textContent = ''; return; }
    const h = this.leap.health, elapsed = now - h.lastReceived, stale = elapsed > Math.max(350, this.hand.graceMs);
    const fps = (value?: number) => value === undefined || !Number.isFinite(value) ? 'unknown' : value.toFixed(1);
    const age = Number.isFinite(elapsed) ? Math.round(h.frameAgeMs + elapsed) : null;
    const flags = h.deviceStatus, warnings = [];
    if (flags !== undefined) {
      if (flags & 2) warnings.push('Device paused');
      if (flags & 4) warnings.push('Infrared interference reported');
      if (flags & 8) warnings.push('Sensor window needs cleaning');
      if (flags & 16) warnings.push('Low-resource mode reported');
      if (flags >= 0xE8000000) warnings.push('Device/USB failure reported');
    }
    const explanation = stale ? 'No fresh sensor frames; check the connection.' : this.hand.status === 'outside' ? 'Hand detected outside the box. Adjust bounds in Setup if needed.'
      : this.hand.status === 'holding' ? 'Brief tracking loss; holding the last position.' : this.hand.status === 'acquiring' ? 'Confirming the hand.'
      : !h.palms ? 'No hand detected. Tracking speed may change when a hand is acquired.' : (h.trackingFps ?? 30) < 15 ? 'Tracking is slow; brief gaps are being bridged.' : 'Tracking feed is responsive.';
    element('leap-quality').textContent = `${fps(h.trackingFps)} tracking FPS \u00b7 ${Math.round(h.frameAgeMs)} ms frame delay. ${explanation}`;
    element('leap-details').textContent = `Camera ${fps(h.cameraFps)} FPS; tracking ${fps(h.trackingFps)} FPS; received ${stale ? '0.0' : fps(h.receivedFps)} FPS. Latest frame age ${age === null ? 'unknown' : age + ' ms'}. ${h.rejected} stale/invalid frames ignored; ${this.hand.rejectedJumps} position jumps held for confirmation. Loss hold ${Math.round(this.hand.graceMs)} ms. ${warnings.length ? warnings.join('. ') + '.' : flags === undefined ? 'Device warning flags unavailable.' : 'No device warning flags reported.'} Preset ${h.profile ?? 'pending'}: ${h.hintsAccepted === undefined ? 'pending' : h.hintsAccepted ? 'request accepted' : 'not supported; service defaults apply'}.`;
    this.healthHistory.push({ atMs: Math.round(now), cameraFps: h.cameraFps, trackingFps: h.trackingFps, receivedFps: stale ? 0 : h.receivedFps,
      frameAgeMs: age, rejectedFrames: h.rejected, detectedHands: h.palms, controlStatus: this.hand.status,
      presence: this.hand.state.presence, rejectedJumps: this.hand.rejectedJumps, graceMs: this.hand.graceMs, deviceStatus: flags, profile: h.profile });
    if (this.healthHistory.length > 120) this.healthHistory.shift();
  }
  dispose() { this.leap.stop(); }
}
