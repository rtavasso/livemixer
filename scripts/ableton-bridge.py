#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["python-rtmidi==1.5.8", "websockets==15.0.1"]
# ///
"""Local controls bridge. LiveMixer Beat Cycle owns all beat scheduling."""
import argparse
import asyncio
import json
import math
import re
import socket
import struct
import time

DEFAULTS = {"vocals": 1., "space": 0., "stutter": 0., "gain": 1.}
CC = {"vocals": 20, "space": 21, "gain": 23}
TIMEOUT = 1.5
FX = ("flicker", "dub", "dive", "halo", "balance")  # Two Song FX: /fx/values on UDP 7403
FX_HEARTBEAT = .25


def unit(name, value):
    if type(value) not in (int, float) or not math.isfinite(value) or not 0 <= value <= 1:
        raise ValueError(f"{name} must be a finite number from 0 to 1")
    return float(value)


def controls(raw):
    if not isinstance(raw, dict) or raw.get("type") != "controls":
        raise ValueError("Expected a controls message")
    return {name: unit(name, raw.get(name)) for name in DEFAULTS}


def fx_values(raw):
    """Optional living-mode effects: None when absent, else five validated values in FX order."""
    fx = raw.get("fx") if isinstance(raw, dict) else None
    if fx is None: return None
    if not isinstance(fx, dict): raise ValueError("fx must be an object")
    return tuple(unit(f"fx.{name}", fx.get(name)) for name in FX)


def osc_string(value):
    data = value.encode() + b"\0"
    return data + b"\0" * (-len(data) % 4)


def osc_packet(address, *values):
    return osc_string(address) + osc_string("," + "f" * len(values)) + b"".join(struct.pack(">f", v) for v in values)


def osc_state(packet):
    """Decode the fixed seven-number status packet emitted by our Max device."""
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


class Bridge:
    def __init__(self, midi, udp):
        self.midi, self.udp = midi, udp
        self.last_midi = {}
        self.owner = None
        self.last_controls = 0.
        self.value = DEFAULTS.copy()
        self.state, self.last_state = None, 0.
        self.fx, self.last_fx = None, 0.

    def send_fx(self, now):
        self.udp.sendto(osc_packet("/fx/values", *self.fx), ("127.0.0.1", 7403)); self.last_fx = now

    def release_fx(self):
        if self.fx is None: return
        self.udp.sendto(osc_packet("/fx/release", 1.), ("127.0.0.1", 7403)); self.fx = None

    def osc(self, address, value):
        self.udp.sendto(osc_packet("/livemixer/" + address, value), ("127.0.0.1", 7400))

    def release(self):
        self.osc("release", 1.)
        self.release_fx()
        self.value = DEFAULTS.copy()
        for name, cc in CC.items():
            value = round(self.value[name] * 127)
            self.midi.send_message([0xBF, cc, value])
            self.last_midi[name] = value
        self.owner, self.last_controls = None, 0.

    def receive(self, client, message, now):
        value, fx = controls(message), fx_values(message)
        if self.owner is not None and self.owner is not client:
            raise ValueError("Another control window is connected")
        self.owner, self.last_controls, self.value = client, now, value
        for name, cc in CC.items():
            v = round(value[name] * 127)
            if self.last_midi.get(name) != v:
                self.midi.send_message([0xBF, cc, v]); self.last_midi[name] = v
        self.osc("stutter", value["stutter"])
        if fx is None: self.release_fx()
        elif fx != self.fx: self.fx = fx; self.send_fx(now)

    def tick(self, now):
        if self.owner is None: return
        if now - self.last_controls >= TIMEOUT:
            self.release()
        else:
            self.osc("stutter", self.value["stutter"])
            if self.fx is not None and now - self.last_fx >= FX_HEARTBEAT - 1e-6: self.send_fx(now)

    def status(self, now):
        fresh = self.state is not None and now - self.last_state < TIMEOUT
        return {"type": "status", "live": bool(fresh and self.state["bound"]),
                "active": self.owner is not None, "state": self.state if fresh else None}


async def run(port, midi_port):
    import rtmidi
    from websockets.asyncio.server import serve
    midi = rtmidi.MidiOut()
    ports = midi.get_ports()
    if midi_port not in ports: raise RuntimeError(f"MIDI output {midi_port!r} is unavailable")
    midi.open_port(ports.index(midi_port), "LiveMixer bridge")
    udp = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    bridge, clients = Bridge(midi, udp), set()

    class StatusReceiver(asyncio.DatagramProtocol):
        def datagram_received(self, data, addr):
            if addr[0] != "127.0.0.1": return
            state = osc_state(data)
            if state is not None: bridge.state, bridge.last_state = state, time.monotonic()

    receiver, _ = await asyncio.get_running_loop().create_datagram_endpoint(StatusReceiver, local_addr=("127.0.0.1", 7401))

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
        finally:
            clients.discard(connection)
            if bridge.owner is connection: bridge.release()

    try:
        async with serve(client, "127.0.0.1", port, max_size=4096,
                         origins=[None, re.compile(r"http://(?:127\.0\.0\.1|localhost)(?::\d+)?")]):
            print(f"LiveMixer bridge: ws://127.0.0.1:{port} → {midi_port}; open /ableton.html", flush=True)
            tick = 0
            while True:
                now = time.monotonic(); bridge.tick(now); tick += 1
                if tick % 2 == 0:
                    message = json.dumps(bridge.status(now))
                    for connection in list(clients):
                        try: await connection.send(message)
                        except Exception: clients.discard(connection)
                await asyncio.sleep(.05)
    finally:
        bridge.release(); receiver.close(); udp.close(); midi.close_port()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=9001)
    parser.add_argument("--midi-port", default="IAC Driver LiveMixer")
    args = parser.parse_args()
    try: asyncio.run(run(args.port, args.midi_port))
    except KeyboardInterrupt: pass
