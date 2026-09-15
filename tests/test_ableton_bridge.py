import importlib.util
from pathlib import Path
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

if __name__ == '__main__': unittest.main()
