import type { Scene } from '../config';
import type { PerformanceSession } from '../music/session';
import { button, element, select } from './controls';

// Keep the authoring instrument available, but give visitors a small playing surface.
export function mountPerformance() {
  const app = element('app'), tools = document.createElement('details');
  tools.id = 'studio-tools'; tools.className = 'studio-tools';
  tools.open = new URLSearchParams(location.search).get('tools') === '1';
  tools.innerHTML = '<summary>Studio tools <span>Sound design, imports, audio checks and diagnostics</span></summary>';
  app.append(tools);
  const section = (title: string, description: string) => {
    const box = document.createElement('section'); box.className = 'panel';
    box.innerHTML = `<h2>${title}</h2><p class="subtle">${description}</p>`; tools.append(box); return box;
  };
  const imports = section('Audio files & test signals', 'Test signals are sine tones for checking the engine. They are not songs or additional musical passages.');
  imports.append(element('load-fixtures').parentElement!, app.querySelector('.mode-row')!);
  button('load-fixtures').textContent = 'Load engineering tones';
  const sound = app.querySelector<HTMLElement>('.control-panel')!;
  sound.querySelector('h2')!.textContent = 'Sound shape';
  select('adapter').parentElement!.firstChild!.textContent = 'Control with ';
  select('adapter').querySelector('option[value="slider"]')!.textContent = 'Mouse / touch';
  select('adapter').querySelector('option[value="camera"]')!.textContent = 'Camera / hand';
  select('adapter').querySelector<HTMLOptionElement>('option[value="replay"]')!.hidden = true;
  element('openness').setAttribute('aria-label', 'Sound shape');
  sound.querySelector('.range-labels')!.innerHTML = '<span>Muffled</span><span>Full & clear</span>';
  const mappings = section('How movement changes the sound', '<strong>Tone</strong> means the color of the sound: muffled to clear. <strong>Arrangement</strong> means which stems are audible. The normal playing view keeps these separate.');
  for (const node of [...sound.querySelectorAll('.value-row,.input-details,.setting-row'), element('hold-progress'), element('gesture')]) mappings.append(node);
  select('mapping').innerHTML = '<option value="timbre_only">Tone only (separate vocal button)</option><option value="structure_only">Arrangement only (tone fixed)</option><option value="combined">Tone + arrangement together</option>';
  const explanation = document.createElement('p'); explanation.className = 'subtle';
  explanation.textContent = 'Filter bypass removes the tone effect. Metronome adds a timing click. Hold-to-advance lets a sustained high hand position request the next passage.';
  mappings.append(explanation);
  const amount = document.createElement('div'); amount.className = 'sound-amount';
  amount.innerHTML = '<output id="sound-amount">30%</output><span id="sound-character">Warm & soft</span>';
  sound.querySelector('.section-heading')!.after(amount);
  const help = document.createElement('p'); help.id = 'sound-help'; help.className = 'performance-help';
  element('openness').before(help);
  const cameraHelp = document.createElement('p'); cameraHelp.className = 'subtle';
  cameraHelp.textContent = 'Camera moves this same Sound shape control. Open Camera setup below to calibrate your hand.';
  const camera = element('camera-panel'), cameraSetup = document.createElement('details');
  cameraSetup.innerHTML = '<summary>Camera setup</summary>';
  while (camera.firstChild) cameraSetup.append(camera.firstChild);
  camera.append(cameraHelp, cameraSetup);
  const arrangement = app.querySelector<HTMLElement>('[aria-label="Arrangement"]')!;
  const meters = section('Arrangement details', 'Recipes are saved stem-level combinations. Current is audible now; Desired is requested; Pending waits for a phrase; Committed is already scheduled.');
  meters.append(element('cancel'));
  for (const node of [...arrangement.querySelectorAll('.recipe-state,.recipe-buttons'), element('stem-meters'), arrangement.querySelector('.master-meter')!, element('nodes')]) meters.append(node);
  arrangement.classList.add('vocal-panel'); arrangement.setAttribute('aria-label', 'Vocals');
  arrangement.innerHTML = '<span class="eyebrow">THE HUMAN LAYER</span><h2>Vocals</h2><div id="voice-state" class="voice-state">Instrumental</div><p id="voice-feedback" class="performance-help">Start audio, then invite the voice in.</p><button id="vocal-toggle" class="primary" disabled>Bring in vocals</button><p id="voice-help" class="subtle">Vocals enter and leave at a complete phrase boundary. The instrumental keeps playing.</p>';
  const chooser = document.createElement('label'); chooser.className = 'passage-picker';
  app.querySelector('.transport .eyebrow')!.textContent = 'MUSIC PASSAGE';
  chooser.innerHTML = 'Passage <select id="performance-scene" aria-label="Passage" disabled></select>';
  element('scene-meta').after(chooser);
  button('next').textContent = 'Next passage';
  meters.append(element('boundary'), element('transition'));
  const passage = document.createElement('span'); passage.id = 'passage-feedback';
  app.querySelector('.transport-bottom')!.append(passage);
  tools.append(app.querySelector('[aria-label="Trace and replay"]')!, element('author-panel'));
  app.querySelector('footer')!.before(tools);
  app.querySelector('footer')!.textContent = 'Your music stays on this computer.';
  const notice = document.createElement('p'); notice.id = 'content-notice'; notice.className = 'content-notice'; notice.hidden = true;
  app.querySelector('.load-row')!.after(notice);
  const empty = document.createElement('p'); empty.id = 'empty-state'; empty.className = 'panel'; empty.hidden = true;
  empty.textContent = 'No prepared music yet. Open Library & mix builder to choose your stems, or open a stem folder in Studio tools.';
  notice.after(empty);
}

export function vocalChoices(scene: Scene) {
  const ids = ['sparse', 'pulse', 'open'] as const;
  const instrumental = ids.find(id => scene.recipes[id].vocals === null);
  const vocal = [...ids].filter(id => scene.recipes[id].vocals != null).sort((a, b) => scene.recipes[b].vocals! - scene.recipes[a].vocals!)[0];
  return { instrumental, vocal };
}

export function updatePerformance(session: PerformanceSession, scene: Scene, now: number) {
  const s = session.state, { instrumental, vocal } = vocalChoices(scene);
  const voices = (id: typeof s.currentRecipe) => scene.recipes[id].vocals != null;
  const desired = s.recipeIntent ? s.desiredRecipe : s.committedRecipe?.recipe ?? s.currentRecipe;
  const next = s.committedRecipe?.recipe ?? (s.recipeIntent && desired !== s.currentRecipe ? desired : undefined);
  const at = s.committedRecipe?.end ?? s.pendingRecipe?.end;
  const feedback = !s.running ? 'Start audio, then invite the voice in.' : next !== undefined
    ? `${voices(next) ? 'Vocals enter' : 'Instrumental returns'} ${at === undefined ? 'at the next phrase' : `in ${Math.max(0, at - now).toFixed(1)} s`} · completing this phrase`
    : voices(s.currentRecipe) ? 'Voice and instrumental are playing together.' : 'The instrumental keeps the room playing.';
  element('voice-state').textContent = s.running && voices(s.currentRecipe) ? 'Voice is in' : 'Instrumental';
  element('voice-feedback').textContent = feedback;
  button('vocal-toggle').textContent = voices(desired) ? 'Return to instrumental' : 'Bring in vocals';
  button('vocal-toggle').disabled = !s.running || !instrumental || !vocal;
  element('voice-help').textContent = !scene.stems.vocals ? 'This passage has no vocal stem. You can still shape its instrumental sound.' : instrumental && vocal ? 'The change waits for a phrase boundary, so it can take up to one loop. Sound shape responds immediately.' : 'This passage needs both an instrumental recipe and a vocal recipe. Set them in Studio tools.';
  const amount = session.timbre;
  element('sound-amount').textContent = `${Math.round(amount * 100)}%`;
  element('sound-character').textContent = session.filterBypass ? 'Effect bypassed' : amount < .25 ? 'Deeply muffled' : amount < .65 ? 'Warm & soft' : 'Full & clear';
  element('sound-help').textContent = session.mode === 'structure_only' ? 'Arrangement mode is active. Movement changes stem combinations; the tone is fixed. Change this in Studio tools.' : `Move to hear ${scene.filter.target === 'instrumental' ? 'the whole instrumental' : 'the harmonic stem'} open up immediately.${session.mode === 'combined' ? ' Combined mode also requests arrangement changes.' : ' This leaves the vocal choice alone.'}`;
  const transition = s.committedAdvance ?? s.pendingAdvance;
  element('passage-feedback').textContent = transition ? `Next passage ${transition.at === undefined ? 'requested' : `in ${Math.max(0, transition.at - now).toFixed(1)} s`}` : s.running ? 'This passage loops until you move on.' : 'Choose a passage, then start.';
}
