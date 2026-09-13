import type { SessionInput } from './music/session';
export const BUILD_VERSION = '0.1.0-hand-space-2';
export interface TraceRecord { type: string; atMs: number; [key: string]: unknown }
export interface TraceInput extends TraceRecord { type: 'input'; input: SessionInput; audioTime: number }
export class TraceRecorder {
  readonly records: TraceRecord[] = [];
  dropped = 0;
  constructor(readonly originMs: number, header: Record<string, unknown>) {
    this.records.push({ type: 'session', atMs: 0, ...header, buildVersion: BUILD_VERSION, timebase: 'session-relative monotonic milliseconds; audioTime is context seconds', rawReplayMode: 'raw-control', eventReplayMode: 'event-plan' });
  }
  add(type: string, nowMs: number, fields: Record<string, unknown> = {}) {
    // Keep the declared origin/header; bounded recording has a visible truncation warning.
    if (this.records.length >= 300_000) { this.dropped++; return; }
    this.records.push({ type, atMs: nowMs - this.originMs, ...fields });
  }
  input(input: SessionInput, nowMs: number, audioTime: number) {
    const normalized = input.type === 'frame' ? { ...input, frame: { ...input.frame, observedAtMs: input.frame.observedAtMs - this.originMs, receivedAtMs: input.frame.receivedAtMs - this.originMs } } : input;
    this.add('input', nowMs, { input: normalized, audioTime });
  }
  jsonl() { return this.records.map(r => JSON.stringify(r)).join('\n') + '\n'; }
}
export function parseTrace(text: string): TraceRecord[] {
  const records: TraceRecord[] = text.trim().split(/\r?\n/).filter(Boolean).map((line, i) => {
    let row; try { row = JSON.parse(line); } catch { throw new Error(`Invalid JSON on trace line ${i + 1}.`); }
    if (!row || typeof row.type !== 'string' || !Number.isFinite(row.atMs) || row.atMs < 0) throw new Error(`Malformed trace line ${i + 1}.`);
    return row;
  });
  if (records[0]?.type !== 'session') throw new Error('Trace needs a session header.');
  if (records.some((r, i) => i > 0 && r.atMs < records[i - 1].atMs)) throw new Error('Trace timestamps must be monotonic.');
  return records;
}
export function download(name: string, value: string | Blob, type = 'application/json') {
  const blob = typeof value === 'string' ? new Blob([value], { type }) : value;
  const url = URL.createObjectURL(blob), a = document.createElement('a'); a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
