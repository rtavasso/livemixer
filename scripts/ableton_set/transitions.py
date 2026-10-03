"""Transition planning for a continuous mix.

Pure functions over per-song timing data: no XML and no audio. Positions are
in Arrangement beats (quarter notes at the master tempo). Each song is warped
so one of its bars spans `4 * scale` beats; `scale` (½, 1 or 2) lets a song
listed at double or half time line up with its neighbours without a large
tempo ramp. A song's effective tempo is `native_bpm * scale`.
"""
import math
from dataclasses import dataclass, field

SILENT = 0.0003162277571  # Live's volume and EQ gain floor (−70 dB)
START = -63072000.0  # Live's time for an envelope's initial value
STEP = 1 / 16  # beats used for an instantaneous change
CONTENT_DB = -35.0  # a stem "has content" in a bar above this peak level
PHRASE_BEATS = 32  # 8 bars of 4 beats
SCALES = (0.5, 1.0, 2.0)

DRUMS, BASS, MELODIC, VOCALS = "drums", "bass", "melodic", "vocals"

KEY_TO_CAMELOT = {
    "ab minor": "1A", "g# minor": "1A", "b major": "1B", "cb major": "1B",
    "eb minor": "2A", "d# minor": "2A", "f# major": "2B", "gb major": "2B",
    "bb minor": "3A", "a# minor": "3A", "db major": "3B", "c# major": "3B",
    "f minor": "4A", "ab major": "4B", "g# major": "4B",
    "c minor": "5A", "eb major": "5B", "d# major": "5B",
    "g minor": "6A", "bb major": "6B", "a# major": "6B",
    "d minor": "7A", "f major": "7B",
    "a minor": "8A", "c major": "8B",
    "e minor": "9A", "g major": "9B",
    "b minor": "10A", "d major": "10B",
    "f# minor": "11A", "gb minor": "11A", "a major": "11B",
    "c# minor": "12A", "db minor": "12A", "e major": "12B",
}


def stem_role(name):
    lowered = name.casefold()
    if any(word in lowered for word in ("kick", "snare", "drum")):
        return DRUMS
    if "bass" in lowered:
        return BASS
    if "vocal" in lowered:
        return VOCALS
    return MELODIC


def camelot(key=None, code=None):
    if code:
        return code.upper()
    return KEY_TO_CAMELOT.get((key or "").strip().casefold())


def camelot_compatible(a, b):
    """Same key, a neighbour on the wheel, or the relative major/minor."""
    if not a or not b:
        return False
    number_a, letter_a = int(a[:-1]), a[-1]
    number_b, letter_b = int(b[:-1]), b[-1]
    if letter_a == letter_b:
        return (number_a - number_b) % 12 in (0, 1, 11)
    return number_a == number_b


@dataclass
class Song:
    name: str
    native_bpm: float
    downbeats: list  # seconds of detected bar starts
    pickup_bars: int  # extrapolated bars before the first downbeat
    duration: float  # seconds (the rendered, audible length)
    bar_levels: dict  # stem name -> peak dBFS per bar, pickup bars first
    camelot: str = None
    reliable: bool = True
    scale: float = 1.0

    @property
    def bpm(self):
        return self.native_bpm * self.scale

    @property
    def bar_beats(self):
        return 4 * self.scale


@dataclass
class Grid:
    """Clip-beat layout of one song: warp markers and the clip's first and last beat."""
    markers: list  # (seconds, clip beat), strictly increasing in both
    start_beat: float  # clip beat at 0 s
    end_beat: float  # clip beat at the audible end


def grid(song):
    downbeats = song.downbeats
    first_bar = downbeats[1] - downbeats[0]
    bar_beats = song.bar_beats
    start = bar_beats * (song.pickup_bars - downbeats[0] / first_bar)
    markers = [] if downbeats[0] <= 1e-6 else [(0.0, start)]
    markers += [(t, bar_beats * (song.pickup_bars + k)) for k, t in enumerate(downbeats) if t < song.duration - 1e-3]
    last_time, last_beat = markers[-1]
    last_bar = downbeats[-1] - downbeats[-2]
    end = last_beat + bar_beats * (song.duration - last_time) / last_bar
    markers.append((song.duration, end))
    return Grid(markers, markers[0][1], end)


def choose_scales(songs):
    """Halve or double a song's tempo only when that shrinks the ramp from the previous song by at least 25%.

    Songs otherwise keep their listed tempo, so bars and overlaps stay at their real length."""
    margin = math.log(1.25)
    for index, song in enumerate(songs):
        song.scale = 1.0
        if index == 0 or not songs[index - 1].reliable or not song.reliable:
            continue
        previous = songs[index - 1].bpm
        distance = lambda s: abs(math.log(song.native_bpm * s / previous))  # noqa: E731
        best = min(SCALES, key=distance)
        if distance(1.0) - distance(best) > margin:
            song.scale = best


def has_content(song, role, first_beat, last_beat):
    """True when the role's stems are above CONTENT_DB in at least half of the song's bars in the clip-beat window."""
    names = [n for n in song.bar_levels if stem_role(n) == role]
    bars = [j for j in range(len(next(iter(song.bar_levels.values()))))
            if first_beat <= j * song.bar_beats < last_beat]
    if not names or not bars:
        return False
    loud = sum(1 for j in bars if any(song.bar_levels[n][j] > CONTENT_DB for n in names))
    return loud * 2 >= len(bars)


def entry_beat(song):
    """Clip beat of the first bar where any stem has content, floored to a 4-beat boundary."""
    count = len(next(iter(song.bar_levels.values())))
    for j in range(count):
        if any(levels[j] > CONTENT_DB for levels in song.bar_levels.values()):
            return 4 * math.floor(j * song.bar_beats / 4)
    return 0.0


@dataclass
class Transition:
    outgoing: int
    incoming: int
    start: float  # Arrangement beat where the overlap begins
    bars: int  # overlap length in 4-beat bars (0 = butt join)
    style: str  # handover, crossfade, filter or butt
    blend: bool = False  # handover: incoming melodic stems start early
    reason: str = ""

    @property
    def end(self):
        return self.start + 4 * self.bars


@dataclass
class Plan:
    songs: list
    grids: list
    origins: list  # Arrangement beat of each song's clip beat 0
    clip_ends: list  # Arrangement beat where each song's clips end
    transitions: list
    locators: list = field(default_factory=list)  # (beat, name)


def choose_style(a, b, window_a, window_b):
    if not (a.reliable and b.reliable):
        return "crossfade", False, "beat grid uncertain"
    drums = has_content(a, DRUMS, *window_a) and has_content(b, DRUMS, *window_b)
    bass = has_content(a, BASS, *window_a) and has_content(b, BASS, *window_b)
    keys = f"{a.camelot or '?'}→{b.camelot or '?'}"
    if not camelot_compatible(a.camelot, b.camelot):
        if drums:
            return "handover", False, f"keys clash ({keys}): no melodic overlap"
        return "short-crossfade", False, f"keys clash ({keys}) and no drums to carry a handover"
    close = abs(math.log(b.bpm / a.bpm)) <= math.log(1.08)
    if close and drums:
        return "filter", False, f"compatible keys ({keys}), tempos within 8%"
    if drums and bass:
        return "handover", True, f"compatible keys ({keys})"
    return "crossfade", False, f"compatible keys ({keys}), missing drums or bass"


def plan(songs, overlap_bars=16, style=None):
    """Place songs, pick overlaps and styles. Mutates each song's scale.

    `style`: "crossfade" to crossfade every transition instead of choosing per pair."""
    choose_scales(songs)
    grids = [grid(s) for s in songs]
    origins = [-4 * math.floor(grids[0].start_beat / 4)]
    clip_ends = [origins[0] + grids[0].end_beat]
    transitions = []
    earliest = origins[0] + grids[0].start_beat
    for i in range(1, len(songs)):
        a, b = songs[i - 1], songs[i]
        ga, gb = grids[i - 1], grids[i]
        origin_a = origins[i - 1]
        entry = entry_beat(b)
        bars = overlap_bars
        start = None
        while bars >= min(4, overlap_bars) and bars > 0:
            phrase = math.floor((ga.end_beat - 4 * bars) / PHRASE_BEATS)
            candidate = origin_a + PHRASE_BEATS * phrase
            if phrase >= 0 and candidate >= earliest and gb.end_beat - entry >= 4 * bars:
                start = candidate
                break
            bars //= 2
        if start is None:
            start, bars = origin_a + ga.end_beat, 0
            kind, blend, reason = "butt", False, "songs too short to overlap"
        elif style:
            kind, blend, reason = style, False, f"{style} for every transition"
        else:
            window_a = (start - origin_a, start - origin_a + 4 * bars)
            window_b = (entry, entry + 4 * bars)
            kind, blend, reason = choose_style(a, b, window_a, window_b)
            if kind == "short-crossfade":
                if bars > 4:
                    start += 4 * (bars - 4)
                    bars = 4
                kind = "crossfade"
        transitions.append(Transition(i - 1, i, start, bars, kind, blend, reason))
        clip_ends[i - 1] = min(clip_ends[i - 1], start + 4 * bars)
        origins.append(start - entry)
        clip_ends.append(origins[i] + gb.end_beat)
        earliest = start + 4 * bars
    locators = []
    for i, song in enumerate(songs):
        beat = transitions[i - 1].start if i else origins[0] + entry_beat(song)
        locators.append((beat, song))
    return Plan(songs, grids, origins, clip_ends, transitions, locators)


def seconds_at(markers, beat):
    """Audio seconds at a clip beat, along the warp markers [(seconds, clip beat)], extended past either end."""
    for (s0, b0), (s1, b1) in zip(markers, markers[1:]):
        if beat <= b1 or (s1, b1) == markers[-1]:
            return s0 + (beat - b0) * (s1 - s0) / (b1 - b0)
    return markers[-1][0]


@dataclass
class Retimed:
    """A plan laid out for unwarped clips: every song at its own speed, Live's tempo following the song heard."""
    clip_starts: list  # Arrangement beat where each song's audio starts (0 s)
    clip_ends: list  # Arrangement beat where each song's clip ends
    end_seconds: list  # audio seconds where each song's clip ends
    envelopes: dict  # the plan's automation moved onto the new Arrangement beats, tempo replaced
    locators: list  # (beat, song)
    zones: list  # (start, end) beats of every overlap


def natural_speed(plan_, envelopes):
    """Retime a plan so no song is ever sped up or slowed down.

    Transitions keep the plan's phrase points, found on each song's analysed beat grid, but are laid out in
    seconds: each overlap lasts the outgoing song's own bars, the incoming song's audio simply plays, and Live's
    tempo steps to the incoming song's at the end of the overlap (only the grid, FX QUIET markers and the
    position Living FX reports follow it). A wrong tempo estimate then moves a grid line, never the audio."""
    songs, grids = plan_.songs, plan_.grids
    starts, end_seconds, spans = [0.0], [], []  # spans: (old start, old end, new start s, new end s)
    for t in plan_.transitions:
        out_beat = t.start - plan_.origins[t.outgoing]
        at = seconds_at(grids[t.outgoing].markers, out_beat)
        length = seconds_at(grids[t.outgoing].markers, out_beat + 4 * t.bars) - at
        begin = starts[t.outgoing] + at
        starts.append(begin - seconds_at(grids[t.incoming].markers, t.start - plan_.origins[t.incoming]))
        end_seconds.append(at + length)
        spans.append((t.start, t.start + 4 * t.bars, begin, begin + length))
    end_seconds.append(songs[-1].duration)
    changes = [(span[3], songs[k + 1].bpm) for k, span in enumerate(spans)]
    origin = plan_.origins[0] + grids[0].start_beat

    def beat(sec):
        result, at, bpm = origin, 0.0, songs[0].bpm
        for when, following in changes:
            if sec <= when:
                break
            result, at, bpm = result + (when - at) * bpm / 60, when, following
        return result + (sec - at) * bpm / 60

    def remap(x):
        for old0, old1, new0, new1 in spans:
            if old1 > old0 and old0 - 2 * STEP <= x <= old1 + 1e-9:
                b0, b1 = beat(new0), beat(new1)
                return b0 + (x - old0) * (b1 - b0) / (old1 - old0)
        raise ValueError(f"automation at beat {x} is outside every transition")

    moved = {target: (initial, [(remap(b), v) for b, v in points])
             for target, (initial, points) in envelopes.items() if target != "tempo"}
    tempo = []
    for (when, following), previous in zip(changes, songs):
        tempo += [(beat(when) - STEP, previous.bpm), (beat(when), following)]
    moved["tempo"] = (songs[0].bpm, tempo)
    locators = [(beat(seconds_at(grids[0].markers, plan_.locators[0][0] - plan_.origins[0])), songs[0])]
    locators += [(beat(span[2]), song) for span, song in zip(spans, songs[1:])]
    return Retimed(clip_starts=[beat(s) for s in starts], clip_ends=[beat(s + e) for s, e in zip(starts, end_seconds)],
                   end_seconds=end_seconds, envelopes=moved, locators=locators,
                   zones=[(beat(n0), beat(n1)) for o0, o1, n0, n1 in spans if o1 > o0])


def fade(start, end, rising, points=9):
    """Equal-power fade as (beat, gain) breakpoints."""
    if end - start < STEP:
        return step(start, rising)
    out = []
    for n in range(points):
        u = n / (points - 1)
        gain = math.sin(math.pi / 2 * u) if rising else math.cos(math.pi / 2 * u)
        out.append((start + (end - start) * u, max(SILENT, gain)))
    return out


def step(at, rising):
    return [(at - STEP, SILENT if rising else 1.0), (at, 1.0 if rising else SILENT)]


def automation(plan_):
    """Breakpoints per target: ("stem", song, stem name), ("group", song), ("eq", song) and "tempo".

    Returns {target: (initial value, [(beat, value), ...])}."""
    moves = {}  # target -> list of (breakpoints, rising)

    def add(target, points, rising):
        moves.setdefault(target, []).append((points, rising))

    for t in plan_.transitions:
        if t.style == "butt" or t.bars == 0:
            continue
        a, b = plan_.songs[t.outgoing], plan_.songs[t.incoming]
        at = lambda bars: t.start + 4 * bars  # noqa: E731
        length = t.bars
        if t.style == "handover":
            for name in a.bar_levels:
                role = stem_role(name)
                target = ("stem", t.outgoing, name)
                if role == DRUMS:
                    add(target, fade(at(3 * length / 4), at(length), False), False)
                elif role == BASS:
                    add(target, step(at(length / 2), False), False)
                else:
                    add(target, fade(at(length / 4), at(length / 2), False), False)
            for name in b.bar_levels:
                role = stem_role(name)
                target = ("stem", t.incoming, name)
                if role == DRUMS:
                    add(target, fade(at(0), at(length / 4), True), True)
                elif role == BASS:
                    add(target, step(at(length / 2), True), True)
                elif role == VOCALS:
                    pass  # silent until the outgoing song has finished (below)
                elif role == MELODIC and t.blend:
                    add(target, fade(at(length / 4), at(length / 2), True), True)
                else:
                    add(target, fade(at(length / 2), at(length), True), True)
        elif t.style == "crossfade":
            add(("group", t.outgoing), fade(at(0), at(length), False), False)
            add(("group", t.incoming), fade(at(0), at(length), True), True)
        elif t.style == "filter":
            add(("group", t.incoming), fade(at(0), at(length / 4), True), True)
            add(("eq", t.incoming), step(at(length / 2), True), True)
            add(("eq", t.outgoing), step(at(length / 2), False), False)
            add(("group", t.outgoing), fade(at(3 * length / 4), at(length), False), False)
        # The incoming song's vocals stay silent until the outgoing song has ended, whatever the vocal
        # presence gain: two singers never overlap.
        for name in b.bar_levels:
            if stem_role(name) == VOCALS:
                add(("stem", t.incoming, name), step(at(length), True), True)

    envelopes = {}
    for target, entries in moves.items():
        entries.sort(key=lambda e: e[0][0][0])
        initial = SILENT if entries[0][1] else 1.0
        envelopes[target] = (initial, [p for points, _ in entries for p in points])

    tempo = []
    for t in plan_.transitions:
        a, b = plan_.songs[t.outgoing], plan_.songs[t.incoming]
        if t.bars:
            tempo += [(t.start, a.bpm), (t.end, b.bpm)]
        else:
            tempo += [(t.start - STEP, a.bpm), (t.start, b.bpm)]
    envelopes["tempo"] = (plan_.songs[0].bpm, tempo)
    return envelopes
