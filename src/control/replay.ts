import { PerformanceSession, type SessionInput } from '../music/session';
import type { AudioAction, PlannerEnvironment } from '../music/planner';
import type { TraceInput, TraceRecord } from '../trace';
export interface ReplayedAction { atMs: number; audioTime: number; action: AudioAction }
export function replayRawControl(records: TraceRecord[], environment: PlannerEnvironment): { actions: ReplayedAction[]; session: PerformanceSession } {
  const session = new PerformanceSession({ ...environment, sampleRate: typeof records[0]?.sampleRate === 'number' ? records[0].sampleRate : environment.sampleRate }, 0), actions: ReplayedAction[] = [];
  for (const record of records) if (record.type === 'input') {
    const row = record as TraceInput;
    if (!row.input || !Number.isFinite(row.audioTime) || row.audioTime < 0) throw new Error('Invalid raw-control input.');
    for (const action of session.dispatch(row.input, row.atMs, row.audioTime)) actions.push({ atMs: row.atMs, audioTime: row.audioTime, action });
  }
  return { actions, session };
}
// Live raw replay uses a controlled observation origin and today's audio clock.
// The offline regression above additionally reproduces the recorded readiness/timing simulation.
export class RawReplayAdapter {
  private cursor = 0;
  readonly inputs: TraceInput[];
  constructor(records: TraceRecord[], readonly originMs: number) {
    this.inputs = records.filter(r => r.type === 'input') as TraceInput[];
    if (!this.inputs.some(r => r.input?.type === 'frame')) throw new Error('This trace has no raw control frames.');
  }
  due(nowMs: number): SessionInput[] {
    const inputs: SessionInput[] = [];
    while (this.cursor < this.inputs.length && this.inputs[this.cursor].atMs <= nowMs - this.originMs) {
      const row = this.inputs[this.cursor++], input = row.input;
      if (input.type === 'frame') inputs.push({ ...input, frame: { ...input.frame, source: 'replay', observedAtMs: this.originMs + input.frame.observedAtMs, receivedAtMs: this.originMs + input.frame.receivedAtMs } });
      else if (['space', 'timing', 'rate', 'mode', 'hold', 'bypass', 'metronome', 'recipe', 'advance', 'calibration', 'cancel', 'start', 'stop'].includes(input.type)) inputs.push(input);
      else if (input.type === 'adapter') inputs.push({ type: 'adapter', source: 'replay' });
    }
    return inputs;
  }
  get done() { return this.cursor >= this.inputs.length; }
}
