import '../integration/style.css';
import { SimulationModulation, toSpaceState } from '../integration/modulation';
import { PatchEditor } from '../integration/patch-editor';
import { readPatch, TARGET_LABELS, TARGETS } from '../integration/patch';
import { applyUrlOverrides, SettingsStore } from '../sim/host/settings';
import type { SimulationPlayer } from '../sim/player';
import { element } from './controls';

/** Mixer shell for the reusable simulation player. All sound crosses the modulation adapter. */
export class SimulationPanel {
  readonly root = document.createElement('section');
  player?: SimulationPlayer;
  editor?: PatchEditor;
  private mapper?: SimulationModulation;
  private active = false;
  private disposed = false;
  private suspended = false;
  private starting?: Promise<void>;
  private status: HTMLElement;
  private viewport: HTMLElement;
  private controls: HTMLButtonElement;
  constructor() {
    this.root.id = 'simulation-panel'; this.root.className = 'simulation-panel'; this.root.hidden = true;
    this.root.setAttribute('aria-label', 'Simulation performance');
    this.root.innerHTML = `<div class="simulation-toolbar"><h2>Play the simulation</h2><button id="simulation-start">Start audio</button><button id="simulation-stop">Stop audio</button><button id="simulation-controls" aria-expanded="false">Simulation controls</button>
      <button id="simulation-fullscreen">Fullscreen</button><a href="/sim.html" target="_blank" rel="noopener">Open simulation studio</a></div>
      <p id="simulation-status" class="subtle" role="status">Choose music, then start audio. Movement in the simulation shapes the song.</p>
      <div class="simulation-viewport"></div>
      <div class="simulation-readouts">${TARGETS.map(t => `<span>${TARGET_LABELS[t]} <output data-mix-output="${t}">0%</output></span>`).join('')}</div>`;
    element('space-panel').after(this.root);
    this.status = this.root.querySelector('#simulation-status')!;
    this.viewport = this.root.querySelector('.simulation-viewport')!;
    this.controls = this.root.querySelector('#simulation-controls')!;
    this.root.querySelector<HTMLButtonElement>('#simulation-start')!.onclick = () => element<HTMLButtonElement>('start').click();
    this.root.querySelector<HTMLButtonElement>('#simulation-stop')!.onclick = () => element<HTMLButtonElement>('stop-all').click();
    this.controls.onclick = () => {
      if (this.player) this.player.overlay.visible = !this.player.overlay.visible;
      this.controls.setAttribute('aria-expanded', String(this.player?.overlay.visible ?? false));
    };
    this.root.querySelector<HTMLButtonElement>('#simulation-fullscreen')!.onclick = () => {
      if (document.fullscreenElement) void document.exitFullscreen();
      else void this.root.requestFullscreen?.().catch(error => { this.status.textContent = String(error); });
    };
  }
  setActive(active: boolean) {
    this.active = active; this.root.hidden = !active;
    this.mapper?.reset();
    if (this.player) this.player.setActive(active && !this.suspended);
    else if (active && !this.suspended && !this.starting) {
      this.starting = this.initialize().catch(error => { this.status.textContent = `Simulation could not start: ${String(error)}. Choose Hand space or Manual controls to keep playing.`; })
        .finally(() => { this.starting = undefined; });
    }
  }
  /** Audio decoding/analysis gets the main thread before starting the renderer. */
  setSuspended(suspended: boolean) { this.suspended = suspended; this.setActive(this.active); }
  updateTransport() {
    this.root.querySelector<HTMLButtonElement>('#simulation-start')!.disabled = element<HTMLButtonElement>('start').disabled;
    this.root.querySelector<HTMLButtonElement>('#simulation-stop')!.disabled = element<HTMLButtonElement>('stop-all').disabled;
  }
  private async initialize() {
    const { SimulationPlayer } = await import('../sim/player');
    if (!this.active || this.disposed || this.suspended) return;
    const saved = readPatch(localStorage), settings = new SettingsStore(null, location.search);
    if (saved) settings.value = applyUrlOverrides(saved.settings, location.search);
    // The mixer opens with the picture visible; the full studio controls remain one click away.
    settings.value.overlay = false;
    const video = document.createElement('video'); video.className = 'sim-webcam'; video.playsInline = true; video.muted = true; video.hidden = true;
    const overlay = document.createElement('aside'); overlay.className = 'sim-overlay'; overlay.hidden = true;
    this.viewport.append(video, overlay);
    try {
      this.player = new SimulationPlayer(this.viewport, video, overlay, settings, { externalTelemetry: false, fullscreenRoot: this.root });
      this.editor = new PatchEditor(this.player.host, patch => { this.mapper = new SimulationModulation(patch); }, saved?.settings.sim === settings.value.sim ? saved : undefined);
      this.root.append(this.editor.root);
      this.player.setActive(this.active && !this.suspended);
    } catch (error) {
      this.editor?.dispose(); this.player?.dispose(); this.player = undefined; this.editor = undefined;
      this.viewport.replaceChildren(); throw error;
    }
    this.status.textContent = 'Start audio to hear the simulation. Open Simulation controls to choose a scene or input.';
  }
  sample(now: number, running: boolean) {
    const output = this.active && !this.suspended && !document.hidden ? this.player?.host.latestOutput ?? null : null;
    const controls = this.mapper?.sample(output, now) ?? { engagement: 0, balance: .5, space: .35 };
    for (const target of TARGETS) this.root.querySelector<HTMLOutputElement>(`[data-mix-output="${target}"]`)!.value = `${Math.round(controls[target] * 100)}%`;
    if (this.player) this.status.textContent = !running ? 'Start audio to hear the simulation.'
      : !output || now - output.atMs > 500 ? 'Simulation paused or recovering. The instrumental bed continues.'
      : `${this.player.host.simulation.title} is shaping the music. Its motion and decay continue to influence the sound.`;
    return toSpaceState(controls);
  }
  dispose() { this.disposed = true; this.editor?.dispose(); this.player?.dispose(); }
}
