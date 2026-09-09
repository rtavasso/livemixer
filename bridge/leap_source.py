#!/usr/bin/env python3
"""Leap Motion Controller as a depth camera: LeapC stereo images -> depth frames for ``depth_bridge.py``.

``--source leap`` opens the tracking service through LeapC (ctypes, no SDK
wrapper needed), asks for the raw infrared stereo images, rectifies them with
the device's own calibration and turns them into ``uint16`` millimetre depth
frames with :mod:`leap_stereo`; ``depth_bridge.BoxAnalyzer`` does the rest,
so the browser sees the usual blobs, occupancy, voxels and surface scan.
``--source leap-synthetic`` runs the same rectify-and-match pipeline on a
rendered stereo pair (a fist and forearm sweeping above the device) and needs
no hardware.

Hand tracking rides along: the service's tracking events (the hand skeleton
LeapC computes from the same images) are copied into :class:`DeviceHand`
records, matched to the stereo pair by timestamp and projected into the depth
image's frame (:class:`HandProjector`), so every :class:`DepthFrame` carries
both the scan and the skeleton, aligned. Which way the device axes sit behind
the rectified view is not documented, so the projection is a
:class:`HandFrame` convention chosen from sixteen candidates: fixed by
``--leap-hand-frame NAME`` or, by default, detected by scoring every
candidate against the scan (:class:`HandFrameDetector`).

LeapC across service versions
-----------------------------
* The library is searched in the Ultraleap Gemini/Hyperion SDK, then the old
  Leap Motion "Core Services" install, then ``$LEAPC_DLL``; ``--leapc`` names
  it explicitly. Only functions present in every build since 4.x are used
  (``LeapRectilinearToPixelEx`` is picked up when it exists).
* ``LEAP_CONNECTION_MESSAGE`` grew a ``device_id`` field in Gemini 5.x (20
  bytes instead of 16); the layout is read off ``msg.size`` at runtime.
* An allocator is installed before the connection opens (image buffers are
  ours), and the policy (images | background frames) is requested once the
  Connection event arrives and again when a device shows up.
* Known problem: with "Leap Motion Service 5.0.0-preview" a client is granted
  the images policy and then ``LeapPollConnection`` never returns: no
  tracking, no images. The poll runs on its own daemon thread so the bridge
  keeps serving and reports the stall; the fix is to install current
  Ultraleap tracking software (Gemini 5.x / Hyperion, both support the
  controller) and point ``--leapc`` at its ``LeapC.dll``.

Run ``python bridge/leap_source.py --dump-images 3 --out DIR`` (add
``--synthetic`` for the rendered scene) to write the rectified pair and the
depth map as PNGs for inspection; it also reports which camera order matches.
"""
from __future__ import annotations

import argparse
import atexit
import ctypes as C
import logging
import os
import sys
import threading
import time
from collections import deque
from dataclasses import dataclass
from typing import Any, Callable, Iterator, Sequence

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))


def _hard_exit_at_shutdown() -> None:
    """Registered once a LeapC poll thread is known to be stuck: flush and leave without waiting for it."""
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.flush()
        except Exception:  # noqa: BLE001
            pass
    os._exit(0)


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


if __package__:
    from . import leap_stereo as ls
else:
    if HERE not in sys.path:
        sys.path.insert(0, HERE)
    import leap_stereo as ls  # type: ignore[no-redef]

_db = _bridge_module()
DepthFrame, FrameSource, TrackedHand = _db.DepthFrame, _db.FrameSource, _db.TrackedHand
N_JOINTS, N_WIDTHS, N_FINGERS, JOINTS_PER_FINGER = _db.N_JOINTS, _db.N_WIDTHS, _db.N_FINGERS, _db.JOINTS_PER_FINGER
JOINT_PALM, JOINT_WRIST, JOINT_ELBOW, FINGER_JOINTS = _db.JOINT_PALM, _db.JOINT_WRIST, _db.JOINT_ELBOW, _db.FINGER_JOINTS
WIDTH_PALM, WIDTH_ARM, WIDTH_FINGERS = _db.WIDTH_PALM, _db.WIDTH_ARM, _db.WIDTH_FINGERS
finger_joint = _db.finger_joint

log = logging.getLogger("leap_source")

# --------------------------------------------------------------------------- #
# LeapC constants (LeapC.h; identical in Orion 4.x, the 5.0 preview and Gemini/Hyperion)
# --------------------------------------------------------------------------- #

RS_SUCCESS = 0x00000000
RS_INSUFFICIENT_BUFFER = 0xE2010003
RS_TIMEOUT = 0xE2010004
RS_NOT_CONNECTED = 0xE2010005
RS_NAMES = {
    0x00000000: "Success", 0xE2010000: "UnknownError", 0xE2010001: "InvalidArgument", 0xE2010002: "InsufficientResources",
    0xE2010003: "InsufficientBuffer", 0xE2010004: "Timeout", 0xE2010005: "NotConnected", 0xE2010006: "HandshakeIncomplete",
    0xE2010007: "BufferSizeOverflow", 0xE2010008: "ProtocolError", 0xE2010009: "InvalidClientID", 0xE201000A: "UnexpectedClosed",
    0xE201000B: "UnknownImageFrameRequest", 0xE201000C: "UnknownTrackingFrameID", 0xE201000D: "RoutineIsNotSeer",
    0xE201000E: "TimestampTooEarly", 0xE201000F: "ConcurrentPoll", 0xE2010010: "NotAvailable", 0xE2010011: "NotStreaming",
    0xE2010012: "CannotOpenDevice",
}

EVENT_CONNECTION = 0x1
EVENT_CONNECTION_LOST = 0x2
EVENT_DEVICE = 0x3
EVENT_DEVICE_FAILURE = 0x4
EVENT_POLICY = 0x5
EVENT_TRACKING = 0x100
EVENT_LOG_EVENT = 0x103
EVENT_DEVICE_LOST = 0x104
EVENT_DEVICE_STATUS_CHANGE = 0x107
EVENT_IMAGE = 0x109
EVENT_LOG_EVENTS = 0x10C
EVENT_NAMES = {
    0x0: "None", 0x1: "Connection", 0x2: "ConnectionLost", 0x3: "Device", 0x4: "DeviceFailure", 0x5: "Policy",
    0x100: "Tracking", 0x101: "ImageRequestError", 0x102: "ImageComplete", 0x103: "LogEvent", 0x104: "DeviceLost",
    0x105: "ConfigResponse", 0x106: "ConfigChange", 0x107: "DeviceStatusChange", 0x108: "DroppedFrame", 0x109: "Image",
    0x10A: "PointMappingChange", 0x10B: "TrackingMode", 0x10C: "LogEvents", 0x10D: "IMU", 0x10E: "Eyes", 0x10F: "IMU",
}

POLICY_BACKGROUND_FRAMES = 0x1
POLICY_IMAGES = 0x2
POLICY_REQUESTED = POLICY_IMAGES | POLICY_BACKGROUND_FRAMES

DEVICE_TYPES = {
    0x0003: "Leap Motion Controller", 0x1102: "Dragonfly", 0x1201: "Nightcrawler", 0x1202: "Rigel",
    0x1203: "Stereo IR 170", 0x1204: "3Di", 0x1206: "Leap Motion Controller 2",
}
LOG_SEVERITY = {0: logging.DEBUG, 1: logging.ERROR, 2: logging.WARNING, 3: logging.INFO}

STALL_MESSAGE = (
    "no stereo images from LeapC for {elapsed:.0f} s ({state}). This is the known 'Leap Motion Service 5.0.0-preview' "
    "stall: that build grants the images policy and then LeapPollConnection never returns. Fix: install current "
    "Ultraleap tracking software (Gemini 5.x or Hyperion, both support the controller), enable 'Allow Images' in its "
    "control panel, and point --leapc at its LeapC.dll (e.g. C:\\Program Files\\Ultraleap\\LeapSDK\\lib\\x64\\LeapC.dll)."
)


# --------------------------------------------------------------------------- #
# LeapC structures (``#pragma pack(1)`` in LeapC.h)
# --------------------------------------------------------------------------- #


class _Vector(C.Structure):
    _pack_ = 1
    _fields_ = [("x", C.c_float), ("y", C.c_float), ("z", C.c_float)]


class _ConnectionMessage(C.Structure):
    """``LEAP_CONNECTION_MESSAGE`` with room to spare: 16 bytes through 5.0, 20 with Gemini's ``device_id``."""

    _pack_ = 1
    _fields_ = [("size", C.c_uint32), ("type", C.c_uint32), ("pointer", C.c_void_p), ("tail", C.c_uint8 * 64)]

    @property
    def device_id(self) -> int | None:
        if self.size >= 20:
            return int(C.c_uint32.from_buffer(self, 16).value)
        return None


class _FrameHeader(C.Structure):
    _pack_ = 1
    _fields_ = [("reserved", C.c_void_p), ("frame_id", C.c_int64), ("timestamp", C.c_int64)]


class _ImageProperties(C.Structure):
    _pack_ = 1
    _fields_ = [
        ("type", C.c_uint32), ("format", C.c_uint32), ("bpp", C.c_uint32), ("width", C.c_uint32), ("height", C.c_uint32),
        ("x_scale", C.c_float), ("y_scale", C.c_float), ("x_offset", C.c_float), ("y_offset", C.c_float),
    ]


class _Image(C.Structure):
    _pack_ = 1
    _fields_ = [("properties", _ImageProperties), ("matrix_version", C.c_uint64), ("distortion_matrix", C.c_void_p), ("data", C.c_void_p), ("offset", C.c_uint32)]


class _ImageEvent(C.Structure):
    _pack_ = 1
    _fields_ = [("info", _FrameHeader), ("image", _Image * 2), ("calib", C.c_void_p)]


class _DeviceRef(C.Structure):
    _pack_ = 1
    _fields_ = [("handle", C.c_void_p), ("id", C.c_uint32)]


class _DeviceEvent(C.Structure):
    _pack_ = 1
    _fields_ = [("flags", C.c_uint32), ("device", _DeviceRef), ("status", C.c_uint32)]


class _DeviceInfo(C.Structure):
    _pack_ = 1
    _fields_ = [
        ("size", C.c_uint32), ("status", C.c_uint32), ("caps", C.c_uint32), ("type", C.c_uint32), ("baseline", C.c_uint32),
        ("serial_length", C.c_uint32), ("serial", C.c_char_p), ("h_fov", C.c_float), ("v_fov", C.c_float), ("range", C.c_uint32),
    ]


class _PolicyEvent(C.Structure):
    _pack_ = 1
    _fields_ = [("reserved", C.c_uint32), ("current_policy", C.c_uint32)]


class _LogEvent(C.Structure):
    _pack_ = 1
    _fields_ = [("severity", C.c_uint32), ("timestamp", C.c_int64), ("message", C.c_char_p)]


class _LogEvents(C.Structure):
    _pack_ = 1
    _fields_ = [("nEvents", C.c_uint32), ("events", C.POINTER(_LogEvent))]


# Hand tracking (LEAP_TRACKING_EVENT, eLeapEventType_Tracking = 0x100). Like every LeapC struct these are
# ``#pragma pack(1)``; with x64 natural alignment LEAP_HAND would be 1088 bytes (padded after ``arm``) and
# the event 56 (pHands at 40). The field offsets inside LEAP_HAND are the same either way; only the stride
# between hands and the position of pHands/framerate differ, which is what the tests pin.


class _Quaternion(C.Structure):
    _pack_ = 1
    _fields_ = [("x", C.c_float), ("y", C.c_float), ("z", C.c_float), ("w", C.c_float)]


class _Bone(C.Structure):
    _pack_ = 1
    _fields_ = [("prev_joint", _Vector), ("next_joint", _Vector), ("width", C.c_float), ("rotation", _Quaternion)]


class _Digit(C.Structure):
    """``LEAP_DIGIT``: ``bones`` are metacarpal, proximal, intermediate, distal."""

    _pack_ = 1
    _fields_ = [("finger_id", C.c_int32), ("bones", _Bone * 4), ("is_extended", C.c_uint32)]


class _Palm(C.Structure):
    _pack_ = 1
    _fields_ = [
        ("position", _Vector), ("stabilized_position", _Vector), ("velocity", _Vector), ("normal", _Vector),
        ("width", C.c_float), ("direction", _Vector), ("orientation", _Quaternion),
    ]


class _Hand(C.Structure):
    """``LEAP_HAND``: ``type`` is ``eLeapHandType`` (0 left, 1 right); ``digits`` run thumb, index, middle, ring, pinky."""

    _pack_ = 1
    _fields_ = [
        ("id", C.c_uint32), ("flags", C.c_uint32), ("type", C.c_int32), ("confidence", C.c_float), ("visible_time", C.c_uint64),
        ("pinch_distance", C.c_float), ("grab_angle", C.c_float), ("pinch_strength", C.c_float), ("grab_strength", C.c_float),
        ("palm", _Palm), ("digits", _Digit * 5), ("arm", _Bone),
    ]


class _TrackingEvent(C.Structure):
    _pack_ = 1
    _fields_ = [("info", _FrameHeader), ("tracking_frame_id", C.c_int64), ("nHands", C.c_uint32), ("pHands", C.POINTER(_Hand)), ("framerate", C.c_float)]


_ALLOCATE = C.CFUNCTYPE(C.c_void_p, C.c_uint32, C.c_uint32, C.c_void_p)
_DEALLOCATE = C.CFUNCTYPE(None, C.c_void_p, C.c_void_p)


class _Allocator(C.Structure):
    _pack_ = 1
    _fields_ = [("allocate", _ALLOCATE), ("deallocate", _DEALLOCATE), ("state", C.c_void_p)]


assert C.sizeof(_ConnectionMessage) == 16 + 64 and C.sizeof(_ImageEvent) == 24 + 2 * 64 + 8 and C.sizeof(_DeviceInfo) == 44
assert C.sizeof(_Bone) == 44 and C.sizeof(_Digit) == 184 and C.sizeof(_Palm) == 80 and C.sizeof(_Hand) == 1084 and C.sizeof(_TrackingEvent) == 48


class BufferPool:
    """The ``LEAP_ALLOCATOR``: LeapC asks us for image buffers and hands them back when done."""

    def __init__(self) -> None:
        self._buffers: dict[int, Any] = {}
        self._lock = threading.Lock()
        self._allocate_cb = _ALLOCATE(self._allocate)
        self._deallocate_cb = _DEALLOCATE(self._deallocate)
        self.struct = _Allocator(self._allocate_cb, self._deallocate_cb, None)
        self.allocations = 0

    def _allocate(self, size: int, type_hint: int, state: Any) -> int:
        buf = C.create_string_buffer(max(1, int(size)))
        addr = C.addressof(buf)
        with self._lock:
            self._buffers[addr] = buf
            self.allocations += 1
        return addr

    def _deallocate(self, ptr: Any, state: Any) -> None:
        with self._lock:
            self._buffers.pop(int(ptr or 0), None)

    @property
    def live(self) -> int:
        with self._lock:
            return len(self._buffers)


@dataclass(frozen=True)
class LeapDeviceInfo:
    type: int
    baseline_um: int
    h_fov: float
    v_fov: float
    range_um: int
    serial: str
    status: int
    caps: int

    @property
    def baseline_mm(self) -> float:
        return self.baseline_um / 1000.0

    @property
    def type_name(self) -> str:
        return DEVICE_TYPES.get(self.type, f"device type 0x{self.type:x}")


# --------------------------------------------------------------------------- #
# Tracked hands in the device frame
# --------------------------------------------------------------------------- #

MAX_TRACKED_HANDS = 16                       # an event claiming more is garbage (a wrong layout), not a crowd
MAX_JOINT_DISTANCE_MM = 3000.0               # the controller tracks to ~80 cm; anything farther is not a hand
HAND_TYPE_NAMES = {0: "left", 1: "right"}
FOREARM_STUB_MM = 70.0                       # how much forearm is kept past the wrist before projecting


@dataclass(frozen=True)
class DeviceHand:
    """One LeapC hand in the device frame: millimetres, x along the long axis, y up, z toward the performer.

    ``joints`` (``N_JOINTS x 3``), ``widths_mm`` (``N_WIDTHS``, diameters) and
    ``extended`` follow ``depth_bridge``'s skeleton layout: the palm, the
    wrist (``arm.next_joint``), the elbow (``arm.prev_joint``), then per
    finger the metacarpal's start, the knuckle, the two inter-phalangeal
    joints and the tip; a finger's width is its proximal bone's.
    """

    id: int
    type: str
    confidence: float
    grab_strength: float
    pinch_strength: float
    joints: np.ndarray
    widths_mm: np.ndarray
    extended: np.ndarray
    palm_normal: tuple[float, float, float] = (0.0, -1.0, 0.0)
    palm_direction: tuple[float, float, float] = (0.0, 0.0, -1.0)


@dataclass(frozen=True)
class TrackingFrame:
    """One tracking event: ``timestamp_us`` is on LeapC's clock (``LeapGetNow``), the same as the image events'."""

    timestamp_us: int
    frame_id: int
    framerate: float
    hands: tuple[DeviceHand, ...]


def _xyz(v: _Vector) -> tuple[float, float, float]:
    return (float(v.x), float(v.y), float(v.z))


def read_hand(hand: _Hand) -> DeviceHand | None:
    """Copy a ``LEAP_HAND`` into a :class:`DeviceHand`, or ``None`` when its numbers cannot be a hand.

    The guard (finite, within a few metres) is what keeps a wrong struct
    layout or a stale pointer from turning into NaN on the wire.
    """
    joints = np.empty((N_JOINTS, 3), dtype=np.float64)
    widths = np.empty(N_WIDTHS, dtype=np.float64)
    extended = np.zeros(N_FINGERS, dtype=bool)
    joints[JOINT_PALM] = _xyz(hand.palm.position)
    joints[JOINT_WRIST] = _xyz(hand.arm.next_joint)
    joints[JOINT_ELBOW] = _xyz(hand.arm.prev_joint)
    widths[WIDTH_PALM], widths[WIDTH_ARM] = float(hand.palm.width), float(hand.arm.width)
    for f in range(N_FINGERS):
        digit = hand.digits[f]
        bones = digit.bones
        base = finger_joint(f, 0)
        joints[base] = _xyz(bones[0].prev_joint)
        joints[base + 1] = _xyz(bones[1].prev_joint)
        joints[base + 2] = _xyz(bones[2].prev_joint)
        joints[base + 3] = _xyz(bones[3].prev_joint)
        joints[base + 4] = _xyz(bones[3].next_joint)
        widths[WIDTH_FINGERS + f] = float(bones[1].width)
        extended[f] = bool(digit.is_extended)
    scalars = (float(hand.confidence), float(hand.grab_strength), float(hand.pinch_strength))
    if not (np.isfinite(joints).all() and np.isfinite(widths).all() and all(np.isfinite(scalars))):
        return None
    if np.abs(joints).max() > MAX_JOINT_DISTANCE_MM or widths.min() < 0 or widths.max() > 500.0:
        return None
    return DeviceHand(
        id=int(hand.id), type=HAND_TYPE_NAMES.get(int(hand.type), "unknown"),
        confidence=min(1.0, max(0.0, scalars[0])), grab_strength=min(1.0, max(0.0, scalars[1])), pinch_strength=min(1.0, max(0.0, scalars[2])),
        joints=joints, widths_mm=widths, extended=extended, palm_normal=_xyz(hand.palm.normal), palm_direction=_xyz(hand.palm.direction),
    )


def read_tracking_event(event: _TrackingEvent) -> TrackingFrame:
    """Copy a ``LEAP_TRACKING_EVENT`` (the memory is LeapC's until the next poll) into a :class:`TrackingFrame`."""
    count = int(event.nHands)
    hands: list[DeviceHand] = []
    if 0 < count <= MAX_TRACKED_HANDS and event.pHands:
        for i in range(count):
            hand = read_hand(event.pHands[i])
            if hand is not None:
                hands.append(hand)
    return TrackingFrame(int(event.info.timestamp), int(event.info.frame_id), float(event.framerate), tuple(hands))


# --------------------------------------------------------------------------- #
# Projecting the skeleton into the depth image
# --------------------------------------------------------------------------- #


@dataclass(frozen=True)
class HandFrame:
    """One way the device frame can sit behind the rectified view.

    The depth image is the rectified view of one camera whose optical axis is
    the device's up (``+y``): a device point ``p`` becomes ``q = p - origin``
    with the reference camera at ``x = origin_sign * baseline / 2``, its depth
    is ``q.y``, and the view's ray slopes are ``tx = u_sign * q[u_axis] /
    depth`` and ``ty = v_sign * q[v_axis] / depth`` where ``u_axis`` is the
    device x (0) or z (2) and ``v_axis`` the other. LeapC does not say which
    signs its rectilinear frame uses, hence :data:`HAND_FRAMES`, the sixteen
    candidates. Only ``u`` along ``x`` with the reference camera on the low-u
    side (``origin_sign == -u_sign``) can give positive disparities, so if
    the scan works those four are the real contenders; the others are kept so
    the detector can say so rather than assume it. ``--swap-cameras`` makes
    the other camera the reference (:meth:`reference_sign`).
    """

    u_axis: int
    u_sign: int
    v_axis: int
    v_sign: int
    origin_sign: int

    def __post_init__(self) -> None:
        if {self.u_axis, self.v_axis} != {0, 2} or abs(self.u_sign) != 1 or abs(self.v_sign) != 1 or abs(self.origin_sign) != 1:
            raise ValueError(f"bad hand frame {self}")

    @property
    def name(self) -> str:
        sign = {1: "+", -1: "-"}
        return f"u{sign[self.u_sign]}{'xyz'[self.u_axis]}_v{sign[self.v_sign]}{'xyz'[self.v_axis]}_ref{sign[self.origin_sign]}"

    @property
    def plausible(self) -> bool:
        """Consistent with a working stereo pair: ``u`` along the baseline, reference camera on the low-``u`` side."""
        return self.u_axis == 0 and self.origin_sign == -self.u_sign

    def reference_sign(self, swap: bool) -> int:
        return -self.origin_sign if swap else self.origin_sign

    def device_to_camera(self, points: np.ndarray, ref_sign: int, baseline_mm: float) -> np.ndarray:
        """Device points ``(N, 3)`` -> camera coordinates ``(a, b, depth)`` with ``tx = a / depth``, ``ty = b / depth``."""
        q = np.asarray(points, dtype=np.float64).reshape(-1, 3) - np.array([ref_sign * baseline_mm / 2.0, 0.0, 0.0])
        return np.stack([self.u_sign * q[:, self.u_axis], self.v_sign * q[:, self.v_axis], q[:, 1]], axis=-1)

    def camera_to_device(self, camera: np.ndarray, ref_sign: int, baseline_mm: float) -> np.ndarray:
        """Inverse of :meth:`device_to_camera`."""
        cam = np.asarray(camera, dtype=np.float64).reshape(-1, 3)
        q = np.empty_like(cam)
        q[:, self.u_axis] = self.u_sign * cam[:, 0]
        q[:, self.v_axis] = self.v_sign * cam[:, 1]
        q[:, 1] = cam[:, 2]
        return q + np.array([ref_sign * baseline_mm / 2.0, 0.0, 0.0])


def _hand_frames() -> tuple[HandFrame, ...]:
    frames = [
        HandFrame(u_axis, u_sign, 2 - u_axis, v_sign, origin_sign)
        for u_axis in (0, 2) for u_sign in (1, -1) for v_sign in (-1, 1) for origin_sign in (-1, 1)
    ]
    # Plausible ones first (they win ties), the right-handed u+x/v-z default at the head.
    frames.sort(key=lambda f: (not f.plausible, f.u_sign < 0, f.v_sign > 0, f.origin_sign > 0, f.u_axis))
    return tuple(frames)


#: Every candidate convention, most plausible first.
HAND_FRAMES: tuple[HandFrame, ...] = _hand_frames()
HAND_FRAME_BY_NAME: dict[str, HandFrame] = {f.name: f for f in HAND_FRAMES}
HAND_FRAME_NAMES: tuple[str, ...] = tuple(HAND_FRAME_BY_NAME)
DEFAULT_HAND_FRAME = HAND_FRAMES[0].name  # u+x_v-z_ref-: a right-handed camera frame looking up


def project_hand_points(points: np.ndarray, frame: HandFrame, view: ls.RectifiedView, baseline_mm: float, swap: bool = False, orient: str = "none") -> np.ndarray:
    """Device-frame points ``(N, 3)`` mm -> ``(u, v, depth)`` in the depth image.

    ``u``/``v`` are continuous pixel coordinates with integer values at pixel
    centres (:meth:`leap_stereo.RectifiedView.ray_to_pixel`), reoriented like
    the image; ``depth`` is millimetres along the optical axis. Points at or
    below the device plane cannot be projected and get NaN ``u``/``v``.
    """
    cam = frame.device_to_camera(points, frame.reference_sign(swap), baseline_mm)
    depth = cam[:, 2]
    with np.errstate(divide="ignore", invalid="ignore"):
        safe = np.where(depth > 1e-6, depth, np.nan)
        u, v = view.ray_to_pixel(cam[:, 0] / safe, cam[:, 1] / safe)
    u, v = ls.reorient_points(u, v, view.width, view.height, orient)
    return np.stack([u, v, depth], axis=-1)


def trim_forearm(wrist: np.ndarray, elbow: np.ndarray, stub_mm: float = FOREARM_STUB_MM) -> np.ndarray:
    """The elbow moved to ``stub_mm`` past the wrist along the forearm (the browser only wants a stub)."""
    direction = np.asarray(elbow, dtype=np.float64) - np.asarray(wrist, dtype=np.float64)
    length = float(np.linalg.norm(direction))
    if length <= stub_mm:
        return np.asarray(elbow, dtype=np.float64)
    return np.asarray(wrist, dtype=np.float64) + direction * (stub_mm / length)


def joint_hits(projected: np.ndarray, depth: np.ndarray, tolerance_mm: float) -> int:
    """How many projected joints ``(u, v, depth)`` land on a pixel of ``depth`` holding a measurement within ``tolerance_mm``."""
    h, w = depth.shape
    u, v, d = projected[:, 0], projected[:, 1], projected[:, 2]
    ok = np.isfinite(u) & np.isfinite(v) & (d > 0)
    ui, vi = np.rint(u[ok]).astype(np.int64), np.rint(v[ok]).astype(np.int64)
    inside = (ui >= 0) & (ui < w) & (vi >= 0) & (vi < h)
    z = depth[vi[inside], ui[inside]].astype(np.float64)
    return int(((z > 0) & (np.abs(z - d[ok][inside]) <= tolerance_mm)).sum())


#: The joints the detector scores: everything but the elbow, which is often above the box or out of view.
SCORED_JOINTS = np.array([JOINT_PALM, JOINT_WRIST, *range(FINGER_JOINTS, N_JOINTS)])


class HandFrameDetector:
    """Picks the :class:`HandFrame` by scoring every candidate against the scan.

    On each frame that has both a tracked hand and depth, every candidate
    projects the hand's joints (palm, wrist, 25 finger joints) and scores the
    fraction that land on a depth pixel within ``tolerance_mm`` of the joint's
    own depth: the right convention puts the skeleton on the scanned hand,
    the others put it beside, mirrored or transposed. Hits accumulate over
    frames (a frame where no candidate scores is uninformative and skipped)
    and the winner is locked once ``min_frames`` have been scored, it hits
    at least ``min_score`` and leads the runner-up by ``min_lead``. Until
    then ``best`` is the provisional leader (plausible candidates win ties).
    """

    def __init__(
        self, candidates: Sequence[HandFrame] = HAND_FRAMES, tolerance_mm: float = 30.0,
        min_frames: int = 5, min_score: float = 0.5, min_lead: float = 0.15,
    ) -> None:
        if not candidates:
            raise ValueError("need at least one candidate")
        self.candidates = tuple(candidates)
        self.tolerance_mm, self.min_frames, self.min_score, self.min_lead = float(tolerance_mm), int(min_frames), float(min_score), float(min_lead)
        self.hits = np.zeros(len(self.candidates), dtype=np.int64)
        self.total = 0
        self.frames = 0
        self.locked: HandFrame | None = None
        self.locked_after = 0

    @property
    def scores(self) -> np.ndarray:
        return self.hits / max(self.total, 1)

    @property
    def best(self) -> HandFrame:
        if self.locked is not None:
            return self.locked
        return self.candidates[int(np.argmax(self.scores))]  # argmax takes the first of equals: the most plausible

    def observe(self, depth: np.ndarray, project: Callable[[HandFrame], np.ndarray]) -> HandFrame | None:
        """Score one frame; ``project(candidate)`` returns the ``(N, 3)`` image-frame joints. Returns the frame if it just locked."""
        if self.locked is not None:
            return None
        frame_hits = np.array([joint_hits(project(c), depth, self.tolerance_mm) for c in self.candidates], dtype=np.int64)
        if frame_hits.max() == 0:
            return None
        self.hits += frame_hits
        self.total += int(project(self.candidates[0]).shape[0])
        self.frames += 1
        if self.frames < self.min_frames:
            return None
        order = np.argsort(-self.scores, kind="stable")
        best, second = float(self.scores[order[0]]), float(self.scores[order[1]]) if len(order) > 1 else 0.0
        if best >= self.min_score and best - second >= self.min_lead:
            self.locked, self.locked_after = self.candidates[int(order[0])], self.frames
            return self.locked
        return None

    def describe(self) -> str:
        if self.locked is not None:
            return f"{self.locked.name} (auto, locked after {self.locked_after} frames at {self.scores.max():.2f})"
        if self.frames == 0:
            return f"{self.best.name} (auto, nothing scored yet)"
        order = np.argsort(-self.scores, kind="stable")
        runner = f" vs {self.candidates[int(order[1])].name} {self.scores[order[1]]:.2f}" if len(order) > 1 else ""
        return f"{self.best.name} (auto, leading {self.scores[order[0]]:.2f}{runner} after {self.frames} frames)"

    def table(self) -> str:
        """Every candidate's score, best first, for ``--dump-images``."""
        order = np.argsort(-self.scores, kind="stable")
        lines = [f"hand frame candidates after {self.frames} scored frames ({self.total} joints):"]
        for i in order:
            c = self.candidates[int(i)]
            mark = " <- locked" if c is self.locked else (" <- leading" if c is self.best else "")
            lines.append(f"  {c.name:<16} {self.scores[i]:6.3f}  {int(self.hits[i]):5d} hits{'' if c.plausible else '  (implausible: no positive disparity)'}{mark}")
        return "\n".join(lines)


class HandProjector:
    """Turns :class:`DeviceHand` records into :class:`TrackedHand` skeletons in one source's depth image.

    Holds the view, baseline, camera order and orientation of the depth image
    and the convention: fixed (``hand_frame`` a name) or ``"auto"`` with a
    :class:`HandFrameDetector` fed by :meth:`resolve`. Per hand the forearm is
    trimmed to a stub, the joints projected and each width converted to pixels
    at its part's depth (``width * fx / depth``), so widths are perspective
    units like the image. Cheap: a few numpy operations on 28 points per hand,
    plus 16 more projections per frame while the detector is still scoring.
    """

    def __init__(self, view: ls.RectifiedView, baseline_mm: float, swap: bool = False, orient: str = "none", hand_frame: str = "auto", detector: HandFrameDetector | None = None) -> None:
        self.view, self.baseline_mm, self.swap, self.orient = view, float(baseline_mm), bool(swap), orient
        self.fixed: HandFrame | None = None
        self.detector: HandFrameDetector | None = None
        if hand_frame == "auto":
            self.detector = detector or HandFrameDetector()
        elif hand_frame in HAND_FRAME_BY_NAME:
            self.fixed = HAND_FRAME_BY_NAME[hand_frame]
        else:
            raise ValueError(f"unknown hand frame {hand_frame!r}; use 'auto' or one of {', '.join(HAND_FRAME_NAMES)}")

    @property
    def frame(self) -> HandFrame:
        if self.fixed is not None:
            return self.fixed
        assert self.detector is not None
        return self.detector.best

    @property
    def locked(self) -> bool:
        return self.fixed is not None or (self.detector is not None and self.detector.locked is not None)

    def project(self, points: np.ndarray, frame: HandFrame | None = None) -> np.ndarray:
        return project_hand_points(points, frame or self.frame, self.view, self.baseline_mm, self.swap, self.orient)

    def to_image_hand(self, hand: DeviceHand, frame: HandFrame | None = None) -> TrackedHand | None:
        joints = hand.joints.copy()
        joints[JOINT_ELBOW] = trim_forearm(joints[JOINT_WRIST], joints[JOINT_ELBOW])
        image = self.project(joints, frame)
        if not np.isfinite(image).all() or (image[:, 2] <= 0).any():
            return None  # part of the hand below the device plane: not a hand this camera can see
        depth_of_part = np.empty(N_WIDTHS, dtype=np.float64)
        depth_of_part[WIDTH_PALM], depth_of_part[WIDTH_ARM] = image[JOINT_PALM, 2], image[JOINT_WRIST, 2]
        for f in range(N_FINGERS):
            start = finger_joint(f, 0)
            depth_of_part[WIDTH_FINGERS + f] = image[start:start + JOINTS_PER_FINGER, 2].mean()
        widths_px = hand.widths_mm * self.view.fx / depth_of_part
        return TrackedHand(
            id=hand.id, type=hand.type, joints=image, widths_px=widths_px, extended=hand.extended.copy(),
            confidence=hand.confidence, grab_strength=hand.grab_strength, pinch_strength=hand.pinch_strength, has_elbow=True,
        )

    def resolve(self, hands: Sequence[DeviceHand], depth: np.ndarray) -> tuple[TrackedHand, ...]:
        """Score the detector on this frame (while unlocked) and project every hand with the current convention."""
        if not hands:
            return ()
        if self.detector is not None and self.detector.locked is None:
            scored = np.concatenate([h.joints[SCORED_JOINTS] for h in hands])
            locked = self.detector.observe(depth, lambda frame: self.project(scored, frame))
            if locked is not None:
                log.info("hand frame locked: %s", self.detector.describe())
        frame = self.frame
        out = [self.to_image_hand(h, frame) for h in hands]
        return tuple(h for h in out if h is not None)

    def describe(self) -> str:
        if self.fixed is not None:
            return f"{self.fixed.name} (fixed)"
        assert self.detector is not None
        return self.detector.describe()


# --------------------------------------------------------------------------- #
# Locating and binding the library
# --------------------------------------------------------------------------- #


def leapc_candidates() -> list[str]:
    """Where a LeapC library is looked for, in order: ``$LEAPC_DLL``, current Ultraleap installs, the old Leap Motion install."""
    paths: list[str] = []
    env = os.environ.get("LEAPC_DLL")
    if env:
        paths.append(env)
    if sys.platform == "win32":
        pf = os.environ.get("ProgramFiles", r"C:\Program Files")
        paths += [
            os.path.join(pf, "Ultraleap", "LeapSDK", "lib", "x64", "LeapC.dll"),
            os.path.join(pf, "Ultraleap", "LeapSDK", "lib", "LeapC.dll"),
            os.path.join(pf, "Leap Motion", "Core Services", "VRVisualizer", "VRVisualizer_Data", "Plugins", "LeapC.dll"),
            os.path.join(pf, "Leap Motion", "Core Services", "LeapC.dll"),
            "LeapC.dll",
        ]
    elif sys.platform == "darwin":
        paths += [
            "/Applications/Ultraleap Hand Tracking.app/Contents/LeapSDK/lib/libLeapC.5.dylib",
            "/Applications/Ultraleap Hand Tracking.app/Contents/LeapSDK/lib/libLeapC.dylib",
            "/Library/Application Support/Ultraleap/LeapSDK/lib/libLeapC.5.dylib",
            "libLeapC.5.dylib",
        ]
    else:
        paths += [
            "/usr/lib/ultraleap-hand-tracking-service/libLeapC.so.5",
            "/usr/lib/ultraleap-hand-tracking-service/libLeapC.so",
            "libLeapC.so.5",
            "libLeapC.so",
        ]
    return paths


def find_leapc(path: str | None = None) -> str:
    """Resolve the LeapC library path, raising a message that lists what was tried."""
    if path:
        if os.path.isfile(path):
            return path
        raise RuntimeError(f"LeapC library not found at {path}")
    candidates = leapc_candidates()
    for candidate in candidates:
        if os.path.isfile(candidate):
            return candidate
    raise RuntimeError(
        "no LeapC library found. Install Ultraleap tracking software (Gemini/Hyperion) or pass --leapc PATH. Looked in: "
        + ", ".join(candidates)
    )


class LeapC:
    """Thin ctypes binding over the handful of LeapC calls the stereo source needs."""

    def __init__(self, path: str) -> None:
        self.path = path
        loader = C.WinDLL if sys.platform == "win32" else C.CDLL
        try:
            self.dll = loader(path)
        except OSError as exc:
            raise RuntimeError(f"could not load LeapC from {path}: {exc}") from exc
        fn = self._fn
        self._create = fn("LeapCreateConnection", [C.c_void_p, C.POINTER(C.c_void_p)], C.c_uint32)
        self._set_allocator = fn("LeapSetAllocator", [C.c_void_p, C.POINTER(_Allocator)], C.c_uint32)
        self._open = fn("LeapOpenConnection", [C.c_void_p], C.c_uint32)
        self._poll = fn("LeapPollConnection", [C.c_void_p, C.c_uint32, C.POINTER(_ConnectionMessage)], C.c_uint32)
        self._set_policy = fn("LeapSetPolicyFlags", [C.c_void_p, C.c_uint64, C.c_uint64], C.c_uint32)
        self._open_device = fn("LeapOpenDevice", [_DeviceRef, C.POINTER(C.c_void_p)], C.c_uint32)
        self._close_device = fn("LeapCloseDevice", [C.c_void_p], None, required=False)
        self._device_info = fn("LeapGetDeviceInfo", [C.c_void_p, C.POINTER(_DeviceInfo)], C.c_uint32)
        self._r2p = fn("LeapRectilinearToPixel", [C.c_void_p, C.c_uint32, _Vector], _Vector)
        self._p2r = fn("LeapPixelToRectilinear", [C.c_void_p, C.c_uint32, _Vector], _Vector)
        self._r2p_ex = fn("LeapRectilinearToPixelEx", [C.c_void_p, C.c_void_p, C.c_uint32, _Vector], _Vector, required=False)
        self._now = fn("LeapGetNow", [], C.c_int64, required=False)
        self._close = fn("LeapCloseConnection", [C.c_void_p], None)
        self._destroy = fn("LeapDestroyConnection", [C.c_void_p], None)

    def _fn(self, name: str, argtypes: list[Any], restype: Any, required: bool = True) -> Any:
        fn = getattr(self.dll, name, None)
        if fn is None:
            if required:
                raise RuntimeError(f"{self.path} does not export {name}; is it a LeapC library?")
            return None
        fn.argtypes, fn.restype = argtypes, restype
        return fn

    @staticmethod
    def rs_name(rs: int) -> str:
        return RS_NAMES.get(int(rs), f"0x{int(rs):08X}")

    def _check(self, what: str, rs: int) -> None:
        if rs != RS_SUCCESS:
            raise RuntimeError(f"{what} failed: {self.rs_name(rs)}")

    def create_connection(self) -> C.c_void_p:
        conn = C.c_void_p()
        self._check("LeapCreateConnection", self._create(None, C.byref(conn)))
        return conn

    def set_allocator(self, conn: C.c_void_p, pool: BufferPool) -> None:
        self._check("LeapSetAllocator", self._set_allocator(conn, C.byref(pool.struct)))

    def open_connection(self, conn: C.c_void_p) -> None:
        self._check("LeapOpenConnection", self._open(conn))

    def poll(self, conn: C.c_void_p, timeout_ms: int, msg: _ConnectionMessage) -> int:
        return int(self._poll(conn, int(timeout_ms), C.byref(msg)))

    def set_policy_flags(self, conn: C.c_void_p, set_flags: int, clear_flags: int = 0) -> int:
        return int(self._set_policy(conn, set_flags, clear_flags))

    def open_device(self, ref: _DeviceRef) -> C.c_void_p | None:
        handle = C.c_void_p()
        rs = self._open_device(ref, C.byref(handle))
        if rs != RS_SUCCESS:
            log.warning("LeapOpenDevice failed: %s", self.rs_name(rs))
            return None
        return handle

    def close_device(self, handle: C.c_void_p) -> None:
        if self._close_device is not None and handle:
            self._close_device(handle)

    def device_info(self, handle: C.c_void_p) -> LeapDeviceInfo:
        info = _DeviceInfo()
        info.size = C.sizeof(_DeviceInfo)
        serial = C.create_string_buffer(64)
        info.serial, info.serial_length = C.cast(serial, C.c_char_p), 64
        rs = self._device_info(handle, C.byref(info))
        if rs == RS_INSUFFICIENT_BUFFER and 0 < info.serial_length < 4096:
            serial = C.create_string_buffer(int(info.serial_length) + 1)
            info.serial, info.serial_length = C.cast(serial, C.c_char_p), len(serial)
            rs = self._device_info(handle, C.byref(info))
        self._check("LeapGetDeviceInfo", rs)
        return LeapDeviceInfo(int(info.type), int(info.baseline), float(info.h_fov), float(info.v_fov), int(info.range), serial.value.decode(errors="replace"), int(info.status), int(info.caps))

    def rectilinear_to_pixel(self, conn: C.c_void_p, camera: int, tx: float, ty: float, device: C.c_void_p | None = None) -> tuple[float, float]:
        if self._r2p_ex is not None and device:
            out = self._r2p_ex(conn, device, camera, _Vector(tx, ty, 1.0))
        else:
            out = self._r2p(conn, camera, _Vector(tx, ty, 1.0))
        return float(out.x), float(out.y)

    def pixel_to_rectilinear(self, conn: C.c_void_p, camera: int, px: float, py: float) -> tuple[float, float, float]:
        out = self._p2r(conn, camera, _Vector(px, py, 0.0))
        return float(out.x), float(out.y), float(out.z)

    def now_us(self) -> int | None:
        return int(self._now()) if self._now is not None else None

    def close_connection(self, conn: C.c_void_p) -> None:
        self._close(conn)

    def destroy_connection(self, conn: C.c_void_p) -> None:
        self._destroy(conn)


# --------------------------------------------------------------------------- #
# The live source
# --------------------------------------------------------------------------- #


@dataclass(frozen=True)
class StereoPair:
    """One raw stereo frame copied out of a LeapC image event."""

    left: np.ndarray
    right: np.ndarray
    matrix_version: int
    frame_id: int
    timestamp: float  # seconds on time.perf_counter()'s clock
    seq: int
    timestamp_us: int = 0  # LeapC's clock, to pair with tracking events


class LeapStereoSource(FrameSource):
    """Depth frames from the controller's stereo infrared images via LeapC, with its hand skeletons.

    ``start()`` loads the library, installs the allocator, opens the
    connection and starts a daemon thread that polls it; ``read()`` waits for
    the newest stereo pair, rectifies it (maps rebuilt whenever the image
    size or ``matrix_version`` changes), runs :class:`leap_stereo.StereoDepth`
    and returns a :class:`DepthFrame` at most ``fps`` times per second (older
    pairs are skipped). Tracking events (no extra policy needed) are kept in
    a short deque; the one nearest the pair's timestamp, within
    ``tracking_window_s``, lends its hands, which :class:`HandProjector` puts
    into the depth image (``hand_frame``: ``"auto"`` or a convention name).
    If no image arrives within ``stall_after`` seconds the
    stall is logged with the fix; after ``restart_after`` seconds ``read()``
    raises so the server reports it to the browser and retries. A poll thread
    that never returns (the 5.0-preview stall) is left alone rather than
    joined, and ``needs_hard_exit`` tells the CLI to ``os._exit`` at the end.
    """

    name = "leap"
    skeleton = True

    def __init__(
        self, dll_path: str | None = None, view: ls.RectifiedView | None = None, params: ls.StereoParams | None = None,
        swap: bool = False, orient: str = "none", fps: float = 30.0, stall_after: float = 3.0, restart_after: float = 20.0,
        poll_timeout_ms: int = 100, sample_step: int = 4, baseline_mm: float | None = None,
        hand_frame: str = "auto", tracking_window_s: float = 0.05,
    ) -> None:
        if orient not in ls.ORIENTATIONS:
            raise ValueError(f"orient must be one of {ls.ORIENTATIONS}")
        if hand_frame != "auto" and hand_frame not in HAND_FRAME_BY_NAME:
            raise ValueError(f"unknown hand frame {hand_frame!r}; use 'auto' or one of {', '.join(HAND_FRAME_NAMES)}")
        self.dll_path = dll_path
        self.view = view or ls.RectifiedView()
        self.params = params or ls.StereoParams()
        self.swap, self.orient = bool(swap), orient
        self.fps = float(fps) if fps and fps > 0 else None
        self.stall_after, self.restart_after = float(stall_after), float(restart_after)
        self.poll_timeout_ms, self.sample_step = int(poll_timeout_ms), int(sample_step)
        self.forced_baseline_mm = baseline_mm
        self.hand_frame = hand_frame
        self.tracking_window_us = int(tracking_window_s * 1e6)
        self.projector: HandProjector | None = None
        self._tracking: deque[TrackingFrame] = deque(maxlen=64)  # ~0.25 s at the service's tracking rate
        self.tracking_frames = 0
        self.last_tracking: TrackingFrame | None = None
        self.last_hands: tuple[TrackedHand, ...] = ()

        self.lib: LeapC | None = None
        self.pool = BufferPool()
        self._conn: C.c_void_p | None = None
        self._device: C.c_void_p | None = None
        self.device_info: LeapDeviceInfo | None = None
        self._thread: threading.Thread | None = None
        self._stop = threading.Event()
        self._cond = threading.Condition()
        self._latest: StereoPair | None = None
        self._consumed_seq = -1
        self._error: str | None = None
        self._seq = 0
        self.rectifier: ls.Rectifier | None = None
        self._maps_key: tuple[int, int, int] | None = None
        self._maps_attempt_at = 0.0
        self.stereo: ls.StereoDepth | None = None
        self._stuck = False
        self._last_return: float | None = None
        self.last_pair: StereoPair | None = None
        self.last_rectified: tuple[np.ndarray, np.ndarray] | None = None
        self.last_depth: np.ndarray | None = None
        self.last_distortion: dict[int, np.ndarray] = {}
        self.events: dict[str, int] = {}
        self.connected = False
        self.policy: int | None = None
        self.policy_at: float | None = None
        self.started_at: float | None = None
        self.image_size: tuple[int, int] | None = None

    # ---- lifecycle -------------------------------------------------------- #

    @property
    def needs_hard_exit(self) -> bool:
        return self._stuck

    def start(self) -> None:
        if self._thread is not None and self._thread.is_alive():
            log.warning("LeapC poll thread from the previous start is still running (stuck inside LeapPollConnection); reusing it")
            return
        path = find_leapc(self.dll_path)
        self.lib = LeapC(path)
        self._stop.clear()
        self._error = None
        conn = self.lib.create_connection()
        self.lib.set_allocator(conn, self.pool)  # before opening: LeapC drops images for clients without an allocator
        self.lib.open_connection(conn)
        self._conn = conn
        self.started_at = time.monotonic()
        self._thread = threading.Thread(target=self._poll_loop, name="leapc-poll", daemon=True)
        self._thread.start()
        log.info("LeapC %s: connection opened, polling (message layout is detected from msg.size)", path)

    def stop(self) -> None:
        self._stop.set()
        thread = self._thread
        if thread is not None:
            thread.join(2.0)
            if thread.is_alive():
                if not self._stuck:
                    self._stuck = True
                    atexit.register(_hard_exit_at_shutdown)  # a normal interpreter exit hangs behind the stuck native call
                log.warning("LeapC poll thread did not return within 2 s (stuck inside LeapPollConnection); leaving the connection open")
                return
        self._thread = None
        if self.lib is not None and self._conn is not None:
            try:
                if self._device:
                    self.lib.close_device(self._device)
                self.lib.close_connection(self._conn)
                self.lib.destroy_connection(self._conn)
            except Exception as exc:  # noqa: BLE001 - never fail on shutdown
                log.warning("closing LeapC: %s", exc)
        self._conn, self._device = None, None
        self.rectifier, self._maps_key = None, None

    # ---- poll thread ------------------------------------------------------ #

    def _count(self, name: str) -> int:
        self.events[name] = self.events.get(name, 0) + 1
        return self.events[name]

    def _poll_loop(self) -> None:
        assert self.lib is not None and self._conn is not None
        msg = _ConnectionMessage()
        layout_logged = False
        while not self._stop.is_set():
            rs = self.lib.poll(self._conn, self.poll_timeout_ms, msg)
            if rs == RS_TIMEOUT:
                continue
            if rs != RS_SUCCESS:
                if self._count(f"rs:{self.lib.rs_name(rs)}") <= 3:
                    log.warning("LeapPollConnection: %s", self.lib.rs_name(rs))
                if rs == RS_NOT_CONNECTED:
                    time.sleep(0.2)
                continue
            if not layout_logged:
                layout_logged = True
                log.info("LEAP_CONNECTION_MESSAGE is %d bytes (%s device_id field)", msg.size, "with" if msg.size >= 20 else "without")
                if msg.size not in (16, 20):
                    log.warning("unexpected LEAP_CONNECTION_MESSAGE size %d: this LeapC may not be packed like LeapC.h (#pragma pack(1)); "
                                "tracking structs (LEAP_HAND 1084 bytes) could be misread, so skeletons are sanity-checked before use", msg.size)
            try:
                self._handle(msg)
            except Exception as exc:  # noqa: BLE001 - keep polling, surface the error to read()
                log.exception("handling LeapC event 0x%x: %s", msg.type, exc)
                self._error = f"{type(exc).__name__}: {exc}"

    def _handle(self, msg: _ConnectionMessage) -> None:
        assert self.lib is not None and self._conn is not None
        kind = int(msg.type)
        name = EVENT_NAMES.get(kind, f"0x{kind:x}")
        n = self._count(name)
        if kind == EVENT_IMAGE:
            if msg.pointer:
                self._on_image(C.cast(msg.pointer, C.POINTER(_ImageEvent)).contents)
            return
        if kind == EVENT_TRACKING:
            if msg.pointer:
                self._on_tracking(C.cast(msg.pointer, C.POINTER(_TrackingEvent)).contents)
            return
        if n == 1:
            log.info("LeapC event %s", name)
        if kind == EVENT_CONNECTION:
            self.connected = True
            self._request_policy("connection")
        elif kind == EVENT_CONNECTION_LOST:
            self.connected = False
            log.warning("LeapC: connection to the tracking service lost")
        elif kind == EVENT_DEVICE and msg.pointer:
            event = C.cast(msg.pointer, C.POINTER(_DeviceEvent)).contents
            handle = self.lib.open_device(event.device)
            if handle:
                try:
                    self.device_info = self.lib.device_info(handle)
                    info = self.device_info
                    log.info("LeapC device: %s serial %s baseline %.1f mm hfov %.0f deg vfov %.0f deg range %.0f mm",
                             info.type_name, info.serial, info.baseline_mm, np.degrees(info.h_fov), np.degrees(info.v_fov), info.range_um / 1000.0)
                except RuntimeError as exc:
                    log.warning("LeapGetDeviceInfo: %s", exc)
                if self._device:
                    self.lib.close_device(self._device)
                self._device = handle
            self._request_policy("device")
        elif kind == EVENT_POLICY and msg.pointer:
            policy = int(C.cast(msg.pointer, C.POINTER(_PolicyEvent)).contents.current_policy)
            changed = policy != self.policy
            self.policy, self.policy_at = policy, time.monotonic()
            if not changed:
                return
            if policy & POLICY_IMAGES:
                log.info("LeapC policy granted: 0x%x (images%s)", policy, " + background frames" if policy & POLICY_BACKGROUND_FRAMES else "; background frames NOT granted: enable 'Allow Background Apps' in the control panel if frames stop when the window loses focus")
            else:
                log.warning("LeapC policy 0x%x does not include images (0x2): enable 'Allow Images' in the Ultraleap control panel", policy)
        elif kind == EVENT_LOG_EVENT and msg.pointer:
            self._log_event(C.cast(msg.pointer, C.POINTER(_LogEvent)).contents)
        elif kind == EVENT_LOG_EVENTS and msg.pointer:
            events = C.cast(msg.pointer, C.POINTER(_LogEvents)).contents
            count = int(events.nEvents)
            for i in range(min(count, 64)):
                self._log_event(events.events[i], quiet=i >= 4)  # the service replays a backlog on connect
            if count > 4:
                log.info("LeapC log: ... %d more service log lines (run with --log-level debug to see them)", count - 4)
        elif kind in (EVENT_DEVICE_LOST, EVENT_DEVICE_FAILURE):
            log.warning("LeapC: %s", name)

    def _log_event(self, event: _LogEvent, quiet: bool = False) -> None:
        text = event.message.decode(errors="replace") if event.message else ""
        level = LOG_SEVERITY.get(int(event.severity), logging.DEBUG)
        log.log(logging.DEBUG if quiet and level < logging.WARNING else level, "LeapC log: %s", text)

    def _request_policy(self, why: str) -> None:
        assert self.lib is not None and self._conn is not None
        rs = self.lib.set_policy_flags(self._conn, POLICY_REQUESTED, 0)
        if rs != RS_SUCCESS:
            log.warning("LeapSetPolicyFlags(images | background) after %s: %s", why, self.lib.rs_name(rs))
        else:
            log.debug("requested policy images | background frames after %s", why)

    def _on_image(self, event: _ImageEvent) -> None:
        assert self.lib is not None
        images: list[np.ndarray] = []
        for side in range(2):
            img = event.image[side]
            p = img.properties
            if not img.data or p.width == 0 or p.height == 0:
                return
            w, h, bpp = int(p.width), int(p.height), max(1, int(p.bpp))
            raw = (C.c_uint8 * (w * h * bpp)).from_address(int(img.data) + int(img.offset))
            arr = np.frombuffer(raw, dtype=np.uint8)
            if bpp == 2:
                arr = (arr.view(np.uint16) >> 8).astype(np.uint8)
            elif bpp != 1:
                arr = arr.reshape(h, w, bpp)[:, :, 0]
            images.append(np.ascontiguousarray(arr.reshape(h, w)).copy())
            if img.distortion_matrix and int(img.matrix_version) != getattr(self, "_distortion_version", None):
                cam = ls.CAMERA_LEFT if side == 0 else ls.CAMERA_RIGHT
                self.last_distortion[cam] = np.frombuffer((C.c_float * (64 * 64 * 2)).from_address(int(img.distortion_matrix)), dtype=np.float32).copy().reshape(64, 64, 2)
        setattr(self, "_distortion_version", int(event.image[0].matrix_version))
        now_us = self.lib.now_us()
        received = time.perf_counter()
        stamp = received - (now_us - int(event.info.timestamp)) / 1e6 if now_us is not None else received
        with self._cond:
            self._seq += 1
            self._latest = StereoPair(images[0], images[1], int(event.image[0].matrix_version), int(event.info.frame_id), stamp, self._seq, int(event.info.timestamp))
            if self._seq == 1:
                self.image_size = (images[0].shape[1], images[0].shape[0])
                log.info("LeapC images: %dx%d, format 0x%x, matrix_version %d", images[0].shape[1], images[0].shape[0], int(event.image[0].properties.format), int(event.image[0].matrix_version))
            self._cond.notify_all()

    def _on_tracking(self, event: _TrackingEvent) -> None:
        frame = read_tracking_event(event)
        with self._cond:
            self._tracking.append(frame)
            self.tracking_frames += 1
            self.last_tracking = frame
            first = self.tracking_frames == 1
        if first:
            log.info("LeapC tracking: first frame (id %d, %d hand(s), %.0f fps): hand skeletons will ride along with the scan", frame.frame_id, len(frame.hands), frame.framerate)

    def _hands_at(self, timestamp_us: int) -> tuple[DeviceHand, ...]:
        """The hands of the tracking frame nearest ``timestamp_us`` (LeapC clock), if one is within the window."""
        with self._cond:
            if not self._tracking:
                return ()
            nearest = min(self._tracking, key=lambda f: abs(f.timestamp_us - timestamp_us))
        if abs(nearest.timestamp_us - timestamp_us) > self.tracking_window_us:
            return ()
        return nearest.hands

    # ---- consumer side ---------------------------------------------------- #

    def state(self) -> str:
        """One line describing where the connection got to, for the stall message."""
        policy = f"0x{self.policy:x}" if self.policy is not None else "not granted"
        device = f"{self.device_info.type_name} {self.device_info.serial}" if self.device_info else "none"
        counts = ", ".join(f"{k}={v}" for k, v in sorted(dict(self.events).items()))  # copy: the poll thread keeps adding keys
        newest = self.last_tracking
        tracking = f"{self.tracking_frames} frames, {len(newest.hands) if newest else 0} hand(s) in the newest"
        hand_frame = self.projector.describe() if self.projector is not None else f"{self.hand_frame} (pending)"
        return (f"connected={self.connected}, device={device}, policy={policy}, images={self._seq}, tracking={tracking}, "
                f"hand frame={hand_frame}, events: {counts or 'none'}")

    def _wait_for_pair(self) -> StereoPair:
        waited_from = time.monotonic()
        stall_logged = False
        while True:
            with self._cond:
                pair = self._latest
                if pair is not None and pair.seq != self._consumed_seq:
                    self._consumed_seq = pair.seq
                    return pair
                self._cond.wait(0.25)
            if self._error:
                error, self._error = self._error, None
                raise RuntimeError(f"LeapC event handling failed: {error}")
            if self._thread is None or not self._thread.is_alive():
                raise RuntimeError("LeapC poll thread is not running")
            elapsed = time.monotonic() - waited_from
            if elapsed >= self.stall_after and not stall_logged:
                stall_logged = True
                log.warning(STALL_MESSAGE.format(elapsed=elapsed, state=self.state()))
            if elapsed >= self.restart_after:
                raise RuntimeError(STALL_MESSAGE.format(elapsed=elapsed, state=self.state()))

    def _ensure_pipeline(self, pair: StereoPair) -> None:
        """Build (or rebuild) the rectifier and matcher for this pair's size, calibration version and baseline.

        ``LeapRectilinearToPixel`` answers NaN until the service has sent the
        calibration (observed on the 5.0 preview even after the device
        event), so a build that lands mostly outside the raw image is not
        kept: it is retried at most once a second until the maps make sense.
        """
        assert self.lib is not None and self._conn is not None
        h, w = pair.left.shape
        current = (w, h, pair.matrix_version)
        if self.rectifier is None or self._maps_key != current:
            now = time.monotonic()
            if self.rectifier is None or now - self._maps_attempt_at >= 1.0:
                self._maps_attempt_at = now
                lib, conn, device = self.lib, self._conn, self._device

                def ray_to_pixel(camera: int, tx: float, ty: float) -> tuple[float, float]:
                    return lib.rectilinear_to_pixel(conn, camera, tx, ty, device)

                started = time.perf_counter()
                rectifier = ls.Rectifier(ray_to_pixel, w, h, self.view, sample_step=self.sample_step)
                cov = rectifier.coverage
                log.info("rectification maps built for %dx%d raw -> %dx%d view (%.0f deg), matrix_version %d, %.0f ms, coverage L %.2f R %.2f",
                         w, h, self.view.width, self.view.height, self.view.hfov_deg, pair.matrix_version, (time.perf_counter() - started) * 1000.0, cov[ls.CAMERA_LEFT], cov[ls.CAMERA_RIGHT])
                if min(cov.values()) >= 0.5:
                    self.rectifier, self._maps_key = rectifier, current
                else:
                    log.warning("LeapRectilinearToPixel placed most of the view outside the raw image (calibration not delivered yet, or --leap-fov too wide); retrying")
                    if self.rectifier is None:
                        self.rectifier, self._maps_key = rectifier, None  # produce (empty) frames rather than none
        baseline = self.forced_baseline_mm or (self.device_info.baseline_mm if self.device_info and self.device_info.baseline_um > 0 else ls.CONTROLLER_BASELINE_MM)
        if self.stereo is None or abs(self.stereo.baseline_mm - baseline) > 1e-6:
            self.stereo = ls.StereoDepth(baseline, self.view.fx, self.params, self.swap)
            log.info("stereo matcher %s: baseline %.1f mm, f %.1f px, %d disparities (near plane %.0f mm), swap=%s",
                     self.stereo.matcher_name, baseline, self.view.fx, self.stereo.num_disparities, self.params.min_depth_mm, self.swap)
        if self.projector is None:
            self.projector = HandProjector(self.view, baseline, self.swap, self.orient, self.hand_frame)
            log.info("hand skeletons projected with hand frame %s", self.projector.describe())
        else:
            self.projector.baseline_mm = baseline  # the detector's tally survives a baseline correction

    def _pace(self) -> None:
        if self.fps and self._last_return is not None:
            due = self._last_return + 1.0 / self.fps
            now = time.monotonic()
            if now < due:
                time.sleep(due - now)

    def read(self) -> DepthFrame:
        if self._thread is None:
            raise RuntimeError("LeapStereoSource.read() before start()")
        self._pace()
        pair = self._wait_for_pair()
        self._ensure_pipeline(pair)
        assert self.rectifier is not None and self.stereo is not None and self.projector is not None
        left, right = self.rectifier.rectify_pair(pair.left, pair.right)
        depth = ls.reorient(self.stereo.compute(left, right), self.orient)
        hands = self.projector.resolve(self._hands_at(pair.timestamp_us), depth)
        self.last_pair, self.last_rectified, self.last_depth, self.last_hands = pair, (left, right), depth, hands
        self._last_return = time.monotonic()
        return DepthFrame(depth, pair.timestamp, hands)

    def frames(self) -> Iterator[DepthFrame]:
        """Depth frames forever (``start()`` first)."""
        while True:
            yield self.read()


# --------------------------------------------------------------------------- #
# The hardware-free source
# --------------------------------------------------------------------------- #


class LeapSyntheticSource(FrameSource):
    """The whole Leap pipeline (raw fisheye pair -> rectify -> match -> depth, plus the skeleton) on a rendered scene.

    :func:`leap_stereo.hand_shapes` scripts a fist and forearm above the
    device; :class:`leap_stereo.FisheyeModel` plays the raw cameras and
    calibration. The skeleton :func:`leap_stereo.hand_skeleton` lays on those
    surfaces is expressed in the device frame under ``true_frame`` (the
    convention the "service" is pretending to use) and then goes through the
    same :class:`HandProjector` as live hands, so ``hand_frame="auto"`` has a
    positive control: the detector must find ``true_frame`` again.
    ``render(t)`` is a pure function of script time (tests); ``read()`` paces
    itself to ``fps`` like the plain synthetic source.
    """

    name = "leap-synthetic"
    skeleton = True

    def __init__(
        self, view: ls.RectifiedView | None = None, params: ls.StereoParams | None = None, swap: bool = False,
        orient: str = "none", fps: float = 30.0, paced: bool = True, raw_model: ls.FisheyeModel | None = None,
        baseline_mm: float = ls.CONTROLLER_BASELINE_MM, speed: float = 1.0, absences: bool = True, sample_step: int = 4,
        hand_frame: str = "auto", true_frame: str = DEFAULT_HAND_FRAME, skeletons: bool = True,
    ) -> None:
        if orient not in ls.ORIENTATIONS:
            raise ValueError(f"orient must be one of {ls.ORIENTATIONS}")
        if fps <= 0:
            raise ValueError("fps must be positive")
        if true_frame not in HAND_FRAME_BY_NAME:
            raise ValueError(f"unknown true hand frame {true_frame!r}; one of {', '.join(HAND_FRAME_NAMES)}")
        self.view = view or ls.RectifiedView()
        self.params = params or ls.StereoParams()
        self.swap, self.orient, self.fps, self.paced = bool(swap), orient, float(fps), paced
        self.raw_model = raw_model or ls.FisheyeModel()
        self.baseline_mm, self.speed, self.absences = float(baseline_mm), float(speed), absences
        self.rectifier = ls.Rectifier(self.raw_model.ray_to_pixel, self.raw_model.width, self.raw_model.height, self.view, sample_step=sample_step)
        self.stereo = ls.StereoDepth(self.baseline_mm, self.view.fx, self.params, self.swap)
        self.projector = HandProjector(self.view, self.baseline_mm, self.swap, self.orient, hand_frame)
        self.true_frame = HAND_FRAME_BY_NAME[true_frame]
        self.skeletons = bool(skeletons)
        self._origin: float | None = None
        self._next_due = 0.0
        self.last_pair: tuple[np.ndarray, np.ndarray] | None = None
        self.last_rectified: tuple[np.ndarray, np.ndarray] | None = None
        self.last_depth: np.ndarray | None = None
        self.last_hands: tuple[TrackedHand, ...] = ()

    def start(self) -> None:
        self._origin = None

    def scene(self, t: float) -> ls.SyntheticStereoScene:
        return ls.SyntheticStereoScene(ls.hand_shapes(t, self.absences), self.baseline_mm)

    @property
    def reference_camera(self) -> int:
        """The camera whose view the depth image is in: the matcher's first image."""
        return ls.CAMERA_RIGHT if self.swap else ls.CAMERA_LEFT

    def device_hands(self, t: float) -> tuple[DeviceHand, ...]:
        """The scripted skeleton as LeapC would report it under ``true_frame``: device millimetres."""
        skeleton = ls.hand_skeleton(t, self.absences)
        if skeleton is None:
            return ()
        camera = skeleton.points - self.scene(t).camera_origin(self.reference_camera)  # the scene frame IS the reference camera's frame
        joints = self.true_frame.camera_to_device(camera, self.true_frame.reference_sign(self.swap), self.baseline_mm)
        hand = DeviceHand(id=1, type="right", confidence=1.0, grab_strength=1.0, pinch_strength=0.0, joints=joints, widths_mm=skeleton.widths_mm.copy(), extended=skeleton.extended.copy())
        return (hand,)

    def render(self, t: float) -> np.ndarray:
        """Depth image (uint16 mm, reoriented) at script time ``t``; the raw and rectified pairs are kept in ``last_*``."""
        raw_left, raw_right = self.scene(t).raw_pair(self.raw_model)
        left, right = self.rectifier.rectify_pair(raw_left, raw_right)
        depth = ls.reorient(self.stereo.compute(left, right), self.orient)
        self.last_pair, self.last_rectified, self.last_depth = (raw_left, raw_right), (left, right), depth
        return depth

    def tracked_hands(self, t: float, depth: np.ndarray) -> tuple[TrackedHand, ...]:
        """The skeleton at ``t`` projected into ``depth``'s frame (scoring the detector on the way while it is unlocked)."""
        hands = self.projector.resolve(self.device_hands(t), depth)
        self.last_hands = hands
        return hands

    def frame_at(self, t: float, timestamp: float | None = None) -> DepthFrame:
        depth = self.render(t)
        hands = self.tracked_hands(t, depth) if self.skeletons else None
        return DepthFrame(depth, t if timestamp is None else timestamp, hands)

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
        return self.frame_at((now - self._origin) * self.speed, now)


# --------------------------------------------------------------------------- #
# CLI: dump images for inspection
# --------------------------------------------------------------------------- #


def _write_png(path: str, image: np.ndarray) -> None:
    import cv2  # local: leap_stereo already requires it

    if not cv2.imwrite(path, image):
        raise RuntimeError(f"could not write {path}")


def depth_preview(depth: np.ndarray, near_mm: float, far_mm: float) -> np.ndarray:
    """8-bit picture of a depth map: black = no measurement, dark = near plane, bright = far plane, white = beyond."""
    scaled = np.clip((depth.astype(np.float32) - near_mm) / max(far_mm - near_mm, 1.0), 0.0, 1.0)
    preview = (32 + 223 * scaled).astype(np.uint8)
    preview[depth == 0] = 0
    return preview


def dump_images(source: LeapStereoSource | LeapSyntheticSource, count: int, out_dir: str, near_mm: float, far_mm: float) -> int:
    """Read ``count`` frames and write ``leap_NNN_{left,right,depth,depth_preview}.png`` (plus raw frames when live)."""
    os.makedirs(out_dir, exist_ok=True)
    source.start()
    written = 0
    try:
        for i in range(count):
            frame = source.read()
            assert source.last_rectified is not None and source.last_depth is not None
            left, right = source.last_rectified
            depth = frame.depth_mm
            stem = os.path.join(out_dir, f"leap_{i:03d}")
            _write_png(stem + "_left.png", left)
            _write_png(stem + "_right.png", right)
            _write_png(stem + "_depth.png", depth)
            _write_png(stem + "_depth_preview.png", depth_preview(depth, near_mm, far_mm))
            if isinstance(source, LeapStereoSource) and source.last_pair is not None:
                _write_png(stem + "_raw_left.png", source.last_pair.left)
                _write_png(stem + "_raw_right.png", source.last_pair.right)
                for cam, matrix in source.last_distortion.items():
                    np.save(os.path.join(out_dir, f"leap_distortion_{'left' if cam == ls.CAMERA_LEFT else 'right'}.npy"), matrix)
            inbox = int(((depth >= near_mm) & (depth <= far_mm)).sum())
            valid = int((depth > 0).sum())
            stereo = source.stereo
            assert stereo is not None
            other = ls.StereoDepth(stereo.baseline_mm, stereo.focal_px, stereo.params, not stereo.swap).compute(left, right)
            inbox_other = int(((other >= near_mm) & (other <= far_mm)).sum())
            hint = ""
            if inbox_other > 2 * max(inbox, 50):
                hint = " <- the OTHER camera order puts far more pixels in the box: " + ("drop" if stereo.swap else "add") + " --swap-cameras"
            log.info("frame %d: %dx%d, %d valid px, %d in [%.0f, %.0f] mm (swapped order: %d)%s, left mean %.1f",
                     i, depth.shape[1], depth.shape[0], valid, inbox, near_mm, far_mm, inbox_other, hint, float(left.mean()))
            hands = frame.hands or ()
            if hands:
                on_scan = sum(joint_hits(h.joints[SCORED_JOINTS], depth, 30.0) for h in hands)
                log.info("frame %d: %d tracked hand(s), %d of %d joints on a scan pixel within 30 mm, hand frame %s",
                         i, len(hands), on_scan, len(hands) * len(SCORED_JOINTS), source.projector.describe() if source.projector else "n/a")
            written += 1
    finally:
        source.stop()
    projector = source.projector
    if projector is not None and projector.detector is not None:
        log.info("%s", projector.detector.table())
    elif projector is not None:
        log.info("hand frame %s", projector.describe())
    log.info("wrote %d frame(s) to %s", written, out_dir)
    return written


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="Leap Motion Controller stereo -> depth: dump rectified pairs and depth maps as PNGs.")
    p.add_argument("--dump-images", type=int, default=3, metavar="N", help="frames to write (default: %(default)s)")
    p.add_argument("--out", default=os.path.join("test-results", "leap"), help="output directory (default: %(default)s)")
    p.add_argument("--synthetic", action="store_true", help="use the rendered scene instead of hardware")
    p.add_argument("--leapc", metavar="PATH", help="LeapC library (default: search Ultraleap, then Leap Motion Core Services, then $LEAPC_DLL)")
    p.add_argument("--view", type=int, nargs=2, default=(320, 240), metavar=("W", "H"), help="rectified view size (default: 320 240)")
    p.add_argument("--fov", type=float, default=90.0, metavar="DEG", help="horizontal field of view of the view (default: %(default)s)")
    p.add_argument("--near", type=float, default=0.1, metavar="M", help="near plane in metres, sets the disparity range (default: %(default)s)")
    p.add_argument("--far", type=float, default=0.45, metavar="M", help="far plane in metres, for the preview and the in-box count (default: %(default)s)")
    p.add_argument("--min-intensity", type=int, default=16, help="ignore IR pixels darker than this, 0..255 (default: %(default)s)")
    p.add_argument("--swap-cameras", action="store_true", help="exchange the cameras before matching")
    p.add_argument("--orient", choices=ls.ORIENTATIONS, default="none", help="rotate/flip the depth image (default: none)")
    p.add_argument("--hand-frame", default="auto", metavar="MODE", help="device-to-image convention for the hand skeleton: auto (default, prints the candidate table) or one of " + ", ".join(HAND_FRAME_NAMES))
    p.add_argument("--fps", type=float, default=30.0, help="frame pacing (default: %(default)s)")
    p.add_argument("--timeout", type=float, default=40.0, metavar="S", help="hard exit after this many seconds, in case LeapC stalls (default: %(default)s)")
    p.add_argument("--log-level", default="info", choices=("debug", "info", "warning", "error"))
    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    logging.basicConfig(level=getattr(logging, args.log_level.upper()), stream=sys.stderr, format="%(asctime)s %(levelname)s %(message)s")

    def watchdog() -> None:
        log.error("watchdog: %.0f s elapsed (LeapC stalled?); exiting hard", args.timeout)
        sys.stderr.flush()
        os._exit(3)

    if args.timeout > 0:
        timer = threading.Timer(args.timeout, watchdog)
        timer.daemon = True
        timer.start()
    view = ls.RectifiedView.from_fov(args.view[0], args.view[1], args.fov)
    params = ls.StereoParams(min_depth_mm=args.near * 1000.0, min_intensity=args.min_intensity)
    source: LeapStereoSource | LeapSyntheticSource
    code = 0
    try:
        if args.synthetic:
            source = LeapSyntheticSource(view, params, args.swap_cameras, args.orient, fps=args.fps, paced=False, hand_frame=args.hand_frame)
        else:
            source = LeapStereoSource(args.leapc, view, params, args.swap_cameras, args.orient, fps=args.fps, hand_frame=args.hand_frame)
        dump_images(source, args.dump_images, args.out, args.near * 1000.0, args.far * 1000.0)
    except (RuntimeError, ValueError) as exc:
        log.error("%s", exc)
        code = 1
    sys.stderr.flush()
    sys.stdout.flush()
    os._exit(code)  # never wait on a LeapC thread at interpreter shutdown


if __name__ == "__main__":
    main()
