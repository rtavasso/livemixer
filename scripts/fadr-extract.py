"""Extract a Fadr ZIP into a verified, per-song folder without replacing files."""
import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
import shutil
import stat
import tempfile
import zipfile


def sha256(path):
    result = hashlib.sha256()
    with path.open("rb") as file:
        for chunk in iter(lambda: file.read(1024 * 1024), b""):
            result.update(chunk)
    return result.hexdigest()


def extract(archive, output, roles=()):
    archive, output = Path(archive), Path(output)
    fingerprint = sha256(archive)
    if output.exists():
        inventory = json.loads((output / "_stems.local.json").read_text())
        if inventory["archiveSha256"] != fingerprint:
            raise ValueError("A different archive already occupies this output folder")
        for item in inventory["files"]:
            name = item["name"]
            if Path(name).name != name or sha256(output / name) != item["sha256"]:
                raise ValueError("Extracted files changed or are missing")
        verify_roles([item["name"] for item in inventory["files"]], roles)
        return inventory
    output.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix=".extract-", dir=output.parent))
    try:
        with zipfile.ZipFile(archive) as source:
            selected = []
            names = set()
            total = 0
            for item in source.infolist():
                name = PurePosixPath(item.filename.replace("\\", "/"))
                if name.is_absolute() or ".." in name.parts or ":" in item.filename or stat.S_ISLNK(item.external_attr >> 16):
                    raise ValueError("Unsafe path in ZIP")
                if item.is_dir() or name.suffix.lower() not in {".mp3", ".wav", ".flac", ".m4a"} or "__MACOSX" in name.parts:
                    continue
                if name.name.casefold() in names:
                    raise ValueError("Duplicate stem filenames in ZIP")
                names.add(name.name.casefold())
                total += item.file_size
                if item.file_size > 512 * 1024**2 or total > 4 * 1024**3 or len(names) > 100:
                    raise ValueError("ZIP exceeds stem extraction limits")
                selected.append((item, name.name))
            if not selected:
                raise ValueError("ZIP contains no audio stems")
            verify_roles([name for _, name in selected], roles)
            inventory = {"archiveSha256": fingerprint, "files": []}
            for item, name in selected:
                destination = staging / name
                with source.open(item) as incoming, destination.open("xb") as outgoing:
                    shutil.copyfileobj(incoming, outgoing, 1024 * 1024)
                if destination.stat().st_size != item.file_size or not item.file_size:
                    raise ValueError("Incomplete or empty stem")
                inventory["files"].append({"name": name, "bytes": item.file_size, "sha256": sha256(destination)})
        (staging / "_stems.local.json").write_text(json.dumps(inventory, indent=2) + "\n")
        staging.rename(output)
        return inventory
    finally:
        if staging.exists():
            shutil.rmtree(staging)


def verify_roles(names, roles):
    # Fadr shows translated instrument labels, but ZIPs use capitalized internal IDs.
    aliases = {"melodies": {"other", "pro-other"}, "lead vocals": {"vocals-lead"},
               "background vocals": {"vocals-background"}, "other drums": {"drums-other"},
               "other melodies": {"melodics-other"}, "electric guitar": {"electric"},
               "acoustic guitar": {"acoustic"}}
    present = [name.split(" - ", 1)[0].casefold() for name in names]
    missing = []
    for role in roles:
        acceptable = aliases.get(role.casefold(), {role.casefold()})
        found = next((item for item in present if item in acceptable), None)
        if found is None:
            missing.append(role)
        else:
            present.remove(found)
    if missing:
        raise ValueError(f"ZIP is missing requested stems: {', '.join(missing)}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("archive")
    parser.add_argument("output")
    parser.add_argument("--roles", nargs="*", default=[])
    args = parser.parse_args()
    result = extract(args.archive, args.output, args.roles)
    print(json.dumps({"folder": str(Path(args.output).resolve()), "files": len(result["files"])}))
