# /// script
# requires-python = ">=3.10"
# dependencies = ["yt-dlp[default]", "imageio-ffmpeg"]
# ///
"""Match a Spotify manifest to YouTube and download resumable MP3 sources."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import shutil
import subprocess
import unicodedata


def words(value):
    text = unicodedata.normalize("NFKD", value).encode("ascii", "ignore").decode().lower()
    return set(re.findall(r"[a-z0-9]+", text))


def match_score(track, candidate):
    """Reject different versions/durations; rank plausible full-song matches."""
    duration = candidate.get("duration") or 0
    difference = abs(duration - track["duration"])
    if not duration or difference > max(5, track["duration"] * 0.025):
        return None
    title = words(re.sub(r"\(feat\..*?\)", "", track["title"], flags=re.I))
    found_title = words(candidate.get("title") or "")
    found = found_title | words(candidate.get("channel") or candidate.get("uploader") or "")
    artist = words(track["artist"].split(",\u00a0")[0])
    versions = {"live", "remix", "cover", "instrumental", "karaoke", "slowed", "sped", "acoustic", "nightcore", "reverb", "remaster", "remastered", "clean", "censored", "extended"}
    if (found_title & versions) - (words(track["title"]) & versions):
        return None
    if not title or not artist or not title <= found_title or len(artist & found) / len(artist) < 0.8:
        return None
    channel = (candidate.get("channel") or candidate.get("uploader") or "").lower()
    official = channel.endswith(" - topic") or bool(candidate.get("channel_is_verified"))
    return round(100 + 10 * official - difference, 3)


def save(path, value):
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n")
    temporary.replace(path)


def digest(path):
    with path.open("rb") as file:
        result = hashlib.sha256()
        for chunk in iter(lambda: file.read(1024 * 1024), b""):
            result.update(chunk)
        return result.hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("manifest", type=Path)
    parser.add_argument("--search-only", action="store_true")
    parser.add_argument("--only", help="Process one track ID")
    args = parser.parse_args()
    import yt_dlp
    import imageio_ffmpeg

    manifest = json.loads(args.manifest.read_text())
    tracks = manifest["tracks"]
    ids = [t["id"] for t in tracks]
    if len(set(ids)) != len(ids) or any(not re.fullmatch(r"[a-zA-Z0-9_-]{1,100}", key) for key in ids):
        raise ValueError("Track IDs must be unique safe folder names")
    if args.only and args.only not in ids:
        raise ValueError("Unknown track ID")
    root = args.manifest.resolve().parent
    state_path = root / "audio.local.json"
    state = json.loads(state_path.read_text()) if state_path.exists() else {}
    options = {"quiet": True, "noprogress": True, "socket_timeout": 30, "retries": 2,
               "extractor_retries": 2, "noplaylist": True, "js_runtimes": {"node": {}}}
    ffmpeg = shutil.which("ffmpeg") or imageio_ffmpeg.get_ffmpeg_exe()
    failures = 0
    for track in tracks:
        key = track["id"]
        if args.only and key != args.only:
            continue
        fingerprint = hashlib.sha256(json.dumps(track, sort_keys=True).encode()).hexdigest()
        record = state.get(key, {})
        if record.get("fingerprint") != fingerprint:
            record = {"fingerprint": fingerprint}
            state[key] = record
        label = f'{track["artist"]} — {track["title"]}'
        print(f"{key}: {label}", flush=True)
        try:
            if record.get("selected") and match_score(track, record["selected"]) is None:
                raise ValueError("Saved source does not pass version matching; inspect it before reuse")
            if record.get("mp3") and (root / record["mp3"]).is_file():
                if digest(root / record["mp3"]) != record.get("sha256"):
                    raise ValueError("Existing MP3 changed; move it aside before retrying")
                print("  MP3 already verified", flush=True)
                continue
            selected = record.get("selected")
            if not selected:
                candidates = []
                queries = [f'{track["artist"]} {track["title"]} official audio', f'{track["artist"]} "{track["title"]}"']
                for query in queries:
                    with yt_dlp.YoutubeDL({**options, "extract_flat": True}) as ydl:
                        result = ydl.extract_info(f"ytsearch8:{query}", download=False)
                    for entry in result.get("entries", []):
                        if not entry or any(item["id"] == entry["id"] for item in candidates):
                            continue
                        candidate = {k: entry.get(k) for k in ["id", "title", "duration", "channel", "uploader", "channel_is_verified"]}
                        candidate["url"] = entry.get("url") or entry.get("webpage_url")
                        candidate["score"] = match_score(track, candidate)
                        candidates.append(candidate)
                    if any(item["score"] is not None for item in candidates):
                        break
                record["candidates"] = candidates
                plausible = [item for item in candidates if item["score"] is not None]
                if not plausible:
                    raise ValueError("No confident title/artist/duration match; inspect saved candidates")
                selected = max(plausible, key=lambda item: item["score"])
                record["selected"] = selected
            print(f'  Match: {selected["title"]} / {selected["channel"]} / {selected["duration"]}s / {selected["url"]}', flush=True)
            record.pop("error", None)
            save(state_path, state)
            if args.search_only:
                continue
            folder = root / "sources" / key
            folder.mkdir(parents=True, exist_ok=True)
            if not re.fullmatch(r"[a-zA-Z0-9_-]{11}", selected["id"]):
                raise ValueError("Invalid YouTube video ID")
            with yt_dlp.YoutubeDL({**options, "format": "bestaudio/best", "outtmpl": str(folder / f'source-{selected["id"]}.%(ext)s')}) as ydl:
                info = ydl.extract_info(selected["url"], download=False)
                if abs((info.get("duration") or 0) - track["duration"]) > max(5, track["duration"] * 0.025):
                    raise ValueError("Full video duration no longer matches Spotify")
                ydl.process_info(info)
                source = Path(ydl.prepare_filename(info))
            # Human-readable filenames also give each Fadr upload a stable unique name.
            safe_label = re.sub(r'[^\w .()-]+', "_", label).strip(". ")[:140]
            mp3 = folder / f"{safe_label} [{key}].mp3"
            if mp3.exists():
                raise ValueError("An unverified MP3 already exists; move it aside before retrying")
            temporary = folder / "converting.partial.mp3"
            subprocess.run([ffmpeg, "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
                            "-i", str(source), "-map", "0:a:0", "-vn", "-c:a", "libmp3lame", "-q:a", "2",
                            "-metadata", f'title={track["title"]}', "-metadata", f'artist={track["artist"]}',
                            str(temporary)], check=True)
            if temporary.stat().st_size < 10000:
                raise ValueError("Converted MP3 is unexpectedly small")
            temporary.replace(mp3)
            record.update(mp3=str(mp3.relative_to(root)), sha256=digest(mp3))
            print(f"  Saved {mp3.name}", flush=True)
        except Exception as error:
            record["error"] = str(error)
            failures += 1
            print(f"  ERROR: {error}", flush=True)
        save(state_path, state)
    print(f"Saved progress to {state_path}. Errors: {failures}", flush=True)
    return bool(failures)


if __name__ == "__main__":
    raise SystemExit(main())
