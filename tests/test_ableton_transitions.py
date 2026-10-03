"""Tests for scripts/ableton_set/transitions.py (pure transition planning)."""
import math
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

from ableton_set import transitions as tx  # noqa: E402

STEMS = ["01 Kick", "02 Snare", "03 Other Drums", "04 Bass", "05 Guitar", "06 Piano", "07 Melodies",
         "08 Lead Vocals", "09 Background Vocals"]


def song(name="S", bpm=100.0, bars=64, first=0.0, level=-10.0, camelot="8A", silent=(), pickup=0):
    bar = 240 / bpm
    downbeats = [first + k * bar for k in range(bars)]
    count = pickup + bars
    levels = {n: [(-90.0 if n in silent else level)] * count for n in STEMS}
    return tx.Song(name=name, native_bpm=bpm, downbeats=downbeats, pickup_bars=pickup,
                   duration=first + bars * bar, bar_levels=levels, camelot=camelot)


class CamelotTest(unittest.TestCase):
    def test_compatible_neighbours_and_relative(self):
        self.assertTrue(tx.camelot_compatible("8A", "8A"))
        self.assertTrue(tx.camelot_compatible("8A", "9A"))
        self.assertTrue(tx.camelot_compatible("12B", "1B"))
        self.assertTrue(tx.camelot_compatible("8A", "8B"))

    def test_clashes_and_unknown(self):
        self.assertFalse(tx.camelot_compatible("8A", "10A"))
        self.assertFalse(tx.camelot_compatible("8A", "9B"))
        self.assertFalse(tx.camelot_compatible(None, "8A"))

    def test_key_names(self):
        self.assertEqual(tx.camelot("Ab major"), "4B")
        self.assertEqual(tx.camelot("F# minor"), "11A")
        self.assertEqual(tx.camelot("anything", "5a"), "5A")


class ScaleTest(unittest.TestCase):
    def test_double_time_song_is_halved_next_to_a_slow_one(self):
        songs = [song(bpm=74), song(bpm=148), song(bpm=105)]
        tx.choose_scales(songs)
        self.assertEqual([s.scale for s in songs[:2]], [1.0, 0.5])
        self.assertAlmostEqual(songs[1].bpm, 74)

    def test_near_ties_keep_the_real_tempo(self):
        songs = [song(bpm=74), song(bpm=105), song(bpm=89)]
        tx.choose_scales(songs)
        self.assertEqual([s.scale for s in songs], [1.0, 1.0, 1.0])


class GridTest(unittest.TestCase):
    def test_markers_ascend_and_cover_the_song(self):
        s = song(bpm=120, first=0.7, pickup=1)
        g = tx.grid(s)
        seconds = [m[0] for m in g.markers]
        beats = [m[1] for m in g.markers]
        self.assertEqual(seconds, sorted(seconds))
        self.assertEqual(beats, sorted(beats))
        self.assertEqual(g.markers[0][0], 0.0)
        self.assertAlmostEqual(g.markers[1][1], 4.0)  # first downbeat = bar 1 after one pickup bar
        self.assertAlmostEqual(g.start_beat, 4 - 0.7 / 2 * 4)
        self.assertAlmostEqual(g.markers[-1][0], s.duration)


class PlanTest(unittest.TestCase):
    def test_overlap_starts_on_a_phrase_and_incoming_downbeat_lands_on_it(self):
        songs = [song("A", 100, 64), song("B", 100, 64)]
        p = tx.plan(songs, 16)
        t = p.transitions[0]
        self.assertEqual(t.bars, 16)
        self.assertEqual((t.start - p.origins[0]) % tx.PHRASE_BEATS, 0)
        self.assertLessEqual(t.end, p.origins[0] + p.grids[0].end_beat)
        self.assertEqual(p.origins[1] + tx.entry_beat(songs[1]), t.start)
        self.assertEqual(p.clip_ends[0], t.end)

    def test_short_songs_shorten_the_overlap(self):
        p = tx.plan([song("A", 100, 12), song("B", 100, 12)], 16)
        self.assertEqual(p.transitions[0].bars, 8)

    def test_incoming_silent_intro_is_skipped(self):
        b = song("B", 100, 64)
        for levels in b.bar_levels.values():
            levels[:4] = [-90.0] * 4
        self.assertEqual(tx.entry_beat(b), 16)


class StyleTest(unittest.TestCase):
    def test_compatible_close_tempos_filter(self):
        p = tx.plan([song("A", 100, camelot="8A"), song("B", 104, camelot="9A")])
        self.assertEqual(p.transitions[0].style, "filter")

    def test_compatible_far_tempos_handover_with_blend(self):
        p = tx.plan([song("A", 90, camelot="8A"), song("B", 120, camelot="8B")])
        t = p.transitions[0]
        self.assertEqual((t.style, t.blend), ("handover", True))

    def test_clash_handover_without_blend(self):
        p = tx.plan([song("A", 100, camelot="8A"), song("B", 100, camelot="2B")])
        t = p.transitions[0]
        self.assertEqual((t.style, t.blend), ("handover", False))

    def test_clash_without_drums_is_a_short_crossfade(self):
        drumless = ("01 Kick", "02 Snare", "03 Other Drums")
        p = tx.plan([song("A", 100, camelot="8A"), song("B", 100, camelot="2B", silent=drumless)], 16)
        t = p.transitions[0]
        self.assertEqual((t.style, t.bars), ("crossfade", 4))

    def test_unreliable_grid_crossfades(self):
        b = song("B", 100)
        b.reliable = False
        self.assertEqual(tx.plan([song("A", 100), b]).transitions[0].style, "crossfade")


class AutomationTest(unittest.TestCase):
    def test_handover_never_plays_both_basses(self):
        p = tx.plan([song("A", 90, camelot="8A"), song("B", 120, camelot="8B")])
        env = tx.automation(p)
        out_initial, out_points = env[("stem", 0, "04 Bass")]
        in_initial, in_points = env[("stem", 1, "04 Bass")]
        self.assertEqual((out_initial, in_initial), (1.0, tx.SILENT))
        cut = next(b for b, v in out_points if v == tx.SILENT)
        enter = next(b for b, v in in_points if v == 1.0)
        self.assertLessEqual(cut, enter)

    def test_tempo_ramps_across_the_overlap(self):
        p = tx.plan([song("A", 90, camelot="8A"), song("B", 120, camelot="8B")])
        initial, points = tx.automation(p)["tempo"]
        t = p.transitions[0]
        self.assertEqual(initial, 90)
        self.assertEqual(points, [(t.start, 90), (t.end, 120)])

    def test_filter_swaps_lows_at_the_midpoint(self):
        p = tx.plan([song("A", 100), song("B", 102)])
        env = tx.automation(p)
        t = p.transitions[0]
        middle = t.start + 2 * t.bars
        self.assertEqual(env[("eq", 1)][0], tx.SILENT)
        self.assertEqual(env[("eq", 1)][1][-1], (middle, 1.0))
        self.assertEqual(env[("eq", 0)][1][-1], (middle, tx.SILENT))

    def test_fades_are_equal_power(self):
        points = tx.fade(0, 16, True)
        self.assertAlmostEqual(points[4][1], math.sqrt(0.5))
        self.assertEqual(points[0][1], tx.SILENT)



class ShortCrossfadeTest(unittest.TestCase):
    def test_two_bar_crossfades_everywhere(self):
        songs = [song("A", 100, 64, camelot="8A"), song("B", 128, 64, camelot="3B"), song("C", 126, 64, camelot="3B")]
        p = tx.plan(songs, 2, "crossfade")
        self.assertEqual([(t.style, t.bars) for t in p.transitions], [("crossfade", 2), ("crossfade", 2)])
        envelopes = tx.automation(p)
        stems = [k for k in envelopes if k != "tempo" and k[0] == "stem"]
        self.assertEqual({tx.stem_role(k[2]) for k in stems}, {tx.VOCALS})
        for t in p.transitions:
            for name in ("08 Lead Vocals", "09 Background Vocals"):
                initial, points = envelopes[("stem", t.incoming, name)]
                self.assertEqual(initial, tx.SILENT)  # silent through the whole crossfade
                self.assertEqual(points, tx.step(t.start + 8, True))
        for t in p.transitions:
            out_initial, out_points = envelopes[("group", t.outgoing)]
            self.assertEqual(out_points[-1], (t.start + 8, tx.SILENT))
            self.assertEqual(envelopes[("group", t.incoming)][1][0], (t.start, tx.SILENT))
            self.assertEqual(p.clip_ends[t.outgoing], t.start + 8)



class NaturalSpeedTest(unittest.TestCase):
    def setUp(self):
        self.songs = [song("A", 100, 64, camelot="8A"), song("B", 140, 64, camelot="8A"), song("C", 75, 64, camelot="8A")]
        self.plan = tx.plan(self.songs, 2, "crossfade")
        self.r = tx.natural_speed(self.plan, tx.automation(self.plan))

    def test_tempo_steps_at_each_overlap_end_and_never_ramps(self):
        initial, points = self.r.envelopes["tempo"]
        self.assertEqual(initial, self.songs[0].bpm)
        a, b, c = (s.bpm for s in self.songs)  # grid tempos (C may be counted in double time); audio is untouched
        self.assertEqual([v for _, v in points], [a, b, b, c])
        for (b0, _), (b1, _) in zip(points[::2], points[1::2]):
            self.assertAlmostEqual(b1 - b0, tx.STEP)
        self.assertEqual([round(b, 6) for b, _ in points[1::2]], [round(z[1], 6) for z in self.r.zones])

    def test_overlap_lasts_the_outgoing_songs_own_two_bars(self):
        # During an overlap Live runs at the outgoing tempo, so its two bars span 8 Arrangement beats.
        for start, end in self.r.zones:
            self.assertAlmostEqual(end - start, 8, places=6)

    def test_audio_lengths_survive_the_tempo_map(self):
        # Each clip's beats, read through the tempo in force, must equal its audio seconds.
        changes = [(0.0, self.songs[0].bpm)] + [(b, v) for b, v in self.r.envelopes["tempo"][1][1::2]]
        def seconds(b0, b1):
            total = 0.0
            for (c0, bpm), (c1, _) in zip(changes, changes[1:] + [(float("inf"), 0)]):
                lo, hi = max(b0, c0), min(b1, c1)
                if hi > lo:
                    total += (hi - lo) * 60 / bpm
            return total
        for start, end, length in zip(self.r.clip_starts, self.r.clip_ends, self.r.end_seconds):
            self.assertAlmostEqual(seconds(start, end), length, places=6)

    def test_crossfade_automation_follows_the_overlaps(self):
        for (start, end), t in zip(self.r.zones, self.plan.transitions):
            initial, points = self.r.envelopes[("group", t.outgoing)]
            self.assertAlmostEqual(points[-1][0], end)
            self.assertEqual(points[-1][1], tx.SILENT)
            self.assertAlmostEqual(self.r.envelopes[("group", t.incoming)][1][0][0], start)


if __name__ == "__main__":
    unittest.main()
