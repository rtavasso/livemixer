#!/usr/bin/env python3
"""Fuse a tracked hand skeleton into the depth scan.

The Leap Motion Controller's stereo depth is coarse: the pair is 640x240 with
about 2 px per degree vertically, fingers are 8-10 px wide in the raw images,
a hand close to the device saturates the IR image (no texture, so no match)
and the dark background behind it produces phantom near matches. The hand in
the scan is a blob. The tracking service's own hand model, on the other hand,
knows where every finger is even when the matcher cannot see it. This module
renders that model into a depth image in the SAME image frame as the measured
depth (column, row, millimetres; see :class:`depth_bridge.TrackedHand`) and
merges the two, so that everything downstream of the analyzer (the surface
scan, the voxels, the occupancy grid, the blobs) sees one foreground that
agrees with the skeleton.

Capsule model
-------------
:func:`hand_capsules` builds the same solid the browser builds from a skeleton
(``src/sim/input/skeleton.ts``): per finger the four bones carp->mcp, mcp->pip,
pip->dip and dip->tip with radius ``width / 2`` times ``1.15, 1, 0.9, 0.8``,
and the forearm wrist->elbow at ``0.85 * armWidth / 2``; plus a palm, which the
browser leaves to the metacarpals: three flattened capsules index-mcp->wrist,
pinky-mcp->wrist and index-mcp->pinky-mcp whose footprint is
``PALM_RADIUS_FACTOR * palmWidth`` wide but whose relief is only
``PALM_RELIEF_FACTOR * palmWidth`` (a palm is a slab, not a tube). A capsule is
a row ``ax, ay, az, bx, by, bz, radius, relief``: end points in pixels (u, v,
integer = pixel centre) and millimetres, the lateral radius in pixels at the
bone's depth (the widths a source reports are already in those units) and the
relief, how far the front face bulges out of the bone's axis at the centre
line, also in pixels.

Rasterisation
-------------
:func:`rasterize_capsules` treats each capsule as a tube around its segment in
image space: a pixel at distance ``d < radius`` from the segment (closest point
of the projected segment, so the ends are rounded caps) sees the surface at
``depth(t) - relief * sqrt(1 - d^2 / radius^2) * mm_per_px``, where ``depth(t)``
interpolates the ends' depths at the closest point and ``mm_per_px`` is the
size of a pixel at that depth: ``depth / focal_px`` for a perspective view
(the Leap sources know their focal length), or a constant for a source that
has none. That is the rounded tube ``surfaceFromCapsules`` in
``src/sim/input/synthetic.ts`` renders, in millimetres. The nearest capsule
wins at every pixel, only each capsule's bounding box is visited (capsules of
similar footprint as one batch), and the result is ``float32`` millimetres with
``inf`` where no capsule is. Two hands (48 capsules) cost about a millisecond
at 320x240 on a laptop.

Fusion
------
:func:`fuse_depth` merges the measurement (``uint16`` mm, 0 = no measurement)
with the model under one of four modes: ``fill`` keeps a measurement that
exists and agrees with the model within a tolerance, takes the model where
the measurement is missing or disagrees by more, and leaves everything outside
the model alone (the arm, objects); ``model`` takes the model wherever it has
a surface; ``off`` changes nothing; ``blend`` is ``fill`` made noise-aware
for the far hand (below). Model pixels outside the box's depth range count
as no model, so a hand outside the box adds nothing, exactly like a pixel
outside the range. The second result says which pixels came from the model,
which the analyzer reports as ``stats.scanModelFraction``.

``blend``: a hand 35-55 cm above the controller is measured with 5-10 mm of
local noise, a tenth of its pixels wrong by more than 15 % and holes all
over (the README's *Distance* table), and ``fill`` passes every measurement
that is within the tolerance of the model straight through, spikes
included. Under the model's silhouette ``blend`` first median-filters the
measurement (:data:`BLEND_MEDIAN` window, holes taken as the model so the
median does not drift into them), then applies ``fill``'s rule to the
smoothed value, and where it agrees mixes it with the model: ``(1 - w) *
smoothed + w * model`` with a weight that grows with the local noise of
the measurement (:func:`local_noise` over :data:`NOISE_WINDOW`, 0 at
:data:`BLEND_NOISE_MM[0]`, 1 at ``[1]``) and with the depth (0 and 1 at
:data:`BLEND_DEPTH_FRACTION` of the box's depth range, i.e. the far third
of the box; the larger of the two weights wins). A clean measurement at 27
cm is kept as measured, a noisy one at 45
cm reads as the smooth model with the measured relief where the
measurement is consistent, and outside the model nothing changes. A pixel
counts as "from the model" when the model replaced it or its weight is at
least a half.
"""
from __future__ import annotations

import os
import sys
from typing import Any, Sequence

import numpy as np

try:
    import cv2  # type: ignore[import-not-found]
except ImportError:  # pragma: no cover - the median then falls back to numpy
    cv2 = None

HERE = os.path.dirname(os.path.abspath(__file__))


def _bridge_module() -> Any:
    """``depth_bridge`` as already loaded (it may be ``__main__``), without importing a second copy."""
    main = sys.modules.get("__main__")
    if main is not None and os.path.basename(getattr(main, "__file__", "") or "") == "depth_bridge.py":
        return main
    if __package__:
        from . import depth_bridge  # type: ignore[import-not-found]
        return depth_bridge
    if HERE not in sys.path:
        sys.path.insert(0, HERE)
    import depth_bridge  # type: ignore[import-not-found]
    return depth_bridge


_db = _bridge_module()
TrackedHand = _db.TrackedHand
N_FINGERS, JOINTS_PER_FINGER = _db.N_FINGERS, _db.JOINTS_PER_FINGER
JOINT_WRIST, JOINT_ELBOW = _db.JOINT_WRIST, _db.JOINT_ELBOW
WIDTH_PALM, WIDTH_ARM, WIDTH_FINGERS = _db.WIDTH_PALM, _db.WIDTH_ARM, _db.WIDTH_FINGERS
finger_joint = _db.finger_joint
FUSE_MODES: tuple[str, ...] = _db.SCAN_FUSE_MODES  # ("off", "fill", "model", "blend")

#: ``blend``: the measurement's local noise (mm, standard deviation over :data:`NOISE_WINDOW`) at which the model's weight is 0 and 1.
BLEND_NOISE_MM = (5.0, 20.0)
#: ``blend``: where in the box's depth range (0 = near, 1 = far) the model's weight is 0 and 1 whatever the noise: the far third of the
#: box leans on the model (345-450 mm above a controller with the default 100-450 mm box, where its stereo is worst).
BLEND_DEPTH_FRACTION = (0.7, 1.0)


def blend_depth_range(near_mm: float, far_mm: float) -> tuple[float, float]:
    """The depths (mm) at which ``blend``'s depth ramp is 0 and 1 for a box ``[near_mm, far_mm]`` (:data:`BLEND_DEPTH_FRACTION`)."""
    span = float(far_mm) - float(near_mm)
    return float(near_mm) + BLEND_DEPTH_FRACTION[0] * span, float(near_mm) + BLEND_DEPTH_FRACTION[1] * span
#: ``blend``: the median window that smooths the measurement under the model (odd; 5 spans a finger's width at 45 cm on the Leap view).
BLEND_MEDIAN = 5
#: ``blend``: the window of the local noise estimate.
NOISE_WINDOW = 5

# Columns of a capsule row.
CAP_AX, CAP_AY, CAP_AZ, CAP_BX, CAP_BY, CAP_BZ, CAP_RADIUS, CAP_RELIEF = range(8)
CAPSULE_COLUMNS = 8
Bounds = tuple[int, int, int, int]  # (row0, row1, col0, col1), exclusive maxima

#: Width factor per finger bone from the carpal end outward (``skeleton.ts`` ``BONE_WIDTH_FACTORS``).
BONE_WIDTH_FACTORS = (1.15, 1.0, 0.9, 0.8)
#: Forearm width factor over the reported arm width (``skeleton.ts`` ``FOREARM_WIDTH_FACTOR``).
FOREARM_WIDTH_FACTOR = 0.85
#: Bones shorter than this are skipped, like the browser does (the Leap reports the thumb metacarpal as zero length).
MIN_BONE = 1e-6
#: Palm capsules: lateral half-width and relief as fractions of the palm width (a flattened slab between the knuckles and the wrist).
PALM_RADIUS_FACTOR = 0.25
PALM_RELIEF_FACTOR = 0.15
_INDEX, _PINKY, _MCP = 1, 4, 1

# The finger bones as index arrays: bone k of finger f runs from joint k to joint k + 1 with the finger's width times its factor.
_BONE_A = np.array([finger_joint(f, j) for f in range(N_FINGERS) for j in range(JOINTS_PER_FINGER - 1)])
_BONE_B = _BONE_A + 1
_BONE_WIDTH = np.repeat(np.arange(N_FINGERS) + WIDTH_FINGERS, JOINTS_PER_FINGER - 1)
_BONE_FACTOR = np.tile(np.asarray(BONE_WIDTH_FACTORS, dtype=np.float64), N_FINGERS)


def hand_capsules(hand: TrackedHand) -> np.ndarray:
    """The solid a tracked hand stands for: ``(N, 8)`` float64 rows ``ax, ay, az, bx, by, bz, radius, relief``.

    Twenty finger bones (four per finger), the forearm stub when the hand has
    an elbow, and the three palm capsules, in that order; bones of zero length
    or zero radius are left out. Coordinates are the hand's own (pixels and
    millimetres); radii are pixels at the part's depth, as the source reported
    its widths.
    """
    joints, widths = hand.joints, hand.widths_px
    a_idx, b_idx = list(_BONE_A), list(_BONE_B)
    radius = list(widths[_BONE_WIDTH] / 2.0 * _BONE_FACTOR)
    relief = list(radius)
    if hand.has_elbow:
        a_idx.append(JOINT_WRIST)
        b_idx.append(JOINT_ELBOW)
        radius.append(float(widths[WIDTH_ARM]) / 2.0 * FOREARM_WIDTH_FACTOR)
        relief.append(radius[-1])
    index_mcp, pinky_mcp = finger_joint(_INDEX, _MCP), finger_joint(_PINKY, _MCP)
    palm_width = float(widths[WIDTH_PALM])
    a_idx += [index_mcp, pinky_mcp, index_mcp]
    b_idx += [JOINT_WRIST, JOINT_WRIST, pinky_mcp]
    radius += [palm_width * PALM_RADIUS_FACTOR] * 3
    relief += [palm_width * PALM_RELIEF_FACTOR] * 3
    a, b = joints[a_idx], joints[b_idx]
    rows = np.column_stack([a, b, np.asarray(radius, dtype=np.float64), np.asarray(relief, dtype=np.float64)])
    keep = (rows[:, CAP_RADIUS] > 0.0) & (np.sum((a - b) ** 2, axis=1) >= MIN_BONE * MIN_BONE)
    return rows[keep]


def _boxes(caps: np.ndarray, shape: tuple[int, int], row_scale: float = 1.0) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """Per capsule its clipped bounding box: ``(row0, row1, col0, col1, visible)`` with inclusive maxima (a radius spans ``radius / row_scale`` rows)."""
    height, width = shape
    ax, ay, bx, by, radius = caps[:, CAP_AX], caps[:, CAP_AY], caps[:, CAP_BX], caps[:, CAP_BY], caps[:, CAP_RADIUS]
    row_radius = radius / row_scale
    lo_c, hi_c = np.floor(np.minimum(ax, bx) - radius), np.ceil(np.maximum(ax, bx) + radius)
    lo_r, hi_r = np.floor(np.minimum(ay, by) - row_radius), np.ceil(np.maximum(ay, by) + row_radius)
    visible = (radius > 0.0) & (hi_c >= 0) & (lo_c <= width - 1) & (hi_r >= 0) & (lo_r <= height - 1)
    c0, r0 = np.clip(lo_c, 0, width - 1).astype(np.int64), np.clip(lo_r, 0, height - 1).astype(np.int64)
    c1, r1 = np.clip(hi_c, 0, width - 1).astype(np.int64), np.clip(hi_r, 0, height - 1).astype(np.int64)
    return r0, r1, c0, c1, visible


def _batches(side: np.ndarray) -> list[np.ndarray]:
    """Group capsule indices by window size: largest first, a new group whenever the side drops below half the group's.

    Every capsule of a group is rendered in a window of the group's largest
    side, so a group wastes at most 4x the pixels of its smallest member;
    a hand's twenty finger bones land in one small group, the palm and the
    forearm in one or two larger ones.
    """
    order = np.argsort(-side, kind="stable")
    groups: list[np.ndarray] = []
    start = 0
    for i in range(1, len(order) + 1):
        if i == len(order) or side[order[i]] * 2 < side[order[start]]:
            groups.append(order[start:i])
            start = i
    return groups


def _check_capsules(capsules: np.ndarray | Sequence[Sequence[float]]) -> np.ndarray:
    caps = np.asarray(capsules, dtype=np.float64).reshape(-1, CAPSULE_COLUMNS)
    if caps.size and not np.isfinite(caps).all():
        raise ValueError("capsules must be finite")
    return caps


def capsule_bounds(capsules: np.ndarray | Sequence[Sequence[float]], shape: tuple[int, int], row_scale: float = 1.0) -> Bounds | None:
    """The union of the capsules' clipped bounding boxes as ``(row0, row1, col0, col1)`` (exclusive maxima), or ``None`` if none is visible."""
    caps = _check_capsules(capsules)
    if not caps.size:
        return None
    r0, r1, c0, c1, visible = _boxes(caps, (int(shape[0]), int(shape[1])), row_scale)
    if not visible.any():
        return None
    return int(r0[visible].min()), int(r1[visible].max()) + 1, int(c0[visible].min()), int(c1[visible].max()) + 1


def rasterize_capsules(
    capsules: np.ndarray | Sequence[Sequence[float]], shape: tuple[int, int],
    focal_px: float | None = None, mm_per_px: float = 1.0, out: np.ndarray | None = None, row_scale: float = 1.0,
) -> np.ndarray:
    """Depth image (``float32`` mm, ``inf`` where no capsule) of the nearest capsule surface at every pixel of ``shape = (height, width)``.

    Pixel ``(col, row)`` sits at ``(col, row)`` in the capsules' coordinates
    (integer = pixel centre). Only each capsule's bounding box, clipped to the
    image, is visited: a pixel there at distance ``d`` from the projected
    segment (``d < radius``) reads ``z - relief * sqrt(1 - d^2 / radius^2) *
    s`` with ``z`` the segment depth at the closest point and ``s`` the pixel
    size there, ``z / focal_px`` when a focal length is given, else
    ``mm_per_px``. A capsule with no projected length is a sphere at its
    nearer end. Capsules of similar footprint are computed together as one
    ``(K, S, S)`` batch (:func:`_batches`) and scattered into the canvas with
    a per-capsule ``minimum``, so the cost is a few vector operations per
    group rather than per capsule. ``out`` accumulates into an existing canvas
    (the nearest surface wins) instead of a fresh one. ``row_scale`` is the
    height of a pixel in units of its width (1 = square pixels): distances and
    radii are measured in column units, so a grid whose rows are taller than
    its columns (the front view of a metric box) still renders round tubes.
    """
    height, width = int(shape[0]), int(shape[1])
    canvas = np.full((height, width), np.inf, dtype=np.float32) if out is None else out
    if canvas.shape != (height, width) or canvas.dtype != np.float32:
        raise ValueError(f"out must be a float32 ({height}, {width}) canvas, got {canvas.dtype} {canvas.shape}")
    caps = _check_capsules(capsules)
    if focal_px is not None and not (float(focal_px) > 0.0):
        raise ValueError("focal_px must be positive")
    if not (float(row_scale) > 0.0):
        raise ValueError("row_scale must be positive")
    inv_focal = None if focal_px is None else 1.0 / float(focal_px)
    if not caps.size:
        return canvas
    # A degenerate capsule (no projected length) renders as a sphere at its nearer end: make that end ``a``.
    flat = (caps[:, CAP_BX] - caps[:, CAP_AX]) ** 2 + (caps[:, CAP_BY] - caps[:, CAP_AY]) ** 2 <= MIN_BONE * MIN_BONE
    swap = flat & (caps[:, CAP_BZ] < caps[:, CAP_AZ])
    if swap.any():
        caps = caps.copy()
        caps[swap, CAP_AX:CAP_AZ + 1], caps[swap, CAP_BX:CAP_BZ + 1] = caps[swap, CAP_BX:CAP_BZ + 1], caps[swap, CAP_AX:CAP_AZ + 1]
    r0, r1, c0, c1, visible = _boxes(caps, (height, width), row_scale)
    if not visible.any():
        return canvas
    side = np.where(visible, np.maximum(c1 - c0, r1 - r0) + 1, 0)  # each capsule's square window; a batch shares its largest
    caps32 = caps.astype(np.float32)
    f32, eps = np.float32, np.float32(MIN_BONE * MIN_BONE)
    row_scale32 = f32(row_scale)
    for group in _batches(side):
        group = group[side[group] > 0]
        if not group.size:
            continue
        size = int(side[group].max())
        g = caps32[group]                                              # (K, 8)
        steps = np.arange(size, dtype=np.float32)[None, :]
        rows0, cols0 = r0[group], c0[group]
        py = (rows0.astype(np.float32)[:, None] + steps - g[:, CAP_AY:CAP_AY + 1])[:, :, None]  # (K, S, 1), rows -> column units
        py *= row_scale32
        px = (cols0.astype(np.float32)[:, None] + steps - g[:, CAP_AX:CAP_AX + 1])[:, None, :]  # (K, 1, S)
        ab = (g[:, CAP_BX:CAP_BZ + 1] - g[:, CAP_AX:CAP_AZ + 1])[:, :, None, None]           # (K, 3, 1, 1)
        abx, aby, abz = ab[:, 0], ab[:, 1] * row_scale32, ab[:, 2]
        len2 = abx * abx + aby * aby
        inv_len2 = np.where(len2 > eps, f32(1.0) / np.maximum(len2, eps), f32(0.0))
        t = px * (abx * inv_len2) + py * (aby * inv_len2)  # (K, S, S): position along each segment, 0 for a sphere
        np.clip(t, 0.0, 1.0, out=t)
        dx = px - t * abx
        dy = py - t * aby
        d2 = dx * dx
        d2 += dy * dy
        rad2 = (g[:, CAP_RADIUS] * g[:, CAP_RADIUS])[:, None, None]
        inside = d2 < rad2
        bump = np.sqrt(np.maximum(f32(1.0) - d2 / rad2, f32(0.0)))
        bump *= g[:, CAP_RELIEF][:, None, None]
        z = g[:, CAP_AZ][:, None, None] + t * abz
        depth = z - bump * (z * f32(inv_focal) if inv_focal is not None else f32(mm_per_px))
        np.copyto(depth, f32(np.inf), where=~inside)
        for k, (rr, cc) in enumerate(zip(rows0.tolist(), cols0.tolist())):
            window = canvas[rr:rr + size, cc:cc + size]
            np.minimum(window, depth[k, :window.shape[0], :window.shape[1]], out=window)
    return canvas


def render_hands(
    hands: Sequence[TrackedHand], shape: tuple[int, int], offset: tuple[int, int] = (0, 0),
    focal_px: float | None = None, mm_per_px: float = 1.0, out: np.ndarray | None = None, row_scale: float = 1.0,
) -> tuple[np.ndarray, Bounds | None]:
    """The model depth of every hand over a ``shape = (height, width)`` window starting at pixel ``offset = (x0, y0)`` of the hands' image.

    Returns the canvas (``float32`` millimetres, ``inf`` where no hand is;
    ``out`` is reused as the canvas when given) and the bounding box of what
    it could have touched, ``(row0, row1, col0, col1)`` with exclusive maxima
    (:func:`capsule_bounds`), or ``None`` when no capsule reaches the window.
    The analyzer renders over its ROI, which is why the window and offset
    exist, and fuses only inside the box. ``row_scale`` is passed to
    :func:`rasterize_capsules` for grids whose cells are not square.
    """
    shape = (int(shape[0]), int(shape[1]))
    if out is None:
        canvas = np.full(shape, np.inf, dtype=np.float32)
    else:
        canvas = out
        canvas.fill(np.inf)
    caps = np.concatenate([hand_capsules(hand) for hand in hands]) if hands else np.zeros((0, CAPSULE_COLUMNS))
    x0, y0 = float(offset[0]), float(offset[1])
    if x0 or y0:
        caps[:, [CAP_AX, CAP_BX]] -= x0
        caps[:, [CAP_AY, CAP_BY]] -= y0
    rasterize_capsules(caps, shape, focal_px, mm_per_px, out=canvas, row_scale=row_scale)
    return canvas, capsule_bounds(caps, shape, row_scale)


def local_noise(values: np.ndarray, valid: np.ndarray, window: int = NOISE_WINDOW) -> np.ndarray:
    """Standard deviation of the ``valid`` entries of ``values`` (``float32``) over a ``window x window`` box around every pixel (0 where fewer than two are valid)."""
    v = np.where(valid, values, 0.0).astype(np.float32)
    n = valid.astype(np.float32)
    k = (int(window), int(window))
    if cv2 is not None:
        den = cv2.boxFilter(n, -1, k, normalize=False, borderType=cv2.BORDER_CONSTANT)
        num = cv2.boxFilter(v, -1, k, normalize=False, borderType=cv2.BORDER_CONSTANT)
        sq = cv2.boxFilter(v * v, -1, k, normalize=False, borderType=cv2.BORDER_CONSTANT)
    else:  # pragma: no cover - pure numpy box sums (slower; OpenCV is required by the Leap sources anyway)
        def box(a: np.ndarray) -> np.ndarray:
            r = int(window) // 2
            p = np.pad(a, r)
            c = np.cumsum(np.cumsum(p, axis=0), axis=1)
            c = np.pad(c, ((1, 0), (1, 0)))
            h, w = a.shape
            return c[window:window + h, window:window + w] - c[:h, window:window + w] - c[window:window + h, :w] + c[:h, :w]
        den, num, sq = box(n), box(v), box(v * v)
    safe = np.maximum(den, 1.0)
    mean = num / safe
    var = np.maximum(sq / safe - mean * mean, 0.0)
    return np.where(den >= 2.0, np.sqrt(var), 0.0).astype(np.float32)


def blend_weight(noise_mm: np.ndarray, depth_mm: np.ndarray | float, noise_range: tuple[float, float] = BLEND_NOISE_MM, depth_range: tuple[float, float] = (350.0, 450.0)) -> np.ndarray:
    """The model's share, 0..1, from the measurement's local noise and its depth: the larger of two linear ramps (``float32``; ``depth_range`` from :func:`blend_depth_range`)."""
    n0, n1 = noise_range
    d0, d1 = depth_range
    w_noise = np.clip((np.asarray(noise_mm, dtype=np.float32) - n0) / max(n1 - n0, 1e-6), 0.0, 1.0)
    w_depth = np.clip((np.asarray(depth_mm, dtype=np.float32) - d0) / max(d1 - d0, 1e-6), 0.0, 1.0)
    return np.maximum(w_noise, w_depth).astype(np.float32)


def _median(image: np.ndarray, window: int) -> np.ndarray:
    """``window x window`` median of a ``float32`` image (OpenCV; a numpy fallback for environments without it)."""
    if window <= 1:
        return image
    if cv2 is not None:
        return cv2.medianBlur(np.ascontiguousarray(image, dtype=np.float32), int(window))
    r = int(window) // 2  # pragma: no cover
    padded = np.pad(image, r, mode="edge")
    stack = np.stack([padded[dy:dy + image.shape[0], dx:dx + image.shape[1]] for dy in range(window) for dx in range(window)])
    return np.median(stack, axis=0).astype(np.float32)


def _blend(seen: np.ndarray, valid: np.ndarray, model: np.ndarray, has_model: np.ndarray, tolerance_mm: float, depth_for_weight: np.ndarray | float,
           depth_range: tuple[float, float], median: int = BLEND_MEDIAN) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """The ``blend`` rule on ``float32`` arrays: ``(value under the model, taken from the model, model weight)``.

    ``seen`` is the measurement (any value where ``valid`` is false is
    ignored), ``model`` the model depth where ``has_model``. The smoothed
    measurement is a median over the measurement with holes taken as the
    model; where it agrees with the model within the tolerance the result is
    ``(1 - w) * smoothed + w * model``, elsewhere under the model it is the
    model. Outside the model the returned value is ``seen`` (callers keep
    their own there). ``depth_for_weight`` and ``depth_range`` feed the
    depth ramp of :func:`blend_weight`.
    """
    model_here = np.where(has_model, model, 0.0).astype(np.float32)  # finite everywhere: inf outside the model would poison the mix
    filled = np.where(valid, seen, np.where(has_model, model_here, seen)).astype(np.float32)
    smoothed = _median(filled, median)
    noise = local_noise(seen, valid)
    weight = blend_weight(noise, depth_for_weight, depth_range=depth_range)
    agree = has_model & valid & np.isfinite(smoothed) & (np.abs(smoothed - model_here) <= np.float32(tolerance_mm))
    mixed = (1.0 - weight) * np.where(np.isfinite(smoothed), smoothed, 0.0) + weight * model_here
    value = np.where(agree, mixed, np.where(has_model, model_here, seen)).astype(np.float32)
    take = has_model & (~agree | (weight >= 0.5))
    return value, take, weight


def fuse_front(measured: np.ndarray, model: np.ndarray, mode: str, tolerance_mm: float, depth_mm: float, height_range_mm: tuple[float, float] | None = None) -> tuple[np.ndarray, np.ndarray]:
    """Merge two front views (``float32`` reach in mm, ``inf`` = nothing there) under the same rules as :func:`fuse_depth`: ``(fused, from_model)``.

    The upright frame's scan is a height field over the FRONT of the box (u
    across, v down, and the value the nearest reach ``w`` in millimetres from
    the box's front plane), so the measurement is the extruded underside the
    camera saw and the model is the capsules rendered orthographically from
    the front. The model counts only where its reach lies inside ``[0,
    depth_mm]`` (a model face past the box's front or back plane is dropped
    like any point outside the box). Then ``fill`` takes the model where the
    measurement is empty or differs by more than ``tolerance_mm`` and keeps
    the measurement where it agrees; ``model`` takes the model wherever it
    counts; ``off`` returns the measurement and an all-false mask; ``blend``
    (module docstring) smooths the measurement under the model and mixes it
    toward the model by its local noise and, when ``height_range_mm =
    (near, far)`` is given, by the height above the device of each row (row
    0 is the top of the box, ``far``; the last row ``near``; the ramp is
    :func:`blend_depth_range` of that range).
    """
    if mode not in FUSE_MODES:
        raise ValueError(f"scan fusion mode must be one of {FUSE_MODES}, got {mode!r}")
    if measured.ndim != 2 or model.shape != measured.shape:
        raise ValueError(f"model {model.shape} and measurement {measured.shape} must be the same 2-D shape")
    if tolerance_mm < 0.0:
        raise ValueError("tolerance must be non-negative")
    if mode == "off":
        return measured, np.zeros(measured.shape, dtype=bool)
    has_model = (model >= 0.0) & (model <= float(depth_mm))  # inf fails the upper bound: no model there
    if mode == "model":
        take = has_model
    elif mode == "blend":
        valid = np.isfinite(measured)
        if height_range_mm is None:
            height: np.ndarray | float = 0.0
            ramp = (1.0, 2.0)  # never reached: the noise alone decides
        else:
            near, far = float(height_range_mm[0]), float(height_range_mm[1])
            rows = measured.shape[0]
            height = (far - (np.arange(rows, dtype=np.float32) + 0.5) / rows * (far - near))[:, None] * np.ones((1, measured.shape[1]), dtype=np.float32)
            ramp = blend_depth_range(near, far)
        value, take, _ = _blend(measured, valid, model, has_model, tolerance_mm, height, ramp)
        fused = np.where(has_model, value, measured).astype(np.float32, copy=False)
        return fused, take
    else:
        both = has_model & np.isfinite(measured)
        gap = np.full(measured.shape, np.inf, dtype=np.float32)
        np.subtract(measured, model, out=gap, where=both)  # only where both exist: inf - inf is not a disagreement, it is nothing
        keep = both & (np.abs(gap) <= np.float32(tolerance_mm))
        take = has_model & ~keep
    fused = np.where(take, model, measured).astype(np.float32, copy=False)
    return fused, take


def isotropic_mm_per_px(near_mm: float, far_mm: float, roi_width_px: int) -> float:
    """Pixel size for a source without a focal length: the box treated as isotropic, its depth range over its width in pixels."""
    return (float(far_mm) - float(near_mm)) / max(int(roi_width_px), 1)


def fuse_depth(
    measured: np.ndarray, model: np.ndarray, mode: str, tolerance_mm: float, near_mm: float, far_mm: float, bounds: Bounds | None = None,
) -> tuple[np.ndarray, np.ndarray]:
    """Merge a measured depth image with the hand model: ``(fused uint16 mm, from_model bool)``.

    ``measured`` is ``uint16`` millimetres (0 = no measurement), ``model`` the
    ``float32`` canvas of :func:`render_hands` of the same shape and ``bounds``
    the box it returned (found by scanning the model when omitted); only that
    box is looked at. The model counts only where it is finite and inside
    ``[near_mm, far_mm]`` (like any pixel, a model surface outside the box is
    not in the box). Then:

    * ``off``: the measurement, untouched, and an all-false mask.
    * ``fill``: where the model counts and the measurement is missing (0) or
      differs from the model by more than ``tolerance_mm``, the model; where
      the measurement exists and agrees, the measurement; outside the model,
      the measurement.
    * ``model``: the model wherever it counts, the measurement elsewhere.
    * ``blend``: under the model, the median-smoothed measurement mixed
      toward the model by its local noise and its depth where it agrees with
      the model within the tolerance, the model where it is missing or
      disagrees (module docstring); outside the model, the measurement.
    """
    if mode not in FUSE_MODES:
        raise ValueError(f"scan fusion mode must be one of {FUSE_MODES}, got {mode!r}")
    if measured.dtype != np.uint16 or measured.ndim != 2:
        raise ValueError(f"measured depth must be a 2-D uint16 image, got {measured.dtype} {measured.shape}")
    if mode == "off":
        return measured, np.zeros(measured.shape, dtype=bool)
    if model.shape != measured.shape:
        raise ValueError(f"model {model.shape} and measurement {measured.shape} differ in shape")
    if tolerance_mm < 0.0:
        raise ValueError("tolerance must be non-negative")
    take = np.zeros(measured.shape, dtype=bool)
    if bounds is None:
        finite = np.isfinite(model)
        rows, cols = np.flatnonzero(finite.any(axis=1)), np.flatnonzero(finite.any(axis=0))
        if not rows.size:
            return measured, take
        bounds = (int(rows[0]), int(rows[-1]) + 1, int(cols[0]), int(cols[-1]) + 1)
    r0, r1, c0, c1 = bounds
    if mode == "blend":
        # A margin around the model's box so the median and the noise estimate see the measurement's surroundings.
        m = max(BLEND_MEDIAN, NOISE_WINDOW) // 2
        r0, r1, c0, c1 = max(r0 - m, 0), min(r1 + m, measured.shape[0]), max(c0 - m, 0), min(c1 + m, measured.shape[1])
    window, seen = model[r0:r1, c0:c1], measured[r0:r1, c0:c1]
    has_model = (window >= max(float(near_mm), 1.0)) & (window <= float(far_mm))  # inf fails the upper bound: no model there
    fused = measured.copy()
    if mode == "model":
        take_here = has_model
    elif mode == "blend":
        valid = seen != 0
        value, take_here, _ = _blend(seen.astype(np.float32), valid, window, has_model, tolerance_mm, np.where(has_model, window, 0.0), blend_depth_range(near_mm, far_mm))
        fused[r0:r1, c0:c1][has_model] = np.clip(np.rint(value[has_model]), 1.0, 65535.0).astype(np.uint16)
        take[r0:r1, c0:c1] = take_here
        return fused, take
    else:
        keep = (seen != 0) & (np.abs(seen.astype(np.float32) - window) <= np.float32(tolerance_mm))
        take_here = has_model & ~keep
    fused[r0:r1, c0:c1][take_here] = np.clip(np.rint(window[take_here]), 1.0, 65535.0).astype(np.uint16)
    take[r0:r1, c0:c1] = take_here
    return fused, take
