import { describe, expect, it } from 'vitest';
import { TelemetryBus, type Transport } from '../../src/sim/telemetry/bus';
import { parseInbound, type TelemetryFrame, type TelemetryInbound, type TelemetryOutbound, type TelemetrySchema } from '../../src/sim/telemetry/types';

class FakeTransport implements Transport {
  readonly id: string; sent: TelemetryOutbound[] = []; inbound?: (m: TelemetryInbound) => void; closed = false;
  constructor(id = 'fake') { this.id = id; }
  open(onInbound: (m: TelemetryInbound) => void) { this.inbound = onInbound; }
  send(m: TelemetryOutbound) { this.sent.push(m); }
  status() { return { connected: true, detail: 'fake' }; }
  close() { this.closed = true; }
}
const schema = (): TelemetrySchema => ({ type: 'schema', v: 1, sim: { id: 's', title: 'S', description: '', params: {}, signals: {} }, sims: [], input: { hand: ['id'], gestures: [], sources: [] } });
const frame = (seq: number): TelemetryFrame => ({ type: 'frame', v: 1, t: seq / 30, seq, sim: { id: 's', params: {}, signals: { a: 1 } }, input: { source: 'synthetic', presence: 1, activity: 0, hands: [], events: [], sourceAgeMs: 0, stats: {} }, perf: { fps: 60, stepMs: 1, renderMs: 1 } });

describe('telemetry bus', () => {
  it('rate limits frames and fans out to transports and subscribers', () => {
    const bus = new TelemetryBus(30), t = new FakeTransport(); bus.addTransport(t);
    const seen: TelemetryOutbound[] = []; bus.subscribe(m => seen.push(m));
    let built = 0;
    for (let now = 0; now < 1000; now += 1000 / 60) bus.publishFrame(now, () => { built++; return frame(built); });
    expect(built).toBeGreaterThanOrEqual(29); expect(built).toBeLessThanOrEqual(31);
    expect(t.sent.length).toBe(built); expect(seen.length).toBe(built); expect(bus.sent).toBe(built);
  });
  it('replays the schema to late transports and answers schema requests and pings', () => {
    const bus = new TelemetryBus(); bus.publishSchema(schema());
    const late = new FakeTransport('late'); bus.addTransport(late);
    expect(late.sent[0].type).toBe('schema');
    late.inbound?.({ type: 'get-schema' });
    expect(late.sent.filter(m => m.type === 'schema')).toHaveLength(2);
    bus.receive('{"type":"ping","id":7}');
    expect(late.sent.at(-1)).toMatchObject({ type: 'status', message: 'pong 7' });
  });
  it('routes valid inbound commands and ignores garbage', () => {
    const bus = new TelemetryBus(); const got: TelemetryInbound[] = []; bus.onInbound(m => got.push(m));
    bus.receive({ type: 'set-param', name: 'x', value: 1 }); bus.receive('{"type":"select-sim","id":"basin"}'); bus.receive('nonsense'); bus.receive({ type: 'set-param' });
    expect(got.map(m => m.type)).toEqual(['set-param', 'select-sim']);
  });
  it('survives a throwing transport and closes transports on removal', () => {
    const bus = new TelemetryBus(1000), bad: Transport = { id: 'bad', open() {}, send() { throw new Error('boom'); }, status: () => ({ connected: false, detail: '' }), close() {} };
    const good = new FakeTransport(); bus.addTransport(bad); bus.addTransport(good);
    expect(bus.publishFrame(0, () => frame(1))).toBe(true); expect(good.sent).toHaveLength(1);
    bus.removeTransport('fake'); expect(good.closed).toBe(true); expect(bus.transportStatus().map(t => t.id)).toEqual(['bad']);
  });
  it('parses inbound messages strictly', () => {
    expect(parseInbound({ type: 'set-params', values: { a: 1, b: true, c: 'x' } })?.type).toBe('set-params');
    expect(parseInbound({ type: 'set-params', values: { a: { nested: 1 } } })).toBeNull();
    expect(parseInbound({ type: 'select-sim' })).toBeNull();
  });
});
