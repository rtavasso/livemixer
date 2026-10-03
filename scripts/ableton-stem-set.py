"""Write an Ableton Live set that plays the chosen songs as one continuous, beat-matched mix.

Reads a folder of song folders (default: the output of
fadr-ableton-import.py), each holding that song's stems. Every song becomes a
top-level group named "Artist - Title" containing one audio track per stem.

1. Render: every stem of a song is cut or padded to the same length (the
   latest point any stem is above --silence-db) and written as 16-bit WAV,
   which Live streams without its decoding cache.
2. Analyse: tempo, beats and downbeats per song (librosa in an isolated uv
   environment), started from the tempo in tempo-key.json.
3. Mix: clips are warped on their downbeats, songs overlap on phrase
   boundaries, the tempo ramps from one song to the next across each
   overlap, and each transition (stem handover, crossfade or EQ low swap) is
   written as automation. See docs/superpowers/specs/2026-09-24-ableton-transitions-design.md.
4. Living installation (default; --plain leaves it out): each song group gets
   DRUM FX / Bass / TEXTURE FX / VOCALS with the installation's filter and
   vocal-presence devices, the returns become the dub echo and halo reverb,
   Main gets Space, Mix Gain, a limiter and LiveMixer Living FX (copied next
   to the set), and every transition is marked FX QUIET … FX ON so the box
   never colours a handover. See docs/LIVING-MUSIC.md.
5. Gestures (--gestures, Live 11 only): each song splits into a subgroup in RHYTHM (DRUM FX, Bass) and
   one in MELODIC (TEXTURE FX, VOCALS); RHYTHM and MELODIC carry Muffle / Tilt / Level and Main gains
   Whoosh / Freeze / Span for the hand gestures. See docs/superpowers/specs/2026-10-02-hand-gesture-audio-design.md.

Renders and analyses are cached per song, so reordering is fast. The set is
written with a report of every transition, also saved as <set>.transitions.json.

Order songs with positional selectors or --order FILE (one selector per line,
# comments allowed). A selector is a folder number ("7"), an exact name, or
any unique part of a name ("ladders"). Only the listed songs are included;
with no selectors, every numbered folder is included in folder order.
"""
import argparse
import json
import math
import re
import sys
import unicodedata
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from ableton_set import transitions as tx  # noqa: E402
from ableton_set.als import LIVE11_TEMPLATES, TEMPLATES, Gestures, Living, write_mix  # noqa: E402
from ableton_set.analysis import analyze_all  # noqa: E402
from ableton_set.merge import merge_levels, merge_song  # noqa: E402
from ableton_set.render import AUDIO, render_song  # noqa: E402

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
    lines = (line.split("#", 1)[0].strip() for line in Path(path).read_text(encoding="utf-8").splitlines())
    return [line for line in lines if line]


def reliable(analysis, prior):
    """At least 16 bars, and the detected tempo within 10% of the listed one (allowing half/double)."""
    if len(analysis["downbeats"]) < 16:
        return False
    if not prior:
        return True
    ratio = analysis["bpm"] / prior
    while ratio > math.sqrt(2):
        ratio /= 2
    while ratio < 1 / math.sqrt(2):
        ratio *= 2
    return abs(ratio - 1) <= 0.10


def bar(beat):
    return f"{int(beat // 4) + 1}.{int(beat % 4) + 1}"


def rendered_song(folder):
    """A song already rendered (by render_song, on any machine): ([(name, path)], frames, rate) from its _render.json."""
    manifest = json.loads((folder / "_render.json").read_text(encoding="utf-8"))
    stems = [(Path(name).stem, folder / f"{Path(name).stem}.wav") for name in sorted(manifest["sources"])]
    missing = [str(path) for _, path in stems if not path.exists()]
    if missing:
        sys.exit("Missing rendered stems: " + ", ".join(missing))
    return stems, manifest["frames"], manifest["rate"]


def build(folders, output, args):
    render_root = rendered_root(args)
    key_file = Path(args.tempo_key) if args.tempo_key else Path(args.stems).parent / "tempo-key.json"
    # Folder names from Spotify can contain non-breaking spaces; match them loosely.
    loose = lambda name: unicodedata.normalize("NFKC", name).casefold()  # noqa: E731
    listed = json.loads(key_file.read_text(encoding="utf-8")) if key_file.exists() else {}
    meta = {folder.name: next((v for k, v in listed.items() if loose(k) == loose(folder.name)), {}) for folder in folders}
    missing = [f.name for f in folders if not meta[f.name]]
    if missing:
        print(f"Not in {key_file} (tempo from analysis only, key unknown): {', '.join(missing)}")

    rendered = []
    for folder in folders:
        if args.from_rendered:
            stems, frames, rate = rendered_song(folder)
        else:
            stems, frames, rate = render_song(folder, render_root, args.silence_db, "wav")
        rendered.append((folder, stems, frames, rate))
    print(f"Analysing {len(folders)} songs (cached per song)…")
    analyses = analyze_all([render_root / f.name for f in folders], [meta.get(f.name, {}).get("bpm") for f in folders])

    if args.merge:
        print("Merging stems to Kick, Drums, Bass, Melodic and Vocals (cached per song)…")
        merged_root = render_root.parent / "merged-stems"
        rendered = [(folder, merge_song(stems, merged_root / folder.name), frames, rate)
                    for folder, stems, frames, rate in rendered]
        analyses = [{**analysis, "bar_levels": merge_levels(analysis["bar_levels"])} for analysis in analyses]

    songs = []
    for (folder, stems, frames, rate), analysis in zip(rendered, analyses):
        info = meta.get(folder.name, {})
        songs.append(tx.Song(
            name=display_name(folder), native_bpm=analysis["bpm"], downbeats=analysis["downbeats"],
            pickup_bars=analysis["pickup_bars"], duration=frames / rate, bar_levels=analysis["bar_levels"],
            camelot=tx.camelot(info.get("key"), info.get("camelot")), reliable=reliable(analysis, info.get("bpm"))))
    plan = tx.plan(songs, args.overlap_bars, args.style)
    envelopes = tx.automation(plan)
    retimed = tx.natural_speed(plan, envelopes) if args.natural_speed else None

    templates = LIVE11_TEMPLATES if args.live == 11 else TEMPLATES
    write_mix(plan, envelopes, [(stems, frames, rate) for _, stems, frames, rate in rendered], output, COLORS, args.unfold,
              living=None if args.plain else Living(templates), templates=templates, retimed=retimed,
              loop=not args.no_loop,
              gestures=Gestures() if args.gestures else None)

    report = []
    print()
    for index, (song, analysis) in enumerate(zip(songs, analyses)):
        scale = "" if song.scale == 1 else f" (played as {song.bpm:.1f}, ×{song.scale:g})"
        best, second = sorted(analysis["phase_scores"], reverse=True)[:2]
        flag = "" if song.reliable else "  ⚠ beat grid uncertain: crossfades only"
        if song.reliable and best > 0 and (best - second) / best < 0.10:
            flag = "  ⚠ bar start uncertain: transitions may land a beat off"
        print(f"{index + 1:>2}. {song.name}  {song.native_bpm:.1f} BPM{scale}  {song.camelot or '?'}{flag}")
    print()
    for t in plan.transitions:
        a, b = songs[t.outgoing], songs[t.incoming]
        line = (f"{t.outgoing + 1:>2}→{t.incoming + 1:<2} bar {bar(t.start):>7}  {t.style:<9} {t.bars:>2} bars  "
                f"{a.bpm:.1f}→{b.bpm:.1f} BPM  {t.reason}")
        print(line)
        report.append({"from": a.name, "to": b.name, "bar": bar(t.start), "beat": t.start, "bars": t.bars,
                       "style": t.style, "blend": t.blend, "tempo": [a.bpm, b.bpm],
                       "keys": [a.camelot, b.camelot], "reason": t.reason})
    output.with_suffix(".transitions.json").write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")
    total = retimed.clip_ends[-1] if retimed else plan.clip_ends[-1]
    print(f"\nWrote {output} ({len(songs)} songs, ends at bar {bar(total)})")
    if not args.plain:
        print("Living installation: LiveMixer Living FX copied beside the set; start the bridge and the controls page in Living mode.")


def rendered_root(args):
    return (Path(args.rendered) if args.rendered else Path(args.stems).parent / "rendered-stems").resolve()


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("songs", nargs="*", help="song selectors in play order (number, name or part of a name)")
    parser.add_argument("--stems", default=".fadr/groop-show/ableton-import", help="folder of song folders")
    parser.add_argument("--order", help="text file with one song selector per line")
    parser.add_argument("-o", "--output", help="set to write (default: <stems>/../Stem Set.als)")
    parser.add_argument("--tempo-key", help="tempo and key per song folder (default: <stems>/../tempo-key.json)")
    parser.add_argument("--overlap-bars", type=int, default=16, help="length of each transition in bars")
    parser.add_argument("--no-loop", action="store_true",
                        help="leave Live's Arrangement loop off (by default it loops the whole set, so a show never stops)")
    parser.add_argument("--natural-speed", action="store_true",
                        help="play every song unwarped at its own speed; Live's tempo steps to each song's at the end "
                             "of its overlap instead of ramping, so a wrong tempo estimate never bends the audio")
    parser.add_argument("--style", choices=("crossfade",),
                        help="use this transition for every song instead of choosing per pair (crossfade: song group volumes)")
    parser.add_argument("--silence-db", type=float, default=-60, help="level below which a stem's tail counts as silence (dBFS)")
    parser.add_argument("--rendered", help="folder for equal-length stems (default: <stems>/../rendered-stems)")
    parser.add_argument("--unfold", action="store_true", help="leave song groups expanded")
    parser.add_argument("--plain", action="store_true", help="leave out the living installation's groups, effects and FX QUIET markers")
    parser.add_argument("--merge", action="store_true",
                        help="lighter set: Snare + Other Drums, the melodic stems and the vocals each summed to one track "
                             "(written to <rendered>/../merged-stems)")
    parser.add_argument("--live", type=int, choices=(11, 12), default=12, help="Live version to write the set for")
    parser.add_argument("--gestures", action="store_true",
                        help="hand-gesture layout (needs --live 11): each song split into RHYTHM and MELODIC groups "
                             "with Muffle / Tilt / Level on each, and Whoosh / Freeze / Span on Main")
    parser.add_argument("--from-rendered", action="store_true",
                        help="use the rendered stems as they are (no source stems needed, e.g. on Windows)")
    parser.add_argument("--force", action="store_true", help="overwrite an existing set")
    parser.add_argument("--list", action="store_true", help="print the available song folders and exit")
    args = parser.parse_args()
    sys.stdout.reconfigure(encoding="utf-8")  # song names and ⚠ on a Windows console
    if args.gestures and args.live != 11:
        parser.error("--gestures needs --live 11: its devices come from Live 11's Core Library (no Live 12 versions here)")
    if args.gestures and args.plain:
        parser.error("--gestures builds on the living installation; leave out --plain")

    root = rendered_root(args) if args.from_rendered else Path(args.stems)
    folders = songs_in(root)
    if args.list:
        for folder in folders:
            print(folder.name)
        return
    selectors = (read_order(args.order) if args.order else []) + args.songs
    chosen = pick(folders, selectors)
    if len(chosen) < 1:
        sys.exit(f"No song folders found in {root}")
    output = Path(args.output) if args.output else root.parent / "Stem Set.als"
    if output.exists() and not args.force:
        sys.exit(f"{output} exists; pass --force to overwrite")
    build(chosen, output, args)


if __name__ == "__main__":
    main()
