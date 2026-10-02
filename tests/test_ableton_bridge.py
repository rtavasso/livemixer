import importlib.util
from pathlib import Path
import struct
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

class BridgeTests(unittest.TestCase):
    def test_rejects_invalid_values_before_controlling_any_parameter(self):
        for invalid in [float('nan'), float('inf'), -.1, 1.1, True, '0.5', None]:
            with self.assertRaises(ValueError): module.controls(dict(type='controls', **{**module.DEFAULTS, 'stutter': invalid}))

    def test_disconnect_timeout_releases_and_restores_mix(self):
        midi, udp = Midi(), UDP(); bridge = module.Bridge(midi, udp)
        bridge.receive('owner', dict(type='controls', vocals=0, space=1, stutter=1, gain=.5), 10)
        self.assertNotIn(22, [m[1] for m in midi.messages])  # Beat gate is never a MIDI on/off timer.
        bridge.tick(11.4); self.assertEqual(bridge.owner, 'owner')
        bridge.tick(11.5); self.assertIsNone(bridge.owner)
        self.assertEqual(midi.messages[-3:], [[0xBF,20,127],[0xBF,21,0],[0xBF,23,127]])
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
        self.assertEqual(fx_sends(udp)[-1], fx_packet(0, .25, .6, .75, .625, *HOME))

    def test_gesture_values_follow_the_first_five_in_contract_order(self):
        values = module.fx_values(dict(type='controls', fx=dict(flicker=0, dub=.1, dive=.2, halo=.3, balance=.5, **GESTURES)))
        self.assertEqual(module.FX[5:], tuple(GESTURES))
        self.assertEqual(values, (0, .1, .2, .3, .5, *GESTURES.values()))
        udp = UDP(); bridge = module.Bridge(Midi(), udp)
        bridge.receive('owner', dict(type='controls', **module.DEFAULTS, fx=dict(flicker=0, dub=.1, dive=.2, halo=.3, balance=.5, **GESTURES)), 1)
        self.assertEqual(fx_sends(udp), [fx_packet(0, .1, .2, .3, .5, *GESTURES.values())])
        packet = fx_sends(udp)[0]; self.assertEqual(len(packet), 12 + 20 + 4 * 15)  # address, ',' + 15 tags, 15 floats
        self.assertEqual(struct.unpack_from('>15f', packet, 32)[5:], tuple(GESTURES.values()))  # exact in float32

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

# Gesture keys in contract order with distinct non-home values, and their home values.
GESTURES = dict(muffleRhythm=.125, muffleMelodic=.25, tiltRhythm=.375, tiltMelodic=.625, levelRhythm=.75, levelMelodic=.875, freeze=1, bloom=.0625, span=.9375, whoosh=.3125)
HOME = (0, 0, .5, .5, .5, .5, 0, 0, .5, 0)

def fx_sends(udp): return [m for m, a in udp.messages if a == ('127.0.0.1', 7403)]
def fx_packet(*values): return module.osc_packet('/fx/values', *values)

if __name__ == '__main__': unittest.main()
