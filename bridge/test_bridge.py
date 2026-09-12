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
import scan_fusion as sf  # noqa: E402

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
    """Small grids: with a 640x480 frame every 8x6 cell is exactly 80x80 pixels, which keeps the layout tests exact."""
    cfg: dict[str, object] = {"occupancy": (8, 6), "voxels": (8, 6, 4), "surface": (8, 6), "min_pixels": 50, "max_hands": 2}
    cfg.update(overrides)
    return db.BoxAnalyzer(db.BoxConfig(near_m=NEAR, far_m=FAR), db.AnalyzerConfig(**cfg))  # type: ignore[arg-type]


def grid_sizes(hello: dict[str, object]) -> tuple[tuple[int, int] | None, tuple[int, int, int] | None, tuple[int, int] | None]:
    """``(occupancy, voxels, surface)`` sizes announced by a hello message, ``None`` where absent."""
    occ, vox, surf = hello.get("occupancy"), hello.get("voxels"), hello.get("surface")
    return (
        (occ["width"], occ["height"]) if isinstance(occ, dict) else None,
        (vox["nx"], vox["ny"], vox["nz"]) if isinstance(vox, dict) else None,
        (surf["width"], surf["height"]) if isinstance(surf, dict) else None,
    )


def surface_byte(w: float) -> int:
    """The wire encoding of a normalized depth on the surface scan: 1 + round(254 w)."""
    return 1 + int(round(254.0 * w))


def synthetic(**kw: object) -> db.SyntheticSource:
    return db.SyntheticSource(near_m=NEAR, far_m=FAR, paced=False, **kw)  # type: ignore[arg-type]


# ---- protocol shape checks (hand-written mirror of protocol.ts) ------------ #

HELLO_REQUIRED, HELLO_OPTIONAL = {"type", "version", "source", "box"}, {"fps", "occupancy", "voxels", "surface", "skeleton", "frame"}
FRAME_REQUIRED, FRAME_OPTIONAL = {"type", "seq", "t", "hands"}, {"occupancy", "voxels", "surface", "stats"}
HAND_REQUIRED, HAND_OPTIONAL = {"id", "pos"}, {"conf", "extent", "openness", "pinch", "points", "skeleton"}
SKELETON_REQUIRED, SKELETON_OPTIONAL = {"type", "palm", "wrist", "fingers"}, {"elbow", "palmWidth", "armWidth"}
FINGER_KEYS = {"joints", "width", "extended"}
TRACKED_HAND_KEYS = {"id", "pos", "conf", "extent", "openness", "pinch", "points", "skeleton"}
BLOB_HAND_KEYS = {"id", "pos", "conf", "extent", "points"}


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
            self.assert_grid_size(m["occupancy"], {"width", "height"}, 256)
        if "voxels" in m:
            self.assert_grid_size(m["voxels"], {"nx", "ny", "nz"}, 128)
        if "surface" in m:
            self.assert_grid_size(m["surface"], {"width", "height"}, 512)
        if "skeleton" in m:
            self.assertIs(m["skeleton"], True, "announced only when the source tracks hands, never false")
        if "frame" in m:
            self.assertIn(m["frame"], ("image", "upright"))

    def assert_grid_size(self, size: object, keys: set[str], limit: int) -> None:
        assert isinstance(size, dict)
        self.assertEqual(set(size), keys)
        for side in size.values():
            self.assertIsInstance(side, int)
            self.assertTrue(1 <= side <= limit, size)

    def assert_payload(self, m: dict[str, object], key: str, size: tuple[int, ...] | None) -> None:
        """A base64 grid field is present with exactly prod(size) bytes, or absent when ``size`` is None."""
        if size is None:
            self.assertNotIn(key, m)
            return
        self.assertIn(key, m)
        raw = base64.b64decode(m[key], validate=True)  # type: ignore[arg-type]
        self.assertEqual(len(raw), math.prod(size), key)

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
        for key in ("openness", "pinch"):
            if key in h:
                self.assert_number(h[key], 0.0, 1.0)
        if "skeleton" in h:
            self.assert_skeleton(h["skeleton"])

    def assert_open_vec(self, v: object) -> None:
        """A skeleton joint: finite, rounded, NOT clamped (but nowhere near nonsense)."""
        self.assertIsInstance(v, list)
        assert isinstance(v, list)
        self.assertEqual(len(v), 3)
        for x in v:
            self.assert_number(x, -1.0, 2.0)
            self.assertEqual(x, round(x, 4))

    def assert_skeleton(self, s: object) -> None:
        """Mirror of ``bridgeSkeletonSchema``: exactly five fingers with five joints each, widths >= 0, type in the enum."""
        assert isinstance(s, dict)
        keys = set(s)
        self.assertTrue(SKELETON_REQUIRED <= keys <= SKELETON_REQUIRED | SKELETON_OPTIONAL, keys)
        self.assertIn(s["type"], db.HAND_TYPES)
        for key in ("palm", "wrist", "elbow"):
            if key in s:
                self.assert_open_vec(s[key])
        for key in ("palmWidth", "armWidth"):
            if key in s:
                self.assert_number(s[key], 0.0)
        fingers = s["fingers"]
        assert isinstance(fingers, list)
        self.assertEqual(len(fingers), 5)
        for f in fingers:
            assert isinstance(f, dict)
            self.assertEqual(set(f), FINGER_KEYS)
            joints = f["joints"]
            assert isinstance(joints, list)
            self.assertEqual(len(joints), 5)
            for j in joints:
                self.assert_open_vec(j)
            self.assert_number(f["width"], 0.0)
            self.assertIsInstance(f["extended"], bool)

    def assert_frame(
        self, m: dict[str, object], occupancy: tuple[int, int] | None,
        voxels: tuple[int, int, int] | None = None, surface: tuple[int, int] | None = None,
    ) -> None:
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
        self.assert_payload(m, "occupancy", occupancy)
        self.assert_payload(m, "voxels", voxels)
        self.assert_payload(m, "surface", surface)
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

    def test_grid_sizes_are_validated(self) -> None:
        for bad in ({"occupancy": (0, 6)}, {"voxels": (0, 6, 4)}, {"voxels": (129, 6, 4)}, {"surface": (0, 6)}, {"surface": (513, 6)}):
            with self.assertRaises(ValueError, msg=str(bad)):
                db.AnalyzerConfig(**bad)  # type: ignore[arg-type]


# ---- voxels ---------------------------------------------------------------- #


class VoxelTests(unittest.TestCase):
    """The foreground voxel grid: (nz, ny, nx) uint8, x fastest on the wire, top row first, nearest slab first."""

    def test_top_left_nearest_pixel_lands_at_index_zero(self) -> None:
        depth = backdrop()
        depth[0:80, 0:80] = depth_at(0.0)  # exactly one 80x80 cell of the 8x6 grid, at the near plane
        grid = make_analyzer().analyze(frame_from(depth)).voxels
        assert grid is not None
        self.assertEqual(grid.shape, (4, 6, 8))
        self.assertEqual(grid.dtype, np.uint8)
        self.assertEqual(int(grid[0, 0, 0]), 255)
        self.assertEqual(int(grid.sum()), 255, "nothing anywhere else")
        raw = base64.b64decode(db.encode_voxels(grid))
        self.assertEqual(len(raw), 8 * 6 * 4)
        self.assertEqual(raw[0], 255)
        self.assertEqual(set(raw[1:]), {0})

    def test_far_bottom_right_pixel_lands_in_the_last_slab(self) -> None:
        depth = backdrop()
        depth[400:480, 560:640] = depth_at(1.0)
        grid = make_analyzer().analyze(frame_from(depth)).voxels
        assert grid is not None
        self.assertEqual(int(grid[3, 5, 7]), 255)
        self.assertEqual(int(grid.sum()), 255)
        raw = base64.b64decode(db.encode_voxels(grid))
        self.assertEqual(raw[-1], 255)
        self.assertEqual(raw[(3 * 6 + 5) * 8 + 7], 255, "flat index is (z * ny + y) * nx + x")

    def test_slab_index_is_floor_of_w_times_nz(self) -> None:
        for w, expected in ((0.0, 0), (0.24, 0), (0.26, 1), (0.5, 2), (0.99, 3), (1.0, 3)):
            depth = backdrop()
            depth[0:80, 0:80] = depth_at(w)
            grid = make_analyzer().analyze(frame_from(depth)).voxels
            assert grid is not None
            self.assertEqual(int(np.argmax(grid[:, 0, 0])), expected, f"w={w}")
            self.assertEqual(int(grid[:, 0, 0].max()), 255)

    def test_value_is_the_filled_fraction_of_the_voxel_column(self) -> None:
        depth = np.full((60, 80), depth_at(0.5), dtype=np.uint16)  # 10x10 pixels per cell of an 8x6 grid
        mask = np.zeros((60, 80), dtype=bool)
        mask[0:10, 0:10] = True   # a solid cell reads 255
        mask[0:5, 10:20] = True   # half a cell reads 128
        mask[0, 20] = True        # one speckle pixel in a 100-pixel column reads 3: thin noise stays low
        grid = db.voxelize(depth, mask, NEAR_MM, FAR_MM, 8, 6, 4)  # straight to the kernel, no opening
        self.assertEqual(int(grid[2, 0, 0]), 255)
        self.assertEqual(int(grid[2, 0, 1]), 128)
        self.assertEqual(int(grid[2, 0, 2]), 3)
        self.assertEqual(int(grid.sum()), 255 + 128 + 3)
        self.assertEqual(int(db.voxelize(depth, np.zeros_like(mask), NEAR_MM, FAR_MM, 8, 6, 4).sum()), 0)

    def test_a_surface_on_a_slab_boundary_splits_and_columns_sum_to_the_occupancy(self) -> None:
        depth = backdrop()
        depth[0:80, 0:80] = depth_at(0.49)   # one cell, its lower half just in front of the w = 0.5 boundary...
        depth[0:40, 0:80] = depth_at(0.51)   # ...its upper half just behind it
        result = make_analyzer().analyze(frame_from(depth))
        assert result.voxels is not None and result.occupancy is not None
        self.assertEqual((int(result.voxels[1, 0, 0]), int(result.voxels[2, 0, 0])), (128, 128))
        self.assertEqual(int(result.occupancy[0, 0]), 255)
        src = synthetic()
        result = make_analyzer().analyze(frame_from(src.render(2.0), 2.0))
        assert result.voxels is not None and result.occupancy is not None
        sums = result.voxels.astype(np.int32).sum(axis=0)
        self.assertTrue((np.abs(sums - result.occupancy.astype(np.int32)) <= 2).all(), "same lateral cells, per-slab rounding only")
        self.assertGreater(int(sums.max()), 0)

    def test_grid_finer_than_the_image_reads_empty_cells_as_zero(self) -> None:
        depth = np.full((4, 4), depth_at(0.5), dtype=np.uint16)
        mask = np.zeros((4, 4), dtype=bool)
        mask[0, 0] = True  # pixel centre 0.5/4 = 0.125 -> cell 1 of 8
        grid = db.voxelize(depth, mask, NEAR_MM, FAR_MM, 8, 8, 2)
        self.assertEqual(grid.shape, (2, 8, 8))
        self.assertEqual(int(np.count_nonzero(grid)), 1)
        self.assertEqual(int(grid[1, 1, 1]), 255)

    def test_synthetic_hand_is_a_dome_at_its_depth(self) -> None:
        src, t = synthetic(), 2.0
        hand = src.scripted_hands(t)[0]
        grid = make_analyzer(voxels=(32, 24, 64)).analyze(frame_from(src.render(t), t)).voxels  # 12.5 mm slabs resolve the 40 mm dome
        assert grid is not None
        nz, ny, nx = grid.shape
        occupied = grid.any(axis=0)
        nearest = np.where(occupied, grid.astype(bool).argmax(axis=0), nz)  # per column: its nearest occupied slab
        cy, cx = int(hand.y * ny), int(hand.x * nx)
        self.assertTrue(occupied[cy, cx])
        self.assertEqual(int(nearest[cy, cx]), int(hand.z * nz), "the middle of the dome is at the scripted depth")
        self.assertEqual(int(nearest.min()), int(nearest[cy, cx]), "nothing is nearer than the middle")
        self.assertGreater(int(nearest[occupied].max()), int(nearest[cy, cx]), "the rim is deeper: a dome, not a disc")
        deepest = int(np.flatnonzero(grid.reshape(nz, -1).any(axis=1)).max())
        self.assertLessEqual(deepest, int((hand.z + src.dome_mm / (FAR_MM - NEAR_MM)) * nz) + 1, "nothing deeper than the dome's relief")
        z, y, x = np.unravel_index(int(np.argmax(grid)), grid.shape)
        self.assertAlmostEqual((x + 0.5) / nx, hand.x, delta=1.5 / nx)
        self.assertAlmostEqual((y + 0.5) / ny, hand.y, delta=1.5 / ny)
        self.assertLessEqual(abs(int(z) - int(hand.z * nz)), 1)

    def test_no_voxels_path(self) -> None:
        result = make_analyzer(voxels=None).analyze(frame_from(synthetic().render(2.0), 2.0))
        self.assertIsNone(result.voxels)
        self.assertIsNotNone(result.occupancy)
        self.assertIsNotNone(result.surface)
        self.assertNotIn("voxels", db.frame_message(0, 0.0, result))
        self.assertNotIn("voxels", db.hello_message("synthetic", db.BoxConfig(), 30.0, (8, 6), None, (8, 6)))
        with self.assertRaises(ValueError):
            db.encode_voxels(np.zeros((6, 8), dtype=np.uint8))  # a 2-D grid is not a voxel grid


# ---- surface scan ---------------------------------------------------------- #


class SurfaceTests(unittest.TestCase):
    """The nearest-depth scan: (height, width) uint8, row 0 = top; 0 = empty, else 1 + round(254 w)."""

    def test_top_left_nearest_cell_is_index_zero_with_value_one(self) -> None:
        depth = backdrop()
        depth[0:80, 0:80] = depth_at(0.0)
        surf = make_analyzer().analyze(frame_from(depth)).surface
        assert surf is not None
        self.assertEqual(surf.shape, (6, 8))
        self.assertEqual(surf.dtype, np.uint8)
        self.assertEqual(int(surf[0, 0]), 1, "the near plane is 1, never 0")
        self.assertEqual(int(np.count_nonzero(surf)), 1, "every empty cell is 0")
        raw = base64.b64decode(db.encode_surface(surf))
        self.assertEqual(len(raw), 48)
        self.assertEqual(raw[0], 1)
        self.assertEqual(set(raw[1:]), {0})

    def test_far_cell_reads_255_and_a_mid_cell_128(self) -> None:
        depth = backdrop()
        depth[400:480, 560:640] = depth_at(1.0)  # bottom-right cell, far plane
        depth[200:240, 240:320] = depth_at(0.5)  # half of cell (row 2, col 3), mid depth
        surf = make_analyzer().analyze(frame_from(depth)).surface
        assert surf is not None
        self.assertEqual(int(surf[5, 7]), 255)
        self.assertEqual(int(surf[2, 3]), 128)
        self.assertEqual(int(np.count_nonzero(surf)), 2)
        raw = base64.b64decode(db.encode_surface(surf))
        self.assertEqual(raw[-1], 255)
        self.assertEqual(raw[2 * 8 + 3], 128, "row-major, row 0 first")

    def test_a_cell_holds_its_nearest_pixel(self) -> None:
        depth = backdrop()
        depth[0:80, 0:80] = depth_at(0.8)
        depth[30:50, 30:50] = depth_at(0.3)  # a nearer patch inside the same cell wins (min, not mean)
        surf = make_analyzer().analyze(frame_from(depth)).surface
        assert surf is not None
        self.assertEqual(int(surf[0, 0]), surface_byte(0.3))
        self.assertEqual(int(surf[0, 1]), 0)

    def test_scan_surface_edge_cases(self) -> None:
        depth = np.full((4, 4), depth_at(0.5), dtype=np.uint16)
        self.assertEqual(int(db.scan_surface(depth, np.zeros((4, 4), dtype=bool), NEAR_MM, FAR_MM, 8, 6).sum()), 0)
        mask = np.zeros((4, 4), dtype=bool)
        mask[0, 0] = True
        surf = db.scan_surface(depth, mask, NEAR_MM, FAR_MM, 8, 8)  # grid finer than the image: pixel (0, 0) -> cell (1, 1)
        self.assertEqual(int(np.count_nonzero(surf)), 1)
        self.assertEqual(int(surf[1, 1]), 128)
        with self.assertRaises(ValueError):
            db.encode_surface(np.zeros((2, 6, 8), dtype=np.uint8))

    def test_synthetic_hand_scans_as_a_dome(self) -> None:
        src, t = synthetic(), 2.0
        hand = src.scripted_hands(t)[0]
        result = make_analyzer(surface=(64, 48)).analyze(frame_from(src.render(t), t))
        surf = result.surface
        assert surf is not None
        cy, cx = int(hand.y * 48), int(hand.x * 64)
        centre = int(surf[cy, cx])
        self.assertAlmostEqual(centre, surface_byte(hand.z), delta=1)
        lit = surf[surf > 0]
        self.assertEqual(int(lit.min()), centre, "the middle of the dome is the nearest point")
        ys, xs = np.nonzero(surf)
        self.assertGreater(int(surf[ys.min(), cx]), centre, "the rim is deeper")
        self.assertLessEqual(int(lit.max()), centre + int(round(254 * src.dome_mm / (FAR_MM - NEAR_MM))) + 1, "relief is at most the dome height")
        self.assertAlmostEqual((xs.min() + xs.max() + 1) / 2 / 64, hand.x, delta=1.5 / 64)
        self.assertAlmostEqual((ys.min() + ys.max() + 1) / 2 / 48, hand.y, delta=1.5 / 48)
        small = make_analyzer().analyze(frame_from(src.render(t), t))
        assert small.surface is not None and small.occupancy is not None
        self.assertTrue(((small.occupancy > 0) <= (small.surface > 0)).all(), "every cell the occupancy sees is scanned too")

    def test_no_surface_path(self) -> None:
        result = make_analyzer(surface=None).analyze(frame_from(synthetic().render(2.0), 2.0))
        self.assertIsNone(result.surface)
        self.assertIsNotNone(result.voxels)
        self.assertNotIn("surface", db.frame_message(0, 0.0, result))
        self.assertNotIn("surface", db.hello_message("synthetic", db.BoxConfig(), 30.0, (8, 6), (8, 6, 4), None))


# ---- tracked hands (skeletons) --------------------------------------------- #


def tracked_hand(palm: tuple[float, float, float] = (319.5, 239.5, 0.0), spread_px: float = 60.0, hand_id: int = 7, hand_type: str = "right", **kw: float) -> db.TrackedHand:
    """A hand in a 640x480 image: the forearm stub goes image-down from the palm, the fingers fan image-up and deeper."""
    if palm[2] == 0.0:
        palm = (palm[0], palm[1], float(depth_at(0.3)))
    joints = np.tile(np.asarray(palm, dtype=np.float64), (db.N_JOINTS, 1))
    joints[db.JOINT_WRIST] += (0.0, spread_px, 5.0)
    joints[db.JOINT_ELBOW] += (0.0, 2.0 * spread_px, 10.0)
    for f in range(db.N_FINGERS):
        for j in range(db.JOINTS_PER_FINGER):
            along = (j + 1) / db.JOINTS_PER_FINGER
            joints[db.finger_joint(f, j)] += ((f - 2) * spread_px / 2.0 * along, -spread_px * along, 20.0 * along)
    widths = np.array([80.0, 50.0, 14.0, 16.0, 16.0, 15.0, 12.0])
    extended = np.array([False, True, True, True, False])
    return db.TrackedHand(hand_id, hand_type, joints, widths, extended, confidence=kw.get("confidence", 0.2), grab_strength=kw.get("grab", 0.25), pinch_strength=kw.get("pinch", 0.6))


class TrackedHandTests(ProtocolAssertions):
    ROI = (160, 120, 480, 360)  # --roi 0.25 0.25 0.75 0.75 of a 640x480 frame: 320x240 pixels

    def test_normalizes_with_the_same_box_as_the_pixels(self) -> None:
        hand = tracked_hand(palm=(319.5, 239.5, float(depth_at(0.3))))  # pixel-centre coordinates of the ROI's middle
        sk = db.normalize_tracked_hand(hand, self.ROI, NEAR_MM, FAR_MM)
        self.assertEqual(sk.id, 7)
        self.assertEqual(sk.type, "right")
        for got, want in zip(sk.pos, (0.5, 0.5, 0.3)):
            self.assertAlmostEqual(got, want, places=6)
        wrist = sk.joints[db.JOINT_WRIST]
        self.assertAlmostEqual(float(wrist[1]), 0.5 + 60.0 / 240.0, places=6, msg="60 px down is 60/240 of the ROI height")
        self.assertAlmostEqual(float(wrist[2]), 0.3 + 5.0 / (FAR_MM - NEAR_MM), places=6)
        tip = sk.joints[db.finger_joint(4, 4)]
        self.assertAlmostEqual(float(tip[0]), 0.5 + 60.0 / 320.0, places=6, msg="the pinky tip is 60 px right: 60/320 of the ROI width")
        self.assertAlmostEqual(float(sk.widths[db.WIDTH_PALM]), 80.0 / 320.0, places=6, msg="widths are diameters in u units")
        self.assertAlmostEqual(float(sk.widths[db.WIDTH_FINGERS + 1]), 16.0 / 320.0, places=6)
        self.assertEqual(sk.conf, 0.5, "confidence is floored at 0.5: Ultraleap under-reports it")
        self.assertAlmostEqual(sk.openness, 0.75)
        self.assertAlmostEqual(sk.pinch, 0.6)
        self.assertEqual(len(sk.points), 6, "the palm and five tips")
        self.assertEqual(sk.points[0], sk.pos)
        self.assertEqual(list(sk.extended), [False, True, True, True, False])
        lo, hi = sk.extent
        self.assertTrue(all(lo[a] <= sk.pos[a] <= hi[a] for a in range(3)))
        self.assertEqual(db.normalize_tracked_hand(hand, self.ROI, NEAR_MM, FAR_MM, sample_points=0).points, (), "--points 0 drops them")
        self.assertEqual(db.normalize_tracked_hand(tracked_hand(confidence=0.9), self.ROI, NEAR_MM, FAR_MM).conf, 0.9)

    def test_joints_are_not_clamped_but_pos_and_extent_are(self) -> None:
        hand = tracked_hand(palm=(159.5, 119.5, float(depth_at(0.0))))  # the ROI's top-left corner: fingers leave it upward
        sk = db.normalize_tracked_hand(hand, self.ROI, NEAR_MM, FAR_MM)
        self.assertLess(float(sk.joints[:, 1].min()), 0.0)
        self.assertAlmostEqual(sk.pos[0], 0.0, places=6)
        m = db.tracked_hand_message(sk)
        self.assertEqual(set(m), TRACKED_HAND_KEYS)
        self.assert_hand(m)
        self.assertEqual(m["pos"], [0.0, 0.0, 0.0])
        self.assertEqual(m["extent"][0], [0.0, 0.0, 0.0], "clamped like pos")
        self.assertLess(min(j[1] for f in m["skeleton"]["fingers"] for j in f["joints"]), 0.0, "skeleton joints keep their overshoot")
        self.assertTrue(all(0.0 <= c <= 1.0 for p in m["points"] for c in p))

    def test_analyzer_carries_tracked_hands_and_frame_message_prefers_them(self) -> None:
        src, t = synthetic(), 2.0
        scripted = src.scripted_hands(t)[0]
        result = make_analyzer().analyze(db.DepthFrame(src.render(t), t, src.tracked_hands(t)))
        self.assertEqual(len(result.blobs), 1, "blobs are still computed")
        self.assertEqual(len(result.hands), 1)
        self.assertEqual(result.stats["trackedHands"], 1.0)
        self.assertEqual(result.stats["blobs"], 1.0)
        m = db.frame_message(3, 1.0, result)
        self.assert_frame(m, (8, 6), (8, 6, 4), (8, 6))
        h = m["hands"][0]
        self.assertEqual(set(h), TRACKED_HAND_KEYS)
        self.assertEqual(h["id"], 1)
        for got, want in zip(h["pos"], (scripted.x, scripted.y, scripted.z)):
            self.assertAlmostEqual(got, want, delta=1e-3)
        self.assertEqual((h["conf"], h["openness"], h["pinch"]), (1.0, 1.0, 0.0))
        self.assertEqual(len(h["points"]), 6)
        self.assertEqual(h["points"][0], h["pos"])
        sk = h["skeleton"]
        self.assertEqual(set(sk), SKELETON_REQUIRED | SKELETON_OPTIONAL)
        self.assertEqual(sk["type"], "right")
        self.assertEqual(sk["palm"], h["pos"])
        self.assertEqual([len(f["joints"]) for f in sk["fingers"]], [5] * 5)
        self.assertTrue(all(f["width"] > 0 for f in sk["fingers"]) and sk["palmWidth"] > 0 and sk["armWidth"] > 0)
        self.assertTrue(all(f["extended"] for f in sk["fingers"]))
        joints = [sk["palm"], sk["wrist"], sk["elbow"], *(j for f in sk["fingers"] for j in f["joints"])]
        lo, hi = h["extent"]
        for a in range(3):
            self.assertAlmostEqual(lo[a], min(j[a] for j in joints), delta=1e-4)
            self.assertAlmostEqual(hi[a], max(j[a] for j in joints), delta=1e-4)
        text = db.encode_message(m)
        self.assertEqual(json.loads(text), m)
        self.assertNotIn("NaN", text)

    def test_falls_back_to_blobs_without_tracked_hands(self) -> None:
        src, t = synthetic(), 2.0
        for hands in (None, ()):
            result = make_analyzer().analyze(db.DepthFrame(src.render(t), t, hands))
            self.assertEqual(result.hands, ())
            self.assertEqual(result.stats["trackedHands"], 0.0)
            m = db.frame_message(0, 0.0, result)
            self.assertEqual(len(m["hands"]), 1)
            self.assertEqual(set(m["hands"][0]), BLOB_HAND_KEYS, "exactly the blob hand of a plain depth camera")
            self.assertEqual(m["hands"][0]["id"], result.blobs[0].id)
            self.assert_frame(m, (8, 6), (8, 6, 4), (8, 6))

    def test_hand_outside_the_box_is_dropped(self) -> None:
        analyzer = make_analyzer()
        depth = backdrop()

        def hands_for(palm: tuple[float, float, float], **cfg: object) -> int:
            frame = db.DepthFrame(depth, 0.0, (tracked_hand(palm=palm),))
            return len(db.BoxAnalyzer(analyzer.box, db.AnalyzerConfig(occupancy=None, voxels=None, surface=None, **cfg)).analyze(frame).hands)  # type: ignore[arg-type]

        self.assertEqual(hands_for((319.5, 239.5, float(depth_at(0.5)))), 1)
        self.assertEqual(hands_for((319.5, 239.5, float(depth_at(1.2)))), 1, "a quarter box past the far plane is still reported (margin 0.25)")
        self.assertEqual(hands_for((319.5, 239.5, float(depth_at(1.3)))), 0, "farther out it is dropped like any pixel outside the box")
        self.assertEqual(hands_for((319.5, 239.5, float(depth_at(2.0)))), 0)
        self.assertEqual(hands_for((-200.0, 239.5, float(depth_at(0.5)))), 0, "well left of the ROI")
        self.assertEqual(hands_for((-100.0, 239.5, float(depth_at(0.5)))), 1, "just left of it, within the margin")
        self.assertEqual(hands_for((319.5, 239.5, float(depth_at(1.2))), hand_margin=0.0), 0)

    def test_synthetic_skeleton_lies_on_the_dome(self) -> None:
        src = synthetic()
        for t in (0.0, 2.0, 5.5, 9.0):
            depth = src.render(t)
            scripted = src.scripted_hands(t)
            hands = src.tracked_hands(t)
            self.assertEqual(len(hands), len(scripted))
            for hand, script in zip(hands, scripted):
                u, v = np.rint(hand.joints[:, 0]).astype(int), np.rint(hand.joints[:, 1]).astype(int)
                self.assertTrue((u >= 0).all() and (u < 640).all() and (v >= 0).all() and (v < 480).all())
                rendered = depth[v, u].astype(np.float64)
                self.assertLess(float(np.abs(rendered - hand.joints[:, 2]).max()), 1.5, f"t={t}: every joint's depth is the dome under it")
                self.assertTrue(((rendered >= NEAR_MM) & (rendered <= FAR_MM)).all(), "every joint is on a foreground pixel")
                palm = hand.joints[db.JOINT_PALM]
                self.assertAlmostEqual(float(palm[0]), script.x * 640 - 0.5, places=6)
                self.assertAlmostEqual(float(palm[1]), script.y * 480 - 0.5, places=6)
                self.assertAlmostEqual(float(palm[2]), depth_at(script.z), delta=0.5, msg="the palm is the dome's centre, its nearest point")
                self.assertGreaterEqual(float(hand.joints[:, 2].min()), float(palm[2]) - 1e-9)
                dx = ((hand.joints[:, 0] + 0.5) / 640 - script.x) / script.r
                dy = ((hand.joints[:, 1] + 0.5) / 480 - script.y) / (script.r * 1.4)
                self.assertLessEqual(float((dx * dx + dy * dy).max()), 1.0, "every joint is inside the dome")
                self.assertTrue((hand.widths_px > 0).all())
        self.assertEqual(src.tracked_hands(12.0), (), "no hand, no skeleton")
        two = synthetic(hands=2).tracked_hands(2.0)
        self.assertEqual([(h.id, h.type) for h in two], [(1, "right"), (2, "left")])
        src.start()
        frame = src.read()
        assert frame.hands is not None
        self.assertEqual(len(frame.hands), 1, "read() carries the skeleton")
        self.assertTrue(src.skeleton)

    def test_tracked_hand_validation(self) -> None:
        good = tracked_hand()
        with self.assertRaises(ValueError):
            db.TrackedHand(1, "both", good.joints, good.widths_px, good.extended)
        with self.assertRaises(ValueError):
            db.TrackedHand(1, "left", good.joints[:5], good.widths_px, good.extended)
        with self.assertRaises(ValueError):
            db.TrackedHand(1, "left", good.joints, good.widths_px[:3], good.extended)
        bad = good.joints.copy()
        bad[3, 2] = float("nan")
        with self.assertRaises(ValueError):
            db.TrackedHand(1, "left", bad, good.widths_px, good.extended)
        with self.assertRaises(ValueError):
            db.TrackedHand(-1, "left", good.joints, good.widths_px, good.extended)
        self.assertEqual(good.finger(2).shape, (5, 3))

    def test_hello_announces_skeleton_only_when_asked(self) -> None:
        box = db.BoxConfig(near_m=NEAR, far_m=FAR)
        with_skeleton = db.hello_message("synthetic", box, 30.0, (8, 6), (8, 6, 4), (8, 6), skeleton=True)
        self.assert_hello(with_skeleton)
        self.assertIs(with_skeleton["skeleton"], True)
        without = db.hello_message("realsense", box, 30.0, (8, 6), (8, 6, 4), (8, 6))
        self.assert_hello(without)
        self.assertNotIn("skeleton", without)
        self.assertFalse(db.RealSenseSource.skeleton)
        self.assertTrue(db.SyntheticSource.skeleton)


# ---- scan fusion: the skeleton's capsule model rendered into the depth ------ #


def reference_rasterize(capsules: np.ndarray, shape: tuple[int, int], focal_px: float | None = None, mm_per_px: float = 1.0) -> np.ndarray:
    """Brute force, float64, every pixel of every capsule: what ``rasterize_capsules`` must reproduce."""
    h, w = shape
    out = np.full((h, w), np.inf)
    ys, xs = np.mgrid[0:h, 0:w].astype(np.float64)
    for ax, ay, az, bx, by, bz, r, relief in np.asarray(capsules, dtype=np.float64).reshape(-1, 8):
        if r <= 0:
            continue
        abx, aby, abz = bx - ax, by - ay, bz - az
        len2 = abx * abx + aby * aby
        t = np.clip(((xs - ax) * abx + (ys - ay) * aby) / len2, 0.0, 1.0) if len2 > 1e-12 else np.full_like(xs, 0.0 if az <= bz else 1.0)
        dx, dy = xs - (ax + abx * t), ys - (ay + aby * t)
        d2 = dx * dx + dy * dy
        z = az + abz * t
        s = z / focal_px if focal_px else mm_per_px
        depth = z - relief * np.sqrt(np.maximum(1.0 - d2 / (r * r), 0.0)) * s
        out = np.where(d2 < r * r, np.minimum(out, depth), out)
    return out


def capsule(a: tuple[float, float, float], b: tuple[float, float, float], radius: float, relief: float | None = None) -> list[float]:
    return [*a, *b, radius, radius if relief is None else relief]


def assert_same_render(test: unittest.TestCase, got: np.ndarray, want: np.ndarray, atol: float = 0.05) -> None:
    test.assertEqual(got.dtype, np.float32)
    test.assertTrue(np.array_equal(np.isfinite(got), np.isfinite(want)), "the same pixels are lit")
    lit = np.isfinite(want)
    test.assertTrue(np.allclose(got[lit], want[lit], atol=atol), f"max error {np.abs(got[lit] - want[lit]).max():.3f} mm")


class RasterizerTests(unittest.TestCase):
    """``scan_fusion.rasterize_capsules``: rounded tubes in the image frame, nearest surface first, clipped to the image."""

    def test_horizontal_capsule_is_a_rounded_tube_of_its_width(self) -> None:
        img = sf.rasterize_capsules([capsule((20, 30, 500), (60, 30, 500), 5)], (60, 80), mm_per_px=2.0)
        self.assertEqual(img.shape, (60, 80))
        column = img[:, 40]
        self.assertEqual(np.flatnonzero(np.isfinite(column)).tolist(), list(range(26, 35)), "|d| < 5: nine rows across, 2r wide")
        self.assertAlmostEqual(float(column[30]), 500 - 5 * 2, places=3, msg="the centre line bulges the radius (in mm per px) towards the camera")
        self.assertAlmostEqual(float(column[33]), 500 - math.sqrt(25 - 9) * 2, places=3)
        self.assertAlmostEqual(float(column[34]), 500 - 3 * 2, places=3)
        self.assertTrue((np.diff(column[30:35]) > 0).all() and (np.diff(column[26:31]) < 0).all(), "rounded: deeper away from the axis")
        self.assertTrue((column[26:35] >= 490).all() and (column[26:35] < 500).all())
        self.assertAlmostEqual(float(img[30, 16]), 500 - 3 * 2, places=3, msg="rounded caps: 4 px past the end is still inside")
        self.assertFalse(np.isfinite(img[30, 15]))
        self.assertAlmostEqual(float(img[30, 64]), 500 - 3 * 2, places=3)
        self.assertEqual(int(np.isfinite(img).sum()), int(np.isfinite(reference_rasterize([capsule((20, 30, 500), (60, 30, 500), 5)], (60, 80), mm_per_px=2.0)).sum()))
        flat = sf.rasterize_capsules([capsule((20, 30, 500), (60, 30, 500), 5, relief=0.0)], (60, 80), mm_per_px=2.0)
        self.assertTrue((flat[np.isfinite(flat)] == 500).all(), "no relief: a flat ribbon at the bone's depth")

    def test_perspective_relief_is_radius_times_depth_over_focal(self) -> None:
        img = sf.rasterize_capsules([capsule((20, 30, 500), (60, 30, 500), 5), capsule((20, 10, 250), (60, 10, 250), 5)], (60, 80), focal_px=160.0)
        self.assertAlmostEqual(float(img[30, 40]), 500 - 5 * 500 / 160, places=3)
        self.assertAlmostEqual(float(img[10, 40]), 250 - 5 * 250 / 160, places=3, msg="a pixel is smaller nearer the camera, so the same radius bulges less")
        sloped = sf.rasterize_capsules([capsule((20, 30, 400), (60, 30, 600), 5)], (60, 80), focal_px=160.0)
        self.assertAlmostEqual(float(sloped[30, 40]), 500 - 5 * 500 / 160, places=2, msg="depth interpolates along the bone")
        with self.assertRaises(ValueError):
            sf.rasterize_capsules([capsule((20, 30, 500), (60, 30, 500), 5)], (60, 80), focal_px=0.0)

    def test_nearest_capsule_wins_and_out_accumulates(self) -> None:
        far, near = capsule((20, 30, 500), (60, 30, 500), 5), capsule((40, 10, 400), (40, 50, 400), 5)
        both = sf.rasterize_capsules([far, near], (60, 80), mm_per_px=1.0)
        self.assertAlmostEqual(float(both[30, 40]), 395.0, places=3, msg="at the crossing the nearer tube is in front")
        self.assertAlmostEqual(float(both[30, 25]), 495.0, places=3)
        self.assertAlmostEqual(float(both[15, 40]), 395.0, places=3)
        canvas = sf.rasterize_capsules([far], (60, 80), mm_per_px=1.0)
        same = sf.rasterize_capsules([near], (60, 80), mm_per_px=1.0, out=canvas)
        self.assertIs(same, canvas)
        self.assertTrue(np.array_equal(canvas, both), "rendering into an existing canvas keeps the nearest of both")
        with self.assertRaises(ValueError):
            sf.rasterize_capsules([far], (60, 80), out=np.zeros((60, 80), dtype=np.float64))

    def test_bounding_boxes_are_clipped_at_the_image_edge(self) -> None:
        corner = sf.rasterize_capsules([capsule((0, 0, 500), (0, 0, 500), 10)], (60, 80), mm_per_px=1.0)
        ys, xs = np.mgrid[0:60, 0:80]
        self.assertEqual(int(np.isfinite(corner).sum()), int((xs * xs + ys * ys < 100).sum()), "a sphere on the corner: exactly its quadrant")
        self.assertAlmostEqual(float(corner[0, 0]), 490.0, places=3)
        for caps in (
            [capsule((-30, 30, 500), (10, 30, 500), 6)],       # enters from the left
            [capsule((70, -10, 500), (70, 20, 500), 6)],       # from the top
            [capsule((75, 55, 500), (120, 90, 500), 8)],       # leaves bottom-right
            [capsule((-20, 30, 500), (100, 30, 500), 4)],      # spans the whole width
            [capsule((30, 30, 500), (50, 30, 500), 1e6)],      # covers everything
        ):
            assert_same_render(self, sf.rasterize_capsules(caps, (60, 80), mm_per_px=1.0), reference_rasterize(caps, (60, 80), mm_per_px=1.0))
        outside = sf.rasterize_capsules([capsule((-40, 30, 500), (-20, 30, 500), 5), capsule((10, 100, 500), (30, 120, 500), 5)], (60, 80))
        self.assertFalse(np.isfinite(outside).any(), "entirely outside: nothing, and no error")
        self.assertFalse(np.isfinite(sf.rasterize_capsules(np.zeros((0, 8)), (60, 80))).any())
        self.assertFalse(np.isfinite(sf.rasterize_capsules([capsule((20, 30, 500), (60, 30, 500), 0.0)], (60, 80))).any(), "a zero radius draws nothing")
        with self.assertRaises(ValueError):
            sf.rasterize_capsules([capsule((20, 30, float("nan")), (60, 30, 500), 5)], (60, 80))

    def test_degenerate_capsule_is_a_sphere_at_its_nearer_end(self) -> None:
        for a, b in (((30, 30, 600), (30, 30, 400)), ((30, 30, 400), (30, 30, 600))):
            img = sf.rasterize_capsules([capsule(a, b, 5)], (60, 80), mm_per_px=1.0)
            self.assertAlmostEqual(float(img[30, 30]), 395.0, places=3)
            self.assertEqual(int(np.isfinite(img).sum()), int(np.isfinite(reference_rasterize([capsule(a, b, 5)], (60, 80))).sum()))

    def test_matches_the_brute_force_reference_on_whole_hands(self) -> None:
        src = synthetic(hands=2)
        hands = src.tracked_hands(2.0)
        caps = np.concatenate([sf.hand_capsules(h) for h in hands])
        self.assertEqual(len(caps), 48)
        for focal, scale in ((None, 1.25), (400.0, 1.0)):
            assert_same_render(self, sf.rasterize_capsules(caps, (480, 640), focal, scale), reference_rasterize(caps, (480, 640), focal, scale))
        full, bounds = sf.render_hands(hands, (480, 640), (0, 0), 400.0)
        window, _ = sf.render_hands(hands, (240, 320), (160, 120), 400.0)
        self.assertTrue(np.array_equal(window, full[120:360, 160:480]), "an offset window is the crop of the full render")
        self.assertTrue(np.isfinite(full[int(round(hands[0].joints[db.JOINT_PALM][1])), int(round(hands[0].joints[db.JOINT_PALM][0]))]))
        assert bounds is not None
        r0, r1, c0, c1 = bounds
        ys, xs = np.nonzero(np.isfinite(full))
        self.assertTrue(r0 <= ys.min() and ys.max() < r1 and c0 <= xs.min() and xs.max() < c1, "the bounds enclose every lit pixel")
        self.assertTrue(ys.min() - r0 <= 2 and r1 - 1 - ys.max() <= 2 and xs.min() - c0 <= 2 and c1 - 1 - xs.max() <= 2, "and are tight to it")
        self.assertEqual(sf.capsule_bounds(np.zeros((0, 8)), (480, 640)), None)
        self.assertEqual(sf.capsule_bounds([capsule((-40, 30, 500), (-20, 30, 500), 5)], (60, 80)), None, "nothing visible, no bounds")
        self.assertEqual(sf.capsule_bounds([capsule((0, 0, 500), (0, 0, 500), 10)], (60, 80)), (0, 11, 0, 11))
        reused = np.empty((480, 640), dtype=np.float32)
        again, _ = sf.render_hands(hands, (480, 640), (0, 0), 400.0, out=reused)
        self.assertIs(again, reused)
        self.assertTrue(np.array_equal(again, full), "a reused canvas is cleared first")
        self.assertFalse(np.isfinite(sf.render_hands([], (480, 640))[0]).any())

    def test_hand_capsules_follow_the_browsers_bones_plus_a_palm(self) -> None:
        hand = tracked_hand()  # widths: palm 80, arm 50, fingers 14, 16, 16, 15, 12
        caps = sf.hand_capsules(hand)
        self.assertEqual(caps.shape, (24, 8), "twenty finger bones, the forearm, three palm capsules")
        index = caps[4:8]
        self.assertEqual(index[:, sf.CAP_RADIUS].round(4).tolist(), [8 * 1.15, 8.0, 8 * 0.9, 8 * 0.8], "width / 2 times 1.15, 1, .9, .8 from the carpal end")
        self.assertTrue(np.array_equal(index[:, sf.CAP_RELIEF], index[:, sf.CAP_RADIUS]), "fingers are round")
        for j in range(4):
            self.assertTrue(np.array_equal(index[j, :3], hand.joints[db.finger_joint(1, j)]) and np.array_equal(index[j, 3:6], hand.joints[db.finger_joint(1, j + 1)]))
        forearm = caps[20]
        self.assertTrue(np.array_equal(forearm[:3], hand.joints[db.JOINT_WRIST]) and np.array_equal(forearm[3:6], hand.joints[db.JOINT_ELBOW]))
        self.assertAlmostEqual(float(forearm[sf.CAP_RADIUS]), 25 * 0.85)
        wrist, index_mcp, pinky_mcp = hand.joints[db.JOINT_WRIST], hand.joints[db.finger_joint(1, 1)], hand.joints[db.finger_joint(4, 1)]
        palm = caps[21:]
        self.assertTrue(np.array_equal(palm[0, :3], index_mcp) and np.array_equal(palm[0, 3:6], wrist))
        self.assertTrue(np.array_equal(palm[1, :3], pinky_mcp) and np.array_equal(palm[1, 3:6], wrist))
        self.assertTrue(np.array_equal(palm[2, :3], index_mcp) and np.array_equal(palm[2, 3:6], pinky_mcp))
        self.assertTrue((palm[:, sf.CAP_RADIUS] == 80 * sf.PALM_RADIUS_FACTOR).all() and (palm[:, sf.CAP_RELIEF] == 80 * sf.PALM_RELIEF_FACTOR).all())
        self.assertLess(sf.PALM_RELIEF_FACTOR, sf.PALM_RADIUS_FACTOR, "the palm is a flattened slab, wider than it is thick")
        joints = hand.joints.copy()
        joints[db.finger_joint(0, 0)] = joints[db.finger_joint(0, 1)]  # a zero-length thumb metacarpal, as the Leap reports it
        thumbless = sf.hand_capsules(db.TrackedHand(1, "left", joints, hand.widths_px, hand.extended))
        self.assertEqual(len(thumbless), 23, "zero-length bones are skipped like the browser does")
        no_elbow = sf.hand_capsules(db.TrackedHand(1, "left", hand.joints, hand.widths_px, hand.extended, has_elbow=False))
        self.assertEqual(len(no_elbow), 23)
        self.assertFalse(any(np.array_equal(c[3:6], hand.joints[db.JOINT_ELBOW]) for c in no_elbow), "no elbow, no forearm")
        widths = hand.widths_px.copy()
        widths[db.WIDTH_FINGERS + 2] = 0.0
        self.assertEqual(len(sf.hand_capsules(db.TrackedHand(1, "left", hand.joints, widths, hand.extended))), 20, "a zero width (a line, tolerated by the protocol) draws nothing")

    def test_two_hands_render_within_budget(self) -> None:
        hands = synthetic(hands=2).tracked_hands(2.0)
        small = []
        for h in hands:
            joints = h.joints.copy()
            joints[:, 0] *= 0.5
            joints[:, 1] *= 0.5
            small.append(db.TrackedHand(h.id, h.type, joints, h.widths_px * 0.5, h.extended))
        best = min(_timed(lambda: sf.render_hands(small, (240, 320), (0, 0), 160.0)) for _ in range(20))
        self.assertLess(best, 0.010, f"two hands at 320x240 took {best * 1000:.2f} ms (a laptop does it in about 2 ms; the budget is 3)")

    def test_row_scale_renders_round_tubes_on_tall_cells(self) -> None:
        """A grid whose rows are twice as tall as its columns renders like a square grid twice as fine vertically, sampled every other row."""
        caps = [capsule((4.0, 3.0, 200.0), (20.0, 9.0, 260.0), 4.0)]
        tall = sf.rasterize_capsules(caps, (16, 28), None, 2.0, row_scale=2.0)
        stretched = [capsule((4.0, 6.0, 200.0), (20.0, 18.0, 260.0), 4.0)]
        square = sf.rasterize_capsules(stretched, (32, 28), None, 2.0)
        assert_same_render(self, tall, square[::2], atol=1e-3)
        self.assertEqual(sf.capsule_bounds(caps, (16, 28), row_scale=2.0), (1, 12, 0, 25), "a radius of 4 columns spans 2 rows")
        self.assertEqual(sf.capsule_bounds(caps, (16, 28)), (0, 14, 0, 25))
        with self.assertRaises(ValueError):
            sf.rasterize_capsules(caps, (16, 28), None, 2.0, row_scale=0.0)


def _timed(fn: "Callable[[], object]") -> float:
    t0 = time.perf_counter()
    fn()
    return time.perf_counter() - t0


class FusionRuleTests(unittest.TestCase):
    """``scan_fusion.fuse_depth``: which of the measurement and the model a pixel takes under each mode."""

    def scene(self) -> tuple[np.ndarray, np.ndarray]:
        measured = np.zeros((4, 6), dtype=np.uint16)
        model = np.full((4, 6), np.inf, dtype=np.float32)
        measured[:, 0], model[:, 0] = 700, 720       # a measurement that agrees with the model (20 mm)
        measured[:, 1], model[:, 1] = 0, 650         # no measurement under the model
        measured[:, 2], model[:, 2] = 500, 600       # a phantom near match under the model
        measured[:, 3], model[:, 3] = 1500, 700      # the backdrop seen through a hand the matcher missed
        measured[:, 4], model[:, 4] = 900, np.inf    # outside the model
        measured[:, 5], model[:, 5] = 800, 1300      # the model beyond the far plane (1200): no model there
        return measured, model

    def test_fill_keeps_agreeing_measurements_and_takes_the_model_elsewhere_under_it(self) -> None:
        measured, model = self.scene()
        fused, take = sf.fuse_depth(measured, model, "fill", 40.0, NEAR_MM, FAR_MM)
        self.assertEqual(fused.dtype, np.uint16)
        self.assertEqual(fused[0].tolist(), [700, 650, 600, 700, 900, 800])
        self.assertEqual(take[0].tolist(), [False, True, True, True, False, False])
        self.assertTrue((fused == fused[0]).all() and (take == take[0]).all())
        self.assertEqual(measured[0, 1], 0, "the input is untouched")

    def test_model_mode_replaces_the_measurement_wherever_the_model_has_a_surface(self) -> None:
        measured, model = self.scene()
        fused, take = sf.fuse_depth(measured, model, "model", 40.0, NEAR_MM, FAR_MM)
        self.assertEqual(fused[0].tolist(), [720, 650, 600, 700, 900, 800])
        self.assertEqual(take[0].tolist(), [True, True, True, True, False, False])

    def test_off_is_the_identity(self) -> None:
        measured, model = self.scene()
        fused, take = sf.fuse_depth(measured, model, "off", 40.0, NEAR_MM, FAR_MM)
        self.assertIs(fused, measured)
        self.assertFalse(take.any())

    def test_tolerance_is_inclusive_and_honoured(self) -> None:
        measured = np.array([[700, 700, 700]], dtype=np.uint16)
        model = np.array([[720.0, 721.0, 700.4]], dtype=np.float32)
        fused, take = sf.fuse_depth(measured, model, "fill", 20.0, NEAR_MM, FAR_MM)
        self.assertEqual(fused[0].tolist(), [700, 721, 700])
        self.assertEqual(take[0].tolist(), [False, True, False])
        fused, take = sf.fuse_depth(measured, model, "fill", 0.0, NEAR_MM, FAR_MM)
        self.assertEqual(fused[0].tolist(), [720, 721, 700], "tolerance 0: only an exact match keeps the measurement (700.4 rounds to 700)")
        self.assertEqual(take[0].tolist(), [True, True, True])
        fused, _ = sf.fuse_depth(measured, model, "fill", 1000.0, NEAR_MM, FAR_MM)
        self.assertEqual(fused[0].tolist(), [700, 700, 700])
        with self.assertRaises(ValueError):
            sf.fuse_depth(measured, model, "fill", -1.0, NEAR_MM, FAR_MM)

    def test_near_and_far_bound_the_model_like_any_pixel(self) -> None:
        measured = np.array([[0, 0, 0, 0, 500]], dtype=np.uint16)
        model = np.array([[NEAR_MM - 1, NEAR_MM, FAR_MM, FAR_MM + 1, 300.0]], dtype=np.float32)
        fused, take = sf.fuse_depth(measured, model, "fill", 40.0, NEAR_MM, FAR_MM)
        self.assertEqual(fused[0].tolist(), [0, int(NEAR_MM), int(FAR_MM), 0, 500], "in front of near or behind far the model does not exist, so the measurement stands, even a missing one")
        self.assertEqual(take[0].tolist(), [False, True, True, False, False])
        fused, take = sf.fuse_depth(np.zeros((1, 2), dtype=np.uint16), np.array([[0.4, 1.0]], dtype=np.float32), "model", 40.0, 0.0, 10.0)
        self.assertEqual(fused[0].tolist(), [0, 1], "near 0: a model depth below 1 mm would read as 'no measurement', so it is dropped")

    def test_rounding_shape_and_argument_checks(self) -> None:
        measured = np.zeros((2, 2), dtype=np.uint16)
        fused, _ = sf.fuse_depth(measured, np.array([[650.6, 649.4], [np.inf, np.inf]], dtype=np.float32), "fill", 40.0, NEAR_MM, FAR_MM)
        self.assertEqual(fused.tolist(), [[651, 649], [0, 0]])
        fused, take = sf.fuse_depth(measured, np.full((2, 2), np.inf, dtype=np.float32), "fill", 40.0, NEAR_MM, FAR_MM)
        self.assertFalse(take.any())
        self.assertTrue(np.array_equal(fused, measured))
        with self.assertRaises(ValueError):
            sf.fuse_depth(measured, np.full((2, 3), np.inf, dtype=np.float32), "fill", 40.0, NEAR_MM, FAR_MM)
        with self.assertRaises(ValueError):
            sf.fuse_depth(measured, np.full((2, 2), np.inf, dtype=np.float32), "smooth", 40.0, NEAR_MM, FAR_MM)
        with self.assertRaises(ValueError):
            sf.fuse_depth(measured.astype(np.float32), np.full((2, 2), np.inf, dtype=np.float32), "fill", 40.0, NEAR_MM, FAR_MM)
        self.assertEqual(sf.FUSE_MODES, db.SCAN_FUSE_MODES)
        self.assertEqual(sf.FUSE_MODES, ("off", "fill", "model", "blend"))
        self.assertEqual(sf.isotropic_mm_per_px(NEAR_MM, FAR_MM, 640), 1.25)

    def blend_scene(self, noise_mm: float, seed: int = 0) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        """A flat 40x40 measurement at 700 mm +- noise under a flat model at 712 mm (inside the 400-1200 box, on its near side of the depth ramp), with a hole, a phantom patch and a strip outside the model."""
        rng = np.random.default_rng(seed)
        truth = np.full((40, 40), 700.0, dtype=np.float32)
        measured = np.clip(np.rint(truth + rng.normal(0.0, noise_mm, truth.shape)), 1, 65535).astype(np.uint16)
        measured[10:14, 10:14] = 0            # a hole
        measured[20:26, 20:26] = 600          # a phantom patch, 100 mm off the model
        model = np.full((40, 40), 712.0, dtype=np.float32)
        model[:, 34:] = np.inf                # nothing modelled in the last columns
        return measured, model, truth

    def test_blend_keeps_a_clean_measurement_and_fills_and_replaces_like_fill(self) -> None:
        measured, model, truth = self.blend_scene(1.0)
        fused, take = sf.fuse_depth(measured, model, "blend", 40.0, NEAR_MM, FAR_MM)
        self.assertEqual(fused.dtype, np.uint16)
        core = np.zeros(measured.shape, dtype=bool)
        core[2:8, 2:8] = True
        self.assertLess(float(np.abs(fused[core].astype(np.float32) - measured[core].astype(np.float32)).mean()), 1.5, "a quiet measurement on the near side of the box stays the measurement (weight ~0, only the median touches it)")
        self.assertFalse(take[core].any())
        self.assertTrue((fused[11:13, 11:13] > 0).all(), "the hole is filled")
        self.assertTrue(take[11:13, 11:13].all())
        self.assertTrue((np.abs(fused[11:13, 11:13].astype(np.float32) - 712.0) <= 12.0).all(), "with the model (or the median of measurement and model around it)")
        self.assertTrue((fused[22:24, 22:24] == 712).all(), "the phantom patch is replaced by the model")
        self.assertTrue(take[22:24, 22:24].all())
        self.assertTrue(np.array_equal(fused[:, 34:], measured[:, 34:]), "outside the model nothing changes")
        self.assertFalse(take[:, 34:].any())

    def test_blend_moves_a_noisy_measurement_toward_the_model_and_smooths_it(self) -> None:
        measured, model, truth = self.blend_scene(25.0)
        fill, _ = sf.fuse_depth(measured, model, "fill", 60.0, NEAR_MM, FAR_MM)
        blend, take = sf.fuse_depth(measured, model, "blend", 60.0, NEAR_MM, FAR_MM)
        core = np.zeros(measured.shape, dtype=bool)
        core[2:8, 2:8] = True
        core[30:38, 2:8] = True
        err_fill = np.abs(fill[core].astype(np.float32) - truth[core])
        err_blend = np.abs(blend[core].astype(np.float32) - truth[core])
        self.assertLess(float(np.median(err_blend)), float(np.median(err_fill)), (np.median(err_blend), np.median(err_fill)))
        self.assertLessEqual(float(np.median(err_blend)), 12.5, "with 25 mm of noise the weight is 1: the result is the model, 12 mm from the truth")
        self.assertLess(float(blend[core].astype(np.float32).std()), 0.5 * float(fill[core].astype(np.float32).std()), "the noisy hand reads smooth")
        self.assertTrue(take[core].mean() > 0.9, "with 25 mm of noise the model's weight is 1: those pixels count as model")
        self.assertTrue(np.array_equal(blend[:, 34:], measured[:, 34:]))
        # The weight ramps: 5 mm of noise gives the measurement, 20 the model, halfway in between.
        w = sf.blend_weight(np.array([0.0, 5.0, 12.5, 20.0, 40.0], dtype=np.float32), 200.0)
        self.assertTrue(np.allclose(w, [0.0, 0.0, 0.5, 1.0, 1.0]))
        self.assertTrue(np.allclose(sf.blend_weight(np.zeros(3, dtype=np.float32), np.array([350.0, 400.0, 450.0]), depth_range=(350.0, 450.0)), [0.0, 0.5, 1.0]), "and with the depth")
        self.assertEqual(float(sf.blend_weight(np.float32(30.0), 100.0)), 1.0)
        self.assertEqual(sf.blend_depth_range(100.0, 450.0), (345.0, 450.0), "the far third of the Leap box")
        self.assertEqual(sf.blend_depth_range(400.0, 1200.0), (960.0, 1200.0))

    def test_blend_weight_grows_with_depth_even_for_a_quiet_measurement(self) -> None:
        rng = np.random.default_rng(1)
        for depth, expect_model in ((250.0, False), (680.0, True)):
            truth = np.full((30, 30), depth, dtype=np.float32)
            measured = np.clip(np.rint(truth + rng.normal(0.0, 1.0, truth.shape)), 1, 65535).astype(np.uint16)
            model = np.full((30, 30), depth + 15.0, dtype=np.float32)
            fused, take = sf.fuse_depth(measured, model, "blend", 40.0, 100.0, 700.0)  # the ramp runs 520 -> 700 mm, on the model's depth
            centre = fused[10:20, 10:20].astype(np.float32)
            if expect_model:
                weight = (depth + 15.0 - 520.0) / 180.0
                self.assertTrue(np.allclose(centre, depth + 15.0 * weight, atol=1.5), f"at a model depth of 695 of 700 mm the weight is {weight:.2f}: nearly the model whatever the noise")
                self.assertTrue(take[10:20, 10:20].all())
            else:
                self.assertTrue(np.allclose(centre, depth, atol=2.0), "at 25 cm a quiet measurement is kept")
                self.assertFalse(take[10:20, 10:20].any())
        noise = sf.local_noise(np.array([[1.0, 3.0, 5.0], [1.0, 3.0, 5.0], [1.0, 3.0, 5.0]], dtype=np.float32), np.ones((3, 3), dtype=bool), 3)
        self.assertAlmostEqual(float(noise[1, 1]), float(np.std([1, 3, 5] * 3)), places=4)
        self.assertEqual(float(sf.local_noise(np.zeros((3, 3), dtype=np.float32), np.zeros((3, 3), dtype=bool), 3)[1, 1]), 0.0)


class ScanFusionAnalyzerTests(ProtocolAssertions):
    """Fusion inside ``BoxAnalyzer``: the fused depth feeds the mask, the blobs, the occupancy, the voxels and the scan."""

    def frame(self, t: float = 2.0, hands: int = 1) -> tuple[db.SyntheticSource, db.DepthFrame]:
        src = synthetic(hands=hands)
        return src, db.DepthFrame(src.render(t), t, src.tracked_hands(t))

    def test_off_is_the_plain_depth_camera_with_hands_still_reported(self) -> None:
        src, frame = self.frame()
        off = make_analyzer(scan_fuse="off").analyze(frame)
        plain = make_analyzer().analyze(db.DepthFrame(frame.depth_mm, frame.timestamp, None))
        self.assertEqual(off.stats["fusedHands"], 0.0)
        self.assertEqual(off.stats["scanModelFraction"], 0.0)
        self.assertEqual(off.stats["pixels"], plain.stats["pixels"])
        for field in ("surface", "voxels", "occupancy"):
            self.assertTrue(np.array_equal(getattr(off, field), getattr(plain, field)), field)
        self.assertEqual([(b.u, b.v, b.w, b.pixels) for b in off.blobs], [(b.u, b.v, b.w, b.pixels) for b in plain.blobs])
        self.assertEqual(len(off.hands), 1, "the skeleton is still reported, it just does not touch the scan")
        self.assertEqual(off.stats["trackedHands"], 1.0)

    def test_fill_adds_the_model_only_where_the_measurement_is_missing_or_disagrees(self) -> None:
        src, frame = self.frame()
        off, fill = make_analyzer(scan_fuse="off").analyze(frame), make_analyzer(scan_fuse="fill").analyze(frame)
        self.assertEqual(fill.stats["fusedHands"], 1.0)
        self.assertEqual(fill.stats["trackedHands"], 1.0)
        self.assertGreater(fill.stats["pixels"], off.stats["pixels"], "the forearm stub and the fingertips poke past the dome's rim")
        self.assertTrue(0.0 < fill.stats["scanModelFraction"] < 0.25, fill.stats)
        self.assertAlmostEqual(fill.stats["scanModelFraction"], (fill.stats["pixels"] - off.stats["pixels"]) / fill.stats["pixels"], delta=0.01, msg="on a measured dome the model only adds, it replaces nothing (everything agrees within 40 mm)")
        assert off.surface is not None and fill.surface is not None and off.occupancy is not None and fill.occupancy is not None
        self.assertTrue(((off.surface > 0) <= (fill.surface > 0)).all(), "every measured cell is still scanned")
        self.assertTrue((fill.occupancy >= off.occupancy).all())
        self.assertEqual(int(fill.surface[fill.surface > 0].min()), int(off.surface[off.surface > 0].min()), "the dome's centre, a measurement that agrees with the model, is kept: the nearest point is unchanged")
        self.assertEqual(len(fill.blobs), 1)
        self.assertAlmostEqual(fill.blobs[0].w, off.blobs[0].w, delta=0.01)
        m = db.frame_message(0, 0.0, fill)
        self.assert_frame(m, (8, 6), (8, 6, 4), (8, 6))
        self.assertEqual(m["stats"]["fusedHands"], 1.0)
        self.assertTrue(0.0 <= m["stats"]["scanModelFraction"] <= 1.0)

    def test_fill_restores_fingers_the_camera_did_not_see(self) -> None:
        """The Leap's failure mode: a saturated hand has no depth, but the skeleton knows where the fingers are."""
        src, frame = self.frame()
        hand = frame.hands[0]  # type: ignore[index]
        palm = hand.joints[db.JOINT_PALM]
        blank = frame.depth_mm.copy()
        blank[: int(palm[1]) - 5, :] = 0  # nothing measured above the palm: the fingers are gone
        blanked = db.DepthFrame(blank, frame.timestamp, frame.hands)
        off, fill = make_analyzer(scan_fuse="off", surface=(320, 240)).analyze(blanked), make_analyzer(scan_fuse="fill", surface=(320, 240)).analyze(blanked)
        self.assertGreater(fill.stats["pixels"], off.stats["pixels"] * 1.3)
        self.assertGreater(fill.stats["scanModelFraction"], 0.25)
        tips = [hand.joints[db.finger_joint(f, 4)] for f in (1, 2)]
        mid = (tips[0] + tips[1]) / 2.0
        model, _ = sf.render_hands([hand], (480, 640), (0, 0), None, 1.25)
        self.assertFalse(np.isfinite(model[int(round(mid[1])), int(round(mid[0]))]), "precondition: the two fingertips are separate tubes with a gap between them")
        assert off.surface is not None and fill.surface is not None

        def cell(p: np.ndarray) -> tuple[int, int]:
            return int((p[1] + 0.5) / 480 * 240), int((p[0] + 0.5) / 640 * 320)

        for tip in tips:
            self.assertEqual(int(off.surface[cell(tip)]), 0, "the camera saw nothing at the tip")
            self.assertGreater(int(fill.surface[cell(tip)]), 0, "the model put the fingertip back")
            self.assertAlmostEqual((int(fill.surface[cell(tip)]) - 1) / 254.0, (tip[2] - NEAR_MM) / (FAR_MM - NEAR_MM), delta=0.02, msg="at the joint's own depth (minus the finger's radius)")
        self.assertEqual(int(fill.surface[cell(mid)]), 0, "and the gap between the fingers stays open: fingers, not a blob")
        self.assertEqual(len(fill.blobs), 1, "the restored fingers join the palm into one blob")

    def test_model_mode_replaces_the_measurement_under_the_model(self) -> None:
        src, frame = self.frame()
        off, fill, model = (make_analyzer(scan_fuse=mode).analyze(frame) for mode in ("off", "fill", "model"))
        self.assertGreater(model.stats["scanModelFraction"], 0.4)
        self.assertEqual(model.stats["pixels"], fill.stats["pixels"], "same footprint as fill: the model only replaces depths")
        assert off.surface is not None and model.surface is not None
        self.assertLess(int(model.surface[model.surface > 0].min()), int(off.surface[off.surface > 0].min()), "the palm's rounded front face is nearer than the dome under it")
        self.assertLess(model.blobs[0].w, off.blobs[0].w)

    def test_near_and_far_bound_the_model_in_the_analyzer(self) -> None:
        depth = backdrop()
        for palm_depth, expect_pixels in ((depth_at(0.5), True), (depth_at(1.2), False), (300.0, False)):
            frame = db.DepthFrame(depth, 0.0, (tracked_hand(palm=(319.5, 239.5, palm_depth)),))
            result = make_analyzer().analyze(frame)
            self.assertEqual(len(result.hands), 1, "within the margin the hand is reported...")
            self.assertEqual(result.stats["fusedHands"], 1.0, "...and rendered")
            if expect_pixels:
                self.assertGreater(result.stats["pixels"], 0)
                self.assertEqual(result.stats["scanModelFraction"], 1.0, "nothing but the model is in the box")
                self.assertEqual(len(result.blobs), 1)
                self.assertAlmostEqual(result.blobs[0].u, 0.5, delta=0.05)
                assert result.surface is not None
                self.assertGreater(int(np.count_nonzero(result.surface)), 0)
            else:
                self.assertEqual(result.stats["pixels"], 0.0, f"a model surface outside the depth range is dropped (palm at {palm_depth} mm)")
                self.assertEqual(result.stats["scanModelFraction"], 0.0)

    def test_roi_offset_puts_the_model_under_the_hand(self) -> None:
        analyzer = db.BoxAnalyzer(db.BoxConfig(near_m=NEAR, far_m=FAR, roi=(0.25, 0.25, 0.75, 0.75)), db.AnalyzerConfig(occupancy=(8, 6), voxels=None, surface=(8, 6), min_pixels=50))
        result = analyzer.analyze(db.DepthFrame(backdrop(), 0.0, (tracked_hand(palm=(319.5, 239.5, float(depth_at(0.3)))),)))
        self.assertEqual(len(result.blobs), 1)
        self.assertAlmostEqual(result.blobs[0].u, result.hands[0].pos[0], delta=0.08, msg="the blob of the rendered model sits on the skeleton's palm")
        self.assertAlmostEqual(result.blobs[0].v, result.hands[0].pos[1], delta=0.1)
        self.assertEqual(result.stats["scanModelFraction"], 1.0)

    def test_focal_length_comes_from_the_source(self) -> None:
        self.assertIsNone(db.source_focal_px(synthetic()))

        class WithView:
            class view:
                fx = 160.0

        class Declared:
            focal_px = 300

        self.assertEqual(db.source_focal_px(WithView()), 160.0)  # type: ignore[arg-type]
        self.assertEqual(db.source_focal_px(Declared()), 300.0)  # type: ignore[arg-type]
        with self.assertRaises(ValueError):
            db.BoxAnalyzer(db.BoxConfig(), db.AnalyzerConfig(), focal_px=0.0)
        frame = db.DepthFrame(backdrop(), 0.0, (tracked_hand(),))
        flat = db.BoxAnalyzer(db.BoxConfig(near_m=NEAR, far_m=FAR), db.AnalyzerConfig(occupancy=None, voxels=None, surface=(64, 48), min_pixels=50)).analyze(frame)
        perspective = db.BoxAnalyzer(db.BoxConfig(near_m=NEAR, far_m=FAR), db.AnalyzerConfig(occupancy=None, voxels=None, surface=(64, 48), min_pixels=50), focal_px=400.0).analyze(frame)
        self.assertEqual(flat.stats["pixels"], perspective.stats["pixels"], "the focal length sizes the relief, not the footprint")
        self.assertNotEqual(flat.blobs[0].w, perspective.blobs[0].w)

    def test_config_validation(self) -> None:
        with self.assertRaises(ValueError):
            db.AnalyzerConfig(scan_fuse="smooth")
        with self.assertRaises(ValueError):
            db.AnalyzerConfig(fuse_tolerance_mm=-1.0)
        self.assertEqual(db.AnalyzerConfig().scan_fuse, db.DEFAULT_SCAN_FUSE)
        self.assertIn(db.DEFAULT_SCAN_FUSE, ("fill", "blend"))
        self.assertEqual(db.AnalyzerConfig(scan_fuse="blend").scan_fuse, "blend")
        self.assertEqual(db.AnalyzerConfig().fuse_tolerance_mm, 40.0)

    def test_blend_beats_fill_on_a_far_noisy_hand_and_keeps_a_clean_one(self) -> None:
        """The far-hand test behind the default: a dome measured like a hand at 45 cm (noise, holes, wrong matches) against its clean truth.

        In the controller's box (100-450 mm) the tube model lies within ~7 mm of
        the dome and ``blend`` is a third more accurate than ``fill`` and three
        times smoother; in the 400-1200 mm box the model is a poorer proxy
        (12 mm off) and ``blend`` is within 15 % of ``fill``'s error while
        still three times smoother. A clean measurement stays the measurement.
        """
        for near_mm, far_mm, closer in ((100.0, 450.0, True), (NEAR_MM, FAR_MM, False)):
            rng = np.random.default_rng(0)
            src = db.SyntheticSource(640, 480, 30.0, near_m=near_mm / 1000.0, far_m=far_mm / 1000.0, hands=1, paced=False)
            raw = src.render(2.0)
            truth = np.where((raw >= near_mm) & (raw <= far_mm), raw, 0).astype(np.float32)
            hands = src.tracked_hands(2.0)
            model, bounds = sf.render_hands(hands, truth.shape, (0, 0), None, sf.isotropic_mm_per_px(near_mm, far_mm, truth.shape[1]))
            region = np.isfinite(model) & (model >= near_mm) & (model <= far_mm) & (truth > 0)
            self.assertGreater(int(region.sum()), 1000)

            def measure(sigma: float, holes: float, spikes: float) -> np.ndarray:
                out = truth + rng.normal(0.0, sigma, truth.shape).astype(np.float32)
                wrong = rng.random(truth.shape) < spikes
                out[wrong] += rng.choice([-90.0, 90.0], size=int(wrong.sum())).astype(np.float32)
                out[rng.random(truth.shape) < holes] = 0.0
                out[truth <= 0] = 0.0
                return np.clip(np.rint(out), 0, 65535).astype(np.uint16)

            def score(measured: np.ndarray, mode: str) -> tuple[float, float, float, float, float]:
                fused, take = sf.fuse_depth(measured, model, mode, 40.0, near_mm, far_mm, bounds)
                v = region & (fused > 0)
                err = np.abs(fused[v].astype(np.float32) - truth[v])
                rough = float(sf.local_noise(fused.astype(np.float32), fused > 0)[region].mean())
                return float(err.mean()), float(np.percentile(err, 90)), float((err > 45.0).mean()), float(take[region].mean()), rough

            far = measure(12.0, 0.25, 0.07)
            off, fill, blend, model_only = score(far, "off"), score(far, "fill"), score(far, "blend"), score(far, "model")
            label = f"box {near_mm:.0f}-{far_mm:.0f}: blend {blend} fill {fill} model {model_only}"
            if closer:
                self.assertLess(blend[0], 0.8 * fill[0], "mean error " + label)
                self.assertLess(blend[1], 0.8 * fill[1], "p90 error " + label)
                self.assertLess(blend[0], model_only[0] + 1.0, "at least as close to the truth as the tube model, which has no dome relief; " + label)
            else:
                self.assertLess(blend[0], 1.15 * fill[0], "mean error " + label)
                self.assertLessEqual(blend[1], fill[1] + 1.0, "p90 error " + label)
            self.assertLess(blend[4], 0.4 * fill[4], "roughness " + label)
            self.assertGreater(off[2], 0.04, "the raw measurement has its wrong pixels")
            self.assertLessEqual(blend[2], fill[2])
            self.assertLess(blend[2], 0.005, "and blend has none left")
            self.assertTrue(0.3 < blend[3] <= 1.0, blend)
            near = measure(2.0, 0.02, 0.0)
            fill_n, blend_n = score(near, "fill"), score(near, "blend")
            self.assertLess(blend_n[0], 2.5, "a clean near measurement stays the measurement")
            self.assertLess(blend_n[3], 0.1, "and hardly any of it counts as model")
            self.assertLess(abs(blend_n[0] - fill_n[0]), 2.0)

    @unittest.skipUnless(db.HAVE_OPENCV, "the Leap synthetic source needs OpenCV")
    def test_leap_synthetic_source_is_fused_too(self) -> None:
        import leap_source  # noqa: PLC0415 - optional, needs OpenCV
        import leap_stereo  # noqa: PLC0415

        view = leap_stereo.RectifiedView.from_fov(320, 240, 90.0)
        src = leap_source.LeapSyntheticSource(view, leap_stereo.StereoParams(min_depth_mm=100.0), paced=False, hand_frame=leap_source.DEFAULT_HAND_FRAME)
        self.assertEqual(db.source_focal_px(src), view.fx)
        frame = src.frame_at(2.0)
        assert frame.hands
        box = db.BoxConfig(near_m=0.1, far_m=0.45)
        results = {}
        for mode in ("off", "fill"):
            analyzer = db.BoxAnalyzer(box, db.AnalyzerConfig(occupancy=(8, 6), voxels=(8, 6, 4), surface=(64, 48), min_pixels=50, scan_fuse=mode), focal_px=db.source_focal_px(src))
            results[mode] = analyzer.analyze(frame)
        off, fill = results["off"], results["fill"]
        self.assertEqual(fill.stats["fusedHands"], 1.0)
        self.assertGreaterEqual(fill.stats["pixels"], off.stats["pixels"])
        self.assertTrue(0.0 < fill.stats["scanModelFraction"] < 0.5, fill.stats)
        hand = frame.hands[0]
        x0, y0, x1, y1 = box.roi_pixels(frame.width, frame.height)
        fused_mm, _ = sf.fuse_depth(frame.depth_mm, *sf.render_hands([hand], frame.depth_mm.shape, (0, 0), view.fx)[:1], "fill", 40.0, box.near_mm, box.far_mm)
        joints = hand.joints
        inside = (joints[:, 0] >= x0) & (joints[:, 0] < x1) & (joints[:, 1] >= y0) & (joints[:, 1] < y1) & (joints[:, 2] >= box.near_mm) & (joints[:, 2] <= box.far_mm)
        u, v = np.rint(joints[inside, 0]).astype(int), np.rint(joints[inside, 1]).astype(int)
        covered = (fused_mm[v, u] >= box.near_mm) & (fused_mm[v, u] <= box.far_mm)
        self.assertGreater(float(covered.mean()), 0.95, "after fusion every joint in the box lies on a foreground pixel")
        m = db.frame_message(0, 0.0, fill)
        self.assert_frame(m, (8, 6), (8, 6, 4), (64, 48))


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
        m = db.hello_message("synthetic", box, 30.0, (8, 6), (8, 6, 4), (16, 12), skeleton=True)
        self.assert_hello(m)
        self.assertEqual(set(m), (HELLO_REQUIRED | HELLO_OPTIONAL) - {"frame"}, "image mode says nothing about the frame")
        self.assertEqual(m["box"], {"x": [-0.5, 0.5], "y": [-0.4, 0.4], "z": [NEAR, FAR]})
        upright = db.hello_message("leap", db.BoxConfig(near_m=0.1, far_m=0.45, frame="upright", box_mm=(620.0, 350.0), box_center_mm=(10.0, -20.0)), 30.0, (8, 6), (8, 6, 4), (16, 12), skeleton=True)
        self.assert_hello(upright)
        self.assertEqual(set(upright), HELLO_REQUIRED | HELLO_OPTIONAL)
        self.assertEqual(upright["frame"], "upright")
        self.assertEqual(upright["box"], {"x": [-0.3, 0.32], "y": [0.1, 0.45], "z": [-0.195, 0.155]}, "metres: across, the height range, the reach")
        self.assertEqual(m["occupancy"], {"width": 8, "height": 6})
        self.assertEqual(m["voxels"], {"nx": 8, "ny": 6, "nz": 4})
        self.assertEqual(m["surface"], {"width": 16, "height": 12})
        self.assertEqual(grid_sizes(m), ((8, 6), (8, 6, 4), (16, 12)))
        bare = db.hello_message("realsense", box, None, None)
        self.assert_hello(bare)
        self.assertEqual(set(bare), HELLO_REQUIRED)
        self.assertEqual(grid_sizes(bare), (None, None, None))

    def test_frame_message_shape_and_json_round_trip(self) -> None:
        src, analyzer = synthetic(), make_analyzer()
        m = db.frame_message(7, 12.5, analyzer.analyze(frame_from(src.render(2.0), 2.0)))
        self.assert_frame(m, (8, 6), (8, 6, 4), (8, 6))
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
        lines = run_dump("--dump", "3", "--occupancy", "8", "6", "--voxels", "8", "6", "4", "--surface", "8", "6")
        self.assertEqual(len(lines), 4)
        hello, frames = lines[0], lines[1:]
        self.assert_hello(hello)
        self.assertEqual(hello["source"], "synthetic")
        self.assertEqual(hello["occupancy"], {"width": 8, "height": 6})
        self.assertEqual(hello["voxels"], {"nx": 8, "ny": 6, "nz": 4})
        self.assertEqual(hello["surface"], {"width": 8, "height": 6})
        self.assertIs(hello["skeleton"], True, "the synthetic source tracks a skeleton")
        for seq, frame in enumerate(frames):
            self.assert_frame(frame, *grid_sizes(hello))
            self.assertEqual(frame["seq"], seq)
            self.assertEqual(len(frame["hands"]), 1, "the script starts with one hand present")  # type: ignore[arg-type]
            hand = frame["hands"][0]  # type: ignore[index]
            self.assertEqual(set(hand), TRACKED_HAND_KEYS)
            self.assertEqual(len(hand["skeleton"]["fingers"]), 5)
            self.assertEqual(frame["stats"]["trackedHands"], 1.0)  # type: ignore[index]
        ts = [f["t"] for f in frames]
        self.assertEqual(ts, sorted(ts))  # type: ignore[type-var]

    def test_dump_payloads_agree_with_the_hand(self) -> None:
        """The voxel peak and the surface's nearest cell sit at the hand's centroid, in the slab / at the depth it reports."""
        lines = run_dump("--dump", "3", "--occupancy", "8", "6", "--voxels", "8", "6", "4", "--surface", "8", "6")
        for frame in lines[1:]:
            hand = frame["hands"][0]  # type: ignore[index]
            u, v, w = hand["pos"]
            vox = base64.b64decode(frame["voxels"])  # type: ignore[arg-type]
            self.assertEqual(len(vox), 8 * 6 * 4)
            peak = max(range(len(vox)), key=vox.__getitem__)
            z, rest = divmod(peak, 8 * 6)
            y, x = divmod(rest, 8)
            self.assertAlmostEqual((x + 0.5) / 8, u, delta=1.5 / 8)
            self.assertAlmostEqual((y + 0.5) / 6, v, delta=1.5 / 6)
            self.assertLessEqual(abs(z - int(w * 4)), 1)
            surf = base64.b64decode(frame["surface"])  # type: ignore[arg-type]
            self.assertEqual(len(surf), 8 * 6)
            lit = [(val, i) for i, val in enumerate(surf) if val]
            self.assertTrue(lit)
            nearest, index = min(lit)
            self.assertAlmostEqual((nearest - 1) / 254, w, delta=0.02)
            self.assertAlmostEqual((index % 8 + 0.5) / 8, u, delta=1.5 / 8)
            self.assertAlmostEqual((index // 8 + 0.5) / 6, v, delta=1.5 / 6)

    def test_dump_default_grids(self) -> None:
        lines = run_dump("--dump", "1")
        self.assert_hello(lines[0])
        self.assertEqual(grid_sizes(lines[0]), ((32, 24), (32, 24, 16), (64, 48)))
        self.assert_frame(lines[1], (32, 24), (32, 24, 16), (64, 48))

    def test_no_occupancy_flag_drops_the_grid_everywhere(self) -> None:
        lines = run_dump("--dump", "2", "--no-occupancy", "--points", "0", "--resolution", "160", "120", "--min-pixels", "20")
        self.assert_hello(lines[0])
        self.assertNotIn("occupancy", lines[0])
        for frame in lines[1:]:
            self.assert_frame(frame, None, (32, 24, 16), (64, 48))
            for hand in frame["hands"]:  # type: ignore[union-attr]
                self.assertEqual(hand["points"], [], "--points 0 applies to tracked hands too")
                self.assertIn("skeleton", hand)

    def test_no_voxels_and_no_surface_flags_drop_those_fields_everywhere(self) -> None:
        lines = run_dump("--dump", "2", "--no-voxels", "--no-surface", "--occupancy", "8", "6", "--resolution", "160", "120", "--min-pixels", "20")
        self.assert_hello(lines[0])
        self.assertEqual(grid_sizes(lines[0]), ((8, 6), None, None))
        for frame in lines[1:]:
            self.assert_frame(frame, (8, 6), None, None)
        lines = run_dump("--dump", "1", "--no-voxels", "--resolution", "160", "120", "--min-pixels", "20")
        self.assertEqual(grid_sizes(lines[0]), ((32, 24), None, (64, 48)))
        self.assert_frame(lines[1], (32, 24), None, (64, 48))

    def test_bad_grid_sizes_are_rejected(self) -> None:
        for flags in (("--voxels", "0", "6", "4"), ("--voxels", "8", "6", "129"), ("--surface", "600", "6")):
            cmd = [sys.executable, os.path.join(HERE, "depth_bridge.py"), "--dump", "1", *flags]
            proc = subprocess.run(cmd, capture_output=True, text=True, timeout=60, check=False)
            self.assertNotEqual(proc.returncode, 0, flags)
            self.assertIn("grid sides must be", proc.stderr)

    def test_bad_geometry_is_rejected(self) -> None:
        cmd = [sys.executable, os.path.join(HERE, "depth_bridge.py"), "--dump", "1", "--near", "1.5", "--far", "1.0"]
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=60, check=False)
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn("near < far", proc.stderr)

    def test_scan_fuse_flag_round_trip(self) -> None:
        small = ("--resolution", "160", "120", "--min-pixels", "20", "--surface", "16", "12")
        stats = {mode: run_dump("--dump", "2", "--scan-fuse", mode, *small)[1]["stats"] for mode in ("off", "fill", "model", "blend")}
        self.assertEqual((stats["off"]["fusedHands"], stats["off"]["scanModelFraction"]), (0.0, 0.0))
        self.assertEqual(stats["fill"]["fusedHands"], 1.0)
        self.assertTrue(0.0 < stats["fill"]["scanModelFraction"] < 0.3, stats["fill"])
        self.assertGreater(stats["model"]["scanModelFraction"], stats["fill"]["scanModelFraction"])
        self.assertEqual(stats["model"]["pixels"], stats["fill"]["pixels"])
        self.assertGreaterEqual(stats["fill"]["pixels"], stats["off"]["pixels"])
        tight = run_dump("--dump", "1", "--fuse-tolerance", "0", *small)[1]["stats"]
        self.assertGreater(tight["scanModelFraction"], stats["fill"]["scanModelFraction"], "a zero tolerance trusts only exact agreement")
        default = run_dump("--dump", "1", *small)[1]["stats"]
        self.assertEqual(default["scanModelFraction"], stats[db.DEFAULT_SCAN_FUSE]["scanModelFraction"], f"{db.DEFAULT_SCAN_FUSE} is the default")
        blend = run_dump("--dump", "2", "--scan-fuse", "blend", *small)[1]["stats"]
        self.assertEqual(blend["fusedHands"], 1.0)
        self.assertTrue(0.0 <= blend["scanModelFraction"] <= stats["model"]["scanModelFraction"], blend)
        self.assertGreaterEqual(blend["pixels"], stats["off"]["pixels"])
        for flags in (("--scan-fuse", "smooth"), ("--fuse-tolerance", "-5")):
            cmd = [sys.executable, os.path.join(HERE, "depth_bridge.py"), "--dump", "1", *flags]
            proc = subprocess.run(cmd, capture_output=True, text=True, timeout=60, check=False)
            self.assertNotEqual(proc.returncode, 0, flags)

    @unittest.skipUnless(os.path.exists(FIXTURE), "fixture not generated")
    def test_checked_in_fixture_matches_the_protocol(self) -> None:
        with open(FIXTURE, encoding="utf-8") as fh:
            lines = [json.loads(line) for line in fh if line.strip()]
        self.assertGreaterEqual(len(lines), 2)
        self.assert_hello(lines[0])
        sizes = grid_sizes(lines[0])
        self.assertEqual(sizes, ((8, 6), (8, 6, 4), (8, 6)), "the fixture is generated with every field on, at small sizes")
        self.assertIs(lines[0].get("skeleton"), True, "the fixture exercises the skeleton path")
        for frame in lines[1:]:
            self.assert_frame(frame, *sizes)
            hands = frame["hands"]
            assert isinstance(hands, list)
            self.assertEqual(len(hands), 1, "the script starts with the hand present")
            self.assertEqual(set(hands[0]), TRACKED_HAND_KEYS)
            self.assertEqual(hands[0]["skeleton"]["palm"], hands[0]["pos"], "pos is the palm")
            stats = frame["stats"]
            assert isinstance(stats, dict)
            self.assertEqual(stats["fusedHands"], 1.0, "the fixture is generated with the default fusion (fill) and carries its stats")
            self.assertTrue(0.0 < stats["scanModelFraction"] < 0.3, stats)


# ---- the upright frame: a camera on the desk looking up -------------------- #

UP_INTRINSICS = (240.0, 240.0, 240.0, 180.0)  # a 480x360 view, 90 degrees across the width: the Leap default
UP_SHAPE = (360, 480)
UP_NEAR, UP_FAR = 0.1, 0.45
UP_W, UP_D = 620.0, 350.0


def upright_box(**kw: object) -> db.BoxConfig:
    cfg: dict[str, object] = {"near_m": UP_NEAR, "far_m": UP_FAR, "frame": "upright", "box_mm": (UP_W, UP_D)}
    cfg.update(kw)
    return db.BoxConfig(**cfg)  # type: ignore[arg-type]


def upright_analyzer(box: db.BoxConfig | None = None, intrinsics: tuple[float, float, float, float] | None = UP_INTRINSICS, **overrides: object) -> db.BoxAnalyzer:
    """Grids of 10 mm cells over the default upright box (62 across, 35 down, 35 deep), fusion off unless asked."""
    cfg: dict[str, object] = {"occupancy": (62, 35), "voxels": (62, 35, 35), "surface": (62, 35), "front_wcells": 35, "min_pixels": 50, "max_hands": 2, "scan_fuse": "off"}
    cfg.update(overrides)
    return db.BoxAnalyzer(box or upright_box(), db.AnalyzerConfig(**cfg), intrinsics=intrinsics)  # type: ignore[arg-type]


def plate(geometry: db.UprightGeometry, x_mm: tuple[float, float], v_mm: tuple[float, float], height_mm: float, shape: tuple[int, int] = UP_SHAPE) -> np.ndarray:
    """A flat plate ``height_mm`` above the camera covering metric ``x_mm`` across and ``v_mm`` down, as the pinhole sees it: uint16 mm, 0 elsewhere."""
    h, w = shape
    x_of_col, _, _ = geometry.metric_from_pixels(np.arange(w), 0.0, height_mm)
    _, v_of_row, _ = geometry.metric_from_pixels(0.0, np.arange(h), height_mm)
    cols = (x_of_col >= x_mm[0]) & (x_of_col <= x_mm[1])
    rows = (v_of_row >= v_mm[0]) & (v_of_row <= v_mm[1])
    image = np.zeros(shape, dtype=np.uint16)
    image[np.ix_(rows, cols)] = int(round(height_mm))
    return image


def plate_units(geometry: db.UprightGeometry, image: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Box units ``(u, v, w)`` of every non-zero pixel of ``image``."""
    ys, xs = np.nonzero(image)
    return geometry.unit_from_pixels(xs, ys, image[ys, xs])


class UprightGeometryTests(unittest.TestCase):
    def setUp(self) -> None:
        self.geo = db.UprightGeometry(UP_INTRINSICS, upright_box())

    def test_metric_round_trip(self) -> None:
        rng = np.random.default_rng(1)
        cols, rows, depth = rng.uniform(-10, 490, 200), rng.uniform(-10, 370, 200), rng.uniform(100, 450, 200)
        x, v, y = self.geo.metric_from_pixels(cols, rows, depth)
        c2, r2, d2 = self.geo.pixels_from_metric(x, v, y)
        self.assertTrue(np.allclose(c2, cols) and np.allclose(r2, rows) and np.allclose(d2, depth))
        u, down, w = self.geo.unit_from_metric(x, v, y)
        x2, v2, y2 = self.geo.metric_from_unit(u, down, w)
        self.assertTrue(np.allclose(x2, x) and np.allclose(v2, v) and np.allclose(y2, y))
        for height in (150.0, 275.0, 440.0):  # the pixel under the optical axis is the box's lateral centre at any height
            u, down, w = self.geo.unit_from_pixels(240.0 - 0.5, 180.0 - 0.5, height)
            self.assertAlmostEqual(float(u), 0.5)
            self.assertAlmostEqual(float(w), 0.5)
            self.assertAlmostEqual(float(down), 1.0 - (height - 100.0) / 350.0)
        # 100 px right of the axis is 100 mm across at 240 mm of height and 200 mm at 480: the units follow the millimetres
        self.assertAlmostEqual(float(self.geo.unit_from_pixels(339.5, 179.5, 240.0)[0]), 0.5 + 100.0 / UP_W)
        self.assertAlmostEqual(float(self.geo.unit_from_pixels(339.5, 179.5, 480.0)[0]), 0.5 + 200.0 / UP_W)

    def test_box_centre_and_reach_sign(self) -> None:
        shifted = db.UprightGeometry(UP_INTRINSICS, upright_box(box_center_mm=(100.0, -50.0)))
        u, _, w = shifted.unit_from_metric(0.0, 0.0, 200.0)
        self.assertAlmostEqual(float(u), (0.0 - (100.0 - 310.0)) / UP_W)
        self.assertAlmostEqual(float(w), (0.0 - (-50.0 - 175.0)) / UP_D)
        self.assertEqual(shifted.box.x_range_mm, (-210.0, 410.0))
        self.assertEqual(shifted.box.z_range_mm, (-225.0, 125.0))
        flipped = db.UprightGeometry(UP_INTRINSICS, upright_box(reach_sign=-1))
        for side in (-100.0, 0.0, 60.0):
            self.assertAlmostEqual(float(flipped.unit_from_metric(0.0, side, 200.0)[2]), 1.0 - float(self.geo.unit_from_metric(0.0, side, 200.0)[2]))

    def test_widths_are_metric(self) -> None:
        self.assertAlmostEqual(float(self.geo.width_to_u(24.0, 240.0)), 24.0 / UP_W, msg="24 px at 240 mm is 24 mm")
        self.assertAlmostEqual(float(self.geo.width_to_u(12.0, 480.0)), 24.0 / UP_W, msg="12 px at 480 mm is the same 24 mm")

    def test_validation_and_the_intrinsics_requirement(self) -> None:
        with self.assertRaises(ValueError):
            db.BoxConfig(frame="sideways")
        with self.assertRaises(ValueError):
            upright_box(box_mm=(0.0, 350.0))
        with self.assertRaises(ValueError):
            upright_box(reach_sign=2)
        with self.assertRaises(ValueError):
            db.AnalyzerConfig(slab_mm=-1.0)
        with self.assertRaises(ValueError):
            db.AnalyzerConfig(front_wcells=0)
        with self.assertRaises(ValueError):
            db.UprightGeometry((0.0, 240.0, 240.0, 180.0), upright_box())
        with self.assertRaises(ValueError):
            db.UprightGeometry(UP_INTRINSICS, db.BoxConfig())
        with self.assertRaisesRegex(ValueError, "intrinsics"):
            db.BoxAnalyzer(upright_box(), db.AnalyzerConfig(), intrinsics=None)
        db.BoxAnalyzer(db.BoxConfig(), db.AnalyzerConfig(), intrinsics=None)  # image mode never needs them

        class Bare(db.FrameSource):
            name = "bare"

            def read(self) -> db.DepthFrame:  # pragma: no cover
                raise NotImplementedError

        self.assertIsNone(db.resolve_intrinsics(Bare(), "image"))
        with self.assertRaisesRegex(SystemExit, "intrinsics"):
            db.resolve_intrinsics(Bare(), "upright")
        src = synthetic()
        self.assertTrue(np.allclose(db.resolve_intrinsics(src, "upright"), (320.0, 320.0, 320.0, 240.0)), "90 degrees across a 640 px width")  # type: ignore[arg-type]
        self.assertIsNone(db.resolve_intrinsics(src, "image"))

    def test_tracked_hand_goes_through_the_metric_box(self) -> None:
        depth = 275.0
        hand = tracked_hand(palm=(239.5, 179.5, depth), spread_px=40.0)
        skel = db.normalize_tracked_hand(hand, (0, 0, 480, 360), 100.0, 450.0, upright=self.geo)
        self.assertTrue(np.allclose(skel.pos, (0.5, 0.5, 0.5)), "the palm on the optical axis, halfway up the height range")
        wrist = skel.joints[db.JOINT_WRIST]  # spread_px image-down at depth + 5: 40 px at 280 mm = 46.7 mm of reach
        self.assertAlmostEqual(float(wrist[2]), 0.5 + 40.0 * 280.0 / 240.0 / UP_D)
        self.assertAlmostEqual(float(wrist[1]), 1.0 - (280.0 - 100.0) / UP_D)
        self.assertAlmostEqual(float(skel.widths[db.WIDTH_PALM]), 80.0 * depth / 240.0 / UP_W, msg="widths are millimetres at their part's depth over the box width")
        self.assertAlmostEqual(float(skel.widths[db.WIDTH_ARM]), 50.0 * 280.0 / 240.0 / UP_W)
        self.assertAlmostEqual(float(skel.widths[db.WIDTH_FINGERS + 1]), 16.0 * float(hand.finger(1)[:, 2].mean()) / 240.0 / UP_W)
        # the same hand lifted 100 mm straight up: its pixels move toward the centre, its u and w do not
        x, v, y = self.geo.metric_from_pixels(hand.joints[:, 0], hand.joints[:, 1], hand.joints[:, 2])
        cols, rows, ys = self.geo.pixels_from_metric(x, v, y + 100.0)
        lifted = db.TrackedHand(hand.id, hand.type, np.column_stack([cols, rows, ys]), hand.widths_px * hand.joints[0, 2] / ys[0], hand.extended)
        up = db.normalize_tracked_hand(lifted, (0, 0, 480, 360), 100.0, 450.0, upright=self.geo)
        self.assertTrue(np.allclose(up.joints[:, [0, 2]], skel.joints[:, [0, 2]]))
        self.assertTrue(np.allclose(up.joints[:, 1], skel.joints[:, 1] - 100.0 / UP_D))
        self.assertAlmostEqual(float(up.widths[db.WIDTH_PALM]), float(skel.widths[db.WIDTH_PALM]))


class FrontViewTests(ProtocolAssertions):
    """The upright scan is a height field over the FRONT of the metric box, holding the nearest reach of the solid hand."""

    def setUp(self) -> None:
        self.box = upright_box()
        self.geo = db.UprightGeometry(UP_INTRINSICS, self.box)

    def plate_frame(self, x_mm: tuple[float, float], v_mm: tuple[float, float], height_mm: float) -> db.DepthFrame:
        return frame_from(plate(self.geo, x_mm, v_mm, height_mm))

    def test_flat_plate_is_rows_of_its_thickness_at_its_nearest_edge(self) -> None:
        height, slab = 255.0, 30.0
        frame = self.plate_frame((-100.0, 0.0), (20.0, 80.0), height)
        result = upright_analyzer(slab_mm=slab).analyze(frame)
        surface = result.surface
        assert surface is not None
        self.assertEqual(surface.shape, (35, 62))
        lit = surface > 0
        rows, cols = np.flatnonzero(lit.any(axis=1)), np.flatnonzero(lit.any(axis=0))
        row_bottom = math.floor((1.0 - (height - 100.0) / UP_D) * 35)       # the underside's row
        row_top = math.floor((1.0 - (height + slab - 100.0) / UP_D) * 35)   # the top of the extruded solid
        self.assertEqual(rows.tolist(), list(range(row_top, row_bottom + 1)), "rows spanning [h, h + slab]")
        u, v, w = plate_units(self.geo, frame.depth_mm)
        self.assertEqual(cols.tolist(), sorted(set(np.floor(u * 62).astype(int).tolist())), "the columns the plate's metric points fall in")
        self.assertTrue(lit[np.ix_(rows, cols)].all(), "a rectangle")
        self.assertEqual(int(lit.sum()), rows.size * cols.size)
        nearest = surface_byte(float(w.min()))
        self.assertTrue((surface[lit] == nearest).all(), "every cell reports the plate's nearest edge, its smallest reach")
        self.assertAlmostEqual((nearest - 1) / 254.0, (20.0 + UP_D / 2.0) / UP_D, delta=0.01)
        self.assertEqual(len(result.blobs), 1)
        blob = result.blobs[0]  # the solid's centroid (the underside raised by half the slab), nearest reach, an extent spanning the slab
        self.assertAlmostEqual(blob.u, float(u.mean()))
        self.assertAlmostEqual(blob.v, float(v.mean()) - 0.5 * slab / UP_D)
        self.assertAlmostEqual(blob.w, float(np.percentile(w, 10.0)))
        self.assertAlmostEqual(blob.extent[0][1], float(v.min()) - slab / UP_D)
        self.assertAlmostEqual(blob.extent[1][1], float(v.max()))
        self.assertAlmostEqual(blob.extent[1][2], float(np.percentile(w, 90.0)))
        self.assertEqual(result.stats["pixels"], float(np.count_nonzero(frame.depth_mm)))
        self.assertEqual((result.stats["blobs"], result.stats["fusedHands"], result.stats["scanModelFraction"]), (1.0, 0.0, 0.0))
        self.assert_frame(db.frame_message(0, 0.0, result), (62, 35), (62, 35, 35), (62, 35))

    def test_the_box_drops_what_is_outside_it_laterally(self) -> None:
        wide = self.plate_frame((-400.0, 400.0), (-60.0, 60.0), 400.0)  # the whole image width at 400 mm: wider than the 620 mm box on both sides
        result = upright_analyzer().analyze(wide)
        u, _, _ = plate_units(self.geo, wide.depth_mm)
        self.assertLess(result.stats["pixels"], float(np.count_nonzero(wide.depth_mm)))
        self.assertEqual(result.stats["pixels"], float(np.count_nonzero((u >= 0.0) & (u <= 1.0))))
        lit = result.surface > 0  # type: ignore[operator]
        self.assertTrue(lit[:, 0].any() and lit[:, -1].any(), "the plate fills the box edge to edge")
        blob = result.blobs[0]
        self.assertGreaterEqual(blob.extent[0][0], 0.0)
        self.assertLessEqual(blob.extent[1][0], 1.0)

    def test_lifting_the_hand_does_not_move_it_sideways(self) -> None:
        low = upright_analyzer().analyze(self.plate_frame((-55.0, 55.0), (-40.0, 40.0), 150.0))
        high = upright_analyzer().analyze(self.plate_frame((-55.0, 55.0), (-40.0, 40.0), 400.0))
        self.assertGreater(low.stats["pixels"], 5 * high.stats["pixels"], "the plate's image footprint shrinks with height: a frustum")
        a, b = low.blobs[0], high.blobs[0]
        self.assertAlmostEqual(a.u, b.u, delta=0.005, msg="no drift toward the centre")
        self.assertAlmostEqual(a.w, b.w, delta=0.01)
        for axis in (0, 2):
            self.assertAlmostEqual(a.extent[0][axis], b.extent[0][axis], delta=0.01)
            self.assertAlmostEqual(a.extent[1][axis], b.extent[1][axis], delta=0.01)
        self.assertAlmostEqual(b.v, a.v - 250.0 / UP_D, delta=0.01, msg="only the height moved")
        lit_low, lit_high = low.surface > 0, high.surface > 0  # type: ignore[operator]
        self.assertEqual(np.flatnonzero(lit_low.any(axis=0)).tolist(), np.flatnonzero(lit_high.any(axis=0)).tolist(), "the same columns")
        self.assertLess(float(np.flatnonzero(lit_high.any(axis=1)).mean()), float(np.flatnonzero(lit_low.any(axis=1)).mean()), "higher is nearer the top")
        self.assertLessEqual(abs(int(low.surface[lit_low].min()) - int(high.surface[lit_high].min())), 1, "the same nearest reach")  # type: ignore[index]

    def test_reach_sign_flips_w(self) -> None:
        image = plate(self.geo, (-55.0, 55.0), (10.0, 90.0), 250.0)
        plus = upright_analyzer().analyze(frame_from(image))
        minus = upright_analyzer(upright_box(reach_sign=-1)).analyze(frame_from(image))
        a, b = plus.blobs[0], minus.blobs[0]
        self.assertAlmostEqual(a.u, b.u)
        self.assertAlmostEqual(a.v, b.v)
        self.assertAlmostEqual(b.w, 1.0 - a.extent[1][2], places=5, msg="the nearest tenth of 1 - w is 1 - the farthest tenth of w")
        self.assertAlmostEqual(b.extent[1][2], 1.0 - a.w, places=5)
        near_plus = (int(plus.surface[plus.surface > 0].min()) - 1) / 254.0  # type: ignore[index]
        near_minus = (int(minus.surface[minus.surface > 0].min()) - 1) / 254.0  # type: ignore[index]
        self.assertAlmostEqual(near_plus, (10.0 + 175.0) / UP_D, delta=0.01)
        self.assertAlmostEqual(near_minus, 1.0 - (90.0 + 175.0) / UP_D, delta=0.01, msg="the far edge became the near one")

    def test_skeleton_is_rendered_from_the_front(self) -> None:
        depth = 275.0
        hand = tracked_hand(palm=(239.5, 179.5, depth), spread_px=40.0)
        blank = db.DepthFrame(np.zeros(UP_SHAPE, dtype=np.uint16), 0.0, (hand,))
        result = upright_analyzer(scan_fuse="model").analyze(blank)
        self.assertEqual(len(result.hands), 1)
        skel = result.hands[0]
        self.assertEqual((result.stats["pixels"], result.stats["fusedHands"], result.stats["scanModelFraction"]), (0.0, 1.0, 1.0), "nothing measured: the scan is all model")
        surface = result.surface
        assert surface is not None
        lit = surface > 0
        self.assertGreater(int(lit.sum()), 20)
        rows, cols = np.nonzero(lit)
        lo, hi = skel.extent
        pad_u = float(skel.widths[db.WIDTH_PALM])  # the widest part, a diameter in u units; rows are UP_D / UP_W as fine
        pad_v = pad_u * UP_W / UP_D
        self.assertGreaterEqual(cols.min() / 62.0, lo[0] - pad_u)
        self.assertLessEqual((cols.max() + 1) / 62.0, hi[0] + pad_u)
        self.assertGreaterEqual(rows.min() / 35.0, lo[1] - pad_v)
        self.assertLessEqual((rows.max() + 1) / 35.0, hi[1] + pad_v)
        pu, pv, pw = skel.pos
        cell = int(surface[int(pv * 35), int(pu * 62)])
        self.assertGreater(cell, 0, "the palm's cell is lit")
        # This hand lies flat in the image, so from the front it is a thin band and the nearest part in the palm's column is the
        # knuckle bar (index-mcp -> pinky-mcp, 16 px nearer the display), a slab whose front face is its reach minus the palm relief.
        knuckles = 0.5 * (skel.joints[db.finger_joint(1, 1)] + skel.joints[db.finger_joint(4, 1)])
        self.assertLess((cell - 1) / 254.0, pw, "in front of the palm point")
        self.assertAlmostEqual((cell - 1) / 254.0, float(knuckles[2]) - 0.15 * pad_u * UP_W / UP_D, delta=0.015)
        tip = skel.joints[db.finger_joint(2, 4)]  # the middle fingertip: lit within a cell of it, and the nearest thing in the scan is a fingertip's front
        r, c = int(tip[1] * 35), int(tip[0] * 62)
        self.assertTrue(lit[max(r - 1, 0):r + 2, max(c - 1, 0):c + 2].any())
        tip_relief = 0.8 * float(skel.widths[db.WIDTH_FINGERS + 2]) / 2.0 * UP_W / UP_D
        self.assertAlmostEqual((int(surface[lit].min()) - 1) / 254.0, float(lo[2]) - tip_relief, delta=0.012)
        voxels, occupancy = result.voxels, result.occupancy
        assert voxels is not None and occupancy is not None
        self.assertTrue(np.array_equal(voxels.any(axis=0), lit) and np.array_equal(occupancy == 255, lit), "the voxels and the occupancy are the same solid")
        for r, c in zip(rows[::7], cols[::7]):
            first = int(np.flatnonzero(voxels[:, r, c])[0])
            self.assertLessEqual(abs(first - int((surface[r, c] - 1) / 254.0 * 35)), 1, "the first filled slab holds the front face")
        # fill: a measured plate under the palm is kept where it agrees and the model adds the rest
        image = plate(self.geo, (-30.0, 30.0), (-20.0, 20.0), 262.0)
        off = upright_analyzer(scan_fuse="off").analyze(db.DepthFrame(image, 0.0, (hand,)))
        fill = upright_analyzer(scan_fuse="fill").analyze(db.DepthFrame(image, 0.0, (hand,)))
        model = upright_analyzer(scan_fuse="model").analyze(db.DepthFrame(image, 0.0, (hand,)))
        self.assertEqual(off.stats["fusedHands"], 0.0)
        self.assertEqual(len(off.hands), 1, "the skeleton is still reported without fusion")
        self.assertTrue(0.0 < fill.stats["scanModelFraction"] < 1.0, fill.stats)
        self.assertGreater(model.stats["scanModelFraction"], fill.stats["scanModelFraction"])
        lit_off, lit_fill, lit_model = off.surface > 0, fill.surface > 0, model.surface > 0  # type: ignore[operator]
        self.assertTrue((lit_fill | lit_off).sum() == lit_fill.sum(), "fill only adds")
        self.assertTrue(np.array_equal(lit_fill, lit_model), "both modes cover the union of the measurement and the model")
        self.assert_frame(db.frame_message(0, 0.0, fill), (62, 35), (62, 35, 35), (62, 35))

    def test_voxels_and_occupancy_come_from_the_same_solid(self) -> None:
        frame = self.plate_frame((-100.0, 0.0), (20.0, 80.0), 255.0)
        result = upright_analyzer().analyze(frame)  # one voxel per front-view cell
        surface, voxels, occupancy = result.surface, result.voxels, result.occupancy
        assert surface is not None and voxels is not None and occupancy is not None
        self.assertEqual(voxels.shape, (35, 35, 62))
        self.assertEqual(occupancy.shape, (35, 62))
        lit = surface > 0
        self.assertTrue(np.array_equal(occupancy == 255, lit), "the occupancy is the front view's coverage")
        self.assertTrue(np.array_equal(voxels.any(axis=0), lit), "a voxel column is filled exactly under a scanned cell")
        _, _, w = plate_units(self.geo, frame.depth_mm)
        first, last = int(w.min() * 35), int(w.max() * 35)
        for r, c in zip(*np.nonzero(lit)):
            self.assertEqual(np.flatnonzero(voxels[:, r, c]).tolist(), list(range(first, last + 1)), f"({r}, {c}): the plate's reach cells")
            self.assertEqual(int((surface[r, c] - 1) / 254.0 * 35), first, "the scan's reach is the first filled slab")
        self.assertTrue((voxels[first:last + 1][:, lit] == 255).all(), "full cells")
        coarse = upright_analyzer(voxels=(8, 6, 4), occupancy=(8, 6)).analyze(frame)
        assert coarse.voxels is not None and coarse.occupancy is not None
        self.assertEqual(coarse.voxels.shape, (4, 6, 8))
        self.assertTrue(np.array_equal(coarse.voxels.any(axis=0), coarse.occupancy > 0))
        peak = int(np.argmax(coarse.voxels))
        z, rest = divmod(peak, 8 * 6)
        y, x = divmod(rest, 8)
        blob = result.blobs[0]
        self.assertEqual((x, y), (int(blob.u * 8), int(blob.v * 6)), "the densest voxel is under the blob")
        self.assertLessEqual(abs(z - int(blob.w * 4)), 1)
        none = upright_analyzer(voxels=None, occupancy=None, surface=None).analyze(frame)
        self.assertTrue(none.voxels is None and none.occupancy is None and none.surface is None)
        self.assertEqual(len(none.blobs), 1, "blobs do not need the front view")
        only_voxels = upright_analyzer(surface=None).analyze(frame)
        assert only_voxels.voxels is not None
        self.assertEqual(only_voxels.voxels.shape, (35, 35, 62), "the front view is still computed, at the default working grid")

    def test_front_view_render_stays_within_budget(self) -> None:
        image = plate(self.geo, (-100.0, 100.0), (-75.0, 75.0), 250.0)  # 200 x 150 mm at 250 mm: about 27 600 points
        ys, xs = np.nonzero(image)
        self.assertGreater(ys.size, 25000)
        u, _, w = self.geo.unit_from_pixels(xs, ys, image[ys, xs])
        height = image[ys, xs]
        best = min(_timed(lambda: db.render_front_view(u, w, height, 100.0, 450.0, UP_D, 30.0, 120, 160, 48)) for _ in range(20))
        self.assertLess(best, 0.015, f"the front view of {ys.size} points at 160x120x48 took {best * 1000:.2f} ms (a desktop does it in about 4 ms; the budget is 6)")
        analyzer = db.BoxAnalyzer(self.box, db.AnalyzerConfig(occupancy=(32, 24), voxels=(32, 24, 16), surface=(160, 120), min_pixels=150, scan_fuse="off"), intrinsics=UP_INTRINSICS)
        frame = frame_from(image)
        whole = min(_timed(lambda: analyzer.analyze(frame)) for _ in range(10))
        self.assertLess(whole, 0.050, f"the whole upright pass at 480x360 took {whole * 1000:.2f} ms")

    def test_leap_synthetic_source_in_the_upright_frame(self) -> None:
        import leap_source  # noqa: PLC0415 - optional, needs OpenCV
        import leap_stereo  # noqa: PLC0415

        view = leap_stereo.RectifiedView.from_fov(320, 240, 90.0)
        src = leap_source.LeapSyntheticSource(view, leap_stereo.StereoParams(min_depth_mm=100.0), paced=False, hand_frame=leap_source.DEFAULT_HAND_FRAME)
        self.assertTrue(np.allclose(src.intrinsics, (160.0, 160.0, 160.0, 120.0)))
        frame = src.frame_at(2.0)
        assert frame.hands
        box = db.BoxConfig(near_m=0.1, far_m=0.45, frame="upright", box_mm=(1000.0, 1000.0))
        analyzer = db.BoxAnalyzer(box, db.AnalyzerConfig(occupancy=(8, 6), voxels=(8, 6, 4), surface=(64, 48), min_pixels=50), focal_px=db.source_focal_px(src), intrinsics=src.intrinsics)
        result = analyzer.analyze(frame)
        self.assertEqual(len(result.hands), 1)
        self.assertEqual(result.stats["fusedHands"], 1.0)
        self.assertGreater(result.stats["pixels"], 0.0)
        self.assertTrue(0.0 < result.stats["scanModelFraction"] < 1.0, result.stats)
        assert result.surface is not None
        pu, pv, _ = result.hands[0].pos
        r, c = int(pv * 48), int(pu * 64)
        self.assertTrue((result.surface[max(r - 2, 0):r + 3, max(c - 2, 0):c + 3] > 0).any(), "the scan and the skeleton share the front view")
        self.assert_frame(db.frame_message(0, 0.0, result), (8, 6), (8, 6, 4), (64, 48))


class FuseFrontTests(unittest.TestCase):
    """``scan_fusion.fuse_front``: the fusion rules over two front views (reach in mm, inf = nothing)."""

    def scene(self) -> tuple[np.ndarray, np.ndarray]:
        measured = np.full((3, 6), np.inf, dtype=np.float32)
        model = np.full((3, 6), np.inf, dtype=np.float32)
        measured[:, 0], model[:, 0] = 120.0, 140.0    # a measurement that agrees with the model (20 mm)
        model[:, 1] = 90.0                            # nothing measured under the model
        measured[:, 2], model[:, 2] = 50.0, 150.0     # a measurement that disagrees
        measured[:, 3] = 200.0                        # a measurement outside the model
        measured[:, 4], model[:, 4] = 210.0, -5.0     # a model face in front of the box: no model there
        model[:, 5] = 360.0                           # a model face past the back of a 350 mm box: no model there
        return measured, model

    def test_fill_takes_the_model_where_the_measurement_is_missing_or_disagrees(self) -> None:
        measured, model = self.scene()
        fused, take = sf.fuse_front(measured, model, "fill", 40.0, 350.0)
        self.assertEqual(fused[0].tolist(), [120.0, 90.0, 150.0, 200.0, 210.0, math.inf])
        self.assertEqual(take[0].tolist(), [False, True, True, False, False, False])
        self.assertEqual(fused.dtype, np.float32)

    def test_model_mode_takes_the_model_wherever_it_counts(self) -> None:
        measured, model = self.scene()
        fused, take = sf.fuse_front(measured, model, "model", 40.0, 350.0)
        self.assertEqual(fused[0].tolist(), [140.0, 90.0, 150.0, 200.0, 210.0, math.inf])
        self.assertEqual(take[0].tolist(), [True, True, True, False, False, False])

    def test_off_and_the_tolerance(self) -> None:
        measured, model = self.scene()
        fused, take = sf.fuse_front(measured, model, "off", 40.0, 350.0)
        self.assertIs(fused, measured)
        self.assertFalse(take.any())
        self.assertFalse(sf.fuse_front(measured, model, "fill", 20.0, 350.0)[1][0, 0], "20 mm apart with a 20 mm tolerance: kept (inclusive)")
        self.assertTrue(sf.fuse_front(measured, model, "fill", 19.0, 350.0)[1][0, 0])
        with self.assertRaises(ValueError):
            sf.fuse_front(measured, model, "smooth", 40.0, 350.0)
        with self.assertRaises(ValueError):
            sf.fuse_front(measured, model[:, :5], "fill", 40.0, 350.0)
        with self.assertRaises(ValueError):
            sf.fuse_front(measured, model, "fill", -1.0, 350.0)

    def test_blend_smooths_and_mixes_by_noise_and_height(self) -> None:
        rng = np.random.default_rng(0)
        rows, cols = 40, 40
        model = np.full((rows, cols), 150.0, dtype=np.float32)
        model[:, 34:] = np.inf
        quiet = np.clip(140.0 + rng.normal(0.0, 1.0, (rows, cols)), 1.0, 349.0).astype(np.float32)
        quiet[10:14, 10:14] = np.inf                       # nothing measured
        quiet[20:26, 20:26] = 40.0                         # 110 mm off the model
        fused, take = sf.fuse_front(quiet, model, "blend", 40.0, 350.0)
        self.assertEqual(fused.dtype, np.float32)
        self.assertLess(float(np.abs(fused[2:8, 2:8] - quiet[2:8, 2:8]).mean()), 1.5, "a quiet measurement stays (no height given: noise alone decides)")
        self.assertFalse(take[2:8, 2:8].any())
        self.assertTrue(np.isfinite(fused[11:13, 11:13]).all() and take[11:13, 11:13].all(), "the gap is filled")
        self.assertTrue((fused[22:24, 22:24] == 150.0).all() and take[22:24, 22:24].all(), "the disagreement is replaced")
        self.assertTrue(np.array_equal(fused[:, 34:], quiet[:, 34:]), "outside the model nothing changes")
        noisy = np.clip(140.0 + rng.normal(0.0, 25.0, (rows, cols)), 1.0, 349.0).astype(np.float32)
        fused_n, take_n = sf.fuse_front(noisy, model, "blend", 80.0, 350.0)
        self.assertLess(float(fused_n[2:8, 2:8].std()), 0.5 * float(noisy[2:8, 2:8].std()), "a noisy measurement reads smooth")
        self.assertTrue(take_n[2:8, 2:8].mean() > 0.9)
        # With the height range the rows near the top of the box (far from the device) lean on the model even when quiet.
        fused_h, take_h = sf.fuse_front(quiet, model, "blend", 40.0, 350.0, height_range_mm=(100.0, 700.0))  # the ramp runs 520 -> 700 mm
        self.assertTrue(np.allclose(fused_h[0:2, 2:8], 150.0, atol=1.5), "rows 0-1 are 690 mm up (weight 0.9+): the model")
        self.assertTrue(take_h[0:4, 2:8].all())
        self.assertLess(float(np.abs(fused_h[36:39, 2:8] - quiet[36:39, 2:8]).mean()), 1.5, "row 37 is 140 mm up: the measurement")
        self.assertFalse(take_h[36:39, 2:8].any())


class UprightDumpTests(ProtocolAssertions):
    def test_upright_dump_matches_the_protocol(self) -> None:
        lines = run_dump("--dump", "3", "--frame", "upright", "--occupancy", "8", "6", "--voxels", "8", "6", "4", "--surface", "8", "6")
        hello, frames = lines[0], lines[1:]
        self.assert_hello(hello)
        self.assertEqual(hello["frame"], "upright")
        self.assertEqual(hello["box"], {"x": [-0.31, 0.31], "y": [0.4, 1.2], "z": [-0.175, 0.175]}, "the metric box in metres: across, height range, reach")
        self.assertIs(hello["skeleton"], True)
        for seq, frame in enumerate(frames):
            self.assert_frame(frame, *grid_sizes(hello))
            self.assertEqual(frame["seq"], seq)
            hands = frame["hands"]
            assert isinstance(hands, list)
            self.assertEqual(len(hands), 1, "the script starts with the hand present, at the centre of the box")
            self.assertEqual(set(hands[0]), TRACKED_HAND_KEYS)
            self.assertEqual(hands[0]["skeleton"]["palm"], hands[0]["pos"])
            _, v, _ = hands[0]["pos"]
            self.assertAlmostEqual(v, 0.75, delta=0.03, msg="600 mm up in a 400-1200 mm height range")
            stats = frame["stats"]
            assert isinstance(stats, dict)
            self.assertEqual((stats["trackedHands"], stats["fusedHands"]), (1.0, 1.0))
            # At 8x6 cells over 620 x 800 mm the whole hand is one row, where the dome's front edge and the fingertips agree: fill adds nothing.
            self.assertTrue(0.0 <= stats["scanModelFraction"] < 1.0, stats)
            self.assertGreater(stats["pixels"], 0.0)
        for frame in frames:
            db.encode_message(frame)  # finite everywhere
        model = run_dump("--dump", "1", "--frame", "upright", "--scan-fuse", "model", "--occupancy", "8", "6", "--voxels", "8", "6", "4", "--surface", "8", "6")[1]
        self.assertTrue(0.0 < model["stats"]["scanModelFraction"] <= 1.0, model["stats"])  # type: ignore[index]
        image = run_dump("--dump", "1")[0]
        self.assertNotIn("frame", image, "image mode is the default and says nothing")
        self.assertEqual(image["box"], {"x": [-0.5, 0.5], "y": [-0.4, 0.4], "z": [0.4, 1.2]})

    def test_upright_flags_round_trip_and_bad_values_are_rejected(self) -> None:
        small = ("--resolution", "160", "120", "--min-pixels", "20", "--surface", "16", "12")
        hello = run_dump("--dump", "1", "--frame", "upright", "--box-mm", "800", "400", "--box-center", "50", "-20", "--near", "0.3", "--far", "0.9",
                         "--reach-sign", "-1", "--slab-mm", "12", "--front-wcells", "16", *small)[0]
        self.assert_hello(hello)
        self.assertEqual(hello["box"], {"x": [-0.35, 0.45], "y": [0.3, 0.9], "z": [-0.22, 0.18]})
        for flags in (("--box-mm", "0", "350"), ("--reach-sign", "2"), ("--slab-mm", "-3"), ("--front-wcells", "0"), ("--frame", "sideways")):
            cmd = [sys.executable, os.path.join(HERE, "depth_bridge.py"), "--dump", "1", "--frame", "upright", *flags]
            proc = subprocess.run(cmd, capture_output=True, text=True, timeout=60, check=False)
            self.assertNotEqual(proc.returncode, 0, flags)


if __name__ == "__main__":
    unittest.main(verbosity=2)
