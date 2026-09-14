#!/usr/bin/env python3
"""Tests for ``leap_stereo.py`` and the hardware-free half of ``leap_source.py``.

Plain ``unittest``, no hardware, no LeapC::

    python bridge/test_leap_stereo.py

The stereo maths is checked against a ray-cast scene whose depth is known
analytically: spheres above the device rendered into both cameras, either
straight into the rectified pinhole model (pure matcher accuracy) or through
the fisheye stand-in for the raw cameras (rectifier + matcher), then through
``BoxAnalyzer`` so the box filtering and the surface scan are covered too.
"""
from __future__ import annotations

import base64
import contextlib
import ctypes as C
import io
import json
import os
import subprocess
import sys
import tempfile
import threading
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

import numpy as np  # noqa: E402

import depth_bridge as db  # noqa: E402
import leap_source as lsrc  # noqa: E402
import leap_stereo as ls  # noqa: E402
from test_bridge import TRACKED_HAND_KEYS, ProtocolAssertions, grid_sizes  # noqa: E402

VIEW = ls.RectifiedView(320, 240, 1.0)  # f = 160 px, +-45 deg
MODEL = ls.FisheyeModel()               # 640x240 raw stand-in, principal points 4 px apart
NEAR_MM, FAR_MM = 100.0, 450.0
BOX = db.BoxConfig(near_m=NEAR_MM / 1000.0, far_m=FAR_MM / 1000.0)
BASELINE = ls.CONTROLLER_BASELINE_MM
TRUTHS = ("u+x_v-z_ref-", "u-x_v+z_ref+", "u+z_v+x_ref-")  # the default, its mirror image, and a transposed one


def sphere_scene(z: float, x: float = 20.0, y: float = -10.0, radius: float = 40.0, **kw: object) -> ls.SyntheticStereoScene:
    return ls.SyntheticStereoScene([ls.Sphere((x, y, z), radius)], **kw)  # type: ignore[arg-type]


def sphere_mask(truth: np.ndarray) -> np.ndarray:
    """Pixels of the rectified left view that see the sphere (the background plane is at 1200 mm)."""
    return (truth > 0) & (truth < 1000)


def interior(mask: np.ndarray, margin: int = 2) -> np.ndarray:
    """The mask eroded by ``margin`` pixels: away from the silhouette, where matching is unambiguous."""
    return db.erode3(mask, margin)


def errors(depth: np.ndarray, truth: np.ndarray, mask: np.ndarray) -> tuple[float, float, float]:
    """``(valid fraction, median relative error, 90th percentile relative error)`` of ``depth`` against ``truth`` inside ``mask``."""
    d, t = depth.astype(np.float64)[mask], truth.astype(np.float64)[mask]
    valid = d > 0
    rel = np.abs(d[valid] - t[valid]) / t[valid]
    return float(valid.mean()), float(np.median(rel)), float(np.percentile(rel, 90))


def analyzer(**overrides: object) -> db.BoxAnalyzer:
    cfg: dict[str, object] = {"occupancy": (8, 6), "voxels": (8, 6, 4), "surface": (32, 24), "min_pixels": 50}
    cfg.update(overrides)
    return db.BoxAnalyzer(BOX, db.AnalyzerConfig(**cfg))  # type: ignore[arg-type]


# ---- rectified view -------------------------------------------------------- #


class RectifiedViewTests(unittest.TestCase):
    def test_focal_length_is_width_over_twice_the_tangent(self) -> None:
        self.assertEqual(VIEW.fx, 160.0)
        self.assertEqual(VIEW.fy, 160.0, "square pixels by default")
        self.assertAlmostEqual(VIEW.hfov_deg, 90.0)
        self.assertAlmostEqual(VIEW.tan_half_v or 0.0, 0.75)
        wide = ls.RectifiedView.from_fov(640, 480, 120.0)
        self.assertAlmostEqual(wide.tan_half_h, np.tan(np.radians(60.0)))
        self.assertAlmostEqual(wide.fx, 640 / (2 * np.tan(np.radians(60.0))))
        tall = ls.RectifiedView(320, 240, 1.0, tan_half_v=1.0)
        self.assertAlmostEqual(tall.fy, 120.0, msg="an explicit vertical tangent gives non-square pixels; fx is unchanged")
        self.assertEqual(tall.fx, 160.0)

    def test_pixel_ray_round_trip_and_centre(self) -> None:
        tx, ty = VIEW.pixel_to_ray(159.5, 119.5)
        self.assertAlmostEqual(float(tx), 0.0)
        self.assertAlmostEqual(float(ty), 0.0)
        u, v = VIEW.ray_to_pixel(0.0, 0.0)
        self.assertAlmostEqual(float(u), 159.5)
        self.assertAlmostEqual(float(v), 119.5)
        us, vs = np.meshgrid(np.arange(0, 320, 7), np.arange(0, 240, 5))
        back_u, back_v = VIEW.ray_to_pixel(*VIEW.pixel_to_ray(us, vs))
        self.assertTrue(np.allclose(back_u, us) and np.allclose(back_v, vs))
        tx, _ = VIEW.pixel_to_ray(319.5, 0)
        self.assertAlmostEqual(float(tx), 1.0, msg="the right edge of the view looks along tan = 1 (45 deg)")

    def test_validation(self) -> None:
        for bad in ({"width": 4}, {"tan_half_h": 0.0}, {"tan_half_v": -1.0}):
            with self.assertRaises(ValueError, msg=str(bad)):
                ls.RectifiedView(**{"width": 320, "height": 240, "tan_half_h": 1.0, **bad})  # type: ignore[arg-type]
        with self.assertRaises(ValueError):
            ls.RectifiedView.from_fov(320, 240, 180.0)


# ---- rectifier ------------------------------------------------------------- #


class RectifierTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.rect = ls.Rectifier(MODEL.ray_to_pixel, MODEL.width, MODEL.height, VIEW, sample_step=4)

    def test_maps_are_monotonic_and_the_centre_lands_on_the_principal_point(self) -> None:
        for camera in ls.CAMERAS:
            map_x, map_y = self.rect.maps[camera]
            self.assertEqual(map_x.shape, (240, 320))
            self.assertEqual(map_x.dtype, np.float32)
            self.assertTrue((np.diff(map_x, axis=1) > 0).all(), "raw x grows with rectified column")
            self.assertTrue((np.diff(map_y, axis=0) > 0).all(), "raw y grows with rectified row")
            cx, cy = MODEL.principal(camera)
            self.assertAlmostEqual(float(map_x[120, 160]), cx, delta=1.0)
            self.assertAlmostEqual(float(map_y[120, 160]), cy, delta=1.0)
            self.assertEqual(self.rect.coverage[camera], 1.0, "+-45 deg is well inside a 132 deg lens")
        self.assertGreater(float(self.rect.maps[ls.CAMERA_RIGHT][0][120, 160] - self.rect.maps[ls.CAMERA_LEFT][0][120, 160]), 3.0, "the per-camera principal points differ")

    def test_lattice_sampling_matches_exact_evaluation(self) -> None:
        exact = ls.Rectifier(MODEL.ray_to_pixel, MODEL.width, MODEL.height, VIEW, cameras=(ls.CAMERA_LEFT,), sample_step=1)
        for i in range(2):
            self.assertLess(float(np.abs(exact.maps[ls.CAMERA_LEFT][i] - self.rect.maps[ls.CAMERA_LEFT][i]).max()), 0.05)

    def test_rays_the_calibration_cannot_place_map_outside_the_image(self) -> None:
        def broken(camera: int, tx: float, ty: float) -> tuple[float, float]:
            return (float("nan"), float("nan")) if tx > 0.5 else MODEL.ray_to_pixel(camera, tx, ty)  # type: ignore[return-value]

        rect = ls.Rectifier(broken, MODEL.width, MODEL.height, VIEW, cameras=(ls.CAMERA_LEFT,), sample_step=8)
        map_x, map_y = rect.maps[ls.CAMERA_LEFT]
        self.assertTrue(np.isfinite(map_x).all() and np.isfinite(map_y).all())
        self.assertTrue((map_x[:, 300:] == -1).all(), "NaN answers become out-of-image coordinates")
        self.assertLess(rect.coverage[ls.CAMERA_LEFT], 0.8)
        wide = ls.Rectifier(MODEL.ray_to_pixel, MODEL.width, MODEL.height, ls.RectifiedView(320, 240, 6.0), cameras=(ls.CAMERA_LEFT,), sample_step=8)
        self.assertLess(wide.coverage[ls.CAMERA_LEFT], 1.0, "a +-80 deg view runs past the raw image")

    def test_rectified_image_matches_a_direct_pinhole_render(self) -> None:
        scene = sphere_scene(300.0)
        raw_left, raw_right = scene.raw_pair(MODEL)
        self.assertEqual(raw_left.shape, (240, 640))
        left, right = self.rect.rectify_pair(raw_left, raw_right)
        self.assertEqual(left.shape, (240, 320))
        self.assertEqual(left.dtype, np.uint8)
        pinhole_left, truth = scene.render_pinhole(ls.CAMERA_LEFT, VIEW)
        pinhole_right, _ = scene.render_pinhole(ls.CAMERA_RIGHT, VIEW)
        for rectified, direct in ((left, pinhole_left), (right, pinhole_right)):
            diff = np.abs(rectified.astype(np.int32) - direct.astype(np.int32))
            self.assertLess(float(diff.mean()), 4.0, "resampling through the fisheye stand-in reproduces the pinhole view")
        # Horizontal epipolar lines: the sphere sits on the same rows in both eyes and only its columns differ.
        left_mask, right_mask = left > 40, right > 40
        ys_l, xs_l = np.nonzero(left_mask)
        ys_r, xs_r = np.nonzero(right_mask)
        self.assertLess(abs(ys_l.mean() - ys_r.mean()), 1.0)
        expected_disparity = scene.baseline_mm * VIEW.fx / 300.0
        self.assertAlmostEqual(float(xs_l.mean() - xs_r.mean()), expected_disparity, delta=1.5)

    def test_rectify_rejects_the_wrong_raw_size(self) -> None:
        with self.assertRaises(ValueError):
            self.rect.rectify(np.zeros((480, 640), dtype=np.uint8), ls.CAMERA_LEFT)
        with self.assertRaises(ValueError):
            ls.Rectifier(MODEL.ray_to_pixel, 0, 240, VIEW)
        with self.assertRaises(ValueError):
            ls.Rectifier(MODEL.ray_to_pixel, 640, 240, VIEW, sample_step=0)


# ---- stereo depth ---------------------------------------------------------- #


class StereoDepthTests(unittest.TestCase):
    def test_disparity_range_follows_the_near_plane(self) -> None:
        st = ls.StereoDepth(40.0, 160.0, ls.StereoParams(min_depth_mm=100.0))
        self.assertEqual(st.num_disparities, 80, "40 mm * 160 px / 100 mm = 64 px at the near plane, plus margin, rounded to 16")
        self.assertEqual(ls.StereoDepth(40.0, 160.0, ls.StereoParams(min_depth_mm=50.0)).num_disparities, 144)
        self.assertEqual(ls.StereoDepth(40.0, 160.0, ls.StereoParams(min_depth_mm=1000.0)).num_disparities, 16)
        self.assertAlmostEqual(st.depth_step_mm(300.0), 300.0 * 300.0 / (40.0 * 160.0))
        self.assertEqual(st.matcher_name, "sgbm")
        with self.assertRaises(ValueError):
            ls.StereoDepth(0.0, 160.0)
        for bad in ({"block_size": 4}, {"median": 4}, {"matcher": "x"}, {"min_intensity": 300}, {"min_depth_mm": 0.0}):
            with self.assertRaises(ValueError, msg=str(bad)):
                ls.StereoParams(**bad)  # type: ignore[arg-type]

    def test_depth_from_disparity(self) -> None:
        st = ls.StereoDepth(40.0, 160.0, ls.StereoParams(max_depth_mm=2000.0))
        disp = np.array([[-1.0, 0.0, 64.0, 21.3333, 3.2, 1.0]], dtype=np.float32)
        depth = st.depth_from_disparity(disp)
        self.assertEqual(depth.dtype, np.uint16)
        self.assertEqual(depth[0, 0], 0, "invalid")
        self.assertEqual(depth[0, 1], 0, "zero disparity is infinity")
        self.assertEqual(depth[0, 2], 100)
        self.assertEqual(depth[0, 3], 300)
        self.assertEqual(depth[0, 4], 2000)
        self.assertEqual(depth[0, 5], 0, "beyond max_depth_mm")

    def test_synthetic_depth_accuracy_on_a_pinhole_pair(self) -> None:
        """Pure matcher accuracy: rendered straight into the rectified model, no rectifier involved."""
        st = ls.StereoDepth(40.0, VIEW.fx)
        for z in (200.0, 300.0, 400.0):
            left, right, truth = sphere_scene(z).stereo_pair(VIEW)
            depth = st.compute(left, right)
            self.assertEqual(depth.shape, (240, 320))
            self.assertEqual(depth.dtype, np.uint16)
            valid, median, p90 = errors(depth, truth, interior(sphere_mask(truth)))
            self.assertGreater(valid, 0.9, f"Z={z}: valid fraction {valid:.3f}")
            self.assertLess(median, 0.02, f"Z={z}: median relative error {median:.4f}")
            self.assertLess(p90, 0.08, f"Z={z}: p90 relative error {p90:.4f}")
            if z >= 300.0:
                self.assertLess(p90, 0.04, f"Z={z}: p90 relative error {p90:.4f}")

    def test_synthetic_depth_accuracy_through_the_fisheye_and_rectifier(self) -> None:
        """The whole path: raw fisheye pair with offset principal points -> rectify -> match."""
        rect = ls.Rectifier(MODEL.ray_to_pixel, MODEL.width, MODEL.height, VIEW)
        st = ls.StereoDepth(40.0, VIEW.fx)
        for z in (200.0, 300.0, 400.0):
            scene = sphere_scene(z)
            left, right = rect.rectify_pair(*scene.raw_pair(MODEL))
            _, truth = scene.render_pinhole(ls.CAMERA_LEFT, VIEW)
            depth = st.compute(left, right)
            valid, median, p90 = errors(depth, truth, interior(sphere_mask(truth)))
            self.assertGreater(valid, 0.9, f"Z={z}: valid fraction {valid:.3f}")
            self.assertLess(median, 0.025, f"Z={z}: median relative error {median:.4f}")
            self.assertLess(p90, 0.08, f"Z={z}: p90 relative error {p90:.4f}")
            in_box = (depth >= NEAR_MM) & (depth <= FAR_MM)
            near_sphere = db.dilate3(sphere_mask(truth), 3)  # block matching fattens the silhouette by a few pixels
            self.assertEqual(int((in_box & ~near_sphere).sum()), 0, f"Z={z}: the ceiling never reads as inside the box")

    def test_dark_pixels_and_black_frames_yield_no_depth(self) -> None:
        black = np.zeros((240, 320), dtype=np.uint8)
        self.assertEqual(int((ls.StereoDepth(40.0, VIEW.fx).compute(black, black) > 0).sum()), 0)
        self.assertEqual(int((ls.StereoDepth(40.0, VIEW.fx, ls.StereoParams(min_intensity=0)).compute(black, black) > 0).sum()), 0)
        left, right, truth = sphere_scene(300.0).stereo_pair(VIEW)
        gated = ls.StereoDepth(40.0, VIEW.fx, ls.StereoParams(min_intensity=16)).compute(left, right)
        self.assertEqual(int((gated[left < 16] > 0).sum()), 0, "nothing darker than the gate carries depth")
        self.assertGreater(int((gated > 0).sum()), 0)

    def test_swapped_cameras_lose_the_hand(self) -> None:
        left, right, _ = sphere_scene(300.0).stereo_pair(VIEW)
        right_order = ls.StereoDepth(40.0, VIEW.fx, swap=False).compute(left, right)
        wrong_order = ls.StereoDepth(40.0, VIEW.fx, swap=True).compute(left, right)
        in_box = lambda d: int(((d >= NEAR_MM) & (d <= FAR_MM)).sum())  # noqa: E731
        self.assertGreater(in_box(right_order), 1000)
        self.assertLess(in_box(wrong_order), 0.2 * in_box(right_order))
        self.assertGreater(ls.StereoDepth(40.0, VIEW.fx, swap=True).valid_fraction(right, left), 0.9 * ls.StereoDepth(40.0, VIEW.fx).valid_fraction(left, right))

    def test_block_matching_fallback_works(self) -> None:
        st = ls.StereoDepth(40.0, VIEW.fx, ls.StereoParams(matcher="bm"))
        self.assertEqual(st.matcher_name, "bm")
        left, right, truth = sphere_scene(300.0).stereo_pair(VIEW)
        valid, median, _ = errors(st.compute(left, right), truth, interior(sphere_mask(truth), 4))
        self.assertGreater(valid, 0.3)
        self.assertLess(median, 0.05)

    def test_shape_mismatch_is_rejected(self) -> None:
        with self.assertRaises(ValueError):
            ls.StereoDepth(40.0, 160.0).compute(np.zeros((240, 320), np.uint8), np.zeros((120, 320), np.uint8))


# ---- reorientation --------------------------------------------------------- #


class ReorientTests(unittest.TestCase):
    def test_every_orientation(self) -> None:
        img = np.arange(6, dtype=np.uint16).reshape(2, 3)  # [[0 1 2] [3 4 5]]
        self.assertIs(ls.reorient(img, "none"), img)
        self.assertEqual(ls.reorient(img, "rot90").tolist(), [[3, 0], [4, 1], [5, 2]], "clockwise: the left edge becomes the top")
        self.assertEqual(ls.reorient(img, "rot270").tolist(), [[2, 5], [1, 4], [0, 3]])
        self.assertEqual(ls.reorient(img, "rot180").tolist(), [[5, 4, 3], [2, 1, 0]])
        self.assertEqual(ls.reorient(img, "flip-h").tolist(), [[2, 1, 0], [5, 4, 3]])
        self.assertEqual(ls.reorient(img, "flip-v").tolist(), [[3, 4, 5], [0, 1, 2]])
        self.assertEqual(ls.reorient(img, "transpose").tolist(), [[0, 3], [1, 4], [2, 5]])
        for name in ls.ORIENTATIONS:
            out = ls.reorient(img, name)
            self.assertTrue(out.flags["C_CONTIGUOUS"], name)
            self.assertEqual(out.dtype, np.uint16)
        with self.assertRaises(ValueError):
            ls.reorient(img, "upside")
        self.assertEqual(ls.ORIENTATIONS, db.LEAP_ORIENTATIONS, "the CLI choices mirror the maths module")

    def test_reorient_points_follows_the_pixels(self) -> None:
        """A marked pixel moved by ``reorient`` is found again where ``reorient_points`` sends its coordinates."""
        for name in ls.ORIENTATIONS:
            for (row, col) in ((0, 0), (1, 2), (3, 4), (2, 1)):
                img = np.zeros((4, 5), dtype=np.uint16)
                img[row, col] = 9
                out = ls.reorient(img, name)
                u, v = ls.reorient_points(float(col), float(row), 5, 4, name)
                self.assertEqual(int(out[int(v), int(u)]), 9, f"{name} ({row}, {col})")
        u, v = ls.reorient_points(np.array([-1.0, 4.5]), np.array([0.5, -2.0]), 5, 4, "rot90")  # affine: off-image points move too
        self.assertEqual(u.tolist(), [3.0 - 0.5, 3.0 + 2.0])
        self.assertEqual(v.tolist(), [-1.0, 4.5])
        with self.assertRaises(ValueError):
            ls.reorient_points(0.0, 0.0, 5, 4, "upside")

    def test_reorient_intrinsics_follows_the_pixels(self) -> None:
        """A pixel's metric point is the same physical point after a reorientation, expressed in the turned image's axes."""
        view = ls.RectifiedView.from_fov(48, 36, 90.0)
        expect = {
            "none": lambda x, v: (x, v), "rot90": lambda x, v: (-v, x), "rot180": lambda x, v: (-x, -v), "rot270": lambda x, v: (v, -x),
            "flip-h": lambda x, v: (-x, v), "flip-v": lambda x, v: (x, -v), "transpose": lambda x, v: (v, x),
        }
        depth = 250.0
        for name in ls.ORIENTATIONS:
            fx, fy, cx, cy = ls.reorient_intrinsics(view.fx, view.fy, view.cx, view.cy, view.width, view.height, name)
            for col, row in ((0.0, 0.0), (10.0, 3.0), (47.0, 35.0), (-2.5, 40.0)):
                x, v = (col + 0.5 - view.cx) * depth / view.fx, (row + 0.5 - view.cy) * depth / view.fy
                u2, v2 = ls.reorient_points(col, row, view.width, view.height, name)
                turned = ((float(u2) + 0.5 - cx) * depth / fx, (float(v2) + 0.5 - cy) * depth / fy)
                self.assertTrue(np.allclose(turned, expect[name](x, v)), f"{name} ({col}, {row}): {turned} vs {expect[name](x, v)}")
        self.assertEqual(ls.reorient_intrinsics(24.0, 24.0, 24.0, 18.0, 48, 36, "rot90"), (24.0, 24.0, 18.0, 24.0), "a turned 48x36 view is 36 wide")
        with self.assertRaises(ValueError):
            ls.reorient_intrinsics(1.0, 1.0, 1.0, 1.0, 4, 4, "upside")


# ---- synthetic scene ------------------------------------------------------- #


class SceneTests(unittest.TestCase):
    def test_sphere_depth_and_disparity_are_analytic(self) -> None:
        scene = ls.SyntheticStereoScene([ls.Sphere((-20.0, 0.0, 300.0), 40.0)])  # straight above the left camera
        _, truth = scene.render_pinhole(ls.CAMERA_LEFT, VIEW)
        self.assertAlmostEqual(float(truth[119, 159]), 260.0, delta=0.5, msg="the centre ray hits the sphere's nearest point")
        self.assertAlmostEqual(float(truth[0, 0]), 1200.0, delta=0.5, msg="the ceiling is at background_mm")
        _, truth_right = scene.render_pinhole(ls.CAMERA_RIGHT, VIEW)
        ys_l, xs_l = np.nonzero(sphere_mask(truth))
        ys_r, xs_r = np.nonzero(sphere_mask(truth_right))
        self.assertAlmostEqual(float(xs_l.mean() - xs_r.mean()), 40.0 * VIEW.fx / 300.0, delta=0.5)
        self.assertAlmostEqual(float(ys_l.mean() - ys_r.mean()), 0.0, delta=0.5)

    def test_shading_and_background_options(self) -> None:
        scene = sphere_scene(300.0)
        image, truth = scene.render_pinhole(ls.CAMERA_LEFT, VIEW)
        self.assertEqual(image.dtype, np.uint8)
        self.assertGreater(float(image[sphere_mask(truth)].mean()), 40.0, "the sphere is lit")
        self.assertLess(float(image[~sphere_mask(truth)].mean()), 12.0, "the ceiling is dark: IR falls off with distance")
        self.assertGreater(float(image[sphere_mask(truth)].std()), 15.0, "and textured")
        dark, dark_truth = sphere_scene(300.0, background_mm=None).render_pinhole(ls.CAMERA_LEFT, VIEW)
        self.assertEqual(int(dark[dark_truth == 0].max()), 0)
        self.assertEqual(int((dark_truth == 0).sum()), int((~sphere_mask(truth)).sum()))
        again, _ = sphere_scene(300.0).render_pinhole(ls.CAMERA_LEFT, VIEW)
        self.assertTrue(np.array_equal(image, again), "rendering is deterministic")

    def test_capsule_is_a_tube_with_round_ends(self) -> None:
        capsule = ls.Capsule((-20.0, -60.0, 300.0), (-20.0, 60.0, 300.0), 25.0)  # its axis runs straight above the left camera
        _, truth = ls.SyntheticStereoScene([capsule]).render_pinhole(ls.CAMERA_LEFT, VIEW)
        _, end = ls.SyntheticStereoScene([ls.Sphere((-20.0, 60.0, 300.0), 25.0)]).render_pinhole(ls.CAMERA_LEFT, VIEW)
        self.assertGreater(int(sphere_mask(truth).sum()), 2 * int(sphere_mask(end).sum()))
        self.assertAlmostEqual(float(truth[119, 159]), 275.0, delta=1.0, msg="the side of the tube at its nearest")
        self.assertTrue((truth[sphere_mask(truth)] >= 274.0).all())
        centre, radius = capsule.bounding_sphere()
        self.assertEqual(centre.tolist(), [-20.0, 0.0, 300.0])
        self.assertAlmostEqual(radius, 85.0)

    def test_hand_script(self) -> None:
        self.assertEqual(ls.hand_shapes(12.0), [])
        self.assertEqual(len(ls.hand_shapes(12.0, absences=False)), 2)
        for t in np.arange(0.0, 14.0, 0.25):
            for shape in ls.hand_shapes(float(t)):
                if isinstance(shape, ls.Sphere):
                    self.assertTrue(219.0 <= shape.centre[2] <= 351.0, f"t={t}: the fist stays inside the default box heights")

    def test_hand_skeleton_sits_on_the_shapes(self) -> None:
        self.assertIsNone(ls.hand_skeleton(12.0))
        self.assertEqual(ls.SKELETON_JOINTS, db.N_JOINTS)
        self.assertEqual(ls.SKELETON_WIDTHS, db.N_WIDTHS)
        for t in (0.0, 2.0, 5.0):
            sk = ls.hand_skeleton(t)
            assert sk is not None
            self.assertEqual(sk.points.shape, (db.N_JOINTS, 3))
            self.assertEqual(sk.widths_mm.shape, (db.N_WIDTHS,))
            self.assertTrue((sk.widths_mm > 0).all())
            self.assertFalse(sk.extended.any(), "a fist")
            fist = next(s for s in ls.hand_shapes(t) if isinstance(s, ls.Sphere))
            forearm = next(s for s in ls.hand_shapes(t) if isinstance(s, ls.Capsule))
            centre = np.asarray(fist.centre)
            palm = sk.points[db.JOINT_PALM]
            self.assertTrue(np.allclose(palm, centre + (0.0, 0.0, -fist.radius)), "the palm is the fist's lowest point")
            finger_pts = sk.points[db.FINGER_JOINTS:]
            self.assertTrue(np.allclose(np.linalg.norm(finger_pts - centre, axis=1), fist.radius), "finger joints lie on the fist")
            self.assertTrue((finger_pts[:, 2] < centre[2]).all(), "on its underside, where the cameras look")
            a, b = np.asarray(forearm.a), np.asarray(forearm.b)
            axis = (b - a) / np.linalg.norm(b - a)
            for joint in (sk.points[db.JOINT_WRIST], sk.points[db.JOINT_ELBOW]):
                foot = a + np.clip((joint - a) @ axis, 0.0, np.linalg.norm(b - a)) * axis
                self.assertAlmostEqual(float(np.linalg.norm(joint - foot)), forearm.radius, places=6, msg="wrist and elbow lie on the forearm's surface")
                self.assertLess(float(joint[2]), float(foot[2]), "below its axis")


# ---- the box, through BoxAnalyzer ------------------------------------------ #


class BoxFilterTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.rect = ls.Rectifier(MODEL.ray_to_pixel, MODEL.width, MODEL.height, VIEW)
        cls.stereo = ls.StereoDepth(40.0, VIEW.fx)

    def depth_and_truth(self, scene: ls.SyntheticStereoScene) -> tuple[np.ndarray, np.ndarray]:
        left, right = self.rect.rectify_pair(*scene.raw_pair(MODEL))
        _, truth = scene.render_pinhole(ls.CAMERA_LEFT, VIEW)
        return self.stereo.compute(left, right), truth

    def test_sphere_in_the_box_is_one_blob_at_the_right_place_and_depth(self) -> None:
        for z in (200.0, 300.0, 400.0):
            depth, truth = self.depth_and_truth(sphere_scene(z))
            result = analyzer().analyze(db.DepthFrame(depth, 0.0))
            self.assertEqual(len(result.blobs), 1, f"Z={z}")
            blob = result.blobs[0]
            mask = sphere_mask(truth)
            ys, xs = np.nonzero(mask)
            self.assertAlmostEqual(blob.u, (xs.mean() + 0.5) / 320, delta=0.02)
            self.assertAlmostEqual(blob.v, (ys.mean() + 0.5) / 240, delta=0.02)
            nearest_w = (z - 40.0 - NEAR_MM) / (FAR_MM - NEAR_MM)
            self.assertAlmostEqual(blob.w, nearest_w, delta=0.03, msg=f"Z={z}: the blob's depth is the sphere's nearest point")
            ratio = result.stats["pixels"] / float(mask.sum())
            self.assertTrue(0.75 <= ratio <= 1.1, f"Z={z}: in-box pixels are the sphere's, ratio {ratio:.3f}")
            assert result.surface is not None
            lit = result.surface[result.surface > 0]
            self.assertAlmostEqual((int(lit.min()) - 1) / 254.0, nearest_w, delta=0.03, msg="the surface scan's nearest cell is the top of the sphere")

    def test_background_beyond_far_is_filtered_out(self) -> None:
        depth, _ = self.depth_and_truth(sphere_scene(600.0))
        self.assertGreater(int((depth > 0).sum()), 50, "the sphere is still matched...")
        self.assertGreater(float(np.median(depth[depth > 0])), FAR_MM, "...at its true height beyond the far plane")
        result = analyzer().analyze(db.DepthFrame(depth, 0.0))
        self.assertEqual(result.blobs, ())
        self.assertEqual(result.stats["pixels"], 0.0)
        assert result.surface is not None and result.occupancy is not None
        self.assertEqual(int(result.surface.sum()), 0)
        self.assertEqual(int(result.occupancy.sum()), 0)
        empty, _ = self.depth_and_truth(ls.SyntheticStereoScene([]))
        self.assertEqual(analyzer().analyze(db.DepthFrame(empty, 0.0)).stats["pixels"], 0.0, "the ceiling alone is never in the box")

    def test_nearer_than_the_search_range_is_no_measurement(self) -> None:
        depth, _ = self.depth_and_truth(sphere_scene(60.0, radius=20.0))  # disparity 107 px > 64 searched
        result = analyzer().analyze(db.DepthFrame(depth, 0.0))
        self.assertEqual(result.blobs, ())


# ---- the hardware-free source and the LeapC binding's pure parts ------------ #


class LeapSyntheticSourceTests(unittest.TestCase):
    def test_render_is_deterministic_and_feeds_the_analyzer(self) -> None:
        src = lsrc.LeapSyntheticSource(VIEW, paced=False)
        depth = src.render(2.0)
        self.assertEqual(depth.shape, (240, 320))
        self.assertEqual(depth.dtype, np.uint16)
        self.assertTrue(np.array_equal(depth, lsrc.LeapSyntheticSource(VIEW, paced=False).render(2.0)))
        assert src.last_pair is not None and src.last_rectified is not None
        self.assertEqual(src.last_pair[0].shape, (240, 640))
        self.assertEqual(src.last_rectified[0].shape, (240, 320))
        result = analyzer(max_hands=1).analyze(db.DepthFrame(depth, 2.0))
        self.assertEqual(len(result.blobs), 1)
        self.assertGreater(result.stats["pixels"], 1500, "fist and forearm are in the box")
        fist = next(s for s in ls.hand_shapes(2.0) if isinstance(s, ls.Sphere))
        top_w = (fist.centre[2] - fist.radius - NEAR_MM) / (FAR_MM - NEAR_MM)
        assert result.surface is not None
        lit = result.surface[result.surface > 0]
        self.assertAlmostEqual((int(lit.min()) - 1) / 254.0, top_w, delta=0.04, msg="the scan's nearest cell is the top of the fist")
        self.assertEqual(int(((src.render(12.0) >= NEAR_MM) & (src.render(12.0) <= FAR_MM)).sum()), 0, "the hand is away at t = 12")

    def test_read_paces_and_orients(self) -> None:
        src = lsrc.LeapSyntheticSource(VIEW, orient="rot90", paced=False, fps=30.0)
        src.start()
        a, b = src.read(), src.read()
        self.assertEqual(a.depth_mm.shape, (320, 240))
        self.assertGreaterEqual(b.timestamp, a.timestamp)
        assert a.hands is not None
        self.assertEqual(len(a.hands), 1, "read() carries the skeleton, reoriented with the image")
        self.assertGreater(lsrc.joint_hits(a.hands[0].joints[lsrc.SCORED_JOINTS], a.depth_mm, 30.0), 24)
        with self.assertRaises(ValueError):
            lsrc.LeapSyntheticSource(VIEW, orient="sideways")
        with self.assertRaises(ValueError):
            lsrc.LeapSyntheticSource(VIEW, hand_frame="sideways")
        with self.assertRaises(ValueError):
            lsrc.LeapSyntheticSource(VIEW, true_frame="sideways")
        self.assertIsNone(lsrc.LeapSyntheticSource(VIEW, paced=False, skeletons=False).frame_at(2.0).hands, "a source without tracking sends None")

    def test_skeleton_lies_on_the_rendered_hand(self) -> None:
        """Under its true convention the projected skeleton lands on the scan: exact on the truth depth, close on SGBM's."""
        for truth in TRUTHS:
            src = lsrc.LeapSyntheticSource(VIEW, paced=False, hand_frame=truth, true_frame=truth)
            for t in (0.0, 1.0, 2.5):
                frame = src.frame_at(t)
                assert frame.hands is not None
                self.assertEqual(len(frame.hands), 1)
                hand = frame.hands[0]
                self.assertEqual((hand.id, hand.type), (1, "right"))
                self.assertEqual(hand.grab_strength, 1.0, "a fist")
                _, truth_depth = src.scene(t).render_pinhole(src.reference_camera, VIEW)
                scored = hand.joints[lsrc.SCORED_JOINTS]
                self.assertEqual(lsrc.joint_hits(scored, np.rint(truth_depth).astype(np.uint16), 3.0), len(scored), f"{truth} t={t}: every joint is on the rendered surface")
                self.assertGreaterEqual(lsrc.joint_hits(scored, frame.depth_mm, 30.0), len(scored) - 2, f"{truth} t={t}: and on the stereo scan within 30 mm")
                self.assertTrue((hand.widths_px > 0).all())
                fist = next(s for s in ls.hand_shapes(t) if isinstance(s, ls.Sphere))
                self.assertAlmostEqual(float(hand.widths_px[db.WIDTH_PALM]), 1.6 * fist.radius * VIEW.fx / float(hand.joints[db.JOINT_PALM, 2]), places=6, msg="widths are width * fx / depth")
                elbow, wrist = hand.joints[db.JOINT_ELBOW], hand.joints[db.JOINT_WRIST]
                self.assertLess(float(np.hypot(elbow[0] - wrist[0], elbow[1] - wrist[1])), 70.0 * VIEW.fx / 150.0, "the forearm is a stub")
            self.assertEqual(src.device_hands(12.0), ())
        # The device-frame skeleton really is the scene skeleton seen from the reference camera.
        src = lsrc.LeapSyntheticSource(VIEW, paced=False, hand_frame=TRUTHS[1], true_frame=TRUTHS[1])
        device = src.device_hands(2.0)[0].joints
        scene = ls.hand_skeleton(2.0)
        assert scene is not None
        origin = src.scene(2.0).camera_origin(ls.CAMERA_LEFT)
        expected_u, expected_v = VIEW.ray_to_pixel((scene.points[:, 0] - origin[0]) / scene.points[:, 2], scene.points[:, 1] / scene.points[:, 2])
        projected = src.projector.project(device)
        self.assertTrue(np.allclose(projected[:, 0], expected_u) and np.allclose(projected[:, 1], expected_v) and np.allclose(projected[:, 2], scene.points[:, 2]))

    def test_auto_mode_finds_the_true_convention(self) -> None:
        for truth in TRUTHS:
            src = lsrc.LeapSyntheticSource(VIEW, paced=False, hand_frame="auto", true_frame=truth)
            detector = src.projector.detector
            assert detector is not None
            self.assertIsNone(detector.locked)
            for t in np.arange(0.5, 4.0, 0.25):
                frame = src.frame_at(float(t))
                assert frame.hands is not None
                self.assertEqual(len(frame.hands), 1, "hands are reported with the provisional best while scoring")
                if detector.locked is not None:
                    break
            self.assertIsNotNone(detector.locked, f"{truth}: {detector.table()}")
            assert detector.locked is not None
            self.assertEqual(detector.locked.name, truth, detector.table())
            self.assertEqual(detector.locked_after, detector.min_frames, "a clean scene locks as soon as allowed")
            self.assertGreaterEqual(float(detector.scores.max()), 0.95)
            self.assertIn("locked", src.projector.describe())
            self.assertIn(truth, detector.table().splitlines()[1])
            self.assertTrue(src.projector.locked)
            after = detector.frames
            src.frame_at(4.5)
            self.assertEqual(detector.frames, after, "a locked detector stops scoring")


class LeapBindingTests(unittest.TestCase):
    def test_struct_layouts(self) -> None:
        self.assertEqual(C.sizeof(lsrc._Image), 64)
        self.assertEqual(C.sizeof(lsrc._ImageEvent), 160)
        self.assertEqual(C.sizeof(lsrc._DeviceInfo), 44)
        self.assertEqual(C.sizeof(lsrc._DeviceEvent), 20)
        msg = lsrc._ConnectionMessage()
        msg.size, msg.type = 16, lsrc.EVENT_IMAGE
        self.assertIsNone(msg.device_id, "5.0 layout: no device_id")
        msg.size = 20
        msg.tail[0], msg.tail[1], msg.tail[2], msg.tail[3] = 7, 0, 0, 0
        self.assertEqual(msg.device_id, 7, "Gemini layout: device_id right after the pointer")
        info = lsrc.LeapDeviceInfo(3, 40000, 2.3, 2.0, 470000, "LP0", 0, 0)
        self.assertEqual(info.baseline_mm, 40.0)
        self.assertEqual(info.type_name, "Leap Motion Controller")

    def test_tracking_struct_layouts(self) -> None:
        """LeapC.h is ``#pragma pack(1)``: LEAP_HAND is 1084 bytes (1088 would be x64 natural alignment) and the event 48."""
        self.assertEqual(C.sizeof(lsrc._Quaternion), 16)
        self.assertEqual(C.sizeof(lsrc._Bone), 44)
        self.assertEqual(C.sizeof(lsrc._Digit), 184)
        self.assertEqual(C.sizeof(lsrc._Palm), 80)
        self.assertEqual(C.sizeof(lsrc._Hand), 1084)
        self.assertEqual(C.sizeof(lsrc._TrackingEvent), 48)
        self.assertEqual((lsrc._Hand.visible_time.offset, lsrc._Hand.palm.offset, lsrc._Hand.digits.offset, lsrc._Hand.arm.offset), (16, 40, 120, 1040))
        self.assertEqual((lsrc._Digit.bones.offset, lsrc._Digit.is_extended.offset), (4, 180))
        self.assertEqual((lsrc._Palm.width.offset, lsrc._Palm.direction.offset, lsrc._Palm.orientation.offset), (48, 52, 64))
        self.assertEqual((lsrc._TrackingEvent.tracking_frame_id.offset, lsrc._TrackingEvent.nHands.offset, lsrc._TrackingEvent.pHands.offset, lsrc._TrackingEvent.framerate.offset), (24, 32, 36, 44))

    @staticmethod
    def make_hand(hand_id: int, hand_type: int, palm: tuple[float, float, float] = (10.0, 300.0, -20.0)) -> lsrc._Hand:
        h = lsrc._Hand()
        h.id, h.type, h.confidence, h.grab_strength, h.pinch_strength = hand_id, hand_type, 0.9, 0.3, 0.1
        px, py, pz = palm
        h.palm.position, h.palm.width = lsrc._Vector(px, py, pz), 85.0
        h.palm.normal, h.palm.direction = lsrc._Vector(0.0, -1.0, 0.0), lsrc._Vector(0.0, 0.0, -1.0)
        h.arm.next_joint, h.arm.prev_joint, h.arm.width = lsrc._Vector(px, py, pz + 60.0), lsrc._Vector(px, py + 20.0, pz + 300.0), 55.0
        for f in range(5):
            digit = h.digits[f]
            digit.finger_id, digit.is_extended = f, f % 2
            for b in range(4):
                digit.bones[b].prev_joint = lsrc._Vector(px + 10.0 * f, py + 10.0 * b, pz - 20.0)
                digit.bones[b].next_joint = lsrc._Vector(px + 10.0 * f, py + 10.0 * b + 10.0, pz - 20.0)
                digit.bones[b].width = 15.0 + b
        return h

    def test_tracking_event_is_copied_into_device_hands(self) -> None:
        hands = (lsrc._Hand * 2)(self.make_hand(3, 0), self.make_hand(4, 1, (-40.0, 250.0, 30.0)))
        event = lsrc._TrackingEvent()
        event.info.timestamp, event.info.frame_id, event.nHands, event.framerate = 123456, 9, 2, 110.0
        event.pHands = C.cast(hands, C.POINTER(lsrc._Hand))
        frame = lsrc.read_tracking_event(event)
        self.assertEqual((frame.timestamp_us, frame.frame_id, frame.framerate), (123456, 9, 110.0))
        self.assertEqual([(h.id, h.type) for h in frame.hands], [(3, "left"), (4, "right")])
        left = frame.hands[0]
        self.assertEqual(left.joints.shape, (db.N_JOINTS, 3))
        self.assertEqual(left.joints[db.JOINT_PALM].tolist(), [10.0, 300.0, -20.0])
        self.assertEqual(left.joints[db.JOINT_WRIST].tolist(), [10.0, 300.0, 40.0], "wrist = arm.next_joint")
        self.assertEqual(left.joints[db.JOINT_ELBOW].tolist(), [10.0, 320.0, 280.0], "elbow = arm.prev_joint")
        for f in range(5):
            for j in range(4):
                self.assertEqual(left.joints[db.finger_joint(f, j)].tolist(), [10.0 + 10.0 * f, 300.0 + 10.0 * j, -40.0], "carp, mcp, pip, dip are the bones' prev_joints")
            self.assertEqual(left.joints[db.finger_joint(f, 4)].tolist(), [10.0 + 10.0 * f, 340.0, -40.0], "the tip is the distal bone's next_joint")
        self.assertEqual(left.widths_mm.tolist(), [85.0, 55.0, 16.0, 16.0, 16.0, 16.0, 16.0], "a finger's width is its proximal bone's")
        self.assertEqual(left.extended.tolist(), [False, True, False, True, False])
        self.assertAlmostEqual(left.confidence, 0.9, places=6)
        self.assertAlmostEqual(left.grab_strength, 0.3, places=6)
        self.assertAlmostEqual(left.pinch_strength, 0.1, places=6)
        self.assertEqual(frame.hands[1].joints[db.JOINT_PALM].tolist(), [-40.0, 250.0, 30.0], "the second hand is read at the packed stride")
        # Defensive: an impossible count, a null pointer or garbage numbers never become hands.
        event.nHands = lsrc.MAX_TRACKED_HANDS + 1
        self.assertEqual(lsrc.read_tracking_event(event).hands, ())
        event.nHands, event.pHands = 2, C.POINTER(lsrc._Hand)()
        self.assertEqual(lsrc.read_tracking_event(event).hands, ())
        hands[0].palm.position = lsrc._Vector(float("nan"), 300.0, -20.0)
        hands[1].digits[2].bones[3].next_joint = lsrc._Vector(0.0, 1e6, 0.0)
        event.pHands = C.cast(hands, C.POINTER(lsrc._Hand))
        self.assertEqual(lsrc.read_tracking_event(event).hands, ())
        self.assertEqual(lsrc.read_hand(self.make_hand(5, 7)).type, "unknown")  # type: ignore[union-attr]

    def test_library_search(self) -> None:
        with self.assertRaises(RuntimeError) as ctx:
            lsrc.find_leapc(os.path.join(HERE, "no-such-LeapC.dll"))
        self.assertIn("no-such-LeapC.dll", str(ctx.exception))
        old = os.environ.get("LEAPC_DLL")
        os.environ["LEAPC_DLL"] = os.path.join(HERE, "still-missing.dll")
        try:
            self.assertEqual(lsrc.leapc_candidates()[0], os.environ["LEAPC_DLL"])
        finally:
            if old is None:
                del os.environ["LEAPC_DLL"]
            else:
                os.environ["LEAPC_DLL"] = old
        self.assertGreater(len(lsrc.leapc_candidates()), 1)

    def test_stall_watchdog_raises_instead_of_hanging(self) -> None:
        src = lsrc.LeapStereoSource(view=VIEW, stall_after=0.2, restart_after=0.6, fps=None)
        with self.assertRaises(RuntimeError):
            src.read()  # before start()
        src._thread = threading.Thread(target=lambda: time.sleep(3.0), daemon=True)  # stands in for a poll thread that never returns
        src._thread.start()
        started = time.perf_counter()
        with self.assertLogs("leap_source", level="WARNING") as logs:
            with self.assertRaises(RuntimeError) as ctx:
                src.read()
        self.assertLess(time.perf_counter() - started, 2.0)
        self.assertIn("5.0.0-preview", str(ctx.exception))
        self.assertTrue(any("5.0.0-preview" in line for line in logs.output))
        self.assertIn("policy=not granted", src.state())
        src._thread = None
        src.stop()
        self.assertFalse(src.needs_hard_exit)

    def test_injected_stereo_pair_goes_through_the_live_pipeline(self) -> None:
        """Everything after LeapPollConnection, with the fisheye stand-in answering for LeapRectilinearToPixel."""
        src = lsrc.LeapStereoSource(view=VIEW, fps=None)
        src.lib = type("FakeLeapC", (), {"rectilinear_to_pixel": lambda self, conn, camera, tx, ty, device=None: MODEL.ray_to_pixel(camera, tx, ty)})()  # type: ignore[assignment]
        src._conn = C.c_void_p(1)
        src._thread = threading.Thread(target=lambda: time.sleep(2.0), daemon=True)
        src._thread.start()
        src.device_info = lsrc.LeapDeviceInfo(3, 40000, 2.3, 2.0, 470000, "LP0", 0, 0)
        scene = sphere_scene(300.0)
        raw_left, raw_right = scene.raw_pair(MODEL)
        with src._cond:
            src._latest = lsrc.StereoPair(raw_left, raw_right, matrix_version=5, frame_id=1, timestamp=12.5, seq=1)
        frame = src.read()
        self.assertEqual(frame.timestamp, 12.5)
        self.assertEqual(frame.depth_mm.shape, (240, 320))
        assert src.rectifier is not None and src.stereo is not None
        self.assertEqual(src.stereo.baseline_mm, 40.0)
        expected = ls.StereoDepth(40.0, VIEW.fx).compute(*ls.Rectifier(MODEL.ray_to_pixel, MODEL.width, MODEL.height, VIEW).rectify_pair(raw_left, raw_right))
        self.assertTrue(np.array_equal(frame.depth_mm, expected))
        self.assertEqual(len(analyzer().analyze(frame).blobs), 1)
        self.assertEqual(frame.hands, (), "no tracking event yet: no hands, still a tracking source")
        assert src.projector is not None
        self.assertIn("auto", src.state())
        # A tracking frame near the pair's timestamp lends its hands; a stale one does not.
        hand = LeapBindingTests.make_hand(3, 1, (20.0, 300.0, -10.0))
        hands = (lsrc._Hand * 1)(hand)
        event = lsrc._TrackingEvent()
        event.info.timestamp, event.nHands, event.pHands = 1_000_000, 1, C.cast(hands, C.POINTER(lsrc._Hand))
        src._on_tracking(event)
        self.assertEqual(src.tracking_frames, 1)
        self.assertIn("tracking=1 frames, 1 hand(s)", src.state())
        with src._cond:
            src._latest = lsrc.StereoPair(raw_left, raw_right, matrix_version=5, frame_id=2, timestamp=12.6, seq=2, timestamp_us=1_020_000)
        frame = src.read()
        assert frame.hands is not None
        self.assertEqual([(h.id, h.type) for h in frame.hands], [(3, "right")])
        self.assertTrue(np.isfinite(frame.hands[0].joints).all())
        with src._cond:
            src._latest = lsrc.StereoPair(raw_left, raw_right, matrix_version=5, frame_id=3, timestamp=12.7, seq=3, timestamp_us=1_200_000)
        self.assertEqual(src.read().hands, (), "200 ms later the skeleton is stale")
        src._thread = None


# ---- the skeleton's device-to-image projection --------------------------------- #


def device_hand(palm: tuple[float, float, float], spread_mm: float = 40.0, hand_id: int = 1) -> lsrc.DeviceHand:
    """A device-frame hand around ``palm`` (mm: x along the baseline, y up, z toward the performer), fingers toward -z."""
    joints = np.tile(np.asarray(palm, dtype=np.float64), (db.N_JOINTS, 1))
    joints[db.JOINT_WRIST] += (0.0, 0.0, spread_mm)
    joints[db.JOINT_ELBOW] += (0.0, 40.0, 250.0)
    for f in range(db.N_FINGERS):
        for j in range(db.JOINTS_PER_FINGER):
            along = (j + 1) / db.JOINTS_PER_FINGER
            joints[db.finger_joint(f, j)] += ((f - 2) * spread_mm / 2.0 * along, -8.0 * along, -spread_mm * along)
    widths = np.array([85.0, 55.0, 18.0, 17.0, 17.0, 16.0, 14.0])
    return lsrc.DeviceHand(hand_id, "right", 0.8, 0.2, 0.0, joints, widths, np.ones(5, dtype=bool))


def painted_depth(projected: np.ndarray, shape: tuple[int, int] = (240, 320), radius: int = 3) -> np.ndarray:
    """A depth image holding each projected joint's depth in a small square around its pixel, 0 elsewhere."""
    depth = np.zeros(shape, dtype=np.uint16)
    for u, v, d in projected:
        if np.isfinite(u) and np.isfinite(v) and 0 <= u < shape[1] and 0 <= v < shape[0]:
            ui, vi = int(round(u)), int(round(v))
            depth[max(0, vi - radius):vi + radius + 1, max(0, ui - radius):ui + radius + 1] = int(round(d))
    return depth


class HandFrameTests(unittest.TestCase):
    def test_sixteen_named_candidates_with_the_plausible_ones_first(self) -> None:
        self.assertEqual(len(lsrc.HAND_FRAMES), 16)
        self.assertEqual(len(set(lsrc.HAND_FRAME_NAMES)), 16)
        self.assertEqual(lsrc.DEFAULT_HAND_FRAME, "u+x_v-z_ref-")
        self.assertEqual([f.plausible for f in lsrc.HAND_FRAMES][:4], [True] * 4)
        self.assertEqual(sum(f.plausible for f in lsrc.HAND_FRAMES), 4, "u along the baseline with the reference camera on the low-u side")
        for frame in lsrc.HAND_FRAMES:
            self.assertIs(lsrc.HAND_FRAME_BY_NAME[frame.name], frame)
            self.assertEqual({frame.u_axis, frame.v_axis}, {0, 2})
        self.assertEqual(lsrc.HandFrame(0, 1, 2, -1, -1).name, "u+x_v-z_ref-")
        self.assertEqual(lsrc.HandFrame(2, -1, 0, 1, 1).name, "u-z_v+x_ref+")
        with self.assertRaises(ValueError):
            lsrc.HandFrame(0, 1, 1, -1, -1)
        with self.assertRaises(ValueError):
            lsrc.HandFrame(0, 2, 2, -1, -1)
        self.assertEqual(lsrc.HAND_FRAMES[0].reference_sign(False), -1)
        self.assertEqual(lsrc.HAND_FRAMES[0].reference_sign(True), 1, "--swap-cameras makes the other camera the reference")

    def test_projection_round_trips_through_the_view(self) -> None:
        rng = np.random.default_rng(3)
        points = rng.uniform(-150.0, 150.0, (40, 3))
        points[:, 1] = rng.uniform(120.0, 420.0, 40)  # above the device
        for frame in lsrc.HAND_FRAMES:
            for swap in (False, True):
                ref = frame.reference_sign(swap)
                cam = frame.device_to_camera(points, ref, BASELINE)
                self.assertTrue(np.allclose(frame.camera_to_device(cam, ref, BASELINE), points), frame.name)
                image = lsrc.project_hand_points(points, frame, VIEW, BASELINE, swap)
                self.assertTrue(np.allclose(image[:, 2], points[:, 1]), "depth is the height above the device")
                tx, ty = VIEW.pixel_to_ray(image[:, 0], image[:, 1])  # the view's own ray through that pixel...
                back = frame.camera_to_device(np.stack([tx * image[:, 2], ty * image[:, 2], image[:, 2]], axis=-1), ref, BASELINE)
                self.assertTrue(np.allclose(back, points), f"{frame.name} swap={swap}: ...times the depth is the device point again")
                straight_up = np.array([[ref * BASELINE / 2.0, 300.0, 0.0]])  # right above the reference camera
                u, v, _ = lsrc.project_hand_points(straight_up, frame, VIEW, BASELINE, swap)[0]
                self.assertAlmostEqual(float(u), VIEW.cx - 0.5)
                self.assertAlmostEqual(float(v), VIEW.cy - 0.5)
        default = lsrc.HAND_FRAMES[0]
        image = lsrc.project_hand_points(np.array([[100.0, 200.0, -50.0]]), default, VIEW, BASELINE)
        self.assertGreater(float(image[0, 0]), VIEW.cx, "u+x: +x is image right")
        self.assertGreater(float(image[0, 1]), VIEW.cy, "v-z: -z (away from the performer) is image down")
        low = lsrc.project_hand_points(np.array([[0.0, 0.0, 0.0], [0.0, -5.0, 0.0]]), default, VIEW, BASELINE)
        self.assertTrue(np.isnan(low[:, :2]).all(), "on or below the device plane there is no pixel")

    def test_projection_follows_the_image_orientation(self) -> None:
        hand = device_hand((60.0, 300.0, -40.0))
        for orient in ls.ORIENTATIONS:
            plain = lsrc.project_hand_points(hand.joints, lsrc.HAND_FRAMES[0], VIEW, BASELINE)
            turned = lsrc.project_hand_points(hand.joints, lsrc.HAND_FRAMES[0], VIEW, BASELINE, orient=orient)
            depth = ls.reorient(painted_depth(plain), orient)
            self.assertEqual(lsrc.joint_hits(turned, depth, 1.0), db.N_JOINTS, orient)

    def test_forearm_stub_widths_and_hits(self) -> None:
        self.assertTrue(np.allclose(lsrc.trim_forearm(np.zeros(3), np.array([0.0, 0.0, 300.0])), [0.0, 0.0, 70.0]))
        self.assertTrue(np.allclose(lsrc.trim_forearm(np.zeros(3), np.array([0.0, 0.0, 50.0])), [0.0, 0.0, 50.0]), "an arm already shorter than the stub is kept")
        projector = lsrc.HandProjector(VIEW, BASELINE, hand_frame=lsrc.DEFAULT_HAND_FRAME)
        hand = device_hand((60.0, 300.0, -40.0))
        tracked = projector.to_image_hand(hand)
        assert tracked is not None
        self.assertEqual((tracked.id, tracked.type, tracked.confidence, tracked.grab_strength), (1, "right", 0.8, 0.2))
        self.assertAlmostEqual(float(tracked.widths_px[db.WIDTH_PALM]), 85.0 * VIEW.fx / 300.0, places=6, msg="palm width in pixels at the palm's depth")
        self.assertAlmostEqual(float(tracked.widths_px[db.WIDTH_ARM]), 55.0 * VIEW.fx / 300.0, places=6)
        finger_depth = tracked.finger(1)[:, 2].mean()
        self.assertAlmostEqual(float(tracked.widths_px[db.WIDTH_FINGERS + 1]), 17.0 * VIEW.fx / finger_depth, places=6, msg="a finger's width at its mean depth")
        elbow, wrist = tracked.joints[db.JOINT_ELBOW], tracked.joints[db.JOINT_WRIST]
        self.assertAlmostEqual(float(np.linalg.norm(hand.joints[db.JOINT_WRIST] - hand.joints[db.JOINT_ELBOW])), float(np.hypot(40.0, 210.0)))
        self.assertLess(abs(float(elbow[2] - wrist[2])), 70.0, "the elbow is a stub 70 mm past the wrist")
        self.assertIsNone(projector.to_image_hand(device_hand((0.0, 5.0, 0.0))), "fingertips reaching below the device plane: not a hand this camera can see")
        projected = projector.project(hand.joints)
        self.assertEqual(lsrc.joint_hits(projected, painted_depth(projected), 1.0), db.N_JOINTS)
        self.assertEqual(lsrc.joint_hits(projected, painted_depth(projected) + np.uint16(40), 30.0), 0, "the depth must agree within the tolerance")
        self.assertEqual(lsrc.joint_hits(projected, np.zeros((240, 320), np.uint16), 30.0), 0, "an empty scan never hits")
        self.assertEqual(lsrc.joint_hits(projected + np.array([1000.0, 0.0, 0.0]), painted_depth(projected), 30.0), 0, "off-image joints never hit")
        self.assertEqual(projector.describe(), "u+x_v-z_ref- (fixed)")
        with self.assertRaises(ValueError):
            lsrc.HandProjector(VIEW, BASELINE, hand_frame="u+y_v-z_ref-")


class HandFrameDetectorTests(unittest.TestCase):
    def test_locks_on_the_convention_that_puts_joints_on_the_scan(self) -> None:
        for truth in TRUTHS:
            frame_true = lsrc.HAND_FRAME_BY_NAME[truth]
            detector = lsrc.HandFrameDetector(min_frames=5)
            projector = lsrc.HandProjector(VIEW, BASELINE, hand_frame="auto", detector=detector)
            self.assertEqual(projector.frame, lsrc.HAND_FRAMES[0], "before any evidence the default is the provisional pick")
            self.assertIn("nothing scored yet", projector.describe())
            for i, x in enumerate((-80.0, -40.0, 0.0, 40.0, 80.0, 60.0)):
                hand = device_hand((x, 280.0 + 10.0 * i, -30.0 + 15.0 * i))
                depth = painted_depth(lsrc.project_hand_points(hand.joints, frame_true, VIEW, BASELINE))
                tracked = projector.resolve((hand,), depth)
                self.assertEqual(len(tracked), 1)
                if detector.locked is not None:
                    break
            self.assertIsNotNone(detector.locked, detector.table())
            assert detector.locked is not None
            self.assertEqual(detector.locked.name, truth, detector.table())
            self.assertEqual(detector.locked_after, 5)
            self.assertEqual(float(detector.scores[lsrc.HAND_FRAMES.index(frame_true)]), 1.0)
            self.assertIs(projector.frame, frame_true)
            self.assertTrue(projector.locked)
            self.assertIn("locked after 5 frames", projector.describe())
            self.assertEqual(detector.table().splitlines()[1].split()[0], truth)

    def test_uninformative_frames_do_not_count_and_a_tie_does_not_lock(self) -> None:
        detector = lsrc.HandFrameDetector(min_frames=2)
        hand = device_hand((50.0, 300.0, -40.0))
        self.assertIsNone(detector.observe(np.zeros((240, 320), np.uint16), lambda f: lsrc.project_hand_points(hand.joints, f, VIEW, BASELINE)))
        self.assertEqual((detector.frames, detector.total), (0, 0), "an empty scan teaches nothing")
        both = np.maximum(
            painted_depth(lsrc.project_hand_points(hand.joints, lsrc.HAND_FRAME_BY_NAME["u+x_v-z_ref-"], VIEW, BASELINE)),
            painted_depth(lsrc.project_hand_points(hand.joints, lsrc.HAND_FRAME_BY_NAME["u+x_v+z_ref-"], VIEW, BASELINE)),
        )
        for _ in range(4):
            self.assertIsNone(detector.observe(both, lambda f: lsrc.project_hand_points(hand.joints, f, VIEW, BASELINE)))
        self.assertIsNone(detector.locked, "two conventions fit equally well: keep scoring")
        self.assertEqual(detector.frames, 4)
        self.assertIn("leading", detector.describe())
        self.assertEqual(detector.best.name, "u+x_v-z_ref-", "ties go to the more plausible candidate")
        with self.assertRaises(ValueError):
            lsrc.HandFrameDetector(candidates=())


# ---- the calibration grids, the camera alignment and the invalidation rules ---- #


def model_lattice(model: ls.FisheyeModel, camera: int, normalized: bool = True) -> np.ndarray:
    """The 64x64 grid LeapC would attach to an image of this stand-in camera, in the documented convention:
    column i is the ray tx = -4 + 8 i / 63, row j is ty = 4 - 8 j / 63, values normalized so that pixel centre p is (p + 0.5) / size."""
    n, r = ls.DISTORTION_GRID_N, ls.DISTORTION_SLOPE_RANGE
    i, j = np.meshgrid(np.arange(n), np.arange(n))
    tx, ty = -r + 2 * r * i / (n - 1), r - 2 * r * j / (n - 1)
    px, py = model.ray_to_pixel(camera, tx, ty)
    if normalized:
        return np.stack([(px + 0.5) / model.width, (py + 0.5) / model.height], axis=-1).astype(np.float32)
    return np.stack([px, py], axis=-1).astype(np.float32)


class GridCalibrationTests(unittest.TestCase):
    def test_lattice_convention_reproduces_the_model(self) -> None:
        cal = ls.GridCalibration({cam: model_lattice(MODEL, cam) for cam in ls.CAMERAS}, MODEL.width, MODEL.height, normalized=True)
        rng = np.random.default_rng(1)
        tx, ty = rng.uniform(-1.2, 1.2, 500), rng.uniform(-0.9, 0.9, 500)
        for cam in ls.CAMERAS:
            px, py = cal.lookup(cam, tx, ty)
            ex, ey = MODEL.ray_to_pixel(cam, tx, ty)
            self.assertLess(float(np.abs(px - ex).max()), 0.6, "bilinear interpolation of the 64x64 lattice is good to half a pixel inside +-50 deg (the stand-in lens curves more than the real one)")
            self.assertLess(float(np.abs(py - ey).max()), 0.6)
            self.assertLess(float(np.abs(px - ex).mean()), 0.3)
            self.assertEqual(cal(cam, 0.3, -0.2), (float(cal.lookup(cam, 0.3, -0.2)[0]), float(cal.lookup(cam, 0.3, -0.2)[1])), "the scalar call is the RayToPixel protocol")
        self.assertTrue(np.isnan(cal.lookup(ls.CAMERA_LEFT, 4.5, 0.0)[0]), "rays beyond the lattice have no pixel")
        pixels = ls.GridCalibration({cam: model_lattice(MODEL, cam, normalized=False) for cam in ls.CAMERAS}, MODEL.width, MODEL.height, normalized=False)
        self.assertTrue(np.allclose(pixels.lookup(ls.CAMERA_RIGHT, tx, ty), cal.lookup(ls.CAMERA_RIGHT, tx, ty), atol=1e-3), "a grid of pixel samples and the normalized lattice agree")
        # Rectifying through the grid is the same as rectifying through the function.
        via_grid = ls.Rectifier(cal, MODEL.width, MODEL.height, VIEW)
        via_model = ls.Rectifier(MODEL.ray_to_pixel, MODEL.width, MODEL.height, VIEW)
        for cam in ls.CAMERAS:
            for k in range(2):
                self.assertLess(float(np.abs(via_grid.maps[cam][k] - via_model.maps[cam][k]).max()), 0.6, "the vectorised lookup builds the same maps")
        raw_left, raw_right = sphere_scene(300.0).raw_pair(MODEL)
        a, b = via_grid.rectify_pair(raw_left, raw_right), via_model.rectify_pair(raw_left, raw_right)
        self.assertLess(float(np.abs(a[0].astype(int) - b[0].astype(int)).mean()), 1.0)
        with self.assertRaises(ValueError):
            ls.GridCalibration({1: np.zeros((64, 64))}, 640, 240)
        with self.assertRaises(ValueError):
            ls.GridCalibration({}, 640, 240)

    def test_load_prefers_the_function_samples(self) -> None:
        out = tempfile.mkdtemp(prefix="leap-cal-")
        for cam, side in ((ls.CAMERA_LEFT, "left"), (ls.CAMERA_RIGHT, "right")):
            np.save(os.path.join(out, f"leap_distortion_{side}.npy"), model_lattice(MODEL, cam))
        with self.assertRaises(FileNotFoundError):
            ls.GridCalibration.load(tempfile.mkdtemp(prefix="leap-empty-"))
        lattice = ls.GridCalibration.load(out, MODEL.width, MODEL.height)
        self.assertEqual(getattr(lattice, "source"), "leap_distortion")
        for cam, side in ((ls.CAMERA_LEFT, "left"), (ls.CAMERA_RIGHT, "right")):
            np.save(os.path.join(out, f"leap_r2p_{side}.npy"), model_lattice(MODEL, cam, normalized=False))
        samples = ls.GridCalibration.load(out, MODEL.width, MODEL.height)
        self.assertEqual(getattr(samples, "source"), "leap_r2p")
        self.assertEqual(getattr(ls.GridCalibration.load(out, MODEL.width, MODEL.height, prefer_samples=False), "source"), "leap_distortion")
        self.assertTrue(np.allclose(samples.lookup(1, 0.4, 0.1), lattice.lookup(1, 0.4, 0.1), atol=1e-3))


def tilted_calibration(tilt: ls.CameraAlignment) -> ls.RayToPixel:
    """The stand-in cameras' calibration as a service that has the RIGHT camera's frame wrong by ``tilt``."""
    def ray_to_pixel(camera: int, tx: float, ty: float) -> tuple[float, float]:
        if camera == ls.CAMERA_RIGHT:
            tx, ty = (float(v) for v in tilt.rotate(tx, ty))
        px, py = MODEL.ray_to_pixel(camera, tx, ty)
        return float(px), float(py)
    return ray_to_pixel


class CameraAlignmentTests(unittest.TestCase):
    def test_matrix_parse_and_rotate(self) -> None:
        self.assertTrue(ls.CameraAlignment().identity)
        self.assertTrue(np.allclose(ls.CameraAlignment().matrix, np.eye(3)))
        a = ls.CameraAlignment.parse("0.5,-0.3")
        self.assertEqual((a.pitch, a.roll, a.yaw), (0.5, -0.3, 0.0))
        self.assertEqual(ls.CameraAlignment.parse("1,2,3").yaw, 3.0)
        self.assertTrue(ls.CameraAlignment.parse("none").identity)
        self.assertEqual(ls.CameraAlignment.parse(a.name), a, "name round-trips through parse")
        for bad in ("1", "1,2,3,4", "20,0", "x,y"):
            with self.assertRaises(ValueError, msg=bad):
                ls.CameraAlignment.parse(bad)
        tx, ty = ls.CameraAlignment(pitch=0.5).rotate(0.0, 0.0)
        self.assertAlmostEqual(float(tx), 0.0)
        self.assertAlmostEqual(float(ty), -np.tan(np.radians(0.5)), places=6, msg="a pitch moves the centre ray vertically by its tangent")
        tx, ty = ls.CameraAlignment(roll=90.0).rotate(0.5, 0.0)
        self.assertAlmostEqual(float(tx), 0.0)
        self.assertAlmostEqual(float(ty), 0.5, msg="a roll turns the ray about the optical axis")
        self.assertTrue(np.allclose(ls.CameraAlignment(1.0, 2.0, 0.5).matrix @ ls.CameraAlignment(1.0, 2.0, 0.5).matrix.T, np.eye(3)))

    def test_estimate_recovers_a_tilted_right_camera_and_restores_the_depth(self) -> None:
        tilt = ls.CameraAlignment(pitch=0.6, roll=-0.4)
        view = ls.RectifiedView.from_fov(640, 480, 90.0)
        # Spheres spread across the field: the roll is read off how the row error grows with the column, so it needs matches far from the
        # centre (but clear of the leftmost numDisparities columns, which SGBM cannot match at all).
        scene = ls.SyntheticStereoScene([ls.Sphere((-80.0, -20.0, 250.0), 45.0), ls.Sphere((150.0, 30.0, 270.0), 45.0), ls.Sphere((0.0, -80.0, 280.0), 40.0), ls.Sphere((10.0, 90.0, 300.0), 45.0)])
        raw_left, raw_right = scene.raw_pair(MODEL)
        wrong = tilted_calibration(tilt)
        misaligned = ls.Rectifier(wrong, MODEL.width, MODEL.height, view)
        left, right = misaligned.rectify_pair(raw_left, raw_right)
        matches = ls.match_pair(left, right)
        self.assertGreater(len(matches), 40, "the textured spheres give plenty of matches")
        self.assertGreater(abs(float(np.median(matches[:, 3] - matches[:, 1]))), 2.0, "the tilt puts the right eye's features on other rows")
        fit = ls.estimate_alignment(left, right, view)
        self.assertAlmostEqual(fit.alignment.pitch, -tilt.pitch, delta=0.06, msg=fit.describe())
        self.assertAlmostEqual(fit.alignment.roll, -tilt.roll, delta=0.1, msg=fit.describe() + " (feature localisation is biased by a fraction of a pixel between the eyes, which the roll feels most)")
        self.assertLess(fit.after_px, 0.6)
        self.assertGreater(fit.before_px, 2.0)
        self.assertIn("pitch", fit.describe())
        aligned = ls.Rectifier(wrong, MODEL.width, MODEL.height, view, alignment=fit.alignment)
        self.assertEqual(set(aligned.alignment), {ls.CAMERA_RIGHT})
        self.assertEqual(ls.Rectifier(wrong, MODEL.width, MODEL.height, view, alignment=ls.CameraAlignment()).alignment, {}, "an identity alignment is dropped")
        again = ls.estimate_alignment(*aligned.rectify_pair(raw_left, raw_right), view, current=fit.alignment)
        self.assertAlmostEqual(again.alignment.pitch, fit.alignment.pitch, delta=0.05, msg="matches on an aligned pair describe the same calibration frame")
        _, truth = scene.render_pinhole(ls.CAMERA_LEFT, view)
        mask = interior((truth > 0) & (truth < 1000), 3)
        stereo = ls.StereoDepth(BASELINE, view.fx)
        valid_ideal, _, _ = errors(stereo.compute(*ls.Rectifier(MODEL.ray_to_pixel, MODEL.width, MODEL.height, view).rectify_pair(raw_left, raw_right)), truth, mask)
        valid_bad, _, _ = errors(stereo.compute(left, right), truth, mask)
        valid_good, median_good, _ = errors(stereo.compute(*aligned.rectify_pair(raw_left, raw_right)), truth, mask)
        self.assertGreater(valid_ideal, 0.9, f"a co-aligned pair: valid {valid_ideal:.3f}")
        self.assertGreater(valid_good, valid_ideal - 0.03, f"aligned by the fit: valid {valid_good:.3f} vs {valid_ideal:.3f} with the true calibration")
        self.assertLess(median_good, 0.03)
        self.assertLess(valid_bad, valid_good - 0.2, f"misaligned by {tilt.name}: valid {valid_bad:.3f} vs {valid_good:.3f} aligned")

    def test_estimator_accumulates_frames(self) -> None:
        view = ls.RectifiedView.from_fov(640, 480, 90.0)
        tilt = ls.CameraAlignment(pitch=0.3, roll=0.2)
        rect = ls.Rectifier(tilted_calibration(tilt), MODEL.width, MODEL.height, view)
        estimator = ls.AlignmentEstimator(view, min_matches=40, min_frames=3, max_frames=6)
        self.assertIn("collecting", estimator.describe())
        fits = []
        for k in range(6):
            scene = ls.SyntheticStereoScene([ls.Sphere((-150.0 + 25.0 * k, -20.0, 240.0 + 10.0 * k), 45.0), ls.Sphere((140.0, 30.0 - 15.0 * k, 300.0), 50.0)])
            fits.append(estimator.observe(*rect.rectify_pair(*scene.raw_pair(MODEL))))
            if estimator.done:
                break
        locked = [f for f in fits if f is not None]
        self.assertEqual(len(locked), 1, "exactly one fit is returned")
        self.assertGreaterEqual(estimator.frames, 3)
        self.assertAlmostEqual(locked[0].alignment.pitch, -tilt.pitch, delta=0.06)
        self.assertAlmostEqual(locked[0].alignment.roll, -tilt.roll, delta=0.1)
        self.assertTrue(estimator.done)
        self.assertIsNone(estimator.observe(*rect.rectify_pair(*scene.raw_pair(MODEL))), "a finished estimator ignores more frames")
        self.assertIn("pitch", estimator.describe())
        blank = ls.AlignmentEstimator(view, min_matches=40, min_frames=1, max_frames=2)
        black = np.zeros((view.height, view.width), dtype=np.uint8)
        self.assertIsNone(blank.observe(black, black))
        self.assertIsNone(blank.observe(black, black))
        self.assertTrue(blank.done)
        self.assertIn("gave up", blank.describe())
        with self.assertRaises(ValueError):
            ls.fit_alignment(np.zeros((2, 4)), view)


class InvalidationRuleTests(unittest.TestCase):
    def test_parameter_validation(self) -> None:
        for bad in ({"max_intensity": 10}, {"max_intensity": 256}, {"min_lit": -1}, {"lit_reference_mm": 0.0}, {"lit_window": 4}, {"min_texture": 300}, {"texture_window": 4}, {"uniqueness": 101}):
            with self.assertRaises(ValueError, msg=str(bad)):
                ls.StereoParams(**bad)  # type: ignore[arg-type]
        off = ls.StereoParams(min_intensity=0, max_intensity=255, min_texture=0, min_lit=0)
        self.assertIsNone(off.invalid_pixels(np.zeros((4, 4), np.uint8)), "every rule off: nothing to mask")
        self.assertIsNone(off.underlit_pixels(np.zeros((4, 4), np.uint8), np.zeros((4, 4), np.uint16)))

    def test_local_range(self) -> None:
        img = np.zeros((9, 9), dtype=np.uint8)
        img[4, 4] = 40
        spread = ls.local_range(img, 3)
        self.assertEqual(int(spread[4, 4]), 40)
        self.assertEqual(int(spread[3, 3]), 40, "within the 3x3 window of the bright pixel")
        self.assertEqual(int(spread[0, 0]), 0)
        self.assertEqual(spread.dtype, np.uint8)

    def test_saturated_pixels_carry_no_depth(self) -> None:
        left, right, truth = sphere_scene(300.0).stereo_pair(VIEW)
        left, right = left.copy(), right.copy()
        ys, xs = np.nonzero(sphere_mask(truth))
        cy, cx = int(ys.mean()), int(xs.mean())
        patch = (slice(cy - 8, cy + 8), slice(cx - 30, cx + 30))
        left[patch] = 255
        right[cy - 8:cy + 8, cx - 30 - 21:cx + 30 - 21] = 255  # the same blown-out patch, 21 px of disparity away
        kept = ls.StereoDepth(BASELINE, VIEW.fx, ls.StereoParams(max_intensity=255)).compute(left, right)
        gated = ls.StereoDepth(BASELINE, VIEW.fx).compute(left, right)
        self.assertEqual(int((gated[patch] > 0).sum()), 0, "saturated reference pixels are never a measurement")
        self.assertGreater(int((kept[patch] > 0).sum()), 0, "without the rule the matcher happily places pure white")
        outside = interior(sphere_mask(truth) & (left < 250), 3)
        self.assertGreater(float((gated[outside] > 0).mean()), 0.85, "the rest of the sphere is untouched")

    def test_underlit_matches_are_dropped_but_a_dim_far_hand_is_kept(self) -> None:
        left, right, truth = sphere_scene(200.0).stereo_pair(VIEW)
        dim_left = (left.astype(np.float32) * 0.15).astype(np.uint8)  # a surface at 200 mm that is as dark as a far wall
        dim_right = (right.astype(np.float32) * 0.15).astype(np.uint8)
        mask = interior(sphere_mask(truth), 2)
        lit = ls.StereoDepth(BASELINE, VIEW.fx, ls.StereoParams(min_lit=0, min_intensity=4)).compute(dim_left, dim_right)
        self.assertGreater(float((lit[mask] > 0).mean()), 0.5, "the matcher itself still places the dim sphere")
        ruled = ls.StereoDepth(BASELINE, VIEW.fx, ls.StereoParams(min_intensity=4)).compute(dim_left, dim_right)
        self.assertLess(float((ruled[mask] > 0).mean()), 0.05, "but 20 grey levels at 200 mm cannot be lit by the LEDs: dropped")
        far_left, far_right, far_truth = sphere_scene(400.0).stereo_pair(VIEW)
        far_mask = interior(sphere_mask(far_truth), 2)
        default = ls.StereoDepth(BASELINE, VIEW.fx).compute(far_left, far_right)
        self.assertGreater(float((default[far_mask] > 0).mean()), 0.9, "the sphere at 400 mm is dim, and rightly so: kept")
        params = ls.StereoParams()
        depth = np.full((4, 4), 250, dtype=np.uint16)
        depth[0, 0] = 0
        reference = np.full((4, 4), 20, dtype=np.uint8)
        under = params.underlit_pixels(reference, depth)
        assert under is not None
        self.assertFalse(under[0, 0], "a pixel without depth is not underlit")
        self.assertTrue(under[2, 2], "20 at 250 mm is below 20 * (300/250)^2 = 28.8")
        reference[2, 3] = 40
        self.assertFalse(params.underlit_pixels(reference, depth)[2, 2], "a lit neighbour within the window vouches for it")

    def test_texture_rule_drops_flat_regions(self) -> None:
        left, right, truth = sphere_scene(300.0).stereo_pair(VIEW)
        left, right = left.copy(), right.copy()
        left[200:236, 20:120] = 90   # a flat, bright patch in both eyes
        right[200:236, 20:120] = 90
        params = ls.StereoParams(min_texture=8)
        rejected = params.invalid_pixels(left)
        assert rejected is not None
        self.assertTrue(rejected[210:226, 30:110].all(), "a flat patch fails the texture rule")
        self.assertLess(float(rejected[interior(sphere_mask(truth), 3)].mean()), 0.5, "the grainy sphere mostly passes it")
        self.assertIsNone(ls.StereoParams(min_intensity=0, max_intensity=255, min_texture=0).invalid_pixels(left))
        gated = ls.StereoDepth(BASELINE, VIEW.fx, params).compute(left, right)
        self.assertEqual(int((gated[210:226, 30:110] > 0).sum()), 0)


def noisy_depth(truth: np.ndarray, rng: np.random.Generator, sigma_mm: float, hole_fraction: float, spike_fraction: float = 0.0, spike_mm: float = 80.0) -> np.ndarray:
    """A measurement of ``truth`` (``float32`` mm, 0 = nothing): Gaussian noise, random holes and, optionally, wrong matches."""
    out = truth + rng.normal(0.0, sigma_mm, truth.shape).astype(np.float32)
    if spike_fraction > 0:
        spikes = rng.random(truth.shape) < spike_fraction
        out[spikes] += rng.choice([-spike_mm, spike_mm], size=int(spikes.sum())).astype(np.float32)
    out[rng.random(truth.shape) < hole_fraction] = 0.0
    out[truth <= 0] = 0.0
    return np.clip(np.rint(out), 0, 65535).astype(np.uint16)


class DistanceConditioningTests(unittest.TestCase):
    """The far-hand additions: input gain, hole filling, the temporal median and the measurement statistics."""

    STEREO = ls.StereoDepth(BASELINE, VIEW.fx, ls.StereoParams(min_depth_mm=NEAR_MM, fill_radius=0, temporal=0))

    def test_gain_levels_a_dim_scene_to_a_bright_one(self) -> None:
        scene = sphere_scene(300.0)
        left, right, truth = scene.stereo_pair(VIEW)
        dim_l, dim_r = (np.clip(np.rint(img.astype(np.float32) * 0.3), 0, 255).astype(np.uint8) for img in (left, right))
        bright = ls.normalize_intensity(left, "gain", 31, floor=4.0)
        dim = ls.normalize_intensity(dim_l, "gain", 31, floor=4.0)
        capped = ls.normalize_intensity(dim_l, "gain", 31)
        mask = interior(sphere_mask(truth), 4)
        self.assertAlmostEqual(float(bright[mask].mean()), float(dim[mask].mean()), delta=8.0, msg="the local gain levels the sphere to the same brightness whatever the LEDs gave it")
        self.assertLess(float(capped[mask].mean()), float(dim[mask].mean()), "the default floor (24) caps the gain at 4x, so a 0.3x scene is not fully levelled")
        self.assertLess(abs(float(np.corrcoef(bright[mask].astype(float), dim[mask].astype(float))[0, 1]) - 1.0), 0.1, "and keeps the same shading")
        plain = ls.StereoDepth(BASELINE, VIEW.fx, ls.StereoParams(min_depth_mm=NEAR_MM, min_lit=0, min_intensity=4, fill_radius=0, temporal=0))
        gained = ls.StereoDepth(BASELINE, VIEW.fx, ls.StereoParams(min_depth_mm=NEAR_MM, min_lit=0, min_intensity=4, contrast="gain", contrast_floor=4.0, fill_radius=0, temporal=0))
        valid_bright = errors(plain.compute(left, right), truth, mask)[0]
        valid_dim = errors(plain.compute(dim_l, dim_r), truth, mask)[0]
        valid_dim_gained = errors(gained.compute(dim_l, dim_r), truth, mask)[0]
        self.assertGreater(valid_bright, 0.9)
        self.assertGreaterEqual(valid_dim_gained, min(valid_bright, valid_dim + 0.05) - 0.05, (valid_bright, valid_dim, valid_dim_gained))
        self.assertEqual(ls.normalize_intensity(left, "none").tobytes(), left.tobytes())
        lcn = ls.normalize_intensity(dim_l, "lcn", 15)
        self.assertAlmostEqual(float(lcn[mask].mean()), 128.0, delta=8.0, msg="local contrast normalisation centres on mid grey")
        with self.assertRaises(ValueError):
            ls.normalize_intensity(left, "gain", 10)
        with self.assertRaises(ValueError):
            ls.normalize_intensity(left, "nope")

    def test_the_rules_keep_looking_at_the_original_image(self) -> None:
        scene = sphere_scene(300.0)
        left, right, truth = scene.stereo_pair(VIEW)
        dark_l, dark_r = (np.clip(np.rint(img.astype(np.float32) * 0.04), 0, 255).astype(np.uint8) for img in (left, right))
        gained = ls.StereoDepth(BASELINE, VIEW.fx, ls.StereoParams(min_depth_mm=NEAR_MM, contrast="gain", contrast_floor=1.0, fill_radius=0, temporal=0))
        self.assertLess(float((gained.compute(dark_l, dark_r) > 0).mean()), 0.02, "a scene below min_intensity yields nothing however much it is amplified for the matcher")

    def test_hole_filler_fills_small_holes_and_leaves_a_finger_gap_open(self) -> None:
        tol = self.STEREO.tolerance_mm(1.5)
        depth = np.full((40, 60), 300, dtype=np.uint16)
        depth[10:13, 20:23] = 0          # a 3x3 hole in a flat surface
        depth[20, 40] = 0                # a single missing pixel
        depth[:, 30:38] = 0              # an 8 px gap between two "fingers"
        depth[30:40, :] = 0              # the background: nothing there
        filled = ls.fill_holes(depth, 2, tol)
        self.assertTrue((filled[10:13, 20:23] == 300).all(), "the small hole is filled with its surroundings")
        self.assertEqual(int(filled[20, 40]), 300)
        self.assertTrue((filled[:30, 32:36] == 0).all(), "the middle of the finger gap stays open")
        self.assertTrue((filled[33:, :] == 0).all(), "the background is not invented")
        self.assertTrue((filled[:30, :30] > 0).all())
        # Surroundings that disagree with each other (a finger and the backdrop) do not fill.
        mixed = np.full((20, 20), 300, dtype=np.uint16)
        mixed[:, 10:] = 1200
        mixed[8:11, 9:12] = 0
        self.assertTrue((ls.fill_holes(mixed, 2, tol)[8:11, 9:12] == 0).all(), "a hole between a finger and the backdrop stays a hole")
        mixed[8:11, 9:12] = 0
        self.assertTrue((ls.fill_holes(mixed, 2, 2000.0)[8:11, 9:12] > 0).all(), "unless the tolerance allows it")
        self.assertIs(ls.fill_holes(depth, 0, tol), depth)
        self.assertEqual(filled.dtype, np.uint16)
        keep_out = np.zeros(depth.shape, dtype=bool)
        keep_out[10:13, 20:23] = True
        self.assertTrue((ls.fill_holes(depth, 2, tol, exclude=keep_out)[10:13, 20:23] == 0).all(), "excluded pixels (the rules' rejections) stay empty")

    def test_hole_filler_keeps_the_synthetic_sphere_accurate(self) -> None:
        scene = sphere_scene(300.0)
        left, right, truth = scene.stereo_pair(VIEW)
        plain = self.STEREO.compute(left, right)
        filled = ls.StereoDepth(BASELINE, VIEW.fx, ls.StereoParams(min_depth_mm=NEAR_MM, fill_radius=2, temporal=0)).compute(left, right)
        mask = interior(sphere_mask(truth), 3)
        self.assertGreaterEqual(float((filled[mask] > 0).mean()), float((plain[mask] > 0).mean()))
        self.assertLess(errors(filled, truth, mask)[1], 0.02)
        self.assertTrue(((filled == plain) | (plain == 0)).all(), "the filler only writes into holes")

    def test_temporal_median_lowers_noise_and_fills_holes_on_a_static_scene(self) -> None:
        rng = np.random.default_rng(1)
        truth = np.zeros((60, 80), dtype=np.float32)
        truth[10:50, 10:70] = 320.0
        sigma = 12.0
        filt = self.STEREO.temporal_filter() if self.STEREO.params.temporal > 1 else ls.TemporalDepthFilter(3, self.STEREO.tolerance_mm(1.5))
        frames = [noisy_depth(truth, rng, sigma, 0.2) for _ in range(3)]
        out = frames[0]
        for f in frames:
            out = filt.push(f)
        inside = truth > 0
        single = frames[-1]
        self.assertGreater(float((out[inside] > 0).mean()), float((single[inside] > 0).mean()) + 0.05, "holes that flicker are filled from older frames (where two older frames agree)")
        valid_out, valid_one = (out[inside] > 0), (single[inside] > 0)
        err_out = float(np.abs(out[inside][valid_out].astype(np.float32) - 320.0).std())
        err_one = float(np.abs(single[inside][valid_one].astype(np.float32) - 320.0).std())
        self.assertLess(err_out, 0.92 * err_one, (err_out, err_one))
        self.assertTrue((out[~inside] == 0).all(), "nothing appears where nothing was measured")
        self.assertEqual(out.dtype, np.uint16)
        # Noise well inside the tolerance (4 mm against 24): every sample agrees and the median of three divides it by about 1.4.
        quiet = ls.TemporalDepthFilter(3, self.STEREO.tolerance_mm(1.5))
        for _ in range(3):
            q = quiet.push(noisy_depth(truth, rng, 4.0, 0.0))
        self.assertLess(float(np.abs(q[inside].astype(np.float32) - 320.0).std()), 0.8 * 4.0)
        # A lone speckle in one frame is not carried forward: two older frames must agree to fill a hole.
        speckle = np.zeros((60, 80), dtype=np.uint16)
        speckle[5, 5] = 300
        f2 = ls.TemporalDepthFilter(3, self.STEREO.tolerance_mm(1.5))
        f2.push(speckle)
        f2.push(np.zeros_like(speckle))
        self.assertEqual(int(f2.push(np.zeros_like(speckle))[5, 5]), 0)
        # Warm-up passes the input through; a shape change resets.
        f3 = ls.TemporalDepthFilter(3, 10.0)
        first = np.full((4, 4), 200, dtype=np.uint16)
        self.assertIs(f3.push(first), first)
        f3.push(np.full((4, 4), 210, dtype=np.uint16))
        self.assertEqual(int(f3.push(np.full((4, 4), 205, dtype=np.uint16))[0, 0]), 205, "the median of three agreeing samples")
        self.assertEqual(len(f3.history), 3)
        f3.push(np.full((2, 2), 1, dtype=np.uint16))
        self.assertEqual(len(f3.history), 1)
        self.assertIsNone(ls.StereoDepth(BASELINE, VIEW.fx, ls.StereoParams(temporal=0)).temporal_filter())

    def test_temporal_median_does_not_smear_a_moving_hand(self) -> None:
        tol = self.STEREO.tolerance_mm(1.5)  # 1.5 px of disparity: 21 mm at 300 mm
        filt = ls.TemporalDepthFilter(3, tol)
        a = np.zeros((30, 40), dtype=np.uint16)
        a[5:25, 5:20] = 300                       # the hand on the left
        b = np.zeros_like(a)
        b[5:25, 20:35] = 300                      # jumped to the right
        c = np.zeros_like(a)
        c[5:25, 20:35] = 400                      # and receded by 100 mm, far beyond the tolerance
        filt.push(a)
        out_b = filt.push(b)
        self.assertTrue((out_b[5:25, 20:35] == 300).all(), "the newest measurement is authoritative")
        self.assertTrue((out_b[5:25, 5:20] == 0).all(), "one older sample alone does not fill the vacated pixels")
        out_c = filt.push(c)
        self.assertTrue((out_c[5:25, 20:35] == 400).all(), "a sample that disagrees with the newest by more than the tolerance is dropped: no lag")
        self.assertTrue((out_c[5:25, 5:20] == 0).all())
        # Within the tolerance the samples are averaged: a slow move lags by at most the tolerance.
        slow = ls.TemporalDepthFilter(3, tol)
        for z in (300, 306, 312):
            out = slow.push(np.full((4, 4), z, dtype=np.uint16))
        self.assertEqual(int(out[0, 0]), 306)
        # The majority rule: a lone wrong newest sample is outvoted by two agreeing older ones, a jump by both is not.
        vote = ls.TemporalDepthFilter(3, tol, majority=True)
        vote.push(np.full((4, 4), 300, dtype=np.uint16))
        vote.push(np.full((4, 4), 302, dtype=np.uint16))
        self.assertEqual(int(vote.push(np.full((4, 4), 500, dtype=np.uint16))[0, 0]), 301)
        self.assertEqual(int(vote.push(np.full((4, 4), 500, dtype=np.uint16))[0, 0]), 500)
        # The general (any length) path agrees with the three-frame OpenCV path to the rounding of a half.
        rng = np.random.default_rng(3)
        truth = np.zeros((40, 50), dtype=np.float32)
        truth[5:35, 5:45] = 350.0
        frames = [noisy_depth(truth, rng, 10.0, 0.25, 0.05) for _ in range(4)]
        fast, general = ls.TemporalDepthFilter(3, tol), ls.TemporalDepthFilter(3, tol)
        general.fast = False
        for f in frames:
            out_fast, out_general = fast.push(f), general.push(f)
        self.assertLessEqual(int(np.abs(out_fast.astype(int) - out_general.astype(int)).max()), 1)
        self.assertGreater(float((out_fast > 0).mean()), 0.3)

    def test_depth_statistics(self) -> None:
        rng = np.random.default_rng(2)
        truth = np.zeros((120, 160), dtype=np.float32)
        truth[20:100, 30:130] = 300.0
        clean = noisy_depth(truth, rng, 2.0, 0.0)
        noisy = noisy_depth(truth, rng, 15.0, 0.3)
        s_clean, s_noisy = ls.depth_statistics(clean, 100, 450), ls.depth_statistics(noisy, 100, 450)
        self.assertEqual(set(s_clean), {"depthNoiseMm", "depthValidFraction"})
        self.assertGreater(s_clean["depthValidFraction"], 0.99)
        self.assertLess(s_clean["depthNoiseMm"], 3.0)
        self.assertLess(s_noisy["depthValidFraction"], 0.8)
        self.assertGreater(s_noisy["depthValidFraction"], 0.6)
        self.assertGreater(s_noisy["depthNoiseMm"], 10.0)
        self.assertEqual(ls.depth_statistics(np.zeros((10, 10), dtype=np.uint16), 100, 450), {"depthNoiseMm": 0.0, "depthValidFraction": 0.0})
        beyond = np.full((20, 20), 900, dtype=np.uint16)
        self.assertEqual(ls.depth_statistics(beyond, 100, 450)["depthValidFraction"], 0.0, "what lies beyond the box is not foreground")

    def test_synthetic_source_reports_stats_and_runs_the_temporal_filter(self) -> None:
        src = lsrc.LeapSyntheticSource(VIEW, ls.StereoParams(min_depth_mm=NEAR_MM), paced=False, absences=False)
        src.start()
        assert src.temporal is not None
        self.assertEqual(src.temporal.length, 3)
        frames = [src.frame_at(0.05 * i) for i in range(4)]
        self.assertIsInstance(frames[0], lsrc.LeapDepthFrame)
        self.assertIsInstance(frames[0], db.DepthFrame)
        self.assertEqual(set(frames[-1].stats), {"depthNoiseMm", "depthValidFraction"})
        self.assertGreater(frames[-1].stats["depthValidFraction"], 0.5)
        self.assertLess(frames[-1].stats["depthNoiseMm"], 15.0)
        self.assertEqual(len(src.temporal.history), 3)
        src.start()
        self.assertEqual(len(src.temporal.history), 0, "start() resets the history")
        plain = lsrc.LeapSyntheticSource(VIEW, ls.StereoParams(min_depth_mm=NEAR_MM, temporal=0), paced=False, absences=False)
        self.assertIsNone(plain.temporal)

    def test_parameter_validation_and_flags(self) -> None:
        for bad in (dict(p1=8, p2=4), dict(contrast="clahe"), dict(contrast_window=8), dict(fill_radius=-1), dict(temporal=-1), dict(fill_tolerance_px=0.0), dict(mode="hh5")):
            with self.assertRaises(ValueError, msg=str(bad)):
                ls.StereoParams(**bad)  # type: ignore[arg-type]
        for mode in ("hh4", "hh", "sgbm", "3way"):
            ls.StereoDepth(BASELINE, VIEW.fx, ls.StereoParams(mode=mode))
        source = lsrc.build_parser().parse_args(["--contrast", "gain", "--contrast-window", "63", "--p1", "16", "--p2", "64", "--speckle", "100", "--fill-radius", "3", "--temporal", "5"])
        params = lsrc.stereo_params_from_args(source, 100.0, prefix="")
        self.assertEqual((params.contrast, params.contrast_window, params.p1, params.p2, params.speckle_window, params.fill_radius, params.temporal), ("gain", 63, 16, 64, 100, 3, 5))
        defaults = lsrc.stereo_params_from_args(lsrc.build_parser().parse_args([]), 100.0, prefix="")
        self.assertEqual(defaults, ls.StereoParams(min_depth_mm=100.0))
        self.assertEqual((defaults.median, defaults.fill_radius, defaults.temporal, defaults.contrast), (5, 2, 3, "none"))

    def test_tolerance_scales_with_the_square_of_the_depth(self) -> None:
        tol = self.STEREO.tolerance_mm(1.5)
        z = np.array([200.0, 300.0, 450.0], dtype=np.float32)
        expected = 1.5 * z * z / (BASELINE * VIEW.fx)
        self.assertTrue(np.allclose(tol(z), expected))
        self.assertAlmostEqual(float(tol(np.float32(300.0))), 1.5 * self.STEREO.depth_step_mm(300.0), places=4)


class DistanceSimulationTests(unittest.TestCase):
    """``stereo_lab.DistanceSimulator``: the calibration inversion and the re-imaging of a pair to a farther scene."""

    @classmethod
    def setUpClass(cls) -> None:
        import stereo_lab as lab  # noqa: PLC0415

        cls.lab = lab
        cls.cal = ls.GridCalibration({cam: model_lattice(MODEL, cam, normalized=False) for cam in ls.CAMERAS}, MODEL.width, MODEL.height, normalized=False)

    def test_calibration_inversion_round_trips(self) -> None:
        tx, ty = self.lab.invert_calibration(self.cal, ls.CAMERA_LEFT)
        self.assertEqual(tx.shape, (MODEL.height, MODEL.width))
        ok = np.isfinite(tx) & np.isfinite(ty)
        self.assertGreater(float(ok.mean()), 0.9)
        px, py = self.cal.lookup(ls.CAMERA_LEFT, tx[ok], ty[ok])
        gx, gy = np.meshgrid(np.arange(MODEL.width, dtype=np.float64), np.arange(MODEL.height, dtype=np.float64))
        self.assertLess(float(np.hypot(px - gx[ok], py - gy[ok]).max()), 0.05)
        mx, my = MODEL.pixel_to_ray(ls.CAMERA_LEFT, gx[ok], gy[ok])
        self.assertLess(float(np.abs(tx[ok] - mx).max()), 0.02, "the inverted grid agrees with the stand-in camera's own inverse")

    def test_reimaged_scene_has_scaled_disparity_and_a_dimmer_hand(self) -> None:
        lab = self.lab
        scene = sphere_scene(260.0, radius=45.0, background_mm=None)
        raw_left, raw_right = scene.raw_pair(MODEL)
        frame = lab.Frame("000", raw_left, raw_right)
        sim = lab.DistanceSimulator(self.cal, None, hand_threshold=40)
        far = sim.simulate(frame, 260.0 / 390.0, 390.0, seed=1)
        self.assertEqual(far.name, "000@390#1")
        self.assertTrue(far.simulated)
        self.assertAlmostEqual(far.scale, 2.0 / 3.0, places=6)
        rect = ls.Rectifier(self.cal, MODEL.width, MODEL.height, VIEW)
        stereo = ls.StereoDepth(BASELINE, VIEW.fx, ls.StereoParams(min_depth_mm=NEAR_MM, min_lit=0, min_intensity=4, fill_radius=0, temporal=0))
        near = stereo.compute(*rect.rectify_pair(raw_left, raw_right))
        far_depth = stereo.compute(*rect.rectify_pair(far.raw_left, far.raw_right))
        z_near = float(np.median(near[near > 0]))
        z_far = float(np.median(far_depth[far_depth > 0]))
        self.assertAlmostEqual(z_near, 260.0 - 45.0 + 10.0, delta=15.0)
        self.assertAlmostEqual(z_far / z_near, 1.5, delta=0.08, msg="the scene is 1.5x farther")
        self.assertLess(float((far_depth > 0).sum()), 0.75 * float((near > 0).sum()), "and covers fewer pixels (the matcher widens both silhouettes by a few pixels)")
        self.assertLess(float(far.raw_left[far.raw_left > 0].mean()), 0.75 * float(raw_left[raw_left > 0].mean()), "and is dimmer")
        truths = lab.TruthCache(self.cal, None, 40, NEAR_MM, FAR_MM)
        truth = truths.truth(far, VIEW)
        self.assertTrue(truth.hand.any())
        self.assertGreater(truth.box[1], 450.0, "the box stretches to hold the farther hand")
        core = truth.hand & (truth.depth > 0)
        self.assertAlmostEqual(float(np.median(truth.depth[core])), z_far, delta=25.0)


class ParserDefaultTests(unittest.TestCase):
    def test_bridge_and_source_parsers_agree_on_the_stereo_defaults(self) -> None:
        bridge = db.build_parser().parse_args(["--source", "leap"])
        source = lsrc.build_parser().parse_args([])
        for name in ("min_intensity", "max_intensity", "min_lit", "min_texture", "uniqueness", "block", "mode", "matcher", "align", "calibration",
                     "contrast", "contrast_window", "p1", "p2", "speckle", "fill_radius", "temporal"):
            self.assertEqual(getattr(bridge, "leap_" + name), getattr(source, name), name)
        self.assertEqual(db.build_parser().parse_args(["--source", "leap", "--leap-mode", "hh4"]).leap_mode, "hh4")
        self.assertEqual(tuple(bridge.leap_view), lsrc.DEFAULT_VIEW)
        self.assertEqual(tuple(source.view), lsrc.DEFAULT_VIEW)
        self.assertEqual(db.LEAP_DEFAULT_VIEW, lsrc.DEFAULT_VIEW)
        self.assertEqual(db.LEAP_DEFAULT_SURFACE, lsrc.DEFAULT_SURFACE)
        self.assertEqual(bridge.leap_fov, lsrc.DEFAULT_FOV_DEG)
        params = lsrc.stereo_params_from_args(bridge, 100.0, prefix="leap_")
        self.assertEqual(params, ls.StereoParams(min_depth_mm=100.0), "the bridge's defaults build the module's default parameters")
        self.assertEqual(lsrc.stereo_params_from_args(source, 100.0, prefix=""), params)
        custom = db.build_parser().parse_args(["--source", "leap", "--leap-min-lit", "0", "--leap-mode", "hh", "--leap-block", "7"])
        self.assertEqual(lsrc.stereo_params_from_args(custom, 100.0, prefix="leap_"), ls.StereoParams(min_depth_mm=100.0, min_lit=0, mode="hh", block_size=7))

    def test_surface_default_follows_the_source(self) -> None:
        self.assertEqual(db.resolve_surface(db.build_parser().parse_args(["--source", "leap"])), db.LEAP_DEFAULT_SURFACE)
        self.assertEqual(db.resolve_surface(db.build_parser().parse_args(["--source", "leap-synthetic"])), db.LEAP_DEFAULT_SURFACE)
        self.assertEqual(db.resolve_surface(db.build_parser().parse_args([])), db.DEFAULT_SURFACE, "other sources keep 64x48")
        self.assertEqual(db.resolve_surface(db.build_parser().parse_args(["--source", "leap", "--surface", "8", "6"])), (8, 6))
        self.assertEqual(db.AnalyzerConfig().surface, db.DEFAULT_SURFACE)


class StereoLabTests(unittest.TestCase):
    """``stereo_lab.py`` on a synthetic dump directory laid out like ``leap_source.py --dump-images`` writes it."""

    @classmethod
    def setUpClass(cls) -> None:
        import cv2  # noqa: PLC0415

        cls.out = tempfile.mkdtemp(prefix="leap-lab-")
        rect = ls.Rectifier(MODEL.ray_to_pixel, MODEL.width, MODEL.height, VIEW)
        for i, z in enumerate((260.0, 330.0)):
            scene = ls.SyntheticStereoScene([ls.Sphere((10.0, -20.0, z), 45.0), ls.Capsule((30.0, 40.0, z + 20.0), (80.0, 200.0, z + 90.0), 28.0)])
            raw_left, raw_right = scene.raw_pair(MODEL)
            left, right = rect.rectify_pair(raw_left, raw_right)
            stem = os.path.join(cls.out, f"leap_{i:03d}")
            for suffix, image in (("_raw_left", raw_left), ("_raw_right", raw_right), ("_left", left), ("_right", right)):
                cv2.imwrite(stem + suffix + ".png", image)
        for cam, side in ((ls.CAMERA_LEFT, "left"), (ls.CAMERA_RIGHT, "right")):
            np.save(os.path.join(cls.out, f"leap_distortion_{side}.npy"), model_lattice(MODEL, cam))

    def test_verify_list_and_a_run_write_the_contact_sheet(self) -> None:
        import stereo_lab as lab  # noqa: PLC0415

        frames = lab.load_frames(self.out)
        self.assertEqual([f.name for f in frames], ["000", "001"])
        self.assertEqual(lab.load_frames(self.out, ["001"])[0].name, "001")
        report = lab.verify_lattice(frames, self.out, VIEW)
        self.assertTrue(any("lattice frame 000 left" in line and "mean 0." in line for line in report), report)
        self.assertTrue(any("samples: " in line for line in report), "no function samples in this dump: says so")
        configs = lab.build_configs()
        self.assertIn("old", configs)
        self.assertIn("480x360", configs)
        self.assertEqual(configs["480x360"].params.mode, "3way")
        self.assertEqual(configs["old"].params.min_lit, 0)
        png = os.path.join(self.out, "sheet.png")
        with contextlib.redirect_stdout(io.StringIO()) as captured:
            code = lab.main(["--input", self.out, "--configs", "old", "320x240", "--repeat", "1", "--align", "none", "--out", png, "--hand-threshold", "40"])
        self.assertEqual(code, 0)
        text = captured.getvalue()
        self.assertIn("calibration: leap_distortion", text)
        self.assertRegex(text, r"old\s+000\s+[\d.]+\s+[\d.]+\s+\d+\s+\d+")
        self.assertIn("wrote " + png, text)
        self.assertTrue(os.path.isfile(png))
        with contextlib.redirect_stdout(io.StringIO()) as captured:
            self.assertEqual(lab.main(["--list"]), 0)
        self.assertIn("480x360", captured.getvalue())
        with contextlib.redirect_stdout(io.StringIO()) as captured:
            self.assertEqual(lab.main(["--input", self.out, "--verify"]), 0)
        self.assertIn("lattice frame 001 right", captured.getvalue())
        with self.assertRaises(FileNotFoundError):
            lab.load_calibration(self.out, "samples", MODEL.width, MODEL.height)
        with contextlib.redirect_stdout(io.StringIO()) as captured:
            code = lab.main(["--input", self.out, "--configs", "320x240", "--frames", "001", "--repeat", "1", "--align", "auto", "--out", png, "--hand-threshold", "40"])
        self.assertEqual(code, 0)
        self.assertIn("alignment (auto): pitch", captured.getvalue(), "the co-aligned stand-in cameras fit a near-zero alignment")


# ---- CLI --------------------------------------------------------------------- #


def run_bridge(*extra: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run([sys.executable, os.path.join(HERE, "depth_bridge.py"), *extra], capture_output=True, text=True, timeout=120, check=False)


class DumpCliTests(ProtocolAssertions):
    def test_leap_synthetic_dump_matches_the_protocol(self) -> None:
        proc = run_bridge("--source", "leap-synthetic", "--dump", "3", "--surface", "8", "6")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        lines = [json.loads(line) for line in proc.stdout.splitlines() if line.strip()]
        self.assertEqual(len(lines), 4)
        hello, frames = lines[0], lines[1:]
        self.assert_hello(hello)
        self.assertEqual(hello["source"], "leap-synthetic")
        self.assertEqual(hello["box"]["z"], [0.1, 0.45], "the Leap sources default to the controller's range")
        self.assertEqual(grid_sizes(hello), ((32, 24), (32, 24, 16), (8, 6)))
        self.assertIs(hello["skeleton"], True)
        for seq, frame in enumerate(frames):
            self.assert_frame(frame, *grid_sizes(hello))
            self.assertEqual(frame["seq"], seq)
            self.assertEqual(frame["stats"]["frameWidth"], float(lsrc.DEFAULT_VIEW[0]), "the depth image is the default rectified view")  # type: ignore[index]
            self.assertEqual(frame["stats"]["trackedHands"], 1.0)  # type: ignore[index]
            self.assertEqual(len(frame["hands"]), 1, "the script starts with the hand above the device")  # type: ignore[arg-type]
            hand = frame["hands"][0]  # type: ignore[index]
            self.assertEqual(set(hand), TRACKED_HAND_KEYS)
            self.assertEqual(hand["skeleton"]["type"], "right")
            self.assertEqual(hand["openness"], 0.0, "a fist")
            self.assertFalse(any(f["extended"] for f in hand["skeleton"]["fingers"]))
            surface = base64.b64decode(frame["surface"])  # type: ignore[arg-type]
            self.assertEqual(len(surface), 48)
            self.assertTrue(any(surface))
        fixed = run_bridge("--source", "leap-synthetic", "--dump", "1", "--no-voxels", "--no-occupancy", "--no-surface", "--leap-hand-frame", "u-x_v+z_ref+")
        self.assertEqual(fixed.returncode, 0, fixed.stderr)
        self.assertEqual(len(json.loads(fixed.stdout.splitlines()[1])["hands"]), 1, "a fixed convention is used as given (here a wrong one, but it still projects)")
        bad = run_bridge("--source", "leap-synthetic", "--dump", "1", "--leap-hand-frame", "u+y_v-z_ref-")
        self.assertNotEqual(bad.returncode, 0)
        self.assertIn("unknown hand frame", bad.stderr)

    def test_range_flags_override_the_leap_defaults(self) -> None:
        proc = run_bridge("--source", "leap-synthetic", "--dump", "1", "--near", "0.2", "--far", "0.5", "--no-voxels", "--no-occupancy")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        hello = json.loads(proc.stdout.splitlines()[0])
        self.assertEqual(hello["box"]["z"], [0.2, 0.5])
        self.assertEqual(json.loads(run_bridge("--dump", "1").stdout.splitlines()[0])["box"]["z"], [0.4, 1.2], "other sources keep their range")

    def test_missing_library_is_a_clear_error(self) -> None:
        proc = run_bridge("--source", "leap", "--dump", "1", "--leapc", os.path.join(HERE, "no-such-LeapC.dll"))
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn("no-such-LeapC.dll", proc.stderr)

    def test_dump_images_writes_pngs(self) -> None:
        out = tempfile.mkdtemp(prefix="leap-dump-")
        proc = subprocess.run([sys.executable, os.path.join(HERE, "leap_source.py"), "--synthetic", "--dump-images", "2", "--out", out], capture_output=True, text=True, timeout=120, check=False)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        names = sorted(os.listdir(out))
        self.assertEqual(names, sorted(f"leap_{i:03d}_{kind}.png" for i in range(2) for kind in ("left", "right", "depth", "depth_preview")))
        self.assertIn("in [100, 450] mm", proc.stderr)
        self.assertNotIn("--swap-cameras", proc.stderr, "the synthetic pair is in the right order")
        self.assertRegex(proc.stderr, r"1 tracked hand\(s\), 2[5-7] of 27 joints on a scan pixel within 30 mm")
        self.assertIn("hand frame candidates after 2 scored frames", proc.stderr, "auto mode prints the table")
        table = proc.stderr.split("hand frame candidates")[1].splitlines()
        leader = table[1].split()
        self.assertEqual(leader[0], "u+x_v-z_ref-", table)
        self.assertGreaterEqual(float(leader[1]), 0.9, "the truth leads even with the hand centred at t = 0")
        self.assertIn("<- leading", table[1], "two frames are not enough to lock, so the table marks the leader")
        self.assertLess(float(table[2].split()[1]), 0.8)
        proc = subprocess.run([sys.executable, os.path.join(HERE, "leap_source.py"), "--synthetic", "--dump-images", "1", "--out", out, "--hand-frame", "u+x_v-z_ref-"], capture_output=True, text=True, timeout=120, check=False)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn("hand frame u+x_v-z_ref- (fixed)", proc.stderr)
        proc = subprocess.run([sys.executable, os.path.join(HERE, "leap_source.py"), "--synthetic", "--dump-images", "1", "--out", out, "--hand-frame", "nope"], capture_output=True, text=True, timeout=120, check=False)
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn("unknown hand frame", proc.stderr)


if __name__ == "__main__":
    unittest.main(verbosity=2)
