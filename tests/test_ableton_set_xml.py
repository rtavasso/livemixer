"""Structural checks on a mix written by scripts/ableton_set/als.py.

Builds a two-song set from tiny silent WAVs and synthetic timing, then checks
what Live rejects or silently mishandles: duplicate Ids, send knobs without
return tracks, envelopes pointing nowhere, and unordered warp markers.
"""
import gzip
import sys
import tempfile
import unittest
import wave
import xml.etree.ElementTree as ET
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

from ableton_set import transitions as tx  # noqa: E402
from ableton_set.als import Living, quiet_zones, write_mix  # noqa: E402

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_ableton_transitions import STEMS, song  # noqa: E402


def silent_wav(path, seconds, rate=8000):
    with wave.open(str(path), "wb") as f:
        f.setnchannels(2)
        f.setsampwidth(2)
        f.setframerate(rate)
        f.writeframes(b"\0" * 4 * int(seconds * rate))
    return int(seconds * rate), rate


class MixXmlTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        root = Path(cls.tmp.name)
        songs = [song("A", 90, 48, first=0.4, pickup=1, camelot="8A"),
                 song("B", 120, 48, camelot="8B"),
                 song("C", 122, 48, camelot="9B")]
        rendered = []
        for s in songs:
            folder = root / s.name
            folder.mkdir()
            stems = [(n, folder / f"{n}.wav") for n in STEMS]
            for _, path in stems:
                frames, rate = silent_wav(path, s.duration)
            rendered.append((stems, frames, rate))
        cls.plan = tx.plan(songs, 16)
        cls.output = root / "Mix.als"
        write_mix(cls.plan, tx.automation(cls.plan), rendered, cls.output, [1, 5, 9], living=cls.living())
        cls.live_set = ET.fromstring(gzip.open(cls.output).read()).find("LiveSet")

    @staticmethod
    def living():
        return None

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def test_pointee_ids_unique_and_below_next(self):
        ids = [int(e.get("Id")) for e in self.live_set.iter()
               if "Id" in e.attrib and (e.tag.endswith("Target") or e.tag == "Pointee")]
        self.assertEqual(len(ids), len(set(ids)))
        self.assertLess(max(ids), int(self.live_set.find("NextPointeeId").get("Value")))

    def test_tracks_unique_grouped_and_before_returns(self):
        tracks = list(self.live_set.find("Tracks"))
        ids = [t.get("Id") for t in tracks]
        self.assertEqual(len(ids), len(set(ids)))
        kinds = [t.tag for t in tracks]
        self.assertEqual(kinds[-2:], ["ReturnTrack", "ReturnTrack"])
        self.assertEqual(kinds.count("GroupTrack"), 3)
        groups = {t.get("Id") for t in tracks if t.tag == "GroupTrack"}
        for t in tracks:
            if t.tag == "AudioTrack":
                self.assertIn(t.find("TrackGroupId").get("Value"), groups)

    def test_send_counts_match_returns(self):
        tracks = list(self.live_set.find("Tracks"))
        returns = sum(t.tag == "ReturnTrack" for t in tracks)
        for t in tracks:
            self.assertEqual(len(t.find("DeviceChain/Mixer/Sends")), returns)

    def test_envelopes_target_existing_parameters(self):
        targets = {e.get("Id") for e in self.live_set.iter("AutomationTarget")}
        envelopes = list(self.live_set.iter("AutomationEnvelope"))
        self.assertGreater(len(envelopes), 3)
        for envelope in envelopes:
            self.assertIn(envelope.find("EnvelopeTarget/PointeeId").get("Value"), targets)
            times = [float(e.get("Time")) for e in envelope.iter("FloatEvent")]
            self.assertEqual(times, sorted(times))
            self.assertEqual(len(times), len(set(times)))

    def test_clips_warped_with_ascending_markers(self):
        clips = list(self.live_set.iter("AudioClip"))
        self.assertEqual(len(clips), 3 * len(STEMS))
        for clip in clips:
            self.assertEqual(clip.find("IsWarped").get("Value"), "true")
            markers = [(float(m.get("SecTime")), float(m.get("BeatTime"))) for m in clip.find("WarpMarkers")]
            self.assertEqual([m[0] for m in markers], sorted(m[0] for m in markers))
            self.assertEqual([m[1] for m in markers], sorted(m[1] for m in markers))
            start, end = float(clip.find("CurrentStart").get("Value")), float(clip.find("CurrentEnd").get("Value"))
            loop = clip.find("Loop")
            self.assertAlmostEqual(float(loop.find("LoopEnd").get("Value")) - float(loop.find("LoopStart").get("Value")), end - start)
            self.assertGreaterEqual(start, 0)

    def test_tempo_and_locators(self):
        events = self.live_set.find("MainTrack/AutomationEnvelopes/Envelopes")
        tempo_target = self.live_set.find("MainTrack/DeviceChain/Mixer/Tempo/AutomationTarget").get("Id")
        tempo = [e for e in events if e.find("EnvelopeTarget/PointeeId").get("Value") == tempo_target]
        self.assertEqual(len(tempo), 1)
        values = [float(e.get("Value")) for e in tempo[0].iter("FloatEvent")]
        self.assertEqual(values[0], 90)
        self.assertEqual(len(list(self.live_set.iter("Locator"))), 3)



def name(track):
    return track.find("Name/EffectiveName").get("Value")


class LivingMixXmlTest(MixXmlTest):
    """The same checks on a living set, plus its groups, devices and FX QUIET markers."""

    @staticmethod
    def living():
        return Living()

    def test_tracks_unique_grouped_and_before_returns(self):
        tracks = list(self.live_set.find("Tracks"))
        ids = [t.get("Id") for t in tracks]
        self.assertEqual(len(ids), len(set(ids)))
        self.assertEqual([t.tag for t in tracks][-2:], ["ReturnTrack", "ReturnTrack"])
        by_id = {t.get("Id"): t for t in tracks}
        songs = [t for t in tracks if t.tag == "GroupTrack" and t.find("TrackGroupId").get("Value") == "-1"]
        self.assertEqual(len(songs), 3)
        for song_group in songs:
            children = [t for t in tracks if t.find("TrackGroupId").get("Value") == song_group.get("Id")]
            self.assertEqual([name(t) for t in children], ["DRUM FX", "04 Bass", "TEXTURE FX", "VOCALS"])
        expected = {"01 Kick": "DRUM FX", "02 Snare": "DRUM FX", "03 Other Drums": "DRUM FX", "05 Guitar": "TEXTURE FX",
                    "06 Piano": "TEXTURE FX", "07 Melodies": "TEXTURE FX", "08 Lead Vocals": "VOCALS", "09 Background Vocals": "VOCALS"}
        for t in tracks:
            if t.tag == "AudioTrack" and name(t) in expected:
                self.assertEqual(name(by_id[t.find("TrackGroupId").get("Value")]), expected[name(t)])
        # A parent always comes before its children in Live's track list.
        position = {t.get("Id"): i for i, t in enumerate(tracks)}
        for t in tracks:
            parent = t.find("TrackGroupId").get("Value") if t.find("TrackGroupId") is not None else "-1"
            if parent != "-1":
                self.assertLess(position[parent], position[t.get("Id")])

    def test_group_devices_and_one_vocal_mapping(self):
        tracks = list(self.live_set.find("Tracks"))
        texture = [t for t in tracks if name(t) == "TEXTURE FX"]
        vocals = [t for t in tracks if name(t) == "VOCALS"]
        self.assertEqual(len(texture), 3)
        for t in texture:
            self.assertIsNotNone(t.find("DeviceChain/DeviceChain/Devices/AutoFilter2"))
        mapped = [bool(list(t.iter("KeyMidi"))) for t in vocals]
        self.assertEqual(mapped, [True, False, False])
        cc = [k.find("NoteOrController").get("Value") for k in vocals[0].iter("KeyMidi")]
        self.assertEqual(cc, ["20"])
        for t in [t for t in tracks if name(t) == "DRUM FX"]:
            self.assertEqual(list(t.find("DeviceChain/DeviceChain/Devices")), [])

    def test_returns_and_main_chain(self):
        returns = [name(t) for t in self.live_set.findall("Tracks/ReturnTrack")]
        self.assertEqual(returns, ["A-DUB THROW", "B-HALO BLOOM"])
        main = list(self.live_set.find("MainTrack/DeviceChain/DeviceChain/Devices"))
        self.assertEqual([d.tag for d in main], ["Reverb", "StereoGain", "Limiter", "MxDeviceAudioEffect"])
        self.assertEqual(len({d.get("Id") for d in main}), len(main))
        ref = main[-1].find("PatchSlot/Value/MxPatchRef/FileRef")
        path = Path(ref.find("Path").get("Value"))
        self.assertEqual(path.name, "LiveMixer Living FX.amxd")
        self.assertTrue(path.exists())
        self.assertTrue((path.parent / "living-fx.js").exists())
        self.assertEqual((self.output.parent / ref.find("RelativePath").get("Value")).resolve(), path.resolve())
        ccs = sorted(k.find("NoteOrController").get("Value") for k in self.live_set.find("MainTrack").iter("KeyMidi"))
        self.assertEqual(ccs, ["21", "23"])

    def test_tempo_and_locators(self):
        locators = [(float(l.find("Time").get("Value")), l.find("Name").get("Value")) for l in self.live_set.iter("Locator")]
        self.assertEqual([t for t, _ in locators], sorted(t for t, _ in locators))
        self.assertEqual([l.get("Id") for l in self.live_set.iter("Locator")], [str(i) for i in range(len(locators))])
        self.assertEqual(sum(n.startswith("SONG:") for _, n in locators), 3)
        zones = quiet_zones(self.plan)
        self.assertEqual(len(zones), 2)
        for start, end in zones:
            self.assertIn((start, "FX QUIET"), locators)
            self.assertIn((end, "FX ON"), locators)


if __name__ == "__main__":
    unittest.main()
