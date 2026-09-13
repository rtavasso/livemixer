import type { Scene } from '../config';
import type { PerformanceSession } from '../music/session';
import { button, element, select } from './controls';
import { describeRecipes } from './recipes';

// Keep the authoring instrument available, but give visitors a small playing surface.
export function mountPerformance() {
  const app = element('app'), tools = document.createElement('div');
  tools.id = 'studio-tools'; tools.className = 'studio-tools';
  tools.innerHTML = '<div class="setup-intro"><h2>Setup</h2><p>Optional settings for editing your mix. Use Play for the main audio controls.</p></div>';
  app.append(tools);
  const section = (title: string, description: string) => {
    const box = document.createElement('details'); box.className = 'panel setup-section';
    box.innerHTML = `<summary>${title}</summary><p class="subtle">${description}</p>`; tools.append(box); return box;
  };
  const imports = section('Open or restore a saved mix', 'Stop audio before opening another mix. Choose an exported mix folder containing its audio and manifest.json. Restore saved passages replaces edits in Play with the original local passages. To choose new song sections, use Build mix.');
  imports.id = 'setup-files';
  imports.append(element('load-fixtures').parentElement!, app.querySelector('.mode-row')!);
  button('load-prepared').textContent = 'Restore saved passages';
  const tests = section('Engineering test audio', 'These synthetic tones check the audio engine. They are not songs.'); tests.id = 'setup-tests'; tests.append(element('load-fixtures'));
  button('load-fixtures').textContent = 'Play test-tone passages';
  const sound = app.querySelector<HTMLElement>('.control-panel')!;
  sound.querySelector('h2')!.textContent = 'Sound shape';
  select('adapter').parentElement!.firstChild!.textContent = 'Control with ';
  select('adapter').querySelector('option[value="slider"]')!.textContent = 'Mouse / touch';
  select('adapter').querySelector('option[value="camera"]')!.textContent = 'Camera / hand';
  select('adapter').querySelector<HTMLOptionElement>('option[value="replay"]')!.hidden = true;
  element('openness').setAttribute('aria-label', 'Sound shape');
  sound.querySelector('.range-labels')!.innerHTML = '<span>Warm & rounded</span><span>Full & clear</span>';
  const mappings = section('Movement controls', '<strong>Tone</strong> means the color of the sound: muffled to clear. <strong>Arrangement</strong> means which stems are audible. The normal playing view keeps these separate.');
  mappings.id = 'setup-movement';
  for (const node of [...sound.querySelectorAll('.setting-row'), element('hold-progress'), element('gesture')]) mappings.append(node);
  const diagnosticNodes = [...sound.querySelectorAll('.value-row,.input-details')];
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
  const mixes = section('Saved stem combinations', 'These buttons recall the levels saved for this passage. Identical combinations appear once. Start audio in Play before trying them.'); mixes.id = 'setup-mixes';
  mixes.append(arrangement.querySelector('.recipe-buttons')!);
  const mixFeedback = document.createElement('p'); mixFeedback.id = 'preset-feedback'; mixFeedback.className = 'subtle'; mixes.append(mixFeedback);
  const meters = section('Playback diagnostics', 'Internal mix IDs and scheduling states for troubleshooting. Pending waits for your selected timing; committed is already scheduled.'); meters.id = 'setup-diagnostics';
  meters.append(...diagnosticNodes, element('cancel'));
  for (const node of [...arrangement.querySelectorAll('.recipe-state'), element('stem-meters'), arrangement.querySelector('.master-meter')!, element('nodes')]) meters.append(node);
  arrangement.classList.add('vocal-panel'); arrangement.setAttribute('aria-label', 'Vocals');
  arrangement.innerHTML = '<span class="eyebrow">THE HUMAN LAYER</span><h2>Vocals</h2><div id="voice-state" class="voice-state">Instrumental</div><p id="voice-feedback" class="performance-help">Start audio, then invite the voice in.</p><button id="vocal-toggle" class="primary" disabled>Bring in vocals</button><p id="voice-help" class="subtle">Vocals enter and leave on the next beat. The instrumental keeps playing.</p>';
  const chooser = document.createElement('label'); chooser.className = 'passage-picker';
  app.querySelector('.transport .eyebrow')!.textContent = 'MUSIC PASSAGE';
  chooser.innerHTML = 'Passage <select id="performance-scene" aria-label="Passage" disabled></select>';
  element('scene-meta').after(chooser);
  const timing = document.createElement('label'); timing.className = 'response-control';
  timing.innerHTML = 'Change timing <select id="response-timing" aria-label="Change timing"><option value="beat">Next beat</option><option value="immediate">Immediate</option><option value="authored">Phrase endings</option></select>';
  chooser.after(timing);
  const speed = document.createElement('details'); speed.className = 'speed-control';
  speed.innerHTML = '<summary>Speed & pitch <output id="rate-summary">100%</output></summary><p class="subtle">Move all stems together. Slower sounds lower; faster sounds higher.</p><input id="playback-rate" aria-label="Speed and pitch" type="range" min="0.9" max="1.1" step="0.01" value="1"><div class="range-labels"><span>90% / lower</span><span>110% / higher</span></div><p id="rate-value" aria-live="polite">Original speed and pitch</p><button id="rate-reset">Reset to original</button>';
  sound.append(speed);
  button('next').textContent = 'Next passage';
  meters.append(element('boundary'), element('transition'));
  const passage = document.createElement('span'); passage.id = 'passage-feedback';
  app.querySelector('.transport-bottom')!.append(passage);
  const author = section('Edit passage sound & audio checks', 'Edit saved stem levels, listen to transitions, or measure audio levels. Stop playback before editing.'); author.id = 'setup-authoring'; author.append(element('author-panel'));
  const replay = section('Record & replay a control session', 'Save movement and button events for reproducing a performance or investigating a problem.'); replay.id = 'setup-replay'; replay.append(app.querySelector('[aria-label="Trace and replay"]')!);
  for (const id of ['setup-movement', 'setup-mixes', 'setup-authoring', 'setup-files', 'setup-diagnostics', 'setup-replay', 'setup-tests']) tools.append(element(id));
  if (new URLSearchParams(location.search).get('tools') === '1') tools.querySelectorAll('details.setup-section').forEach(d => (d as HTMLDetailsElement).open = true);
  app.querySelector('footer')!.before(tools);
  app.querySelector('footer')!.textContent = 'Your music stays on this computer.';
  const notice = document.createElement('p'); notice.id = 'content-notice'; notice.className = 'content-notice'; notice.hidden = true;
  app.querySelector('.load-row')!.after(notice);
  const empty = document.createElement('p'); empty.id = 'empty-state'; empty.className = 'panel'; empty.hidden = true;
  empty.textContent = 'No prepared music yet. Use Build mix to choose your stems, or Setup to open a saved mix folder.';
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
  const presets = describeRecipes(scene), requested = s.recipeIntent ? s.desiredRecipe : s.committedRecipe?.recipe ?? s.currentRecipe;
  for (const b of document.querySelectorAll<HTMLButtonElement>('[data-recipe]')) {
    const preset = presets.find(p => p.id === b.dataset.recipe); b.hidden = !preset; b.disabled = !s.running || session.space.enabled;
    if (preset) { const label = `${preset.label}: ${preset.summary}`; if (b.textContent !== label) b.textContent = label; b.setAttribute('aria-pressed', String(preset.ids.includes(requested))); }
  }
  const playingPreset = presets.find(p => p.ids.includes(s.currentRecipe));
  element('preset-feedback').textContent = session.space.enabled ? 'Choose Manual controls in Play to use these saved combinations. Hand space controls the balance continuously.' : s.running ? `Playing: ${playingPreset?.label ?? 'saved mix'}. Changes follow the timing chosen in Play.` : 'Start audio in Play to hear these combinations.';
  const voices = (id: typeof s.currentRecipe) => scene.recipes[id].vocals != null;
  const desired = s.recipeIntent ? s.desiredRecipe : s.committedRecipe?.recipe ?? s.currentRecipe;
  const next = s.committedRecipe?.recipe ?? (s.recipeIntent && desired !== s.currentRecipe ? desired : undefined);
  const at = s.committedRecipe?.end ?? s.pendingRecipe?.end;
  const timing = s.timing ?? 'authored', boundary = timing === 'beat' ? 'on the next beat' : timing === 'immediate' ? 'immediately' : 'on the authored grid';
  const feedback = !s.running ? 'Start audio, then invite the voice in.' : next !== undefined
    ? `${voices(next) ? 'Vocals enter' : 'Instrumental returns'} ${at === undefined ? boundary : `in ${Math.max(0, at - now).toFixed(1)} s`}`
    : voices(s.currentRecipe) ? 'Voice and instrumental are playing together.' : 'The instrumental keeps the room playing.';
  element('voice-state').textContent = s.running && voices(s.currentRecipe) ? 'Voice is in' : 'Instrumental';
  element('voice-feedback').textContent = feedback;
  button('vocal-toggle').textContent = voices(desired) ? 'Return to instrumental' : 'Bring in vocals';
  button('vocal-toggle').disabled = !s.running || !instrumental || !vocal;
  element('voice-help').textContent = !scene.stems.vocals ? 'This passage has no vocal stem. You can still shape its instrumental sound.' : instrumental && vocal ? `Vocals and passages change ${boundary}. Sound shape responds immediately.` : 'This passage needs both an instrumental recipe and a vocal recipe. Edit them in Setup.';
  const amount = session.timbre;
  element('sound-amount').textContent = `${Math.round(amount * 100)}%`;
  element('sound-character').textContent = session.filterBypass ? 'Effect bypassed' : amount < .25 ? 'Warm & rounded' : amount < .65 ? 'Warm & soft' : 'Full & clear';
  element('sound-help').textContent = session.mode === 'structure_only' ? 'Arrangement mode is active. Movement changes stem combinations; the tone is fixed. Change this in Setup.' : `Move to hear ${scene.filter.target === 'instrumental' ? 'the whole instrumental' : 'the harmonic stem'} open up immediately.${session.mode === 'combined' ? ' Combined mode also requests arrangement changes.' : ' This leaves the vocal choice alone.'}`;
  const rate = s.rate ?? 1, desiredRate = s.desiredRate ?? 1;
  const semitones = 12 * Math.log2(rate);
  const bpm = s.running ? 60 * s.clock.loopBars * s.clock.beatsPerBar / s.clock.duration : 60 * scene.loopBars * scene.beatsPerBar / session.environment.scenes[scene.id].duration * desiredRate;
  element('rate-summary').textContent = `${Math.round(desiredRate * 100)}%`;
  element('rate-value').textContent = s.running ? `${Math.round(rate * 100)}% speed / ${bpm.toFixed(1)} BPM / ${semitones >= 0 ? '+' : ''}${semitones.toFixed(2)} semitones${rate !== desiredRate ? ` - changing to ${Math.round(desiredRate * 100)}% ${boundary}` : ''}` : `${Math.round(desiredRate * 100)}% speed on Start / ${bpm.toFixed(1)} BPM`;
  const transition = s.committedAdvance ?? s.pendingAdvance;
  element('passage-feedback').textContent = transition ? `Next passage ${transition.at === undefined ? 'requested' : `in ${Math.max(0, transition.at - now).toFixed(1)} s`}` : s.running ? 'This passage loops until you move on.' : 'Choose a passage, then start.';
}
