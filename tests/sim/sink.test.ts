import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTelemetrySink, decodeFrames, encodeTextFrame, type TelemetrySink } from '../../scripts/telemetry-sink';

describe('websocket frame codec', () => {
  it('encodes short, medium and long text frames', () => {
    expect(Array.from(encodeTextFrame('hi').subarray(0, 2))).toEqual([0x81, 2]);
    const medium = encodeTextFrame('x'.repeat(300)); expect(medium[1]).toBe(126); expect(medium.readUInt16BE(2)).toBe(300);
    const long = encodeTextFrame('x'.repeat(70000)); expect(long[1]).toBe(127); expect(Number(long.readBigUInt64BE(2))).toBe(70000);
  });
  it('decodes masked client frames across chunk boundaries', () => {
    const payload = Buffer.from('{"type":"ping"}'), mask = Buffer.from([1, 2, 3, 4]);
    const masked = Buffer.from(payload.map((b, i) => b ^ mask[i & 3]));
    const frame = Buffer.concat([Buffer.from([0x81, 0x80 | payload.length]), mask, masked]);
    const first = decodeFrames(frame.subarray(0, 5));
    expect(first.frames).toHaveLength(0); expect(first.rest.length).toBe(5);
    const second = decodeFrames(Buffer.concat([first.rest, frame.subarray(5)]));
    expect(second.frames).toHaveLength(1); expect(second.frames[0].payload.toString()).toBe('{"type":"ping"}'); expect(second.rest.length).toBe(0);
  });
});

describe('telemetry sink', () => {
  let sink: TelemetrySink; const received: unknown[] = [];
  beforeAll(async () => { sink = await createTelemetrySink({ port: 0, onOpen: c => c.send({ type: 'get-schema' }), onMessage: m => received.push(m) }); });
  afterAll(async () => { await sink.close(); });
  it('accepts a browser-style client, exchanges JSON both ways, and closes cleanly', async () => {
    const socket = new WebSocket(`ws://127.0.0.1:${sink.port}`);
    const inbound: unknown[] = [];
    socket.onmessage = e => inbound.push(JSON.parse(String(e.data)));
    await new Promise<void>((resolve, reject) => { socket.onopen = () => resolve(); socket.onerror = () => reject(new Error('connect failed')); });
    socket.send(JSON.stringify({ type: 'frame', v: 1, sim: { signals: { a: .5 } } }));
    socket.send(JSON.stringify({ type: 'status', message: 'x'.repeat(200) }));
    await new Promise(r => setTimeout(r, 100));
    expect(received).toHaveLength(2); expect(received[0]).toMatchObject({ type: 'frame' });
    expect(inbound[0]).toEqual({ type: 'get-schema' });
    const closed = new Promise<void>(resolve => { socket.onclose = () => resolve(); });
    socket.close(); await closed;
  });
});
