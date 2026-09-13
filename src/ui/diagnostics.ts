import { STEMS } from '../config';
import type { AudioEngine } from '../audio/engine';
import type { PerformanceSession } from '../music/session';
import { phase } from '../music/transport';
import { element, escapeHtml } from './controls';
export function renderStemMeters(engine: AudioEngine, sceneId: string) {
  const scene = engine.assets.scenes[sceneId]?.scene;
  element('stem-meters').innerHTML = scene ? STEMS.filter(s => scene.stems[s]).map(s => `<div class="stem-meter"><span>${escapeHtml(s)}</span><meter id="meter-${s}" min="0" max="1" value="0"></meter><span id="gain-${s}">—</span></div>`).join('') : '';
}
const meterBuffers = new WeakMap<AnalyserNode, Float32Array<ArrayBuffer>>();
function peak(meter: AnalyserNode) {
  let samples = meterBuffers.get(meter);
  if (!samples) { samples = new Float32Array(meter.fftSize); meterBuffers.set(meter, samples); }
  meter.getFloatTimeDomainData(samples); let p = 0; for (const value of samples) p = Math.max(p, Math.abs(value)); return p;
}
const text = (id: string, value: string) => { element(id).textContent = value; };
export function diagnostics(session: PerformanceSession, engine: AudioEngine, now: number) {
  const s = session.state, c = session.conditioned, p = phase(s.clock, now), deck = engine.decks.find(d => d.start <= now && (d.stopAt === undefined || d.stopAt > now));
  text('context-state', `Audio ${engine.context.state}`);
  text('smooth-value', c.smooth.toFixed(3)); text('raw-value', `Raw ${c.raw.toFixed(3)}`);
  text('tracking', c.structural ? 'Valid' : c.valid ? 'Stabilizing' : c.sustainedLoss ? 'Tracking lost · structure frozen' : 'Holding last value');
  text('age', `Age ${Number.isFinite(c.ageMs) ? Math.round(c.ageMs) : '—'} ms`);
  text('cutoff', deck ? `${Math.round(deck.cutoff.valueAt(now)).toLocaleString()} Hz` : '— Hz');
  text('current-recipe', s.currentRecipe); text('desired-recipe', s.desiredRecipe); text('pending-recipe', s.pendingRecipe?.recipe ?? '—'); text('committed-recipe', s.committedRecipe?.recipe ?? '—');
  text('bar', s.running ? `Loop ${p.loops + 1} · bar ${p.bar}/${s.clock.loopBars} · beat ${p.beat}` : 'Stopped');
  const phaseBar = element('phase'); phaseBar.setAttribute('aria-valuenow', String(Math.round(p.fraction * 100))); (phaseBar.firstElementChild as HTMLElement).style.width = s.running ? `${p.fraction * 100}%` : '0%';
  const boundary = s.committedRecipe?.end ?? s.pendingRecipe?.end;
  text('boundary', boundary === undefined ? 'Next boundary —' : `Recipe in ${Math.max(0, boundary - now).toFixed(2)} s`);
  const transition = s.committedAdvance ?? s.pendingAdvance;
  text('transition', transition ? `${s.committedAdvance ? 'Committed' : 'Pending'} → ${transition.to ?? 'next'}${transition.at ? ` · ${Math.max(0, transition.at - now).toFixed(2)} s` : ''}` : 'No scene transition');
  text('gesture', session.gesture.armed ? `Advance armed · hold above 0.92${(s.timing ?? 'authored') === 'authored' ? ' after one loop' : ''}` : 'Advance disarmed · hold below 0.75 to rearm');
  element<HTMLProgressElement>('hold-progress').value = session.gesture.progress;
  for (const id of STEMS) if (deck?.stems[id] && document.getElementById(`meter-${id}`)) {
    const gain = session.space.enabled ? deck.space.levels[id]!.valueAt(now) : deck.stems[id]!.envelope.valueAt(now);
    element<HTMLMeterElement>(`meter-${id}`).value = session.space.enabled ? peak(deck.space.meters[id]!) * gain : peak(deck.stems[id]!.meter);
    text(`gain-${id}`, gain > 0 ? session.space.enabled ? `${Math.round(gain * 100)}% hand mix` : `${(20 * Math.log10(gain)).toFixed(1)} dB` : 'muted');
  } else if (document.getElementById(`meter-${id}`)) {
    element<HTMLMeterElement>(`meter-${id}`).value = 0; text(`gain-${id}`, '—');
  }
  const output = peak(engine.meter); element<HTMLMeterElement>('master-meter').value = output;
  text('peak', output > 0 ? `${(20 * Math.log10(output)).toFixed(1)} dBFS` : '−∞ dBFS');
  text('nodes', `${engine.decks.length} decks · ${engine.decks.reduce((n, d) => n + Object.keys(d.stems).length, 0)} sources`);
}
