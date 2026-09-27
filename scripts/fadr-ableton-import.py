"""Build Ableton-ready import folders from extracted Fadr stems.

For every song under the stems folder, copies the nine leaf stems into
`<output>/<NN> <Artist> - <Title>/01 Kick.mp3 … 09 Background Vocals.mp3`,
the order the Live track layout uses. Parent stems (Drums, Vocals,
Instrumental) are skipped. Existing files are left untouched.
"""
import argparse
import csv
import re
import shutil
from pathlib import Path

TRACKS = [
    ("Kick", "01 Kick"),
    ("Snare", "02 Snare"),
    ("Drums-other", "03 Other Drums"),
    ("Bass", "04 Bass"),
    ("Guitar", "05 Guitar"),
    ("Piano", "06 Piano"),
    ("Pro-other", "07 Melodies"),
    ("Vocals-lead", "08 Lead Vocals"),
    ("Vocals-background", "09 Background Vocals"),
]
SAFE = re.compile(r'[\\/:*?"<>|]+')


def build(root, output):
    root, output = Path(root), Path(output)
    songs = {row["id"]: row for row in csv.DictReader((root / "songs.csv").open())}
    for folder in sorted((root / "stems").iterdir()):
        if not folder.is_dir() or folder.name not in songs:
            continue
        song = songs[folder.name]
        number = folder.name.split("-", 1)[0]
        target = output / SAFE.sub("_", f"{number} {song['artist']} - {song['title']}")
        target.mkdir(parents=True, exist_ok=True)
        files = list(folder.glob("*.mp3"))
        for prefix, name in TRACKS:
            matches = [f for f in files if f.name.startswith(f"{prefix} - ")]
            if len(matches) != 1:
                raise FileNotFoundError(f"{folder.name}: expected one '{prefix}' stem, found {len(matches)}")
            destination = target / f"{name}.mp3"
            if not destination.exists():
                shutil.copy2(matches[0], destination)
        print(f"{target.name}: {len(TRACKS)} stems")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("root", nargs="?", default=".fadr/groop-show", help="collection folder holding stems/ and songs.csv")
    parser.add_argument("--output", default=None, help="import folder (default: <root>/ableton-import)")
    args = parser.parse_args()
    build(args.root, args.output or Path(args.root) / "ableton-import")
