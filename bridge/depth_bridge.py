#!/usr/bin/env python3
"""Reference depth-camera bridge for the livemixer simulations.

A depth camera looks at a physical *box* in front of it. Anything inside the
box (a hand, an arm, a whole person) is reduced to a handful of numbers and
streamed to the browser as JSON text over a WebSocket. The wire format is
defined by ``src/sim/input/protocol.ts`` (the single source of truth); this
file is the reference producer and ``bridge/test_bridge.py`` checks its output
against that schema's shapes.

Geometry conventions
--------------------
* A depth image is a ``(height, width)`` array of ``uint16`` millimetres.
  Row index grows *downwards*, column index grows *rightwards*, exactly like
  the camera image. A value of 0 means "no measurement" (RealSense convention)
  and is never inside the box.
* The **region of interest** (ROI) is an axis-aligned rectangle of the image
  given as fractions ``x0 y0 x1 y1`` of the width/height. It selects which
  columns and rows count as "the box" laterally. Everything the bridge reports
  is normalized *to the ROI*, so a hand at the ROI's left edge has ``u = 0``
  no matter where the ROI sits inside the frame.
* The **depth range** ``[near, far]`` in metres selects which pixels are
  "inside the box" along the camera's optical axis.
  ``w = (depth - near) / (far - near)``: ``w = 0`` is the plane nearest the
  camera, ``w = 1`` the farthest plane.
* A reported point is ``[u, v, w]`` with ``u`` rightwards, ``v`` downwards and
  ``w`` deeper into the box, each clamped to ``[0, 1]``. The browser turns this
  camera-oriented frame into simulation space (mirror, flip y, two-corner
  calibration); the bridge never needs camera intrinsics.
* The occupancy grid covers the same ROI: cell ``(row 0, col 0)`` is the
  top-left of the ROI, row-major, one byte per cell holding the fraction of
  in-range pixels in that cell scaled to 0..255.

Dependencies: ``numpy`` and ``websockets`` (``pip install numpy websockets``).
Optional: ``opencv-python`` for multi-blob connected components and
``pyrealsense2`` for the Intel RealSense source.
"""
from __future__ import annotations

import argparse
import asyncio
import base64
import json
import logging
import math
import sys
import time
from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Any, Callable, Sequence, TextIO

try:
    import numpy as np
except ImportError as exc:  # pragma: no cover - import guard
    raise SystemExit("depth_bridge needs numpy. Install it with: pip install numpy websockets") from exc

try:
    import cv2  # type: ignore[import-not-found]

    HAVE_OPENCV = True
except ImportError:  # pragma: no cover - optional dependency
    cv2 = None
    HAVE_OPENCV = False

PROTOCOL_VERSION = 1
MAX_HANDS = 16            # bridgeFrameSchema: hands.max(16)
MAX_POINTS = 256          # bridgeHandSchema: points.max(256)
MAX_OCCUPANCY_SIDE = 256  # bridgeHelloSchema: occupancy width/height.max(256)
DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8765

log = logging.getLogger("depth_bridge")

Vec3 = tuple[float, float, float]


# --------------------------------------------------------------------------- #
# Frames and sources
# --------------------------------------------------------------------------- #


@dataclass(frozen=True)
class DepthFrame:
    """One depth image.

    ``depth_mm`` is ``uint16`` millimetres with shape ``(height, width)``;
    0 means "no measurement". ``timestamp`` is seconds on
    ``time.perf_counter()``'s clock, taken as close to capture as possible.
    """

    depth_mm: np.ndarray
    timestamp: float

    def __post_init__(self) -> None:
        if self.depth_mm.ndim != 2:
            raise ValueError(f"depth image must be 2-D, got shape {self.depth_mm.shape}")
        if self.depth_mm.dtype != np.uint16:
            raise ValueError(f"depth image must be uint16 millimetres, got {self.depth_mm.dtype}")

    @property
    def height(self) -> int:
        return int(self.depth_mm.shape[0])

    @property
    def width(self) -> int:
        return int(self.depth_mm.shape[1])


class FrameSource(ABC):
    """A camera (or a stand-in) that produces :class:`DepthFrame` objects.

    ``read()`` blocks until the next frame is available and is called from a
    worker thread by the server, so it may sleep or wait on hardware. It should
    raise on hardware errors; the server reports the error to clients and
    restarts the source with backoff.
    """

    #: Reported to the browser in the ``hello`` message as ``source``.
    name: str = "unknown"
    #: Nominal capture rate, or ``None`` when unknown.
    fps: float | None = None

    def start(self) -> None:
        """Open the device. Called once before the first ``read()``."""

    @abstractmethod
    def read(self) -> DepthFrame:
        """Block until the next depth frame is available and return it."""

    def stop(self) -> None:
        """Release the device. Safe to call more than once."""


@dataclass(frozen=True)
class ScriptedHand:
    """Where the synthetic performer's hand is at one instant.

    ``x``/``y`` are fractions of the image (right, down), ``z`` is depth into
    the box in ``[0, 1]`` and ``r`` the blob's half-width as a fraction of the
    image width (the blob is 1.4x taller than wide, like a hand seen palm-on).
    """

    x: float
    y: float
    z: float
    r: float


class SyntheticSource(FrameSource):
    """No hardware: renders a scripted performer into a depth image.

    The script mirrors ``src/sim/input/synthetic.ts``: one or two hands sweep
    figure-eights, leave the box for 3 s out of every 14, and occasionally push
    towards the far plane. A flat backdrop sits behind the far plane so the
    analyzer has something to reject. Rendering is a pure function of the
    script time ``t`` (``render(t)``), which makes it deterministic for tests;
    ``read()`` derives ``t`` from the wall clock and paces itself to ``fps``.
    """

    name = "synthetic"

    def __init__(
        self,
        width: int = 640,
        height: int = 480,
        fps: float = 30.0,
        near_m: float = 0.4,
        far_m: float = 1.2,
        hands: int = 1,
        absences: bool = True,
        speed: float = 1.0,
        paced: bool = True,
        backdrop_mm: float = 300.0,
        dome_mm: float = 40.0,
    ) -> None:
        if hands not in (1, 2):
            raise ValueError("synthetic source supports 1 or 2 hands")
        if fps <= 0:
            raise ValueError("fps must be positive")
        self.width, self.height, self.fps = width, height, float(fps)
        self.hands, self.absences, self.speed, self.paced = hands, absences, speed, paced
        self._near_mm, self._far_mm = near_m * 1000.0, far_m * 1000.0
        self.backdrop_mm, self.dome_mm = backdrop_mm, dome_mm
        self._origin: float | None = None
        self._next_due = 0.0
        self._xs = (np.arange(width, dtype=np.float32) + 0.5) / width
        self._ys = (np.arange(height, dtype=np.float32) + 0.5) / height

    def start(self) -> None:
        self._origin = None

    def scripted_hands(self, t: float) -> list[ScriptedHand]:
        """Analytic hand positions at script time ``t`` (seconds)."""
        if self.absences and (t % 14.0) >= 11.0:
            return []
        hands: list[ScriptedHand] = []
        for i in range(self.hands):
            offset = i * math.pi
            x = 0.5 + 0.32 * math.sin(t * 0.7 + offset)
            y = 0.5 + 0.22 * math.sin(t * 1.4 + offset) * math.cos(t * 0.3)
            push = max(0.0, math.sin(t * 0.45 + i)) ** 6  # brief pushes
            z = 0.25 + 0.7 * push
            r = 0.05 + 0.02 * math.sin(t * 0.9)
            hands.append(ScriptedHand(x, y, z, r))
        return hands

    def render(self, t: float) -> np.ndarray:
        """Depth image (uint16 mm) of the scene at script time ``t``."""
        canvas = np.full((self.height, self.width), self._far_mm + self.backdrop_mm, dtype=np.float32)
        span = self._far_mm - self._near_mm
        for hand in self.scripted_hands(t):
            dx = (self._xs[None, :] - hand.x) / hand.r
            dy = (self._ys[:, None] - hand.y) / (hand.r * 1.4)
            rho2 = dx * dx + dy * dy
            centre = self._near_mm + hand.z * span
            surface = centre + self.dome_mm * rho2  # a shallow dome: the middle is nearest
            canvas = np.where(rho2 <= 1.0, np.minimum(canvas, surface), canvas)
        return np.clip(canvas, 0, 65535).astype(np.uint16)

    def read(self) -> DepthFrame:
        now = time.perf_counter()
        if self._origin is None:
            self._origin = now
            self._next_due = now
        elif self.paced and now < self._next_due:
            time.sleep(self._next_due - now)
            now = time.perf_counter()
        period = 1.0 / self.fps
        self._next_due = max(self._next_due, now - period) + period
        return DepthFrame(self.render((now - self._origin) * self.speed), now)


class RealSenseSource(FrameSource):
    """Intel RealSense depth stream via ``pyrealsense2``.

    Streams Z16 depth at ``width x height @ fps`` (640x480 @ 30 by default).
    An optional decimation filter shrinks the image by its magnitude (the ROI
    is in fractions, so nothing else changes). Hole filling is off by default:
    filled holes invent depth where the sensor saw nothing, which reads as
    phantom matter inside the box.
    """

    name = "realsense"

    def __init__(self, width: int = 640, height: int = 480, fps: float = 30.0, decimation: int = 0, hole_filling: bool = False) -> None:
        self.width, self.height, self.fps = width, height, float(fps)
        self.decimation, self.hole_filling = decimation, hole_filling
        self._pipeline: Any = None
        self._filters: list[Any] = []
        self._mm_per_unit = 1.0

    def start(self) -> None:
        try:
            import pyrealsense2 as rs  # type: ignore[import-not-found]
        except ImportError as exc:
            raise RuntimeError(
                "pyrealsense2 is not installed. Install the Intel RealSense SDK wrapper with "
                "'pip install pyrealsense2' (or use --source synthetic to run without hardware)."
            ) from exc
        pipeline = rs.pipeline()
        config = rs.config()
        config.enable_stream(rs.stream.depth, self.width, self.height, rs.format.z16, int(round(self.fps)))
        profile = pipeline.start(config)
        depth_scale = float(profile.get_device().first_depth_sensor().get_depth_scale())  # metres per unit
        self._mm_per_unit = depth_scale * 1000.0
        self._filters = []
        if self.decimation > 0:
            dec = rs.decimation_filter()
            dec.set_option(rs.option.filter_magnitude, float(self.decimation))
            self._filters.append(dec)
        if self.hole_filling:
            self._filters.append(rs.hole_filling_filter())
        self._pipeline = pipeline
        log.info("RealSense started: %dx%d @ %g fps, depth scale %.6f m", self.width, self.height, self.fps, depth_scale)

    def read(self) -> DepthFrame:
        if self._pipeline is None:
            raise RuntimeError("RealSenseSource.read() before start()")
        frames = self._pipeline.wait_for_frames(5000)
        depth = frames.get_depth_frame()
        if not depth:
            raise RuntimeError("RealSense delivered a frameset without depth")
        for f in self._filters:
            depth = f.process(depth)
        stamp = time.perf_counter()
        raw = np.asanyarray(depth.get_data())
        if abs(self._mm_per_unit - 1.0) > 1e-6:
            raw = np.clip(raw.astype(np.float32) * self._mm_per_unit, 0, 65535)
        return DepthFrame(np.ascontiguousarray(raw, dtype=np.uint16), stamp)

    def stop(self) -> None:
        if self._pipeline is not None:
            try:
                self._pipeline.stop()
            finally:
                self._pipeline = None


class AzureKinectSource(FrameSource):
    """STUB - not implemented. Shows how to add another camera.

    Any depth camera fits by subclassing :class:`FrameSource` and returning
    ``uint16`` millimetres from ``read()``; the analyzer and server need nothing
    else. Add the class to :data:`SOURCES` and it becomes a ``--source`` choice.

    Azure Kinect (``pip install pyk4a``)::

        from pyk4a import PyK4A, Config, DepthMode, FPS
        k4a = PyK4A(Config(depth_mode=DepthMode.NFOV_UNBINNED, camera_fps=FPS.FPS_30))
        k4a.start()                            # in start()
        capture = k4a.get_capture()            # in read()
        depth = capture.depth                  # uint16 mm already, shape (576, 640)
        return DepthFrame(np.ascontiguousarray(depth, dtype=np.uint16), time.perf_counter())
        k4a.stop()                             # in stop()

    OpenNI2 devices (Orbbec, Asus Xtion; ``pip install openni``)::

        from openni import openni2
        openni2.initialize(); dev = openni2.Device.open_any()
        stream = dev.create_depth_stream(); stream.start()          # in start()
        frame = stream.read_frame()                                 # in read()
        buf = frame.get_buffer_as_uint16()                          # 1 mm units for PIXEL_FORMAT_DEPTH_1_MM
        depth = np.frombuffer(buf, dtype=np.uint16).reshape(frame.height, frame.width)
        stream.stop(); openni2.unload()                             # in stop()

    Whatever the device, keep row 0 as the top of the image and column 0 as
    the left, and convert to millimetres if the SDK reports another unit.
    """

    name = "kinect"

    def start(self) -> None:
        raise NotImplementedError("AzureKinectSource is a stub; see its docstring for how to implement it with pyk4a.")

    def read(self) -> DepthFrame:  # pragma: no cover - stub
        raise NotImplementedError


# --------------------------------------------------------------------------- #
# Box geometry and analysis
# --------------------------------------------------------------------------- #


@dataclass(frozen=True)
class BoxConfig:
    """The physical box as the camera sees it.

    ``near_m``/``far_m`` bound the box along the optical axis (metres from the
    camera). ``roi`` is ``(x0, y0, x1, y1)`` as fractions of the image and
    bounds it laterally. ``box_x``/``box_y`` are the box's metric extents,
    reported in ``hello`` for humans and telemetry only; the bridge never uses
    them for maths because it has no intrinsics.
    """

    near_m: float = 0.4
    far_m: float = 1.2
    roi: tuple[float, float, float, float] = (0.0, 0.0, 1.0, 1.0)
    box_x: tuple[float, float] = (-0.5, 0.5)
    box_y: tuple[float, float] = (-0.4, 0.4)

    def __post_init__(self) -> None:
        if not (0.0 <= self.near_m < self.far_m):
            raise ValueError(f"need 0 <= near < far, got near={self.near_m} far={self.far_m}")
        x0, y0, x1, y1 = self.roi
        if not (0.0 <= x0 < x1 <= 1.0 and 0.0 <= y0 < y1 <= 1.0):
            raise ValueError(f"roi must satisfy 0 <= x0 < x1 <= 1 and 0 <= y0 < y1 <= 1, got {self.roi}")

    @property
    def near_mm(self) -> float:
        return self.near_m * 1000.0

    @property
    def far_mm(self) -> float:
        return self.far_m * 1000.0

    def roi_pixels(self, width: int, height: int) -> tuple[int, int, int, int]:
        """The ROI as ``(x0, y0, x1, y1)`` pixel bounds (exclusive max), at least 1x1."""
        x0, y0, x1, y1 = self.roi
        px0, px1 = int(round(x0 * width)), int(round(x1 * width))
        py0, py1 = int(round(y0 * height)), int(round(y1 * height))
        px0, py0 = min(px0, width - 1), min(py0, height - 1)
        return px0, py0, max(px1, px0 + 1), max(py1, py0 + 1)


@dataclass(frozen=True)
class AnalyzerConfig:
    """Tuning for :class:`BoxAnalyzer`.

    ``occupancy`` is ``(width, height)`` of the grid or ``None`` to skip it.
    A blob needs at least ``min_pixels`` in-range pixels; confidence rises
    linearly from there and saturates at ``conf_saturation * min_pixels``.
    ``morph_iterations`` rounds of 3x3 opening remove speckle. ``max_jump`` is
    the largest normalized centroid move (u/v) that still counts as the same
    blob; a blob missing for more than ``max_missed`` frames loses its id.
    ``depth_percentile`` picks the blob depth (10 = its nearest tenth, so a
    reaching hand reads as pushed even when the arm behind it is in the box).
    """

    occupancy: tuple[int, int] | None = (32, 24)
    min_pixels: int = 150
    max_hands: int = 2
    morph_iterations: int = 1
    sample_points: int = 16
    max_jump: float = 0.25
    max_missed: int = 5
    depth_percentile: float = 10.0
    conf_saturation: float = 4.0

    def __post_init__(self) -> None:
        if self.occupancy is not None:
            w, h = self.occupancy
            if not (1 <= w <= MAX_OCCUPANCY_SIDE and 1 <= h <= MAX_OCCUPANCY_SIDE):
                raise ValueError(f"occupancy grid sides must be 1..{MAX_OCCUPANCY_SIDE}, got {self.occupancy}")
        if not (0 <= self.max_hands <= MAX_HANDS):
            raise ValueError(f"max_hands must be 0..{MAX_HANDS}")
        if not (0 <= self.sample_points <= MAX_POINTS):
            raise ValueError(f"sample_points must be 0..{MAX_POINTS}")
        if self.min_pixels < 1:
            raise ValueError("min_pixels must be at least 1")


@dataclass(frozen=True)
class Blob:
    """One tracked blob in ROI-normalized coordinates (see module docstring).

    ``w`` is the nearest-percentile depth. ``extent`` is
    ``((min_u, min_v, w_near), (max_u, max_v, w_far))`` where ``w_near``/``w_far``
    are the low/high depth percentiles rather than raw min/max, so one stray
    pixel does not stretch the box.
    """

    id: int
    u: float
    v: float
    w: float
    extent: tuple[Vec3, Vec3]
    conf: float
    pixels: int
    points: tuple[Vec3, ...]

    @property
    def pos(self) -> Vec3:
        return (self.u, self.v, self.w)


@dataclass(frozen=True)
class AnalysisResult:
    blobs: tuple[Blob, ...]
    #: ``uint8`` array of shape ``(height, width)``, row 0 = top of the ROI; ``None`` when disabled.
    occupancy: np.ndarray | None
    stats: dict[str, float]


def erode3(mask: np.ndarray, iterations: int = 1) -> np.ndarray:
    """Binary erosion with a 3x3 structuring element (pure numpy)."""
    h, w = mask.shape
    for _ in range(iterations):
        padded = np.pad(mask, 1, constant_values=False)
        out = np.ones_like(mask)
        for dy in range(3):
            for dx in range(3):
                out &= padded[dy:dy + h, dx:dx + w]
        mask = out
    return mask


def dilate3(mask: np.ndarray, iterations: int = 1) -> np.ndarray:
    """Binary dilation with a 3x3 structuring element (pure numpy)."""
    h, w = mask.shape
    for _ in range(iterations):
        padded = np.pad(mask, 1, constant_values=False)
        out = np.zeros_like(mask)
        for dy in range(3):
            for dx in range(3):
                out |= padded[dy:dy + h, dx:dx + w]
        mask = out
    return mask


def open_mask(mask: np.ndarray, iterations: int = 1) -> np.ndarray:
    """Morphological opening: removes specks smaller than the element, keeps blob size."""
    if iterations <= 0:
        return mask
    return dilate3(erode3(mask, iterations), iterations)


def downsample_occupancy(mask: np.ndarray, width: int, height: int) -> np.ndarray:
    """Fraction of ``True`` pixels per cell as ``uint8`` 0..255, shape ``(height, width)``.

    Row 0 of the result covers the top rows of ``mask``. Cells are laid out by
    rounding ``linspace`` edges, so any mask size works; a cell that receives
    no pixels (mask smaller than the grid) reads 0.
    """
    h, w = mask.shape
    rows = np.round(np.linspace(0, h, height + 1)).astype(np.int64)
    cols = np.round(np.linspace(0, w, width + 1)).astype(np.int64)
    integral = np.zeros((h + 1, w + 1), dtype=np.int64)
    integral[1:, 1:] = mask.astype(np.int32).cumsum(axis=0).cumsum(axis=1)
    corners = integral[rows][:, cols]
    sums = corners[1:, 1:] - corners[:-1, 1:] - corners[1:, :-1] + corners[:-1, :-1]
    areas = np.outer(np.diff(rows), np.diff(cols))
    frac = sums / np.maximum(areas, 1)
    return np.clip(np.round(frac * 255.0), 0, 255).astype(np.uint8)


def label_components(mask: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Connected components of a boolean mask.

    Returns ``(labels, areas)``: ``labels`` is an integer image with 0 for
    background and ``1..n`` per component; ``areas[k - 1]`` is label ``k``'s
    pixel count. With OpenCV installed this is true 8-connected labelling;
    without it every in-range pixel belongs to one blob (label 1).
    """
    if HAVE_OPENCV:
        count, labels, stats, _ = cv2.connectedComponentsWithStats(mask.astype(np.uint8), connectivity=8)
        return labels, stats[1:count, cv2.CC_STAT_AREA].astype(np.int64)
    area = int(np.count_nonzero(mask))
    labels = mask.astype(np.int32)
    return labels, (np.array([area], dtype=np.int64) if area else np.zeros(0, dtype=np.int64))


@dataclass
class _Track:
    id: int
    u: float
    v: float
    missed: int = 0


class BlobTracker:
    """Assigns stable ids to blobs by greedy nearest-centroid matching.

    Distances are in ROI-normalized u/v units. Pairs are matched closest-first;
    a blob farther than ``max_jump`` from every unmatched track starts a new
    id. Tracks survive ``max_missed`` frames of absence so a one-frame dropout
    keeps its id; ids never repeat within a run.
    """

    def __init__(self, max_jump: float = 0.25, max_missed: int = 5) -> None:
        self.max_jump, self.max_missed = max_jump, max_missed
        self._tracks: dict[int, _Track] = {}
        self._next_id = 1

    def reset(self) -> None:
        self._tracks.clear()
        self._next_id = 1

    def update(self, centroids: Sequence[tuple[float, float]]) -> list[int]:
        """Return one id per centroid, in the same order."""
        pairs: list[tuple[float, int, int]] = []
        for tid, track in self._tracks.items():
            for ci, (u, v) in enumerate(centroids):
                d = math.hypot(u - track.u, v - track.v)
                if d <= self.max_jump:
                    pairs.append((d, tid, ci))
        pairs.sort()
        ids: list[int | None] = [None] * len(centroids)
        used_tracks: set[int] = set()
        for _, tid, ci in pairs:
            if tid in used_tracks or ids[ci] is not None:
                continue
            ids[ci] = tid
            used_tracks.add(tid)
            track = self._tracks[tid]
            track.u, track.v, track.missed = centroids[ci][0], centroids[ci][1], 0
        for ci, tid in enumerate(ids):
            if tid is None:
                tid = self._next_id
                self._next_id += 1
                ids[ci] = tid
                self._tracks[tid] = _Track(tid, centroids[ci][0], centroids[ci][1])
                used_tracks.add(tid)
        for tid in list(self._tracks):
            if tid not in used_tracks:
                self._tracks[tid].missed += 1
                if self._tracks[tid].missed > self.max_missed:
                    del self._tracks[tid]
        return [tid for tid in ids if tid is not None]


class RateMeter:
    """Exponentially smoothed rate (Hz) from a sequence of timestamps."""

    def __init__(self, alpha: float = 0.1) -> None:
        self.alpha = alpha
        self.value = 0.0
        self._last: float | None = None

    def tick(self, t: float) -> float:
        if self._last is not None and t > self._last:
            instant = 1.0 / (t - self._last)
            self.value = instant if self.value == 0.0 else self.value + self.alpha * (instant - self.value)
        self._last = t
        return self.value


class BoxAnalyzer:
    """Turns a depth frame into blobs, an occupancy grid, and stats.

    Pipeline: crop the ROI -> mask pixels with ``near <= depth <= far`` ->
    morphological opening -> connected components -> keep the largest
    ``max_hands`` blobs with at least ``min_pixels`` -> per blob: centroid,
    nearest-percentile depth, extent, confidence, sample points -> stable ids
    from :class:`BlobTracker` -> occupancy grid of the mask. All outputs are
    ROI-normalized (see the module docstring).
    """

    def __init__(self, box: BoxConfig, config: AnalyzerConfig | None = None) -> None:
        self.box = box
        self.config = config or AnalyzerConfig()
        self.tracker = BlobTracker(self.config.max_jump, self.config.max_missed)
        self._rate = RateMeter()

    def analyze(self, frame: DepthFrame) -> AnalysisResult:
        started = time.perf_counter()
        cfg, box = self.config, self.box
        x0, y0, x1, y1 = box.roi_pixels(frame.width, frame.height)
        roi = frame.depth_mm[y0:y1, x0:x1]
        rh, rw = roi.shape
        near_mm, far_mm = box.near_mm, box.far_mm
        span_mm = far_mm - near_mm

        mask = (roi >= max(near_mm, 1.0)) & (roi <= far_mm)  # depth 0 is "unknown", never inside the box
        mask = open_mask(mask, cfg.morph_iterations)
        in_range = int(np.count_nonzero(mask))

        blobs: list[Blob] = []
        candidates: list[tuple[int, int]] = []
        if in_range >= cfg.min_pixels and cfg.max_hands > 0:
            labels, areas = label_components(mask)
            order = np.argsort(-areas, kind="stable")
            candidates = [(int(k) + 1, int(areas[k])) for k in order if areas[k] >= cfg.min_pixels]
            for label, area in candidates[: cfg.max_hands]:
                ys, xs = np.nonzero(labels == label)
                depth = roi[ys, xs].astype(np.float32)
                u = (xs.astype(np.float32) + 0.5) / rw
                v = (ys.astype(np.float32) + 0.5) / rh
                w = np.clip((depth - near_mm) / span_mm, 0.0, 1.0)
                w_near = float(np.percentile(w, cfg.depth_percentile))
                w_far = float(np.percentile(w, 100.0 - cfg.depth_percentile))
                conf = min(1.0, area / (cfg.conf_saturation * cfg.min_pixels))
                n_points = min(cfg.sample_points, area)
                points: tuple[Vec3, ...] = ()
                if n_points > 0:
                    idx = np.round(np.linspace(0, area - 1, n_points)).astype(np.int64)
                    points = tuple((float(u[i]), float(v[i]), float(w[i])) for i in idx)
                blobs.append(Blob(
                    id=-1,
                    u=float(u.mean()), v=float(v.mean()), w=w_near,
                    extent=((float(u.min()), float(v.min()), w_near), (float(u.max()), float(v.max()), w_far)),
                    conf=conf, pixels=area, points=points,
                ))
        ids = self.tracker.update([(b.u, b.v) for b in blobs])
        tracked = tuple(Blob(id=i, u=b.u, v=b.v, w=b.w, extent=b.extent, conf=b.conf, pixels=b.pixels, points=b.points) for i, b in zip(ids, blobs))

        occupancy = downsample_occupancy(mask, *cfg.occupancy) if cfg.occupancy else None
        fps = self._rate.tick(frame.timestamp)
        stats = {
            "pixels": float(in_range),
            "blobs": float(len(candidates)),
            "fps": round(fps, 2),
            "processingMs": round((time.perf_counter() - started) * 1000.0, 3),
            "frameWidth": float(frame.width),
            "frameHeight": float(frame.height),
        }
        return AnalysisResult(tracked, occupancy, stats)


# --------------------------------------------------------------------------- #
# Wire messages (mirror src/sim/input/protocol.ts exactly)
# --------------------------------------------------------------------------- #


def _unit(x: float) -> float:
    """Clamp to [0, 1] and round for compact JSON."""
    return round(min(1.0, max(0.0, float(x))), 4)


def _vec(p: Sequence[float]) -> list[float]:
    return [_unit(p[0]), _unit(p[1]), _unit(p[2])]


def encode_occupancy(grid: np.ndarray) -> str:
    """Base64 of the grid's bytes, row-major, row 0 first (= top)."""
    return base64.b64encode(np.ascontiguousarray(grid, dtype=np.uint8).tobytes()).decode("ascii")


def hello_message(source: str, box: BoxConfig, fps: float | None, occupancy: tuple[int, int] | None) -> dict[str, Any]:
    msg: dict[str, Any] = {
        "type": "hello",
        "version": PROTOCOL_VERSION,
        "source": source,
        "box": {
            "x": [float(box.box_x[0]), float(box.box_x[1])],
            "y": [float(box.box_y[0]), float(box.box_y[1])],
            "z": [float(box.near_m), float(box.far_m)],
        },
    }
    if fps is not None and fps > 0:
        msg["fps"] = float(fps)
    if occupancy is not None:
        msg["occupancy"] = {"width": int(occupancy[0]), "height": int(occupancy[1])}
    return msg


def frame_message(seq: int, t: float, result: AnalysisResult) -> dict[str, Any]:
    hands = [
        {
            "id": int(b.id),
            "pos": _vec(b.pos),
            "conf": _unit(b.conf),
            "extent": [_vec(b.extent[0]), _vec(b.extent[1])],
            "points": [_vec(p) for p in b.points[:MAX_POINTS]],
        }
        for b in result.blobs[:MAX_HANDS]
    ]
    msg: dict[str, Any] = {"type": "frame", "seq": int(seq), "t": round(float(t), 6), "hands": hands}
    if result.occupancy is not None:
        msg["occupancy"] = encode_occupancy(result.occupancy)
    msg["stats"] = {k: float(v) for k, v in result.stats.items()}
    return msg


def status_message(level: str, message: str) -> dict[str, Any]:
    if level not in ("info", "warning", "error"):
        raise ValueError(f"bad status level {level!r}")
    return {"type": "status", "level": level, "message": str(message)}


def encode_message(msg: dict[str, Any]) -> str:
    """Compact JSON. Refuses NaN/Infinity, which JSON.parse would reject anyway."""
    return json.dumps(msg, separators=(",", ":"), allow_nan=False)


# --------------------------------------------------------------------------- #
# Server
# --------------------------------------------------------------------------- #


def _websockets_api() -> tuple[Callable[..., Any], Callable[..., Any], type[BaseException]]:
    """Return ``(serve, broadcast, ConnectionClosed)`` for websockets >= 13, or the legacy API."""
    try:
        import websockets
        from websockets.exceptions import ConnectionClosed
    except ImportError as exc:
        raise SystemExit("depth_bridge needs the websockets package. Install it with: pip install websockets numpy") from exc
    try:
        from websockets.asyncio.server import broadcast, serve  # websockets >= 13
    except ImportError:  # pragma: no cover - older websockets
        serve, broadcast = websockets.serve, websockets.broadcast  # type: ignore[attr-defined]
    return serve, broadcast, ConnectionClosed


class BridgeServer:
    """Asyncio WebSocket server that broadcasts analyzer output to every client.

    Frames are read from the source in a worker thread (``read()`` blocks),
    analyzed on the loop thread, and fanned out with ``websockets.broadcast``,
    which skips clients whose send buffer is full rather than stalling the
    capture. The loop keeps running with zero clients; source errors become
    ``status`` messages and trigger a restart with backoff.
    """

    def __init__(self, source: FrameSource, analyzer: BoxAnalyzer, hello: dict[str, Any], host: str = DEFAULT_HOST, port: int = DEFAULT_PORT) -> None:
        self.source, self.analyzer, self.hello, self.host, self.port = source, analyzer, hello, host, port
        self._clients: set[Any] = set()
        self._serve, self._broadcast, self._closed = _websockets_api()
        self.seq = 0

    @property
    def client_count(self) -> int:
        return len(self._clients)

    def broadcast(self, msg: dict[str, Any]) -> None:
        if self._clients:
            self._broadcast(self._clients, encode_message(msg))

    async def _handle_client(self, ws: Any) -> None:
        peer = getattr(ws, "remote_address", None)
        self._clients.add(ws)
        log.info("client connected from %s (%d connected)", peer, len(self._clients))
        try:
            await ws.send(encode_message(self.hello))
            async for _ in ws:  # the browser never sends anything; drain so pings keep flowing
                pass
        except self._closed:
            pass
        except Exception as exc:  # noqa: BLE001 - one bad client must not stop the server
            log.warning("client %s errored: %s", peer, exc)
        finally:
            self._clients.discard(ws)
            log.info("client %s disconnected (%d connected)", peer, len(self._clients))

    async def pump_once(self) -> bool:
        """Read, analyze and broadcast one frame. Returns False if the source failed."""
        try:
            frame = await asyncio.to_thread(self.source.read)
        except Exception as exc:  # noqa: BLE001 - hardware errors are reported, not fatal
            log.error("source %s failed: %s", self.source.name, exc)
            self.broadcast(status_message("error", f"{self.source.name}: {exc}"))
            return False
        result = self.analyzer.analyze(frame)
        self.broadcast(frame_message(self.seq, frame.timestamp, result))
        self.seq += 1
        return True

    async def _pump(self) -> None:
        backoff = 1.0
        while True:
            if await self.pump_once():
                backoff = 1.0
                continue
            await asyncio.sleep(backoff)
            backoff = min(8.0, backoff * 2.0)
            try:
                self.source.stop()
                self.source.start()
                self.broadcast(status_message("info", f"{self.source.name} restarted"))
            except Exception as exc:  # noqa: BLE001
                log.error("restarting %s failed: %s", self.source.name, exc)

    async def run(self) -> None:
        async with self._serve(self._handle_client, self.host, self.port):
            log.info("listening on ws://%s:%d (source=%s, opencv=%s)", self.host, self.port, self.source.name, HAVE_OPENCV)
            await self._pump()


def dump_frames(source: FrameSource, analyzer: BoxAnalyzer, hello: dict[str, Any], count: int, out: TextIO) -> None:
    """Write the hello and ``count`` frames as JSON lines (fixtures, tests)."""
    source.start()
    try:
        out.write(encode_message(hello) + "\n")
        for seq in range(count):
            frame = source.read()
            out.write(encode_message(frame_message(seq, frame.timestamp, analyzer.analyze(frame))) + "\n")
        out.flush()
    finally:
        source.stop()


# --------------------------------------------------------------------------- #
# CLI
# --------------------------------------------------------------------------- #

SOURCES: dict[str, type[FrameSource]] = {"synthetic": SyntheticSource, "realsense": RealSenseSource}


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="Depth-camera bridge: streams blobs inside a physical box to the browser over WebSocket.")
    p.add_argument("--source", choices=sorted(SOURCES), default="synthetic", help="frame source (default: synthetic)")
    p.add_argument("--host", default=DEFAULT_HOST, help="bind address (default: %(default)s)")
    p.add_argument("--port", type=int, default=DEFAULT_PORT, help="bind port (default: %(default)s)")
    p.add_argument("--near", type=float, default=0.4, metavar="M", help="nearest plane of the box in metres (default: %(default)s)")
    p.add_argument("--far", type=float, default=1.2, metavar="M", help="farthest plane of the box in metres (default: %(default)s)")
    p.add_argument("--roi", type=float, nargs=4, default=(0.0, 0.0, 1.0, 1.0), metavar=("X0", "Y0", "X1", "Y1"), help="image rectangle as fractions of width/height (default: full frame)")
    p.add_argument("--box-x", type=float, nargs=2, default=(-0.5, 0.5), metavar=("MIN", "MAX"), help="metric x extent reported in hello (informational)")
    p.add_argument("--box-y", type=float, nargs=2, default=(-0.4, 0.4), metavar=("MIN", "MAX"), help="metric y extent reported in hello (informational)")
    p.add_argument("--occupancy", type=int, nargs=2, default=(32, 24), metavar=("W", "H"), help="occupancy grid size (default: 32 24)")
    p.add_argument("--no-occupancy", action="store_true", help="do not send an occupancy grid")
    p.add_argument("--min-pixels", type=int, default=150, help="smallest blob in pixels (default: %(default)s)")
    p.add_argument("--max-hands", type=int, default=2, help=f"largest number of blobs to report, 0..{MAX_HANDS} (default: %(default)s)")
    p.add_argument("--fps", type=float, default=30.0, help="capture rate (default: %(default)s)")
    p.add_argument("--dump", type=int, metavar="N", help="print the hello and N frames as JSON lines to stdout, then exit")
    p.add_argument("--points", type=int, default=16, help=f"sample points per blob, 0..{MAX_POINTS} (default: %(default)s)")
    p.add_argument("--morph", type=int, default=1, help="3x3 opening iterations for speckle removal, 0 to disable (default: %(default)s)")
    p.add_argument("--max-jump", type=float, default=0.25, help="largest normalized centroid move per frame that keeps a blob id (default: %(default)s)")
    p.add_argument("--resolution", type=int, nargs=2, default=(640, 480), metavar=("W", "H"), help="camera/synthetic frame size (default: 640 480)")
    p.add_argument("--decimation", type=int, default=0, help="RealSense decimation filter magnitude, 0 = off (default: %(default)s)")
    p.add_argument("--hole-filling", action="store_true", help="RealSense hole-filling filter (off by default)")
    p.add_argument("--synthetic-hands", type=int, choices=(1, 2), default=1, help="hands in the synthetic script (default: %(default)s)")
    p.add_argument("--log-level", default="info", choices=("debug", "info", "warning", "error"))
    return p


def make_source(args: argparse.Namespace) -> FrameSource:
    width, height = args.resolution
    if args.source == "synthetic":
        return SyntheticSource(width, height, args.fps, near_m=args.near, far_m=args.far, hands=args.synthetic_hands, paced=args.dump is None)
    if args.source == "realsense":
        return RealSenseSource(width, height, args.fps, decimation=args.decimation, hole_filling=args.hole_filling)
    raise SystemExit(f"unknown source {args.source!r}")


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    logging.basicConfig(level=getattr(logging, args.log_level.upper()), stream=sys.stderr, format="%(asctime)s %(levelname)s %(message)s")
    try:
        box = BoxConfig(near_m=args.near, far_m=args.far, roi=tuple(args.roi), box_x=tuple(args.box_x), box_y=tuple(args.box_y))
        config = AnalyzerConfig(
            occupancy=None if args.no_occupancy else tuple(args.occupancy),
            min_pixels=args.min_pixels, max_hands=args.max_hands, morph_iterations=args.morph,
            sample_points=args.points, max_jump=args.max_jump,
        )
    except ValueError as exc:
        parser.error(str(exc))
    source = make_source(args)
    analyzer = BoxAnalyzer(box, config)
    hello = hello_message(source.name, box, source.fps, config.occupancy)

    if args.dump is not None:
        if hasattr(sys.stdout, "reconfigure"):
            sys.stdout.reconfigure(newline="\n")  # JSON lines end in LF on every platform (fixtures are committed)
        try:
            dump_frames(source, analyzer, hello, args.dump, sys.stdout)
        except (RuntimeError, NotImplementedError) as exc:
            log.error("%s", exc)
            return 1
        return 0

    try:
        source.start()
    except (RuntimeError, NotImplementedError) as exc:
        log.error("%s", exc)
        return 1
    server = BridgeServer(source, analyzer, hello, args.host, args.port)
    try:
        asyncio.run(server.run())
    except KeyboardInterrupt:
        log.info("stopping")
    finally:
        source.stop()
    return 0


if __name__ == "__main__":
    sys.exit(main())
