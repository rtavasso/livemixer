import './style.css';
import { names, defaults, musicRelay, normalize, smooth, stutterCount, type Control, type Controls, type Source } from './controls';
import { BROADCAST_CHANNEL_NAME, type TelemetryFrame, type TelemetrySchema } from '../sim/telemetry/types';
import { AXES, CONTRACT_SIGNALS, Governor, isLivingSchema, toLiveControls, type Axis, type LiveFx, type LivingSignals } from '../living/governor';

const labels: Record<Control, string> = { vocals: 'Vocal presence', space: 'Reverb', stutter: 'Beat repeat', gain: 'Mix gain' };
const descriptions: Record<Control, string> = { vocals: 'Silence to full vocals', space: 'Dry to 20% wet', stutter: '1/16-note slices · up to one beat · 4+ beats dry', gain: '−12 dB to unity' };
const axisLabels: Record<Axis, string> = { vocals: 'Vocals', arrangement: 'Arrangement · rhythm ↔ textures', depth: 'Depth · underwater', space: 'Space', allowance: 'Allowance' };
function meter(id: string, label: string) { return `<div class="meter"><span>${label}</span><i><b id="${id}"></b></i><output id="${id}-value">0%</output></div>`; }
const app = document.querySelector<HTMLElement>('#app')!;
app.innerHTML = `<header><a href="/sim.html" target="_blank">LiveMixer ↗ Simulation</a><p class="eyebrow">ABLETON LIVE</p><h1>Shape the mix.</h1><p>Back To Us <span>74 BPM</span> → Ladders <span>104 BPM</span></p></header>
<section class="connection"><button id="connect">Connect to Live</button><span id="status" role="status">Disconnected</span><button id="release" class="quiet">Release & reset</button></section>
<section class="mode"><label>Control source <select id="mode"><option value="living">Living</option><option value="manual">Manual</option><option value="simulation">Simulation</option></select></label><span id="simulation">Open a simulation in another tab.</span></section>
<section class="living" id="living" hidden><div><h3>The song</h3>${AXES.map(axis => meter(`axis-${axis}`, axisLabels[axis])).join('')}</div><div><h3>From the simulation</h3>${CONTRACT_SIGNALS.map(key => meter(`signal-${key}`, key)).join('')}</div></section>
<section class="controls">${names.map(name => `<article><h2>${labels[name]}</h2><output id="${name}-value"></output><input id="${name}" aria-label="${labels[name]}" type="range" min="0" max="1" step="0.001" value="${defaults[name]}"><p>${descriptions[name]}</p><label class="route" hidden>Simulation signal <select id="${name}-source" aria-label="${labels[name]} signal"></select></label></article>`).join('')}</section>
<section class="cycle"><strong id="cycle">Repeat is off</strong><span id="clock">Start playback in Ableton. Song order and tempo follow the arrangement.</span></section>
<p class="help">If the connection stays unavailable, run <code>uv run scripts/ableton-bridge.py</code> and open the prepared Live set.</p>`;
const channel = new BroadcastChannel(BROADCAST_CHANNEL_NAME);
const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const route: Record<Control, string> = { vocals: 'input.presence', space: 'input.activity', stutter: 'input.activity', gain: 'constant' };
try { const saved = JSON.parse(localStorage.getItem('livemixer-ableton-routes') ?? '{}'); for (const name of names) if (typeof saved[name] === 'string') route[name] = saved[name]; } catch { /* use defaults */ }
let value: Controls = { ...defaults }, socket: WebSocket | null = null, schema: TelemetrySchema | null = null;
let frame: TelemetryFrame | null = null, lastFrame = 0, lastUpdate = performance.now(), lastSchemaId = '';
let stale = false, fx: LiveFx | null = null, modeChosen = false;
const governor = new Governor();
const mode = element<HTMLSelectElement>('mode');
mode.value = 'manual';
const status = element('status');

function drawValues() {
  for (const name of names) {
    element<HTMLInputElement>(name).value = String(value[name]);
    const count = stutterCount(value.stutter);
    element<HTMLOutputElement>(`${name}-value`).value = name === 'stutter' ? `${count} ${count === 1 ? 'stutter' : 'stutters'}` : `${Math.round(value[name] * 100)}%`;
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
  const axes = governor.value;
  for (const axis of AXES) setMeter(`axis-${axis}`, axes[axis]);
  for (const key of CONTRACT_SIGNALS) setMeter(`signal-${key}`, signals[key]);
}
function setMeter(id: string, amount: number | undefined) {
  const valid = typeof amount === 'number' && Number.isFinite(amount);
  element(id).style.width = `${valid ? Math.max(0, Math.min(1, amount)) * 100 : 0}%`;
  element<HTMLOutputElement>(`${id}-value`).value = valid ? `${Math.round(amount * 100)}%` : '—';
}
function send() {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(fx ? { type: 'controls', ...value, fx } : { type: 'controls', ...value }));
}
function reset() {
  modeChosen = true; mode.value = 'manual'; value = { ...defaults }; fx = null; governor.release(); updateMode(); drawValues();
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'release' }));
}
function updateMode() {
  document.querySelectorAll<HTMLElement>('.route').forEach(el => { el.hidden = mode.value !== 'simulation'; });
  element('living').hidden = mode.value !== 'living';
  for (const name of names) element<HTMLInputElement>(name).disabled = mode.value === 'living' || (mode.value === 'simulation' && route[name] !== 'constant');
  if (mode.value !== 'living') { fx = null; governor.release(); }
}
function livingSignals(current: TelemetryFrame): LivingSignals {
  const signals: LivingSignals = {};
  for (const key of CONTRACT_SIGNALS) signals[key] = current.sim.signals[key];
  if (!Number.isFinite(signals.presence)) signals.presence = current.input.presence;
  return signals;
}
function update(now = performance.now()) {
  if (mode.value === 'simulation' || mode.value === 'living') {
    if (!frame || now - lastFrame > 750 || frame.input.sourceAgeMs > 750) {
      if (!stale && socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'release' }));
      stale = true;
      value = { ...defaults }; fx = null; governor.release();
      if (mode.value === 'living') drawLiving({});
      element('simulation').textContent = 'Waiting for fresh simulation input…';
    } else if (mode.value === 'living') {
      stale = false;
      const signals = livingSignals(frame);
      const live = toLiveControls(governor.step(signals, (now - lastUpdate) / 1000));
      value = { vocals: live.vocals, space: live.space, stutter: live.stutter, gain: live.gain }; fx = live.fx;
      drawLiving(signals);
      element('simulation').textContent = `${schema?.sim.title ?? frame.sim.id} · living${isLivingSchema(frame.sim.signals) ? '' : ' · missing contract signals, holding home'}`;
    } else {
      stale = false;
      for (const name of names) {
        if (route[name] === 'constant') continue;
        let source: Source | undefined;
        if (route[name] === 'input.presence') source = { value: frame.input.presence, min: 0, max: 1 };
        else if (route[name] === 'input.activity') source = { value: frame.input.activity, min: 0, max: 1 };
        else {
          const key = route[name].slice(7), spec = schema?.sim.id === frame.sim.id ? schema.sim.signals[key] : undefined;
          if (spec) source = { value: frame.sim.signals[key], min: spec.min, max: spec.max };
        }
        value[name] = smooth(value[name], normalize(source, defaults[name]), now - lastUpdate);
      }
      element('simulation').textContent = `${schema?.sim.title ?? frame.sim.id} · input connected`;
    }
  }
  lastUpdate = now; drawValues(); send();
}
for (const name of names) {
  element<HTMLInputElement>(name).addEventListener('input', event => { value[name] = Number((event.target as HTMLInputElement).value); drawValues(); send(); });
  element<HTMLSelectElement>(`${name}-source`).addEventListener('change', event => {
    route[name] = (event.target as HTMLSelectElement).value; localStorage.setItem('livemixer-ableton-routes', JSON.stringify(route)); updateMode();
  });
}
mode.addEventListener('change', () => { modeChosen = true; updateMode(); update(); });
element('release').addEventListener('click', reset);
element('connect').addEventListener('click', () => {
  if (socket) { socket.close(); socket = null; return; }
  status.textContent = 'Connecting…';
  const connection = new WebSocket('ws://127.0.0.1:9001'); socket = connection;
  connection.onopen = () => { element('connect').textContent = 'Disconnect'; send(); };
  connection.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message.type === 'error') { status.textContent = message.message; return; }
    if (message.type !== 'status') return;
    status.textContent = message.live ? 'Live connected' : 'Bridge connected · waiting for Live device';
    status.dataset.ready = String(message.live);
    const state = message.state;
    // Relay Live's transport to the simulation page (it estimates tempo from successive beats).
    const music = musicRelay(state);
    if (music) channel.postMessage(music);
    if (state) {
      element('cycle').textContent = state.repeat ? `Quick stutter · ${Math.ceil(state.onLeft * 4)} slices left` : state.offLeft > 0 ? `Dry · ${Math.ceil(state.offLeft)} beats until ready` : value.stutter > 0 ? 'Waiting for the next beat' : 'Repeat is off';
      const bar = Math.floor(state.beat / 4) + 1, beat = Math.floor(state.beat % 4) + 1;
      element('clock').textContent = state.playing ? `Playing · ${bar}.${beat} · ${state.beat < 308 ? 'Back To Us' : 'Ladders'}` : 'Stopped in Ableton';
    }
  };
  connection.onclose = () => { if (socket === connection) socket = null; status.textContent = 'Disconnected'; status.dataset.ready = 'false'; element('connect').textContent = 'Connect to Live'; };
  connection.onerror = () => { status.textContent = 'Start the local Live bridge to connect.'; };
});
channel.onmessage = event => {
  if (event.data?.direction !== 'outbound') return;
  const message = event.data.message;
  if (message?.type === 'schema' && message.v === 1 && message.sim?.signals) {
    schema = message; sources();
    // Living is the default whenever the simulation speaks the living contract, until the operator picks a mode.
    if (!modeChosen) { mode.value = isLivingSchema(message.sim.signals) ? 'living' : 'manual'; updateMode(); }
  }
  else if (message?.type === 'frame' && message.v === 1 && message.input && message.sim?.signals) {
    frame = message; lastFrame = performance.now();
    if (message.sim.id !== lastSchemaId) { lastSchemaId = message.sim.id; channel.postMessage({ direction: 'inbound', message: { type: 'get-schema' } }); }
    if (mode.value !== 'manual') update(lastFrame);
  }
};
channel.postMessage({ direction: 'inbound', message: { type: 'get-schema' } });
window.addEventListener('pagehide', () => { if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'release' })); socket?.close(); channel.close(); });
setInterval(() => update(), 100);
sources(); updateMode(); drawValues();
