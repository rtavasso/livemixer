"""Write an Ableton Live set with one named group per song, in a chosen order.

Reads a folder of song folders (default: the output of
fadr-ableton-import.py), each holding that song's stems. Every song becomes a
top-level group named "Artist - Title" containing one audio track per stem.
Songs are laid end to end in the Arrangement, separated by a gap, with a
"SONG: …" locator at each start. Clips are unwarped, so they play at their
original speed and stay sample-aligned with one another.

Order songs with positional selectors or --order FILE (one selector per line,
# comments allowed). A selector is a folder number ("7"), an exact name, or
any unique part of a name ("ladders"). Only the listed songs are included;
with no selectors, every numbered folder is included in folder order.

The set is cloned from ableton-templates/stem-set.als (saved by Live 12.4),
which holds one group track and one audio track routed into it.
"""
import argparse
import copy
import gzip
import os
import re
import subprocess
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

TEMPLATE = Path(__file__).parent / "ableton-templates" / "stem-set.als"
AUDIO = {".mp3", ".wav", ".aif", ".aiff", ".flac", ".ogg", ".m4a"}
NUMBERED = re.compile(r"^(\d+)\s+(.*)$")
COLORS = [1, 5, 9, 13, 17, 21, 25, 29, 33, 37, 41, 45, 49, 53, 57, 61, 65, 3, 11, 19]


def songs_in(root):
    return sorted(p for p in root.iterdir() if p.is_dir() and any(f.suffix.lower() in AUDIO for f in p.iterdir()))


def display_name(folder):
    match = NUMBERED.match(folder.name)
    return match.group(2) if match else folder.name


def pick(folders, selectors):
    if not selectors:
        return [f for f in folders if NUMBERED.match(f.name)]
    chosen = []
    for selector in selectors:
        key = selector.casefold()
        if selector.isdigit():
            hits = [f for f in folders if (m := NUMBERED.match(f.name)) and int(m.group(1)) == int(selector)]
        else:
            hits = [f for f in folders if key in (f.name.casefold(), display_name(f).casefold())]
            if not hits:
                hits = [f for f in folders if NUMBERED.match(f.name) and key in f.name.casefold()]
            if not hits:
                hits = [f for f in folders if key in f.name.casefold()]
        if len(hits) != 1:
            names = ", ".join(f.name for f in hits) or "nothing"
            sys.exit(f"'{selector}' matches {names}; use a folder number or a longer name")
        if hits[0] in chosen:
            sys.exit(f"'{selector}' repeats {hits[0].name}")
        chosen.append(hits[0])
    return chosen


def read_order(path):
    lines = (line.split("#", 1)[0].strip() for line in Path(path).read_text().splitlines())
    return [line for line in lines if line]


def audio_info(path):
    """Frames and sample rate, counted from packets (afinfo's estimate is unreliable for MP3)."""
    out = subprocess.run(["afinfo", str(path)], capture_output=True, text=True, check=True).stdout
    rate = float(re.search(r"(\d+) Hz", out).group(1))
    packets = re.search(r"audio packets: (\d+)", out)
    per_packet = re.search(r"(\d+) frames/packet", out)
    if packets and per_packet and int(per_packet.group(1)) > 0:
        frames = int(packets.group(1)) * int(per_packet.group(1))
    else:
        frames = round(float(re.search(r"estimated duration: ([\d.]+)", out).group(1)) * rate)
    return frames, int(rate)


def renumber(element, next_pointee):
    """Give every automation/modulation target in a cloned track a fresh set-wide Id."""
    for node in element.iter():
        if "Id" in node.attrib and (node.tag.endswith("Target") or node.tag == "Pointee"):
            node.set("Id", str(next_pointee))
            next_pointee += 1
    return next_pointee


def set_name(track, name):
    track.find("Name/EffectiveName").set("Value", name)
    track.find("Name/UserName").set("Value", name)


def fill_clip(clip, stem, name, color, start, tempo, output_dir):
    frames, rate = audio_info(stem)
    seconds = frames / rate
    clip.set("Time", repr(start))
    clip.find("CurrentStart").set("Value", repr(start))
    clip.find("CurrentEnd").set("Value", repr(start + seconds * tempo / 60))
    for tag in ("LoopStart", "StartRelative", "HiddenLoopStart"):
        clip.find(f"Loop/{tag}").set("Value", "0")
    for tag in ("LoopEnd", "OutMarker", "HiddenLoopEnd"):
        clip.find(f"Loop/{tag}").set("Value", repr(seconds))
    clip.find("Name").set("Value", name)
    clip.find("Color").set("Value", str(color))
    clip.find("IsWarped").set("Value", "false")
    ref = clip.find("SampleRef")
    file_ref = ref.find("FileRef")
    file_ref.find("RelativePathType").set("Value", "1")
    file_ref.find("RelativePath").set("Value", os.path.relpath(stem, output_dir))
    file_ref.find("Path").set("Value", str(stem))
    file_ref.find("OriginalFileSize").set("Value", str(stem.stat().st_size))
    file_ref.find("OriginalCrc").set("Value", "0")
    ref.find("LastModDate").set("Value", str(int(stem.stat().st_mtime)))
    ref.find("DefaultDuration").set("Value", str(frames))
    ref.find("DefaultSampleRate").set("Value", str(rate))
    return seconds


def set_tempo(live_set, tempo):
    tempo_node = live_set.find("MainTrack/DeviceChain/Mixer/Tempo")
    tempo_node.find("Manual").set("Value", repr(float(tempo)))
    target = tempo_node.find("AutomationTarget").get("Id")
    for envelope in live_set.iter("AutomationEnvelope"):
        if envelope.find("EnvelopeTarget/PointeeId").get("Value") == target:
            for event in envelope.iter("FloatEvent"):
                event.set("Value", repr(float(tempo)))


def add_locator(locators, index, time, name):
    locator = ET.SubElement(locators, "Locator", Id=str(index))
    for tag, value in (("LomId", "0"), ("Time", repr(time)), ("Name", name), ("Annotation", ""), ("IsSongStart", "false")):
        ET.SubElement(locator, tag, Value=value)


def build(songs, output, tempo, gap_bars, unfold):
    with gzip.open(TEMPLATE, "rt", encoding="utf-8") as f:
        root = ET.fromstring(f.read())
    live_set = root.find("LiveSet")
    tracks = live_set.find("Tracks")
    group_template, stem_template = tracks.find("GroupTrack"), tracks.find("AudioTrack")
    tracks.remove(group_template)
    tracks.remove(stem_template)
    # Group and audio tracks must precede the return tracks in <Tracks>.
    position = 0
    next_pointee = int(live_set.find("NextPointeeId").get("Value"))
    next_track = 1 + max(int(t.get("Id")) for t in live_set.iter() if t.tag in ("AudioTrack", "GroupTrack", "ReturnTrack", "MidiTrack"))
    next_track = max(next_track, 100)
    locators = live_set.find("Locators/Locators")
    set_tempo(live_set, tempo)
    output_dir = output.parent.resolve()

    beat = 0.0
    for index, folder in enumerate(songs):
        name = display_name(folder)
        color = COLORS[index % len(COLORS)]
        group = copy.deepcopy(group_template)
        group_id = next_track
        next_track += 1
        group.set("Id", str(group_id))
        set_name(group, name)
        group.find("Color").set("Value", str(color))
        group.find("TrackUnfolded").set("Value", "true" if unfold else "false")
        next_pointee = renumber(group, next_pointee)
        tracks.insert(position, group)
        position += 1
        add_locator(locators, index, beat, f"SONG: {name}")

        longest = 0.0
        stems = sorted(f for f in folder.iterdir() if f.suffix.lower() in AUDIO)
        for stem in stems:
            track = copy.deepcopy(stem_template)
            track.set("Id", str(next_track))
            next_track += 1
            set_name(track, stem.stem)
            track.find("Color").set("Value", str(color))
            track.find("TrackGroupId").set("Value", str(group_id))
            clip = track.find("DeviceChain/MainSequencer/Sample/ArrangerAutomation/Events/AudioClip")
            seconds = fill_clip(clip, stem.resolve(), stem.stem, color, beat, tempo, output_dir)
            longest = max(longest, seconds)
            next_pointee = renumber(track, next_pointee)
            tracks.insert(position, track)
            position += 1
        print(f"{beat / 4 + 1:>6.0f}.1.1  {name}  ({len(stems)} stems, {int(longest // 60)}:{longest % 60:04.1f})")
        end = beat + longest * tempo / 60
        beat = (int(end // 4) + (end % 4 > 0) + gap_bars) * 4.0

    live_set.find("NextPointeeId").set("Value", str(next_pointee))
    output.parent.mkdir(parents=True, exist_ok=True)
    with gzip.open(output, "wt", encoding="utf-8") as f:
        f.write('<?xml version="1.0" encoding="UTF-8"?>\n')
        f.write(ET.tostring(root, encoding="unicode"))
    print(f"Wrote {output} ({len(songs)} songs)")


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("songs", nargs="*", help="song selectors in play order (number, name or part of a name)")
    parser.add_argument("--stems", default=".fadr/groop-show/ableton-import", help="folder of song folders")
    parser.add_argument("--order", help="text file with one song selector per line")
    parser.add_argument("-o", "--output", help="set to write (default: <stems>/../Stem Set.als)")
    parser.add_argument("--tempo", type=float, default=120, help="set tempo; clips are unwarped, so this only sets the grid")
    parser.add_argument("--gap-bars", type=int, default=4, help="empty bars between songs")
    parser.add_argument("--unfold", action="store_true", help="leave song groups expanded")
    parser.add_argument("--force", action="store_true", help="overwrite an existing set")
    parser.add_argument("--list", action="store_true", help="print the available song folders and exit")
    args = parser.parse_args()

    root = Path(args.stems)
    folders = songs_in(root)
    if args.list:
        for folder in folders:
            print(folder.name)
        return
    selectors = (read_order(args.order) if args.order else []) + args.songs
    songs = pick(folders, selectors)
    if not songs:
        sys.exit(f"No song folders found in {root}")
    output = Path(args.output) if args.output else root.parent / "Stem Set.als"
    if output.exists() and not args.force:
        sys.exit(f"{output} exists; pass --force to overwrite")
    build(songs, output, args.tempo, args.gap_bars, args.unfold)


if __name__ == "__main__":
    main()
