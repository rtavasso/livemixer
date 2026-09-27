import type { SimHost } from './host/app';
import { SettingsStore } from './host/settings';
import type { Overlay } from './ui/overlay';
import { SimulationPlayer } from './player';
import { PatchEditor } from '../integration/patch-editor';
import { SIMULATIONS } from './host/registry';
import { rotationFromUrl, SimRotation } from './host/rotation';

const root = document.getElementById('stage-root') as HTMLElement;
const video = document.getElementById('webcam') as HTMLVideoElement;
const overlayRoot = document.getElementById('overlay') as HTMLElement;

const settings = new SettingsStore(typeof localStorage !== 'undefined' ? localStorage : null, location.search);
const player = new SimulationPlayer(root, video, overlayRoot, settings, { keyboardRoot: document });
const { host, overlay } = player;
const patchEditor = new PatchEditor(host, () => {}, undefined, true);
overlayRoot.append(patchEditor.root);

// Hide the cursor over the stage when idle, as an installation should.
let cursorTimer: ReturnType<typeof setTimeout> | undefined;
const showCursor = () => { document.body.classList.remove('sim-idle'); if (cursorTimer) clearTimeout(cursorTimer); cursorTimer = setTimeout(() => document.body.classList.add('sim-idle'), 3000); };
window.addEventListener('pointermove', showCursor); showCursor();

player.setActive(true);

// Optional timer rotation for a long show: sim.html?rotate=MINUTES&rotation=tide,lantern,murmuration
const rotationSettings = rotationFromUrl(location.search, SIMULATIONS.map(s => s.id));
if (rotationSettings) {
  const rotation = new SimRotation(rotationSettings, host.simulation.id);
  if (host.simulation.id !== rotation.current) host.selectSimulation(rotation.current);
  setInterval(() => {
    const { opacity, switchTo } = rotation.tick(performance.now(), host.state().tracked.presence);
    if (switchTo) host.selectSimulation(switchTo);
    root.style.opacity = String(opacity);
  }, 100);
}
// Only persist on hide: disposing here would leave a dead page after a back/forward-cache restore.
window.addEventListener('pagehide', () => settings.flush());

/** Devtools / test hook. */
declare global { interface Window { livemixerSim: { host: SimHost; overlay: Overlay; settings: SettingsStore } } }
window.livemixerSim = { host, overlay, settings };
