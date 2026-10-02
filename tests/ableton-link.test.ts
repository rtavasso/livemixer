import { describe, it, expect } from 'vitest';
import { BridgeLink, initialWanted, parseConnect, type LinkState, type SocketLike } from '../src/ableton/link';

class FakeSocket implements SocketLike {
  readyState = 0;
  onopen: ((event: unknown) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  sent: string[] = [];
  send(data: string) { this.sent.push(data); }
  close() { this.drop(); }
  accept() { this.readyState = 1; this.onopen?.({}); }
  drop() { if (this.readyState === 3) return; this.readyState = 3; this.onerror?.({}); this.onclose?.({}); }
}

function harness() {
  const sockets: FakeSocket[] = [], timers: { fn: () => void; ms: number; cancelled: boolean }[] = [], states: LinkState[] = [];
  let opened = 0;
  const link = new BridgeLink({
    open: () => { const s = new FakeSocket(); sockets.push(s); return s; },
    onState: s => states.push(s),
    onOpen: () => { opened++; },
    schedule: (fn, ms) => { const t = { fn, ms, cancelled: false }; timers.push(t); return t; },
    cancel: handle => { (handle as { cancelled: boolean }).cancelled = true; },
  });
  const pending = () => timers.filter(t => !t.cancelled);
  const fire = () => { const live = pending(); for (const t of live) { t.cancelled = true; t.fn(); } return live.length; };
  return { link, sockets, timers, states, pending, fire, opened: () => opened };
}

describe('connect parameter', () => {
  it('parses ?connect=1 and its variants', () => {
    expect(parseConnect('?connect=1')).toBe(true);
    expect(parseConnect('?connect')).toBe(true);
    expect(parseConnect('?a=b&connect=true')).toBe(true);
    expect(parseConnect('?connect=0')).toBe(false);
    expect(parseConnect('?connect=off')).toBe(false);
    expect(parseConnect('?connect=maybe')).toBeNull();
    expect(parseConnect('')).toBeNull();
  });
  it('lets the URL win over the stored operator choice, which wins over not connecting', () => {
    expect(initialWanted('?connect=1', '0')).toBe(true);
    expect(initialWanted('?connect=0', '1')).toBe(false);
    expect(initialWanted('', '1')).toBe(true);
    expect(initialWanted('', '0')).toBe(false);
    expect(initialWanted('', null)).toBe(false);
  });
});

describe('bridge link', () => {
  it('reconnects every 2 s while wanted, with exactly one retry pending at a time', () => {
    const h = harness();
    h.link.start(); h.link.start();
    expect(h.sockets).toHaveLength(1);
    h.sockets[0].accept();
    expect(h.opened()).toBe(1);
    expect(h.link.send({ type: 'controls' })).toBe(true);
    h.sockets[0].drop();
    expect(h.states.at(-1)).toBe('reconnecting');
    expect(h.pending()).toHaveLength(1);
    expect(h.pending()[0].ms).toBe(2000);
    h.link.start();
    expect(h.sockets).toHaveLength(1);
    // Bridge still down: each failed attempt schedules exactly one more.
    for (let i = 0; i < 3; i++) { expect(h.fire()).toBe(1); h.sockets.at(-1)!.drop(); expect(h.pending()).toHaveLength(1); }
    h.fire(); h.sockets.at(-1)!.accept();
    expect(h.link.open).toBe(true);
    expect(h.opened()).toBe(2);
    expect(h.pending()).toHaveLength(0);
  });

  it('ignores the close of an orphan socket instead of starting a second loop', () => {
    const h = harness();
    h.link.start(); h.sockets[0].accept();
    h.link.stop();
    expect(h.states.at(-1)).toBe('disconnected');
    h.link.start(); h.sockets[1].accept();
    // The first socket closes late (already orphaned): no retry, the live socket stays.
    h.sockets[0].readyState = 1; h.sockets[0].drop();
    expect(h.pending()).toHaveLength(0);
    expect(h.link.open).toBe(true);
    expect(h.states.at(-1)).toBe('open');
  });

  it('stops retrying on stop and does not send when closed', () => {
    const h = harness();
    h.link.start(); h.sockets[0].drop();
    expect(h.pending()).toHaveLength(1);
    h.link.stop();
    expect(h.pending()).toHaveLength(0);
    expect(h.link.wanted).toBe(false);
    expect(h.link.send({ type: 'release' })).toBe(false);
    expect(h.sockets).toHaveLength(1);
  });

  it('retries when opening the socket throws', () => {
    const timers: (() => void)[] = [];
    let attempts = 0;
    const link = new BridgeLink({ open: () => { attempts++; throw new Error('blocked'); }, onState: () => {}, schedule: fn => timers.push(fn), cancel: () => {} });
    link.start();
    expect(attempts).toBe(1);
    expect(timers).toHaveLength(1);
    timers.shift()!();
    expect(attempts).toBe(2);
    expect(timers).toHaveLength(1);
  });
});
