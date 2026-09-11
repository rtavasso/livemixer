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
* The voxel grid is the same idea in 3D: the foreground (every in-range
  pixel) binned into ``nx`` columns, ``ny`` rows and ``nz`` depth slabs of the
  box. Bytes are laid out x fastest, then y (top row first), then z (nearest
  slab first); each holds the fraction of the voxel's projected pixel area
  that is filled, 0..255. See :func:`voxelize` for the normalisation.
* The surface is a 3D scan of the foreground: a ``(height, width)`` grid over
  the ROI (row 0 = top, like the occupancy) holding each cell's NEAREST
  in-range depth as ``1 + round(254 * w)``, or 0 where the cell holds no
  foreground pixel. See :func:`scan_surface`.
* A source that tracks hands (the Leap Motion Controller, and the synthetic
  sources for testing) attaches :class:`TrackedHand` skeletons to its frames
  in the SAME image frame as the depth pixels (column, row, millimetres). The
  analyzer normalizes them with the same ROI and depth range as everything
  else, so a joint and the scan pixel under it share coordinates; joints are
  not clamped (a forearm may leave the box) but the hand's ``pos`` is. When a
  frame carries tracked hands they are what ``hands`` reports, with a
  ``skeleton``; otherwise the blobs are, exactly as for a plain depth camera.
* Before anything is measured from the depth, the tracked hands' capsule
  model (``scan_fusion.py``) is fused into it (``scan_fuse``: ``fill`` fills
  where the measurement is missing or disagrees with the model, ``model``
  replaces it under the model, ``off`` leaves it alone), so the scan, the
  voxels, the occupancy and the blobs agree with the skeleton;
  ``stats.scanModelFraction`` says how much of the foreground came from it.

Dependencies: ``numpy`` and ``websockets`` (``pip install numpy websockets``).
Optional: ``opencv-python`` for multi-blob connected components and for the
Leap Motion Controller stereo source (``--source leap``, see
``leap_source.py``), ``pyrealsense2`` for the Intel RealSense source.
"""
from __future__ import annotations

import argparse
import asyncio
import base64
import functools
import json
import logging
import math
import os
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
MAX_VOXEL_SIDE = 128      # bridgeHelloSchema: voxels nx/ny/nz.max(128)
MAX_SURFACE_SIDE = 512    # bridgeHelloSchema: surface width/height.max(512)
#: How a tracked hand's capsule model is fused into the depth before the scan (``scan_fusion.fuse_depth``).
SCAN_FUSE_MODES = ("off", "fill", "model")
DEFAULT_SCAN_FUSE = "fill"
DEFAULT_FUSE_TOLERANCE_MM = 40.0
DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8765

log = logging.getLogger("depth_bridge")

Vec3 = tuple[float, float, float]

# Skeleton joint layout, shared by every source that tracks hands and by the wire format: 28 points per hand.
JOINT_PALM, JOINT_WRIST, JOINT_ELBOW = 0, 1, 2
FINGER_JOINTS = 3                 # first finger joint; then N_FINGERS fingers x JOINTS_PER_FINGER joints
JOINTS_PER_FINGER, N_FINGERS = 5, 5
N_JOINTS = FINGER_JOINTS + N_FINGERS * JOINTS_PER_FINGER
FINGER_NAMES = ("thumb", "index", "middle", "ring", "pinky")
JOINT_NAMES = ("carp", "mcp", "pip", "dip", "tip")   # metacarpal base, knuckle, two inter-phalangeal joints, tip
WIDTH_PALM, WIDTH_ARM, WIDTH_FINGERS = 0, 1, 2       # index into a hand's widths: palm, forearm, then one per finger
N_WIDTHS = WIDTH_FINGERS + N_FINGERS
HAND_TYPES = ("left", "right", "unknown")


def finger_joint(finger: int, joint: int) -> int:
    """Row of finger ``finger`` (0 = thumb) joint ``joint`` (0 = carp .. 4 = tip) in a hand's ``joints`` array."""
    return FINGER_JOINTS + finger * JOINTS_PER_FINGER + joint


# --------------------------------------------------------------------------- #
# Frames and sources
# --------------------------------------------------------------------------- #


@dataclass(frozen=True)
class TrackedHand:
    """A hand skeleton a source tracked, in the depth image's own frame.

    ``joints`` is ``(N_JOINTS, 3)`` float64: continuous pixel column ``u`` and
    row ``v`` with integer values at pixel centres (OpenCV's convention, the
    one ``leap_stereo.RectifiedView.ray_to_pixel`` uses; a joint may lie past
    the image edge) and depth in millimetres along the same axis as the depth
    pixels. Rows are the palm, the wrist, the elbow (already trimmed to a stub
    by the source) and five fingers thumb -> pinky with carp, mcp, pip, dip,
    tip each (:func:`finger_joint`). ``widths_px`` holds ``N_WIDTHS`` DIAMETERS
    in pixels at each part's own depth (palm, forearm, one per finger), which
    puts them in the same perspective units as the image, so a width and the
    scan around it agree. ``extended`` is one flag per finger. ``confidence``,
    ``grab_strength`` and ``pinch_strength`` are in [0, 1] as the tracker
    reports them. ``id`` is the tracker's id (stable while the hand stays
    tracked); ``type`` is ``"left"``, ``"right"`` or ``"unknown"``.
    """

    id: int
    type: str
    joints: np.ndarray
    widths_px: np.ndarray
    extended: np.ndarray
    confidence: float = 1.0
    grab_strength: float = 0.0
    pinch_strength: float = 0.0
    has_elbow: bool = True

    def __post_init__(self) -> None:
        if self.type not in HAND_TYPES:
            raise ValueError(f"hand type must be one of {HAND_TYPES}, got {self.type!r}")
        if self.joints.shape != (N_JOINTS, 3):
            raise ValueError(f"joints must have shape ({N_JOINTS}, 3), got {self.joints.shape}")
        if self.widths_px.shape != (N_WIDTHS,):
            raise ValueError(f"widths_px must have shape ({N_WIDTHS},), got {self.widths_px.shape}")
        if self.extended.shape != (N_FINGERS,):
            raise ValueError(f"extended must have shape ({N_FINGERS},), got {self.extended.shape}")
        if not (np.isfinite(self.joints).all() and np.isfinite(self.widths_px).all()):
            raise ValueError("a tracked hand must be finite everywhere")
        if self.id < 0:
            raise ValueError("hand ids are non-negative")

    def finger(self, index: int) -> np.ndarray:
        """The ``(JOINTS_PER_FINGER, 3)`` joints of finger ``index`` (0 = thumb)."""
        start = finger_joint(index, 0)
        return self.joints[start:start + JOINTS_PER_FINGER]


@dataclass(frozen=True)
class DepthFrame:
    """One depth image, optionally with the hands a tracker saw in it.

    ``depth_mm`` is ``uint16`` millimetres with shape ``(height, width)``;
    0 means "no measurement". ``timestamp`` is seconds on
    ``time.perf_counter()``'s clock, taken as close to capture as possible.
    ``hands`` is ``None`` for a source without hand tracking, otherwise the
    :class:`TrackedHand` skeletons in this image's frame (possibly none).
    """

    depth_mm: np.ndarray
    timestamp: float
    hands: tuple[TrackedHand, ...] | None = None

    def __post_init__(self) -> None:
        if self.depth_mm.ndim != 2:
            raise ValueError(f"depth image must be 2-D, got shape {self.depth_mm.shape}")
        if self.depth_mm.dtype != np.uint16:
            raise ValueError(f"depth image must be uint16 millimetres, got {self.depth_mm.dtype}")
        if self.hands is not None and not isinstance(self.hands, tuple):
            object.__setattr__(self, "hands", tuple(self.hands))

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
    #: True when frames can carry :class:`TrackedHand` skeletons (announced as ``skeleton`` in ``hello``).
    skeleton: bool = False
    #: Focal length of the depth image in pixels when it is a perspective view (square pixels), else ``None``.
    #: It sizes the relief of the fused hand model; :func:`source_focal_px` also reads it off a Leap source's ``view``.
    focal_px: float | None = None

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
    Each hand also carries a procedural skeleton (:meth:`scripted_skeleton`)
    lying inside its dome, so the skeleton path is exercised without hardware.
    """

    name = "synthetic"
    skeleton = True

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

    # Where the procedural skeleton sits inside the dome, in dome units (1 = the rim): the wrist and the
    # forearm stub run toward image-down, the fingers fan toward image-up (angles clockwise from up).
    _FINGER_FAN_DEG = (-62.0, -28.0, 0.0, 24.0, 48.0)
    _FINGER_REACH = (0.6, 0.85, 0.9, 0.85, 0.72)
    _JOINT_ALONG = (0.18, 0.42, 0.64, 0.83, 1.0)
    _WRIST_RHO, _ELBOW_RHO = 0.55, 0.95
    _WIDTHS_OF_HALF = (1.5, 0.9, 0.28, 0.26, 0.26, 0.24, 0.22)  # diameters as fractions of the dome's half-width

    def scripted_skeleton(self, hand: ScriptedHand, index: int) -> TrackedHand:
        """A skeleton inside ``hand``'s dome: the palm at its centre, fingers fanning up, the forearm stub down.

        Every joint's depth is the dome surface at the pixel holding it (the
        centre is nearest, the rim ``dome_mm`` deeper), so the skeleton lies
        ON the rendered scan the way a Leap skeleton lies on the stereo scan,
        and the rendering itself is untouched. The second hand of a two-hand
        script is a left hand with the thumb on the other side.
        """
        width, height = self.width, self.height
        centre = self._near_mm + hand.z * (self._far_mm - self._near_mm)
        mirror = -1.0 if index % 2 else 1.0

        def joint(rho: float, angle_deg: float) -> tuple[float, float, float]:
            angle = math.radians(angle_deg) * mirror
            x = hand.x + rho * hand.r * math.sin(angle)
            y = hand.y - rho * hand.r * 1.4 * math.cos(angle)
            px, py = min(width - 1, int(x * width)), min(height - 1, int(y * height))  # the pixel holding (x, y)
            dx = ((px + 0.5) / width - hand.x) / hand.r
            dy = ((py + 0.5) / height - hand.y) / (hand.r * 1.4)
            return x * width - 0.5, y * height - 0.5, centre + self.dome_mm * (dx * dx + dy * dy)

        joints = np.empty((N_JOINTS, 3), dtype=np.float64)
        joints[JOINT_PALM] = joint(0.0, 0.0)
        joints[JOINT_WRIST] = joint(self._WRIST_RHO, 180.0)
        joints[JOINT_ELBOW] = joint(self._ELBOW_RHO, 180.0)
        for f in range(N_FINGERS):
            for j in range(JOINTS_PER_FINGER):
                joints[finger_joint(f, j)] = joint(self._FINGER_REACH[f] * self._JOINT_ALONG[j], self._FINGER_FAN_DEG[f])
        widths_px = hand.r * width * np.asarray(self._WIDTHS_OF_HALF, dtype=np.float64)
        return TrackedHand(
            id=index + 1, type="right" if index % 2 == 0 else "left", joints=joints, widths_px=widths_px,
            extended=np.ones(N_FINGERS, dtype=bool), confidence=1.0, grab_strength=0.0, pinch_strength=0.0,
        )

    def tracked_hands(self, t: float) -> tuple[TrackedHand, ...]:
        """The skeletons of the hands present at script time ``t``, in the image frame of ``render(t)``."""
        return tuple(self.scripted_skeleton(hand, i) for i, hand in enumerate(self.scripted_hands(t)))

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
        t = (now - self._origin) * self.speed
        return DepthFrame(self.render(t), now, self.tracked_hands(t))


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
    ``voxels`` is ``(nx, ny, nz)`` of the foreground voxel grid (across, down,
    deep) or ``None`` to skip it. ``surface`` is ``(width, height)`` of the
    nearest-depth scan or ``None`` to skip it.
    A blob needs at least ``min_pixels`` in-range pixels; confidence rises
    linearly from there and saturates at ``conf_saturation * min_pixels``.
    ``morph_iterations`` rounds of 3x3 opening remove speckle. ``max_jump`` is
    the largest normalized centroid move (u/v) that still counts as the same
    blob; a blob missing for more than ``max_missed`` frames loses its id.
    ``depth_percentile`` picks the blob depth (10 = its nearest tenth, so a
    reaching hand reads as pushed even when the arm behind it is in the box).
    A tracked hand (skeleton) is reported while its palm is inside the box
    widened by ``hand_margin`` on every axis (normalized units); farther out it
    is dropped like any pixel outside the box, instead of sticking to a wall.
    ``scan_fuse`` (one of :data:`SCAN_FUSE_MODES`) fuses the reported hands'
    capsule model into the depth before the mask, the blobs, the occupancy,
    the voxels and the scan are computed from it: ``fill`` keeps a measurement
    that exists and agrees with the model within ``fuse_tolerance_mm``, takes
    the model where the measurement is missing or disagrees, and leaves pixels
    outside the model alone; ``model`` takes the model wherever it has a
    surface; ``off`` is a plain depth camera.
    """

    occupancy: tuple[int, int] | None = (32, 24)
    voxels: tuple[int, int, int] | None = (32, 24, 16)
    surface: tuple[int, int] | None = (64, 48)
    min_pixels: int = 150
    max_hands: int = 2
    morph_iterations: int = 1
    sample_points: int = 16
    max_jump: float = 0.25
    max_missed: int = 5
    depth_percentile: float = 10.0
    conf_saturation: float = 4.0
    hand_margin: float = 0.25
    scan_fuse: str = DEFAULT_SCAN_FUSE
    fuse_tolerance_mm: float = DEFAULT_FUSE_TOLERANCE_MM

    def __post_init__(self) -> None:
        if self.scan_fuse not in SCAN_FUSE_MODES:
            raise ValueError(f"scan_fuse must be one of {SCAN_FUSE_MODES}, got {self.scan_fuse!r}")
        if not (self.fuse_tolerance_mm >= 0.0):
            raise ValueError("fuse_tolerance_mm must be non-negative")
        if self.occupancy is not None:
            w, h = self.occupancy
            if not (1 <= w <= MAX_OCCUPANCY_SIDE and 1 <= h <= MAX_OCCUPANCY_SIDE):
                raise ValueError(f"occupancy grid sides must be 1..{MAX_OCCUPANCY_SIDE}, got {self.occupancy}")
        if self.voxels is not None:
            if len(self.voxels) != 3 or not all(1 <= n <= MAX_VOXEL_SIDE for n in self.voxels):
                raise ValueError(f"voxel grid sides must be 1..{MAX_VOXEL_SIDE}, got {self.voxels}")
        if self.surface is not None:
            if len(self.surface) != 2 or not all(1 <= n <= MAX_SURFACE_SIDE for n in self.surface):
                raise ValueError(f"surface grid sides must be 1..{MAX_SURFACE_SIDE}, got {self.surface}")
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
class SkeletonHand:
    """A tracked hand normalized to the box, ready for the wire.

    ``joints`` is ``(N_JOINTS, 3)`` in box units (``u``/``v`` over the ROI,
    ``w`` over the depth range), NOT clamped: the browser expects a forearm
    to leave the box with its direction intact. ``widths`` are diameters in
    ``u`` units (fractions of the ROI width). ``conf`` is the reported
    confidence floored at 0.5 (Ultraleap under-reports it and the browser's
    tracker drops hands below 0.3), ``openness`` is ``1 - grab_strength`` and
    ``pinch`` the pinch strength. ``points`` are the palm and the fingertips.
    """

    id: int
    type: str
    joints: np.ndarray
    widths: np.ndarray
    extended: np.ndarray
    conf: float
    openness: float
    pinch: float
    has_elbow: bool
    points: tuple[Vec3, ...]

    @property
    def pos(self) -> Vec3:
        palm = self.joints[JOINT_PALM]
        return (float(palm[0]), float(palm[1]), float(palm[2]))

    @property
    def extent(self) -> tuple[Vec3, Vec3]:
        """Bounding box of every joint (the elbow stub included when present)."""
        joints = self.joints if self.has_elbow else np.delete(self.joints, JOINT_ELBOW, axis=0)
        lo, hi = joints.min(axis=0), joints.max(axis=0)
        return (float(lo[0]), float(lo[1]), float(lo[2])), (float(hi[0]), float(hi[1]), float(hi[2]))

    def finger(self, index: int) -> np.ndarray:
        start = finger_joint(index, 0)
        return self.joints[start:start + JOINTS_PER_FINGER]


MIN_TRACKED_CONF = 0.5


def normalize_tracked_hand(hand: TrackedHand, roi: tuple[int, int, int, int], near_mm: float, far_mm: float, sample_points: int = MAX_POINTS) -> SkeletonHand:
    """Normalize a :class:`TrackedHand` with the same box as the pixels: ``u``/``v`` over the ROI, ``w`` over the depth range.

    A pixel-centre coordinate ``c`` (integer = centre) becomes
    ``(c + 0.5 - roi_start) / roi_size``, the rule the blob centroids and the
    grids use, so a joint and the scan cell under it agree. Widths divide by
    the ROI width. Nothing is clamped here; ``sample_points == 0`` (``--points
    0``) suppresses the point list like it does for blobs.
    """
    x0, y0, x1, y1 = roi
    rw, rh = float(x1 - x0), float(y1 - y0)
    src = hand.joints
    joints = np.empty_like(src)
    joints[:, 0] = (src[:, 0] + 0.5 - x0) / rw
    joints[:, 1] = (src[:, 1] + 0.5 - y0) / rh
    joints[:, 2] = (src[:, 2] - near_mm) / (far_mm - near_mm)
    widths = hand.widths_px / rw
    palm = joints[JOINT_PALM]
    tips = [joints[finger_joint(f, JOINTS_PER_FINGER - 1)] for f in range(N_FINGERS)]
    points: tuple[Vec3, ...] = tuple((float(p[0]), float(p[1]), float(p[2])) for p in (palm, *tips)) if sample_points > 0 else ()
    return SkeletonHand(
        id=int(hand.id), type=hand.type, joints=joints, widths=widths, extended=hand.extended.astype(bool),
        conf=min(1.0, max(MIN_TRACKED_CONF, float(hand.confidence))),
        openness=min(1.0, max(0.0, 1.0 - float(hand.grab_strength))),
        pinch=min(1.0, max(0.0, float(hand.pinch_strength))),
        has_elbow=bool(hand.has_elbow), points=points,
    )


def hand_in_box(hand: SkeletonHand, margin: float) -> bool:
    """Whether the palm lies inside the unit box widened by ``margin`` on every axis."""
    return all(-margin <= c <= 1.0 + margin for c in hand.pos)


@functools.lru_cache(maxsize=1)
def _import_scan_fusion() -> Any:
    """``scan_fusion`` (the hand-model rasteriser and fusion rules), imported on first use so the module can import this one."""
    if __package__:
        from . import scan_fusion  # type: ignore[import-not-found]
    else:
        import scan_fusion  # type: ignore[import-not-found]
    return scan_fusion


def source_focal_px(source: FrameSource) -> float | None:
    """The focal length (pixels) of the source's depth image when it is a perspective view, else ``None``.

    Sources declare it as ``focal_px``; the Leap sources expose their rectified
    ``view`` (``leap_stereo.RectifiedView``, square pixels) instead, whose
    ``fx`` is taken. The fused hand model uses it to size its relief: a tube of
    radius ``r`` px bulges ``r * depth / focal`` mm.
    """
    focal = getattr(source, "focal_px", None)
    if focal is None:
        focal = getattr(getattr(source, "view", None), "fx", None)
    try:
        return float(focal) if focal else None
    except (TypeError, ValueError):
        return None


@dataclass(frozen=True)
class AnalysisResult:
    blobs: tuple[Blob, ...]
    #: ``uint8`` array of shape ``(height, width)``, row 0 = top of the ROI; ``None`` when disabled.
    occupancy: np.ndarray | None
    stats: dict[str, float]
    #: ``uint8`` array of shape ``(nz, ny, nx)``, slab 0 = nearest, row 0 = top; ``None`` when disabled.
    voxels: np.ndarray | None = None
    #: ``uint8`` array of shape ``(height, width)``, row 0 = top, 0 = empty else 1 + round(254 w); ``None`` when disabled.
    surface: np.ndarray | None = None
    #: Tracked hands normalized to the box; empty for a source without tracking or when it saw none.
    hands: tuple[SkeletonHand, ...] = ()


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


def cell_bins(n_pixels: int, n_cells: int) -> np.ndarray:
    """Cell index of each pixel position along one axis: ``floor((i + 0.5) / n_pixels * n_cells)``.

    Evaluated in integers so the boundaries are exact. A pixel belongs to the
    cell its centre falls in, which is the same rule the browser uses to look a
    cell up from a normalized coordinate (``floor(coordinate * n)``), so a
    blob's reported ``u``/``v`` and the voxel or surface cell holding its
    pixels agree. Used by :func:`voxelize` and :func:`scan_surface`.
    """
    i = np.arange(n_pixels, dtype=np.int64)
    return ((2 * i + 1) * n_cells) // (2 * n_pixels)


@functools.lru_cache(maxsize=8)
def _voxel_tables(rh: int, rw: int, nx: int, ny: int, nz: int, near_mm: float, far_mm: float) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Lookup tables for :func:`voxelize`, cached per frame size, grid and depth range (read-only)."""
    col_bin, row_bin = cell_bins(rw, nx), cell_bins(rh, ny)
    column = (row_bin[:, None] * nx + col_bin[None, :]).astype(np.int32)  # (rh, rw): flat (y, x) cell of every pixel
    area = np.outer(np.bincount(row_bin, minlength=ny), np.bincount(col_bin, minlength=nx))  # ROI pixels per (y, x) column
    mm = np.arange(65536, dtype=np.float64)  # every uint16 depth -> its slab; out-of-range depths clamp to the end slabs
    slab = np.clip(np.floor((mm - near_mm) / (far_mm - near_mm) * nz), 0, nz - 1).astype(np.int32)
    return column, area, slab


def voxelize(roi_mm: np.ndarray, mask: np.ndarray, near_mm: float, far_mm: float, nx: int, ny: int, nz: int) -> np.ndarray:
    """Foreground voxel grid as ``uint8`` of shape ``(nz, ny, nx)``.

    Every ``True`` pixel of ``mask`` (the in-range pixels of the ROI) is binned
    exactly once: its column into ``x``, its row into ``y`` and its depth
    ``w = (mm - near) / (far - near)`` into ``z``, slab 0 being nearest the
    camera. The accumulation is a ``bincount`` over flat voxel indices (the
    vectorised form of ``np.add.at``) using cached lookup tables, so the cost
    is one scan of the mask plus a few gathers per foreground pixel, and does
    not depend on the grid size.

    Normalisation: each voxel's count is divided by the number of ROI pixels
    that project into its ``(x, y)`` column (its "projected pixel area"), then
    scaled to 0..255 and clipped. Consequences:

    * A surface that fills a column at one depth reads 255 in that slab and 0
      in the others: a solid hand is a bright slab, not a faint cloud.
    * A surface crossing a slab boundary splits between the two slabs; they
      sum to 255. Pick ``nz`` so a slab is thicker than the surface relief you
      want to read as solid (a hand is ~30-50 mm deep).
    * One stray pixel in a column of hundreds reads 0 or 1: thin noise is low.
    * Summed over ``z``, the grid is the occupancy grid of the same lateral
      cells (up to per-slab rounding).

    ``.tobytes()`` of the result is the wire layout defined in protocol.ts:
    x fastest, then y (row 0 = top of the ROI), then z (nearest slab first).
    """
    rh, rw = mask.shape
    column, area, slab = _voxel_tables(rh, rw, nx, ny, nz, float(near_mm), float(far_mm))
    idx = np.flatnonzero(mask)
    flat = slab[np.take(roi_mm, idx)] * np.int32(nx * ny) + np.take(column, idx)
    counts = np.bincount(flat, minlength=nx * ny * nz)
    frac = counts.reshape(nz, ny, nx) / np.maximum(area, 1)[None, :, :]
    return np.clip(np.round(frac * 255.0), 0, 255).astype(np.uint8)


@functools.lru_cache(maxsize=8)
def _surface_tables(rh: int, rw: int, width: int, height: int) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Group starts and cell areas for :func:`scan_surface`, cached per frame size and grid (read-only)."""
    col_bin, row_bin = cell_bins(rw, width), cell_bins(rh, height)
    row_starts = np.searchsorted(row_bin, np.arange(height))  # first pixel row of each cell row
    col_starts = np.searchsorted(col_bin, np.arange(width))
    area = np.outer(np.bincount(row_bin, minlength=height), np.bincount(col_bin, minlength=width))
    return row_starts, col_starts, area


NO_DEPTH = np.uint16(65535)  # sentinel for "no foreground pixel" inside scan_surface


def scan_surface(roi_mm: np.ndarray, mask: np.ndarray, near_mm: float, far_mm: float, width: int, height: int) -> np.ndarray:
    """Nearest foreground depth per cell as ``uint8`` of shape ``(height, width)``: a 3D scan of the foreground.

    Cells tile the ROI with the same pixel-centre rule as :func:`voxelize`
    (:func:`cell_bins`), row 0 at the top. A cell with no ``True`` pixel of
    ``mask`` reads 0. Otherwise it holds the NEAREST in-range depth among its
    pixels, normalized into the box and packed as ``1 + round(254 * w)``
    (``w = (mm - near) / (far - near)``): 1 is the near plane, 255 the far
    plane, so a value can never be mistaken for "empty". The minimum is a
    block reduction (``np.minimum.reduceat`` twice) over the masked depth, so
    the cost is one pass over the ROI regardless of grid size or foreground.
    ``.tobytes()`` is the wire layout: row-major, row 0 first.
    """
    rh, rw = mask.shape
    row_starts, col_starts, area = _surface_tables(rh, rw, width, height)
    masked = np.where(mask, roi_mm, NO_DEPTH)
    nearest = np.minimum.reduceat(np.minimum.reduceat(masked, row_starts, axis=0), col_starts, axis=1)
    w = np.clip((nearest.astype(np.float64) - near_mm) / (far_mm - near_mm), 0.0, 1.0)
    out = (1.0 + np.round(254.0 * w)).astype(np.uint8)
    out[(nearest == NO_DEPTH) | (area == 0)] = 0  # empty cells, and reduceat's placeholder for zero-pixel cells
    return out


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

    Pipeline: crop the ROI -> the frame's tracked hands, if any, normalized
    with the same box (:func:`normalize_tracked_hand`) and kept while their
    palm is within ``hand_margin`` of it -> fuse the kept hands' capsule model
    into the depth (``scan_fusion``, per ``config.scan_fuse``) -> mask pixels
    with ``near <= depth <= far`` -> morphological opening -> connected
    components -> keep the largest ``max_hands`` blobs with at least
    ``min_pixels`` -> per blob: centroid, nearest-percentile depth, extent,
    confidence, sample points -> stable ids from :class:`BlobTracker` ->
    occupancy grid of the mask -> voxel grid of the mask binned by depth (the
    foreground in 3D) -> surface scan (nearest depth per cell). Everything
    after the fusion sees the fused depth, so the scan, the voxels and the
    blobs agree with the skeleton. All outputs are ROI-normalized (see the
    module docstring). ``focal_px`` is the depth image's focal length when it
    is a perspective view (:func:`source_focal_px`); without one the model's
    relief is scaled as if the box were isotropic.
    """

    def __init__(self, box: BoxConfig, config: AnalyzerConfig | None = None, focal_px: float | None = None) -> None:
        self.box = box
        self.config = config or AnalyzerConfig()
        self.focal_px = None if focal_px is None else float(focal_px)
        if self.focal_px is not None and not (self.focal_px > 0.0):
            raise ValueError("focal_px must be positive")
        self.tracker = BlobTracker(self.config.max_jump, self.config.max_missed)
        self._rate = RateMeter()
        self._fusion = _import_scan_fusion() if self.config.scan_fuse != "off" else None
        self._model_canvas: np.ndarray | None = None  # reused across frames: a fresh 1 MB float32 image costs more than rendering into it

    def analyze(self, frame: DepthFrame) -> AnalysisResult:
        started = time.perf_counter()
        cfg, box = self.config, self.box
        x0, y0, x1, y1 = box.roi_pixels(frame.width, frame.height)
        roi = frame.depth_mm[y0:y1, x0:x1]
        rh, rw = roi.shape
        near_mm, far_mm = box.near_mm, box.far_mm
        span_mm = far_mm - near_mm

        hands: list[SkeletonHand] = []
        fused: list[TrackedHand] = []
        for hand in frame.hands or ():
            skeleton = normalize_tracked_hand(hand, (x0, y0, x1, y1), near_mm, far_mm, cfg.sample_points)
            if hand_in_box(skeleton, cfg.hand_margin) and len(hands) < MAX_HANDS:
                hands.append(skeleton)
                fused.append(hand)
        from_model: np.ndarray | None = None
        if self._fusion is not None and fused:
            if self._model_canvas is None or self._model_canvas.shape != (rh, rw):
                self._model_canvas = np.empty((rh, rw), dtype=np.float32)
            mm_per_px = self._fusion.isotropic_mm_per_px(near_mm, far_mm, rw)
            model, bounds = self._fusion.render_hands(fused, (rh, rw), (x0, y0), self.focal_px, mm_per_px, out=self._model_canvas)
            roi, from_model = self._fusion.fuse_depth(roi, model, cfg.scan_fuse, cfg.fuse_tolerance_mm, near_mm, far_mm, bounds)

        mask = (roi >= max(near_mm, 1.0)) & (roi <= far_mm)  # depth 0 is "unknown", never inside the box
        mask = open_mask(mask, cfg.morph_iterations)
        in_range = int(np.count_nonzero(mask))
        model_pixels = int(np.count_nonzero(mask & from_model)) if from_model is not None else 0

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
        voxels = voxelize(roi, mask, near_mm, far_mm, *cfg.voxels) if cfg.voxels else None
        surface = scan_surface(roi, mask, near_mm, far_mm, *cfg.surface) if cfg.surface else None
        fps = self._rate.tick(frame.timestamp)
        stats = {
            "pixels": float(in_range),
            "blobs": float(len(candidates)),
            "trackedHands": float(len(hands)),
            "fusedHands": float(len(fused)) if from_model is not None else 0.0,
            "scanModelFraction": round(model_pixels / in_range, 4) if in_range else 0.0,
            "fps": round(fps, 2),
            "processingMs": round((time.perf_counter() - started) * 1000.0, 3),
            "frameWidth": float(frame.width),
            "frameHeight": float(frame.height),
        }
        return AnalysisResult(tracked, occupancy, stats, voxels, surface, tuple(hands))


# --------------------------------------------------------------------------- #
# Wire messages (mirror src/sim/input/protocol.ts exactly)
# --------------------------------------------------------------------------- #


def _unit(x: float) -> float:
    """Clamp to [0, 1] and round for compact JSON."""
    return round(min(1.0, max(0.0, float(x))), 4)


def _vec(p: Sequence[float]) -> list[float]:
    return [_unit(p[0]), _unit(p[1]), _unit(p[2])]


def _open_vec(p: Sequence[float]) -> list[float]:
    """A skeleton joint: rounded like ``pos`` but NOT clamped (the browser keeps joints outside the box)."""
    return [round(float(p[0]), 4), round(float(p[1]), 4), round(float(p[2]), 4)]


def _width(w: float) -> float:
    return round(max(0.0, float(w)), 4)


def skeleton_message(hand: SkeletonHand) -> dict[str, Any]:
    """The ``skeleton`` object of a tracked hand (``bridgeSkeletonSchema`` in protocol.ts)."""
    msg: dict[str, Any] = {"type": hand.type, "palm": _open_vec(hand.joints[JOINT_PALM]), "wrist": _open_vec(hand.joints[JOINT_WRIST])}
    if hand.has_elbow:
        msg["elbow"] = _open_vec(hand.joints[JOINT_ELBOW])
    msg["palmWidth"] = _width(hand.widths[WIDTH_PALM])
    msg["armWidth"] = _width(hand.widths[WIDTH_ARM])
    msg["fingers"] = [
        {
            "joints": [_open_vec(p) for p in hand.finger(f)],
            "width": _width(hand.widths[WIDTH_FINGERS + f]),
            "extended": bool(hand.extended[f]),
        }
        for f in range(N_FINGERS)
    ]
    return msg


def tracked_hand_message(hand: SkeletonHand) -> dict[str, Any]:
    """A ``hands[]`` entry for a tracked hand: ``pos`` is the palm (clamped), ``extent`` spans every joint."""
    return {
        "id": int(hand.id),
        "pos": _vec(hand.pos),
        "conf": _unit(hand.conf),
        "extent": [_vec(hand.extent[0]), _vec(hand.extent[1])],
        "openness": _unit(hand.openness),
        "pinch": _unit(hand.pinch),
        "points": [_vec(p) for p in hand.points[:MAX_POINTS]],
        "skeleton": skeleton_message(hand),
    }


def blob_hand_message(b: Blob) -> dict[str, Any]:
    return {
        "id": int(b.id),
        "pos": _vec(b.pos),
        "conf": _unit(b.conf),
        "extent": [_vec(b.extent[0]), _vec(b.extent[1])],
        "points": [_vec(p) for p in b.points[:MAX_POINTS]],
    }


def _encode_grid(grid: np.ndarray, ndim: int, what: str) -> str:
    """Base64 of a C-ordered ``uint8`` grid: the last axis varies fastest, index 0 of every axis comes first."""
    if grid.ndim != ndim:
        raise ValueError(f"{what} grid must be {ndim}-D, got shape {grid.shape}")
    return base64.b64encode(np.ascontiguousarray(grid, dtype=np.uint8).tobytes()).decode("ascii")


def encode_occupancy(grid: np.ndarray) -> str:
    """Base64 of the ``(height, width)`` grid's bytes, row-major, row 0 first (= top)."""
    return _encode_grid(grid, 2, "occupancy")


def encode_voxels(grid: np.ndarray) -> str:
    """Base64 of a ``(nz, ny, nx)`` grid's bytes: x fastest, then y (top first), then z (nearest first)."""
    return _encode_grid(grid, 3, "voxel")


def encode_surface(grid: np.ndarray) -> str:
    """Base64 of the ``(height, width)`` surface scan's bytes, row-major, row 0 first (= top)."""
    return _encode_grid(grid, 2, "surface")


def hello_message(
    source: str, box: BoxConfig, fps: float | None, occupancy: tuple[int, int] | None,
    voxels: tuple[int, int, int] | None = None, surface: tuple[int, int] | None = None, skeleton: bool = False,
) -> dict[str, Any]:
    """The ``hello``; ``skeleton`` is announced only when the source tracks hands, omitted otherwise."""
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
    if voxels is not None:
        msg["voxels"] = {"nx": int(voxels[0]), "ny": int(voxels[1]), "nz": int(voxels[2])}
    if surface is not None:
        msg["surface"] = {"width": int(surface[0]), "height": int(surface[1])}
    if skeleton:
        msg["skeleton"] = True
    return msg


def frame_message(seq: int, t: float, result: AnalysisResult) -> dict[str, Any]:
    """One ``frame``: tracked hands (with skeletons) when the frame has any, otherwise the blobs, exactly as before."""
    if result.hands:
        hands = [tracked_hand_message(h) for h in result.hands[:MAX_HANDS]]
    else:
        hands = [blob_hand_message(b) for b in result.blobs[:MAX_HANDS]]
    msg: dict[str, Any] = {"type": "frame", "seq": int(seq), "t": round(float(t), 6), "hands": hands}
    if result.occupancy is not None:
        msg["occupancy"] = encode_occupancy(result.occupancy)
    if result.voxels is not None:
        msg["voxels"] = encode_voxels(result.voxels)
    if result.surface is not None:
        msg["surface"] = encode_surface(result.surface)
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
#: Sources implemented in ``leap_source.py`` (imported on demand; they need OpenCV), with their default depth range in metres:
#: the Leap Motion Controller looks up from the desk and sees about 10-45 cm of height.
LEAP_SOURCES: dict[str, tuple[float, float]] = {"leap": (0.1, 0.45), "leap-synthetic": (0.1, 0.45)}
DEFAULT_RANGE_M = (0.4, 1.2)
DEFAULT_SURFACE = (64, 48)  # the AnalyzerConfig default; the Leap sources use LEAP_DEFAULT_SURFACE (see resolve_surface)
LEAP_ORIENTATIONS = ("none", "rot90", "rot180", "rot270", "flip-h", "flip-v", "transpose")  # mirrors leap_stereo.ORIENTATIONS


def _import_leap_source() -> Any:
    try:
        if __package__:
            from . import leap_source  # type: ignore[import-not-found]
        else:
            import leap_source  # type: ignore[import-not-found]
    except ImportError as exc:
        raise SystemExit(f"--source leap needs bridge/leap_source.py and OpenCV (pip install opencv-python): {exc}") from exc
    return leap_source


def resolve_range(args: argparse.Namespace) -> tuple[float, float]:
    """``(near, far)`` in metres: the flags if given, else the source's default range."""
    near, far = LEAP_SOURCES.get(args.source, DEFAULT_RANGE_M)
    return (near if args.near is None else args.near, far if args.far is None else args.far)


#: The Leap sources' rectified view (mirrors ``leap_source.DEFAULT_VIEW``) and their surface scan: a hand 25 cm above the
#: controller is 120 px wide and a finger 13 px in that view, so 3 pixels per cell keep the fingers apart in the scan.
LEAP_DEFAULT_VIEW = (480, 360)
LEAP_DEFAULT_SURFACE = (160, 120)


def resolve_surface(args: argparse.Namespace) -> tuple[int, int]:
    """``--surface`` if given, else the source's default: 160x120 for the Leap sources, 64x48 otherwise."""
    if args.surface is not None:
        return tuple(args.surface)
    return LEAP_DEFAULT_SURFACE if args.source in LEAP_SOURCES else DEFAULT_SURFACE


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="Depth-camera bridge: streams blobs inside a physical box to the browser over WebSocket.")
    p.add_argument("--source", choices=sorted(SOURCES) + sorted(LEAP_SOURCES), default="synthetic", help="frame source (default: synthetic)")
    p.add_argument("--host", default=DEFAULT_HOST, help="bind address (default: %(default)s)")
    p.add_argument("--port", type=int, default=DEFAULT_PORT, help="bind port (default: %(default)s)")
    p.add_argument("--near", type=float, default=None, metavar="M", help=f"nearest plane of the box in metres (default: {DEFAULT_RANGE_M[0]}, {LEAP_SOURCES['leap'][0]} for the Leap sources)")
    p.add_argument("--far", type=float, default=None, metavar="M", help=f"farthest plane of the box in metres (default: {DEFAULT_RANGE_M[1]}, {LEAP_SOURCES['leap'][1]} for the Leap sources)")
    p.add_argument("--roi", type=float, nargs=4, default=(0.0, 0.0, 1.0, 1.0), metavar=("X0", "Y0", "X1", "Y1"), help="image rectangle as fractions of width/height (default: full frame)")
    p.add_argument("--box-x", type=float, nargs=2, default=(-0.5, 0.5), metavar=("MIN", "MAX"), help="metric x extent reported in hello (informational)")
    p.add_argument("--box-y", type=float, nargs=2, default=(-0.4, 0.4), metavar=("MIN", "MAX"), help="metric y extent reported in hello (informational)")
    p.add_argument("--occupancy", type=int, nargs=2, default=(32, 24), metavar=("W", "H"), help="occupancy grid size (default: 32 24)")
    p.add_argument("--no-occupancy", action="store_true", help="do not send an occupancy grid")
    p.add_argument("--voxels", type=int, nargs=3, default=(32, 24, 16), metavar=("NX", "NY", "NZ"), help=f"foreground voxel grid: cells across, down and deep into the box, each 1..{MAX_VOXEL_SIDE} (default: 32 24 16)")
    p.add_argument("--no-voxels", action="store_true", help="do not send a voxel grid")
    p.add_argument("--surface", type=int, nargs=2, default=None, metavar=("W", "H"), help=f"nearest-depth surface scan size, each side 1..{MAX_SURFACE_SIDE} (default: {DEFAULT_SURFACE[0]} {DEFAULT_SURFACE[1]}, {LEAP_DEFAULT_SURFACE[0]} {LEAP_DEFAULT_SURFACE[1]} for the Leap sources)")
    p.add_argument("--no-surface", action="store_true", help="do not send a surface scan")
    p.add_argument("--scan-fuse", choices=SCAN_FUSE_MODES, default=DEFAULT_SCAN_FUSE, help="fuse the tracked hands' capsule model into the depth before the scan, voxels, occupancy and blobs: 'fill' keeps measurements that agree with the model within --fuse-tolerance and takes the model where the measurement is missing or disagrees, 'model' takes the model wherever it has a surface, 'off' uses the measurement alone (default: %(default)s)")
    p.add_argument("--fuse-tolerance", type=float, default=DEFAULT_FUSE_TOLERANCE_MM, metavar="MM", help="under --scan-fuse fill, how far a measurement may differ from the model and still be kept (default: %(default)s mm)")
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
    leap = p.add_argument_group("Leap Motion Controller (--source leap / leap-synthetic; see bridge/README.md)")
    leap.add_argument("--leapc", metavar="PATH", help="LeapC library (default: search the Ultraleap Gemini/Hyperion SDK, then Leap Motion Core Services, then $LEAPC_DLL)")
    leap.add_argument("--leap-view", type=int, nargs=2, default=LEAP_DEFAULT_VIEW, metavar=("W", "H"), help="rectified stereo view = depth image size (default: %d %d)" % LEAP_DEFAULT_VIEW)
    leap.add_argument("--leap-fov", type=float, default=90.0, metavar="DEG", help="horizontal field of view of the rectified view in degrees (default: %(default)s)")
    # The matcher and invalidation flags below repeat leap_source.add_stereo_arguments (which cannot be imported here: OpenCV is optional);
    # test_leap_stereo pins the two parsers' defaults to each other.
    leap.add_argument("--leap-min-intensity", type=int, default=16, help="ignore IR pixels darker than this, 0..255; the LEDs do not reach the background (default: %(default)s)")
    leap.add_argument("--leap-max-intensity", type=int, default=250, help="ignore IR pixels at or above this, 0..255: a hand close to the LEDs saturates and matches anywhere; 255 = off (default: %(default)s)")
    leap.add_argument("--leap-min-lit", type=int, default=20, help="ignore a match darker than N * (300 mm / depth)^2 in a 5x5 neighbourhood: a dark wall cannot be 25 cm from the LEDs; 0 = off (default: %(default)s)")
    leap.add_argument("--leap-min-texture", type=int, default=0, help="ignore pixels whose 7x7 neighbourhood spans fewer grey levels than this; 0 = off (default: %(default)s; skin is smooth, so this hollows a hand before it removes phantoms)")
    leap.add_argument("--leap-uniqueness", type=int, default=15, help="percent margin the best disparity must win by, 0..100 (default: %(default)s)")
    leap.add_argument("--leap-block", type=int, default=5, help="matching block size, odd (default: %(default)s)")
    leap.add_argument("--leap-mode", choices=("sgbm", "hh", "3way"), default="3way", help="SGBM path aggregation: 3way (parallel, fastest), sgbm (5 directions), hh (8 directions, slowest) (default: %(default)s)")
    leap.add_argument("--leap-matcher", choices=("sgbm", "bm"), default="sgbm", help="sgbm or plain block matching (bm: faster, far sparser on skin) (default: %(default)s)")
    leap.add_argument("--leap-align", default="auto", metavar="MODE", help="right-camera alignment: 'auto' (fitted from feature matches in the first frames, default), 'none', or PITCH,ROLL[,YAW] in degrees")
    leap.add_argument("--leap-calibration", choices=("function", "lattice"), default="function", help="rectify with LeapRectilinearToPixel (function, default) or the images' 64x64 distortion lattice")
    leap.add_argument("--swap-cameras", action="store_true", help="exchange the two cameras before matching (use when the depth image stays empty with a hand over the device)")
    leap.add_argument("--leap-orient", choices=LEAP_ORIENTATIONS, default="none", help="rotate/flip the depth image before analysis so image right/down mean what the browser expects (default: none)")
    leap.add_argument("--leap-hand-frame", default="auto", metavar="MODE", help="how the LeapC hand skeleton is projected onto the depth image: 'auto' (default: every convention is scored against the scan until one clearly leads) or a convention name u{+|-}{x|z}_v{+|-}{z|x}_ref{+|-}, see bridge/README.md")
    p.add_argument("--log-level", default="info", choices=("debug", "info", "warning", "error"))
    return p


def make_source(args: argparse.Namespace) -> FrameSource:
    width, height = args.resolution
    if args.source == "synthetic":
        return SyntheticSource(width, height, args.fps, near_m=args.near, far_m=args.far, hands=args.synthetic_hands, paced=args.dump is None)
    if args.source == "realsense":
        return RealSenseSource(width, height, args.fps, decimation=args.decimation, hole_filling=args.hole_filling)
    if args.source in LEAP_SOURCES:
        leap = _import_leap_source()
        try:
            view = leap.ls.RectifiedView.from_fov(args.leap_view[0], args.leap_view[1], args.leap_fov)
            params = leap.stereo_params_from_args(args, args.near * 1000.0, prefix="leap_")
            if args.source == "leap-synthetic":
                return leap.LeapSyntheticSource(view, params, args.swap_cameras, args.leap_orient, fps=args.fps, paced=args.dump is None, hand_frame=args.leap_hand_frame)
            return leap.LeapStereoSource(args.leapc, view, params, args.swap_cameras, args.leap_orient, fps=args.fps, hand_frame=args.leap_hand_frame,
                                         alignment=args.leap_align, calibration=args.leap_calibration)
        except ValueError as exc:
            raise SystemExit(str(exc)) from exc
    raise SystemExit(f"unknown source {args.source!r}")


def _finish(source: FrameSource, code: int) -> int:
    """Exit code, or a hard exit when a native thread is stuck inside the source (LeapC's 5.0-preview stall)."""
    if getattr(source, "needs_hard_exit", False):
        log.warning("a native thread is stuck inside %s; exiting hard", source.name)
        sys.stdout.flush()
        sys.stderr.flush()
        os._exit(code)
    return code


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    args.near, args.far = resolve_range(args)
    args.surface = resolve_surface(args)
    logging.basicConfig(level=getattr(logging, args.log_level.upper()), stream=sys.stderr, format="%(asctime)s %(levelname)s %(message)s")
    try:
        box = BoxConfig(near_m=args.near, far_m=args.far, roi=tuple(args.roi), box_x=tuple(args.box_x), box_y=tuple(args.box_y))
        config = AnalyzerConfig(
            occupancy=None if args.no_occupancy else tuple(args.occupancy),
            voxels=None if args.no_voxels else tuple(args.voxels),
            surface=None if args.no_surface else tuple(args.surface),
            min_pixels=args.min_pixels, max_hands=args.max_hands, morph_iterations=args.morph,
            sample_points=args.points, max_jump=args.max_jump,
            scan_fuse=args.scan_fuse, fuse_tolerance_mm=args.fuse_tolerance,
        )
    except ValueError as exc:
        parser.error(str(exc))
    source = make_source(args)
    analyzer = BoxAnalyzer(box, config, focal_px=source_focal_px(source))
    hello = hello_message(source.name, box, source.fps, config.occupancy, config.voxels, config.surface, skeleton=source.skeleton)

    if args.dump is not None:
        if hasattr(sys.stdout, "reconfigure"):
            sys.stdout.reconfigure(newline="\n")  # JSON lines end in LF on every platform (fixtures are committed)
        try:
            dump_frames(source, analyzer, hello, args.dump, sys.stdout)
        except (RuntimeError, NotImplementedError) as exc:
            log.error("%s", exc)
            return _finish(source, 1)
        return _finish(source, 0)

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
    return _finish(source, 0)


if __name__ == "__main__":
    sys.exit(main())
