"""Writing Live sets: clone the template's group and stem tracks, place clips, add automation.

The template (ableton-templates/stem-set.als, saved by Live 12.4) holds one
group track, one audio track routed into it, and two return tracks. Every
automation or modulation target in a clone gets a fresh set-wide Id below
NextPointeeId; group and stem tracks are inserted before the return tracks.

A living set (`write_mix(..., living=...)`) adds the installation's effects
from ableton-templates/living.xml (see scripts/extract-living-templates.py):
each song group holds DRUM FX / Bass / TEXTURE FX (Auto Filter) / VOCALS
(Vocal Presence utility) like the hand-built sets, the returns become the dub
echo and halo reverb, Main gets Space, Mix Gain, a limiter and the LiveMixer
Living FX Max device, and every transition is marked FX QUIET … FX ON.
"""
import copy
import gzip
import os
import shutil
import xml.etree.ElementTree as ET
from pathlib import Path

from . import transitions as tx

TEMPLATES = Path(__file__).resolve().parent.parent / "ableton-templates"
START = "-63072000"  # Live's time for an envelope's initial value
WARP_BEATS, WARP_COMPLEX_PRO = 0, 6


def _set_name(track, name):
    track.find("Name/EffectiveName").set("Value", name)
    track.find("Name/UserName").set("Value", name)


class LiveSet:
    def __init__(self, template=TEMPLATES / "stem-set.als"):
        with gzip.open(template, "rt", encoding="utf-8") as f:
            self.root = ET.fromstring(f.read())
        self.live_set = self.root.find("LiveSet")
        self.tracks = self.live_set.find("Tracks")
        self.group_template = self.tracks.find("GroupTrack")
        self.stem_template = self.tracks.find("AudioTrack")
        self.tracks.remove(self.group_template)
        self.tracks.remove(self.stem_template)
        self.eq_template = ET.fromstring((TEMPLATES / "eq-three.xml").read_text())
        self.next_pointee = int(self.live_set.find("NextPointeeId").get("Value"))
        self.next_track = max(100, 1 + max(int(t.get("Id")) for t in self.tracks))
        self.position = 0  # insertion index: before the return tracks
        self.next_event = 1

    def _renumber(self, element):
        for node in element.iter():
            if "Id" in node.attrib and (node.tag.endswith("Target") or node.tag == "Pointee"):
                node.set("Id", str(self.next_pointee))
                self.next_pointee += 1

    def _insert(self, track):
        track.set("Id", str(self.next_track))
        self.next_track += 1
        self._renumber(track)
        self.tracks.insert(self.position, track)
        self.position += 1
        return track

    def add_group(self, name, color, unfold=False, eq=False, parent=None, devices=()):
        group = copy.deepcopy(self.group_template)
        _set_name(group, name)
        group.find("Color").set("Value", str(color))
        group.find("TrackUnfolded").set("Value", "true" if unfold else "false")
        if parent is not None:
            group.find("TrackGroupId").set("Value", parent.get("Id"))
        chain = group.find("DeviceChain/DeviceChain/Devices")
        if eq:
            device = copy.deepcopy(self.eq_template)
            device.set("Id", "0")
            chain.append(device)
        for index, device in enumerate(devices, start=len(chain)):
            device = copy.deepcopy(device)
            device.set("Id", str(index))
            chain.append(device)
        return self._insert(group)

    def add_stem(self, group, name, color):
        track = copy.deepcopy(self.stem_template)
        _set_name(track, name)
        track.find("Color").set("Value", str(color))
        track.find("TrackGroupId").set("Value", group.get("Id"))
        return self._insert(track)

    @staticmethod
    def volume_target(track):
        return track.find("DeviceChain/Mixer/Volume/AutomationTarget").get("Id")

    @staticmethod
    def eq_low_target(group):
        return group.find("DeviceChain/DeviceChain/Devices/FilterEQ3/GainLo/AutomationTarget").get("Id")

    def set_clip(self, track, path, frames, rate, name, color, output_dir, *, start, end, loop_start, markers, warp_mode):
        """Place the track's single Arrangement clip, warped by `markers` [(seconds, clip beat)]."""
        clip = track.find("DeviceChain/MainSequencer/Sample/ArrangerAutomation/Events/AudioClip")
        length = end - start
        clip.set("Time", repr(start))
        clip.find("CurrentStart").set("Value", repr(start))
        clip.find("CurrentEnd").set("Value", repr(end))
        loop = clip.find("Loop")
        for tag, value in (("LoopStart", loop_start), ("LoopEnd", loop_start + length), ("StartRelative", 0),
                           ("OutMarker", loop_start + length), ("HiddenLoopStart", loop_start),
                           ("HiddenLoopEnd", loop_start + length)):
            loop.find(tag).set("Value", repr(float(value)))
        loop.find("LoopOn").set("Value", "false")
        clip.find("Name").set("Value", name)
        clip.find("Color").set("Value", str(color))
        clip.find("IsWarped").set("Value", "true")
        clip.find("WarpMode").set("Value", str(warp_mode))
        warp = clip.find("WarpMarkers")
        for child in list(warp):
            warp.remove(child)
        for index, (seconds, beat) in enumerate(markers):
            ET.SubElement(warp, "WarpMarker", Id=str(index), SecTime=repr(float(seconds)), BeatTime=repr(float(beat)))
        # Live saves one extra marker a 32nd note past the last, at the same tempo.
        (s0, b0), (s1, b1) = markers[-2], markers[-1]
        ET.SubElement(warp, "WarpMarker", Id=str(len(markers)), SecTime=repr(s1 + (s1 - s0) / (b1 - b0) / 32),
                      BeatTime=repr(b1 + 1 / 32))
        ref = clip.find("SampleRef")
        file_ref = ref.find("FileRef")
        file_ref.find("RelativePathType").set("Value", "1")
        file_ref.find("RelativePath").set("Value", os.path.relpath(path, output_dir))
        file_ref.find("Path").set("Value", str(path))
        file_ref.find("OriginalFileSize").set("Value", str(path.stat().st_size))
        file_ref.find("OriginalCrc").set("Value", "0")
        ref.find("LastModDate").set("Value", str(int(path.stat().st_mtime)))
        ref.find("DefaultDuration").set("Value", str(frames))
        ref.find("DefaultSampleRate").set("Value", str(rate))

    def _events(self, parent, initial, points):
        events = ET.SubElement(parent, "Events")
        ET.SubElement(events, "FloatEvent", Id=str(self.next_event), Time=START, Value=repr(float(initial)))
        self.next_event += 1
        last = None
        for beat, value in points:
            if last is not None and beat <= last:
                beat = last + 1e-4
            ET.SubElement(events, "FloatEvent", Id=str(self.next_event), Time=repr(float(beat)), Value=repr(float(value)))
            self.next_event += 1
            last = beat
        return events

    def add_envelope(self, track, target_id, initial, points):
        envelopes = track.find("AutomationEnvelopes/Envelopes")
        next_id = 1 + max((int(e.get("Id")) for e in envelopes), default=-1)
        envelope = ET.SubElement(envelopes, "AutomationEnvelope", Id=str(next_id))
        ET.SubElement(ET.SubElement(envelope, "EnvelopeTarget"), "PointeeId", Value=str(target_id))
        automation = ET.SubElement(envelope, "Automation")
        self._events(automation, initial, points)
        view = ET.SubElement(automation, "AutomationTransformViewState")
        ET.SubElement(view, "IsTransformPending", Value="false")
        ET.SubElement(view, "TimeAndValueTransforms")

    def set_tempo(self, initial, points):
        main = self.live_set.find("MainTrack")
        tempo = main.find("DeviceChain/Mixer/Tempo")
        tempo.find("Manual").set("Value", repr(float(initial)))
        target = tempo.find("AutomationTarget").get("Id")
        envelopes = main.find("AutomationEnvelopes/Envelopes")
        for envelope in list(envelopes):
            if envelope.find("EnvelopeTarget/PointeeId").get("Value") == target:
                envelopes.remove(envelope)
        self.add_envelope(main, target, initial, points)

    def add_locator(self, beat, name):
        locators = self.live_set.find("Locators/Locators")
        locator = ET.SubElement(locators, "Locator", Id=str(len(locators)))
        for tag, value in (("LomId", "0"), ("Time", repr(float(beat))), ("Name", name), ("Annotation", ""), ("IsSongStart", "false")):
            ET.SubElement(locator, tag, Value=value)

    def use_returns(self, returns):
        """Replace the template's return tracks with `returns` (same count, so every send still has its return)."""
        current = self.tracks.findall("ReturnTrack")
        if len(current) != len(returns):
            raise ValueError(f"expected {len(current)} return tracks, got {len(returns)}")
        for old, new in zip(current, returns):
            new = copy.deepcopy(new)
            new.set("Id", old.get("Id"))
            self._renumber(new)
            index = list(self.tracks).index(old)
            self.tracks.remove(old)
            self.tracks.insert(index, new)

    def add_main_devices(self, devices):
        chain = self.live_set.find("MainTrack/DeviceChain/DeviceChain/Devices")
        for device in devices:
            device = copy.deepcopy(device)
            device.set("Id", str(len(chain)))
            self._renumber(device)
            chain.append(device)
            yield device

    def write(self, output):
        locators = self.live_set.find("Locators/Locators")
        ordered = sorted(locators, key=lambda l: float(l.find("Time").get("Value")))
        for index, locator in enumerate(ordered):
            locators.remove(locator)
            locator.set("Id", str(index))
            locators.append(locator)
        self.live_set.find("NextPointeeId").set("Value", str(self.next_pointee))
        output.parent.mkdir(parents=True, exist_ok=True)
        with gzip.open(output, "wt", encoding="utf-8") as f:
            f.write('<?xml version="1.0" encoding="UTF-8"?>\n')
            f.write(ET.tostring(self.root, encoding="unicode"))


LIVING_FX = Path(__file__).resolve().parent.parent.parent / "devices" / "LiveMixer Living FX"
# Sub-groups of a living song group, by stem role, in track order; None: directly in the song group.
LIVING_GROUPS = [(tx.DRUMS, "DRUM FX"), (tx.BASS, None), (tx.MELODIC, "TEXTURE FX"), (tx.VOCALS, "VOCALS")]


class Living:
    """The installation's devices, from ableton-templates/living.xml."""

    def __init__(self, template=TEMPLATES / "living.xml", device_dir=LIVING_FX):
        root = ET.parse(template).getroot()
        self.texture_filter = root.find("TextureFilter")[0]
        self.vocal_presence = root.find("VocalPresence")[0]
        self.returns = list(root.find("Returns"))
        self.main = list(root.find("Main"))
        self.device_dir = Path(device_dir)

    def vocal_device(self, first):
        """Vocal Presence; only the first song's keeps the MIDI mapping (the Max device mirrors it to the rest)."""
        device = copy.deepcopy(self.vocal_presence)
        if not first:
            for parent in device.iter():
                for key_midi in parent.findall("KeyMidi"):
                    parent.remove(key_midi)
        return device

    def install_device(self, output_dir):
        """Copy the Max device next to the set; returns the .amxd path."""
        target = output_dir / "LiveMixer Living FX"
        target.mkdir(parents=True, exist_ok=True)
        for name in ("LiveMixer Living FX.amxd", "living-fx.js"):
            shutil.copy2(self.device_dir / name, target / name)
        return target / "LiveMixer Living FX.amxd"


def _point_max_device(device, amxd, output_dir):
    ref = device.find("PatchSlot/Value/MxPatchRef")
    file_ref = ref.find("FileRef")
    file_ref.find("RelativePathType").set("Value", "1")
    file_ref.find("RelativePath").set("Value", os.path.relpath(amxd, output_dir))
    file_ref.find("Path").set("Value", str(amxd))
    file_ref.find("OriginalFileSize").set("Value", str(amxd.stat().st_size))
    file_ref.find("OriginalCrc").set("Value", "0")
    ref.find("LastModDate").set("Value", str(int(amxd.stat().st_mtime)))


def quiet_zones(plan):
    """(start, end) beats of every overlapping transition: the effects hold at home while songs hand over."""
    return [(t.start, t.start + 4 * t.bars) for t in plan.transitions if t.bars > 0]


def write_mix(plan, envelopes, rendered, output, colors, unfold=False, living=None):
    """Write a planned mix. `rendered` is one (stems [(name, path)], frames, rate) per song.

    `living`: a `Living` to add the installation's effects, or None for a plain stem set.
    """
    live = LiveSet()
    output_dir = output.parent.resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    groups, stem_tracks = [], {}
    for index, ((stems, frames, rate), song) in enumerate(zip(rendered, plan.songs)):
        color = colors[index % len(colors)]
        group = live.add_group(song.name, color, unfold=unfold, eq=True)
        groups.append(group)
        g = plan.grids[index]
        parents = {}
        if living is not None:
            # Role order, each sub-group created just before its first stem: Live lists a group's tracks under it.
            order = [role for role, _ in LIVING_GROUPS]
            stems = sorted(stems, key=lambda s: order.index(tx.stem_role(s[0])))
        for stem_name, path in stems:
            role = tx.stem_role(stem_name)
            if living is not None and role not in parents:
                sub = dict(LIVING_GROUPS)[role]
                devices = {tx.MELODIC: [living.texture_filter], tx.VOCALS: [living.vocal_device(index == 0)]}.get(role, [])
                parents[role] = group if sub is None else live.add_group(sub, color, unfold=unfold, parent=group, devices=devices)
            track = live.add_stem(parents.get(role, group), stem_name, color)
            mode = WARP_BEATS if tx.stem_role(stem_name) == tx.DRUMS else WARP_COMPLEX_PRO
            live.set_clip(track, Path(path).resolve(), frames, rate, stem_name, color, output_dir,
                          start=plan.origins[index] + g.start_beat, end=plan.clip_ends[index],
                          loop_start=g.start_beat, markers=g.markers, warp_mode=mode)
            stem_tracks[(index, stem_name)] = track
    for target, (initial, points) in envelopes.items():
        if target == "tempo":
            live.set_tempo(initial, points)
        elif target[0] == "stem":
            track = stem_tracks[target[1:]]
            live.add_envelope(track, live.volume_target(track), initial, points)
        elif target[0] == "group":
            live.add_envelope(groups[target[1]], live.volume_target(groups[target[1]]), initial, points)
        elif target[0] == "eq":
            live.add_envelope(groups[target[1]], live.eq_low_target(groups[target[1]]), initial, points)
    for beat, song in plan.locators:
        live.add_locator(beat, f"SONG: {song.name} · {song.native_bpm:.0f} BPM · {song.camelot or '?'}")
    if living is not None:
        live.use_returns(living.returns)
        amxd = living.install_device(output_dir)
        for device in live.add_main_devices(living.main):
            if device.tag == "MxDeviceAudioEffect":
                _point_max_device(device, amxd, output_dir)
        for start, end in quiet_zones(plan):
            live.add_locator(start, "FX QUIET")
            live.add_locator(end, "FX ON")
    live.write(output)
