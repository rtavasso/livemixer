"""Lighter sets: a song's rendered stems summed down to five tracks.

Kick and Bass stay as they are; Snare + Other Drums become "02 Drums", every melodic stem "05 Melodic" and
every vocal "08 Vocals". Transitions move all stems of a role together, so merging within a role changes
nothing there; the merged names keep their roles (see transitions.stem_role). Kick stays apart so the dub
echo never takes it. Merged files go to merged-stems/<song>/ beside rendered-stems/, which beat analysis
still reads (it needs kick and snare apart).
"""
import json
import wave

import numpy as np

from . import transitions as tx

MERGED = {tx.DRUMS: "02 Drums", tx.MELODIC: "05 Melodic", tx.VOCALS: "08 Vocals"}


def merged_name(stem):
    role = tx.stem_role(stem)
    if role == tx.BASS or "kick" in stem.casefold():
        return stem
    return MERGED[role]


def _read(path):
    with wave.open(str(path)) as f:
        return np.frombuffer(f.readframes(f.getnframes()), dtype="<i2").reshape(-1, f.getnchannels()), f.getframerate()


def _write(samples, rate, target):
    temp = target.with_name(f"{target.stem}.part.wav")
    with wave.open(str(temp), "wb") as f:
        f.setnchannels(samples.shape[1])
        f.setsampwidth(2)
        f.setframerate(rate)
        f.writeframes(samples.tobytes())
    temp.replace(target)


def merge_song(stems, out_dir):
    """[(name, path)] of rendered stems -> [(merged name, path)], writing each sum once (cached in _merge.json)."""
    groups = {}
    for name, path in stems:
        groups.setdefault(merged_name(name), []).append((name, path))
    manifest_path = out_dir / "_merge.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8")) if manifest_path.exists() else {}
    out = []
    for name, parts in groups.items():
        if len(parts) == 1:
            out.append((name, parts[0][1]))
            continue
        target = out_dir / f"{name}.wav"
        sources = {p.name: [p.stat().st_size, int(p.stat().st_mtime)] for _, p in parts}
        if manifest.get(name, {}).get("sources") != sources or not target.exists():
            out_dir.mkdir(parents=True, exist_ok=True)
            total = None
            for _, path in parts:
                samples, rate = _read(path)
                total = samples.astype(np.int32) if total is None else total + samples
            clipped = int(np.count_nonzero((total > 32767) | (total < -32768)))
            _write(np.clip(total, -32768, 32767).astype("<i2"), rate, target)
            manifest[name] = {"sources": sources, "clipped_samples": clipped}
            manifest_path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
        out.append((name, target))
    return out


def merge_levels(bar_levels):
    """Per-bar peaks of merged stems: the loudest part, which is what the planner asks of a role."""
    merged = {}
    for name, levels in bar_levels.items():
        key = merged_name(name)
        merged[key] = levels if key not in merged else [max(a, b) for a, b in zip(merged[key], levels)]
    return merged
