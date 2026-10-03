import asyncio
import importlib.util
import os
from pathlib import Path
import signal
import struct
import sys
import unittest

spec = importlib.util.spec_from_file_location('ableton_bridge', Path(__file__).resolve().parents[1] / 'scripts/ableton-bridge.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class Midi:
    def __init__(self): self.messages = []
    def send_message(self, message): self.messages.append(message)
class UDP:
    def __init__(self): self.messages = []
    def sendto(self, message, address): self.messages.append((message, address))

class Quiet(unittest.TestCase):
    def setUp(self):
        self.log, self.now = [], 0.; self.write, self.clock = module.LOG.write, module.LOG.clock; module.LOG.seen.clear()
        module.LOG.write, module.LOG.clock = self.log.append, lambda: self.now
    def tearDown(self): module.LOG.write, module.LOG.clock = self.write, self.clock

class BridgeTests(Quiet):
    def test_rejects_invalid_values_before_controlling_any_parameter(self):
        for invalid in [float('nan'), float('inf'), -.1, 1.1, True, '0.5', None]:
            with self.assertRaises(ValueError): module.controls(dict(type='controls', **{**module.DEFAULTS, 'stutter': invalid}))

    def test_disconnect_timeout_releases_and_restores_mix(self):
        midi, udp = Midi(), UDP(); bridge = module.Bridge(midi, udp)
        bridge.receive('owner', dict(type='controls', vocals=0, space=1, stutter=1, gain=.5), 10)
        self.assertNotIn(22, [m[1] for m in midi.messages])  # Beat gate is never a MIDI on/off timer.
        bridge.tick(11.4); self.assertEqual(bridge.owner, 'owner')
        bridge.tick(11.5); self.assertIsNone(bridge.owner)
        self.assertEqual(midi.messages[-3:], [[0xBF,20,0],[0xBF,21,0],[0xBF,23,127]])  # Living home: instrumental
        self.assertIn(b'/livemixer/release', udp.messages[-1][0])

    def test_second_window_cannot_take_over_an_active_controller(self):
        bridge = module.Bridge(Midi(), UDP()); first, second = object(), object()
        bridge.receive(first, dict(type='controls', **module.DEFAULTS), 1)
        with self.assertRaises(ValueError): bridge.receive(second, dict(type='controls', **module.DEFAULTS), 2)
        self.assertIs(bridge.owner, first)

    def test_fx_values_are_validated_before_controlling_any_parameter(self):
        good = dict(flicker=0, dub=.1, dive=.2, halo=.3, balance=.5, **GESTURES)
        for invalid in [float('nan'), float('inf'), -.1, 1.1, True, '0.5', None]:
            for key in good:
                midi, udp = Midi(), UDP(); bridge = module.Bridge(midi, udp)
                with self.assertRaises(ValueError):
                    bridge.receive('owner', dict(type='controls', **module.DEFAULTS, fx={**good, key: invalid}), 1)
                self.assertEqual((midi.messages, udp.messages, bridge.owner), ([], [], None))
        for invalid in [[0, 0, 0, 0, .5], 'fx', 1, {}]:
            with self.assertRaises(ValueError): module.fx_values(dict(type='controls', fx=invalid))
        self.assertIsNone(module.fx_values(dict(type='controls')))

    def test_fx_values_are_sent_on_change_and_as_a_heartbeat(self):
        udp = UDP(); bridge = module.Bridge(Midi(), udp)
        fx = dict(flicker=0, dub=.25, dive=.5, halo=.75, balance=.625)
        bridge.receive('owner', dict(type='controls', **module.DEFAULTS, fx=fx), 10)
        sent = [m for m, a in udp.messages if a == ('127.0.0.1', 7403)]
        self.assertEqual(sent, [fx_packet(0, .25, .5, .75, .625, *HOME)])
        bridge.receive('owner', dict(type='controls', **module.DEFAULTS, fx=fx), 10.05)
        self.assertEqual(len(fx_sends(udp)), 1)  # unchanged: no resend
        bridge.tick(10.1); self.assertEqual(len(fx_sends(udp)), 1)
        bridge.tick(10.3); self.assertEqual(len(fx_sends(udp)), 2)  # heartbeat 250 ms after the last send
        bridge.receive('owner', dict(type='controls', **module.DEFAULTS, fx={**fx, 'dive': .6}), 10.31)
        self.assertEqual(len(fx_sends(udp)), 2)  # 10 ms after the last send: waits for the next tick
        bridge.tick(10.35)
        self.assertEqual(fx_sends(udp)[-1], fx_packet(0, .25, .6, .75, .625, *HOME))

    def test_a_burst_of_fx_changes_sends_only_the_newest_never_a_queue(self):
        udp = UDP(); bridge = module.Bridge(Midi(), udp)
        fx = dict(flicker=0, dub=0, dive=0, halo=0, balance=.5)
        for i in range(10):  # a 120 Hz page: ten changes inside 80 ms
            bridge.receive('owner', dict(type='controls', **module.DEFAULTS, fx={**fx, 'dive': i / 10}), 1 + i / 120)
        self.assertEqual(len(fx_sends(udp)), 2)  # the first, then one 40 ms later
        bridge.tick(1.1)
        self.assertEqual(len(fx_sends(udp)), 3)
        self.assertEqual(fx_sends(udp)[-1], fx_packet(0, 0, .9, 0, .5, *HOME))  # the newest; the rest were replaced

    def test_gesture_values_follow_the_first_five_in_contract_order(self):
        values = module.fx_values(dict(type='controls', fx=dict(flicker=0, dub=.1, dive=.2, halo=.3, balance=.5, **GESTURES)))
        self.assertEqual(module.FX[5:], tuple(GESTURES))
        self.assertEqual(values, (0, .1, .2, .3, .5, *GESTURES.values()))
        udp = UDP(); bridge = module.Bridge(Midi(), udp)
        bridge.receive('owner', dict(type='controls', **module.DEFAULTS, fx=dict(flicker=0, dub=.1, dive=.2, halo=.3, balance=.5, **GESTURES)), 1)
        self.assertEqual(fx_sends(udp), [fx_packet(0, .1, .2, .3, .5, *GESTURES.values())])
        packet = fx_sends(udp)[0]; self.assertEqual(len(packet), 12 + 20 + 4 * 16)  # address, ',' + 16 tags, 16 floats
        self.assertEqual(struct.unpack_from('>16f', packet, 32)[5:], tuple(GESTURES.values()))  # exact in float32

    def test_missing_gesture_values_mean_home_for_older_pages(self):
        old = module.fx_values(dict(type='controls', fx=dict(flicker=0, dub=.1, dive=.2, halo=.3, balance=.5)))
        self.assertEqual(old, (0, .1, .2, .3, .5, *HOME))
        partial = module.fx_values(dict(type='controls', fx=dict(flicker=0, dub=.1, dive=.2, halo=.3, balance=.5, freeze=1)))
        self.assertEqual(partial[11], 1.); self.assertEqual(partial[13], .5)

    def test_fx_release_on_timeout_disconnect_and_when_fx_stops(self):
        fx = dict(flicker=0, dub=0, dive=0, halo=0, balance=.5)
        udp = UDP(); bridge = module.Bridge(Midi(), udp)
        bridge.receive('owner', dict(type='controls', **module.DEFAULTS, fx=fx), 10)
        bridge.tick(11.5)
        self.assertEqual(fx_sends(udp)[-1], module.osc_packet('/fx/release', 1.))
        self.assertIn(b'/livemixer/release', udp.messages[-2][0])
        bridge.release(); self.assertEqual(fx_sends(udp).count(module.osc_packet('/fx/release', 1.)), 1)  # only once
        bridge.receive('owner', dict(type='controls', **module.DEFAULTS, fx=fx), 20)
        bridge.receive('owner', dict(type='controls', **module.DEFAULTS), 20.1)  # left living mode
        self.assertEqual(fx_sends(udp)[-1], module.osc_packet('/fx/release', 1.))
        bridge.tick(20.5); self.assertEqual(fx_sends(udp)[-1], module.osc_packet('/fx/release', 1.))  # no heartbeat

    def test_controls_without_fx_never_touch_the_fx_device(self):
        udp = UDP(); bridge = module.Bridge(Midi(), udp)
        bridge.receive('owner', dict(type='controls', **module.DEFAULTS), 1); bridge.tick(1.3); bridge.release()
        self.assertEqual(fx_sends(udp), [])

    def test_fail_safe_option_chooses_the_release_mix(self):
        for fail_safe, vocals in [('living', 0), ('full', 127)]:
            midi = Midi(); bridge = module.Bridge(midi, UDP(), fail_safe)
            bridge.receive('owner', dict(type='controls', vocals=.5, space=1, stutter=0, gain=.5), 1); bridge.release()
            self.assertEqual(midi.messages[-3:], [[0xBF,20,vocals],[0xBF,21,0],[0xBF,23,127]])
        self.assertEqual(module.parse_args([]).fail_safe, 'living')
        self.assertEqual(module.parse_args(['--fail-safe', 'full']).fail_safe, 'full')
        with self.assertRaises(SystemExit), open(os.devnull, 'w') as null:
            stderr, sys.stderr = sys.stderr, null
            try: module.parse_args(['--fail-safe', 'loud'])
            finally: sys.stderr = stderr

    def test_failing_sends_never_escape_tick_receive_or_release(self):
        midi, udp = Broken(), Broken(); bridge = module.Bridge(midi, udp)
        bridge.receive('owner', dict(type='controls', **module.DEFAULTS, fx=dict(flicker=0, dub=0, dive=0, halo=0, balance=.5)), 10)
        bridge.tick(10.3); bridge.tick(10.6)
        bridge.tick(12); self.assertIsNone(bridge.owner)  # the timeout still releases
        bridge.release()
        self.assertGreater(midi.calls, 3); self.assertGreater(udp.calls, 3)
        self.assertTrue(any('failed' in line for line in self.log))
        self.assertLess(len(self.log), 6)  # repeated failures are rate limited

    def test_release_reaches_live_even_when_osc_fails(self):
        midi = Midi(); bridge = module.Bridge(midi, Broken())
        bridge.receive('owner', dict(type='controls', vocals=1, space=1, stutter=0, gain=0), 1)
        bridge.release()
        self.assertEqual(midi.messages[-3:], [[0xBF,20,0],[0xBF,21,0],[0xBF,23,127]])

    def test_a_failed_cc_is_sent_again_on_the_next_tick(self):
        midi = Flaky(fail=1); bridge = module.Bridge(midi, UDP())
        bridge.receive('owner', dict(type='controls', vocals=1, space=0, stutter=0, gain=1), 1)
        self.assertNotIn([0xBF,20,127], midi.messages)
        bridge.tick(1.05); self.assertIn([0xBF,20,127], midi.messages)
        count = len(midi.messages); bridge.tick(1.1); self.assertEqual(len(midi.messages), count)  # nothing new

    def test_mix_is_resent_when_living_fx_becomes_bound(self):
        midi = Midi(); bridge = module.Bridge(midi, UDP())
        bridge.tick(0); self.assertEqual(len(midi.messages), 3)  # sent before the set was open: lost
        bridge.receive_state(module.osc_state(state_packet(bound=0)), .5); self.assertEqual(len(midi.messages), 3)
        bridge.receive_state(module.osc_state(state_packet(bound=1)), .6)
        self.assertEqual(midi.messages[3:], [[0xBF,20,0],[0xBF,21,0],[0xBF,23,127]])
        bridge.receive_state(module.osc_state(state_packet(bound=1)), .7); self.assertEqual(len(midi.messages), 6)  # still bound
        bridge.receive_state(module.osc_state(state_packet(bound=1)), 5)  # stale (Live went quiet), then back
        self.assertEqual(len(midi.messages), 9)

    def test_mix_is_resent_every_two_seconds(self):
        midi = Midi(); bridge = module.Bridge(midi, UDP())
        bridge.receive('owner', dict(type='controls', vocals=.5, space=1, stutter=0, gain=1), 0); bridge.tick(0)
        self.assertEqual(len(midi.messages), 3)
        for t in range(1, 41): bridge.receive('owner', dict(type='controls', vocals=.5, space=1, stutter=0, gain=1), t * .05); bridge.tick(t * .05)
        self.assertEqual(len(midi.messages), 6)  # one full resend at 2 s, nothing else
        self.assertEqual(midi.messages[3:], [[0xBF,20,64],[0xBF,21,127],[0xBF,23,127]])
        bridge.receive('owner', dict(type='controls', vocals=.5, space=1, stutter=0, gain=1), 4); bridge.tick(4)
        self.assertEqual(len(midi.messages), 9)

    def test_levels_from_living_fx_reach_the_status_while_fresh(self):
        # Live's meters (Main, RHYTHM, MELODIC) ride to the page so the simulations pulse with the audio.
        values = (.8, .6, -1.)
        packet = module.osc_packet('/livemixer/levels', *values)
        levels = module.osc_levels(packet)
        self.assertEqual(set(levels), {'main', 'rhythm', 'melodic'})
        for key, value in zip(('main', 'rhythm', 'melodic'), values):
            self.assertAlmostEqual(levels[key], value, places=5)
        self.assertIsNone(module.osc_levels(module.osc_packet('/livemixer/levels', .5)), 'wrong arity')
        self.assertIsNone(module.osc_state(packet), 'not a state packet')
        bridge = module.Bridge(Midi(), UDP())
        bridge.receive_levels(levels, 1)
        self.assertEqual(bridge.status(1.5)['levels'], levels)
        self.assertIsNone(bridge.status(3)['levels'])  # stale

    def test_status_reports_midi_owner_and_passes_state_through(self):
        class Port(Midi): name, is_open = 'IAC Driver LiveMixer', False
        midi = Port(); bridge = module.Bridge(midi, UDP()); first, second = object(), object()
        status = bridge.status(0, first)
        self.assertEqual(status, dict(type='status', live=False, active=False, state=None, owner=False,
                                      midi=False, midiPort='IAC Driver LiveMixer', levels=None))
        midi.is_open = True; bridge.receive(first, dict(type='controls', **module.DEFAULTS), 1)
        state = module.osc_state(state_packet(amount=-.25, bound=1)); bridge.receive_state(state, 1)
        self.assertEqual(state['amount'], -.25)
        status = bridge.status(1.1, first)
        self.assertEqual((status['owner'], status['active'], status['live'], status['midi']), (True, True, True, True))
        self.assertEqual(status['state']['amount'], -.25)
        self.assertFalse(bridge.status(1.1, second)['owner']); self.assertFalse(bridge.status(1.1)['owner'])
        self.assertIsNone(bridge.status(3, first)['state'])  # stale
        self.assertEqual(module.Bridge(Midi(), UDP()).status(0)['midiPort'], None)

    def test_pump_sends_each_client_its_own_owner_flag(self):
        import json
        bridge = module.Bridge(Midi(), UDP())
        class Client:
            def __init__(self): self.messages = []
            async def send(self, message): self.messages.append(json.loads(message))
        first, second = Client(), Client()
        bridge.receive(first, dict(type='controls', **module.DEFAULTS), 1e9)  # never times out during the test
        async def scenario():
            stop = asyncio.Event()
            asyncio.get_running_loop().call_later(.1, stop.set)
            await asyncio.wait_for(module.pump(bridge, {first, second}, stop, period=.005), 2)
        asyncio.run(scenario())
        self.assertTrue(first.messages and all(m['owner'] for m in first.messages))
        self.assertTrue(second.messages and not any(m['owner'] for m in second.messages))

class MidiPortTests(Quiet):
    def setUp(self):
        super().setUp(); self.ports, self.outs = [], []
    def port(self, name='IAC Driver LiveMixer'):
        def factory():
            out = FakeOut(self.ports); self.outs.append(out); return out
        return module.MidiPort(name, factory, clock=lambda: self.now)

    def test_missing_port_is_retried_every_two_seconds_and_logged_once_a_minute(self):
        port = self.port()
        self.assertFalse(port.poll()); self.assertFalse(port.send_message([0xBF, 20, 0]))
        self.now = 1.9; self.assertFalse(port.poll()); self.assertEqual(len(self.outs), 1)  # waits RETRY
        for t in range(2, 40, 2): self.now = t; self.assertFalse(port.poll())
        self.assertEqual(len(self.log), 1)
        self.now = 61; port.poll(); self.assertEqual(len(self.log), 2); self.assertIn('more since', self.log[-1])
        self.ports.append('IAC Driver LiveMixer'); self.now = 63
        self.assertTrue(port.poll()); self.assertTrue(port.is_open)
        self.assertTrue(port.send_message([0xBF, 20, 0])); self.assertEqual(self.outs[-1].sent, [[0xBF, 20, 0]])

    def test_index_suffixed_windows_names_still_match_but_ambiguity_does_not(self):
        self.ports.extend(['Microsoft GS Wavetable Synth 0', 'liveMixer 6'])
        port = self.port('liveMixer'); self.assertTrue(port.poll()); self.assertEqual(self.outs[-1].opened, 1)
        self.assertIsNone(module.match_port(['liveMixer 1', 'liveMixer 2'], 'liveMixer'))
        self.assertEqual(module.match_port(['liveMixer', 'liveMixer 2'], 'liveMixer'), 'liveMixer')

    def test_a_failed_send_closes_and_reopens_the_port(self):
        self.ports.append('IAC Driver LiveMixer'); port = self.port(); self.assertTrue(port.poll())
        self.outs[-1].broken = True
        self.assertFalse(port.send_message([0xBF, 20, 0])); self.assertFalse(port.is_open); self.assertTrue(self.outs[-1].closed)
        self.assertTrue(port.poll()); self.assertEqual(len(self.outs), 2)  # reopened at once, then RETRY applies

    def test_a_vanished_port_is_noticed_and_reopened_when_it_returns(self):
        self.ports.append('IAC Driver LiveMixer'); port = self.port(); port.poll()
        self.ports.clear(); self.now = 5; self.assertFalse(port.poll()); self.assertFalse(port.is_open)
        self.now = 7; self.assertFalse(port.poll())
        self.ports.append('IAC Driver LiveMixer'); self.now = 9; self.assertTrue(port.poll())

    def test_bridge_resends_the_mix_when_the_port_reopens(self):
        self.ports.append('IAC Driver LiveMixer'); port = self.port(); bridge = module.Bridge(port, UDP())
        bridge.tick(0)  # first open: Live is told the fail-safe mix at once
        self.assertEqual(self.outs[-1].sent, [[0xBF,20,0],[0xBF,21,0],[0xBF,23,127]])
        self.outs[-1].broken = True; bridge.receive('owner', dict(type='controls', vocals=1, space=0, stutter=0, gain=1), .1)
        bridge.tick(.15)  # reopened: every CC again, with the current values
        self.assertEqual(self.outs[-1].sent, [[0xBF,20,127],[0xBF,21,0],[0xBF,23,127]])

class ShutdownTests(Quiet):
    def test_pump_survives_a_failing_tick_and_stops_on_request(self):
        class Exploding:
            ticks = 0
            def tick(self, now): self.ticks += 1; raise OSError('send failed')
            def status(self, now): raise RuntimeError('status failed')
        class Client:
            async def send(self, message): raise AssertionError('no status when status fails')
        bridge = Exploding()
        async def scenario():
            stop = asyncio.Event()
            asyncio.get_running_loop().call_later(.1, stop.set)
            await asyncio.wait_for(module.pump(bridge, {Client()}, stop, period=.005), 2)
        asyncio.run(scenario())
        self.assertGreater(bridge.ticks, 3)

    def test_termination_signals_request_a_clean_stop(self):
        names = [n for n in ('SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK') if hasattr(signal, n)]
        saved = {n: signal.getsignal(getattr(signal, n)) for n in names}
        async def scenario():
            loop, stop = asyncio.get_running_loop(), asyncio.Event()
            installed = module.install_signal_handlers(loop, stop)
            self.assertIn('SIGINT', installed)
            if sys.platform == 'win32': signal.getsignal(signal.SIGINT)(signal.SIGINT, None)
            else: os.kill(os.getpid(), signal.SIGTERM)
            await asyncio.wait_for(stop.wait(), 2)
        try: asyncio.run(scenario())
        finally:
            for n, handler in saved.items(): signal.signal(getattr(signal, n), handler)
        self.assertTrue(any('releasing Live' in line for line in self.log))

class Broken:
    def __init__(self): self.calls = 0
    def send_message(self, message): self.calls += 1; raise RuntimeError('MIDI gone')
    def sendto(self, message, address): self.calls += 1; raise OSError('network down')
class Flaky(Midi):
    def __init__(self, fail): super().__init__(); self.fail = fail
    def send_message(self, message):
        if self.fail: self.fail -= 1; raise RuntimeError('MIDI hiccup')
        super().send_message(message)
class FakeOut:
    def __init__(self, ports): self.ports, self.sent, self.opened, self.closed, self.broken = ports, [], None, False, False
    def get_ports(self): return list(self.ports)
    def open_port(self, index, name): self.opened = index
    def close_port(self): self.closed = True
    def send_message(self, message):
        if self.broken: raise RuntimeError('port vanished')
        self.sent.append(message)

# Gesture keys in contract order with distinct non-home values, and their home values.
GESTURES = dict(muffleRhythm=.125, muffleMelodic=.25, tiltRhythm=.375, tiltMelodic=.625, levelRhythm=.75, levelMelodic=.875, freeze=1, bloom=.0625, span=.9375, whoosh=.3125, swarm=.4375)
HOME = (0, 0, .5, .5, .5, .5, 0, 0, .5, 0, 0)

def fx_sends(udp): return [m for m, a in udp.messages if a == ('127.0.0.1', 7403)]
def fx_packet(*values): return module.osc_packet('/fx/values', *values)
def state_packet(amount=0., bound=1.): return module.osc_packet('/livemixer/state', 0., 0., 0., 1., 1., amount, bound)

if __name__ == '__main__': unittest.main()
