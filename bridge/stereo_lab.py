#!/usr/bin/env python3
"""Offline stereo experiments on dumped Leap Motion Controller frames.

``leap_source.py --dump-images`` leaves raw stereo pairs, the bridge's own
rectified views and depth maps, and the device's calibration grids in a
directory. This tool re-rectifies and re-matches the raw pairs offline under
any number of configurations (view size and field of view, block size, SGBM
mode, block matching, invalidation rules), times each one, scores the hand
(valid depth on it, phantom depth around it, whether spread fingers stay
separate) and writes a labelled contact sheet so the choices can be checked
by eye::

    python bridge/stereo_lab.py --input test-results/leap --out test-results/leap/stereo_lab.png
    python bridge/stereo_lab.py --configs base 640x480 640x480-b3 --frames 001 --repeat 10
    python bridge/stereo_lab.py --verify          # lattice convention against the dumped rectified views
    python bridge/stereo_lab.py --list            # the configuration names

No hardware and no LeapC needed: the calibration comes from the dumped
``leap_r2p_*.npy`` (samples of ``LeapRectilinearToPixel``, preferred) or
``leap_distortion_*.npy`` (the image events' lattices), see
:class:`leap_stereo.GridCalibration`. The alignment of the right camera
(``--align auto``) is estimated from the frames' feature matches before the
configurations run, the same way ``--leap-align auto`` does it live.
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
        return f"{v.width}x{v.height} {v.hfov_deg:.0f}deg fx{v.fx:.0f} {p.matcher}/{p.mode} b{p.block_size} u{p.uniqueness} d12={p.disp12_max_diff} i[{p.min_intensity},{p.max_intensity}) t{p.min_texture}@{p.texture_window} sp{p.speckle_window}"


#: The bridge's defaults before this experiment, for reference.
OLD_PARAMS = ls.StereoParams(min_intensity=16, max_intensity=255, min_lit=0, min_texture=0, uniqueness=10, speckle_window=100, mode="sgbm")
#: The invalidation rules under test, at their proposed defaults.
NEW_PARAMS = ls.StereoParams()


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
    add("480x360", v480, note="fx 240: 1.5x the previous angular resolution (the proposed default)")
    add("640x480", v640, note="fx 320: twice the previous angular resolution")
    add("640x360", ls.RectifiedView.from_fov(640, 360, 90.0), note="fx 320, rows cropped to +-29 deg")
    add("640x384-98", ls.RectifiedView.from_fov(640, 384, 98.0), note="wider: fx 278")
    add("480x300-100", ls.RectifiedView.from_fov(480, 300, 100.0), note="wider and cheaper: fx 201")
    add("crop480@fx320", view_with_fx(480, 360, 320.0), note="640x480/90 cropped to the central 74x59 deg working area")
    add("crop400@fx320", view_with_fx(400, 300, 320.0), note="640x480/90 cropped to the central 64x50 deg")
    for block in (3, 7):
        add(f"480x360-b{block}", v480, block_size=block)
        add(f"640x480-b{block}", v640, block_size=block)
    for mode in ("sgbm", "hh"):
        add(f"320x240-{mode}", v320, mode=mode)
        add(f"480x360-{mode}", v480, mode=mode)
        add(f"640x480-{mode}", v640, mode=mode)
    add("480x360-bm", v480, matcher="bm", block_size=9, note="block matching, 9x9")
    add("640x480-bm", v640, matcher="bm", block_size=11, note="block matching, 11x11")
    add("480x360-u5", v480, uniqueness=5, note="loose uniqueness")
    add("480x360-u25", v480, uniqueness=25, note="strict uniqueness")
    add("480x360-lit0", v480, min_lit=0, note="no lit-at-depth rule")
    add("480x360-lit32", v480, min_lit=32, note="strict lit-at-depth rule")
    add("480x360-i24", v480, min_intensity=24, note="higher intensity floor")
    add("480x360-t8", v480, min_texture=8, note="texture rule on (8 levels in 7x7)")
    add("480x360-t8d", v480, min_texture=8, texture_window=11, note="texture rule on, 11x11 window")
    add("480x360-d12off", v480, disp12_max_diff=-1, note="no left-right check")
    add("480x360-nomed", v480, median=0)
    add("480x360-near150", v480, min_depth_mm=150.0, note="near plane 15 cm: fewer disparities")
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
    extras: dict[str, float] = field(default_factory=dict)

    @property
    def fingers_separated(self) -> bool:
        return self.fingers_seen >= 3 and self.fingers_depth >= self.fingers_seen - 1


def hand_mask(reference: np.ndarray, threshold: int) -> np.ndarray:
    """The largest bright connected blob of the reference image (a hand and arm lit by the LEDs), opened once."""
    bright = (reference >= threshold).astype(np.uint8)
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


def score(config: Config, frame: Frame, rectifier: ls.Rectifier, stereo: ls.StereoDepth, near_mm: float, far_mm: float, hand_threshold: int, repeat: int) -> tuple[Score, dict[str, np.ndarray]]:
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
    match_ms = float(np.median(times))
    reference = right if stereo.swap else left
    in_box = (depth >= near_mm) & (depth <= far_mm)
    valid = depth > 0
    scale = config.view.width / 320.0
    r_erode, r_dilate = max(1, int(round(2 * scale))), max(2, int(round(6 * scale)))
    hand = hand_mask(reference, hand_threshold)
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
    s = Score(config.name, frame.name, remap_ms, match_ms, int(hand.sum()), valid_hand, int(phantom.sum()), 100.0 * float(phantom.mean()),
              gap_fill, seen, by_depth, sat_valid, line_row, {"valid_pct": 100.0 * float(valid.mean()), "inbox_pct": 100.0 * float(in_box.mean())})
    return s, {"left": left, "right": right, "depth": depth, "hand": hand, "hull": hull.astype(bool), "phantom": phantom, "gaps": gaps}


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
        panels = [fit_tile(left_tile(images)), fit_tile(depth_tile(images["depth"], near_mm, far_mm)), fit_tile(mask_tile(images, near_mm, far_mm, s.line_row))]
        height = max(p.shape[0] for p in panels)
        panels = [np.pad(p, ((0, height - p.shape[0]), (0, 0), (0, 0))) for p in panels]
        strip = np.concatenate(panels, axis=1)
        header = np.zeros((44, strip.shape[1], 3), dtype=np.uint8)
        text1 = f"{config.name} [{frame.name}]  {config.label}"
        text2 = (f"match {s.match_ms:.1f} ms (+{s.remap_ms:.1f} remap)  hand {s.hand_px} px valid {100 * s.valid_hand:.0f}%  phantom {s.phantom_pct:.2f}% ({s.phantom_px} px)  "
                 f"gap fill {100 * s.gap_fill:.0f}%  fingers {s.fingers_depth}/{s.fingers_seen} {'SEP' if s.fingers_separated else 'blob'}  sat-valid {100 * s.saturated_valid:.0f}%")
        cv2.putText(header, text1, (6, 16), cv2.FONT_HERSHEY_SIMPLEX, 0.42, (255, 255, 255), 1, cv2.LINE_AA)
        cv2.putText(header, text2, (6, 36), cv2.FONT_HERSHEY_SIMPLEX, 0.42, (120, 255, 120) if s.fingers_separated else (120, 180, 255), 1, cv2.LINE_AA)
        tiles.append(np.concatenate([header, strip], axis=0))
    width = max(t.shape[1] for t in tiles)
    tiles = [np.pad(t, ((0, 0), (0, width - t.shape[1]), (0, 0))) for t in tiles]
    banner = np.zeros((28, width, 3), dtype=np.uint8)
    cv2.putText(banner, title, (6, 19), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (255, 255, 255), 1, cv2.LINE_AA)
    return np.concatenate([banner, *tiles], axis=0)


# --------------------------------------------------------------------------- #
# Driver
# --------------------------------------------------------------------------- #


def table(scores: Sequence[Score]) -> str:
    head = f"{'config':16} {'frame':5} {'match ms':>8} {'remap':>6} {'hand px':>7} {'valid%':>6} {'phantom%':>8} {'gap%':>5} {'fingers':>7} {'sat-valid%':>10}"
    lines = [head, "-" * len(head)]
    for s in scores:
        lines.append(f"{s.config:16} {s.frame:5} {s.match_ms:8.1f} {s.remap_ms:6.1f} {s.hand_px:7d} {100 * s.valid_hand:6.0f} {s.phantom_pct:8.2f} {100 * s.gap_fill:5.0f} "
                     f"{s.fingers_depth:>3d}/{s.fingers_seen:<3d} {100 * s.saturated_valid:10.0f}  {'separated' if s.fingers_separated else 'blob'}")
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
    return p


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    configs = build_configs()
    if args.list:
        for c in configs.values():
            print(f"{c.name:16} {c.label}  {c.note}")
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
        for f in frames:
            s, images = score(c, f, rect, stereo, near_mm, far_mm, args.hand_threshold, args.repeat)
            scores.append(s)
            rows.append((c, f, s, images))
        print(f"  {c.name:16} " + "  ".join(f"[{s.frame}] {s.match_ms:5.1f} ms valid {100 * s.valid_hand:3.0f}% phantom {s.phantom_pct:5.2f}% gap {100 * s.gap_fill:3.0f}% fingers {s.fingers_depth}/{s.fingers_seen}" for s in scores[-len(frames):]))
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
