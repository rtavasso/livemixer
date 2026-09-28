"""Extract the living installation's Live devices from a hand-built set into a builder template.

Reads a set saved by Live that has the layout of the Back To Us sets (song groups with DRUM FX /
TEXTURE FX / VOCALS, DUB THROW and HALO BLOOM returns, Space / Mix Gain / Limiter / Two Song FX on
Main) and writes scripts/ableton-templates/living.xml, which scripts/ableton_set/als.py uses:

  TextureFilter  the TEXTURE FX Auto Filter ("Velvet Dive")
  VocalPresence  the VOCALS Utility ("Vocal Presence", MIDI CC20 on channel 16)
  Returns        the two return tracks (A: dub echo, B: halo reverb)
  Main           Space reverb (CC21), Mix Gain utility (CC23), limiter, and the FX Max device
                 (re-pointed to LiveMixer Living FX when a set is written)

Run: python3 scripts/extract-living-templates.py ["~/Music/LiveMixer/Back To Us Project/LiveMixer - Drum Transition.als"]
"""
import gzip
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

DEFAULT = Path.home() / "Music/LiveMixer/Back To Us Project/LiveMixer - Drum Transition.als"
OUT = Path(__file__).resolve().parent / "ableton-templates" / "living.xml"


def named(tracks, name):
    return next(t for t in tracks if t.find("Name/EffectiveName").get("Value") == name)


def main(source):
    live_set = ET.fromstring(gzip.open(source, "rt", encoding="utf-8").read()).find("LiveSet")
    tracks = list(live_set.find("Tracks"))
    root = ET.Element("LivingTemplates", Source=Path(source).name)
    ET.SubElement(root, "TextureFilter").append(named(tracks, "TEXTURE FX").find("DeviceChain/DeviceChain/Devices/AutoFilter2"))
    ET.SubElement(root, "VocalPresence").append(named(tracks, "VOCALS").find("DeviceChain/DeviceChain/Devices/StereoGain"))
    returns = ET.SubElement(root, "Returns")
    for track in live_set.findall("Tracks/ReturnTrack"):
        returns.append(track)
    main_chain = ET.SubElement(root, "Main")
    for device in live_set.find("MainTrack/DeviceChain/DeviceChain/Devices"):
        ref = device.find("PatchSlot/Value/MxPatchRef/FileRef/Path")
        if device.tag == "MxDeviceAudioEffect" and (ref is None or "Two Song FX" not in ref.get("Value")):
            continue  # the stutter: no one-shots in the living installation
        main_chain.append(device)
    ET.indent(root, space=" ")
    OUT.write_text(ET.tostring(root, encoding="unicode") + "\n", encoding="utf-8")
    print(f"{OUT}: {[d.tag for d in main_chain]}, {len(returns)} returns")


if __name__ == "__main__":
    main(Path(sys.argv[1]).expanduser() if len(sys.argv) > 1 else DEFAULT)
