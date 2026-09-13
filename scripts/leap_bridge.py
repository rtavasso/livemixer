"""Local LeapC reader. Emits palm positions as JSON lines; never captures images.

Uses the installed Ultraleap SDK ABI (LeapC.h, packed structs), no pip packages.
The Vite plugin owns this child process and the same-origin browser connection.
"""
import argparse
import ctypes as c
import json
import math
import os
from pathlib import Path
import sys
import time


class Packed(c.Structure):
    _pack_ = 1


class Vector(Packed):
    _fields_ = [(axis, c.c_float) for axis in ("x", "y", "z")]


class Quaternion(Packed):
    _fields_ = [(axis, c.c_float) for axis in ("x", "y", "z", "w")]


class Bone(Packed):
    _fields_ = [("prev", Vector), ("next", Vector), ("width", c.c_float), ("rotation", Quaternion)]


class Digit(Packed):
    _fields_ = [("id", c.c_int32), ("bones", Bone * 4), ("extended", c.c_uint32)]


class Palm(Packed):
    _fields_ = [("position", Vector), ("stabilized", Vector), ("velocity", Vector), ("normal", Vector),
                ("width", c.c_float), ("direction", Vector), ("orientation", Quaternion)]


class Hand(Packed):
    _fields_ = [("id", c.c_uint32), ("flags", c.c_uint32), ("type", c.c_uint32),
                ("confidence", c.c_float), ("visible_time", c.c_uint64),
                ("pinch_distance", c.c_float), ("grab_angle", c.c_float),
                ("pinch_strength", c.c_float), ("grab_strength", c.c_float),
                ("palm", Palm), ("digits", Digit * 5), ("arm", Bone)]


class FrameHeader(Packed):
    _fields_ = [("reserved", c.c_void_p), ("frame_id", c.c_int64), ("timestamp", c.c_int64)]


class Tracking(Packed):
    _fields_ = [("info", FrameHeader), ("frame_id", c.c_int64), ("count", c.c_uint32),
                ("hands", c.POINTER(Hand)), ("framerate", c.c_float)]


class Message(Packed):
    _fields_ = [("size", c.c_uint32), ("type", c.c_uint32), ("pointer", c.c_void_p), ("device_id", c.c_uint32)]


class ConnectionConfig(Packed):
    _fields_ = [("size", c.c_uint32), ("flags", c.c_uint32), ("namespace", c.c_char_p), ("origin", c.c_uint32)]


class DeviceRef(Packed):
    _fields_ = [("handle", c.c_void_p), ("id", c.c_uint32)]


class DeviceEvent(Packed):
    _fields_ = [("flags", c.c_uint32), ("device", DeviceRef), ("status", c.c_uint32)]


class DeviceStatus(Packed):
    _fields_ = [("device", DeviceRef), ("previous", c.c_uint32), ("status", c.c_uint32)]


PROFILES = {
    "balanced": [],
    "responsive": ["high_hand_fidelity"],
    "bright-room": ["high_background_illumination", "high_hand_fidelity"],
}


def emit(**data):
    print(json.dumps({**data, "sentAtMs": time.time() * 1000}, allow_nan=False), flush=True)


def library():
    if sys.platform != "win32" or c.sizeof(c.c_void_p) != 8:
        raise RuntimeError("Leap input currently needs Windows and 64-bit Python. Mouse preview works on any desktop.")
    folder = Path(os.environ.get("ProgramFiles", "C:/Program Files"))
    candidates = [Path(os.environ["LEAPC_DLL"])] if os.environ.get("LEAPC_DLL") else [
        folder / "Ultraleap/LeapSDK/lib/x64/LeapC.dll",
        folder / "Leap Motion/Core Services/LeapC.dll",
    ]
    path = next((p for p in candidates if p.is_file()), None)
    if path is None:
        raise RuntimeError("LeapC.dll was not found. Install Ultraleap Hand Tracking, or set LEAPC_DLL to its full path.")
    dll = c.WinDLL(str(path))
    signatures = {
        "LeapCreateConnection": ([c.c_void_p, c.POINTER(c.c_void_p)], c.c_uint32),
        "LeapOpenConnection": ([c.c_void_p], c.c_uint32),
        "LeapPollConnection": ([c.c_void_p, c.c_uint32, c.POINTER(Message)], c.c_uint32),
        "LeapSetTrackingMode": ([c.c_void_p, c.c_uint32], c.c_uint32),
        "LeapGetNow": ([], c.c_int64),
        "LeapCloseConnection": ([c.c_void_p], None),
        "LeapDestroyConnection": ([c.c_void_p], None),
    }
    for name, (args, result) in signatures.items():
        function = getattr(dll, name)
        function.argtypes, function.restype = args, result
    optional = {
        "LeapOpenDevice": ([DeviceRef, c.POINTER(c.c_void_p)], c.c_uint32),
        "LeapCloseDevice": ([c.c_void_p], None),
        "LeapSetPrimaryDevice": ([c.c_void_p, c.c_void_p, c.c_bool], c.c_uint32),
        "LeapSetDeviceHints": ([c.c_void_p, c.c_void_p, c.POINTER(c.c_char_p)], c.c_uint32),
        "LeapSetTrackingModeEx": ([c.c_void_p, c.c_void_p, c.c_uint32], c.c_uint32),
        "LeapGetDeviceFrameRateEx": ([c.c_void_p, c.c_void_p, c.POINTER(c.c_float)], c.c_uint32),
    }
    for name, (args, result) in optional.items():
        if hasattr(dll, name):
            function = getattr(dll, name)
            function.argtypes, function.restype = args, result
    return dll


def run(seconds=0, profile="responsive"):
    dll = library()
    connection = c.c_void_p()
    modern = all(hasattr(dll, name) for name in ("LeapSetDeviceHints", "LeapSetPrimaryDevice", "LeapOpenDevice", "LeapCloseDevice", "LeapSetTrackingModeEx"))
    config = ConnectionConfig(c.sizeof(ConnectionConfig), 1, None, 0)  # Multi-device aware, sensor-centered coordinates.
    device = c.c_void_p()
    device_id = None
    device_status = None
    tracking_fps = None
    hints_accepted = False
    for result in [dll.LeapCreateConnection(c.byref(config) if modern else None, c.byref(connection))]:
        if result:
            raise RuntimeError(f"Cannot create Leap connection (0x{result:08x}).")
    try:
        result = dll.LeapOpenConnection(connection)
        if result:
            raise RuntimeError(f"Cannot open Leap connection (0x{result:08x}).")
        started = last_status = last_health = time.monotonic()
        last_output = 0
        sequence = 0
        status = "Connecting to Ultraleap service..."
        emit(type="status", message=status)
        while not seconds or time.monotonic() - started < seconds:
            message = Message()
            message.size = c.sizeof(Message)
            result = dll.LeapPollConnection(connection, 100, c.byref(message))
            now = time.monotonic()
            if result == 0 and message.type == 1:
                result = 0 if modern else dll.LeapSetTrackingMode(connection, 0)
                if result:
                    raise RuntimeError(f"Cannot select tabletop tracking (0x{result:08x}).")
                status = "Service connected. Waiting for sensor frames."
                emit(type="status", message=status)
            elif result == 0 and message.type == 2:
                status = "Ultraleap service disconnected. Waiting to reconnect."
                emit(type="status", message=status)
                if device:
                    dll.LeapCloseDevice(device)
                    device = c.c_void_p()
                device_id = device_status = tracking_fps = None
            elif result == 0 and message.type == 3 and message.pointer:
                event = c.cast(message.pointer, c.POINTER(DeviceEvent)).contents
                if device_id is not None:  # Keep one sensor; never mix coordinate systems.
                    continue
                device_id, device_status = int(event.device.id), int(event.status)
                if modern:
                    result = dll.LeapOpenDevice(event.device, c.byref(device))
                    if not result:
                        result = dll.LeapSetPrimaryDevice(connection, device, True)
                    if not result:
                        result = dll.LeapSetTrackingModeEx(connection, device, 0)
                    if result:
                        raise RuntimeError(f"Cannot prepare Leap sensor (0x{result:08x}).")
                    hints = PROFILES[profile]
                    values = (c.c_char_p * (len(hints) + 1))(*[hint.encode() for hint in hints], None)
                    hints_accepted = dll.LeapSetDeviceHints(connection, device, values) == 0
                emit(type="health", deviceStatus=device_status, profile=profile, hintsAccepted=hints_accepted)
            elif result == 0 and message.type == 0x104:
                if message.device_id not in (0, device_id):
                    continue
                if device:
                    dll.LeapCloseDevice(device)
                    device = c.c_void_p()
                device_id = device_status = tracking_fps = None
                emit(type="status", message="Leap sensor disconnected. Waiting for it to reconnect.")
            elif result == 0 and message.type == 0x107 and message.pointer:
                event = c.cast(message.pointer, c.POINTER(DeviceStatus)).contents
                if int(event.device.id) == device_id:
                    device_status = int(event.status)
            elif result == 0 and message.type == 0x100 and message.pointer:
                if message.device_id not in (0, device_id) or now - last_output < 1 / 60:
                    continue
                frame = c.cast(message.pointer, c.POINTER(Tracking)).contents
                tracking_fps = float(frame.framerate) if math.isfinite(frame.framerate) and frame.framerate > 0 else None
                if frame.count > 16 or (frame.count and not frame.hands):
                    raise RuntimeError("Unexpected Leap frame layout. Check the installed SDK version.")
                palms = []
                for i in range(frame.count):
                    hand = frame.hands[i]
                    p = hand.palm.position
                    if all(math.isfinite(v) for v in (p.x, p.y, p.z)):
                        palms.append({"id": int(hand.id), "x": float(p.x), "y": float(p.y), "z": float(p.z),
                                      "type": int(hand.type), "visibleMs": int(hand.visible_time) / 1000})
                # Copy all native data before the next LeapPollConnection invalidates it.
                sequence += 1
                emit(type="frame", sequence=sequence, ageMs=max(0, (dll.LeapGetNow() - frame.info.timestamp) / 1000), trackingFps=tracking_fps, palms=palms)
                last_output = last_status = now
                status = "No recent sensor frames. Check the Leap connection and tracking service."
            elif result not in (0, 0xE2010004):  # Normal poll timeout.
                status = f"Waiting for Ultraleap service (0x{result:08x})."
            if now - last_health > 1:
                camera_fps = c.c_float()
                camera_rate = None
                if device and hasattr(dll, "LeapGetDeviceFrameRateEx"):
                    if dll.LeapGetDeviceFrameRateEx(connection, device, c.byref(camera_fps)) == 0 and math.isfinite(camera_fps.value) and camera_fps.value > 0:
                        camera_rate = camera_fps.value
                emit(type="health", cameraFps=camera_rate, trackingFps=tracking_fps, deviceStatus=device_status,
                     profile=profile, hintsAccepted=hints_accepted)
                last_health = now
            if now - last_status > 1:
                emit(type="status", message=status)
                last_status = now
    finally:
        if device:
            # Hints belong to this connection; do not rewrite service configuration.
            dll.LeapSetDeviceHints(connection, device, (c.c_char_p * 1)(None))
            dll.LeapCloseDevice(device)
        dll.LeapCloseConnection(connection)
        dll.LeapDestroyConnection(connection)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--seconds", type=float, default=0, help="Bounded connection check; zero runs until stopped")
    parser.add_argument("--profile", choices=PROFILES, default="responsive")
    try:
        args = parser.parse_args()
        run(args.seconds, args.profile)
    except (KeyboardInterrupt, BrokenPipeError):
        pass
    except Exception as error:
        emit(type="error", message=str(error))
        sys.exit(1)
