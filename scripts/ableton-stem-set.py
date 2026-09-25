"""Write an Ableton Live set with one named group per song, in a chosen order.

Reads a folder of song folders (default: the output of
fadr-ableton-import.py), each holding that song's stems. Every song becomes a
top-level group named "Artist - Title" containing one audio track per stem.

Stems are first rendered to FLAC with every stem of a song cut or padded to
the same length: the latest point at which any of its stems is above the
silence threshold. Trailing silence and near-silent noise are removed, and
shorter stems are padded with silence. Renders are cached per song and
reused while the source files and threshold are unchanged. Songs then run
back to back in the Arrangement with no gap, with a "SONG: …" locator at each
start. Clips are unwarped, so they play at their original speed and stay
sample-aligned with one another.

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
import json
import os
import re
import subprocess
import sys
import wave
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np

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


def decode(stem, scratch):
    """Decode a stem to 16-bit PCM with afconvert; returns (frames x channels array, rate)."""
    temp = scratch / f"{stem.stem}.decode.wav"
    subprocess.run(["afconvert", "-f", "WAVE", "-d", "LEI16", str(stem), str(temp)], check=True)
    with wave.open(str(temp)) as f:
        rate, channels = f.getframerate(), f.getnchannels()
        samples = np.frombuffer(f.readframes(f.getnframes()), dtype="<i2").reshape(-1, channels)
    temp.unlink()
    return samples, rate


def audible_end(samples, rate, silence_db):
    """Frame just after the last 50 ms block whose peak exceeds the threshold (0 if silent)."""
    block = rate // 20
    peaks = np.abs(samples.astype(np.int32)).max(axis=1)
    count = -(-len(peaks) // block)
    padded = np.zeros(count * block, dtype=np.int32)
    padded[: len(peaks)] = peaks
    loud = np.nonzero(padded.reshape(count, block).max(axis=1) > 32768 * 10 ** (silence_db / 20))[0]
    return int(min(len(samples), (loud[-1] + 1) * block)) if len(loud) else 0


def write_flac(samples, frames, rate, target):
    """Cut or zero-pad to exactly `frames`, fade the last 10 ms, and encode as FLAC."""
    out = np.zeros((frames, samples.shape[1]), dtype=np.int16)
    keep = min(frames, len(samples))
    out[:keep] = samples[:keep]
    fade = min(frames, rate // 100)
    out[frames - fade :] = (out[frames - fade :] * np.linspace(1, 0, fade)[:, None]).astype(np.int16)
    temp = target.with_suffix(".wav")
    with wave.open(str(temp), "wb") as f:
        f.setnchannels(out.shape[1])
        f.setsampwidth(2)
        f.setframerate(rate)
        f.writeframes(out.tobytes())
    subprocess.run(["afconvert", "-f", "flac", "-d", "flac", str(temp), str(target)], check=True)
    temp.unlink()


def render_song(folder, render_root, silence_db):
    """Render a song's stems to equal-length FLACs; returns ([(name, path)], frames, rate)."""
    stems = sorted(f for f in folder.iterdir() if f.suffix.lower() in AUDIO)
    target_dir = render_root / folder.name
    manifest_path = target_dir / "_render.json"
    sources = {f.name: [f.stat().st_size, int(f.stat().st_mtime)] for f in stems}
    outputs = [(f.stem, (target_dir / f.stem).with_suffix(".flac")) for f in stems]
    if manifest_path.exists():
        manifest = json.loads(manifest_path.read_text())
        if manifest.get("sources") == sources and manifest.get("silence_db") == silence_db and all(p.exists() for _, p in outputs):
            return outputs, manifest["frames"], manifest["rate"]
    target_dir.mkdir(parents=True, exist_ok=True)
    manifest_path.unlink(missing_ok=True)
    with ThreadPoolExecutor(max_workers=len(stems)) as pool:
        decoded = list(pool.map(lambda f: decode(f, target_dir), stems))
    rates = {rate for _, rate in decoded}
    if len(rates) != 1:
        sys.exit(f"{folder.name}: stems have different sample rates {sorted(rates)}")
    rate = rates.pop()
    frames = max(audible_end(samples, rate, silence_db) for samples, _ in decoded)
    if frames == 0:
        sys.exit(f"{folder.name}: every stem is below {silence_db} dBFS")
    with ThreadPoolExecutor(max_workers=len(stems)) as pool:
        list(pool.map(lambda job: write_flac(job[0][0], frames, rate, job[1][1]), zip(decoded, outputs)))
    manifest_path.write_text(json.dumps({"silence_db": silence_db, "sources": sources, "frames": frames, "rate": rate}, indent=2))
    return outputs, frames, rate


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


def fill_clip(clip, stem, frames, rate, name, color, start, tempo, output_dir):
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


def build(songs, output, tempo, gap_bars, unfold, render_root, silence_db):
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
        stems, frames, rate = render_song(folder, render_root, silence_db)
        seconds = frames / rate
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

        for stem_name, stem in stems:
            track = copy.deepcopy(stem_template)
            track.set("Id", str(next_track))
            next_track += 1
            set_name(track, stem_name)
            track.find("Color").set("Value", str(color))
            track.find("TrackGroupId").set("Value", str(group_id))
            clip = track.find("DeviceChain/MainSequencer/Sample/ArrangerAutomation/Events/AudioClip")
            fill_clip(clip, stem.resolve(), frames, rate, stem_name, color, beat, tempo, output_dir)
            next_pointee = renumber(track, next_pointee)
            tracks.insert(position, track)
            position += 1
        clock = beat * 60 / tempo
        print(f"{int(clock // 60):>3}:{clock % 60:06.3f}  {name}  ({len(stems)} stems, {int(seconds // 60)}:{seconds % 60:06.3f})")
        beat += seconds * tempo / 60
        if gap_bars:
            beat = (int(beat // 4) + (beat % 4 > 0) + gap_bars) * 4.0

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
    parser.add_argument("--gap-bars", type=int, default=0, help="empty bars between songs (0 = butt songs together exactly)")
    parser.add_argument("--silence-db", type=float, default=-60, help="level below which a stem's tail counts as silence (dBFS)")
    parser.add_argument("--rendered", help="folder for equal-length FLAC stems (default: <stems>/../rendered-stems)")
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
    render_root = Path(args.rendered) if args.rendered else root.parent / "rendered-stems"
    build(songs, output, args.tempo, args.gap_bars, args.unfold, render_root.resolve(), args.silence_db)


if __name__ == "__main__":
    main()
