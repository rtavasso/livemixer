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


if __name__ == "__main__":
    unittest.main()
