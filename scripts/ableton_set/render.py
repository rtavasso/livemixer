"""Equal-length stem rendering: decode, find the audible end, cut or pad, write WAV or FLAC."""
import json
import subprocess
import sys
import wave
from concurrent.futures import ThreadPoolExecutor

import numpy as np

AUDIO = {".mp3", ".wav", ".aif", ".aiff", ".flac", ".ogg", ".m4a"}


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


def write_stem(samples, frames, rate, target):
    """Cut or zero-pad to exactly `frames`, fade the last 10 ms, and write WAV or FLAC by suffix."""
    out = np.zeros((frames, samples.shape[1]), dtype=np.int16)
    keep = min(frames, len(samples))
    out[:keep] = samples[:keep]
    fade = min(frames, rate // 100)
    out[frames - fade :] = (out[frames - fade :] * np.linspace(1, 0, fade)[:, None]).astype(np.int16)
    temp = target.with_name(f"{target.stem}.part.wav")
    with wave.open(str(temp), "wb") as f:
        f.setnchannels(out.shape[1])
        f.setsampwidth(2)
        f.setframerate(rate)
        f.writeframes(out.tobytes())
    if target.suffix == ".flac":
        subprocess.run(["afconvert", "-f", "flac", "-d", "flac", str(temp), str(target)], check=True)
        temp.unlink()
    else:
        temp.replace(target)


def render_song(folder, render_root, silence_db, fmt):
    """Render a song's stems to equal-length files; returns ([(name, path)], frames, rate)."""
    stems = sorted(f for f in folder.iterdir() if f.suffix.lower() in AUDIO)
    target_dir = render_root / folder.name
    manifest_path = target_dir / "_render.json"
    sources = {f.name: [f.stat().st_size, int(f.stat().st_mtime)] for f in stems}
    outputs = [(f.stem, target_dir / f"{f.stem}.{fmt}") for f in stems]
    if manifest_path.exists():
        manifest = json.loads(manifest_path.read_text())
        if manifest.get("sources") == sources and manifest.get("silence_db") == silence_db and all(p.exists() for _, p in outputs):
            return outputs, manifest["frames"], manifest["rate"]
    target_dir.mkdir(parents=True, exist_ok=True)
    manifest_path.unlink(missing_ok=True)
    for old in target_dir.iterdir():
        if old.suffix in (".wav", ".flac"):
            old.unlink()
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
        list(pool.map(lambda job: write_stem(job[0][0], frames, rate, job[1][1]), zip(decoded, outputs)))
    manifest_path.write_text(json.dumps({"silence_db": silence_db, "sources": sources, "frames": frames, "rate": rate}, indent=2))
    return outputs, frames, rate
