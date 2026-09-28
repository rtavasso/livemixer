# Automatic transitions for the Ableton stem set

## Goal

Extend `scripts/ableton-stem-set.py` so the generated set is a continuous, beat-matched DJ-style mix: each song plays at its native tempo, songs overlap during a transition, the master tempo ramps across the overlap, and the handover is written as automation Live plays back. The user listens and asks for changes afterwards ("3→4 as a crossfade", "bring Ladders in 8 bars later"); there is no per-transition configuration file in this iteration.

## Decisions made with the user

| Question | Decision |
|---|---|
| Purpose | Continuous DJ-style mix, edited in Live afterwards |
| Control | Automatic; changes requested after listening |
| Tempo | Native tempo per song, ramp across each overlap |
| Styles | Stem handover, beat-matched crossfade, and filter/EQ swap, chosen automatically per transition |
| Beat analysis | librosa (approach A) in an isolated `uv` environment, with kick/snare stems locating downbeats |
| Tempo and key | Looked up on the web (sites republishing Spotify's audio features), stored in an editable file |

## Inputs

- Song folders and ordering, as today.
- Rendered equal-length WAV stems, as today (`rendered-stems/`).
- `tempo-key.json` beside the stems folder: `{ "<song folder>": { "bpm": 104, "key": "F minor", "camelot": "4A", "sources": [...] } }`. Filled once from a web search and editable by hand. A song missing from the file falls back to the analysed tempo and has an unknown key.

## Units

The single script is split into a small package, `scripts/ableton_set/`, keeping `scripts/ableton-stem-set.py` as the command:

| Module | Responsibility | Depends on |
|---|---|---|
| `als.py` | Template loading, track cloning, pointee Ids, clips, warp markers, automation envelopes, locators, writing the set | template `.als` |
| `render.py` | Existing equal-length WAV rendering and cache | numpy, afconvert |
| `analysis.py` | Per-song tempo, beat times, downbeats, phrase starts; cached as `rendered-stems/<song>/_analysis.json` | runs under `uv run --with librosa` |
| `transitions.py` | Pure functions: choose style, compute overlap and cue points, produce per-track volume/EQ/tempo breakpoints in beats | none (plain data in, plain data out) |
| `ableton-stem-set.py` | CLI, song selection, orchestration, printed report | the above |

`transitions.py` has no XML or audio dependency, so its rules are unit-testable with plain numbers.

## Analysis

1. Tempo prior: the `tempo-key.json` BPM when present, else librosa's estimate. The beat tracker is started from the prior, so it does not lock to half or double time.
2. Beats: `librosa.beat.beat_track` on the sum of the drum stems (Kick, Snare, Other Drums), falling back to the full mix for songs without drums.
3. Downbeats: for each of the four possible bar phases, score kick onset strength on beat 1 plus snare onset strength on beats 2 and 4; the best phase marks bar starts.
4. Phrases: 8-bar blocks counted from the first downbeat.
5. Cached per song with the source file sizes and times, like the render cache.

## Warping

Every clip becomes warped, with a warp marker on each downbeat from that song's analysis (identical markers for all stems of a song, so they stay aligned). Warp mode is Beats for drum stems and Complex Pro for the others. Outside transitions the tempo automation equals the song's local tempo, so songs play at their native speed; only the overlap is stretched.

## Layout and tempo

- Overlap length: 16 bars by default (`--overlap-bars`), shortened to fit songs whose outro or intro is shorter.
- Out point: the outgoing song's last phrase start that leaves at least the overlap length before its audible end. The incoming song's first downbeat lands on that phrase start.
- Tempo automation: hold A's tempo until the overlap, ramp linearly to B's tempo across it, hold B's tempo afterwards. Locator per song: `SONG: <name> · <bpm> BPM · <camelot>`.

## Transition styles

All timings are in bars from the start of the overlap (length L, default 16).

- **Handover**: incoming drums fade in over bars 0–4; outgoing vocals and melodic stems (Guitar, Piano, Melodies, Lead and Background Vocals) fade out over bars 4–L/2; bass swaps on the downbeat at L/2 (outgoing bass cut, incoming bass in, never both); incoming melodic stems and vocals fade in over L/2–L; outgoing drums fade out over the last 4 bars. Nothing harmonic overlaps. When the keys are compatible, the incoming melodic stems (not vocals) start earlier, fading in over L/4–L/2, so the melodies blend.
- **Crossfade**: equal-power fade between the two song groups' volumes across the overlap.
- **Filter swap**: an EQ Three on every song group. The incoming group starts with its low band killed and enters with a volume fade over bars 0–4; at L/2 the incoming lows return and the outgoing lows are killed; the outgoing group fades out over the last 4 bars.

## Automatic choice

Keys are compatible when they are the same, adjacent, or relative on the Camelot wheel.

1. Keys clash or a key is unknown: harmonic material must not overlap. Use **handover** without the melodic blend; if either song lacks drum content in the overlap, use a **crossfade** shortened to 4 bars.
2. Keys compatible, tempos within 8%, and both songs have drum content in the overlap: **filter swap**.
3. Keys compatible and both songs have drum and bass content in the overlap: **handover** with the melodic blend.
4. Otherwise: **crossfade**.

"Has content" means the stem is above the silence threshold for at least half of the overlap.

## Output

The printed report lists, per transition, the style, the overlap bars in Arrangement position, both tempos and keys, and the reason for the choice. The same data is written beside the set as `<set name>.transitions.json`, the basis for later per-transition overrides.

## Error handling

- Missing `uv` or a failed librosa install: stop with the command to fix it; no partial set.
- Analysis that finds fewer than 16 downbeats, or a tempo more than 10% from the `tempo-key.json` value after half/double correction: warn in the report and use crossfade for that song's transitions.
- A song shorter than two overlaps: shorten its overlaps to fit, down to 4 bars, else butt join as today.

## Testing

- `tests/test_ableton_transitions.py` (unittest): Camelot compatibility, style choice, out-point and overlap math, handover and filter breakpoints, tempo ramp breakpoints.
- `tests/test_ableton_set_xml.py` (unittest): builds a set from two tiny synthetic songs (generated sine and click WAVs) and checks unique pointee and track Ids, send counts against return tracks, automation envelopes pointing at existing targets, and warp markers present and ascending.
- An `npm run test:ableton-set` script runs both.
- Manual: open the full set in Live, confirm it loads without log errors, and listen to each transition.

## Out of scope

Reordering songs by key or tempo, pitch-shifting for key matching, structure detection (intro, chorus, outro), per-transition override files, and live gesture control of transitions.
