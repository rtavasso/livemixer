import './ui/overlay.css';
import { SimHost, type HostOptions } from './host/app';
import type { SettingsStore } from './host/settings';
import { Overlay } from './ui/overlay';

/** The same player is mounted by the standalone studio and the mixer. Owns no audio. */
export class SimulationPlayer {
  readonly host: SimHost;
  readonly overlay: Overlay;
  private active = false;
  private readonly keyboardRoot: HTMLElement | Document;
  private keydown = (event: KeyboardEvent) => {
    if (!this.active || event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement || event.target instanceof HTMLTextAreaElement) return;
    const key = event.key.toLowerCase();
    if (key === 'h') { this.overlay.visible = !this.overlay.visible; this.settings.update(s => { s.overlay = this.overlay.visible; }); }
    else if (key === 'f') this.host.toggleFullscreen();
    else if (key === 'c') this.overlay.captureNext();
    else if (/^[1-9]$/.test(key)) this.overlay.selectByIndex(Number(key) - 1);
    else return;
    event.preventDefault();
  };
  private visibility = () => {
    if (this.active && !document.hidden) this.host.start(); else this.host.stop();
  };
  constructor(root: HTMLElement, video: HTMLVideoElement, overlayRoot: HTMLElement, readonly settings: SettingsStore, options: HostOptions & { keyboardRoot?: HTMLElement | Document } = {}) {
    this.host = new SimHost(root, video, settings, undefined, options);
    this.overlay = new Overlay(overlayRoot, this.host, video);
    this.overlay.visible = settings.value.overlay;
    this.host.canvas.tabIndex = 0;
    this.keyboardRoot = options.keyboardRoot ?? root;
    this.keyboardRoot.addEventListener('keydown', this.keydown as EventListener);
    document.addEventListener('visibilitychange', this.visibility);
  }
  setActive(active: boolean) { this.active = active; this.visibility(); }
  dispose() {
    document.removeEventListener('visibilitychange', this.visibility);
    this.keyboardRoot.removeEventListener('keydown', this.keydown as EventListener);
    this.overlay.dispose(); this.host.dispose();
  }
}
