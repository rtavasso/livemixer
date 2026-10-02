#!/usr/bin/env python3
"""Make Live 11 versions of the stem-set templates (ableton-templates/live11/) from Live 11's own files.

Live 11 cannot open sets saved by Live 12, so ableton-stem-set.py --live 11 builds from these instead:

  stem-set.als  Live 11's default set with its two returns, a group track from the Podcast template and
                one audio track routed into it, holding an audio clip from the Live 11 demo song
  eq-three.xml  EQ Three
  living.xml    the installation's devices and returns

Every device comes from a Live 11 Core Library preset, with each parameter (and MIDI mapping) copied from
the Live 12 template where Live 11 has the same parameter. Live 12's Auto Filter has no Live 11
counterpart; its place is taken by Live 11's Auto Filter as an open low-pass that LiveMixer Living FX
closes for "dive". The Max device keeps its Live 12 form, less what only Live 12 knows.

  python3 scripts/make-live11-templates.py --live11 "C:/ProgramData/Ableton/Live 11 Suite/Resources"
"""
import argparse
import copy
import gzip
import xml.etree.ElementTree as ET
from pathlib import Path

TEMPLATES = Path(__file__).resolve().parent / "ableton-templates"
OUT = TEMPLATES / "live11"
PRESETS = {  # Live 11 Core Library preset for each device
    "FilterEQ3": "EQ Three/Boost HiHats.adv",
    "AutoFilter": "Auto Filter/Bandpass Spinner.adv",
    "StereoGain": "Utility/Bass Mono.adv",
    "Echo": "Echo/Ambient Spaces/Diffused Long Cascades.adv",
    "Hybrid": "Hybrid Reverb/Drums/Clap Hybrid.adv",
    "Reverb": "Reverb/Hall/Ballad Reverb.adv",
    "Limiter": "Limiter/Fast.adv",
}
LIVE11_FILTER = {"FilterType": 0, "CircuitLpHp": 0, "Cutoff": 135, "Resonance": 0.1, "Drive": 0, "ModHub": 0, "LfoAmount": 0}
MX_LIVE12_ONLY = {"BreakoutIsExpanded", "MpePitchBendUsesTuning", "ViewData", "AudioOutputsListWrapper",
                  "AudioInputsListWrapper", "MidiOutputsListWrapper", "MidiInputsListWrapper", "MpeTuningEnabled",
                  "IsStored", "IsUndoable", "SourceHint"}
# Leaves that identify a device or point at files rather than set how it sounds
NOT_PORTED = {"LomId", "LomIdView", "OverwriteProtectionNumber", "ModulationSourceCount", "LastSelectedTimeableIndex",
              "LastSelectedClipEnvelopeIndex", "IsExpanded", "PointeeId"}
NOT_PORTED_UNDER = {"LastPresetRef", "SourceContext", "FileRef", "SampleRef", "ParametersListWrapper", "Pointee"}


def gz(path):
    with gzip.open(path, "rb") as f:
        return ET.fromstring(f.read())


def paths(element):
    """{relative tag path: element} for every descendant, first occurrence of each path."""
    out = {}

    def walk(node, prefix):
        counts = {}
        for child in node:
            counts[child.tag] = counts.get(child.tag, 0) + 1
            key = f"{prefix}/{child.tag}" + (f"[{counts[child.tag]}]" if counts[child.tag] > 1 else "")
            out.setdefault(key, child)
            if child.tag not in NOT_PORTED_UNDER:
                walk(child, key)

    walk(element, "")
    return out


def strip_mappings(device):
    for node in device.iter():
        for key_midi in node.findall("KeyMidi"):
            node.remove(key_midi)


def port(live12, live11):
    """Copy every setting Live 11's device shares with Live 12's: leaf values and MIDI mappings."""
    device = copy.deepcopy(live11)
    strip_mappings(device)
    device.attrib.update({k: v for k, v in live12.attrib.items() if k == "Id"})
    source = paths(live12)
    for key, node in paths(device).items():
        if node.tag in NOT_PORTED or len(node) or "Value" not in node.attrib:
            continue
        theirs = source.get(key)
        if theirs is not None and "Value" in theirs.attrib and not len(theirs):
            node.set("Value", theirs.get("Value"))
    for key, node in paths(device).items():  # MIDI mappings (Vocal Presence's CC20)
        theirs = source.get(key)
        if theirs is not None and theirs.find("KeyMidi") is not None and node.find("Manual") is not None:
            index = list(theirs).index(theirs.find("KeyMidi"))
            node.insert(min(index, len(node)), copy.deepcopy(theirs.find("KeyMidi")))
    return device


class Builder:
    def __init__(self, live11):
        self.res = Path(live11)
        self.presets = {}
        for tag, rel in PRESETS.items():
            root = gz(self.res / "Core Library/Devices/Audio Effects" / rel)
            self.presets[tag] = root.find(tag) if root.tag != tag else root

    def device(self, live12):
        if live12.tag == "AutoFilter2":
            device = copy.deepcopy(self.presets["AutoFilter"])
            strip_mappings(device)
            device.set("Id", live12.get("Id", "0"))
            for tag in ("UserName", "IsFolded"):
                device.find(tag).set("Value", live12.find(tag).get("Value"))
            device.find("On/Manual").set("Value", live12.find("On/Manual").get("Value"))
            for tag, value in LIVE11_FILTER.items():
                device.find(tag + "/Manual").set("Value", str(value))
            return device
        if live12.tag == "MxDeviceAudioEffect":
            device = copy.deepcopy(live12)
            for node in device.iter():
                for child in list(node):
                    if child.tag in MX_LIVE12_ONLY:
                        node.remove(child)
            ref = device.find("PatchSlot/Value/MxPatchRef")
            ref.tag = "MxDPatchRef"  # Live 11's name; its file reference is type 1 and has no SourceHint
            ref.find("FileRef/Type").set("Value", "1")
            return device
        return port(live12, self.presets[live12.tag])

    def return_track(self, live12, live11):
        """Live 11's return track carrying the Live 12 return's name, colour, mixer settings and devices."""
        track = copy.deepcopy(live11)
        for key in ("Name/EffectiveName", "Name/UserName", "Color"):
            track.find(key).set("Value", live12.find(key).get("Value"))
        mixer = port(live12.find("DeviceChain/Mixer"), track.find("DeviceChain/Mixer"))
        chain = track.find("DeviceChain")
        chain.remove(chain.find("Mixer"))
        chain.insert(list(live11.find("DeviceChain")).index(live11.find("DeviceChain/Mixer")), mixer)
        devices = track.find("DeviceChain/DeviceChain/Devices")
        devices[:] = [self.device(d) for d in live12.find("DeviceChain/DeviceChain/Devices")]
        return track

    def stem_set(self):
        root = gz(self.res / "Builtin/Templates/DefaultLiveSet.als")
        live_set = root.find("LiveSet")
        tracks = live_set.find("Tracks")
        audio = [t for t in tracks if t.tag == "AudioTrack"]
        for t in list(tracks):
            if t.tag == "MidiTrack" or (t.tag == "AudioTrack" and t is not audio[0]):
                tracks.remove(t)
        stem = audio[0]
        podcast = gz(self.res / "Core Library/Templates/Podcast Template.als").find("LiveSet/Tracks")
        group = copy.deepcopy(podcast.find("GroupTrack"))
        group.find("DeviceChain/DeviceChain/Devices")[:] = []
        group_mixer = group.find("DeviceChain/Mixer")
        sends = group_mixer.find("Sends")
        sends[:] = [copy.deepcopy(s) for s in stem.find("DeviceChain/Mixer/Sends")]
        next_pointee = int(live_set.find("NextPointeeId").get("Value"))
        for node in group.iter():
            if "Id" in node.attrib and (node.tag.endswith("Target") or node.tag == "Pointee"):
                node.set("Id", str(next_pointee))
                next_pointee += 1
        live_set.find("NextPointeeId").set("Value", str(next_pointee))
        group.set("Id", str(1 + max(int(t.get("Id")) for t in tracks)))
        group.find("TrackGroupId").set("Value", "-1")
        stem.find("TrackGroupId").set("Value", group.get("Id"))
        routed = next(t for t in podcast if t.tag == "AudioTrack")
        chain = stem.find("DeviceChain")
        index = list(chain).index(chain.find("AudioOutputRouting"))
        chain.remove(chain.find("AudioOutputRouting"))
        chain.insert(index, copy.deepcopy(routed.find("DeviceChain/AudioOutputRouting")))
        for track, name in ((group, "SONG"), (stem, "STEM")):
            track.find("Name/EffectiveName").set("Value", name)
            track.find("Name/UserName").set("Value", name)
        tracks.insert(list(tracks).index(stem), group)
        self.add_clip(stem)
        return root

    def add_clip(self, stem):
        """One arrangement audio clip for the builder to fill in, from the Live 11 demo song."""
        demo = gz(self.res / "Core Library/Lessons/Demo Songs/Ninajirachi - In The Rain (Live 11 Suite Demo).als")
        clip = copy.deepcopy(next(demo.iter("AudioClip")))
        for envelopes in clip.iter("Envelopes"):
            envelopes[:] = []
        clip.set("Id", "0")
        events = stem.find("DeviceChain/MainSequencer/Sample/ArrangerAutomation/Events")
        events[:] = [clip]

    def living(self):
        live12 = ET.parse(TEMPLATES / "living.xml").getroot()
        default = gz(self.res / "Builtin/Templates/DefaultLiveSet.als").find("LiveSet/Tracks")
        returns11 = default.findall("ReturnTrack")
        root = ET.Element(live12.tag, live12.attrib)
        for section in live12:
            out = ET.SubElement(root, section.tag, section.attrib)
            if section.tag == "Returns":
                out.extend(self.return_track(r, returns11[i]) for i, r in enumerate(section))
            else:
                out.extend(self.device(d) for d in section)
        return root

    def eq_three(self):
        return self.device(ET.fromstring((TEMPLATES / "eq-three.xml").read_text(encoding="utf-8")))


def write_gz(root, path):
    with gzip.open(path, "wt", encoding="utf-8") as f:
        f.write('<?xml version="1.0" encoding="UTF-8"?>\n')
        f.write(ET.tostring(root, encoding="unicode"))


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--live11", default="C:/ProgramData/Ableton/Live 11 Suite/Resources",
                        help="Live 11's Resources folder (macOS: /Applications/Ableton Live 11 Suite.app/Contents/App-Resources)")
    args = parser.parse_args()
    builder = Builder(args.live11)
    OUT.mkdir(exist_ok=True)
    write_gz(builder.stem_set(), OUT / "stem-set.als")
    (OUT / "eq-three.xml").write_text(ET.tostring(builder.eq_three(), encoding="unicode"), encoding="utf-8")
    (OUT / "living.xml").write_text(ET.tostring(builder.living(), encoding="unicode"), encoding="utf-8")
    print(f"wrote {OUT}")


if __name__ == "__main__":
    main()
