"""Build LiveMixer Living FX.amxd from the Two Song FX device.

Same dials, OSC input (UDP 7403) and parameters, so a Live set can carry it
in place of the Two Song FX device; the script becomes living-fx.js (every
song group of a generated stem set, no one-shots) and a udpsend reports
Live's position to the bridge on UDP 7401 for the simulation page.
Run: python3 scripts/build-living-fx.py
"""
import json
import struct
from pathlib import Path

root = Path(__file__).resolve().parent.parent
source = root / "devices/LiveMixer Two Song Controls/LiveMixer Two Song FX.amxd"
out = root / "devices/LiveMixer Living FX"


def unpack(path):
    data = path.read_bytes()
    i = data.index(b"ptch")
    return json.loads(data[i + 8:].rstrip(b"\0\n"))


def save(path, patch):
    raw = (json.dumps(patch, indent=2) + "\n\0").encode()
    path.write_bytes(b"ampf" + struct.pack("<I", 4) + b"aaaa" + b"meta" + struct.pack("<II", 4, 0)
                     + b"ptch" + struct.pack("<I", len(raw)) + raw)


def build():
    patch = unpack(source)
    q = patch["patcher"]
    for item in q["boxes"]:
        box = item["box"]
        if box.get("id") == "js":
            box["text"] = "js living-fx.js"
            box["numoutlets"] = 3
            box["outlettype"] = ["", "", ""]
        elif box.get("id") == "title":
            box["text"] = "LIVEMIXER · LIVING FX"
        elif box.get("id") == "description":
            box["text"] = "The box reshapes the song. Words stay clear."
    q["boxes"].append({"box": {"id": "state", "maxclass": "newobj", "text": "udpsend 127.0.0.1 7401",
                               "numinlets": 1, "numoutlets": 0, "patching_rect": [560, 620, 150, 22]}})
    q["lines"].append({"patchline": {"source": ["js", 2], "destination": ["state", 0]}})
    q["dependency_cache"] = [dict(name="living-fx.js", patcherrelativepath=".", type="TEXT", implicit=1)]
    out.mkdir(parents=True, exist_ok=True)
    save(out / "LiveMixer Living FX.amxd", patch)
    return out / "LiveMixer Living FX.amxd"


if __name__ == "__main__":
    print(build())
