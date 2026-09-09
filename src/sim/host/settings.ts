/**
 * Persisted host settings: which simulation, which source, per-source
 * mappings, per-simulation parameter overrides, and telemetry endpoints.
 * Stored in localStorage; URL query parameters override for a session so an
 * installation can be launched with a fixed configuration:
 *
 *   sim.html?sim=basin&source=depth&bridge=ws://127.0.0.1:8765&ws=ws://127.0.0.1:9000&overlay=0&quality=medium
 */
import { z } from 'zod';
import { gestureSettingsSchema } from '../input/gestures';
import { spaceMappingSchema, DEPTH_MAPPING, IMAGE_MAPPING, SCREEN_MAPPING, type SpaceMapping } from '../input/mapping';
import { trackerSettingsSchema } from '../input/conditioning';
import type { SourceId } from '../input/types';

const sourceId = z.enum(['pointer', 'synthetic', 'webcam', 'depth', 'replay']);

export const settingsSchema = z.object({
  sim: z.string().default('trails'),
  source: sourceId.default('pointer'),
  quality: z.enum(['low', 'medium', 'high']).default('medium'),
  /** Device pixel ratio cap. 1.0 is plenty for a projector; retina laptops render 4× the pixels at 2.0. */
  maxDpr: z.number().min(.5).max(3).default(1.25),
  overlay: z.boolean().default(true),
  mappings: z.record(sourceId, spaceMappingSchema).default({}),
  params: z.record(z.string(), z.record(z.string(), z.union([z.number(), z.boolean(), z.string()]))).default({}),
  tracker: trackerSettingsSchema.partial().default({}),
  gestures: gestureSettingsSchema.partial().default({}),
  telemetry: z.object({
    rateHz: z.number().min(1).max(120).default(30),
    broadcast: z.boolean().default(true),
    window: z.boolean().default(true),
    websocketUrl: z.string().default(''),
    occupancy: z.boolean().default(false),
  }).default({}),
  depth: z.object({ url: z.string().default('ws://127.0.0.1:8765') }).default({}),
  synthetic: z.object({ hands: z.union([z.literal(1), z.literal(2)]).default(1), speed: z.number().min(.1).max(5).default(1) }).default({}),
}).strict();
export type Settings = z.infer<typeof settingsSchema>;

export const STORAGE_KEY = 'livemixer-sim-settings';

export function defaultMapping(source: SourceId): SpaceMapping {
  switch (source) {
    case 'pointer': return SCREEN_MAPPING;
    case 'depth': return DEPTH_MAPPING;
    default: return IMAGE_MAPPING;
  }
}

/** Parse stored JSON leniently: unknown keys and invalid values fall back to defaults instead of failing. */
export function parseSettings(raw: unknown): Settings {
  const result = settingsSchema.safeParse(raw);
  if (result.success) return result.data;
  const clean: Record<string, unknown> = {};
  if (raw && typeof raw === 'object') {
    for (const [key, value] of Object.entries(raw)) {
      const attempt = settingsSchema.safeParse({ [key]: value });
      if (attempt.success) clean[key] = value;
    }
  }
  return settingsSchema.parse(clean);
}

export function applyUrlOverrides(settings: Settings, search: string): Settings {
  const q = new URLSearchParams(search);
  const next = structuredClone(settings);
  const sim = q.get('sim'); if (sim) next.sim = sim;
  const source = q.get('source'); if (source && sourceId.safeParse(source).success) next.source = source as SourceId;
  const quality = q.get('quality'); if (quality === 'low' || quality === 'medium' || quality === 'high') next.quality = quality;
  const overlay = q.get('overlay'); if (overlay !== null) next.overlay = overlay !== '0' && overlay !== 'false';
  const ws = q.get('ws'); if (ws !== null) next.telemetry.websocketUrl = ws;
  const bridge = q.get('bridge'); if (bridge) next.depth.url = bridge;
  const dpr = Number(q.get('dpr')); if (Number.isFinite(dpr) && dpr > 0) next.maxDpr = Math.min(3, Math.max(.5, dpr));
  const rate = Number(q.get('rate')); if (Number.isFinite(rate) && rate > 0) next.telemetry.rateHz = Math.min(120, Math.max(1, rate));
  return next;
}

export class SettingsStore {
  value: Settings;
  private timer?: ReturnType<typeof setTimeout>;
  constructor(private readonly storage: Pick<Storage, 'getItem' | 'setItem'> | null, search = '') {
    let stored: unknown = {};
    try { const text = storage?.getItem(STORAGE_KEY); if (text) stored = JSON.parse(text); } catch { stored = {}; }
    this.value = applyUrlOverrides(parseSettings(stored), search);
  }
  /** Mutate and persist (debounced). URL overrides are persisted too, which is what an installation wants. */
  update(mutate: (settings: Settings) => void) {
    mutate(this.value);
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 150);
  }
  flush() {
    if (this.timer) clearTimeout(this.timer); this.timer = undefined;
    try { this.storage?.setItem(STORAGE_KEY, JSON.stringify(this.value)); } catch { /* private mode or quota; settings stay in memory */ }
  }
}
