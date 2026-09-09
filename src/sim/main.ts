import './ui/overlay.css';
import { SimHost } from './host/app';
import { SettingsStore } from './host/settings';
import { Overlay } from './ui/overlay';

const root = document.getElementById('stage-root') as HTMLElement;
const video = document.getElementById('webcam') as HTMLVideoElement;
const overlayRoot = document.getElementById('overlay') as HTMLElement;

const settings = new SettingsStore(typeof localStorage !== 'undefined' ? localStorage : null, location.search);
const host = new SimHost(root, video, settings);
const overlay = new Overlay(overlayRoot, host, video);
overlay.visible = settings.value.overlay;

window.addEventListener('keydown', event => {
  if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement || event.target instanceof HTMLTextAreaElement) return;
  if (event.key === 'h' || event.key === 'H') { overlay.visible = !overlay.visible; settings.update(s => { s.overlay = overlay.visible; }); }
  if (event.key === 'f' || event.key === 'F') host.toggleFullscreen();
  if (event.key === 'c' || event.key === 'C') overlay.captureNext();
  if (/^[1-9]$/.test(event.key)) overlay.selectByIndex(Number(event.key) - 1);
});

// Hide the cursor over the stage when idle, as an installation should.
let cursorTimer: ReturnType<typeof setTimeout> | undefined;
const showCursor = () => { document.body.classList.remove('sim-idle'); if (cursorTimer) clearTimeout(cursorTimer); cursorTimer = setTimeout(() => document.body.classList.add('sim-idle'), 3000); };
window.addEventListener('pointermove', showCursor); showCursor();

host.start();
// Only persist on hide: disposing here would leave a dead page after a back/forward-cache restore.
window.addEventListener('pagehide', () => settings.flush());

/** Devtools / test hook. */
declare global { interface Window { livemixerSim: { host: SimHost; overlay: Overlay; settings: SettingsStore } } }
window.livemixerSim = { host, overlay, settings };
