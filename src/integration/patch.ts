import { z } from 'zod';
import { coerceParam, resolveParams } from '../sim/core/params';
import type { SignalSpecs } from '../sim/core/types';
import { findSimulation } from '../sim/host/registry';
import { settingsSchema, type Settings } from '../sim/host/settings';

export const PATCH_KEY = 'livemixer-performance-patch-v1';
export const TARGETS = ['engagement', 'balance', 'space'] as const;
export type MixTarget = typeof TARGETS[number];
export const TARGET_LABELS: Record<MixTarget, string> = { engagement: 'Engagement', balance: 'Stem balance', space: 'Echo & reverb' };

const unit = z.number().finite().min(0).max(1);
export const routeSchema = z.object({
  source: z.string().min(1).max(100),
  inputMin: z.number().finite(), inputMax: z.number().finite(),
  outputMin: unit, outputMax: unit,
  smoothingMs: z.number().finite().min(0).max(5000),
}).strict().refine(r => r.inputMin < r.inputMax, 'Input minimum must be below maximum.');
export type SignalRoute = z.infer<typeof routeSchema>;
const patchSchema = z.object({
  version: z.literal(1), name: z.string().trim().min(1).max(100),
  settings: settingsSchema,
  routes: z.object({ engagement: routeSchema, balance: routeSchema, space: routeSchema }).strict(),
}).strict();
export type PerformancePatch = z.infer<typeof patchSchema>;

export function routeSources(signals: SignalSpecs): Record<string, { min: number; max: number; description: string; label: string }> {
  return {
    ...Object.fromEntries(Object.entries(signals).map(([name, spec]) => [`signal.${name}`, { ...spec, label: name }])),
    'input.presence': { min: 0, max: 1, description: 'Conditioned hand presence.', label: 'Hand presence' },
    'input.activity': { min: 0, max: 1, description: 'Conditioned hand motion.', label: 'Hand motion' },
    constant: { min: 0, max: 1, description: 'A fixed output, set with Output at minimum.', label: 'Constant' },
  };
}

export function parsePatch(raw: unknown): PerformancePatch {
  const patch = patchSchema.parse(raw);
  const sim = findSimulation(patch.settings.sim);
  if (!sim) throw new Error(`Simulation "${patch.settings.sim}" is not installed. Register it before opening this patch.`);
  if (patch.settings.source === 'replay') throw new Error('Choose a live or synthetic input before saving a performance patch. Replay files are not included.');
  const sources = routeSources(sim.signals);
  for (const target of TARGETS) {
    const route = patch.routes[target];
    if (!Object.hasOwn(sources, route.source)) throw new Error(`Unknown signal "${route.source}" for ${sim.title}.`);
  }
  for (const [name, value] of Object.entries(patch.settings.params[sim.id] ?? {})) {
    const spec = sim.params[name];
    if (!spec || coerceParam(spec, value) !== value) throw new Error(`Invalid parameter "${name}" for ${sim.title}.`);
  }
  // A patch carries one simulation; unrelated studio experiments stay in the studio.
  patch.settings.params = { [sim.id]: resolveParams(sim.params, patch.settings.params[sim.id]) };
  return patch;
}

/** Audio presets live outside simulation implementations. New simulations work with a generic preset. */
const presets: Record<string, [string, string, string]> = {
  trails: ['ink', 'hue', 'glow'], veil: ['flutter', 'depth', 'sway'],
  basin: ['energy', 'rotation', 'swirl'], prism: ['brightness', 'hue', 'spread'],
  presence: ['presence', 'y', 'z'],
};
export function defaultPatch(settings: Settings): PerformancePatch {
  const sim = findSimulation(settings.sim);
  if (!sim) throw new Error(`Unknown simulation "${settings.sim}".`);
  const chosen = presets[sim.id] ?? [Object.keys(sim.signals)[0], Object.keys(sim.signals)[1], Object.keys(sim.signals)[2]];
  const routes = Object.fromEntries(TARGETS.map((target, i) => {
    const spec = sim.signals[chosen[i]];
    return [target, { source: spec ? `signal.${chosen[i]}` : i === 0 ? 'input.presence' : 'constant', inputMin: spec?.min ?? 0, inputMax: spec?.max ?? 1,
      outputMin: spec || i === 0 ? 0 : .5, outputMax: 1, smoothingMs: (spec?.smoothing ?? .15) * 1000 }];
  })) as PerformancePatch['routes'];
  return parsePatch({ version: 1, name: `${sim.title} performance`, settings: { ...settings, source: settings.source === 'replay' ? 'pointer' : settings.source }, routes });
}
export function readPatch(storage: Pick<Storage, 'getItem'> | null): PerformancePatch | null {
  try { const text = storage?.getItem(PATCH_KEY); return text ? parsePatch(JSON.parse(text)) : null; } catch { return null; }
}
export function savePatch(storage: Pick<Storage, 'setItem'>, patch: PerformancePatch) {
  storage.setItem(PATCH_KEY, JSON.stringify(parsePatch(patch)));
}
