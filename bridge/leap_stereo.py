#!/usr/bin/env python3
"""Stereo maths that turns the Leap Motion Controller's infrared image pair into a depth map.

No LeapC in here: everything is numpy + OpenCV and unit-testable
(``bridge/test_leap_stereo.py``). ``leap_source.py`` feeds it real images.

The controller lies flat on the desk looking UP. It has two infrared cameras
40 mm apart along its long axis (device x), each with a very wide (~150 deg)
fisheye lens, and a calibration the service exposes as ``LeapRectilinearToPixel``:
"the ray with slopes (tx, ty, 1) lands on raw pixel (px, py)". That is all the
stereo needs:

1. :class:`Rectifier` picks one virtual pinhole camera for both eyes (the
   :class:`RectifiedView`: a width, a height and the tangent of the half field
   of view) and, per pixel of that view, asks the calibration where the ray
   lands in each raw camera. ``cv2.remap`` then produces two rectified images
   with the same pinhole model, so a scene point sits on the SAME ROW in both
   and differs only in column: horizontal epipolar lines.
2. :class:`StereoDepth` matches the pair (``cv2.StereoSGBM``) into a disparity
   ``d`` in rectified pixels and converts it to depth
   ``Z = baseline_mm * f / d`` with ``f = width / (2 * tan_half_h)`` the focal
   length of the rectified view in pixels. Unmatched pixels are 0, which the
   box analyzer already treats as "no measurement".

Axes of the depth image the bridge produces
-------------------------------------------
Column ``u`` grows with ray slope ``tx``, i.e. along the DEVICE's x axis (its
long axis, the baseline). Row ``v`` grows with ``ty``, along the device's
short axis (device z, toward or away from the performer). The depth value is
the HEIGHT above the device (device y), not distance from a camera looking at
the hand. So compared with a depth camera facing the performer, the "camera
image" here is a view from underneath: ``--near``/``--far`` are heights above
the desk, "pushing in" means lowering the hand, and the browser's mapping
decides which of ``u``/``v`` is left/right and which is toward the display.
The default browser mapping (``DEPTH_MAPPING``: u -> sim x mirrored, v -> sim y
flipped, w -> sim z) is a starting point; swap or mirror axes in the overlay
if the device sits rotated. :func:`reorient` can also rotate or flip the depth
image inside the bridge (``--leap-orient``), which is handy when the surface
scan must keep the browser's "image right/down" convention.

Quality to expect: a 40 mm baseline with ~0.24 deg per rectified pixel gives a
depth step of ``Z^2 / (baseline * f)`` per disparity pixel, about 9 mm at
300 mm with the default 480x360 view (f = 240 px); sub-pixel matching brings
the noise on a textured hand down to roughly 5-10 mm. Beyond ~450 mm the
controller's IR illumination fades and matches become sparse.

What the real frames showed (``stereo_lab.py`` on ``leap_source.py --dump-images``
output; see the README's "Tuning the stereo" for the numbers): the raw sensor
has only 2.4 px/deg horizontally and 1.2 rows/deg vertically at the centre of
its field, so the rectified view is already oversampling a hand over the
device; the two cameras' calibrations leave the right eye 1-2 rows above the
left at f = 160 px, which :class:`CameraAlignment` corrects; and the phantom
near depth in dark, featureless parts of the room is best removed by the
depth-aware brightness rule (``StereoParams.min_lit``) rather than by a
texture threshold, which hollows the equally smooth hand.
"""
from __future__ import annotations

import functools
import math
from dataclasses import dataclass
from typing import Callable, Sequence

import numpy as np

try:
    import cv2  # type: ignore[import-not-found]
except ImportError as exc:  # pragma: no cover - import guard
    raise ImportError("leap_stereo needs OpenCV: pip install opencv-python") from exc

#: ``eLeapPerspectiveType``: which camera a calibration query refers to.
CAMERA_LEFT = 1
CAMERA_RIGHT = 2
CAMERAS = (CAMERA_LEFT, CAMERA_RIGHT)
#: The Leap Motion Controller's stereo baseline (``LEAP_DEVICE_INFO.baseline`` = 40000 um).
CONTROLLER_BASELINE_MM = 40.0

#: ``ray_to_pixel(camera, tx, ty) -> (px, py)`` with ``LeapRectilinearToPixel`` semantics:
#: the ray with slopes ``(tx, ty)`` and ``z = 1`` lands on raw pixel ``(px, py)``
#: (OpenCV convention: integer coordinates are pixel centres).
RayToPixel = Callable[[int, float, float], tuple[float, float]]


# --------------------------------------------------------------------------- #
# Rectification
# --------------------------------------------------------------------------- #


@dataclass(frozen=True)
class RectifiedView:
    """The virtual pinhole camera both rectified images share.

    ``tan_half_h`` is the tangent of the horizontal half field of view
    (``1.0`` = +-45 deg); ``tan_half_v`` defaults to the value that makes the
    pixels square (``tan_half_h * height / width``). Pixel ``(u, v)`` covers
    the unit square ``[u, u + 1) x [v, v + 1)``; its centre looks along the
    ray ``((u + 0.5 - cx) / fx, (v + 0.5 - cy) / fy, 1)``. The horizontal
    focal length ``fx = width / (2 * tan_half_h)`` is the one stereo uses,
    because disparity is horizontal.
    """

    width: int = 320
    height: int = 240
    tan_half_h: float = 1.0
    tan_half_v: float | None = None

    def __post_init__(self) -> None:
        if self.width < 8 or self.height < 8:
            raise ValueError(f"rectified view must be at least 8x8, got {self.width}x{self.height}")
        if not (self.tan_half_h > 0):
            raise ValueError("tan_half_h must be positive")
        if self.tan_half_v is None:
            object.__setattr__(self, "tan_half_v", self.tan_half_h * self.height / self.width)
        elif not (self.tan_half_v > 0):
            raise ValueError("tan_half_v must be positive")

    @classmethod
    def from_fov(cls, width: int, height: int, hfov_deg: float) -> "RectifiedView":
        """A view of ``width x height`` square pixels spanning ``hfov_deg`` horizontally."""
        if not (0 < hfov_deg < 180):
            raise ValueError("horizontal field of view must be between 0 and 180 degrees")
        return cls(width, height, math.tan(math.radians(hfov_deg) / 2.0))

    @property
    def fx(self) -> float:
        return self.width / (2.0 * self.tan_half_h)

    @property
    def fy(self) -> float:
        assert self.tan_half_v is not None
        return self.height / (2.0 * self.tan_half_v)

    @property
    def cx(self) -> float:
        return self.width / 2.0

    @property
    def cy(self) -> float:
        return self.height / 2.0

    @property
    def hfov_deg(self) -> float:
        return math.degrees(2.0 * math.atan(self.tan_half_h))

    @property
    def vfov_deg(self) -> float:
        assert self.tan_half_v is not None
        return math.degrees(2.0 * math.atan(self.tan_half_v))

    def pixel_to_ray(self, u: np.ndarray | float, v: np.ndarray | float) -> tuple[np.ndarray, np.ndarray]:
        """Ray slopes ``(tx, ty)`` through the centre of pixel ``(u, v)``; arrays broadcast."""
        tx = (np.asarray(u, dtype=np.float64) + 0.5 - self.cx) / self.fx
        ty = (np.asarray(v, dtype=np.float64) + 0.5 - self.cy) / self.fy
        return tx, ty

    def ray_to_pixel(self, tx: np.ndarray | float, ty: np.ndarray | float) -> tuple[np.ndarray, np.ndarray]:
        """Continuous pixel coordinates (integer = pixel centre) of the ray ``(tx, ty, 1)``."""
        u = self.cx + self.fx * np.asarray(tx, dtype=np.float64) - 0.5
        v = self.cy + self.fy * np.asarray(ty, dtype=np.float64) - 0.5
        return u, v


def _upsample_lattice(lattice: np.ndarray, step: int, width: int, height: int) -> np.ndarray:
    """Bilinear interpolation of values sampled at ``(row j * step, col i * step)`` onto every pixel."""
    u, v = np.arange(width), np.arange(height)
    iu, fu = np.divmod(u, step)
    iv, fv = np.divmod(v, step)
    fu, fv = fu / step, fv / step
    a = lattice[iv[:, None], iu[None, :]]
    b = lattice[iv[:, None], iu[None, :] + 1]
    c = lattice[iv[:, None] + 1, iu[None, :]]
    d = lattice[iv[:, None] + 1, iu[None, :] + 1]
    wu, wv = fu[None, :], fv[:, None]
    return a * (1 - wu) * (1 - wv) + b * wu * (1 - wv) + c * (1 - wu) * wv + d * wu * wv


@dataclass(frozen=True)
class CameraAlignment:
    """A small rotation applied to one camera's rays before its calibration is asked where they land.

    LeapC's per-camera calibration (``LeapRectilinearToPixel`` and the image
    events' distortion matrices) undistorts each camera on its own but does
    not quite co-align the two: on the controller measured here the right
    camera's features sit 1-2 rows above the left's at f = 160 px, and the
    offset grows with the column, i.e. a pitch of a few tenths of a degree and
    a roll of about half a degree. Block matching on a pair misaligned by two
    rows is what turns a hand into a blob, so the rectifier rotates the right
    camera's rays by this before looking them up. Angles are in degrees:
    ``pitch`` about the baseline (x; positive moves the right view's content
    down, i.e. corrects features that sat too high), ``roll`` about the
    optical axis (z; positive corrects a right view whose rows tilt up
    towards the right), ``yaw`` about y (it offsets disparity by ``f * yaw``
    and cannot be told from depth without a known distance, so it is 0
    unless you know better). :func:`estimate_alignment` measures pitch and
    roll from image matches.
    """

    pitch: float = 0.0
    roll: float = 0.0
    yaw: float = 0.0

    @property
    def matrix(self) -> np.ndarray:
        """``R`` such that a ray ``d`` of the aligned view is the calibration's ray ``R @ d``."""
        rx, ry, rz = (math.radians(a) for a in (self.pitch, self.yaw, self.roll))
        cx, sx, cy, sy, cz, sz = math.cos(rx), math.sin(rx), math.cos(ry), math.sin(ry), math.cos(rz), math.sin(rz)
        mx = np.array([[1.0, 0.0, 0.0], [0.0, cx, -sx], [0.0, sx, cx]])
        my = np.array([[cy, 0.0, sy], [0.0, 1.0, 0.0], [-sy, 0.0, cy]])
        mz = np.array([[cz, -sz, 0.0], [sz, cz, 0.0], [0.0, 0.0, 1.0]])
        return mz @ my @ mx

    @property
    def identity(self) -> bool:
        return self.pitch == 0.0 and self.roll == 0.0 and self.yaw == 0.0

    def rotate(self, tx: np.ndarray | float, ty: np.ndarray | float) -> tuple[np.ndarray, np.ndarray]:
        """Ray slopes of the aligned view -> slopes in the calibration's own frame (arrays broadcast)."""
        tx, ty = np.asarray(tx, dtype=np.float64), np.asarray(ty, dtype=np.float64)
        r = self.matrix
        x = r[0, 0] * tx + r[0, 1] * ty + r[0, 2]
        y = r[1, 0] * tx + r[1, 1] * ty + r[1, 2]
        z = r[2, 0] * tx + r[2, 1] * ty + r[2, 2]
        with np.errstate(divide="ignore", invalid="ignore"):
            return x / z, y / z

    @property
    def name(self) -> str:
        return f"{self.pitch:.3f},{self.roll:.3f}" + (f",{self.yaw:.3f}" if self.yaw else "")

    @classmethod
    def parse(cls, text: str) -> "CameraAlignment":
        """``"PITCH,ROLL"`` or ``"PITCH,ROLL,YAW"`` in degrees; ``"none"`` is the identity."""
        if text.strip().lower() in ("none", "0", ""):
            return cls()
        parts = [float(p) for p in text.split(",")]
        if len(parts) not in (2, 3) or any(abs(p) > 10.0 for p in parts):
            raise ValueError(f"alignment must be PITCH,ROLL[,YAW] in degrees (each within +-10), got {text!r}")
        return cls(parts[0], parts[1], parts[2] if len(parts) == 3 else 0.0)


#: ``LEAP_DISTORTION_MATRIX`` is 64x64 points; the lattice spans ray slopes ``-4..4`` (+-76 deg) in both directions.
DISTORTION_GRID_N = 64
DISTORTION_SLOPE_RANGE = 4.0


class GridCalibration:
    """The controller's calibration as a sampled grid, usable offline: a :data:`RayToPixel` built from arrays.

    The distortion matrix LeapC attaches to every image (``LEAP_IMAGE.distortion_matrix``,
    ``float[64][64][2]``) is a lookup table from ray direction to raw pixel,
    verified against the live ``LeapRectilinearToPixel`` and the images it
    rectified: entry ``[j, i]`` holds the raw-image coordinates, normalized to
    ``0..1`` of the width and height, hit by the ray with slopes
    ``tx = -4 + 8 i / 63`` (columns run with ``+tx``, image right) and
    ``ty = 4 - 8 j / 63`` (row 0 is ``+ty``, image DOWN: the rows are stored
    bottom-up, the OpenGL texture convention of the original SDK's distortion
    shaders). Values outside ``0..1`` are rays that miss the sensor. In pixels
    that is ``x * width - 0.5`` (OpenCV's integer-is-centre convention), which
    matches the live function to a quarter pixel in the centre; towards the
    edges of the sensor the two disagree by several pixels (the function
    extrapolates differently), so a grid of the function's own answers on the
    same lattice (``normalized=False``, pixels) reproduces the bridge's live
    rectification exactly and is what ``leap_source.py --dump-images`` saves
    next to the lattice. ``grids`` maps camera -> ``(64, 64, 2)`` array;
    lookups are bilinear, vectorised in :meth:`lookup`, scalar via
    :meth:`__call__` (the :data:`RayToPixel` protocol).
    """

    def __init__(self, grids: dict[int, np.ndarray], raw_width: int, raw_height: int, normalized: bool = True, slope_range: float = DISTORTION_SLOPE_RANGE) -> None:
        if raw_width < 1 or raw_height < 1:
            raise ValueError("raw image size must be positive")
        self.raw_width, self.raw_height = int(raw_width), int(raw_height)
        self.slope_range = float(slope_range)
        self.grids: dict[int, np.ndarray] = {}
        for camera, grid in grids.items():
            g = np.asarray(grid, dtype=np.float64)
            if g.ndim != 3 or g.shape[0] != g.shape[1] or g.shape[2] != 2 or g.shape[0] < 2:
                raise ValueError(f"camera {camera}: expected an (N, N, 2) grid, got {g.shape}")
            if normalized:
                g = np.stack([g[..., 0] * self.raw_width - 0.5, g[..., 1] * self.raw_height - 0.5], axis=-1)
            self.grids[int(camera)] = np.ascontiguousarray(g)
        if not self.grids:
            raise ValueError("no calibration grids")

    @classmethod
    def load(cls, directory: str, raw_width: int = 640, raw_height: int = 240, prefer_samples: bool = True) -> "GridCalibration":
        """The grids ``leap_source.py --dump-images`` writes: ``leap_r2p_{left,right}.npy`` (function samples, pixels) if present and
        ``prefer_samples``, else ``leap_distortion_{left,right}.npy`` (the image events' lattices, normalized)."""
        import os

        for prefix, normalized in (("leap_r2p", False), ("leap_distortion", True)):
            if prefix == "leap_r2p" and not prefer_samples:
                continue
            paths = {CAMERA_LEFT: os.path.join(directory, f"{prefix}_left.npy"), CAMERA_RIGHT: os.path.join(directory, f"{prefix}_right.npy")}
            if all(os.path.isfile(p) for p in paths.values()):
                cal = cls({cam: np.load(p) for cam, p in paths.items()}, raw_width, raw_height, normalized=normalized)
                cal.source = prefix  # type: ignore[attr-defined]
                return cal
        raise FileNotFoundError(f"no leap_r2p_*.npy or leap_distortion_*.npy in {directory}")

    def lookup(self, camera: int, tx: np.ndarray | float, ty: np.ndarray | float) -> tuple[np.ndarray, np.ndarray]:
        """Raw pixel coordinates of rays ``(tx, ty, 1)``; NaN for rays outside the lattice."""
        grid = self.grids[int(camera)]
        n = grid.shape[0]
        a = (np.asarray(tx, dtype=np.float64) + self.slope_range) / (2.0 * self.slope_range) * (n - 1)
        b = (self.slope_range - np.asarray(ty, dtype=np.float64)) / (2.0 * self.slope_range) * (n - 1)
        ok = (a >= 0) & (a <= n - 1) & (b >= 0) & (b <= n - 1)
        a = np.clip(np.nan_to_num(a), 0.0, n - 1 - 1e-9)
        b = np.clip(np.nan_to_num(b), 0.0, n - 1 - 1e-9)
        i0, j0 = np.floor(a).astype(np.int64), np.floor(b).astype(np.int64)
        fa, fb = (a - i0)[..., None], (b - j0)[..., None]
        p = (grid[j0, i0] * (1 - fa) * (1 - fb) + grid[j0, i0 + 1] * fa * (1 - fb) + grid[j0 + 1, i0] * (1 - fa) * fb + grid[j0 + 1, i0 + 1] * fa * fb)
        px, py = p[..., 0], p[..., 1]
        px = np.where(ok, px, np.nan)
        py = np.where(ok, py, np.nan)
        return px, py

    def __call__(self, camera: int, tx: float, ty: float) -> tuple[float, float]:
        px, py = self.lookup(camera, tx, ty)
        return float(px), float(py)

    @property
    def cameras(self) -> tuple[int, ...]:
        return tuple(self.grids)


class Rectifier:
    """Builds and applies ``cv2.remap`` maps that turn raw images into the :class:`RectifiedView`.

    ``ray_to_pixel`` is queried on a lattice every ``sample_step`` rectified
    pixels (the Leap's own calibration is a 64x64 grid, so nothing is lost)
    and interpolated bilinearly in between; ``sample_step=1`` queries every
    pixel. A calibration with a vectorised ``lookup`` (:class:`GridCalibration`)
    is asked for the whole lattice at once. Rays the calibration cannot place
    (non-finite results) map outside the raw image and come out black.
    ``coverage[camera]`` is the fraction of the view that lands inside the
    raw image. ``alignment`` rotates a camera's rays (:class:`CameraAlignment`)
    before the lookup; by convention only the right camera is aligned, to the
    left, so the reference view keeps the calibration's frame.
    """

    def __init__(
        self, ray_to_pixel: RayToPixel, raw_width: int, raw_height: int,
        view: RectifiedView | None = None, cameras: Sequence[int] = CAMERAS, sample_step: int = 4,
        alignment: "dict[int, CameraAlignment] | CameraAlignment | None" = None,
    ) -> None:
        if raw_width < 1 or raw_height < 1:
            raise ValueError("raw image size must be positive")
        if sample_step < 1:
            raise ValueError("sample_step must be at least 1")
        self.view = view or RectifiedView()
        self.raw_width, self.raw_height = int(raw_width), int(raw_height)
        self.sample_step = int(sample_step)
        if isinstance(alignment, CameraAlignment):
            alignment = {CAMERA_RIGHT: alignment}
        self.alignment: dict[int, CameraAlignment] = {int(k): v for k, v in (alignment or {}).items() if not v.identity}
        self.maps: dict[int, tuple[np.ndarray, np.ndarray]] = {}
        self.coverage: dict[int, float] = {}
        for camera in cameras:
            map_x, map_y = self._build(ray_to_pixel, int(camera))
            self.maps[int(camera)] = (map_x, map_y)
            inside = (map_x >= 0) & (map_x <= self.raw_width - 1) & (map_y >= 0) & (map_y <= self.raw_height - 1)
            self.coverage[int(camera)] = float(inside.mean())

    def _build(self, ray_to_pixel: RayToPixel, camera: int) -> tuple[np.ndarray, np.ndarray]:
        view, step = self.view, self.sample_step
        nu, nv = (view.width - 1) // step + 2, (view.height - 1) // step + 2
        i, j = np.meshgrid(np.arange(nu), np.arange(nv))
        tx, ty = view.pixel_to_ray(i * step, j * step)
        align = self.alignment.get(camera)
        if align is not None:
            tx, ty = align.rotate(tx, ty)
        lookup = getattr(ray_to_pixel, "lookup", None)
        if callable(lookup):
            lat_x, lat_y = lookup(camera, tx, ty)
            lat_x, lat_y = np.asarray(lat_x, dtype=np.float64), np.asarray(lat_y, dtype=np.float64)
        else:
            lat_x = np.empty((nv, nu), dtype=np.float64)
            lat_y = np.empty((nv, nu), dtype=np.float64)
            for jj in range(nv):
                for ii in range(nu):
                    px, py = ray_to_pixel(camera, float(tx[jj, ii]), float(ty[jj, ii]))
                    lat_x[jj, ii], lat_y[jj, ii] = px, py
        map_x = _upsample_lattice(lat_x, step, view.width, view.height)
        map_y = _upsample_lattice(lat_y, step, view.width, view.height)
        bad = ~(np.isfinite(map_x) & np.isfinite(map_y))
        map_x[bad] = -1.0
        map_y[bad] = -1.0
        return np.ascontiguousarray(map_x, dtype=np.float32), np.ascontiguousarray(map_y, dtype=np.float32)

    def rectify(self, image: np.ndarray, camera: int) -> np.ndarray:
        """Resample one raw image (``(raw_height, raw_width)``) into the rectified view."""
        if image.shape[:2] != (self.raw_height, self.raw_width):
            raise ValueError(f"raw image is {image.shape[1]}x{image.shape[0]}, maps were built for {self.raw_width}x{self.raw_height}")
        map_x, map_y = self.maps[int(camera)]
        return cv2.remap(image, map_x, map_y, cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT, borderValue=0)

    def rectify_pair(self, left: np.ndarray, right: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        return self.rectify(left, CAMERA_LEFT), self.rectify(right, CAMERA_RIGHT)


# --------------------------------------------------------------------------- #
# Estimating the camera alignment from the images themselves
# --------------------------------------------------------------------------- #


def match_pair(left: np.ndarray, right: np.ndarray, max_dy: float = 12.0, max_disparity: float = 160.0, ratio: float = 0.7, features: int = 4000) -> np.ndarray:
    """Feature matches between a rectified pair as ``(N, 4)`` rows ``(u_left, v_left, u_right, v_right)`` (pixel-centre coordinates).

    SIFT (ORB when OpenCV lacks it) with Lowe's ratio test, keeping matches
    whose rows differ by at most ``max_dy`` and whose disparity is between -1
    and ``max_disparity``; the scale of the two keypoints must agree, which
    drops most mismatches on repetitive ceiling texture.
    """
    if hasattr(cv2, "SIFT_create"):
        detector = cv2.SIFT_create(nfeatures=features, contrastThreshold=0.015, edgeThreshold=20)
        norm = cv2.NORM_L2
    else:  # pragma: no cover - older OpenCV builds
        detector = cv2.ORB_create(nfeatures=features)
        norm = cv2.NORM_HAMMING
    kl, dl = detector.detectAndCompute(left, None)
    kr, dr = detector.detectAndCompute(right, None)
    if dl is None or dr is None or len(kl) < 2 or len(kr) < 2:
        return np.zeros((0, 4))
    out = []
    for pair in cv2.BFMatcher(norm).knnMatch(dl, dr, k=2):
        if len(pair) < 2:
            continue
        m, n = pair
        if m.distance >= ratio * n.distance:
            continue
        a, b = kl[m.queryIdx], kr[m.trainIdx]
        disparity = a.pt[0] - b.pt[0]
        if abs(a.pt[1] - b.pt[1]) > max_dy or not (-1.0 <= disparity <= max_disparity) or abs(a.size - b.size) > 0.5 * a.size:
            continue
        out.append((a.pt[0], a.pt[1], b.pt[0], b.pt[1]))
    return np.asarray(out, dtype=np.float64).reshape(-1, 4)


def matches_to_rays(matches: np.ndarray, view: RectifiedView, current: CameraAlignment | None = None) -> np.ndarray:
    """``(N, 4)`` pixel matches -> ``(N, 4)`` ray slopes ``(txL, tyL, txR, tyR)``, the right ones in its calibration frame.

    ``current`` is the alignment the right view was rectified with, so that
    matches measured on an already partly aligned pair still describe the
    calibration frame and fits can be refined and accumulated.
    """
    m = np.asarray(matches, dtype=np.float64).reshape(-1, 4)
    txl, tyl = view.pixel_to_ray(m[:, 0], m[:, 1])
    txr, tyr = view.pixel_to_ray(m[:, 2], m[:, 3])
    if current is not None and not current.identity:
        txr, tyr = current.rotate(txr, tyr)
    return np.stack([txl, tyl, txr, tyr], axis=-1)


def _alignment_residual(pitch_rad: float, roll_rad: float, rays: np.ndarray) -> np.ndarray:
    align = CameraAlignment(math.degrees(pitch_rad), math.degrees(roll_rad))
    r = align.matrix  # calibration ray = R @ aligned ray  =>  aligned ray = R^T @ calibration ray
    x, y, z = rays[:, 2], rays[:, 3], 1.0
    ay = r[0, 1] * x + r[1, 1] * y + r[2, 1] * z
    az = r[0, 2] * x + r[1, 2] * y + r[2, 2] * z
    return ay / az - rays[:, 1]


@dataclass(frozen=True)
class AlignmentFit:
    """Result of :func:`fit_alignment`: the alignment, how many matches it was fitted on and the row error before/after (view pixels)."""

    alignment: CameraAlignment
    matches: int
    before_px: float
    after_px: float

    def describe(self) -> str:
        return f"pitch {self.alignment.pitch:+.3f} deg, roll {self.alignment.roll:+.3f} deg from {self.matches} matches (row error {self.before_px:.2f} -> {self.after_px:.2f} px)"


def fit_alignment(rays: np.ndarray, view: RectifiedView, iterations: int = 30, huber_px: float = 1.0) -> AlignmentFit:
    """Pitch and roll of the right camera that put matched features on the same row (yaw stays 0).

    Gauss-Newton on the vertical ray error with Huber-like reweighting
    (``huber_px`` in view pixels), so a few wrong matches do not steer it.
    """
    rays = np.asarray(rays, dtype=np.float64).reshape(-1, 4)
    if len(rays) < 4:
        raise ValueError(f"need at least 4 matches to fit the alignment, got {len(rays)}")
    p = np.zeros(2)
    scale = huber_px / view.fy
    r0 = _alignment_residual(0.0, 0.0, rays)
    for _ in range(iterations):
        r = _alignment_residual(p[0], p[1], rays)
        jac = np.empty((len(rays), 2))
        for k in range(2):
            dp = np.zeros(2)
            dp[k] = 1e-7
            jac[:, k] = (_alignment_residual(p[0] + dp[0], p[1] + dp[1], rays) - r) / 1e-7
        w = 1.0 / np.maximum(1.0, np.abs(r) / scale)
        step, *_ = np.linalg.lstsq(jac * w[:, None], -r * w, rcond=None)
        p = p + step
        if float(np.abs(step).max()) < 1e-10:
            break
    r1 = _alignment_residual(p[0], p[1], rays)
    align = CameraAlignment(round(math.degrees(p[0]), 4), round(math.degrees(p[1]), 4))
    return AlignmentFit(align, len(rays), float(np.median(np.abs(r0)) * view.fy), float(np.median(np.abs(r1)) * view.fy))


def estimate_alignment(left: np.ndarray, right: np.ndarray, view: RectifiedView, current: CameraAlignment | None = None) -> AlignmentFit:
    """One-shot :func:`match_pair` + :func:`fit_alignment` on a rectified pair (``current`` = the alignment it was made with)."""
    return fit_alignment(matches_to_rays(match_pair(left, right), view, current), view)


class AlignmentEstimator:
    """Accumulates matches over frames and fits once there are enough (``--leap-align auto``).

    Feed every rectified pair to :meth:`observe`; it returns the fit the
    first time at least ``min_matches`` matches from at least ``min_frames``
    frames are in, and ``None`` before that and after (``fit`` keeps the
    result). ``max_frames`` caps how long a scene without features is tried.
    """

    def __init__(self, view: RectifiedView, current: CameraAlignment | None = None, min_matches: int = 150, min_frames: int = 5, max_frames: int = 300) -> None:
        self.view, self.current = view, current or CameraAlignment()
        self.min_matches, self.min_frames, self.max_frames = int(min_matches), int(min_frames), int(max_frames)
        self.rays: list[np.ndarray] = []
        self.matches = 0
        self.frames = 0
        self.fit: AlignmentFit | None = None

    @property
    def done(self) -> bool:
        return self.fit is not None or self.frames >= self.max_frames

    def observe(self, left: np.ndarray, right: np.ndarray) -> AlignmentFit | None:
        if self.done:
            return None
        self.frames += 1
        m = match_pair(left, right)
        if len(m):
            self.rays.append(matches_to_rays(m, self.view, self.current))
            self.matches += len(m)
        if self.frames >= self.min_frames and self.matches >= self.min_matches:
            self.fit = fit_alignment(np.concatenate(self.rays), self.view)
            return self.fit
        return None

    def describe(self) -> str:
        if self.fit is not None:
            return self.fit.describe()
        if self.frames >= self.max_frames:
            return f"gave up after {self.frames} frames with {self.matches} matches (keeping {self.current.name})"
        return f"collecting: {self.matches} matches from {self.frames} frames"


# --------------------------------------------------------------------------- #
# Stereo matching
# --------------------------------------------------------------------------- #


def local_range(image: np.ndarray, window: int) -> np.ndarray:
    """Spread of intensities (max - min) in a ``window x window`` neighbourhood of every pixel, as ``uint8``."""
    kernel = np.ones((window, window), dtype=np.uint8)
    return cv2.subtract(cv2.dilate(image, kernel), cv2.erode(image, kernel))


CONTRAST_MODES = ("none", "gain", "lcn")


def _local_moments(image: np.ndarray, window: int) -> tuple[np.ndarray, np.ndarray]:
    """Mean and standard deviation of ``image`` over a ``window x window`` box around every pixel (``float32``)."""
    x = image.astype(np.float32)
    mean = cv2.blur(x, (window, window))
    var = cv2.blur(x * x, (window, window)) - mean * mean
    return mean, np.sqrt(np.maximum(var, 0.0))


def normalize_intensity(image: np.ndarray, mode: str = "gain", window: int = 31, floor: float = 24.0, target: float = 96.0) -> np.ndarray:
    """Rescale a rectified IR image so that a dim (far) surface has the amplitude of a bright (near) one.

    The controller's LEDs light a hand at 45 cm with a third of the grey
    levels it has at 27 cm, and SGBM's data term (Birchfield-Tomasi on the
    intensities and their x-gradient) shrinks with it while the smoothness
    penalties ``P1``/``P2`` and the uniqueness margin stay fixed, so the dim
    hand loses to smoothness and comes out as holes and flat patches.
    ``"gain"`` multiplies every pixel by ``target / max(local_mean, floor)``
    over a ``window x window`` box: the local mean (the LED falloff and the
    hand's overall brightness) is levelled to ``target``, and the shading
    inside the window, which on smooth skin is most of what the matcher can
    lock onto, is scaled with it. ``floor`` caps the gain at ``target /
    floor`` so the dark room (grey 10-30) is not amplified into texture.
    ``"lcn"`` is local contrast normalisation, ``128 + (I - mean) * target /
    max(std, floor)``: it also removes the shading and, on the real 27 cm
    frame, loses a fifth of the hand; it is kept for comparison. Both return
    ``uint8``; the invalidation rules keep looking at the ORIGINAL image.
    """
    if mode == "none":
        return image
    if mode not in CONTRAST_MODES:
        raise ValueError(f"contrast mode must be one of {CONTRAST_MODES}, got {mode!r}")
    if window < 3 or window % 2 == 0:
        raise ValueError("contrast window must be odd and at least 3")
    mean, std = _local_moments(image, window)
    if mode == "gain":
        out = image.astype(np.float32) * (target / np.maximum(mean, max(float(floor), 1.0)))
    else:
        out = 128.0 + (image.astype(np.float32) - mean) * (target / 4.0) / np.maximum(std, max(float(floor), 0.5))
    return np.clip(out, 0, 255).astype(np.uint8)


def fill_holes(depth: np.ndarray, radius: int, tolerance_mm: Callable[[np.ndarray], np.ndarray] | float, min_support: float = 0.6, exclude: np.ndarray | None = None) -> np.ndarray:
    """Fill small holes of a depth map by normalised convolution, only where the surrounding depth agrees.

    A hole pixel (0) takes the mean of the valid depth in its ``(2 radius + 1)``
    square when at least ``min_support`` of that square is valid and the
    valid depths spread (standard deviation) by no more than ``tolerance_mm``
    (a number, or a function of the local mean depth: pass the matcher's
    depth step so the tolerance grows with ``Z^2``). Both conditions keep the
    filler from bridging the gap between two spread fingers: the middle of a
    gap wider than the radius has too little support, and a window that
    straddles a finger and the backdrop behind it spreads far beyond the
    tolerance. ``exclude`` marks pixels that must stay empty (what the
    invalidation rules threw out: too dark, saturated, underlit for their
    depth), so the filler only fills what the matcher left. ``radius <= 0``
    returns the input; the result is a new ``uint16`` array.
    """
    if radius <= 0:
        return depth
    k = 2 * int(radius) + 1
    box = (k, k)
    d = depth.astype(np.float32)  # holes are already 0
    valid = cv2.compare(d, 0.0, cv2.CMP_GT)  # uint8 0/255
    num = cv2.boxFilter(d, -1, box, normalize=False, borderType=cv2.BORDER_CONSTANT)
    den = cv2.boxFilter(valid, cv2.CV_32F, box, normalize=False, borderType=cv2.BORDER_CONSTANT)  # 255 per valid pixel
    sq = cv2.boxFilter(cv2.multiply(d, d), -1, box, normalize=False, borderType=cv2.BORDER_CONSTANT)
    safe = cv2.max(den, 1.0)
    mean = cv2.divide(num, safe, scale=255.0)               # 0 where nothing is valid
    var = cv2.subtract(cv2.divide(sq, safe, scale=255.0), cv2.multiply(mean, mean))
    spread = cv2.sqrt(cv2.max(var, 0.0))
    tol = tolerance_mm(mean) if callable(tolerance_mm) else np.full(mean.shape, float(tolerance_mm), dtype=np.float32)
    fill = cv2.bitwise_and(cv2.bitwise_not(valid), cv2.compare(den, min_support * k * k * 255.0, cv2.CMP_GE))
    fill = cv2.bitwise_and(fill, cv2.compare(spread, np.asarray(tol, dtype=np.float32), cv2.CMP_LE))
    if exclude is not None:
        fill = cv2.bitwise_and(fill, cv2.bitwise_not(np.ascontiguousarray(exclude, dtype=np.uint8) * 255))
    out = depth.copy()
    cv2.copyTo(cv2.add(mean, 0.5).astype(np.uint16), fill, out)  # rounded; mean > 0 wherever den > 0
    return out


class TemporalDepthFilter:
    """Median of the last ``length`` depth maps where they agree, without smearing a moving hand.

    The controller's disparity noise is independent frame to frame, so a
    per-pixel median over a few frames divides it by about the square root
    of their number and fills the holes that flicker from frame to frame.
    Unlike a plain running median, only samples that agree with the newest
    frame are used: where the newest frame has a measurement, an older one
    counts if it is within ``tolerance(depth)`` of it (pass the matcher's
    depth step scaled by a pixel count, so the tolerance grows with ``Z^2``
    like the noise does); where the newest frame has a hole, the most recent
    older measurement is the reference instead and the hole is filled from
    the samples that agree with it. A hand that moved by more than the
    tolerance since the previous frame therefore keeps only its newest
    sample (no lag), and its old position can only linger in pixels where
    the newest frame saw nothing at all, for at most ``length - 1`` frames.
    With ``majority`` on, a newest sample that no older sample agrees with
    is outvoted when at least two older samples agree with each other: the
    lone sample is then a wrong match (the scattered near or far spikes a
    dim hand produces) far more often than a hand that jumped by more than
    the tolerance in one frame, and the cost of being wrong about that is
    one frame of lag on that pixel. A hole in the newest frame is filled
    only when at least ``min_fill_samples`` older samples agree (2 by
    default: a speckle that matched once in the dark room does not get
    carried forward, a hand pixel that matched in the last two frames
    does). The raw measurements are what is kept, not the filtered output,
    so nothing feeds back. ``length <= 1`` passes frames through. Three
    frames (the default) cost about 3 ms at 480x360 on a laptop; longer
    histories take a sort per pixel and several times that.
    """

    def __init__(self, length: int, tolerance_mm: Callable[[np.ndarray], np.ndarray] | float, majority: bool = False, min_fill_samples: int = 2) -> None:
        self.length = max(1, int(length))
        self.tolerance_mm = tolerance_mm
        self.majority = bool(majority)
        self.min_fill_samples = max(1, int(min_fill_samples))
        self.fast = True  # three frames without the majority rule take the OpenCV path (:meth:`_push3`); off for checking it against the general one
        self.history: list[np.ndarray] = []

    def reset(self) -> None:
        self.history.clear()

    def _tolerance(self, depth: np.ndarray) -> np.ndarray:
        t = self.tolerance_mm(depth) if callable(self.tolerance_mm) else float(self.tolerance_mm)
        return np.asarray(t, dtype=np.float32)

    def push(self, depth: np.ndarray) -> np.ndarray:
        """Add the newest measurement and return the filtered depth (``uint16``; the input itself while warming up)."""
        if self.history and self.history[0].shape != depth.shape:
            self.reset()
        self.history.append(depth.astype(np.float32))
        if len(self.history) > self.length:
            del self.history[0]
        if len(self.history) < 2:
            return depth
        if len(self.history) == 3 and not self.majority and self.fast:
            return self._push3(*self.history[::-1])
        samples = np.stack(self.history[::-1])  # newest first
        valid = samples > 0
        newest = samples[0]
        # Reference per pixel: the newest measurement, else the most recent older one.
        reference = newest.copy()
        have = valid[0].copy()
        for i in range(1, len(samples)):
            take = ~have & valid[i]
            reference[take] = samples[i][take]
            have |= take
        tol = self._tolerance(reference)
        agree = valid & (np.abs(samples - reference[None]) <= tol[None])
        count = agree.sum(axis=0)
        if self.min_fill_samples > 1:
            unconfirmed = ~valid[0] & (count < self.min_fill_samples)
            agree[:, unconfirmed] = False
            count[unconfirmed] = 0
        if self.majority and len(samples) >= 3:
            lone = valid[0] & (count == 1)
            if lone.any():
                # The older sample that most of the other older samples agree with, if at least one does.
                best_count = np.zeros(newest.shape, dtype=np.int32)
                best_ref = np.zeros(newest.shape, dtype=np.float32)
                for i in range(1, len(samples)):
                    tol_i = self._tolerance(samples[i])
                    with_i = (valid[1:] & (np.abs(samples[1:] - samples[i][None]) <= tol_i[None])).sum(axis=0)
                    with_i = np.where(valid[i], with_i, 0)
                    better = with_i > best_count
                    best_count = np.where(better, with_i, best_count)
                    best_ref = np.where(better, samples[i], best_ref)
                outvoted = lone & (best_count >= 2)
                if outvoted.any():
                    reference = np.where(outvoted, best_ref, reference)
                    tol = self._tolerance(reference)
                    agree = valid & (np.abs(samples - reference[None]) <= tol[None])
                    agree[0] &= ~outvoted
                    count = agree.sum(axis=0)
        if len(samples) == 2:
            a, b = np.where(agree[0], samples[0], 0.0), np.where(agree[1], samples[1], 0.0)
            median = np.where(count > 0, (a + b) / np.maximum(count, 1), 0.0)
        else:
            ordered = np.sort(np.where(agree, samples, np.inf), axis=0)  # agreeing samples first, ascending
            lo = np.take_along_axis(ordered, np.maximum(count - 1, 0)[None] // 2, axis=0)[0]
            hi = np.take_along_axis(ordered, np.maximum(count - 1, 0)[None] - np.maximum(count - 1, 0)[None] // 2, axis=0)[0]
            median = np.where(count > 0, 0.5 * (lo + hi), 0.0)
        return np.clip(np.rint(median), 0, 65535).astype(np.uint16)

    def _push3(self, n: np.ndarray, o1: np.ndarray, o2: np.ndarray) -> np.ndarray:
        """The three-frame case with OpenCV primitives (a few milliseconds instead of a sort per pixel); same rules as :meth:`push`."""
        gt = cv2.CMP_GT
        vn, v1, v2 = cv2.compare(n, 0.0, gt), cv2.compare(o1, 0.0, gt), cv2.compare(o2, 0.0, gt)
        reference = o2.copy()
        cv2.copyTo(o1, v1, reference)
        cv2.copyTo(n, vn, reference)  # newest where valid, else the most recent valid older sample
        tol = self._tolerance(reference)
        a1 = cv2.bitwise_and(v1, cv2.compare(cv2.absdiff(o1, reference), tol, cv2.CMP_LE))
        a2 = cv2.bitwise_and(v2, cv2.compare(cv2.absdiff(o2, reference), tol, cv2.CMP_LE))
        count = cv2.add(cv2.add(cv2.bitwise_and(vn, 1), cv2.bitwise_and(a1, 1)), cv2.bitwise_and(a2, 1))  # uint8 0..3
        if self.min_fill_samples > 1:
            confirmed = cv2.bitwise_or(vn, cv2.compare(count, self.min_fill_samples, cv2.CMP_GE))
            a1, a2 = cv2.bitwise_and(a1, confirmed), cv2.bitwise_and(a2, confirmed)
            count = cv2.bitwise_and(count, confirmed)
        total = cv2.add(cv2.add(cv2.copyTo(n, vn), cv2.copyTo(o1, a1)), cv2.copyTo(o2, a2))
        median = cv2.divide(total, cv2.max(count.astype(np.float32), 1.0))  # the mean of one or two agreeing samples (0 where none)
        mid3 = cv2.max(cv2.min(n, o1), cv2.min(cv2.max(n, o1), o2))
        cv2.copyTo(mid3, cv2.compare(count, 3, cv2.CMP_EQ), median)  # the middle of three
        return cv2.add(median, 0.5).astype(np.uint16)


def depth_statistics(depth: np.ndarray, near_mm: float, far_mm: float, window: int = 5, close: int = 7) -> dict[str, float]:
    """How good the measurement is: ``depthNoiseMm`` and ``depthValidFraction`` of a depth map's foreground.

    The foreground is what lies within ``[near_mm, far_mm]``; its hull is
    that mask closed with a ``close x close`` ellipse (small holes and
    speckle gaps closed, the gaps between spread fingers not), and
    ``depthValidFraction`` is the share of the hull that carries an in-range
    measurement: 1 for a solid scan, well below for a hand full of holes.
    ``depthNoiseMm`` is the median, over the foreground, of the standard
    deviation of the in-range depth in a ``window x window`` box (only boxes
    at least 60 % filled count, so silhouettes and hole edges do not
    inflate it): 5-10 mm for a hand at 30 cm on the controller, 20 and more
    when the scan has turned to noise. Both are 0 when nothing is in range.
    """
    inbox = cv2.inRange(depth, np.array([near_mm], dtype=np.float64), np.array([far_mm], dtype=np.float64))  # uint8 0/255
    n = cv2.countNonZero(inbox)
    if n < window * window:
        return {"depthNoiseMm": 0.0, "depthValidFraction": 0.0}
    x, y, w, h = cv2.boundingRect(inbox)  # the foreground's box, with a margin for the filters
    pad = max(window, close)
    x0, y0, x1, y1 = max(x - pad, 0), max(y - pad, 0), min(x + w + pad, depth.shape[1]), min(y + h + pad, depth.shape[0])
    inbox = inbox[y0:y1, x0:x1]
    hull = cv2.morphologyEx(inbox, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (close, close)))
    valid_fraction = n / max(cv2.countNonZero(hull), 1)
    d = cv2.copyTo(depth[y0:y1, x0:x1].astype(np.float32), inbox)
    k = (window, window)
    den = cv2.boxFilter(inbox, cv2.CV_32F, k, normalize=False, borderType=cv2.BORDER_CONSTANT)  # 255 per in-range pixel
    num = cv2.boxFilter(d, -1, k, normalize=False, borderType=cv2.BORDER_CONSTANT)
    sq = cv2.boxFilter(cv2.multiply(d, d), -1, k, normalize=False, borderType=cv2.BORDER_CONSTANT)
    safe = cv2.max(den, 1.0)
    mean = cv2.divide(num, safe, scale=255.0)
    var = cv2.subtract(cv2.divide(sq, safe, scale=255.0), cv2.multiply(mean, mean))
    std = cv2.sqrt(cv2.max(var, 0.0))
    full = cv2.bitwise_and(inbox, cv2.compare(den, 0.6 * window * window * 255.0, cv2.CMP_GE))
    values = std[::2, ::2][full[::2, ::2] > 0]  # every other pixel is plenty for a median
    noise = float(np.median(values)) if values.size else 0.0
    return {"depthNoiseMm": round(noise, 2), "depthValidFraction": round(float(valid_fraction), 4)}


@dataclass(frozen=True)
class StereoParams:
    """Matcher tuning. ``min_depth_mm`` sets the disparity search range
    (``numDisparities = ceil((baseline * f / min_depth + 8) / 16) * 16``, the
    margin keeping the near plane away from the saturating end of the
    search); pass the box's near plane. Anything nearer than the range
    matches at the largest disparity, so disparities within a pixel of it
    are discarded rather than reported as a wrong depth.
    Four rules invalidate pixels of the reference image after matching, each
    off at its neutral value. ``min_intensity`` drops pixels darker than that
    (0..255): the controller's IR LEDs light what is near and leave the room
    dark, and a matcher fed near-black texture invents disparities.
    ``max_intensity`` drops pixels at or above it (255 = off): a hand held
    close to the LEDs saturates to pure white and matches anywhere.
    ``min_lit`` is the same idea made depth-aware (0 = off): the LEDs fall off
    with the square of the distance, so a surface that claims depth ``Z``
    must be at least ``min_lit * (lit_reference_mm / Z)^2`` bright somewhere
    in its ``lit_window`` neighbourhood; a real hand is 65-90 at 300 mm on
    the controller measured here, a dark wall that the matcher placed at
    250 mm is 20-40 and fails, while a dim hand at 450 mm (the same wall's
    brightness, but consistent with its depth) passes.
    ``min_texture`` drops pixels whose ``texture_window`` x ``texture_window``
    neighbourhood spans fewer than that many grey levels (0 = off, the
    default: skin at 2-3 px per degree is as smooth as the walls, so on the
    real frames this rule hollows the hand before it removes the phantoms;
    it is kept for rooms where the walls are the only flat thing). The
    matcher's own confidence rules stay on: ``uniqueness`` (percent margin
    the best disparity must win by) and ``disp12_max_diff`` (left-right
    consistency in pixels; -1 = off). ``median`` (0, 3 or 5) median-filters
    the disparity; the speckle filter drops connected patches smaller than
    ``speckle_window`` pixels whose disparity varies by more than
    ``speckle_range`` (scale the window with the view's pixel count).
    ``matcher`` is ``"sgbm"`` (default) or ``"bm"`` (block matching: faster,
    noisier); ``mode`` picks the SGBM path aggregation (``"3way"``, the
    default, is the parallel three-direction pass and 3-4x faster than
    ``"sgbm"``, 5 directions, for the same hand; ``"hh4"`` is a single
    four-direction pass, ``"hh"`` 8 directions and slower still). ``p1``
    and ``p2`` are SGBM's smoothness penalties per block pixel (``P1 = p1 *
    block^2`` for a one-pixel disparity change, ``P2 = p2 * block^2`` for
    more; OpenCV's usual 8 and 32).

    Distance (a hand 35-55 cm up is dim, small and matched on a few raw
    rows; see the README's tuning table): ``contrast`` conditions the pair
    before matching (:func:`normalize_intensity`, ``"gain"`` over a
    ``contrast_window`` box, floor ``contrast_floor``; the invalidation
    rules keep reading the original image); ``fill_radius`` fills holes up
    to about twice that wide from agreeing neighbours after matching
    (:func:`fill_holes`, spread tolerance ``fill_tolerance_px`` disparity
    pixels at the local depth; 0 = off); ``temporal`` is the length of the
    per-pixel agreeing median over frames (:class:`TemporalDepthFilter`,
    tolerance ``temporal_tolerance_px``; 0 or 1 = off), which the source
    applies since it is stateful.
    """

    min_depth_mm: float = 100.0
    max_depth_mm: float = 65535.0
    min_intensity: int = 16
    max_intensity: int = 250
    min_lit: int = 20
    lit_reference_mm: float = 300.0
    lit_window: int = 5
    min_texture: int = 0
    texture_window: int = 7
    block_size: int = 5
    uniqueness: int = 15
    speckle_window: int = 200
    speckle_range: int = 2
    disp12_max_diff: int = 1
    prefilter_cap: int = 31
    median: int = 5
    matcher: str = "sgbm"
    mode: str = "3way"
    p1: int = 8
    p2: int = 32
    contrast: str = "none"
    contrast_window: int = 31
    contrast_floor: float = 24.0
    fill_radius: int = 2
    fill_tolerance_px: float = 1.5
    temporal: int = 3
    temporal_tolerance_px: float = 1.5

    def __post_init__(self) -> None:
        if not (0 < self.min_depth_mm < self.max_depth_mm):
            raise ValueError("need 0 < min_depth_mm < max_depth_mm")
        if self.p1 < 0 or self.p2 < self.p1:
            raise ValueError("need 0 <= p1 <= p2")
        if self.contrast not in CONTRAST_MODES:
            raise ValueError(f"contrast must be one of {CONTRAST_MODES}")
        if self.contrast_window < 3 or self.contrast_window % 2 == 0:
            raise ValueError("contrast_window must be odd and at least 3")
        if self.fill_radius < 0 or self.temporal < 0:
            raise ValueError("fill_radius and temporal must not be negative")
        if not (self.fill_tolerance_px > 0 and self.temporal_tolerance_px > 0):
            raise ValueError("tolerances must be positive")
        if not (0 <= self.min_intensity <= 255):
            raise ValueError("min_intensity must be 0..255")
        if not (self.min_intensity < self.max_intensity <= 255):
            raise ValueError("max_intensity must be above min_intensity and at most 255")
        if not (0 <= self.min_lit <= 255) or not (self.lit_reference_mm > 0):
            raise ValueError("min_lit must be 0..255 at a positive reference depth")
        if self.lit_window < 1 or self.lit_window % 2 == 0:
            raise ValueError("lit_window must be odd and positive")
        if not (0 <= self.min_texture <= 255):
            raise ValueError("min_texture must be 0..255")
        if self.texture_window < 3 or self.texture_window % 2 == 0:
            raise ValueError("texture_window must be odd and at least 3")
        if self.block_size < 1 or self.block_size % 2 == 0:
            raise ValueError("block_size must be odd and positive")
        if not (0 <= self.uniqueness <= 100):
            raise ValueError("uniqueness must be 0..100 (percent)")
        if self.median not in (0, 3, 5):
            raise ValueError("median must be 0, 3 or 5")
        if self.matcher not in ("sgbm", "bm"):
            raise ValueError("matcher must be 'sgbm' or 'bm'")
        if self.mode not in ("sgbm", "hh", "hh4", "3way"):
            raise ValueError("mode must be 'sgbm', 'hh', 'hh4' or '3way'")

    def invalid_pixels(self, reference: np.ndarray) -> np.ndarray | None:
        """Boolean mask of the reference-image pixels the intensity and texture rules reject, or ``None`` when every rule is off."""
        masks = []
        if self.min_intensity > 0:
            masks.append(reference < self.min_intensity)
        if self.max_intensity < 255:
            masks.append(reference >= self.max_intensity)
        if self.min_texture > 0:
            masks.append(local_range(reference, self.texture_window) < self.min_texture)
        if not masks:
            return None
        out = masks[0]
        for m in masks[1:]:
            out |= m
        return out

    def underlit_pixels(self, reference: np.ndarray, depth_mm: np.ndarray) -> np.ndarray | None:
        """Boolean mask of measured pixels too dark for the depth they claim (the ``min_lit`` rule), or ``None`` when it is off.

        Brightness is the maximum over a ``lit_window`` neighbourhood, so a
        dark pore or grain inside a lit hand does not count as unlit; a
        phantom region is dark throughout and still fails.
        """
        if self.min_lit <= 0:
            return None
        z = depth_mm.astype(np.float32)
        needed = self.min_lit * (self.lit_reference_mm / np.maximum(z, 1.0)) ** 2
        brightest = cv2.dilate(reference, np.ones((self.lit_window, self.lit_window), dtype=np.uint8))
        return (z > 0) & (brightest.astype(np.float32) < needed)


class StereoDepth:
    """Rectified pair -> ``uint16`` depth in millimetres (0 = no match).

    ``swap=True`` exchanges the two images before matching, for a device whose
    "left" camera turns out to sit at +x (disparities come out negative and
    the depth image is empty until swapped; ``leap_source.py --dump-images``
    reports which order matches).
    """

    def __init__(self, baseline_mm: float, focal_px: float, params: StereoParams | None = None, swap: bool = False) -> None:
        if not (baseline_mm > 0 and focal_px > 0):
            raise ValueError("baseline and focal length must be positive")
        self.baseline_mm, self.focal_px = float(baseline_mm), float(focal_px)
        self.params = params or StereoParams()
        self.swap = bool(swap)
        self.num_disparities = max(16, int(math.ceil((self.baseline_mm * self.focal_px / self.params.min_depth_mm + 8.0) / 16.0)) * 16)
        p = self.params
        use_bm = p.matcher == "bm" or not hasattr(cv2, "StereoSGBM_create")
        if use_bm:
            block = max(5, p.block_size | 1)
            matcher = cv2.StereoBM_create(numDisparities=self.num_disparities, blockSize=block)
            matcher.setUniquenessRatio(p.uniqueness)
            matcher.setSpeckleWindowSize(p.speckle_window)
            matcher.setSpeckleRange(p.speckle_range)
            matcher.setDisp12MaxDiff(p.disp12_max_diff)
            matcher.setPreFilterCap(p.prefilter_cap)
            self.matcher_name = "bm"
        else:
            modes = {"sgbm": cv2.STEREO_SGBM_MODE_SGBM, "hh": cv2.STEREO_SGBM_MODE_HH, "3way": cv2.STEREO_SGBM_MODE_SGBM_3WAY,
                     "hh4": getattr(cv2, "STEREO_SGBM_MODE_HH4", cv2.STEREO_SGBM_MODE_SGBM)}
            block = p.block_size
            matcher = cv2.StereoSGBM_create(
                minDisparity=0, numDisparities=self.num_disparities, blockSize=block,
                P1=p.p1 * block * block, P2=p.p2 * block * block, disp12MaxDiff=p.disp12_max_diff,
                preFilterCap=p.prefilter_cap, uniquenessRatio=p.uniqueness,
                speckleWindowSize=p.speckle_window, speckleRange=p.speckle_range, mode=modes[p.mode],
            )
            self.matcher_name = "sgbm"
        self.matcher = matcher

    @property
    def max_depth_mm(self) -> float:
        return self.params.max_depth_mm

    def depth_step_mm(self, depth_mm: float) -> float:
        """Depth change per whole pixel of disparity at ``depth_mm`` (the matcher resolves 1/16 of that)."""
        return depth_mm * depth_mm / (self.baseline_mm * self.focal_px)

    def tolerance_mm(self, pixels: float) -> Callable[[np.ndarray], np.ndarray]:
        """``depth -> pixels * depth_step(depth)``, the millimetre tolerance worth ``pixels`` of disparity at every depth (arrays)."""
        scale = float(pixels) / (self.baseline_mm * self.focal_px)

        def tolerance(depth_mm: np.ndarray) -> np.ndarray:
            z = np.asarray(depth_mm, dtype=np.float32)
            return scale * z * z

        return tolerance

    def temporal_filter(self) -> "TemporalDepthFilter | None":
        """A :class:`TemporalDepthFilter` sized by ``params.temporal`` and its tolerance, or ``None`` when it is off."""
        if self.params.temporal <= 1:
            return None
        return TemporalDepthFilter(self.params.temporal, self.tolerance_mm(self.params.temporal_tolerance_px))

    def condition(self, image: np.ndarray) -> np.ndarray:
        """The image as the matcher sees it (:func:`normalize_intensity` under ``params.contrast``)."""
        p = self.params
        return normalize_intensity(image, p.contrast, p.contrast_window, p.contrast_floor)

    def disparity(self, left: np.ndarray, right: np.ndarray) -> np.ndarray:
        """Disparity in rectified pixels as ``float32``; ``<= 0`` means no match."""
        if left.shape != right.shape:
            raise ValueError(f"stereo images differ in shape: {left.shape} vs {right.shape}")
        if left.dtype != np.uint8:
            left = np.clip(left, 0, 255).astype(np.uint8)
        if right.dtype != np.uint8:
            right = np.clip(right, 0, 255).astype(np.uint8)
        if self.swap:
            left, right = right, left
        raw = self.matcher.compute(self.condition(left), self.condition(right))  # int16, 16x fixed point, invalid = -16
        disp = raw.astype(np.float32) / 16.0
        if self.params.median in (3, 5):
            disp = cv2.medianBlur(disp, self.params.median)
        disp[disp > self.num_disparities - 1.5] = -1.0  # saturated: nearer than the search range, depth unknown
        rejected = self.params.invalid_pixels(left)  # too dark, saturated or featureless in the ORIGINAL reference image
        if rejected is not None:
            disp[rejected] = -1.0
        return disp

    def depth_from_disparity(self, disp: np.ndarray) -> np.ndarray:
        """``Z = baseline * f / d`` as ``uint16`` millimetres; invalid or out-of-range disparities read 0."""
        valid = disp > 0
        depth = np.zeros(disp.shape, dtype=np.float32)
        np.divide(self.baseline_mm * self.focal_px, disp, out=depth, where=valid)
        depth[(depth > self.params.max_depth_mm) | (depth > 65535.0)] = 0.0
        return np.ascontiguousarray(np.rint(depth), dtype=np.uint16)

    def compute(self, left: np.ndarray, right: np.ndarray) -> np.ndarray:
        """Depth in millimetres (``uint16``, 0 = none) with every invalidation rule applied, including the depth-aware ``min_lit``, then the hole filler."""
        depth = self.depth_from_disparity(self.disparity(left, right))
        reference = right if self.swap else left
        if reference.dtype != np.uint8:
            reference = np.clip(reference, 0, 255).astype(np.uint8)
        underlit = self.params.underlit_pixels(reference, depth)
        if underlit is not None:
            depth[underlit] = 0
        if self.params.fill_radius > 0:
            rejected = self.params.invalid_pixels(reference)  # the rules' rejections stay empty: the filler only fills what the matcher left
            if underlit is not None:
                rejected = underlit if rejected is None else (rejected | underlit)
            depth = fill_holes(depth, self.params.fill_radius, self.tolerance_mm(self.params.fill_tolerance_px), exclude=rejected)
        return depth

    def valid_fraction(self, left: np.ndarray, right: np.ndarray) -> float:
        """Fraction of pixels the matcher could place; used to detect a swapped pair."""
        return float((self.disparity(left, right) > 0).mean())


# --------------------------------------------------------------------------- #
# Reorientation
# --------------------------------------------------------------------------- #

ORIENTATIONS = ("none", "rot90", "rot180", "rot270", "flip-h", "flip-v", "transpose")


def reorient(image: np.ndarray, orientation: str = "none") -> np.ndarray:
    """Rotate or flip an image so the browser's "image right / image down" means what you want.

    ``rot90`` turns the image a quarter turn clockwise (the old left edge
    becomes the top), ``rot270`` counter-clockwise, ``rot180`` upside down;
    ``flip-h`` mirrors left-right, ``flip-v`` top-bottom, ``transpose`` swaps
    the axes (rows become columns). The result is C-contiguous.
    """
    if orientation == "none":
        return image
    if orientation == "rot90":
        out = np.rot90(image, k=-1)
    elif orientation == "rot180":
        out = np.rot90(image, k=2)
    elif orientation == "rot270":
        out = np.rot90(image, k=1)
    elif orientation == "flip-h":
        out = image[:, ::-1]
    elif orientation == "flip-v":
        out = image[::-1, :]
    elif orientation == "transpose":
        out = image.T
    else:
        raise ValueError(f"unknown orientation {orientation!r}; choose one of {ORIENTATIONS}")
    return np.ascontiguousarray(out)


def reorient_points(u: np.ndarray | float, v: np.ndarray | float, width: int, height: int, orientation: str = "none") -> tuple[np.ndarray, np.ndarray]:
    """Continuous pixel coordinates through the same transform :func:`reorient` applies to the image.

    ``u``/``v`` are column/row with integer values at pixel centres (the
    convention of :meth:`RectifiedView.ray_to_pixel`) and ``width``/``height``
    the image size BEFORE reorientation. Each mode is affine, so points past
    the image edge move consistently with the pixels: a projected skeleton
    stays on top of the reoriented scan wherever it is. Used to keep hand
    joints aligned with a depth image that ``--leap-orient`` has turned.
    """
    u = np.asarray(u, dtype=np.float64)
    v = np.asarray(v, dtype=np.float64)
    last_col, last_row = float(width - 1), float(height - 1)
    if orientation == "none":
        return u, v
    if orientation == "rot90":
        return last_row - v, u
    if orientation == "rot180":
        return last_col - u, last_row - v
    if orientation == "rot270":
        return v, last_col - u
    if orientation == "flip-h":
        return last_col - u, v
    if orientation == "flip-v":
        return u, last_row - v
    if orientation == "transpose":
        return v, u
    raise ValueError(f"unknown orientation {orientation!r}; choose one of {ORIENTATIONS}")


def reorient_intrinsics(fx: float, fy: float, cx: float, cy: float, width: int, height: int, orientation: str = "none") -> tuple[float, float, float, float]:
    """The pinhole intrinsics ``(fx, fy, cx, cy)`` of an image after :func:`reorient` turned it.

    ``cx``/``cy`` are the principal point in edge coordinates (pixel ``i``
    spans ``[i, i + 1)``, so pixel index ``i`` has its centre at ``i + 0.5``:
    the convention of :class:`RectifiedView`, whose ``cx`` is ``width / 2``).
    A rotation or flip is a rigid move of the image plane, so the camera stays
    a pinhole: the focal lengths follow the axes they land on and the
    principal point is mirrored where an axis is reversed. Metric coordinates
    ``X = (u + 0.5 - cx) * depth / fx`` (across) and ``V = (v + 0.5 - cy) *
    depth / fy`` (down) computed with the result therefore describe the same
    physical point as before, expressed in the turned image's axes: ``rot90``
    gives ``(-V, X)``, ``flip-h`` gives ``(-X, V)``, ``transpose`` ``(V, X)``.
    """
    w, h = float(width), float(height)
    if orientation == "none":
        return fx, fy, cx, cy
    if orientation == "rot90":
        return fy, fx, h - cy, cx
    if orientation == "rot180":
        return fx, fy, w - cx, h - cy
    if orientation == "rot270":
        return fy, fx, cy, w - cx
    if orientation == "flip-h":
        return fx, fy, w - cx, cy
    if orientation == "flip-v":
        return fx, fy, cx, h - cy
    if orientation == "transpose":
        return fy, fx, cy, cx
    raise ValueError(f"unknown orientation {orientation!r}; choose one of {ORIENTATIONS}")


# --------------------------------------------------------------------------- #
# Synthetic stereo: a stand-in raw camera and a ray-cast scene with known depth
# --------------------------------------------------------------------------- #


@dataclass(frozen=True)
class FisheyeModel:
    """Equidistant-fisheye stand-in for the Leap's raw cameras and calibration.

    A ray at angle ``theta`` from the optical axis lands ``focal_px * theta``
    pixels from the principal point, with rows squashed by ``y_scale`` (the
    controller streams 640x240 frames whose pixels are twice as tall as wide).
    Each camera has its own principal point so that the rectifier's
    per-camera maps matter: with the default 4-pixel offset, matching the raw
    images directly would be biased by four pixels of disparity.
    """

    width: int = 640
    height: int = 240
    focal_px: float = 280.0
    y_scale: float = 0.5
    principal_left: tuple[float, float] = (319.5, 119.5)
    principal_right: tuple[float, float] = (323.5, 118.0)

    def principal(self, camera: int) -> tuple[float, float]:
        if camera == CAMERA_LEFT:
            return self.principal_left
        if camera == CAMERA_RIGHT:
            return self.principal_right
        raise ValueError(f"unknown camera {camera}")

    def ray_to_pixel(self, camera: int, tx: np.ndarray | float, ty: np.ndarray | float) -> tuple[np.ndarray, np.ndarray]:
        """``LeapRectilinearToPixel`` semantics; scalars or arrays."""
        cx, cy = self.principal(camera)
        tx, ty = np.asarray(tx, dtype=np.float64), np.asarray(ty, dtype=np.float64)
        r = np.hypot(tx, ty)
        safe = np.where(r > 0, r, 1.0)
        scale = np.where(r > 0, self.focal_px * np.arctan(r) / safe, self.focal_px)
        return cx + scale * tx, cy + scale * ty * self.y_scale

    def pixel_to_ray(self, camera: int, px: np.ndarray | float, py: np.ndarray | float) -> tuple[np.ndarray, np.ndarray]:
        """Inverse of :meth:`ray_to_pixel` (rays beyond 86 deg off-axis are clamped)."""
        cx, cy = self.principal(camera)
        dx = (np.asarray(px, dtype=np.float64) - cx) / self.focal_px
        dy = (np.asarray(py, dtype=np.float64) - cy) / (self.focal_px * self.y_scale)
        theta = np.minimum(np.hypot(dx, dy), 1.5)
        safe = np.where(theta > 0, theta, 1.0)
        k = np.where(theta > 0, np.tan(theta) / safe, 1.0)
        return k * dx, k * dy


@dataclass(frozen=True)
class Sphere:
    """Centre ``(x, y, z)`` in millimetres of the stereo frame (x along the baseline, z = height above the device)."""

    centre: tuple[float, float, float]
    radius: float

    def bounding_sphere(self) -> tuple[np.ndarray, float]:
        return np.asarray(self.centre, dtype=np.float64), float(self.radius)


@dataclass(frozen=True)
class Capsule:
    """A tube with round ends from ``a`` to ``b`` (a forearm)."""

    a: tuple[float, float, float]
    b: tuple[float, float, float]
    radius: float

    def bounding_sphere(self) -> tuple[np.ndarray, float]:
        a, b = np.asarray(self.a, dtype=np.float64), np.asarray(self.b, dtype=np.float64)
        return (a + b) / 2.0, float(np.linalg.norm(b - a) / 2.0 + self.radius)


def _hit_sphere(o: np.ndarray, d: np.ndarray, centre: np.ndarray, radius: float) -> tuple[np.ndarray, np.ndarray]:
    """Entry parameter ``t`` of rays ``o + t d`` (``d`` of shape ``(k, 3)``) into a ball, and which rays enter it."""
    oc = o - centre
    a = (d * d).sum(axis=-1)
    b = 2.0 * (d @ oc)
    c = float(oc @ oc) - radius * radius
    disc = b * b - 4.0 * a * c
    hit = disc > 0
    t = (-b - np.sqrt(np.maximum(disc, 0.0))) / (2.0 * a)
    return t, hit & (t > 1e-6)


def _hit_capsule(o: np.ndarray, d: np.ndarray, a_pt: np.ndarray, b_pt: np.ndarray, radius: float) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Entry ``t``, hit mask and surface normals for a capsule: the union of a finite cylinder and two balls."""
    axis = b_pt - a_pt
    length = float(np.linalg.norm(axis))
    n = axis / length
    oa = o - a_pt
    on = float(oa @ n)
    dn = d @ n
    d_perp = d - dn[:, None] * n
    oa_perp = oa - on * n
    A = (d_perp * d_perp).sum(axis=-1)
    B = 2.0 * (d_perp @ oa_perp)
    C = float(oa_perp @ oa_perp) - radius * radius
    disc = B * B - 4.0 * A * C
    safe_a = np.where(A > 1e-12, A, 1e-12)
    t_cyl = (-B - np.sqrt(np.maximum(disc, 0.0))) / (2.0 * safe_a)
    s = on + t_cyl * dn
    ok_cyl = (disc > 0) & (A > 1e-12) & (t_cyl > 1e-6) & (s >= 0.0) & (s <= length)
    t_a, ok_a = _hit_sphere(o, d, a_pt, radius)
    t_b, ok_b = _hit_sphere(o, d, b_pt, radius)
    candidates = np.stack([np.where(ok_cyl, t_cyl, np.inf), np.where(ok_a, t_a, np.inf), np.where(ok_b, t_b, np.inf)])
    which = candidates.argmin(axis=0)
    t = candidates[which, np.arange(len(d))]
    hit = np.isfinite(t)
    p = o + np.where(hit, t, 0.0)[:, None] * d
    foot = a_pt + np.clip((p - a_pt) @ n, 0.0, length)[:, None] * n  # nearest point on the segment
    normals = (p - foot) / radius
    return t, hit, normals


@functools.lru_cache(maxsize=8)
def _view_dirs(view: RectifiedView) -> np.ndarray:
    """Ray ``(tx, ty, 1)`` through every pixel centre of a rectified view, shape ``(height, width, 3)`` (read-only)."""
    u, v = np.meshgrid(np.arange(view.width), np.arange(view.height))
    tx, ty = view.pixel_to_ray(u, v)
    dirs = np.stack([tx, ty, np.ones_like(tx)], axis=-1)
    dirs.setflags(write=False)
    return dirs


@functools.lru_cache(maxsize=8)
def _raw_dirs(model: FisheyeModel, camera: int) -> np.ndarray:
    """Ray through every pixel of the stand-in raw camera, shape ``(height, width, 3)`` (read-only)."""
    px, py = np.meshgrid(np.arange(model.width), np.arange(model.height))
    tx, ty = model.pixel_to_ray(camera, px, py)
    dirs = np.stack([tx, ty, np.ones_like(tx)], axis=-1)
    dirs.setflags(write=False)
    return dirs


def _hash01(ix: np.ndarray, iy: np.ndarray, iz: np.ndarray) -> np.ndarray:
    """Deterministic pseudo-random value in [0, 1) per integer lattice cell."""
    def u32(a: np.ndarray) -> np.ndarray:
        return (a.astype(np.int64) & 0xFFFFFFFF).astype(np.uint32)
    with np.errstate(over="ignore"):
        h = (u32(ix) * np.uint32(73856093)) ^ (u32(iy) * np.uint32(19349663)) ^ (u32(iz) * np.uint32(83492791))
        h ^= h >> np.uint32(13)
        h *= np.uint32(0x5BD1E995)
        h ^= h >> np.uint32(15)
    return (h & np.uint32(0xFFFFFF)).astype(np.float64) / float(0x1000000)


class SyntheticStereoScene:
    """Spheres and capsules above the device, ray-cast into either camera with known depth.

    The two cameras sit at ``x = -+baseline / 2``, look along +z and share
    every other parameter, so a scene point seen by both has disparity
    ``baseline * f / Z`` in a :class:`RectifiedView` exactly. Surfaces carry a
    view-independent albedo (a smooth pattern plus grain hashed from the 3D
    position, quantised to ``texture_mm`` cells) so the matcher has something
    to lock onto, are lit from the device (``lambert * min(1, (falloff / dist)^2)``
    like the controller's IR LEDs) and get a little sensor noise. An optional
    flat ``background_mm`` plane (a ceiling) fills the rest of the view.
    """

    def __init__(
        self, shapes: Sequence[Sphere | Capsule], baseline_mm: float = CONTROLLER_BASELINE_MM,
        background_mm: float | None = 1200.0, texture_mm: float = 4.0, falloff_mm: float = 220.0,
        noise: float = 1.5, seed: int = 0,
    ) -> None:
        self.shapes: list[Sphere | Capsule] = list(shapes)
        self.baseline_mm = float(baseline_mm)
        self.background_mm = background_mm
        self.texture_mm, self.falloff_mm, self.noise = float(texture_mm), float(falloff_mm), float(noise)
        self.seed = seed

    def camera_origin(self, camera: int) -> np.ndarray:
        if camera == CAMERA_LEFT:
            return np.array([-self.baseline_mm / 2.0, 0.0, 0.0])
        if camera == CAMERA_RIGHT:
            return np.array([self.baseline_mm / 2.0, 0.0, 0.0])
        raise ValueError(f"unknown camera {camera}")

    @property
    def _background_key(self) -> tuple[float, float | None, float, float, float, int]:
        return (self.baseline_mm, self.background_mm, self.texture_mm, self.falloff_mm, self.noise, self.seed)

    def raycast(self, origin: np.ndarray, dirs: np.ndarray, shapes_only: bool = False) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        """Nearest hit along each ray: ``(Z, points, normals)``, ``Z`` = depth along +z (0 = nothing hit).

        Each shape is only tested against the rays inside its bounding cone
        (the cone from the camera around its bounding sphere), so the cost is
        a dot product per pixel per shape plus the intersection maths on the
        few pixels that can see it. ``shapes_only`` skips the background plane.
        """
        o = np.asarray(origin, dtype=np.float64)
        d = np.asarray(dirs, dtype=np.float64).reshape(-1, 3)
        count = d.shape[0]
        best_t = np.full(count, np.inf)
        best_n = np.zeros((count, 3))
        inv_norm = 1.0 / np.linalg.norm(d, axis=-1)
        for shape in self.shapes:
            centre, radius = shape.bounding_sphere()
            to_centre = centre - o
            dist = float(np.linalg.norm(to_centre))
            if dist > radius * 1.001:
                cos_cone = math.sqrt(1.0 - (radius / dist) ** 2) * 0.999
                idx = np.flatnonzero((d @ (to_centre / dist)) * inv_norm >= cos_cone)
            else:
                idx = np.arange(count)
            if idx.size == 0:
                continue
            sub = d[idx]
            if isinstance(shape, Sphere):
                t, hit = _hit_sphere(o, sub, centre, shape.radius)
                normals = (o + t[:, None] * sub - centre) / shape.radius
            else:
                t, hit, normals = _hit_capsule(o, sub, np.asarray(shape.a, dtype=np.float64), np.asarray(shape.b, dtype=np.float64), shape.radius)
            closer = hit & (t < best_t[idx])
            if not closer.any():
                continue
            chosen = idx[closer]
            best_t[chosen] = t[closer]
            best_n[chosen] = normals[closer]
        if self.background_mm is not None and not shapes_only:
            dz = d[:, 2]
            with np.errstate(divide="ignore", invalid="ignore"):
                t_bg = np.where(dz > 1e-9, (self.background_mm - o[2]) / dz, np.inf)
            closer = t_bg < best_t
            best_t[closer] = t_bg[closer]
            best_n[closer] = (0.0, 0.0, -1.0)
        hit = np.isfinite(best_t)
        t = np.where(hit, best_t, 0.0)
        points = o + t[:, None] * d
        z = np.where(hit, t * d[:, 2], 0.0)
        shape_out = np.asarray(dirs).shape[:-1]
        return z.reshape(shape_out), points.reshape(*shape_out, 3), best_n.reshape(*shape_out, 3)

    def albedo(self, points: np.ndarray) -> np.ndarray:
        x, y, z = points[..., 0], points[..., 1], points[..., 2]
        smooth = 0.55 + 0.15 * np.sin(0.09 * x + 0.5) * np.cos(0.11 * y) + 0.1 * np.sin(0.07 * z + 0.13 * x)
        cells = np.floor(points / self.texture_mm)
        grain = _hash01(cells[..., 0], cells[..., 1], cells[..., 2]) - 0.5
        return np.clip(smooth + 0.4 * grain, 0.05, 1.0)

    def shade(self, origin: np.ndarray, dirs: np.ndarray, z: np.ndarray, points: np.ndarray, normals: np.ndarray, camera: int) -> np.ndarray:
        """Infrared intensity image as ``uint8`` for the hits described by :meth:`raycast`."""
        d = np.asarray(dirs, dtype=np.float64)
        view = d / np.linalg.norm(d, axis=-1, keepdims=True)
        lambert = np.clip(-(normals * view).sum(axis=-1), 0.0, 1.0)
        dist = np.maximum(np.linalg.norm(points - origin, axis=-1), 1.0)
        falloff = np.clip((self.falloff_mm / dist) ** 2, 0.0, 1.0)
        intensity = self.albedo(points) * lambert * falloff * 255.0
        rng = np.random.default_rng(self.seed + camera)
        intensity = intensity + rng.normal(0.0, self.noise, intensity.shape)
        intensity[z <= 0] = 0.0
        return np.clip(np.rint(intensity), 0, 255).astype(np.uint8)

    def _render(self, camera: int, dirs: np.ndarray, background: tuple[np.ndarray, np.ndarray]) -> tuple[np.ndarray, np.ndarray]:
        """Shapes composited over a pre-rendered background: ``(image, depth)``."""
        origin = self.camera_origin(camera)
        z, points, normals = self.raycast(origin, dirs, shapes_only=True)
        image, depth = background[0].copy(), background[1].copy()
        hit = z > 0
        if hit.any():
            shaded = self.shade(origin, dirs[hit], z[hit], points[hit], normals[hit], camera)
            image[hit] = shaded
            depth[hit] = z[hit]
        return image, depth

    def render_pinhole(self, camera: int, view: RectifiedView) -> tuple[np.ndarray, np.ndarray]:
        """``(image, true_depth)`` of the scene seen through the rectified pinhole model; depth as ``float32`` mm."""
        dirs = _view_dirs(view)
        return self._render(camera, dirs, _background(self._background_key, camera, view))

    def render_raw(self, model: FisheyeModel, camera: int) -> np.ndarray:
        """The scene seen through the stand-in raw camera, as the service would deliver it."""
        dirs = _raw_dirs(model, camera)
        return self._render(camera, dirs, _background(self._background_key, camera, model))[0]

    def stereo_pair(self, view: RectifiedView) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        """Rectified ``(left, right, true_left_depth)`` straight from the pinhole model (no rectifier involved)."""
        left, depth = self.render_pinhole(CAMERA_LEFT, view)
        right, _ = self.render_pinhole(CAMERA_RIGHT, view)
        return left, right, depth

    def raw_pair(self, model: FisheyeModel) -> tuple[np.ndarray, np.ndarray]:
        return self.render_raw(model, CAMERA_LEFT), self.render_raw(model, CAMERA_RIGHT)


@functools.lru_cache(maxsize=8)
def _background(key: tuple[float, float | None, float, float, float, int], camera: int, model: FisheyeModel | RectifiedView) -> tuple[np.ndarray, np.ndarray]:
    """The static background plane rendered once per scene parameters, camera and camera model (read-only ``(image, depth)``)."""
    baseline_mm, background_mm, texture_mm, falloff_mm, noise, seed = key
    scene = SyntheticStereoScene([], baseline_mm, background_mm, texture_mm, falloff_mm, noise, seed)
    dirs = _raw_dirs(model, camera) if isinstance(model, FisheyeModel) else _view_dirs(model)
    origin = scene.camera_origin(camera)
    z, points, normals = scene.raycast(origin, dirs)
    image = scene.shade(origin, dirs, z, points, normals, camera)
    depth = z.astype(np.float32)
    image.setflags(write=False)
    depth.setflags(write=False)
    return image, depth


def hand_shapes(t: float, absences: bool = True) -> list[Sphere | Capsule]:
    """A scripted fist and forearm sweeping above the device, for ``--source leap-synthetic``.

    Heights stay between 220 and 350 mm above the device (inside the default
    100-450 mm box); like the browser's synthetic performer the hand leaves
    for 3 s out of every 14 unless ``absences`` is off.
    """
    if absences and (t % 14.0) >= 11.0:
        return []
    x = 90.0 * math.sin(t * 0.7)
    y = 60.0 * math.sin(t * 1.4) * math.cos(t * 0.3)
    push = max(0.0, math.sin(t * 0.45)) ** 6
    z = 350.0 - 130.0 * push  # pushing towards the device lowers the hand
    fist = Sphere((x, y, z), 38.0)
    forearm = Capsule((x + 10.0, y + 45.0, z + 20.0), (x + 70.0, y + 260.0, z + 110.0), 30.0)
    return [fist, forearm]


#: Skeleton layout shared with ``depth_bridge`` (``N_JOINTS`` there): the palm, the wrist, the elbow, then five
#: fingers thumb -> pinky with five joints each (carp, mcp, pip, dip, tip); seven widths: palm, arm, five fingers.
SKELETON_JOINTS = 3 + 5 * 5
SKELETON_WIDTHS = 2 + 5
#: Where the synthetic fingers sit on the fist: azimuth around the fist's underside per finger (degrees from the
#: direction away from the forearm), the polar angle of each joint from the point nearest the device (degrees, for
#: the middle finger) and how far along that arc each finger reaches. Angles stay well inside the hemisphere the
#: cameras see, so every joint lands on a matched pixel rather than on the silhouette.
_FINGER_AZIMUTH_DEG = (-58.0, -24.0, 0.0, 22.0, 44.0)
_JOINT_POLAR_DEG = (8.0, 22.0, 34.0, 44.0, 52.0)
_FINGER_REACH = (0.72, 0.95, 1.0, 0.95, 0.8)
_FINGER_WIDTH_MM = (16.0, 18.0, 18.0, 17.0, 15.0)


@dataclass(frozen=True)
class SceneSkeleton:
    """Joints of the scripted hand in the scene frame (millimetres, ``x`` along the baseline, ``z`` = height).

    ``points`` is ``(SKELETON_JOINTS, 3)`` in the layout above, ``widths_mm``
    ``(SKELETON_WIDTHS,)`` diameters and ``extended`` one flag per finger.
    """

    points: np.ndarray
    widths_mm: np.ndarray
    extended: np.ndarray


def _unit(v: np.ndarray) -> np.ndarray:
    return v / np.linalg.norm(v)


def hand_skeleton(t: float, absences: bool = True) -> SceneSkeleton | None:
    """A skeleton lying ON the surfaces :func:`hand_shapes` renders at script time ``t``, or ``None`` when the hand is away.

    The cameras look up, so the surface they scan is the underside of the fist
    and forearm. The palm is the fist's lowest point, the fingers fan across
    the lower hemisphere of the fist (a closed hand: nothing is extended), the
    wrist and elbow sit on the underside of the forearm capsule. Every joint is
    exactly on a rendered surface, so a correctly projected skeleton lands on
    scan pixels of the same depth: that is what makes this a positive control
    for the device-to-image convention detector in ``leap_source``.
    """
    shapes = hand_shapes(t, absences)
    if not shapes:
        return None
    fist = next(s for s in shapes if isinstance(s, Sphere))
    forearm = next(s for s in shapes if isinstance(s, Capsule))
    centre, radius = np.asarray(fist.centre, dtype=np.float64), float(fist.radius)
    a, b = np.asarray(forearm.a, dtype=np.float64), np.asarray(forearm.b, dtype=np.float64)
    axis = _unit(b - a)
    down = np.array([0.0, 0.0, -1.0])                  # toward the device: the side the cameras see
    underside = _unit(down - (down @ axis) * axis)      # the forearm's lowest line, perpendicular to its axis
    forward = _unit(-(axis - (axis @ down) * down))     # horizontal direction from the forearm toward the fingers
    side = np.cross(down, forward)
    points = np.empty((SKELETON_JOINTS, 3), dtype=np.float64)
    points[0] = centre + radius * down
    points[1] = a + forearm.radius * underside
    points[2] = b + forearm.radius * underside
    for f in range(5):
        az = math.radians(_FINGER_AZIMUTH_DEG[f])
        heading = math.cos(az) * forward + math.sin(az) * side
        for j in range(5):
            polar = math.radians(_JOINT_POLAR_DEG[j]) * _FINGER_REACH[f]
            points[3 + 5 * f + j] = centre + radius * (math.cos(polar) * down + math.sin(polar) * heading)
    widths = np.array([1.6 * radius, 2.0 * forearm.radius, *_FINGER_WIDTH_MM], dtype=np.float64)
    return SceneSkeleton(points, widths, np.zeros(5, dtype=bool))
