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
from ableton_set.als import write_mix  # noqa: E402

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
        output = root / "Mix.als"
        write_mix(cls.plan, tx.automation(cls.plan), rendered, output, [1, 5, 9])
        cls.live_set = ET.fromstring(gzip.open(output).read()).find("LiveSet")

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


if __name__ == "__main__":
    unittest.main()
