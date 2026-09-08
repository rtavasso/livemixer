export type Adapter = 'camera' | 'slider' | 'replay';
export type MappingMode = 'timbre_only' | 'structure_only' | 'combined';
export interface ControlFrame {
  sequence: number;
  observedAtMs: number;
  receivedAtMs: number;
  valid: boolean;
  values: { openness: number };
  source: Adapter;
}
export interface Landmark { x: number; y: number; z?: number }
