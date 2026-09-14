/** In-process output of a successfully rendered frame. Independent of telemetry rate/transports. */
export interface SimulationOutput {
  readonly simId: string;
  /** Browser monotonic clock, in milliseconds. Consumers can detect a stalled renderer. */
  readonly atMs: number;
  readonly signals: Readonly<Record<string, number>>;
  readonly input: { readonly presence: number; readonly activity: number };
}
