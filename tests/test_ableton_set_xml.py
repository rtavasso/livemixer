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
from dataclasses import replace
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

from ableton_set import transitions as tx  # noqa: E402
from ableton_set.merge import merge_levels, merge_song  # noqa: E402
from ableton_set.als import LIVE11_TEMPLATES, TEMPLATES, Gestures, Living, quiet_zones, write_mix  # noqa: E402

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
    templates = TEMPLATES
    main_track = "MainTrack"
    texture_filter = "AutoFilter2"
    patch_ref = "MxPatchRef"
    merge = False
    natural = False
    style = None

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
            if cls.merge:
                stems = merge_song(stems, folder / "merged")
            rendered.append((stems, frames, rate))
        if cls.merge:
            songs = [replace(s, bar_levels=merge_levels(s.bar_levels)) for s in songs]
        cls.plan = tx.plan(songs, 16, cls.style)
        cls.output = root / "Mix.als"
        envelopes = tx.automation(cls.plan)
        cls.retimed = tx.natural_speed(cls.plan, envelopes) if cls.natural else None
        write_mix(cls.plan, envelopes, rendered, cls.output, [1, 5, 9], living=cls.living(),
                  templates=cls.templates, retimed=cls.retimed, gestures=cls.gestures())
        cls.live_set = ET.fromstring(gzip.open(cls.output).read()).find("LiveSet")

    @staticmethod
    def living():
        return None

    @staticmethod
    def gestures():
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
        self.assertEqual(len(clips), 3 * (5 if self.merge else len(STEMS)))
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

    def test_nested_tracks_play_through_their_parent(self):
        # A nested group saved as "AudioOut/Master" would bypass its song group's volume, EQ and crossfades.
        for t in self.live_set.find("Tracks"):
            if t.find("TrackGroupId").get("Value") != "-1":
                self.assertEqual(t.find("DeviceChain/AudioOutputRouting/Target").get("Value"), "AudioOut/GroupTrack", name(t))

    def test_group_devices_and_one_vocal_mapping(self):
        tracks = list(self.live_set.find("Tracks"))
        texture = [t for t in tracks if name(t) == "TEXTURE FX"]
        vocals = [t for t in tracks if name(t) == "VOCALS"]
        self.assertEqual(len(texture), 3)
        for t in texture:
            self.assertIsNotNone(t.find("DeviceChain/DeviceChain/Devices/" + self.texture_filter))
        mapped = [bool(list(t.iter("KeyMidi"))) for t in vocals]
        self.assertEqual(mapped, [True, False, False])
        cc = [k.find("NoteOrController").get("Value") for k in vocals[0].iter("KeyMidi")]
        self.assertEqual(cc, ["20"])
        for t in [t for t in tracks if name(t) == "DRUM FX"]:
            self.assertEqual(list(t.find("DeviceChain/DeviceChain/Devices")), [])

    def test_returns_and_main_chain(self):
        returns = [name(t) for t in self.live_set.findall("Tracks/ReturnTrack")]
        self.assertEqual(returns, ["A-DUB THROW", "B-HALO BLOOM"])
        main = list(self.live_set.find(self.main_track + "/DeviceChain/DeviceChain/Devices"))
        self.assertEqual([d.tag for d in main], ["Reverb", "StereoGain", "Limiter", "MxDeviceAudioEffect"])
        self.assertEqual(len({d.get("Id") for d in main}), len(main))
        ref = main[-1].find(f"PatchSlot/Value/{self.patch_ref}/FileRef")
        path = Path(ref.find("Path").get("Value"))
        self.assertEqual(path.name, "LiveMixer Living FX.amxd")
        self.assertTrue(path.exists())
        self.assertTrue((path.parent / "living-fx.js").exists())
        self.assertEqual((self.output.parent / ref.find("RelativePath").get("Value")).resolve(), path.resolve())
        ccs = sorted(k.find("NoteOrController").get("Value") for k in self.live_set.find(self.main_track).iter("KeyMidi"))
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


class Live11LivingMixXmlTest(LivingMixXmlTest):
    """A living set from the Live 11 templates (scripts/make-live11-templates.py)."""
    templates = LIVE11_TEMPLATES
    main_track = "MasterTrack"
    texture_filter = "AutoFilter"
    patch_ref = "MxDPatchRef"

    @staticmethod
    def living():
        return Living(LIVE11_TEMPLATES)

    def test_written_as_live11(self):
        root = ET.fromstring(gzip.open(self.output).read())
        self.assertTrue(root.get("MinorVersion").startswith("11."))
        for tag in ("MainTrack", "AutoFilter2", "MxPatchRef", "SourceHint", "IsStored"):
            self.assertIsNone(next(root.iter(tag), None), tag)


class MergedLivingMixXmlTest(Live11LivingMixXmlTest):
    """ableton-stem-set.py --merge: Kick, Drums, Bass, Melodic and Vocals per song."""
    merge = True

    def test_tracks_unique_grouped_and_before_returns(self):
        tracks = list(self.live_set.find("Tracks"))
        self.assertEqual(len({t.get("Id") for t in tracks}), len(tracks))
        self.assertEqual([t.tag for t in tracks][-2:], ["ReturnTrack", "ReturnTrack"])
        children = lambda parent: [name(t) for t in tracks if t.find("TrackGroupId").get("Value") == parent.get("Id")]  # noqa: E731
        songs = [t for t in tracks if t.tag == "GroupTrack" and t.find("TrackGroupId").get("Value") == "-1"]
        self.assertEqual(len(songs), 3)
        for song_group in songs:
            self.assertEqual(children(song_group), ["DRUM FX", "04 Bass", "TEXTURE FX", "VOCALS"])
        for group in [t for t in tracks if name(t) == "DRUM FX"]:
            self.assertEqual(children(group), ["01 Kick", "02 Drums"])
        for group in [t for t in tracks if name(t) == "TEXTURE FX"]:
            self.assertEqual(group.tag, "GroupTrack")  # Living FX moves its volume; the melodic track is automated
            self.assertEqual(children(group), ["05 Melodic"])
        self.assertEqual({t.tag for t in tracks if name(t) == "VOCALS"}, {"AudioTrack"})

    def test_merged_files_sum_their_parts(self):
        folder = self.output.parent / "A" / "merged"
        self.assertEqual(sorted(p.name for p in folder.glob("*.wav")), ["02 Drums.wav", "05 Melodic.wav", "08 Vocals.wav"])
        manifest = (folder / "_merge.json").read_text(encoding="utf-8")
        self.assertIn("02 Snare.wav", manifest)
        self.assertNotIn("01 Kick.wav", manifest)

    def test_envelopes_follow_merged_tracks(self):
        names = {name(t) for t in self.live_set.find("Tracks") if list(t.iter("AutomationEnvelope"))}
        self.assertFalse(names & {"02 Snare", "05 Guitar", "08 Lead Vocals"})


class NaturalSpeedMixXmlTest(MergedLivingMixXmlTest):
    """ableton-stem-set.py --natural-speed: unwarped clips, loop points in seconds."""
    natural = True

    def test_clips_warped_with_ascending_markers(self):
        for clip in self.live_set.iter("AudioClip"):
            self.assertEqual(clip.find("IsWarped").get("Value"), "false")
            loop = clip.find("Loop")
            self.assertEqual(float(loop.find("LoopStart").get("Value")), 0.0)
            self.assertIn(round(float(loop.find("LoopEnd").get("Value")), 6), [round(s, 6) for s in self.retimed.end_seconds])

    def test_tempo_and_locators(self):
        locators = [float(l.find("Time").get("Value")) for l in self.live_set.iter("Locator")]
        self.assertEqual(locators, sorted(locators))
        for start, end in self.retimed.zones:
            self.assertIn(round(start, 6), [round(t, 6) for t in locators])
            self.assertIn(round(end, 6), [round(t, 6) for t in locators])


class GesturesMixXmlTest(NaturalSpeedMixXmlTest):
    """--gestures --merge --natural-speed --style crossfade --live 11: every song split into RHYTHM and MELODIC."""
    style = "crossfade"
    rhythm = {"DRUM FX": ["01 Kick", "02 Drums"]}  # groups inside a song's rhythm subgroup, and their tracks
    melodic = {"TEXTURE FX": ["05 Melodic"]}

    @staticmethod
    def gestures():
        return Gestures()

    def tracks(self):
        return list(self.live_set.find("Tracks"))

    def children(self, parent):
        return [t for t in self.tracks() if t.find("TrackGroupId").get("Value") == parent.get("Id")]

    def halves(self):
        tops = [t for t in self.tracks() if t.tag != "ReturnTrack" and t.find("TrackGroupId").get("Value") == "-1"]
        self.assertEqual([(t.tag, name(t)) for t in tops], [("GroupTrack", "RHYTHM"), ("GroupTrack", "MELODIC")])
        return tops

    def song_groups(self, index):
        return [self.children(top)[index] for top in self.halves()]

    @staticmethod
    def envelope_targets(track):
        return [e.find("EnvelopeTarget/PointeeId").get("Value") for e in track.find("AutomationEnvelopes/Envelopes")]

    def test_tracks_unique_grouped_and_before_returns(self):
        tracks = self.tracks()
        self.assertEqual(len({t.get("Id") for t in tracks}), len(tracks))
        self.assertEqual([t.tag for t in tracks][-2:], ["ReturnTrack", "ReturnTrack"])
        rhythm, melodic = self.halves()
        for top, inner, last in ((rhythm, self.rhythm, "04 Bass"), (melodic, self.melodic, "VOCALS")):
            songs = self.children(top)
            self.assertEqual([(t.tag, name(t)) for t in songs], [("GroupTrack", n) for n in "ABC"])
            for song_group in songs:
                kids = self.children(song_group)
                self.assertEqual([name(t) for t in kids], list(inner) + [last])
                for kid in kids:
                    if name(kid) in inner:
                        self.assertEqual([name(t) for t in self.children(kid)], inner[name(kid)])
        # A parent always comes before its children, and all of RHYTHM before MELODIC.
        position = {t.get("Id"): i for i, t in enumerate(tracks)}
        top_of = {}
        for t in tracks:
            parent = t.find("TrackGroupId").get("Value")
            if parent != "-1":
                self.assertLess(position[parent], position[t.get("Id")])
                top_of[t.get("Id")] = top_of.get(parent, parent)
        self.assertEqual(len(top_of), len(tracks) - 4)
        in_rhythm = [position[i] for i, top in top_of.items() if top == rhythm.get("Id")]
        self.assertLess(max(in_rhythm), position[melodic.get("Id")])
        # Nested groups play out through their parent, like the stems.
        for t in tracks:
            if t.tag == "GroupTrack" and t not in (rhythm, melodic):
                self.assertEqual(t.find("DeviceChain/AudioOutputRouting/Target").get("Value"), "AudioOut/GroupTrack")

    def test_group_devices_and_one_vocal_mapping(self):
        tracks = self.tracks()
        texture = [t for t in tracks if name(t) == "TEXTURE FX"]
        self.assertEqual(len(texture), 3)
        for t in texture:
            self.assertEqual([d.tag for d in t.find("DeviceChain/DeviceChain/Devices")], ["AutoFilter"])
        vocals = [t for t in tracks if name(t) == "VOCALS"]
        self.assertEqual([bool(list(t.iter("KeyMidi"))) for t in vocals], [True, False, False])
        for t in [t for t in tracks if name(t) == "DRUM FX"]:
            self.assertEqual(list(t.find("DeviceChain/DeviceChain/Devices")), [])
        for top in self.halves():
            chain = list(top.find("DeviceChain/DeviceChain/Devices"))
            self.assertEqual([(d.tag, d.find("UserName").get("Value")) for d in chain],
                             [("AutoFilter", "Muffle"), ("Eq8", "Tilt"), ("StereoGain", "Level")])
            self.assertEqual([d.get("Id") for d in chain], ["0", "1", "2"])
            self.assertIsNone(next(top.iter("KeyMidi"), None))
            for song_group in self.children(top):
                self.assertEqual([d.tag for d in song_group.find("DeviceChain/DeviceChain/Devices")], ["FilterEQ3"])

    def test_gesture_devices_at_rest(self):
        manual = lambda device, path: device.find(path + "/Manual").get("Value")  # noqa: E731
        for top in self.halves():
            muffle, tilt, level = top.find("DeviceChain/DeviceChain/Devices")
            self.assertEqual([manual(muffle, p) for p in ("FilterType", "Cutoff", "Resonance")], ["0", "135", "0.1"])
            self.assertEqual([(manual(tilt, f"Bands.{i}/ParameterA/IsOn"), manual(tilt, f"Bands.{i}/ParameterA/Mode"))
                              for i in (0, 3)], [("true", "2"), ("true", "5")])
            self.assertEqual([manual(tilt, f"Bands.{i}/ParameterA/IsOn") for i in (1, 2, 4, 5, 6, 7)], ["false"] * 6)
            self.assertEqual({manual(tilt, f"Bands.{i}/ParameterA/Gain") for i in range(8)}, {"0"})
            self.assertEqual([manual(level, "Gain"), manual(level, "StereoWidth")], ["1", "1"])
        main = {d.find("UserName").get("Value"): d for d in self.live_set.find(self.main_track + "/DeviceChain/DeviceChain/Devices")}
        self.assertEqual([manual(main["Freeze"], p) for p in ("DryWet", "Freezer_FreezeOn")], ["0", "false"])
        self.assertEqual(manual(main["Whoosh"], "Cutoff"), "135")
        self.assertEqual(manual(main["Span"], "StereoWidth"), "1")

    def test_returns_and_main_chain(self):
        returns = [name(t) for t in self.live_set.findall("Tracks/ReturnTrack")]
        self.assertEqual(returns, ["A-DUB THROW", "B-HALO BLOOM"])
        main = list(self.live_set.find(self.main_track + "/DeviceChain/DeviceChain/Devices"))
        self.assertEqual([d.tag for d in main], ["Reverb", "StereoGain", "AutoFilter", "Spectral", "StereoGain", "Limiter",
                                                 "MxDeviceAudioEffect"])
        self.assertEqual([d.find("UserName").get("Value") for d in main[2:5]], ["Whoosh", "Freeze", "Span"])
        self.assertEqual([d.get("Id") for d in main], [str(i) for i in range(len(main))])
        path = Path(main[-1].find(f"PatchSlot/Value/{self.patch_ref}/FileRef/Path").get("Value"))
        self.assertEqual(path.name, "LiveMixer Living FX.amxd")
        ccs = sorted(k.find("NoteOrController").get("Value") for k in self.live_set.find(self.main_track).iter("KeyMidi"))
        self.assertEqual(ccs, ["21", "23"])

    def test_crossfades_move_both_subgroups(self):
        targets = {e.get("Id") for e in self.live_set.iter("AutomationTarget")}
        for index in range(3):
            fades = []
            for group in self.song_groups(index):
                volume = group.find("DeviceChain/Mixer/Volume/AutomationTarget").get("Id")
                self.assertIn(volume, targets)
                envelope = next(e for e in group.iter("AutomationEnvelope")
                                if e.find("EnvelopeTarget/PointeeId").get("Value") == volume)
                fades.append([(e.get("Time"), e.get("Value")) for e in envelope.iter("FloatEvent")])
            self.assertEqual(fades[0], fades[1])
        for top in self.halves():
            self.assertEqual(list(top.find("AutomationEnvelopes/Envelopes")), [])


class GesturesUnmergedMixXmlTest(GesturesMixXmlTest):
    """--gestures with every stem apart, warped, and transitions chosen per pair (an EQ low swap among them)."""
    merge = False
    natural = False
    style = None
    rhythm = {"DRUM FX": ["01 Kick", "02 Snare", "03 Other Drums"]}
    melodic = {"TEXTURE FX": ["05 Guitar", "06 Piano", "07 Melodies"]}
    test_clips_warped_with_ascending_markers = MixXmlTest.test_clips_warped_with_ascending_markers
    test_tempo_and_locators = LivingMixXmlTest.test_tempo_and_locators
    test_merged_files_sum_their_parts = None
    test_envelopes_follow_merged_tracks = None

    def test_tracks_unique_grouped_and_before_returns(self):
        super().test_tracks_unique_grouped_and_before_returns()
        for song_group in self.children(self.halves()[1]):
            vocals = self.children(song_group)[-1]
            self.assertEqual((vocals.tag, [name(t) for t in self.children(vocals)]),
                             ("GroupTrack", ["08 Lead Vocals", "09 Background Vocals"]))

    def test_crossfades_move_both_subgroups(self):
        self.assertIn("filter", [t.style for t in self.plan.transitions])
        for t in self.plan.transitions:
            for index in (t.outgoing, t.incoming):
                groups = self.song_groups(index)
                lows = [g.find("DeviceChain/DeviceChain/Devices/FilterEQ3/GainLo/AutomationTarget").get("Id") in
                        self.envelope_targets(g) for g in groups]
                volumes = [g.find("DeviceChain/Mixer/Volume/AutomationTarget").get("Id") in self.envelope_targets(g)
                           for g in groups]
                self.assertEqual(lows, [t.style == "filter"] * 2 if t.style == "filter" else [lows[0]] * 2)
                self.assertEqual(volumes[0], volumes[1])


if __name__ == "__main__":
    unittest.main()
