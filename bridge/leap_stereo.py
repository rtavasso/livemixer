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

Quality to expect: a 40 mm baseline with ~0.36 deg per rectified pixel gives a
depth step of ``Z^2 / (baseline * f)`` per disparity pixel, about 14 mm at
300 mm with the default 320x240 view; sub-pixel matching brings the noise on a
textured hand down to roughly 5-15 mm. Beyond ~450 mm the controller's IR
illumination fades and matches become sparse.
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


class Rectifier:
    """Builds and applies ``cv2.remap`` maps that turn raw images into the :class:`RectifiedView`.

    ``ray_to_pixel`` is queried on a lattice every ``sample_step`` rectified
    pixels (the Leap's own calibration is a 64x64 grid, so nothing is lost)
    and interpolated bilinearly in between; ``sample_step=1`` queries every
    pixel. Rays the calibration cannot place (non-finite results) map outside
    the raw image and come out black. ``coverage[camera]`` is the fraction of
    the view that lands inside the raw image.
    """

    def __init__(
        self, ray_to_pixel: RayToPixel, raw_width: int, raw_height: int,
        view: RectifiedView | None = None, cameras: Sequence[int] = CAMERAS, sample_step: int = 4,
    ) -> None:
        if raw_width < 1 or raw_height < 1:
            raise ValueError("raw image size must be positive")
        if sample_step < 1:
            raise ValueError("sample_step must be at least 1")
        self.view = view or RectifiedView()
        self.raw_width, self.raw_height = int(raw_width), int(raw_height)
        self.sample_step = int(sample_step)
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
        lat_x = np.empty((nv, nu), dtype=np.float64)
        lat_y = np.empty((nv, nu), dtype=np.float64)
        for j in range(nv):
            for i in range(nu):
                tx, ty = view.pixel_to_ray(i * step, j * step)
                px, py = ray_to_pixel(camera, float(tx), float(ty))
                lat_x[j, i], lat_y[j, i] = px, py
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
# Stereo matching
# --------------------------------------------------------------------------- #


@dataclass(frozen=True)
class StereoParams:
    """Matcher tuning. ``min_depth_mm`` sets the disparity search range
    (``numDisparities = ceil((baseline * f / min_depth + 8) / 16) * 16``, the
    margin keeping the near plane away from the saturating end of the
    search); pass the box's near plane. Anything nearer than the range
    matches at the largest disparity, so disparities within a pixel of it
    are discarded rather than reported as a wrong depth.
    ``min_intensity`` invalidates pixels darker than that
    (0..255) in the reference image: the controller's IR LEDs light what is
    near and leave the room dark, and a matcher fed near-black texture
    invents disparities, so this is the main defence against phantom
    matter. ``median`` (0, 3 or 5) median-filters the disparity; the speckle
    filter drops connected patches smaller than ``speckle_window`` pixels
    whose disparity varies by more than ``speckle_range``. ``matcher`` is
    ``"sgbm"`` (default) or ``"bm"`` (block matching: faster, noisier);
    ``mode`` picks the SGBM path aggregation (``"sgbm"`` 5 directions,
    ``"hh"`` 8 directions, ``"3way"`` fastest).
    """

    min_depth_mm: float = 100.0
    max_depth_mm: float = 65535.0
    min_intensity: int = 16
    block_size: int = 5
    uniqueness: int = 10
    speckle_window: int = 100
    speckle_range: int = 2
    disp12_max_diff: int = 1
    prefilter_cap: int = 31
    median: int = 3
    matcher: str = "sgbm"
    mode: str = "sgbm"

    def __post_init__(self) -> None:
        if not (0 < self.min_depth_mm < self.max_depth_mm):
            raise ValueError("need 0 < min_depth_mm < max_depth_mm")
        if not (0 <= self.min_intensity <= 255):
            raise ValueError("min_intensity must be 0..255")
        if self.block_size < 1 or self.block_size % 2 == 0:
            raise ValueError("block_size must be odd and positive")
        if self.median not in (0, 3, 5):
            raise ValueError("median must be 0, 3 or 5")
        if self.matcher not in ("sgbm", "bm"):
            raise ValueError("matcher must be 'sgbm' or 'bm'")
        if self.mode not in ("sgbm", "hh", "3way"):
            raise ValueError("mode must be 'sgbm', 'hh' or '3way'")


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
            modes = {"sgbm": cv2.STEREO_SGBM_MODE_SGBM, "hh": cv2.STEREO_SGBM_MODE_HH, "3way": cv2.STEREO_SGBM_MODE_SGBM_3WAY}
            block = p.block_size
            matcher = cv2.StereoSGBM_create(
                minDisparity=0, numDisparities=self.num_disparities, blockSize=block,
                P1=8 * block * block, P2=32 * block * block, disp12MaxDiff=p.disp12_max_diff,
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
        raw = self.matcher.compute(left, right)  # int16, 16x fixed point, invalid = -16
        disp = raw.astype(np.float32) / 16.0
        if self.params.median in (3, 5):
            disp = cv2.medianBlur(disp, self.params.median)
        disp[disp > self.num_disparities - 1.5] = -1.0  # saturated: nearer than the search range, depth unknown
        if self.params.min_intensity > 0:
            disp[left < self.params.min_intensity] = -1.0  # too dark to trust: the IR LEDs did not reach it
        return disp

    def depth_from_disparity(self, disp: np.ndarray) -> np.ndarray:
        """``Z = baseline * f / d`` as ``uint16`` millimetres; invalid or out-of-range disparities read 0."""
        valid = disp > 0
        depth = np.zeros(disp.shape, dtype=np.float32)
        np.divide(self.baseline_mm * self.focal_px, disp, out=depth, where=valid)
        depth[(depth > self.params.max_depth_mm) | (depth > 65535.0)] = 0.0
        return np.ascontiguousarray(np.rint(depth), dtype=np.uint16)

    def compute(self, left: np.ndarray, right: np.ndarray) -> np.ndarray:
        return self.depth_from_disparity(self.disparity(left, right))

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
