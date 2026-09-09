/** Temporary stand-in used while a simulation is being built so the registry always compiles. */
import { defineSimulation } from '../core/types';
import presence from './template';

export function placeholder(id: string, title: string, description: string) {
  return defineSimulation({ ...presence, id, title, description: `${description} (placeholder: shows the Presence simulation until implemented)` });
}
