/**
 * Every simulation the host can run. Adding a simulation is one import and
 * one array entry; the overlay, URL selection, and telemetry schema pick it
 * up automatically.
 */
import type { ParamSpecs, SignalSpecs, SimulationDefinition } from '../core/types';
import presence from '../sims/template';
import trails from '../sims/trails';
import veil from '../sims/veil';
import basin from '../sims/basin';
import prism from '../sims/prism';
import shallows from '../sims/shallows';

export type AnySimulation = SimulationDefinition<ParamSpecs, SignalSpecs>;

export const SIMULATIONS: readonly AnySimulation[] = [trails, veil, basin, prism, shallows, presence] as unknown as AnySimulation[];

export function findSimulation(id: string): AnySimulation | undefined { return SIMULATIONS.find(s => s.id === id); }

/** Sanity checks that run once at startup and in tests: unique ids, sane ranges. */
export function validateRegistry(simulations: readonly AnySimulation[] = SIMULATIONS): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();
  for (const sim of simulations) {
    if (!/^[a-z][a-z0-9-]*$/.test(sim.id)) problems.push(`${sim.id}: id must be lowercase letters, digits, dashes`);
    if (ids.has(sim.id)) problems.push(`${sim.id}: duplicate id`); ids.add(sim.id);
    if (!sim.title || !sim.description) problems.push(`${sim.id}: needs a title and description`);
    for (const [name, p] of Object.entries(sim.params)) {
      if (!/^[a-zA-Z][a-zA-Z0-9]*$/.test(name)) problems.push(`${sim.id}.${name}: param names are camelCase identifiers`);
      if (p.kind === 'number' && !(p.min < p.max && p.default >= p.min && p.default <= p.max)) problems.push(`${sim.id}.${name}: default must lie within min < max`);
      if (p.kind === 'select' && !p.options.includes(p.default)) problems.push(`${sim.id}.${name}: default is not an option`);
    }
    for (const [name, s] of Object.entries(sim.signals)) {
      if (!/^[a-zA-Z][a-zA-Z0-9]*$/.test(name)) problems.push(`${sim.id}.${name}: signal names are camelCase identifiers`);
      if (!(s.min < s.max) || !s.description) problems.push(`${sim.id}.${name}: signal needs min < max and a description`);
    }
    if (sim.stepHz !== undefined && !(sim.stepHz >= 10 && sim.stepHz <= 240)) problems.push(`${sim.id}: stepHz must be within 10..240`);
  }
  return problems;
}
