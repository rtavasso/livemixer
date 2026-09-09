/**
 * Record input frames from any source to JSONL and play them back later as a
 * source of their own. Lets the installation be tuned without a performer in
 * the room, and makes browser tests reproducible.
 *
 * The recorder serialises each frame as it arrives and keeps a byte budget,
 * so a recording forgotten for an hour costs bounded memory and can still be
 * downloaded (as Blob parts; no single giant string is ever built).
 */
import { decodeOccupancy, encodeOccupancy } from './protocol';
import type { InputFrame, InputSource, InputSourceStatus } from './types';

interface RecordedFrame { atMs: number; frame: Omit<InputFrame, 'occupancy' | 'observedAtMs' | 'receivedAtMs'> & { observedOffsetMs: number; occupancy?: { width: number; height: number; data: string } } }

export class InputRecorder {
  private lines: string[] = [];
  private bytes = 0;
  private originMs: number | null = null;
  dropped = 0;
  /** @param maxBytes Budget for the serialised frames (default 64 MiB). */
  constructor(readonly maxBytes = 64 << 20) {}
  get length() { return this.lines.length; }
  get size() { return this.bytes; }
  add(frame: InputFrame) {
    if (this.originMs === null) this.originMs = frame.receivedAtMs;
    const { occupancy, observedAtMs, receivedAtMs, ...rest } = frame;
    const record: RecordedFrame = { atMs: receivedAtMs - this.originMs, frame: { ...rest, observedOffsetMs: observedAtMs - receivedAtMs, occupancy: occupancy ? { width: occupancy.width, height: occupancy.height, data: encodeOccupancy(occupancy) } : undefined } };
    const line = JSON.stringify(record);
    if (this.bytes + line.length > this.maxBytes) { this.dropped++; return; }
    this.lines.push(line); this.bytes += line.length;
  }
  clear() { this.lines = []; this.bytes = 0; this.originMs = null; this.dropped = 0; }
  private header() { return JSON.stringify({ type: 'sim-input-recording', version: 1, frames: this.lines.length, dropped: this.dropped }); }
  /** Blob parts for a download: `new Blob(recorder.parts())`. */
  parts(): BlobPart[] {
    const out: BlobPart[] = [this.header(), '\n'];
    for (const line of this.lines) out.push(line, '\n');
    return out;
  }
  /** The whole recording as one string; fine for tests and small recordings. */
  jsonl(): string { return this.parts().join(''); }
}

export function parseRecording(text: string): RecordedFrame[] {
  const lines = text.trim().split(/\r?\n/).filter(Boolean);
  if (!lines.length) throw new Error('Recording is empty.');
  const header = JSON.parse(lines[0]);
  if (header?.type !== 'sim-input-recording' || header.version !== 1) throw new Error('Not a simulation input recording.');
  const records: RecordedFrame[] = lines.slice(1).map((line, i) => {
    const row = JSON.parse(line);
    if (!row || !Number.isFinite(row.atMs) || !row.frame || !Array.isArray(row.frame.hands) || !Number.isFinite(row.frame.observedOffsetMs)) throw new Error(`Malformed recording line ${i + 2}.`);
    return row as RecordedFrame;
  });
  for (let i = 1; i < records.length; i++) if (records[i].atMs < records[i - 1].atMs) throw new Error('Recording timestamps must be monotonic.');
  return records;
}

export class ReplaySource implements InputSource {
  readonly id = 'replay' as const;
  readonly frameDescription = 'Whatever frame the recorded source used; keep its mapping';
  private cursor = 0; private originMs: number | null = null; private running = false; private sequence = 0;
  loop = true;
  constructor(private readonly records: RecordedFrame[], private readonly emit: (frame: InputFrame) => void) { if (!records.length) throw new Error('Recording has no frames.'); }
  async start() { this.running = true; this.cursor = 0; this.originMs = null; }
  stop() { this.running = false; }
  get done() { return this.cursor >= this.records.length; }
  status(): InputSourceStatus { return { state: this.running ? 'running' : 'idle', message: this.running ? `Replaying frame ${Math.min(this.cursor, this.records.length)} of ${this.records.length}${this.loop ? ' (looping)' : ''}.` : 'Replay stopped.' }; }
  sample(nowMs: number) {
    if (!this.running) return;
    if (this.originMs === null) this.originMs = nowMs;
    const elapsed = nowMs - this.originMs;
    while (this.cursor < this.records.length && this.records[this.cursor].atMs <= elapsed) {
      const { frame } = this.records[this.cursor++];
      const { occupancy, observedOffsetMs, ...rest } = frame;
      this.emit({ ...rest, source: 'replay', sequence: this.sequence++, observedAtMs: nowMs + Math.min(0, observedOffsetMs ?? 0), receivedAtMs: nowMs, occupancy: occupancy ? decodeOccupancy(occupancy.data, occupancy.width, occupancy.height) : undefined });
    }
    if (this.cursor >= this.records.length && this.loop) { this.cursor = 0; this.originMs = nowMs; }
  }
}
