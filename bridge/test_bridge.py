#!/usr/bin/env python3
"""Tests for ``depth_bridge.py``.

Plain ``unittest``, no pytest. Run either of::

    python bridge/test_bridge.py
    python -m bridge.test_bridge

The protocol-shape checks mirror ``src/sim/input/protocol.ts`` by hand (strict
key sets, finite numbers, unit ranges). The TypeScript side runs the same
fixture through the real zod schema in ``tests/sim/bridge-fixture.test.ts``.
"""
from __future__ import annotations

import base64
import json
import math
import os
import subprocess
import sys
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

import numpy as np  # noqa: E402

import depth_bridge as db  # noqa: E402

NEAR, FAR = 0.4, 1.2
NEAR_MM, FAR_MM = NEAR * 1000.0, FAR * 1000.0
FIXTURE = os.path.join(HERE, "fixtures", "sample_messages.jsonl")


def frame_from(depth: np.ndarray, t: float = 0.0) -> db.DepthFrame:
    return db.DepthFrame(np.ascontiguousarray(depth, dtype=np.uint16), t)


def backdrop(width: int = 640, height: int = 480) -> np.ndarray:
    """A scene with nothing inside the box: a wall 30 cm behind the far plane."""
    return np.full((height, width), FAR_MM + 300, dtype=np.uint16)


def depth_at(w: float) -> int:
    """Millimetres for a normalized depth ``w`` into the [NEAR, FAR] box."""
    return int(round(NEAR_MM + w * (FAR_MM - NEAR_MM)))


def make_analyzer(**overrides: object) -> db.BoxAnalyzer:
    cfg: dict[str, object] = {"occupancy": (8, 6), "min_pixels": 50, "max_hands": 2}
    cfg.update(overrides)
    return db.BoxAnalyzer(db.BoxConfig(near_m=NEAR, far_m=FAR), db.AnalyzerConfig(**cfg))  # type: ignore[arg-type]


def synthetic(**kw: object) -> db.SyntheticSource:
    return db.SyntheticSource(near_m=NEAR, far_m=FAR, paced=False, **kw)  # type: ignore[arg-type]


# ---- protocol shape checks (hand-written mirror of protocol.ts) ------------ #

HELLO_REQUIRED, HELLO_OPTIONAL = {"type", "version", "source", "box"}, {"fps", "occupancy"}
FRAME_REQUIRED, FRAME_OPTIONAL = {"type", "seq", "t", "hands"}, {"occupancy", "stats"}
HAND_REQUIRED, HAND_OPTIONAL = {"id", "pos"}, {"conf", "extent", "openness", "pinch", "points"}


class ProtocolAssertions(unittest.TestCase):
    def assert_number(self, x: object, lo: float | None = None, hi: float | None = None) -> None:
        self.assertIsInstance(x, (int, float))
        self.assertNotIsInstance(x, bool)
        assert isinstance(x, (int, float))
        self.assertTrue(math.isfinite(x), f"{x!r} is not finite")
        if lo is not None:
            self.assertGreaterEqual(x, lo)
        if hi is not None:
            self.assertLessEqual(x, hi)

    def assert_vec(self, v: object) -> None:
        self.assertIsInstance(v, list)
        assert isinstance(v, list)
        self.assertEqual(len(v), 3)
        for x in v:
            self.assert_number(x, 0.0, 1.0)

    def assert_hello(self, m: dict[str, object]) -> None:
        keys = set(m)
        self.assertTrue(HELLO_REQUIRED <= keys <= HELLO_REQUIRED | HELLO_OPTIONAL, keys)
        self.assertEqual(m["type"], "hello")
        self.assertEqual(m["version"], db.PROTOCOL_VERSION)
        self.assertIsInstance(m["source"], str)
        self.assertTrue(m["source"])
        box = m["box"]
        assert isinstance(box, dict)
        self.assertEqual(set(box), {"x", "y", "z"})
        for axis in ("x", "y", "z"):
            pair = box[axis]
            self.assertIsInstance(pair, list)
            self.assertEqual(len(pair), 2)
            for x in pair:
                self.assert_number(x)
        if "fps" in m:
            self.assert_number(m["fps"])
            self.assertGreater(m["fps"], 0)  # type: ignore[operator]
        if "occupancy" in m:
            occ = m["occupancy"]
            assert isinstance(occ, dict)
            self.assertEqual(set(occ), {"width", "height"})
            for side in occ.values():
                self.assertIsInstance(side, int)
                self.assertTrue(1 <= side <= 256)

    def assert_hand(self, h: dict[str, object]) -> None:
        keys = set(h)
        self.assertTrue(HAND_REQUIRED <= keys <= HAND_REQUIRED | HAND_OPTIONAL, keys)
        self.assertIsInstance(h["id"], int)
        self.assertGreaterEqual(h["id"], 0)  # type: ignore[arg-type]
        self.assert_vec(h["pos"])
        if "conf" in h:
            self.assert_number(h["conf"], 0.0, 1.0)
        if "extent" in h:
            ext = h["extent"]
            assert isinstance(ext, list)
            self.assertEqual(len(ext), 2)
            self.assert_vec(ext[0])
            self.assert_vec(ext[1])
            for lo, hi in zip(ext[0], ext[1]):
                self.assertLessEqual(lo, hi)
        if "points" in h:
            pts = h["points"]
            assert isinstance(pts, list)
            self.assertLessEqual(len(pts), 256)
            for p in pts:
                self.assert_vec(p)

    def assert_frame(self, m: dict[str, object], occupancy: tuple[int, int] | None) -> None:
        keys = set(m)
        self.assertTrue(FRAME_REQUIRED <= keys <= FRAME_REQUIRED | FRAME_OPTIONAL, keys)
        self.assertEqual(m["type"], "frame")
        self.assertIsInstance(m["seq"], int)
        self.assertGreaterEqual(m["seq"], 0)  # type: ignore[arg-type]
        self.assert_number(m["t"])
        hands = m["hands"]
        assert isinstance(hands, list)
        self.assertLessEqual(len(hands), 16)
        for h in hands:
            self.assert_hand(h)
        if occupancy is None:
            self.assertNotIn("occupancy", m)
        else:
            self.assertIn("occupancy", m)
            raw = base64.b64decode(m["occupancy"], validate=True)  # type: ignore[arg-type]
            self.assertEqual(len(raw), occupancy[0] * occupancy[1])
        if "stats" in m:
            stats = m["stats"]
            assert isinstance(stats, dict)
            for k, v in stats.items():
                self.assertIsInstance(k, str)
                self.assert_number(v)


# ---- synthetic source ------------------------------------------------------ #


class SyntheticSourceTests(unittest.TestCase):
    def test_read_produces_uint16_frames_with_the_hand_in_the_box(self) -> None:
        src = synthetic()
        src.start()
        a, b = src.read(), src.read()
        self.assertEqual(a.depth_mm.dtype, np.uint16)
        self.assertEqual(a.depth_mm.shape, (480, 640))
        self.assertEqual((a.width, a.height), (640, 480))
        self.assertGreaterEqual(b.timestamp, a.timestamp)
        inside = (a.depth_mm >= NEAR_MM) & (a.depth_mm <= FAR_MM)
        self.assertGreater(int(inside.sum()), 100, "the script starts with a hand present")
        self.assertTrue((a.depth_mm[~inside] > FAR_MM).all(), "everything else is the backdrop")

    def test_render_is_a_pure_function_of_time(self) -> None:
        src = synthetic()
        self.assertTrue(np.array_equal(src.render(3.3), src.render(3.3)))
        self.assertFalse(np.array_equal(src.render(3.3), src.render(4.0)))

    def test_absence_window_empties_the_box(self) -> None:
        src = synthetic()
        self.assertEqual(src.scripted_hands(12.0), [])
        depth = src.render(12.0)
        self.assertEqual(int(((depth >= NEAR_MM) & (depth <= FAR_MM)).sum()), 0)
        self.assertEqual(len(synthetic(absences=False).scripted_hands(12.0)), 1)
        self.assertEqual(len(synthetic(hands=2).scripted_hands(2.0)), 2)

    def test_scripted_hand_stays_inside_the_image_and_box(self) -> None:
        src = synthetic()
        for i in range(0, 1400):
            for h in src.scripted_hands(i / 100.0):
                self.assertTrue(0 < h.x - h.r and h.x + h.r < 1)
                self.assertTrue(0 < h.y - h.r * 1.4 and h.y + h.r * 1.4 < 1)
                self.assertTrue(0 <= h.z <= 1)

    def test_paced_read_respects_fps(self) -> None:
        src = db.SyntheticSource(width=64, height=48, fps=40, near_m=NEAR, far_m=FAR, paced=True)
        src.start()
        t0 = time.perf_counter()
        for _ in range(5):
            src.read()
        self.assertGreaterEqual(time.perf_counter() - t0, 4 / 40 - 0.02)


# ---- analyzer -------------------------------------------------------------- #


class AnalyzerTests(unittest.TestCase):
    def test_finds_the_blob_where_the_script_put_it(self) -> None:
        src, analyzer = synthetic(), make_analyzer()
        t = 2.0
        hand = src.scripted_hands(t)[0]
        result = analyzer.analyze(frame_from(src.render(t), t))
        self.assertEqual(len(result.blobs), 1)
        b = result.blobs[0]
        self.assertAlmostEqual(b.u, hand.x, delta=0.01)
        self.assertAlmostEqual(b.v, hand.y, delta=0.01)
        self.assertAlmostEqual(b.w, hand.z, delta=0.03)
        (min_u, min_v, min_w), (max_u, max_v, max_w) = b.extent
        self.assertTrue(min_u <= b.u <= max_u and min_v <= b.v <= max_v and min_w <= b.w <= max_w)
        self.assertAlmostEqual(max_u - min_u, 2 * hand.r, delta=0.01)
        self.assertAlmostEqual(max_v - min_v, 2 * hand.r * 1.4, delta=0.01)
        self.assertEqual(b.conf, 1.0)
        self.assertTrue(1 <= len(b.points) <= 16)
        for p in b.points:
            self.assertTrue(all(0.0 <= c <= 1.0 for c in p))
        self.assertEqual(result.stats["blobs"], 1.0)
        self.assertEqual(result.stats["pixels"], float(b.pixels))
        self.assertEqual(result.stats["frameWidth"], 640.0)

    def test_blob_depth_is_the_nearest_tenth_so_a_reaching_hand_reads_as_pushed(self) -> None:
        depth = backdrop()
        depth[200:280, 100:400] = depth_at(0.8)  # forearm, deep in the box
        depth[200:280, 100:160] = depth_at(0.2)  # hand at the end of it, nearer the camera (20% of the pixels)
        b = make_analyzer().analyze(frame_from(depth)).blobs[0]
        self.assertAlmostEqual(b.w, 0.2, delta=0.02)
        self.assertAlmostEqual(b.extent[0][2], 0.2, delta=0.02)
        self.assertAlmostEqual(b.extent[1][2], 0.8, delta=0.02)

    def test_occupancy_row_zero_is_the_top_of_the_image(self) -> None:
        depth = backdrop()
        depth[0:80, :] = depth_at(0.5)  # a band across the top 80 rows = exactly one 8x6 cell row
        result = make_analyzer().analyze(frame_from(depth))
        grid = result.occupancy
        assert grid is not None
        self.assertEqual(grid.shape, (6, 8))
        self.assertEqual(grid.dtype, np.uint8)
        self.assertTrue((grid[0] == 255).all(), grid)
        self.assertTrue((grid[1:] == 0).all(), grid)
        raw = base64.b64decode(db.encode_occupancy(grid))
        self.assertEqual(len(raw), 48)
        self.assertEqual(list(raw[:8]), [255] * 8)
        self.assertEqual(list(raw[8:]), [0] * 40)

    def test_downsample_occupancy_fractions(self) -> None:
        mask = np.zeros((4, 4), dtype=bool)
        mask[0, 0] = True
        self.assertEqual(db.downsample_occupancy(mask, 2, 2).tolist(), [[64, 0], [0, 0]])
        mask[:] = True
        self.assertEqual(db.downsample_occupancy(mask, 3, 2).max(), 255)
        self.assertEqual(db.downsample_occupancy(mask, 8, 8).shape, (8, 8))  # grid finer than the mask still works

    def test_normalization_stays_within_the_unit_cube(self) -> None:
        analyzer = make_analyzer()
        depth = backdrop()
        depth[0:40, 0:40] = depth_at(0.0)  # top-left corner, nearest plane
        b = analyzer.analyze(frame_from(depth)).blobs[0]
        self.assertAlmostEqual(b.u, 20 / 640, delta=0.005)
        self.assertAlmostEqual(b.v, 20 / 480, delta=0.005)
        self.assertEqual(b.w, 0.0)
        self.assertGreaterEqual(min(b.extent[0]), 0.0)
        depth = backdrop()
        depth[440:480, 600:640] = depth_at(1.0)  # bottom-right corner, farthest plane
        b = db.BoxAnalyzer(analyzer.box, analyzer.config).analyze(frame_from(depth)).blobs[0]
        self.assertEqual(b.w, 1.0)
        self.assertLessEqual(max(b.extent[1]), 1.0)
        self.assertGreater(b.u, 0.9)
        self.assertGreater(b.v, 0.9)
        msg = db.frame_message(0, 1.0, db.AnalysisResult((b,), None, {}))
        for vec in [msg["hands"][0]["pos"], *msg["hands"][0]["extent"], *msg["hands"][0]["points"]]:
            self.assertTrue(all(0.0 <= c <= 1.0 for c in vec))

    def test_pixels_outside_the_depth_range_or_invalid_are_not_in_the_box(self) -> None:
        depth = backdrop()
        depth[100:200, 100:200] = 0  # "no measurement"
        depth[300:400, 100:200] = int(NEAR_MM) - 5  # just in front of the box
        depth[300:400, 300:400] = int(FAR_MM) + 5  # just behind it
        result = make_analyzer().analyze(frame_from(depth))
        self.assertEqual(result.blobs, ())
        self.assertEqual(result.stats["pixels"], 0.0)

    def test_roi_normalizes_to_the_roi_not_the_frame(self) -> None:
        analyzer = db.BoxAnalyzer(db.BoxConfig(near_m=NEAR, far_m=FAR, roi=(0.25, 0.25, 0.75, 0.75)), db.AnalyzerConfig(occupancy=(8, 6), min_pixels=50))
        depth = backdrop()
        depth[220:260, 300:340] = depth_at(0.5)  # image centre
        depth[0:40, 0:40] = depth_at(0.5)  # outside the ROI: ignored
        result = analyzer.analyze(frame_from(depth))
        self.assertEqual(len(result.blobs), 1)
        self.assertAlmostEqual(result.blobs[0].u, 0.5, delta=0.01)
        self.assertAlmostEqual(result.blobs[0].v, 0.5, delta=0.01)
        self.assertEqual(result.stats["pixels"], 1600.0)
        grid = result.occupancy
        assert grid is not None
        self.assertGreater(int(grid[2:4, 3:5].sum()), 0)
        self.assertEqual(int(grid[0].sum()), 0)

    def test_empty_frame_has_no_hands(self) -> None:
        analyzer = make_analyzer()
        for depth in (np.zeros((480, 640), dtype=np.uint16), backdrop()):
            result = analyzer.analyze(frame_from(depth))
            self.assertEqual(result.blobs, ())
            self.assertEqual(result.stats["pixels"], 0.0)
            self.assertEqual(result.stats["blobs"], 0.0)
            assert result.occupancy is not None
            self.assertEqual(int(result.occupancy.sum()), 0)
            self.assertEqual(db.frame_message(0, 0.0, result)["hands"], [])

    def test_speckle_is_removed_by_opening(self) -> None:
        depth = backdrop()
        rng = np.random.default_rng(1)
        ys, xs = rng.integers(0, 480, 300), rng.integers(0, 640, 300)
        depth[ys, xs] = depth_at(0.5)
        result = make_analyzer(min_pixels=10).analyze(frame_from(depth))
        self.assertEqual(result.blobs, ())
        self.assertLess(result.stats["pixels"], 10)

    def test_blob_ids_are_stable_across_consecutive_frames(self) -> None:
        src, analyzer = synthetic(), make_analyzer()
        ids = [analyzer.analyze(frame_from(src.render(t), t)).blobs[0].id for t in (1.0, 1.0 + 1 / 30, 1.0 + 2 / 30, 1.5)]
        self.assertEqual(ids, [ids[0]] * 4)
        # A one-frame dropout keeps the id...
        self.assertEqual(analyzer.analyze(frame_from(src.render(12.0), 12.0)).blobs, ())
        self.assertEqual(analyzer.analyze(frame_from(src.render(1.6), 1.6)).blobs[0].id, ids[0])
        # ...but a long absence starts a new track.
        for _ in range(analyzer.config.max_missed + 3):
            analyzer.analyze(frame_from(src.render(12.0), 12.0))
        self.assertNotEqual(analyzer.analyze(frame_from(src.render(1.7), 1.7)).blobs[0].id, ids[0])

    @unittest.skipUnless(db.HAVE_OPENCV, "two-blob separation needs OpenCV connected components")
    def test_two_hands_get_distinct_stable_ids_with_opencv(self) -> None:
        src, analyzer = synthetic(hands=2), make_analyzer()
        first = analyzer.analyze(frame_from(src.render(2.0), 2.0)).blobs
        self.assertEqual(len(first), 2)
        self.assertNotEqual(first[0].id, first[1].id)
        second = analyzer.analyze(frame_from(src.render(2.0 + 1 / 30), 2.0 + 1 / 30)).blobs
        self.assertEqual({b.id for b in second}, {b.id for b in first})
        capped = db.BoxAnalyzer(analyzer.box, db.AnalyzerConfig(occupancy=None, min_pixels=50, max_hands=1)).analyze(frame_from(src.render(2.0), 2.0))
        self.assertEqual(len(capped.blobs), 1)
        self.assertEqual(capped.stats["blobs"], 2.0)

    def test_max_hands_zero_reports_nothing_but_still_counts_pixels(self) -> None:
        src = synthetic()
        result = make_analyzer(max_hands=0).analyze(frame_from(src.render(2.0), 2.0))
        self.assertEqual(result.blobs, ())
        self.assertGreater(result.stats["pixels"], 0)


class TrackerTests(unittest.TestCase):
    def test_greedy_nearest_matching_and_new_ids(self) -> None:
        tr = db.BlobTracker(max_jump=0.25, max_missed=1)
        self.assertEqual(tr.update([(0.2, 0.2), (0.8, 0.8)]), [1, 2])
        self.assertEqual(tr.update([(0.82, 0.79), (0.21, 0.22)]), [2, 1])
        self.assertEqual(tr.update([(0.5, 0.5)]), [3])  # too far from both: a new id
        self.assertEqual(tr.update([(0.5, 0.5), (0.2, 0.2)]), [3, 1])  # 1 survived one missed frame

    def test_tracks_expire_after_max_missed_frames(self) -> None:
        tr = db.BlobTracker(max_jump=0.25, max_missed=1)
        self.assertEqual(tr.update([(0.5, 0.5)]), [1])
        tr.update([])
        self.assertEqual(tr.update([(0.5, 0.5)]), [1])
        tr.update([])
        tr.update([])
        self.assertEqual(tr.update([(0.5, 0.5)]), [2])
        tr.reset()
        self.assertEqual(tr.update([(0.5, 0.5)]), [1])


# ---- messages -------------------------------------------------------------- #


class MessageTests(ProtocolAssertions):
    def test_hello_message_shape(self) -> None:
        box = db.BoxConfig(near_m=NEAR, far_m=FAR, box_x=(-0.5, 0.5), box_y=(-0.4, 0.4))
        m = db.hello_message("synthetic", box, 30.0, (8, 6))
        self.assert_hello(m)
        self.assertEqual(set(m), HELLO_REQUIRED | HELLO_OPTIONAL)
        self.assertEqual(m["box"], {"x": [-0.5, 0.5], "y": [-0.4, 0.4], "z": [NEAR, FAR]})
        self.assertEqual(m["occupancy"], {"width": 8, "height": 6})
        bare = db.hello_message("realsense", box, None, None)
        self.assert_hello(bare)
        self.assertEqual(set(bare), HELLO_REQUIRED)

    def test_frame_message_shape_and_json_round_trip(self) -> None:
        src, analyzer = synthetic(), make_analyzer()
        m = db.frame_message(7, 12.5, analyzer.analyze(frame_from(src.render(2.0), 2.0)))
        self.assert_frame(m, (8, 6))
        self.assertEqual(m["seq"], 7)
        self.assertEqual(m["t"], 12.5)
        self.assertEqual(set(m["hands"][0]), {"id", "pos", "conf", "extent", "points"})
        text = db.encode_message(m)
        self.assertEqual(json.loads(text), m)
        self.assertNotIn(" ", text.split('"stats"')[0], "compact separators")

    def test_status_message(self) -> None:
        self.assertEqual(db.status_message("error", "boom"), {"type": "status", "level": "error", "message": "boom"})
        with self.assertRaises(ValueError):
            db.status_message("fatal", "boom")

    def test_encoder_refuses_non_finite_numbers(self) -> None:
        with self.assertRaises(ValueError):
            db.encode_message({"type": "status", "level": "info", "message": "x", "bad": float("nan")})


# ---- CLI dump and fixture --------------------------------------------------- #


def run_dump(*extra: str) -> list[dict[str, object]]:
    cmd = [sys.executable, os.path.join(HERE, "depth_bridge.py"), "--source", "synthetic", *extra]
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=60, check=False)
    if proc.returncode != 0:
        raise AssertionError(f"dump failed ({proc.returncode}): {proc.stderr}")
    return [json.loads(line) for line in proc.stdout.splitlines() if line.strip()]


class DumpCliTests(ProtocolAssertions):
    def test_dump_lines_match_the_protocol(self) -> None:
        lines = run_dump("--dump", "3", "--occupancy", "8", "6")
        self.assertEqual(len(lines), 4)
        hello, frames = lines[0], lines[1:]
        self.assert_hello(hello)
        self.assertEqual(hello["source"], "synthetic")
        self.assertEqual(hello["occupancy"], {"width": 8, "height": 6})
        for seq, frame in enumerate(frames):
            self.assert_frame(frame, (8, 6))
            self.assertEqual(frame["seq"], seq)
            self.assertEqual(len(frame["hands"]), 1, "the script starts with one hand present")  # type: ignore[arg-type]
        ts = [f["t"] for f in frames]
        self.assertEqual(ts, sorted(ts))  # type: ignore[type-var]

    def test_no_occupancy_flag_drops_the_grid_everywhere(self) -> None:
        lines = run_dump("--dump", "2", "--no-occupancy", "--points", "0", "--resolution", "160", "120", "--min-pixels", "20")
        self.assert_hello(lines[0])
        self.assertNotIn("occupancy", lines[0])
        for frame in lines[1:]:
            self.assert_frame(frame, None)
            for hand in frame["hands"]:  # type: ignore[union-attr]
                self.assertEqual(hand["points"], [])

    def test_bad_geometry_is_rejected(self) -> None:
        cmd = [sys.executable, os.path.join(HERE, "depth_bridge.py"), "--dump", "1", "--near", "1.5", "--far", "1.0"]
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=60, check=False)
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn("near < far", proc.stderr)

    @unittest.skipUnless(os.path.exists(FIXTURE), "fixture not generated")
    def test_checked_in_fixture_matches_the_protocol(self) -> None:
        with open(FIXTURE, encoding="utf-8") as fh:
            lines = [json.loads(line) for line in fh if line.strip()]
        self.assertGreaterEqual(len(lines), 2)
        self.assert_hello(lines[0])
        occ = lines[0].get("occupancy")
        size = (occ["width"], occ["height"]) if occ else None
        for frame in lines[1:]:
            self.assert_frame(frame, size)


if __name__ == "__main__":
    unittest.main(verbosity=2)
