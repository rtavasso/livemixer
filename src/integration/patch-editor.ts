import './style.css';
import type { SimHost } from '../sim/host/app';
import { download } from '../trace';
import { defaultPatch, parsePatch, routeSchema, routeSources, savePatch, TARGET_LABELS, TARGETS, type PerformancePatch } from './patch';

const escape = (text: string) => text.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** Shared patch authoring UI. Simulation implementations never import this integration layer. */
export class PatchEditor {
  readonly root = document.createElement('details');
  private patch: PerformancePatch;
  private unsubscribe: () => void;
  private status = document.createElement('p');
  constructor(private readonly host: SimHost, private readonly changed: (patch: PerformancePatch) => void, initial?: PerformancePatch, private readonly studio = false) {
    this.patch = initial ?? defaultPatch(host.settings.value);
    this.root.className = 'performance-patch';
    this.render();
    this.unsubscribe = host.onChange(() => {
      if (this.patch.settings.sim === host.simulation.id) return;
      this.patch = defaultPatch(host.settings.value); this.render(); this.changed(this.patch);
    });
    this.changed(this.patch);
  }
  current(): PerformancePatch {
    return parsePatch({ ...this.patch, settings: { ...structuredClone(this.host.settings.value), source: this.host.state().sourceId } });
  }
  apply(raw: unknown) {
    const patch = parsePatch(raw); // Validate everything before touching the running player.
    this.patch = patch; this.host.restoreSettings(patch.settings); this.render(); this.changed(this.patch);
  }
  private attempt(action: () => void | Promise<void>) {
    Promise.resolve().then(action).catch(error => { this.status.textContent = error instanceof Error ? error.message : String(error); });
  }
  private render() {
    const sources = routeSources(this.host.simulation.signals);
    this.root.innerHTML = `<summary>Sound mappings & performance patch</summary>
      <p>Connect the simulation to the music. Engagement brings in vocals and effects; stem balance moves from rhythm to melody; echo & reverb adds space.</p>
      <label>Patch name <input data-patch-name type="text" maxlength="100" value="${escape(this.patch.name)}"></label>
      <div class="patch-routes">${TARGETS.map(target => {
        const r = this.patch.routes[target], title = TARGET_LABELS[target];
        return `<fieldset data-route="${target}"><legend>${title}</legend>
          <label>Follow <select aria-label="${title} signal" data-field="source">${Object.entries(sources).map(([id, spec]) => `<option value="${escape(id)}" ${id === r.source ? 'selected' : ''}>${escape(spec.label)}</option>`).join('')}</select></label>
          <p class="route-description">${escape(sources[r.source].description)}</p>
          <div class="patch-range">${(['inputMin', 'inputMax', 'outputMin', 'outputMax', 'smoothingMs'] as const).map(field => {
            const label = { inputMin: 'Input minimum', inputMax: 'Input maximum', outputMin: 'Output at minimum', outputMax: 'Output at maximum', smoothingMs: 'Smoothing (ms)' }[field];
            const bounds = field.startsWith('output') ? 'min="0" max="1"' : field === 'smoothingMs' ? 'min="0" max="5000"' : '';
            return `<label>${label}<input aria-label="${title} ${label.toLowerCase()}" data-field="${field}" type="number" step="any" ${bounds} value="${r[field]}"></label>`;
          }).join('')}</div></fieldset>`;
      }).join('')}</div>
      <p>Outputs run from 0 to 1. Swap the output endpoints to reverse a response. Choose Constant for a fixed output.</p>
      <div class="patch-actions"><button data-save>Save patch</button><button data-export>Export patch</button>
      <label class="file-button">Open patch<input data-import type="file" accept=".json,application/json" aria-label="Open performance patch"></label>
      <button data-reset>Reset sound mappings</button>${this.studio ? '<button data-play class="primary">Play in mixer</button>' : ''}</div>`;
    this.status = document.createElement('p'); this.status.setAttribute('role', 'status'); this.root.append(this.status);
    this.root.querySelector<HTMLInputElement>('[data-patch-name]')!.onchange = event => this.attempt(() => {
      const name = (event.target as HTMLInputElement).value.trim();
      this.patch = parsePatch({ ...this.patch, name }); this.changed(this.patch);
    });
    for (const target of TARGETS) {
      const fieldset = this.root.querySelector<HTMLFieldSetElement>(`[data-route="${target}"]`)!;
      fieldset.onchange = event => this.attempt(() => {
        const node = event.target as HTMLInputElement | HTMLSelectElement;
        const next = { ...this.patch.routes[target] };
        if (node.dataset.field === 'source') {
          const spec = sources[node.value]; next.source = node.value; next.inputMin = spec.min; next.inputMax = spec.max;
        } else {
          for (const field of ['inputMin', 'inputMax', 'outputMin', 'outputMax', 'smoothingMs'] as const) {
            const input = fieldset.querySelector<HTMLInputElement>(`[data-field="${field}"]`)!;
            next[field] = input.value === '' ? NaN : Number(input.value);
          }
        }
        this.patch.routes[target] = routeSchema.parse(next);
        this.changed(this.patch); this.render();
      });
    }
    this.root.querySelector<HTMLButtonElement>('[data-save]')!.onclick = () => this.attempt(() => { savePatch(localStorage, this.current()); this.status.textContent = 'Performance patch saved in this browser.'; });
    this.root.querySelector<HTMLButtonElement>('[data-export]')!.onclick = () => this.attempt(() => download('livemixer-performance.patch.json', JSON.stringify(this.current(), null, 2)));
    this.root.querySelector<HTMLInputElement>('[data-import]')!.onchange = event => this.attempt(async () => {
      const input = event.target as HTMLInputElement, file = input.files?.[0]; if (!file) return;
      try {
        if (file.size > 2_000_000) throw new Error('Performance patches must be smaller than 2 MB.');
        this.apply(JSON.parse(await file.text())); this.status.textContent = 'Patch opened. Save it to use it next time.';
      } finally { input.value = ''; }
    });
    this.root.querySelector<HTMLButtonElement>('[data-reset]')!.onclick = () => this.attempt(() => {
      this.patch = defaultPatch(this.host.settings.value); this.changed(this.patch); this.render();
    });
    const play = this.root.querySelector<HTMLButtonElement>('[data-play]');
    if (play) play.onclick = () => this.attempt(() => { savePatch(localStorage, this.current()); this.host.settings.flush(); location.assign('/?play=simulation'); });
  }
  dispose() { this.unsubscribe(); this.root.remove(); }
}
