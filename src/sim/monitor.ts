/**
 * Telemetry monitor: open `telemetry.html` in a second tab next to `sim.html`
 * and watch the stream the audio project will receive. It is deliberately
 * tiny and dependency-free so it can be copied as the seed of the mapping
 * project. It listens on the BroadcastChannel and can send commands back.
 *
 * The DOM is built once per schema and only values are updated per frame, so
 * controls stay stable under the pointer.
 */
import './ui/monitor.css';
import { BROADCAST_CHANNEL_NAME, type TelemetryFrame, type TelemetryOutbound, type TelemetrySchema } from './telemetry/types';

const root = document.getElementById('monitor') as HTMLElement;
const channel = new BroadcastChannel(BROADCAST_CHANNEL_NAME);
const send = (message: unknown) => channel.postMessage({ direction: 'inbound', message });

let schema: TelemetrySchema | null = null;
let frame: TelemetryFrame | null = null;
let frames = 0, lastSecond = 0, rate = 0, framesThisSecond = 0;
const log: string[] = [];
const smoothed: Record<string, number> = {};
let builtFor = '';

channel.onmessage = ({ data }) => {
  if (!data || data.direction !== 'outbound') return;
  const message = data.message as TelemetryOutbound;
  if (message.type === 'schema') { schema = message; log.unshift(`schema: ${message.sim.title} (${Object.keys(message.sim.signals).length} signals, ${Object.keys(message.sim.params).length} params)`); }
  else if (message.type === 'frame') {
    frame = message; frames++; framesThisSecond++;
    const second = Math.floor(performance.now() / 1000);
    if (second !== lastSecond) { rate = framesThisSecond; framesThisSecond = 0; lastSecond = second; }
    for (const e of message.input.events) log.unshift(`${message.t.toFixed(2)}s ${e.type}${'direction' in e ? ` ${e.direction}` : ''} hand #${e.handId}`);
    // Example of the kind of smoothing an audio mapping would do: one-pole toward each signal.
    for (const [name, value] of Object.entries(message.sim.signals)) smoothed[name] = (smoothed[name] ?? value) + .25 * (value - (smoothed[name] ?? value));
  } else if (message.type === 'status') log.unshift(`${message.level}: ${message.message}`);
  if (log.length > 40) log.length = 40;
};
send({ type: 'get-schema' });

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag); if (className) node.className = className; if (text) node.textContent = text; return node;
}
interface Bar { fill: HTMLElement; value: HTMLElement; min: number; max: number; unit: string }
function bar(name: string, min: number, max: number, unit = ''): { row: HTMLElement; bar: Bar } {
  const row = el('div', 'bar'), track = el('div', 'track'), fill = el('i'), value = el('span', 'value');
  row.append(el('span', 'name', name), track, value); track.append(fill);
  return { row, bar: { fill, value, min, max, unit } };
}
function setBar(b: Bar, v: number) {
  const t = Math.max(0, Math.min(1, (v - b.min) / (b.max - b.min)));
  b.fill.style.width = `${(t * 100).toFixed(1)}%`; b.value.textContent = `${v.toFixed(3)}${b.unit ? ` ${b.unit}` : ''}`;
}

const view = { meta: el('div', 'meta'), raw: new Map<string, Bar>(), smooth: new Map<string, Bar>(), presence: null as Bar | null, activity: null as Bar | null, hands: el('tbody'), paramValues: new Map<string, HTMLElement>(), paramInputs: new Map<string, HTMLInputElement>(), simButtons: new Map<string, HTMLButtonElement>(), log: el('pre') };

function build(s: TelemetrySchema) {
  view.raw.clear(); view.smooth.clear(); view.paramValues.clear(); view.paramInputs.clear(); view.simButtons.clear();
  const header = el('header'), title = el('div'); title.append(el('h1', '', s.sim.title), el('p', 'muted', s.sim.description)); header.append(title, view.meta);
  const section = (heading: string) => { const sec = el('section'); sec.append(el('h2', '', heading)); return sec; };
  const raw = section('Signals (raw)'), smooth = section('Signals (smoothed here, as a mapper might)');
  for (const [name, spec] of Object.entries(s.sim.signals)) {
    const a = bar(name, spec.min, spec.max, spec.unit); raw.append(a.row); view.raw.set(name, a.bar);
    const b = bar(name, spec.min, spec.max); smooth.append(b.row); view.smooth.set(name, b.bar);
  }
  const presence = section('Presence');
  const p = bar('presence', 0, 1), a = bar('activity', 0, 1); view.presence = p.bar; view.activity = a.bar;
  const table = el('table'), head = el('tr'); for (const h of ['hand', 'x', 'y', 'z', 'speed', 'open', 'push']) head.append(el('th', '', h));
  const thead = el('thead'); thead.append(head); table.append(thead, view.hands); presence.append(p.row, a.row, table);
  const params = section('Parameters (editable; sent back with set-param)');
  for (const [name, spec] of Object.entries(s.sim.params)) {
    const row = el('div', 'param'), label = el('span', 'name', spec.label ?? name), value = el('span', 'value'); label.title = spec.description ?? '';
    let control: HTMLElement;
    if (spec.kind === 'number') { const input = el('input'); input.type = 'range'; input.dataset.param = name; input.min = String(spec.min); input.max = String(spec.max); input.step = String(spec.step ?? (spec.max - spec.min) / 200); input.addEventListener('input', () => send({ type: 'set-param', name, value: Number(input.value) })); view.paramInputs.set(name, input); control = input; }
    else if (spec.kind === 'boolean') { const input = el('input'); input.type = 'checkbox'; input.dataset.param = name; input.addEventListener('change', () => send({ type: 'set-param', name, value: input.checked })); view.paramInputs.set(name, input); control = input; }
    else control = el('code');
    row.append(label, control, value); params.append(row); view.paramValues.set(name, value);
  }
  const sims = section('Simulations');
  for (const sim of s.sims) { const button = el('button', '', sim.title); button.addEventListener('click', () => send({ type: 'select-sim', id: sim.id })); sims.append(button, document.createTextNode(' ')); view.simButtons.set(sim.id, button); }
  const events = section('Events & status'); events.append(view.log);
  root.replaceChildren(header, raw, smooth, presence, params, sims, events);
}

function update() {
  requestAnimationFrame(update);
  if (!schema) { if (builtFor !== 'waiting') { builtFor = 'waiting'; root.replaceChildren(el('h1', '', 'Simulation telemetry'), el('p', 'muted', `Waiting for sim.html in another tab of this browser (BroadcastChannel “${BROADCAST_CHANNEL_NAME}”).`)); } return; }
  const key = `${schema.sim.id}:${Object.keys(schema.sim.params).join(',')}:${Object.keys(schema.sim.signals).join(',')}`;
  if (key !== builtFor) { builtFor = key; build(schema); }
  view.meta.textContent = `${frames} frames · ${rate} Hz · source ${frame?.input.source ?? '–'} · ${frame?.perf.fps ?? 0} fps`;
  for (const [name, b] of view.raw) setBar(b, frame?.sim.signals[name] ?? b.min);
  for (const [name, b] of view.smooth) setBar(b, smoothed[name] ?? b.min);
  if (view.presence) setBar(view.presence, frame?.input.presence ?? 0);
  if (view.activity) setBar(view.activity, frame?.input.activity ?? 0);
  const rows = frame?.input.hands ?? [];
  while (view.hands.children.length > rows.length) view.hands.lastElementChild?.remove();
  while (view.hands.children.length < rows.length) { const tr = el('tr'); for (let i = 0; i < 7; i++) tr.append(el('td')); view.hands.append(tr); }
  rows.forEach((h, i) => { const cells = view.hands.children[i].children; const values = [`#${h.id}`, h.x.toFixed(2), h.y.toFixed(2), h.z.toFixed(2), h.speed.toFixed(2), h.openness.toFixed(1), h.push.toFixed(2)]; values.forEach((v, j) => { if (cells[j].textContent !== v) cells[j].textContent = v; }); });
  for (const [name, spec] of Object.entries(schema.sim.params)) {
    const value = frame?.sim.params[name] ?? spec.default;
    view.paramValues.get(name)!.textContent = typeof value === 'number' ? value.toFixed(3) : String(value);
    const input = view.paramInputs.get(name);
    if (input && document.activeElement !== input) { if (input.type === 'checkbox') input.checked = Boolean(value); else if (input.value !== String(value)) input.value = String(value); }
    if (!input) { const code = view.paramValues.get(name)!.previousElementSibling; if (code && code.textContent !== String(value)) code.textContent = String(value); }
  }
  for (const [id, button] of view.simButtons) button.classList.toggle('active', id === schema.sim.id);
  const text = log.join('\n'); if (view.log.textContent !== text) view.log.textContent = text;
}
update();
