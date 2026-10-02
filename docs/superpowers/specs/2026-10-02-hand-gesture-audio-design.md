# Hand gestures in the music: design

Status: accepted, 2026-10-02 (one hand conducts everything; two hands split halves with a meaningful span; every gesture at full strength). Builds on the living installation
([2026-09-27](2026-09-27-living-installation-design.md), [LIVING-MUSIC.md](../../LIVING-MUSIC.md)).

## Problem

The visitor's hand changes the song too little to notice, and what does change does not read as
caused by the gesture:

- A stranger may move the song only 35% of the way (`baseAllowance`), and agitation cuts that further.
- Axes move with 0.8–3 s time constants: too slow to feel caused by the hand.
- Ceilings are low: about 10% wet reverb, dub echo 0.3, drum/texture balance ±4 dB.
- Reverb and echo answer "closeness", which no visitor can perceive as an action.

Goal: every gesture has an effect that is **noticeable**, **semantically matches the action**, and is
**never unpleasant**; one hand and two hands both behave sensibly.

## Inputs

Per hand, from telemetry (`input.hands[]`, already broadcast to the controls page): position on the
picture (x, height y), reach through the picture (z), speed, `openness` (grip = 1 − openness) and
`palmUp` (1 up … −1 down, 0 sideways or unknown). Each is smoothed per hand id (rise ~0.15 s, fall ~0.3 s)
before anything below reads it.

The simulation signals stay as they are and keep their jobs (presence gates vocals; closeness and
agitation still shape the creatures and allowance).

## One hand, two hands

**Roles.** With one hand present it *conducts the whole song*. With two, each hand takes half of the
band and the gap between them becomes a control:

| | One hand | Two hands |
|---|---|---|
| Grip (muffle, freeze) | that hand | the **larger** grip (any fist grabs) |
| Palm (air / weight) | whole song | each hand on **its own half** |
| Height (layer spotlight) | which layer leads | each hand sets **its half's** level |
| Reach (dive) | that hand | the deeper reach |
| Span | — | distance between hands → width and space |

**Halves by side, not anatomy.** The hand farther left on the picture is the **rhythm half** (DRUM FX,
Bass), the other the **melodic half** (TEXTURE FX, VOCALS). Roles swap only when the hands cross by a
clear margin (hysteresis ~0.08 picture widths), never because the tracker relabels a hand.

**Handover.** When a second hand arrives or one leaves, every combined value crossfades from its
one-hand to its two-hand form over 0.5 s, so a dropped hand never produces a jump.

Decided: halves.

## Gestures and their sound

| Gesture | Meaning | Sound | Live |
|---|---|---|---|
| Closing the fist (continuous grip) | holding the sound | **Muffle:** low-pass closes, gentle saturation, stereo narrows | Auto Filter (low resonance) + Saturator (Soft Sine, low drive) + Utility width on the affected half or the whole song |
| Holding a fist ≥ ~0.4 s | grabbing the moment | **Freeze:** the instant is held as a sustained, shimmering texture while the song ducks under it | **Spectral Time** Freeze on a return fed by the song; dry ducked ~6 dB while frozen |
| Opening the hand | letting go | **Release bloom:** freeze fades out over ~1.5 s, a short reverb swell trails the moment, the song comes back up | freeze off + Hybrid Reverb send swell |
| Palm up | lift, offering | **Air:** high shelf up, shimmer on melodies and vocals, vocals slightly forward | EQ Eight high shelf + Hybrid Reverb (shimmer) send |
| Palm down | press, calm, ground | **Weight:** highs dip slightly, bass forward, reverb dries | EQ Eight shelf down + bass group up + sends down |
| Hand height | which layer leads | **Layer spotlight:** high = melody and vocals forward, low = drums and bass forward, ±8–10 dB | existing DRUM FX / TEXTURE FX group volumes, larger range |
| Reach through the picture | going under | **Underwater dive** (unchanged in kind, full range) | existing TEXTURE FX Auto Filter |
| Two hands apart | expand | **Width and space:** stereo wider, reverb larger | Utility width on Main + reverb size/send |
| Fast swipe | disturbance | **Whoosh:** a short filter sweep that recovers (replaces only pulling the song home) | Auto Filter on Main, one-shot envelope |

### Why the freeze is Spectral Time, not Beat Repeat

Beat Repeat follows Live's tempo and grid, not the audio. In the natural-speed set Live's tempo is the
analysed estimate (wrong for some songs, e.g. "red": 84 BPM analysed as 112) and songs' beats do not sit
on Live's bar lines, so a synced repeat would stutter off the beat on roughly a third of the set.
Spectral Time's Freeze needs no tempo or phase, smears harmony instead of chopping rhythm, and works on
every song. Freeze length is capped (~6 s held, then it releases on its own) so nobody can leave the
song stuck.

## Keeping it pleasant

- Responses fast enough to feel caused (0.15–0.4 s) but never instantaneous: every control is ramped.
- Filters with low resonance; saturation subtle; shelves ≤ ±6 dB.
- Anything time-based is either unsynced by nature (freeze, reverb) or already tempo-locked by Live
  (none needed here).
- A limiter stays last on Main; the freeze return is ducked against nothing and capped in level.
- Transitions keep priority: inside FX QUIET zones every gesture effect holds at home, as now.
- Fail-safe: with no telemetry for 750 ms every gesture control returns home over ~1 s.

## Allowance

Decided: **full strength.** Gestures (muffle, freeze, bloom, tilt, levels, dive, span, whoosh) act at
full strength immediately; allowance no longer scales them. Only `space` (closeness: the creatures' slow
reverb/echo) keeps allowance as its ceiling.

## Live set layout (`--gestures`, Live 11)

Per-song devices would add ~250 always-running devices to a 48-song set, so the halves are buses:

- Two top-level groups, **RHYTHM** and **MELODIC**. Each song contributes one subgroup to each, named
  after the song: the rhythm subgroup holds DRUM FX (Kick, Drums) and Bass; the melodic subgroup holds
  TEXTURE FX (Melodic, with the dive Auto Filter) and VOCALS (Vocal Presence). Song crossfades automate
  both of a song's subgroups; vocals keep their own volume automation.
- On RHYTHM and on MELODIC, in order: **Auto Filter** "Muffle" (low-pass, low resonance, open at rest),
  **EQ Eight** "Tilt" (low shelf and high shelf, 0 dB at rest), **Utility** "Level" (gain 0 dB at rest).
- On Main, before the Limiter: **Auto Filter** "Whoosh" (open at rest), **Spectral Time** "Freeze"
  (Freeze mode, Dry/Wet 0 at rest), **Utility** "Span" (width 100% at rest).
- Returns unchanged (dub echo, halo reverb). Bloom raises the Main reverb ("Space") briefly.

## Contract

`controls.fx` (page → bridge, JSON) gains ten values, all finite and in 0..1; the bridge appends them to
`/fx/values` (UDP 7403) after the existing five, in this order:

| # | Key | Home | Meaning |
|---|---|---|---|
| 0–4 | flicker, dub, dive, halo, balance | as now | unchanged (`balance` still sent for old devices) |
| 5 | muffleRhythm | 0 | 0 open … 1 fully muffled (RHYTHM Muffle) |
| 6 | muffleMelodic | 0 | same for MELODIC |
| 7 | tiltRhythm | .5 | 0 full weight (palm down) … .5 flat … 1 full air (palm up) |
| 8 | tiltMelodic | .5 | same for MELODIC |
| 9 | levelRhythm | .5 | gain in dB: below .5 down to −10 dB at 0, above up to +6 dB at 1 |
| 10 | levelMelodic | .5 | same for MELODIC |
| 11 | freeze | 0 | 1 = frozen (the combiner owns hold time, cap and re-arm; the device only ramps) |
| 12 | bloom | 0 | release swell envelope (Main reverb up briefly) |
| 13 | span | .5 | 0 narrow … .5 normal … 1 wide (Main width, a little more reverb) |
| 14 | whoosh | 0 | one-shot sweep envelope (Main Auto Filter) |

A missing `fx` value means home. Inside FX QUIET zones the device holds every gesture value at home.

### Combiner rules

- Per hand (by id): grip = 1 − openness, palmUp, height y, reach z, speed; smoothed (rise 0.15 s, fall 0.3 s).
- **One hand:** muffle both halves = grip; tilt both = .5 + .5·palmUp; levels from height (spotlight):
  levelMelodic = y, levelRhythm = 1 − y (within ±0.08 of the middle both stay .5); span = .5.
- **Two hands:** the hand farther left on the picture is rhythm, the other melodic (swap only when they
  cross by > 0.08 picture widths). Each hand sets its half: muffle = its grip, tilt = .5 + .5·its palmUp,
  level = its height. span = .5 + .5·clamp((distance − 0.35) / 0.25, −1, 1).
- **Handover:** when the hand count changes, every value crossfades to its new form over 0.5 s.
- **Freeze:** the larger grip ≥ 0.7 for 0.4 s → freeze = 1; it ends when the larger grip ≤ 0.4, or after
  6 s, and then needs grip ≤ 0.4 before it can freeze again. Ending a freeze fires bloom.
- **Bloom:** 1 when a freeze ends, decaying with τ 0.8 s.
- **Whoosh:** any hand's speed ≥ 1.6 sim units/s → 1, decaying with τ 0.4 s; at most once per 0.8 s.
- **Dive:** reach at full strength (no allowance), as the governor's depth with its usual time constant.
- **No hands / no telemetry for 750 ms:** everything returns home over about 1 s.

## Changes

1. **Hand combiner** (`src/living/hands.ts`, pure): per-hand smoothing, role assignment with hysteresis,
   one/two-hand handover, combined values (grip, freeze state machine with hold time and cap, palm per
   half, height per half, reach, span, swipe one-shot). Unit-tested like the governor.
2. **Governor / controls**: `src/ableton/main.ts` passes `frame.input.hands` to the combiner; the
   controls message gains the new values (bridge schema extended; old fields unchanged).
3. **Bridge** (`scripts/ableton-bridge.py`): new OSC values for the Living FX device.
4. **Live set** (`scripts/ableton-stem-set.py` living layout + Live 11 templates): per song EQ Eight on
   TEXTURE FX and VOCALS (air/weight), Saturator + Utility on the song group (muffle); Main gains Auto
   Filter (whoosh), Utility width; a third return with Spectral Time (freeze) and the Hybrid Reverb
   return gains a shimmer setting.
5. **Living FX device** (`devices/LiveMixer Living FX/living-fx.js`): drive the new parameters, per half
   where the gesture is per half, cached ids and write-on-change as now.
6. **Docs**: LIVING-MUSIC.md gesture table; LIVING.md updated.

## Verification

- Combiner unit tests: one hand, two hands, crossing with hysteresis, a hand dropping mid-gesture, freeze
  hold/cap/release, swipe one-shot, fail-safe.
- Living FX tests with the mock Live API: each value reaches the right parameters, nothing written when
  idle.
- Set-builder tests: new devices present on every song, returns count consistent with sends.
- By ear in Live 11 with the pointer source (Shift = fist, U / D = palm) and then the Leap, on a short
  set including a misanalysed song.
