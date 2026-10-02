#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11,<3.13"  # python-rtmidi 1.5.8 ships Windows wheels up to 3.12; a source build on 3.13 crashes on import
# dependencies = ["python-rtmidi==1.5.8", "websockets==15.0.1"]
# ///
"""Local controls bridge. LiveMixer Beat Cycle owns all beat scheduling.

Built to run unattended: a failed MIDI or UDP send is logged (stderr, timestamped) and never ends the process,
a missing or vanished MIDI port is retried every 2 s, a busy network port is waited for, and SIGTERM/SIGHUP/SIGINT
(SIGBREAK on Windows) put Live at the fail-safe mix before exiting."""
import argparse
import asyncio
import json
import math
import re
import signal
import socket
import struct
import sys
import time

DEFAULTS = {"vocals": 1., "space": 0., "stutter": 0., "gain": 1.}
# What Live is left at on release, timeout, disconnect and shutdown. The Living home is instrumental;
# "full" (full vocals) is the original fail-safe of the two-song sets.
FAIL_SAFE = {"living": {"vocals": 0., "space": 0., "stutter": 0., "gain": 1.}, "full": DEFAULTS}
CC = {"vocals": 20, "space": 21, "gain": 23}
TIMEOUT = 1.5
# Living FX: /fx/values on UDP 7403. The hand-gesture values follow the original five; a page that predates
# a key omits it, which means home (FX_HOME), so older pages keep working.
FX = ("flicker", "dub", "dive", "halo", "balance", "muffleRhythm", "muffleMelodic", "tiltRhythm", "tiltMelodic",
      "levelRhythm", "levelMelodic", "freeze", "bloom", "span", "whoosh", "swarm")
FX_HOME = {"muffleRhythm": 0., "muffleMelodic": 0., "tiltRhythm": .5, "tiltMelodic": .5, "levelRhythm": .5,
           "levelMelodic": .5, "freeze": 0., "bloom": 0., "span": .5, "whoosh": 0., "swarm": 0.}
FX_HEARTBEAT = .25
RETRY = 2.          # seconds between attempts to open a MIDI port or bind a busy network port
PORT_CHECK = 5.     # seconds between checks that the open MIDI port still exists
LOG_INTERVAL = 60.  # a repeating failure is logged at most once per this many seconds
RESEND = 2.         # seconds between full resends of the mix CCs, so a CC Live missed (set not open yet) is corrected


class Log:
    """Timestamped lines on stderr; every() reports a repeating failure once per interval with a count."""
    def __init__(self, interval=LOG_INTERVAL, clock=time.monotonic, write=None):
        self.interval, self.clock, self.seen = interval, clock, {}
        self.write = write or (lambda line: print(line, file=sys.stderr, flush=True))

    def __call__(self, message):
        try: self.write(time.strftime("%Y-%m-%d %H:%M:%S ") + message)
        except Exception: pass  # a closed stderr must not stop the bridge either

    def every(self, key, message):
        now = self.clock()
        last, skipped = self.seen.get(key, (None, 0))
        if last is not None and now - last < self.interval:
            self.seen[key] = (last, skipped + 1); return False
        self(message + (f" ({skipped} more since the last report)" if skipped else ""))
        self.seen[key] = (now, 0); return True


LOG = Log()


def unit(name, value):
    if type(value) not in (int, float) or not math.isfinite(value) or not 0 <= value <= 1:
        raise ValueError(f"{name} must be a finite number from 0 to 1")
    return float(value)


def controls(raw):
    if not isinstance(raw, dict) or raw.get("type") != "controls":
        raise ValueError("Expected a controls message")
    return {name: unit(name, raw.get(name)) for name in DEFAULTS}


def fx_values(raw):
    """Optional living-mode effects: None when absent, else validated values in FX order (missing gesture keys are home)."""
    fx = raw.get("fx") if isinstance(raw, dict) else None
    if fx is None: return None
    if not isinstance(fx, dict): raise ValueError("fx must be an object")
    return tuple(unit(f"fx.{name}", fx.get(name, FX_HOME.get(name))) for name in FX)


def osc_string(value):
    data = value.encode() + b"\0"
    return data + b"\0" * (-len(data) % 4)


def osc_packet(address, *values):
    return osc_string(address) + osc_string("," + "f" * len(values)) + b"".join(struct.pack(">f", v) for v in values)


def osc_state(packet):
    """Decode the fixed seven-number status packet emitted by our Max device.

    Slots: repeat, onLeft, offLeft, beat, playing, amount, bound. `amount` carries Live's current Vocal Presence gain
    as the raw parameter value (Live 11 Utility Gain, -1..1, roughly 35 dB per unit: 0 = 0 dB, -1 = -inf); older
    devices send something else there. The bridge passes every slot through unchanged in status()["state"]."""
    def string(offset):
        end = packet.index(0, offset)
        return packet[offset:end].decode(), (end + 4) & ~3
    try:
        address, offset = string(0)
        tags, offset = string(offset)
        if address != "/livemixer/state" or len(tags) != 8 or tags[0] != ",": return None
        values = []
        for tag in tags[1:]:
            if tag not in "if": return None
            values.append(struct.unpack_from(">" + tag, packet, offset)[0]); offset += 4
        if not all(math.isfinite(v) for v in values): return None
        return dict(zip(("repeat", "onLeft", "offLeft", "beat", "playing", "amount", "bound"), values))
    except (ValueError, UnicodeError, struct.error):
        return None


def match_port(ports, name):
    """The one output called `name`. Windows appends a device index ("liveMixer 6") that shifts as devices come and go."""
    matches = [p for p in ports if p == name] or [p for p in ports if re.sub(r" \d+$", "", p) == name]
    return matches[0] if len(matches) == 1 else None


class MidiPort:
    """A MIDI output that survives a missing or vanished port (IAC Driver or loopMIDI restarted, interface unplugged).

    poll() (called every tick) opens the port when it is closed, at most every RETRY seconds, and checks every
    PORT_CHECK seconds that it still exists; it returns True when the port has just been (re)opened, so the caller
    resends its values. send_message() returns False instead of raising, and a failed send closes the port so the
    next poll reopens it."""
    def __init__(self, name, factory, clock=time.monotonic):
        self.name, self.factory, self.clock = name, factory, clock
        self.out, self.next_try, self.next_check = None, 0., 0.

    @property
    def is_open(self): return self.out is not None

    def poll(self):
        now = self.clock()
        if self.out is not None:
            if now >= self.next_check:
                self.next_check = now + PORT_CHECK
                try: present = match_port(self.out.get_ports(), self.name) is not None
                except Exception as error: present = False; LOG.every("midi-list", f"MIDI: listing ports failed: {error!r}")
                if not present:
                    LOG(f"MIDI output {self.name!r} disappeared; reopening when it is back"); self.close()
            return False
        if now < self.next_try: return False
        self.next_try = now + RETRY
        try:
            out = self.factory()
            ports = out.get_ports()
            port = match_port(ports, self.name)
            if port is None:
                LOG.every("midi-open", f"MIDI output {self.name!r} is unavailable (outputs: {', '.join(ports) or 'none'}); "
                                       f"retrying every {RETRY:g} s")
                return False
            out.open_port(ports.index(port), "LiveMixer bridge")
        except Exception as error:
            LOG.every("midi-open", f"MIDI: opening {self.name!r} failed: {error!r}; retrying every {RETRY:g} s")
            return False
        self.out, self.next_check = out, now + PORT_CHECK
        LOG(f"MIDI output {port!r} open"); LOG.seen.pop("midi-open", None)
        return True

    def send_message(self, message):
        if self.out is None: return False
        try:
            self.out.send_message(message); return True
        except Exception as error:
            LOG(f"MIDI send failed ({error!r}); reopening {self.name!r}")
            self.close(); self.next_try = 0.
            return False

    def close(self):
        out, self.out = self.out, None
        if out is None: return
        try: out.close_port()
        except Exception: pass


class Bridge:
    def __init__(self, midi, udp, fail_safe="living"):
        self.midi, self.udp = midi, udp
        self.home = dict(FAIL_SAFE[fail_safe] if isinstance(fail_safe, str) else fail_safe)
        self.last_midi = {}
        self.owner = None
        self.last_controls = 0.
        self.value = self.home.copy()
        self.state, self.last_state = None, 0.
        self.last_resend = None
        self.fx, self.last_fx = None, 0.

    def send_udp(self, packet, port):
        """Never raises: a failed send is logged (rate limited) and the next tick or heartbeat sends again."""
        try:
            self.udp.sendto(packet, ("127.0.0.1", port)); return True
        except Exception as error:
            LOG.every(f"udp-{port}", f"UDP send to 127.0.0.1:{port} failed: {error!r}"); return False

    def send_mix(self):
        """Sends each CC whose value differs from what Live last received; a failed CC is retried on the next call."""
        for name, cc in CC.items():
            v = round(self.value[name] * 127)
            if self.last_midi.get(name) == v: continue
            try: sent = self.midi.send_message([0xBF, cc, v]) is not False
            except Exception as error:
                sent = False; LOG.every("midi-send", f"MIDI send failed: {error!r}")
            if sent: self.last_midi[name] = v
            else: self.last_midi.pop(name, None)

    def send_fx(self, now):
        self.send_udp(osc_packet("/fx/values", *self.fx), 7403); self.last_fx = now

    def release_fx(self):
        if self.fx is None: return
        self.fx = None; self.send_udp(osc_packet("/fx/release", 1.), 7403)

    def osc(self, address, value):
        self.send_udp(osc_packet("/livemixer/" + address, value), 7400)

    def release(self):
        """Puts Live at the fail-safe mix. Every step is attempted even if another one fails."""
        self.owner, self.last_controls = None, 0.
        self.osc("release", 1.)
        self.release_fx()
        self.value = self.home.copy()
        self.last_midi.clear(); self.send_mix()

    def receive(self, client, message, now):
        value, fx = controls(message), fx_values(message)
        if self.owner is not None and self.owner is not client:
            raise ValueError("Another control window is connected")
        self.owner, self.last_controls, self.value = client, now, value
        self.send_mix()
        self.osc("stutter", value["stutter"])
        if fx is None: self.release_fx()
        elif fx != self.fx: self.fx = fx; self.send_fx(now)

    def live(self, now):
        """Living FX is bound to the set and its status is fresh."""
        return bool(self.state is not None and now - self.last_state < TIMEOUT and self.state.get("bound"))

    def receive_state(self, state, now):
        """A /livemixer/state packet. When Living FX becomes bound (Live just opened the set, or came back after
        going quiet) the whole mix is sent again at once: CCs sent before the set was open were lost."""
        was_live = self.live(now)
        self.state, self.last_state = state, now
        if not was_live and self.live(now):
            self.last_midi.clear(); self.send_mix()

    def tick(self, now):
        poll = getattr(self.midi, "poll", None)
        if poll is not None and poll(): self.last_midi.clear()  # port (re)opened: tell Live everything again
        if self.last_resend is None: self.last_resend = now
        elif now - self.last_resend >= RESEND - 1e-6:
            self.last_resend = now; self.last_midi.clear()  # a lost CC is never left uncorrected for long
        if self.owner is not None:
            if now - self.last_controls >= TIMEOUT:
                LOG("controls went quiet; releasing to the fail-safe mix")
                self.release()
            else:
                self.osc("stutter", self.value["stutter"])
                if self.fx is not None and now - self.last_fx >= FX_HEARTBEAT - 1e-6: self.send_fx(now)
        self.send_mix()

    def status(self, now, client=None):
        """Status for one connection: `owner` says whether `client` is the controls owner."""
        fresh = self.state is not None and now - self.last_state < TIMEOUT
        return {"type": "status", "live": self.live(now),
                "active": self.owner is not None, "state": self.state if fresh else None,
                "owner": client is not None and self.owner is client,
                "midi": bool(getattr(self.midi, "is_open", True)), "midiPort": getattr(self.midi, "name", None)}


def install_signal_handlers(loop, stop):
    """SIGTERM, SIGHUP, SIGINT (and SIGBREAK on Windows) set `stop`; run() then releases Live and exits."""
    def request(signum, *_):
        try: name = signal.Signals(signum).name
        except ValueError: name = str(signum)
        LOG(f"{name}: releasing Live and exiting")
        loop.call_soon_threadsafe(stop.set)
    installed = []
    for name in ("SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"):
        signum = getattr(signal, name, None)
        if signum is None: continue
        try:
            loop.add_signal_handler(signum, request, signum); installed.append(name)
        except (NotImplementedError, RuntimeError, ValueError):  # Windows event loops: plain handlers instead
            try: signal.signal(signum, request); installed.append(name)
            except (OSError, ValueError): pass
    return installed


async def pump(bridge, clients, stop, period=.05):
    """The 20 Hz loop: ticks the bridge and sends each client its status every other tick until `stop` is set.
    Never raises."""
    count = 0
    while not stop.is_set():
        now = time.monotonic(); count += 1
        try: bridge.tick(now)
        except Exception as error: LOG.every("tick", f"tick failed: {error!r}")
        for connection in list(clients) if count % 2 == 0 else ():
            try: message = json.dumps(bridge.status(now, connection))
            except Exception as error: LOG.every("status", f"status failed: {error!r}"); continue
            try: await connection.send(message)
            except Exception: clients.discard(connection)
        await asyncio.sleep(period)


async def bind(what, open_, stop):
    """Awaits open_() until it succeeds (a port in use is retried every RETRY seconds); None if stopped first."""
    while not stop.is_set():
        try: return await open_()
        except Exception as error:
            LOG.every(f"bind-{what}", f"{what} unavailable ({error!r}); retrying every {RETRY:g} s")
        try: await asyncio.wait_for(stop.wait(), RETRY)
        except (asyncio.TimeoutError, TimeoutError): pass
    return None


async def run(port, midi_port, fail_safe="living"):
    import rtmidi
    from websockets.asyncio.server import serve
    loop = asyncio.get_running_loop()
    stop = asyncio.Event()
    install_signal_handlers(loop, stop)
    midi = MidiPort(midi_port, rtmidi.MidiOut)
    udp = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    bridge, clients = Bridge(midi, udp, fail_safe), set()
    receiver = server = None

    class StatusReceiver(asyncio.DatagramProtocol):
        def datagram_received(self, data, addr):
            if addr[0] != "127.0.0.1": return
            state = osc_state(data)
            if state is None: return
            try: bridge.receive_state(state, time.monotonic())
            except Exception as error: LOG.every("state", f"status packet failed: {error!r}")

        def error_received(self, error):
            LOG.every("udp-7401", f"UDP 7401: {error!r}")

    async def client(connection):
        clients.add(connection)
        try:
            async for data in connection:
                try:
                    message = json.loads(data)
                    if isinstance(message, dict) and message.get("type") == "release":
                        if bridge.owner is connection: bridge.release()
                    else: bridge.receive(connection, message, time.monotonic())
                except (ValueError, TypeError) as error:
                    await connection.send(json.dumps({"type": "error", "message": str(error)}))
                except Exception as error:
                    LOG.every("client", f"message failed: {error!r}")
                    await connection.send(json.dumps({"type": "error", "message": "bridge error"}))
        finally:
            clients.discard(connection)
            if bridge.owner is connection: bridge.release()

    async def open_receiver():
        transport, _ = await loop.create_datagram_endpoint(StatusReceiver, local_addr=("127.0.0.1", 7401))
        return transport

    async def open_server():
        return await serve(client, "127.0.0.1", port, max_size=4096,
                           origins=[None, re.compile(r"http://(?:127\.0\.0\.1|localhost)(?::\d+)?")])

    ticking = asyncio.create_task(pump(bridge, clients, stop))  # retries MIDI while the ports are bound
    # Live's status port is bound on its own, so a busy 7401 costs only the beat relay, not the controls.
    receiving = asyncio.create_task(bind("UDP 127.0.0.1:7401", open_receiver, stop))
    try:
        server = await bind(f"WebSocket 127.0.0.1:{port}", open_server, stop)
        if server is not None:
            LOG(f"LiveMixer bridge: ws://127.0.0.1:{port} → {midi_port} (fail-safe {fail_safe}); open /ableton.html")
        await ticking
    finally:
        stop.set()
        try: receiver = await asyncio.wait_for(receiving, 1)
        except Exception: receiver = None
        for step in (lambda: server and server.close(), bridge.release, lambda: receiver and receiver.close(),
                     udp.close, midi.close):
            try: step()
            except Exception as error: LOG(f"shutdown step failed: {error!r}")
        if server is not None:
            try: await asyncio.wait_for(server.wait_closed(), 2)
            except Exception: pass
        LOG("bridge stopped")


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--port", type=int, default=9001)
    parser.add_argument("--midi-port", default="IAC Driver LiveMixer")
    parser.add_argument("--fail-safe", choices=sorted(FAIL_SAFE), default="living",
                        help="mix left in Live on release, timeout and shutdown: living = instrumental "
                             "(vocals 0, space 0, gain 1, the default); full = full vocals (two-song sets)")
    return parser.parse_args(argv)


def main(argv=None):
    args = parse_args(argv)
    for stream in (sys.stdout, sys.stderr):  # the status line's arrow on a Windows console
        try: stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception: pass
    try: asyncio.run(run(args.port, args.midi_port, args.fail_safe))
    except KeyboardInterrupt: pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
