import './style.css';
import { names, defaults, bridgeStatus, musicRelay, stutterCount, type Control } from './controls';
import { BROADCAST_CHANNEL_NAME, type TelemetryFrame, type TelemetrySchema } from '../sim/telemetry/types';
import { AXES, CONTRACT_SIGNALS, isLivingSchema, type Axis, type LivingSignals } from '../living/governor';
import { ControlsCore, type Mode, type Outgoing } from './page';
import { BridgeLink, initialWanted, WANTED_KEY, type LinkState, type SocketLike } from './link';

const labels: Record<Control, string> = { vocals: 'Vocal presence', space: 'Reverb', stutter: 'Beat repeat', gain: 'Mix gain' };
const descriptions: Record<Control, string> = { vocals: 'Silence to full vocals', space: 'Dry to 20% wet', stutter: '1/16-note slices · up to one beat · 4+ beats dry', gain: '−12 dB to unity' };
const axisLabels: Record<Axis, string> = { vocals: 'Vocals', arrangement: 'Arrangement · rhythm ↔ textures', depth: 'Depth · underwater', space: 'Space', allowance: 'Allowance' };
function meter(id: string, label: string) { return `<div class="meter"><span>${label}</span><i><b id="${id}"></b></i><output id="${id}-value">0%</output></div>`; }
const app = document.querySelector<HTMLElement>('#app')!;
app.innerHTML = `<header><a href="/sim.html" target="_blank">LiveMixer ↗ Simulation</a><p class="eyebrow">ABLETON LIVE</p><h1>Shape the mix.</h1><p>Back To Us <span>74 BPM</span> → Ladders <span>104 BPM</span></p></header>
<section class="connection"><button id="connect">Connect to Live</button><span id="status" role="status">Disconnected</span><span id="vocals-live" hidden></span><button id="release" class="quiet">Release & reset</button></section>
<section class="mode"><label>Control source <select id="mode"><option value="living">Living</option><option value="manual">Manual</option><option value="simulation">Simulation</option></select></label><span id="simulation">Open a simulation in another tab.</span></section>
<section class="living" id="living" hidden><div><h3>The song</h3>${AXES.map(axis => meter(`axis-${axis}`, axisLabels[axis])).join('')}</div><div><h3>From the simulation</h3>${CONTRACT_SIGNALS.map(key => meter(`signal-${key}`, key)).join('')}</div></section>
<section class="controls">${names.map(name => `<article><h2>${labels[name]}</h2><output id="${name}-value"></output><input id="${name}" aria-label="${labels[name]}" type="range" min="0" max="1" step="0.001" value="${defaults[name]}"><p>${descriptions[name]}</p><label class="route" hidden>Simulation signal <select id="${name}-source" aria-label="${labels[name]} signal"></select></label></article>`).join('')}</section>
<section class="cycle"><strong id="cycle">Repeat is off</strong><span id="clock">Start playback in Ableton. Song order and tempo follow the arrangement.</span></section>
<p class="help">If the connection stays unavailable, run <code>uv run scripts/ableton-bridge.py</code> and open the prepared Live set.</p>`;
const channel = new BroadcastChannel(BROADCAST_CHANNEL_NAME);
const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const savedRoute: Partial<Record<Control, string>> = {};
try { const saved = JSON.parse(localStorage.getItem('livemixer-ableton-routes') ?? '{}'); for (const name of names) if (typeof saved[name] === 'string') savedRoute[name] = saved[name]; } catch { /* use defaults */ }
let schema: TelemetrySchema | null = null;
let frame: TelemetryFrame | null = null, lastFrame = 0, lastSchemaId = '';
let storedWanted: string | null = null;
try { storedWanted = localStorage.getItem(WANTED_KEY); } catch { /* storage unavailable */ }
// A show launcher opens ableton.html?connect=1; otherwise the operator's last Connect / Disconnect survives a reload.
const connectAtLoad = initialWanted(location.search, storedWanted);
const mode = element<HTMLSelectElement>('mode');
// Unattended start: Living, at home (vocals off). Every mode starts at home; the first message is a fresh tick's.
const core = new ControlsCore({ mode: connectAtLoad ? 'living' : 'manual', now: performance.now(), route: savedRoute });
const route = core.route, living = core.living;
mode.value = core.mode;
const status = element('status');
// This window's ownership of the bridge (null until a bridge reports it), kept across statuses that omit it.
let owner: boolean | null = null;

function drawValues() {
  for (const name of names) {
    element<HTMLInputElement>(name).value = String(core.value[name]);
    const count = stutterCount(core.value.stutter);
    element<HTMLOutputElement>(`${name}-value`).value = name === 'stutter' ? `${count} ${count === 1 ? 'stutter' : 'stutters'}` : `${Math.round(core.value[name] * 100)}%`;
  }
}
function sources() {
  const list = [['constant', 'Manual value'], ['input.presence', 'Hand presence'], ['input.activity', 'Hand motion'],
    ...Object.keys(schema?.sim.signals ?? {}).map(key => [`signal.${key}`, key])];
  for (const name of names) {
    const select = element<HTMLSelectElement>(`${name}-source`);
    select.replaceChildren(...list.map(([key, label]) => new Option(label, key)));
    if (!list.some(([key]) => key === route[name])) route[name] = name === 'gain' ? 'constant' : 'input.activity';
    select.value = route[name];
  }
}
function drawLiving(signals: LivingSignals) {
  const axes = living.governor.value;
  for (const axis of AXES) setMeter(`axis-${axis}`, axes[axis]);
  for (const key of CONTRACT_SIGNALS) setMeter(`signal-${key}`, signals[key]);
}
function setMeter(id: string, amount: number | undefined) {
  const valid = typeof amount === 'number' && Number.isFinite(amount);
  element(id).style.width = `${valid ? Math.max(0, Math.min(1, amount)) * 100 : 0}%`;
  element<HTMLOutputElement>(`${id}-value`).value = valid ? `${Math.round(amount * 100)}%` : '—';
}
function transmit(messages: (Outgoing | null)[]) { for (const message of messages) if (message) link.send(message); }
// Release & reset keeps the current mode (and automatic choice, if the operator never picked one) and starts from home.
function reset() { const messages = core.reset(); updateMode(); drawValues(); transmit(messages); }
function updateMode() {
  mode.value = core.mode;
  document.querySelectorAll<HTMLElement>('.route').forEach(el => { el.hidden = core.mode !== 'simulation'; });
  element('living').hidden = core.mode !== 'living';
  for (const name of names) element<HTMLInputElement>(name).disabled = core.mode === 'living' || (core.mode === 'simulation' && route[name] !== 'constant');
}
// One tick: the decisions (src/ableton/page.ts), then the display, then the messages.
function update(now = performance.now()) {
  const tick = core.tick(frame, lastFrame, now, schema);
  const result = tick.living;
  if (result) {
    drawLiving(result.signals);
    const title = schema?.sim.title ?? frame?.sim.id ?? 'Simulation';
    const after = result.released ? 'released to the bridge until input returns' : 'drifting home';
    element('simulation').textContent =
      result.state === 'fresh' ? `${title} · living${isLivingSchema(frame!.sim.signals) ? '' : ' · hand only (no scene signals)'}`
      : result.state === 'input-stale' ? `${title} · ${frame!.input.sourceAgeMs < 0 ? 'hand input not connected yet' : 'hand input stalled'} · ${after}`
      : `Waiting for the simulation · ${after}`;
  } else if (tick.simulation === 'stale') element('simulation').textContent = 'Waiting for fresh simulation input… (released to the bridge)';
  else if (tick.simulation === 'connected') element('simulation').textContent = `${schema?.sim.title ?? frame!.sim.id} · input connected`;
  drawValues(); transmit(tick.messages);
}
for (const name of names) {
  element<HTMLInputElement>(name).addEventListener('input', event => { const message = core.setManual(name, Number((event.target as HTMLInputElement).value)); drawValues(); transmit([message]); });
  element<HTMLSelectElement>(`${name}-source`).addEventListener('change', event => {
    route[name] = (event.target as HTMLSelectElement).value;
    try { localStorage.setItem('livemixer-ableton-routes', JSON.stringify(route)); } catch { /* storage unavailable */ }
    updateMode();
  });
}
mode.addEventListener('change', () => { core.setMode(mode.value as Mode, true); updateMode(); update(); });
element('release').addEventListener('click', reset);
// Once wanted (Connect, ?connect=1 or the stored choice), a dropped bridge (restarted, or briefly down) is retried
// every 2 s until it is back, so the vocals and effects never go silently dead; Disconnect stops that.
let linkState: LinkState = 'disconnected', everOpen = false;
const link = new BridgeLink({
  open: () => new WebSocket('ws://127.0.0.1:9001') as unknown as SocketLike,
  onState: state => {
    const previous = linkState; linkState = state;
    status.dataset.ready = 'false';
    element('connect').textContent = state === 'disconnected' ? 'Connect to Live' : 'Disconnect';
    if (state === 'open') { everOpen = true; owner = null; status.textContent = 'Bridge connected · waiting for Live device'; }
    else if (state === 'disconnected') status.textContent = 'Disconnected';
    else if (state === 'reconnecting' || previous === 'reconnecting') {
      status.textContent = everOpen ? 'Bridge restarting · reconnecting…' : 'Bridge not running · retrying every 2 s (uv run scripts/ableton-bridge.py)';
    } else status.textContent = 'Connecting…';
  },
  // A fresh tick, so the first message on a (re)connect is the current mode's value now (home at load).
  onOpen: () => update(),
  onMessage: data => {
    let message: any;
    try { message = JSON.parse(String(data)); } catch { return; }
    if (message?.type === 'error') { status.textContent = String(message.message); return; }
    if (message?.type !== 'status') return;
    const view = bridgeStatus(message, owner);
    owner = view.owner;
    status.textContent = view.text;
    status.dataset.ready = String(view.ready);
    const vocalsLive = element('vocals-live');
    vocalsLive.hidden = view.vocalsInLive === null;
    vocalsLive.textContent = view.vocalsInLive === null ? '' : `Vocals in Live: ${view.vocalsInLive ? 'on' : 'off'}`;
    const state = message.state;
    // Relay Live's transport to the simulation page (it estimates tempo from successive beats).
    const music = musicRelay(state);
    if (music) channel.postMessage(music);
    if (state) {
      element('cycle').textContent = state.repeat ? `Quick stutter · ${Math.ceil(state.onLeft * 4)} slices left` : state.offLeft > 0 ? `Dry · ${Math.ceil(state.offLeft)} beats until ready` : core.value.stutter > 0 ? 'Waiting for the next beat' : 'Repeat is off';
      const bar = Math.floor(state.beat / 4) + 1, beat = Math.floor(state.beat % 4) + 1;
      element('clock').textContent = state.playing ? `Playing · ${bar}.${beat} · ${state.beat < 308 ? 'Back To Us' : 'Ladders'}` : 'Stopped in Ableton';
    }
  },
});
element('connect').addEventListener('click', () => {
  const wanted = !link.wanted;
  try { localStorage.setItem(WANTED_KEY, wanted ? '1' : '0'); } catch { /* storage unavailable */ }
  if (wanted) link.start(); else link.stop();
});
channel.onmessage = event => {
  if (event.data?.direction !== 'outbound') return;
  const message = event.data.message;
  if (message?.type === 'schema' && message.v === 1 && message.sim?.signals) {
    schema = message; sources();
    // Living is the default whenever the simulation speaks the living contract, until the operator picks a mode; a
    // schema without it never drops the page out of Living (see ControlsCore.onSchema).
    if (core.onSchema(message)) { updateMode(); update(); }
  }
  else if (message?.type === 'frame' && message.v === 1 && message.input && message.sim?.signals) {
    frame = message; lastFrame = performance.now();
    if (message.sim.id !== lastSchemaId) { lastSchemaId = message.sim.id; channel.postMessage({ direction: 'inbound', message: { type: 'get-schema' } }); }
    if (core.mode !== 'manual') update(lastFrame);
  }
};
channel.postMessage({ direction: 'inbound', message: { type: 'get-schema' } });
window.addEventListener('pagehide', () => { link.send({ type: 'release' }); link.stop(); channel.close(); });
setInterval(() => update(), 100);
sources(); updateMode(); update();
if (connectAtLoad) link.start();
