"""Beat, downbeat and level analysis for one song's rendered stems.

Runs inside an isolated environment with librosa (see analysis.py), reads
the WAV stems of one song and prints JSON:

    {"bpm": 104.0, "beats": [sec, ...], "downbeats": [sec, ...], "pickup_bars": 2,
     "bar_levels": {"01 Kick": [peak dBFS per bar, ...], ...}}

Bar levels start with `pickup_bars` extrapolated bars before the first
downbeat, then one entry per detected bar.

Beats come from the drum stems (the whole mix if the drums are nearly
silent), started from a tempo prior so the tracker does not settle on half
or double time. Downbeats are the beat phase where kicks land on beat 1 and
snares on beats 2 and 4.
"""
import json
import sys
from pathlib import Path

import librosa
import numpy as np

SR = 22050
HOP = 512


def role(name):
    lowered = name.casefold()
    if "kick" in lowered:
        return "kick"
    if "snare" in lowered:
        return "snare"
    if "drum" in lowered:
        return "drums"
    return "other"


def onset(y):
    return librosa.onset.onset_strength(y=y, sr=SR, hop_length=HOP)


def sample(envelope, times):
    frames = np.clip(librosa.time_to_frames(times, sr=SR, hop_length=HOP), 0, len(envelope) - 1)
    # Take the strongest frame within ±2 frames: detected beats land a few ms off the attack.
    return np.array([envelope[max(0, f - 2) : f + 3].max() for f in frames])


def fix_octave(beats, bpm, prior):
    """Halve or double the beat list when the tracker settled an octave away from the prior."""
    if not prior:
        return beats, bpm
    if bpm > prior * 1.5:
        return beats[::2], bpm / 2
    if bpm < prior / 1.5:
        middles = (beats[:-1] + beats[1:]) / 2
        return np.sort(np.concatenate([beats, middles])), bpm * 2
    return beats, bpm


def main():
    folder, prior = Path(sys.argv[1]), float(sys.argv[2]) if len(sys.argv) > 2 and sys.argv[2] else None
    stems = {p.stem: librosa.load(p, sr=SR, mono=True)[0] for p in sorted(folder.glob("*.wav"))}
    length = min(len(y) for y in stems.values())
    stems = {name: y[:length] for name, y in stems.items()}
    drum_names = [n for n in stems if role(n) != "other"]
    drums = sum(stems[n] for n in drum_names) if drum_names else None
    mix = sum(stems.values())
    source = drums if drums is not None and np.abs(drums).max() > 0.01 else mix

    envelope = onset(source)

    def track(tightness):
        bpm, frames = librosa.beat.beat_track(onset_envelope=envelope, sr=SR, hop_length=HOP, start_bpm=prior or 120,
                                              tightness=tightness, units="frames")
        return fix_octave(librosa.frames_to_time(frames, sr=SR, hop_length=HOP), float(np.atleast_1d(bpm)[0]), prior)

    beats, bpm = track(100)
    if prior and abs(bpm / prior - 1) > 0.10:
        # Settled on a non-octave relation (e.g. a triplet feel): hold it to the listed tempo.
        beats, bpm = track(1000)

    def normalized(names):
        env = onset(stems[names[0]]) if names else envelope
        at = sample(env, beats)
        return at / (at.mean() or 1)

    kick_at = normalized([n for n in stems if role(n) == "kick"])
    snare_at = normalized([n for n in stems if role(n) == "snare"])
    bass_at = normalized([n for n in stems if "bass" in n.casefold()])

    def mean_at(values, phase):
        picked = values[phase % 4 :: 4]
        return picked.mean() if len(picked) else 0

    # Snares on 2 and 4 separate even from odd phases; kicks and bass notes
    # landing harder on beat 1 than on beat 3 separate 1 from 3.
    scores = [mean_at(snare_at, p + 1) + mean_at(snare_at, p + 3)
              + mean_at(kick_at, p) - mean_at(kick_at, p + 2)
              + mean_at(bass_at, p) - mean_at(bass_at, p + 2) for p in range(4)]
    phase = int(np.argmax(scores))
    downbeats = beats[phase::4]

    # Extend the bar grid back to the start of the song at the first bar's
    # length, so intros before the first detected downbeat get levels too.
    first_bar = downbeats[1] - downbeats[0] if len(downbeats) > 1 else 240 / bpm
    pickup = int(np.ceil(downbeats[0] / first_bar - 1e-9))
    lead = [max(0.0, downbeats[0] - p * first_bar) for p in range(pickup, 0, -1)]
    edges = np.concatenate([lead, downbeats, [length / SR]])
    levels = {}
    for name, y in stems.items():
        peaks = []
        for start, end in zip(edges[:-1], edges[1:]):
            chunk = np.abs(y[int(start * SR) : int(end * SR)])
            peaks.append(round(float(20 * np.log10(max(chunk.max() if len(chunk) else 0, 1e-6))), 1))
        levels[name] = peaks

    if len(downbeats) > 1:
        bpm = float(240 / np.median(np.diff(downbeats)))
    json.dump({"bpm": round(bpm, 3), "beats": [round(float(b), 5) for b in beats],
               "downbeats": [round(float(b), 5) for b in downbeats], "bar_levels": levels,
               "phase_scores": [round(float(s), 3) for s in scores], "pickup_bars": pickup,
               "duration": length / SR}, sys.stdout)


if __name__ == "__main__":
    main()
