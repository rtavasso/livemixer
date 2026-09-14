#!/usr/bin/env python3
"""Offline stereo experiments on dumped Leap Motion Controller frames.

``leap_source.py --dump-images`` leaves raw stereo pairs, the bridge's own
rectified views and depth maps, and the device's calibration grids in a
directory. This tool re-rectifies and re-matches the raw pairs offline under
any number of configurations (view size and field of view, block size, SGBM
mode, block matching, invalidation rules, input conditioning, hole filling),
times each one, scores the hand (valid depth on it, depth noise, holes,
phantom depth around it, whether spread fingers stay separate) and writes a
labelled contact sheet so the choices can be checked by eye::

    python bridge/stereo_lab.py --input test-results/leap --out test-results/leap/stereo_lab.png
    python bridge/stereo_lab.py --configs base 640x480 640x480-b3 --frames 001 --repeat 10
    python bridge/stereo_lab.py --simulate-distance 350 450 550 --configs 480x360 gain31   # a far hand from the 27 cm frame
    python bridge/stereo_lab.py --simulate-distance 450 --temporal 3 --configs 480x360      # the temporal median on it
    python bridge/stereo_lab.py --verify          # lattice convention against the dumped rectified views
    python bridge/stereo_lab.py --list            # the configuration names

No hardware and no LeapC needed: the calibration comes from the dumped
``leap_r2p_*.npy`` (samples of ``LeapRectilinearToPixel``, preferred) or
``leap_distortion_*.npy`` (the image events' lattices), see
:class:`leap_stereo.GridCalibration`. The alignment of the right camera
(``--align auto``) is estimated from the frames' feature matches before the
configurations run, the same way ``--leap-align auto`` does it live.

Simulating distance
-------------------
The dumps hold a hand at one height. ``--simulate-distance Z [Z ...]`` (mm)
moves the reference frame's scene to each ``Z``: every raw image is
re-imaged through the device's own calibration with the ray slopes scaled
by ``s = Z_ref / Z`` (a point at depth ``Z0`` moves to ``Z0 / s``, so
disparities scale by ``s`` exactly and the raw sensor's 2.4 x 1.2 px/deg
sampling of the smaller hand is real, not a blurred copy), the hand is
dimmed by ``s^2`` like the LEDs' inverse-square falloff, and sensor noise is
topped up to what the original frame carries. The truth for such a frame is
the reference frame's own depth (full SGBM, holes filled, smoothed) scaled
the same way, so the scores also report the depth error and the wrong
matches, which a real frame cannot.
"""
from __future__ import annotations

import argparse
import glob
import math
import os
import re
import sys
import time
from dataclasses import dataclass, field, replace
from typing import Any, Sequence

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
if __package__:
    from . import leap_stereo as ls
else:
    if HERE not in sys.path:
        sys.path.insert(0, HERE)
    import leap_stereo as ls  # type: ignore[no-redef]

import cv2  # noqa: E402  (leap_stereo already requires it)

DEFAULT_INPUT = os.path.join("test-results", "leap")


# --------------------------------------------------------------------------- #
# Frames and calibration
# --------------------------------------------------------------------------- #


@dataclass
class Frame:
    name: str
    raw_left: np.ndarray
    raw_right: np.ndarray
    ref_left: np.ndarray | None = None   # the bridge's own rectified view, for --verify
    ref_right: np.ndarray | None = None
    scale: float = 1.0                    # < 1: a distance simulation of ``reference`` (see simulate_distance)
    reference: "Frame | None" = None
    depth_mm: float = 0.0                 # the simulated hand height (0 for a dumped frame)
    seed: int = 0

    @property
    def simulated(self) -> bool:
        return self.reference is not None


def load_frames(directory: str, names: Sequence[str] | None = None) -> list[Frame]:
    """``leap_NNN_raw_{left,right}.png`` pairs in ``directory`` (all of them, or the given NNN names)."""
    if names:
        stems = [os.path.join(directory, f"leap_{n}") for n in names]
    else:
        stems = sorted(p[: -len("_raw_left.png")] for p in glob.glob(os.path.join(directory, "leap_*_raw_left.png")))
    frames = []
    for stem in stems:
        left, right = cv2.imread(stem + "_raw_left.png", cv2.IMREAD_GRAYSCALE), cv2.imread(stem + "_raw_right.png", cv2.IMREAD_GRAYSCALE)
        if left is None or right is None:
            raise FileNotFoundError(f"{stem}_raw_left.png / _raw_right.png")
        ref_l, ref_r = cv2.imread(stem + "_left.png", cv2.IMREAD_GRAYSCALE), cv2.imread(stem + "_right.png", cv2.IMREAD_GRAYSCALE)
        frames.append(Frame(os.path.basename(stem)[len("leap_"):], left, right, ref_l, ref_r))
    if not frames:
        raise FileNotFoundError(f"no leap_*_raw_left.png in {directory}")
    return frames


def load_calibration(directory: str, which: str, raw_width: int, raw_height: int) -> ls.GridCalibration:
    """``which``: ``samples`` (leap_r2p_*.npy), ``lattice`` (leap_distortion_*.npy) or ``auto`` (samples if present)."""
    if which == "lattice":
        return ls.GridCalibration.load(directory, raw_width, raw_height, prefer_samples=False)
    cal = ls.GridCalibration.load(directory, raw_width, raw_height, prefer_samples=True)
    if which == "samples" and getattr(cal, "source", "") != "leap_r2p":
        raise FileNotFoundError(f"no leap_r2p_*.npy in {directory} (run leap_source.py --dump-images on the device)")
    return cal


def verify_lattice(frames: Sequence[Frame], directory: str, view: ls.RectifiedView) -> list[str]:
    """Re-rectify the raw pairs with each available calibration grid and compare with the bridge's dumped rectified views."""
    lines = []
    h, w = frames[0].raw_left.shape
    for which in ("lattice", "samples"):
        try:
            cal = load_calibration(directory, which, w, h)
        except FileNotFoundError as exc:
            lines.append(f"{which}: {exc}")
            continue
        rect = ls.Rectifier(cal, w, h, view)
        for f in frames:
            if f.ref_left is None or f.ref_right is None or f.ref_left.shape != (view.height, view.width):
                lines.append(f"{which} frame {f.name}: no dumped {view.width}x{view.height} rectified view to compare with")
                continue
            for side, raw, ref, cam in (("left", f.raw_left, f.ref_left, ls.CAMERA_LEFT), ("right", f.raw_right, f.ref_right, ls.CAMERA_RIGHT)):
                ours = rect.rectify(raw, cam)
                diff = np.abs(ours.astype(np.int32) - ref.astype(np.int32))
                shift, response = cv2.phaseCorrelate(ours.astype(np.float32), ref.astype(np.float32))
                lines.append(f"{which} frame {f.name} {side}: grey-level difference mean {diff.mean():.2f} median {np.median(diff):.0f} p99 {np.percentile(diff, 99):.0f}; "
                             f"residual shift ({shift[0]:+.2f}, {shift[1]:+.2f}) px (response {response:.2f})")
    return lines


# --------------------------------------------------------------------------- #
# Simulating distance: re-imaging the raw pair through the calibration
# --------------------------------------------------------------------------- #


def invert_calibration(cal: ls.GridCalibration, camera: int, iterations: int = 10) -> tuple[np.ndarray, np.ndarray]:
    """Ray slopes ``(tx, ty)`` of every raw pixel of ``camera`` (``(raw_height, raw_width)`` arrays; NaN where the grid cannot say).

    Newton's method on the bilinear grid lookup, started from a linear fit of
    the grid's central samples; the lookup is piecewise linear, so a few
    iterations land within a hundredth of a pixel.
    """
    grid = cal.grids[camera]
    n, r = grid.shape[0], cal.slope_range
    idx = np.arange(n)
    tx_g = -r + 2.0 * r * idx / (n - 1)
    ty_g = r - 2.0 * r * idx / (n - 1)
    TX, TY = np.meshgrid(tx_g, ty_g)  # [j, i]
    central = (np.abs(TX) < 1.0) & (np.abs(TY) < 1.0) & np.isfinite(grid[..., 0]) & np.isfinite(grid[..., 1])
    A = np.stack([grid[..., 0][central], grid[..., 1][central], np.ones(int(central.sum()))], axis=-1)
    coef_x, *_ = np.linalg.lstsq(A, TX[central], rcond=None)
    coef_y, *_ = np.linalg.lstsq(A, TY[central], rcond=None)
    px, py = np.meshgrid(np.arange(cal.raw_width, dtype=np.float64), np.arange(cal.raw_height, dtype=np.float64))
    tx = coef_x[0] * px + coef_x[1] * py + coef_x[2]
    ty = coef_y[0] * px + coef_y[1] * py + coef_y[2]
    eps = 1e-3
    for _ in range(iterations):
        fx, fy = cal.lookup(camera, tx, ty)
        fxx, fyx = cal.lookup(camera, tx + eps, ty)
        fxy, fyy = cal.lookup(camera, tx, ty + eps)
        j11, j21 = (fxx - fx) / eps, (fyx - fy) / eps
        j12, j22 = (fxy - fx) / eps, (fyy - fy) / eps
        det = j11 * j22 - j12 * j21
        ex, ey = px - fx, py - fy
        with np.errstate(divide="ignore", invalid="ignore"):
            dtx = (j22 * ex - j12 * ey) / det
            dty = (-j21 * ex + j11 * ey) / det
        ok = np.isfinite(dtx) & np.isfinite(dty)
        tx = np.where(ok, tx + np.clip(dtx, -0.5, 0.5), tx)
        ty = np.where(ok, ty + np.clip(dty, -0.5, 0.5), ty)
    fx, fy = cal.lookup(camera, tx, ty)
    bad = ~(np.isfinite(fx) & np.isfinite(fy)) | (np.hypot(fx - px, fy - py) > 0.05)
    tx[bad], ty[bad] = np.nan, np.nan
    return tx, ty


def _rotate_slopes(m: np.ndarray, tx: np.ndarray, ty: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    x = m[0, 0] * tx + m[0, 1] * ty + m[0, 2]
    y = m[1, 0] * tx + m[1, 1] * ty + m[1, 2]
    z = m[2, 0] * tx + m[2, 1] * ty + m[2, 2]
    with np.errstate(divide="ignore", invalid="ignore"):
        return x / z, y / z


def residual_noise(image: np.ndarray, low: int = 12, high: int = 48) -> float:
    """Standard deviation of ``image - median3x3(image)`` over pixels of grey ``low..high`` (the room): the sensor noise, roughly."""
    res = image.astype(np.float32) - cv2.medianBlur(image, 3).astype(np.float32)
    band = (image >= low) & (image < high)
    return float(res[band].std()) if band.sum() > 100 else float(res.std())


class DistanceSimulator:
    """Re-images a dumped raw pair as if its scene were ``1 / s`` times farther from the device.

    A scene point at depth ``Z0`` moved to ``Z0 / s`` keeps its lateral
    position, so its ray slope scales by ``s`` in every pinhole view and its
    disparity too. Per raw pixel ``p`` of the output, the ray ``t(p)`` is
    read off the inverted calibration (:func:`invert_calibration`), the
    input is sampled where the calibration puts ``t / s``, and the output is
    the input resampled there (after a Gaussian pre-blur matching the
    down-scaling, so texture the smaller image cannot hold is averaged, not
    aliased). The right camera's scaling is done in the aligned frame
    (``alignment`` from the frames' feature matches), so the pair stays
    misaligned by exactly what the real pair is. Rays the scaled scene does
    not cover (the outer part of the field) keep the original pixels. The
    hand (the largest lit blob, feathered) is then dimmed by ``s^2`` and
    Gaussian noise is added to bring the residual noise back to the input's.
    """

    def __init__(self, cal: ls.GridCalibration, alignment: ls.CameraAlignment | None = None, hand_threshold: int = 56) -> None:
        self.cal = cal
        self.alignment = alignment or ls.CameraAlignment()
        self.hand_threshold = int(hand_threshold)
        self.inverse = {cam: invert_calibration(cal, cam) for cam in ls.CAMERAS}

    def _sample_map(self, camera: int, s: float) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        tx, ty = self.inverse[camera]
        if camera == ls.CAMERA_RIGHT and not self.alignment.identity:
            m = self.alignment.matrix
            ax, ay = _rotate_slopes(m.T, tx, ty)     # calibration frame -> aligned frame
            ax, ay = ax / s, ay / s
            t2x, t2y = _rotate_slopes(m, ax, ay)     # back to the calibration frame
        else:
            t2x, t2y = tx / s, ty / s
        qx, qy = self.cal.lookup(camera, np.nan_to_num(t2x, nan=1e9), np.nan_to_num(t2y, nan=1e9))
        ok = np.isfinite(qx) & np.isfinite(qy) & np.isfinite(tx) & np.isfinite(ty)
        ok &= (qx >= 0) & (qx <= self.cal.raw_width - 1) & (qy >= 0) & (qy <= self.cal.raw_height - 1)
        return np.nan_to_num(qx, nan=-1.0).astype(np.float32), np.nan_to_num(qy, nan=-1.0).astype(np.float32), ok

    def reimage(self, raw: np.ndarray, camera: int, s: float) -> tuple[np.ndarray, np.ndarray]:
        """``(image, covered)``: the raw image of ``camera`` with its scene ``1 / s`` times farther, and where that scene had data."""
        qx, qy, ok = self._sample_map(camera, s)
        src = raw
        if s < 0.999:
            sigma = 0.5 * math.sqrt(1.0 / (s * s) - 1.0)
            src = cv2.GaussianBlur(raw, (0, 0), sigma)
        out = cv2.remap(src, qx, qy, cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT, borderValue=0)
        return np.where(ok, out, raw).astype(np.uint8), ok

    def hand_region(self, image: np.ndarray) -> np.ndarray:
        """Soft mask (0..1, ``float32``) of the largest lit blob, dilated by 2 px and feathered."""
        mask = hand_mask(image, self.hand_threshold).astype(np.uint8)
        mask = cv2.dilate(mask, np.ones((5, 5), np.uint8))
        return cv2.GaussianBlur(mask.astype(np.float32), (0, 0), 1.5)

    def simulate(self, frame: Frame, s: float, depth_mm: float, seed: int = 0, noise: float | None = None) -> Frame:
        """The frame's scene ``1 / s`` times farther: raw pair re-imaged, hand dimmed by ``s^2``, noise topped up (``noise``: target sigma, default the input's)."""
        rng = np.random.default_rng(seed)
        outs = []
        for camera, raw in ((ls.CAMERA_LEFT, frame.raw_left), (ls.CAMERA_RIGHT, frame.raw_right)):
            image, _ = self.reimage(raw, camera, s)
            soft = self.hand_region(image)
            dim = image.astype(np.float32) * (1.0 - (1.0 - s * s) * soft)
            target = residual_noise(raw) if noise is None else float(noise)
            have = residual_noise(np.clip(np.rint(dim), 0, 255).astype(np.uint8))
            extra = math.sqrt(max(target * target - have * have, 0.0))
            if extra > 0:
                dim = dim + rng.normal(0.0, extra, dim.shape).astype(np.float32)
            outs.append(np.clip(np.rint(dim), 0, 255).astype(np.uint8))
        name = f"{frame.name}@{depth_mm:.0f}" + (f"#{seed}" if seed else "")
        return Frame(name, outs[0], outs[1], scale=s, reference=frame, depth_mm=depth_mm, seed=seed)


def scale_about_centre(image: np.ndarray, s: float, view: ls.RectifiedView, nearest: bool = True) -> np.ndarray:
    """``out(u') = image(cx + (u' - cx) / s, ...)``: the view-domain counterpart of the raw re-imaging (nearest neighbour by default, for masks and depth)."""
    u, v = np.meshgrid(np.arange(view.width, dtype=np.float32), np.arange(view.height, dtype=np.float32))
    mx = (view.cx - 0.5) + (u - (view.cx - 0.5)) / s
    my = (view.cy - 0.5) + (v - (view.cy - 0.5)) / s
    return cv2.remap(image, mx, my, cv2.INTER_NEAREST if nearest else cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT, borderValue=0)


def smooth_depth(depth: np.ndarray, radius: int = 3) -> np.ndarray:
    """Holes filled by normalised convolution and two 5x5 medians: a truth map for the simulations (``uint16``)."""
    filled = ls.fill_holes(depth, radius, 1e9, min_support=0.3)
    out = cv2.medianBlur(filled, 5)
    return cv2.medianBlur(out, 5)


# --------------------------------------------------------------------------- #
# Configurations
# --------------------------------------------------------------------------- #


def view_with_fx(width: int, height: int, fx: float) -> ls.RectifiedView:
    """A ``width x height`` view of square pixels with focal length ``fx`` (a crop of a larger view with the same fx)."""
    return ls.RectifiedView(width, height, width / (2.0 * fx))


@dataclass(frozen=True)
class Config:
    name: str
    view: ls.RectifiedView
    params: ls.StereoParams
    note: str = ""

    @property
    def label(self) -> str:
        v, p = self.view, self.params
        extra = ""
        if p.contrast != "none":
            extra += f" {p.contrast}{p.contrast_window}"
        if (p.p1, p.p2) != (8, 32):
            extra += f" P{p.p1}/{p.p2}"
        if p.fill_radius:
            extra += f" fill{p.fill_radius}"
        return f"{v.width}x{v.height} {v.hfov_deg:.0f}deg fx{v.fx:.0f} {p.matcher}/{p.mode} b{p.block_size} u{p.uniqueness} d12={p.disp12_max_diff} i[{p.min_intensity},{p.max_intensity}) t{p.min_texture}@{p.texture_window} sp{p.speckle_window}{extra}"


#: The bridge's defaults before this experiment, for reference.
OLD_PARAMS = ls.StereoParams(min_intensity=16, max_intensity=255, min_lit=0, min_texture=0, uniqueness=10, speckle_window=100, mode="sgbm")
#: The invalidation rules at their defaults, before the distance work: 3x3 median, no conditioning, no hole filling, no temporal median.
NEW_PARAMS = ls.StereoParams(median=3, contrast="none", fill_radius=0, temporal=0)


def scaled(params: ls.StereoParams, view: ls.RectifiedView, **overrides: Any) -> ls.StereoParams:
    """``params`` with the speckle window scaled to the view's pixel count (relative to 320x240) and any overrides."""
    scale = (view.width * view.height) / (320.0 * 240.0)
    base = replace(params, speckle_window=int(round(params.speckle_window * scale)))
    return replace(base, **overrides) if overrides else base


def build_configs() -> dict[str, Config]:
    configs: list[Config] = []

    def add(name: str, view: ls.RectifiedView, params: ls.StereoParams | None = None, note: str = "", **overrides: Any) -> None:
        configs.append(Config(name, view, scaled(params or NEW_PARAMS, view, **overrides), note))

    v320 = ls.RectifiedView.from_fov(320, 240, 90.0)
    v480 = ls.RectifiedView.from_fov(480, 360, 90.0)
    v640 = ls.RectifiedView.from_fov(640, 480, 90.0)
    add("old", v320, OLD_PARAMS, "the bridge's previous defaults: 320x240/90, sgbm, no saturation/lit rule, no alignment")
    add("old+align", v320, OLD_PARAMS, "previous defaults, only the camera alignment added (see --align)")
    add("320x240", v320, note="320x240/90 with the new rules and 3way")
    add("480x360", v480, note="fx 240: 1.5x the previous angular resolution (the default view, no conditioning, no filling)")
    add("640x480", v640, note="fx 320: twice the previous angular resolution")
    add("640x360", ls.RectifiedView.from_fov(640, 360, 90.0), note="fx 320, rows cropped to +-29 deg")
    add("640x384-98", ls.RectifiedView.from_fov(640, 384, 98.0), note="wider: fx 278")
    add("480x300-100", ls.RectifiedView.from_fov(480, 300, 100.0), note="wider and cheaper: fx 201")
    add("crop480@fx320", view_with_fx(480, 360, 320.0), note="640x480/90 cropped to the central 74x59 deg working area")
    add("crop400@fx320", view_with_fx(400, 300, 320.0), note="640x480/90 cropped to the central 64x50 deg")
    for block in (3, 7):
        add(f"480x360-b{block}", v480, block_size=block)
        add(f"640x480-b{block}", v640, block_size=block)
    for mode in ("sgbm", "hh", "hh4"):
        add(f"320x240-{mode}", v320, mode=mode)
        add(f"480x360-{mode}", v480, mode=mode)
        add(f"640x480-{mode}", v640, mode=mode)
    add("480x360-bm", v480, matcher="bm", block_size=9, note="block matching, 9x9")
    add("640x480-bm", v640, matcher="bm", block_size=11, note="block matching, 11x11")
    add("480x360-u5", v480, uniqueness=5, note="loose uniqueness")
    add("480x360-u10", v480, uniqueness=10, note="looser uniqueness")
    add("480x360-u25", v480, uniqueness=25, note="strict uniqueness")
    add("480x360-lit0", v480, min_lit=0, note="no lit-at-depth rule")
    add("480x360-lit32", v480, min_lit=32, note="strict lit-at-depth rule")
    add("480x360-i24", v480, min_intensity=24, note="higher intensity floor")
    add("480x360-t8", v480, min_texture=8, note="texture rule on (8 levels in 7x7)")
    add("480x360-t8d", v480, min_texture=8, texture_window=11, note="texture rule on, 11x11 window")
    add("480x360-d12off", v480, disp12_max_diff=-1, note="no left-right check")
    add("480x360-nomed", v480, median=0)
    add("480x360-near150", v480, min_depth_mm=150.0, note="near plane 15 cm: fewer disparities")
    # Distance: input conditioning, smoothness, speckle, hole filling.
    for window in (15, 31, 63):
        add(f"gain{window}", v480, contrast="gain", contrast_window=window, note=f"local gain over {window}x{window}: the dim far hand is levelled to a near one")
    add("gain31f12", v480, contrast="gain", contrast_window=31, contrast_floor=12.0, note="local gain, floor 12: the room is amplified more too")
    add("gain31f48", v480, contrast="gain", contrast_window=31, contrast_floor=48.0, note="local gain, floor 48: gain capped at 2x")
    add("lcn31", v480, contrast="lcn", contrast_window=31, note="local contrast normalisation (removes the shading)")
    add("lcn15", v480, contrast="lcn", contrast_window=15)
    add("P4/16", v480, p1=4, p2=16, note="half the smoothness penalties")
    add("P2/8", v480, p1=2, p2=8, note="a quarter of the smoothness penalties")
    add("P8/64", v480, p1=8, p2=64, note="stronger P2: fewer disparity jumps")
    add("P16/64", v480, p1=16, p2=64, note="twice the smoothness penalties")
    add("P12/48", v480, p1=12, p2=48)
    add("P16/96", v480, p1=16, p2=96)
    add("P24/96", v480, p1=24, p2=96, note="three times the smoothness penalties")
    add("P32/128", v480, p1=32, p2=128, note="four times the smoothness penalties")
    add("P16/64-u10", v480, p1=16, p2=64, uniqueness=10)
    add("P16/64-u20", v480, p1=16, p2=64, uniqueness=20)
    add("P16/64-d0", v480, p1=16, p2=64, disp12_max_diff=0, note="exact left-right agreement")
    add("P16/64-med5", v480, p1=16, p2=64, median=5)
    add("P16/64-sr1", v480, p1=16, p2=64, speckle_range=1)
    add("P16/64-sp100", v480, p1=16, p2=64, speckle_window=100)
    add("P16/64-b7", v480, p1=16, p2=64, block_size=7)
    add("P16/64-fill2", v480, p1=16, p2=64, fill_radius=2)
    add("P24/96-fill2", v480, p1=24, p2=96, fill_radius=2)
    add("P16/64-u10-fill2", v480, p1=16, p2=64, uniqueness=10, fill_radius=2)
    add("P16/64-gain63", v480, p1=16, p2=64, contrast="gain", contrast_window=63)
    add("med5", v480, median=5, note="5x5 disparity median instead of 3x3")
    add("med5-fill2", v480, median=5, fill_radius=2)
    add("P12/48-med5-fill2", v480, p1=12, p2=48, median=5, fill_radius=2)
    add("P16/64-med5-fill2", v480, p1=16, p2=64, median=5, fill_radius=2)
    add("gain63-med5-fill2", v480, contrast="gain", contrast_window=63, median=5, fill_radius=2)
    add("med5-fill2-b7", v480, median=5, fill_radius=2, block_size=7)
    add("gain31-u5", v480, contrast="gain", contrast_window=31, uniqueness=5)
    add("gain31-u10", v480, contrast="gain", contrast_window=31, uniqueness=10)
    add("gain31-P4/16", v480, contrast="gain", contrast_window=31, p1=4, p2=16)
    add("gain31-P16/64", v480, contrast="gain", contrast_window=31, p1=16, p2=64)
    add("gain31-b3", v480, contrast="gain", contrast_window=31, block_size=3)
    add("gain31-b7", v480, contrast="gain", contrast_window=31, block_size=7)
    add("gain31-hh4", v480, contrast="gain", contrast_window=31, mode="hh4")
    add("gain31-hh", v480, contrast="gain", contrast_window=31, mode="hh")
    add("gain31-sgbm", v480, contrast="gain", contrast_window=31, mode="sgbm")
    add("sp50", v480, speckle_window=50, note="speckle window 50 px at 320x240 (112 at 480x360)")
    add("sp100", v480, speckle_window=100)
    add("sp400", v480, speckle_window=400)
    add("gain31-sp100", v480, contrast="gain", contrast_window=31, speckle_window=100)
    add("gain31-sp50", v480, contrast="gain", contrast_window=31, speckle_window=50)
    for radius in (1, 2, 3, 4):
        add(f"fill{radius}", v480, fill_radius=radius, note=f"hole filling, radius {radius}")
        add(f"gain31-fill{radius}", v480, contrast="gain", contrast_window=31, fill_radius=radius)
    add("gain31-sp100-fill2", v480, contrast="gain", contrast_window=31, speckle_window=100, fill_radius=2)
    add("gain31-u10-fill2", v480, contrast="gain", contrast_window=31, uniqueness=10, fill_radius=2)
    add("gain31-u10-sp100-fill2", v480, contrast="gain", contrast_window=31, uniqueness=10, speckle_window=100, fill_radius=2)
    add("gain31-P4/16-fill2", v480, contrast="gain", contrast_window=31, p1=4, p2=16, fill_radius=2)
    add("default", v480, ls.StereoParams(), note="the bridge's current defaults (leap_stereo.StereoParams(): 5x5 median, fill radius 2; add --temporal 3 for the temporal median it also runs)")
    return {c.name: c for c in configs}


# --------------------------------------------------------------------------- #
# Scoring
# --------------------------------------------------------------------------- #


@dataclass
class Score:
    config: str
    frame: str
    remap_ms: float
    match_ms: float
    hand_px: int
    valid_hand: float        # fraction of the (eroded) hand with in-box depth
    phantom_px: int          # in-box pixels away from the hand
    phantom_pct: float       # ... as a percentage of the image
    gap_fill: float          # fraction of the pixels between the fingers (hull minus hand) that read as in-box
    fingers_seen: int        # most runs of hand across a row of the finger region, by intensity
    fingers_depth: int       # ... by in-box depth
    saturated_valid: float   # fraction of saturated reference pixels that still carry in-box depth
    line_row: int = -1
    noise_mm: float = 0.0    # median local (5x5) standard deviation of the depth over the hand core
    holes: int = 0           # connected patches of missing depth inside the hand core
    hole_px: int = 0
    err_mm: float = float("nan")    # simulated frames: median |depth - truth| over the hand core
    err_p90_mm: float = float("nan")
    wrong: float = float("nan")     # simulated frames: fraction of the core's measurements off by more than 15 % of the truth
    lag_mm: float = float("nan")    # temporal runs on a moving hand: median (truth - depth), positive = lagging behind
    extras: dict[str, float] = field(default_factory=dict)

    @property
    def fingers_separated(self) -> bool:
        return self.fingers_seen >= 3 and self.fingers_depth >= self.fingers_seen - 1


def hand_mask(reference: np.ndarray, threshold: int, exclude: np.ndarray | None = None) -> np.ndarray:
    """The largest bright connected blob of the reference image (a hand and arm lit by the LEDs), opened once.

    ``exclude`` removes pixels first (the lab passes what its reference
    matcher placed beyond the far plane: a lit ceiling touching the hand
    would otherwise join the blob).
    """
    bright = (reference >= threshold).astype(np.uint8)
    if exclude is not None:
        bright[exclude] = 0
    bright = cv2.morphologyEx(bright, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
    n, labels, stats, _ = cv2.connectedComponentsWithStats(bright, connectivity=8)
    if n <= 1:
        return np.zeros(reference.shape, dtype=bool)
    largest = 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))
    return labels == largest


def runs(row: np.ndarray, min_len: int = 2) -> int:
    """Number of runs of True at least ``min_len`` long in a boolean row."""
    if not row.any():
        return 0
    padded = np.concatenate([[False], row, [False]])
    edges = np.flatnonzero(padded[1:] != padded[:-1])
    lengths = edges[1::2] - edges[0::2]
    return int((lengths >= min_len).sum())


def finger_rows(mask: np.ndarray) -> tuple[int, int]:
    """Row range (top 40 % of the hand's bounding box) where the fingers are expected."""
    ys = np.flatnonzero(mask.any(axis=1))
    if ys.size == 0:
        return 0, 0
    top, bottom = int(ys[0]), int(ys[-1])
    return top, top + max(1, int(0.4 * (bottom - top)))


def local_noise(depth: np.ndarray, window: int = 5) -> tuple[np.ndarray, np.ndarray]:
    """Per-pixel standard deviation of the valid depth in a ``window`` box, and where at least 60 % of the box is valid."""
    valid = depth > 0
    d = np.where(valid, depth, 0).astype(np.float32)
    v = valid.astype(np.float32)
    k = (window, window)
    den = cv2.boxFilter(v, -1, k, normalize=False, borderType=cv2.BORDER_CONSTANT)
    num = cv2.boxFilter(d, -1, k, normalize=False, borderType=cv2.BORDER_CONSTANT)
    sq = cv2.boxFilter(d * d, -1, k, normalize=False, borderType=cv2.BORDER_CONSTANT)
    safe = np.maximum(den, 1.0)
    mean = num / safe
    std = np.sqrt(np.maximum(sq / safe - mean * mean, 0.0))
    return std, valid & (den >= 0.6 * window * window)


def count_holes(missing: np.ndarray, min_px: int = 2) -> int:
    n, _, stats, _ = cv2.connectedComponentsWithStats(missing.astype(np.uint8), connectivity=8)
    return int((stats[1:, cv2.CC_STAT_AREA] >= min_px).sum()) if n > 1 else 0


@dataclass
class Truth:
    """What a simulated frame should measure, in a config's view: the hand mask and the smoothed reference depth, both scaled."""

    hand: np.ndarray
    depth: np.ndarray      # float32 mm, 0 where unknown
    box: tuple[float, float]


class TruthCache:
    """Per view: the reference frame rectified, its hand mask and its best depth (full SGBM, filled, smoothed), scaled on demand."""

    def __init__(self, cal: ls.GridCalibration, alignment: ls.CameraAlignment | None, hand_threshold: int, near_mm: float, far_mm: float, swap: bool = False) -> None:
        self.cal, self.alignment, self.hand_threshold = cal, alignment, int(hand_threshold)
        self.near_mm, self.far_mm, self.swap = float(near_mm), float(far_mm), swap
        self._base: dict[tuple[str, ls.RectifiedView], tuple[np.ndarray, np.ndarray]] = {}

    def base(self, frame: Frame, view: ls.RectifiedView) -> tuple[np.ndarray, np.ndarray]:
        key = (frame.name, view)
        if key not in self._base:
            h, w = frame.raw_left.shape
            rect = ls.Rectifier(self.cal, w, h, view, alignment=self.alignment)
            left, right = rect.rectify_pair(frame.raw_left, frame.raw_right)
            params = ls.StereoParams(min_depth_mm=self.near_mm, mode="sgbm", speckle_window=int(round(200 * view.width * view.height / (320.0 * 240.0))), fill_radius=3)
            depth = ls.StereoDepth(ls.CONTROLLER_BASELINE_MM, view.fx, params, self.swap).compute(left, right)
            reference = right if self.swap else left
            # Two passes: the lit blob's median depth, then the blob again without what lies well beyond it (a lit
            # shelf or ceiling near the far plane touching the hand would otherwise join it).
            blob = hand_mask(reference, self.hand_threshold, exclude=depth > self.far_mm)
            measured = blob & (depth > 0)
            median = float(np.median(depth[measured])) if measured.any() else self.far_mm
            hand = hand_mask(reference, self.hand_threshold, exclude=(depth > 1.35 * median) | ((depth > 0) & (depth < 0.6 * median)))
            depth = np.where(hand, depth, 0).astype(np.uint16)
            self._base[key] = (hand, smooth_depth(depth).astype(np.float32))
        return self._base[key]

    def reference_depth_mm(self, frame: Frame, view: ls.RectifiedView) -> float:
        """The reference hand's height: the median of its truth depth over the eroded hand mask."""
        hand, depth = self.base(frame, view)
        core = cv2.erode(hand.astype(np.uint8), np.ones((5, 5), np.uint8)).astype(bool) & (depth > 0)
        return float(np.median(depth[core])) if core.any() else 0.0

    def truth(self, frame: Frame, view: ls.RectifiedView) -> Truth:
        """A dumped frame gets its hand mask (no depth to compare with); a simulated one its reference's mask and depth, scaled."""
        if frame.reference is None:
            hand, _ = self.base(frame, view)
            return Truth(hand, np.zeros(hand.shape, dtype=np.float32), (self.near_mm, self.far_mm))
        hand, depth = self.base(frame.reference, view)
        s = frame.scale
        hand_s = scale_about_centre(hand.astype(np.uint8), s, view).astype(bool)
        depth_s = scale_about_centre(depth, s, view) / s
        depth_s[~hand_s] = 0.0
        far = max(self.far_mm, 1.25 * frame.depth_mm)
        return Truth(hand_s, depth_s.astype(np.float32), (self.near_mm, far))


def score_depth(config: Config, frame: Frame, depth: np.ndarray, reference: np.ndarray, near_mm: float, far_mm: float, hand_threshold: int,
                remap_ms: float, match_ms: float, truth: Truth | None, left: np.ndarray, right: np.ndarray) -> tuple[Score, dict[str, np.ndarray]]:
    """Score one depth map against the hand (``truth``: the lab's hand mask, plus the scaled depth for a simulated frame; else the lit blob)."""
    if truth is not None:
        near_mm, far_mm = truth.box
        hand = truth.hand
        has_truth = bool((truth.depth > 0).any())
    else:
        hand = hand_mask(reference, hand_threshold)
        has_truth = False
    in_box = (depth >= near_mm) & (depth <= far_mm)
    valid = depth > 0
    scale = config.view.width / 320.0
    r_erode, r_dilate = max(1, int(round(2 * scale))), max(2, int(round(6 * scale)))
    hand_u8 = hand.astype(np.uint8)
    core = cv2.erode(hand_u8, np.ones((2 * r_erode + 1,) * 2, np.uint8)).astype(bool)
    halo = cv2.dilate(hand_u8, np.ones((2 * r_dilate + 1,) * 2, np.uint8)).astype(bool)
    valid_hand = float(in_box[core].mean()) if core.any() else 0.0
    phantom = in_box & ~halo
    hull = np.zeros(hand.shape, dtype=np.uint8)
    contours, _ = cv2.findContours(hand_u8, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if contours:
        points = np.concatenate(contours)
        cv2.fillConvexPoly(hull, cv2.convexHull(points), 1)
    gaps = hull.astype(bool) & ~cv2.dilate(hand_u8, np.ones((3, 3), np.uint8)).astype(bool)
    gap_fill = float(in_box[gaps].mean()) if gaps.any() else 0.0
    top, bottom = finger_rows(hand)
    seen, by_depth, line_row = 0, 0, -1
    min_run = max(2, int(round(2 * scale)))
    for row in range(top, bottom):
        n_int = runs(hand[row], min_run)
        if n_int > seen:
            seen, by_depth, line_row = n_int, runs(in_box[row] & hull[row].astype(bool), min_run), row
    saturated = reference >= 250
    sat_valid = float(in_box[saturated].mean()) if saturated.any() else 0.0
    std, full = local_noise(np.where(in_box, depth, 0).astype(np.uint16))
    noise_pixels = core & full
    noise_mm = float(np.median(std[noise_pixels])) if noise_pixels.any() else 0.0
    missing = core & ~in_box
    s = Score(config.name, frame.name, remap_ms, match_ms, int(hand.sum()), valid_hand, int(phantom.sum()), 100.0 * float(phantom.mean()),
              gap_fill, seen, by_depth, sat_valid, line_row, noise_mm, count_holes(missing), int(missing.sum()),
              extras={"valid_pct": 100.0 * float(valid.mean()), "inbox_pct": 100.0 * float(in_box.mean())})
    if truth is not None and has_truth:
        known = core & valid & (truth.depth > 0)
        if known.any():
            err = np.abs(depth[known].astype(np.float32) - truth.depth[known])
            s.err_mm, s.err_p90_mm = float(np.median(err)), float(np.percentile(err, 90))
            s.wrong = float((err > 0.15 * truth.depth[known]).mean())
            s.lag_mm = float(np.median(truth.depth[known] - depth[known].astype(np.float32)))
    return s, {"left": left, "right": right, "depth": depth, "hand": hand, "hull": hull.astype(bool), "phantom": phantom, "gaps": gaps}


def score(config: Config, frame: Frame, rectifier: ls.Rectifier, stereo: ls.StereoDepth, near_mm: float, far_mm: float, hand_threshold: int, repeat: int,
          truth: Truth | None = None) -> tuple[Score, dict[str, np.ndarray]]:
    t0 = time.perf_counter()
    left, right = rectifier.rectify_pair(frame.raw_left, frame.raw_right)
    remap_ms = (time.perf_counter() - t0) * 1000.0
    times = []
    depth = None
    for _ in range(max(1, repeat)):
        t0 = time.perf_counter()
        depth = stereo.compute(left, right)
        times.append((time.perf_counter() - t0) * 1000.0)
    assert depth is not None
    reference = right if stereo.swap else left
    return score_depth(config, frame, depth, reference, near_mm, far_mm, hand_threshold, remap_ms, float(np.median(times)), truth, left, right)


def score_temporal(config: Config, frames: Sequence[Frame], rectifier: ls.Rectifier, stereo: ls.StereoDepth, near_mm: float, far_mm: float, hand_threshold: int,
                   truth: Truth | None, length: int, majority: bool = False) -> tuple[Score, dict[str, np.ndarray]]:
    """Push ``frames`` (oldest first) through a :class:`leap_stereo.TemporalDepthFilter` of ``length`` and score the last output against ``truth`` (of the last frame)."""
    filt = ls.TemporalDepthFilter(length, stereo.tolerance_mm(stereo.params.temporal_tolerance_px), majority)
    depth = None
    left = right = None
    push_ms = []
    for f in frames:
        left, right = rectifier.rectify_pair(f.raw_left, f.raw_right)
        measured = stereo.compute(left, right)
        t0 = time.perf_counter()
        depth = filt.push(measured)
        push_ms.append((time.perf_counter() - t0) * 1000.0)
    assert depth is not None and left is not None and right is not None
    reference = right if stereo.swap else left
    s, images = score_depth(config, frames[-1], depth, reference, near_mm, far_mm, hand_threshold, 0.0, float(np.median(push_ms)), truth, left, right)
    s.config = f"{config.name}+t{length}{'m' if majority else ''}"
    return s, images


# --------------------------------------------------------------------------- #
# Contact sheet
# --------------------------------------------------------------------------- #


TILE_W = 320


def depth_tile(depth: np.ndarray, near_mm: float, far_mm: float) -> np.ndarray:
    """BGR picture: black = nothing, grey ramp = in the box (dark near, light far), blue = beyond far, red = nearer than near."""
    scaled_ = np.clip((depth.astype(np.float32) - near_mm) / max(far_mm - near_mm, 1.0), 0.0, 1.0)
    grey = (48 + 200 * scaled_).astype(np.uint8)
    tile = np.stack([grey, grey, grey], axis=-1)
    tile[depth == 0] = 0
    tile[(depth > far_mm)] = (120, 40, 0)
    tile[(depth > 0) & (depth < near_mm)] = (0, 0, 140)
    return tile


def mask_tile(images: dict[str, np.ndarray], near_mm: float, far_mm: float, line_row: int) -> np.ndarray:
    depth = images["depth"]
    in_box = (depth >= near_mm) & (depth <= far_mm)
    tile = np.zeros((*depth.shape, 3), dtype=np.uint8)
    tile[depth > 0] = (70, 70, 70)
    tile[in_box] = (230, 230, 230)
    tile[images["phantom"]] = (0, 0, 220)         # phantoms in red
    tile[images["gaps"] & in_box] = (0, 160, 255)  # filled finger gaps in orange
    if line_row >= 0:
        tile[line_row, :, :] = (0, 255, 0)
    return tile


def left_tile(images: dict[str, np.ndarray]) -> np.ndarray:
    left = images["left"]
    tile = cv2.cvtColor(left, cv2.COLOR_GRAY2BGR)
    contours, _ = cv2.findContours(images["hand"].astype(np.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    cv2.drawContours(tile, contours, -1, (0, 220, 0), 1)
    hull_c, _ = cv2.findContours(images["hull"].astype(np.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    cv2.drawContours(tile, hull_c, -1, (0, 160, 255), 1)
    return tile


def fit_tile(image: np.ndarray, width: int = TILE_W) -> np.ndarray:
    h, w = image.shape[:2]
    return cv2.resize(image, (width, int(round(h * width / w))), interpolation=cv2.INTER_NEAREST if width <= w else cv2.INTER_LINEAR)


def contact_sheet(rows: list[tuple[Config, Frame, Score, dict[str, np.ndarray]]], near_mm: float, far_mm: float, title: str) -> np.ndarray:
    tiles = []
    for config, frame, s, images in rows:
        far = max(far_mm, 1.25 * frame.depth_mm) if frame.simulated else far_mm
        panels = [fit_tile(left_tile(images)), fit_tile(depth_tile(images["depth"], near_mm, far)), fit_tile(mask_tile(images, near_mm, far, s.line_row))]
        height = max(p.shape[0] for p in panels)
        panels = [np.pad(p, ((0, height - p.shape[0]), (0, 0), (0, 0))) for p in panels]
        strip = np.concatenate(panels, axis=1)
        header = np.zeros((44, strip.shape[1], 3), dtype=np.uint8)
        text1 = f"{s.config} [{frame.name}]  {config.label}"
        err = f"  err {s.err_mm:.0f}/{s.err_p90_mm:.0f} mm wrong {100 * s.wrong:.0f}%" if np.isfinite(s.err_mm) else ""
        text2 = (f"match {s.match_ms:.1f} ms  hand {s.hand_px} px valid {100 * s.valid_hand:.0f}% noise {s.noise_mm:.1f} mm holes {s.holes}{err}  phantom {s.phantom_pct:.2f}%  "
                 f"gap {100 * s.gap_fill:.0f}%  fingers {s.fingers_depth}/{s.fingers_seen} {'SEP' if s.fingers_separated else 'blob'}")
        cv2.putText(header, text1, (6, 16), cv2.FONT_HERSHEY_SIMPLEX, 0.42, (255, 255, 255), 1, cv2.LINE_AA)
        cv2.putText(header, text2, (6, 36), cv2.FONT_HERSHEY_SIMPLEX, 0.4, (120, 255, 120) if s.fingers_separated else (120, 180, 255), 1, cv2.LINE_AA)
        tiles.append(np.concatenate([header, strip], axis=0))
    width = max(t.shape[1] for t in tiles)
    tiles = [np.pad(t, ((0, 0), (0, width - t.shape[1]), (0, 0))) for t in tiles]
    banner = np.zeros((28, width, 3), dtype=np.uint8)
    cv2.putText(banner, title, (6, 19), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (255, 255, 255), 1, cv2.LINE_AA)
    return np.concatenate([banner, *tiles], axis=0)


# --------------------------------------------------------------------------- #
# Driver
# --------------------------------------------------------------------------- #


def _fmt(x: float, width: int, digits: int = 0) -> str:
    return f"{x:{width}.{digits}f}" if np.isfinite(x) else f"{'-':>{width}}"


def table(scores: Sequence[Score]) -> str:
    head = (f"{'config':22} {'frame':9} {'match ms':>8} {'remap':>6} {'hand px':>7} {'valid%':>6} {'noise':>5} {'holes':>5} {'err':>4} {'p90':>4} {'wrong%':>6} {'lag':>4} "
            f"{'phantom%':>8} {'gap%':>5} {'fingers':>7}")
    lines = [head, "-" * len(head)]
    for s in scores:
        lines.append(f"{s.config:22} {s.frame:9} {s.match_ms:8.1f} {s.remap_ms:6.1f} {s.hand_px:7d} {100 * s.valid_hand:6.0f} {s.noise_mm:5.1f} {s.holes:5d} "
                     f"{_fmt(s.err_mm, 4)} {_fmt(s.err_p90_mm, 4)} {_fmt(100 * s.wrong, 6)} {_fmt(s.lag_mm, 4)} {s.phantom_pct:8.2f} {100 * s.gap_fill:5.0f} "
                     f"{s.fingers_depth:>3d}/{s.fingers_seen:<3d} {'separated' if s.fingers_separated else 'blob'}")
    return "\n".join(lines)


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0], formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--input", default=DEFAULT_INPUT, metavar="DIR", help="directory with leap_NNN_raw_*.png and the calibration .npy files (default: %(default)s)")
    p.add_argument("--out", default=None, metavar="PNG", help="contact sheet to write (default: DIR/stereo_lab.png)")
    p.add_argument("--frames", nargs="*", default=None, metavar="NNN", help="frame numbers to use (default: every dumped frame)")
    p.add_argument("--configs", nargs="*", default=None, metavar="NAME", help="configurations to run (default: all; see --list)")
    p.add_argument("--list", action="store_true", help="print the configuration names and exit")
    p.add_argument("--verify", action="store_true", help="check the calibration grids against the dumped rectified views and exit")
    p.add_argument("--calibration", choices=("auto", "samples", "lattice"), default="auto", help="which dumped grid rectifies: LeapRectilinearToPixel samples, the image events' lattice, or samples if present (default: auto)")
    p.add_argument("--align", default="auto", metavar="MODE", help="right-camera alignment: 'auto' (fitted from the frames), 'none', or PITCH,ROLL[,YAW] degrees (default: auto)")
    p.add_argument("--near", type=float, default=0.1, metavar="M")
    p.add_argument("--far", type=float, default=0.45, metavar="M")
    p.add_argument("--hand-threshold", type=int, default=56, help="reference-image intensity that counts as the lit hand (default: %(default)s)")
    p.add_argument("--repeat", type=int, default=5, help="matcher runs per configuration for the timing (default: %(default)s)")
    p.add_argument("--swap-cameras", action="store_true")
    p.add_argument("--simulate-distance", type=float, nargs="*", default=None, metavar="MM", help="also score the reference frame's hand moved to these heights (mm), see the module docstring")
    p.add_argument("--reference-frame", default=None, metavar="NNN", help="the frame the simulations start from (default: the first frame)")
    p.add_argument("--reference-depth", type=float, default=None, metavar="MM", help="that hand's height (default: the median of its matched depth)")
    p.add_argument("--noise", type=float, default=None, metavar="SIGMA", help="sensor noise of the simulated frames in grey levels (default: the reference frame's own)")
    p.add_argument("--only-simulated", action="store_true", help="score only the simulated frames (the dumped ones still feed the alignment fit)")
    p.add_argument("--temporal", type=int, default=0, metavar="N", help="also run each config with the temporal median over N frames on the simulated frames: N static noise realisations, and N frames of a hand moving --temporal-speed mm per frame")
    p.add_argument("--temporal-speed", type=float, default=10.0, metavar="MM", help="hand movement per frame (away from the device) for the moving temporal run (default: %(default)s)")
    p.add_argument("--temporal-majority", action="store_true", help="also run the temporal median with the majority rule (a lone newest sample outvoted by two agreeing older ones; rows marked 'm')")
    return p


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    configs = build_configs()
    if args.list:
        for c in configs.values():
            print(f"{c.name:22} {c.label}  {c.note}")
        return 0
    frames = load_frames(args.input, args.frames)
    h, w = frames[0].raw_left.shape
    if args.verify:
        print("\n".join(verify_lattice(frames, args.input, ls.RectifiedView.from_fov(320, 240, 90.0))))
        return 0
    cal = load_calibration(args.input, args.calibration, w, h)
    print(f"calibration: {getattr(cal, 'source', '?')} ({args.input}), raw {w}x{h}, {len(frames)} frame(s): {', '.join(f.name for f in frames)}")
    if args.align == "auto":
        fit_view = ls.RectifiedView.from_fov(640, 480, 90.0)
        rect = ls.Rectifier(cal, w, h, fit_view)
        rays = []
        for f in frames:
            left, right = rect.rectify_pair(f.raw_left, f.raw_right)
            m = ls.match_pair(left, right)
            rays.append(ls.matches_to_rays(m, fit_view))
            print(f"  frame {f.name}: {len(m)} feature matches, row offset median {np.median(m[:, 3] - m[:, 1]) if len(m) else float('nan'):+.2f} px at fy {fit_view.fy:.0f}")
        fit = ls.fit_alignment(np.concatenate(rays), fit_view)
        alignment = fit.alignment
        print(f"alignment (auto): {fit.describe()}")
    else:
        alignment = ls.CameraAlignment.parse(args.align)
        print(f"alignment: {alignment.name if not alignment.identity else 'none'}")
    near_mm, far_mm = args.near * 1000.0, args.far * 1000.0
    truths = TruthCache(cal, alignment, args.hand_threshold, near_mm, far_mm, args.swap_cameras)
    simulated: list[Frame] = []
    simulator: DistanceSimulator | None = None
    reference: Frame | None = None
    z_ref = 0.0
    if args.simulate_distance:
        reference = next((f for f in frames if f.name == args.reference_frame), frames[0]) if args.reference_frame else frames[0]
        z_ref = args.reference_depth or truths.reference_depth_mm(reference, ls.RectifiedView.from_fov(480, 360, 90.0))
        if z_ref <= 0:
            raise SystemExit(f"frame {reference.name}: no hand found to measure the reference height from; pass --reference-depth")
        simulator = DistanceSimulator(cal, alignment, args.hand_threshold)
        started = time.perf_counter()
        for z in args.simulate_distance:
            simulated.append(simulator.simulate(reference, z_ref / z, z, noise=args.noise))
        noise = residual_noise(reference.raw_left)
        print(f"simulated distances from frame {reference.name} at {z_ref:.0f} mm: {', '.join(f'{z:.0f}' for z in args.simulate_distance)} mm "
              f"(scale {', '.join(f'{z_ref / z:.2f}' for z in args.simulate_distance)}; sensor noise {noise:.2f} grey levels; {1000 * (time.perf_counter() - started):.0f} ms)")
    scored_frames = (simulated if args.only_simulated else frames + simulated)
    chosen = [configs[n] for n in (args.configs or list(configs))]
    rows: list[tuple[Config, Frame, Score, dict[str, np.ndarray]]] = []
    scores: list[Score] = []
    rect_cache: dict[tuple[ls.RectifiedView, bool], ls.Rectifier] = {}
    for c in chosen:
        aligned = c.name != "old"
        key = (c.view, aligned)
        if key not in rect_cache:
            rect_cache[key] = ls.Rectifier(cal, w, h, c.view, alignment=alignment if aligned else None)
        rect = rect_cache[key]
        params = replace(c.params, min_depth_mm=near_mm) if c.params.min_depth_mm == ls.StereoParams().min_depth_mm else c.params
        stereo = ls.StereoDepth(ls.CONTROLLER_BASELINE_MM, c.view.fx, params, args.swap_cameras)
        batch: list[Score] = []
        for f in scored_frames:
            truth = truths.truth(f, c.view)
            s, images = score(c, f, rect, stereo, near_mm, far_mm, args.hand_threshold, args.repeat, truth)
            batch.append(s)
            rows.append((c, f, s, images))
            if args.temporal > 1 and f.simulated and simulator is not None and reference is not None:
                static = [simulator.simulate(reference, f.scale, f.depth_mm, seed=k + 1, noise=args.noise) for k in range(args.temporal)]
                moving = [simulator.simulate(reference, z_ref / (f.depth_mm - (args.temporal - 1 - k) * args.temporal_speed), f.depth_mm - (args.temporal - 1 - k) * args.temporal_speed, seed=k + 1, noise=args.noise)
                          for k in range(args.temporal)]
                for majority in ((False, True) if args.temporal_majority else (False,)):
                    s_static, im_static = score_temporal(c, static, rect, stereo, near_mm, far_mm, args.hand_threshold, truth, args.temporal, majority)
                    s_static.frame = f"{f.name} static"
                    s_moving, im_moving = score_temporal(c, moving, rect, stereo, near_mm, far_mm, args.hand_threshold, truth, args.temporal, majority)
                    s_moving.frame = f"{f.name} moving"
                    batch += [s_static, s_moving]
                    rows += [(c, f, s_static, im_static), (c, f, s_moving, im_moving)]
        scores += batch
        print(f"  {c.name:22} " + "  ".join(f"[{s.frame}] {s.match_ms:5.1f} ms valid {100 * s.valid_hand:3.0f}% noise {s.noise_mm:4.1f} holes {s.holes:3d}"
                                          + (f" err {s.err_mm:3.0f} wrong {100 * s.wrong:2.0f}%" if np.isfinite(s.err_mm) else "")
                                          + f" phantom {s.phantom_pct:5.2f}% gap {100 * s.gap_fill:3.0f}% fingers {s.fingers_depth}/{s.fingers_seen}" for s in batch))
    print()
    print(table(scores))
    out = args.out or os.path.join(args.input, "stereo_lab.png")
    title = f"stereo lab: {getattr(cal, 'source', '?')} calibration, alignment {alignment.name if not alignment.identity else 'none'}, box {near_mm:.0f}-{far_mm:.0f} mm; left+hand mask | depth (grey=in box, blue=beyond) | in-box mask (red=phantom, orange=finger gap filled, green=finger row)"
    sheet = contact_sheet(rows, near_mm, far_mm, title)
    if not cv2.imwrite(out, sheet):
        raise RuntimeError(f"could not write {out}")
    print(f"wrote {out} ({sheet.shape[1]}x{sheet.shape[0]})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
