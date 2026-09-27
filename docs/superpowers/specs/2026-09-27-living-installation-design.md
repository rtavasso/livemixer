# Living installation: three creatures and a musical governor

Date: 2026-09-27 · Status: approved in conversation, implementation started the same day.

## Intent

A Pepper's-ghost box with a Leap Motion (LM-010) on its floor, facing up. The visitor reaches in and
touches an upright hologram plane (parallel to the back of the box, 25–46 cm above the Leap). Ableton
plays a pre-mixed set of stem-separated songs for a whole room during a 3-hour exhibit.

- The box is **an instrument that reshapes the song**, never one that adds sounds. No one-shots,
  throws or stutters: over three hours any injected sound becomes a tic.
- It is also **an encounter**: something alive in the box responds to the visitor.
- **The room comes first.** People not at the box must always hear a pleasant song. There is one mix
  (room PA only; no speaker in the box).

## 1. The song is the instrument (governor)

Home position is the original mix. With nobody present the song plays clean (vocals follow the
existing gate: instrumental until a hand is present). A visitor pulls the song away from home on three
continuous axes; letting go drifts it back over seconds.

| Axis | Change in the song | Live target |
|---|---|---|
| Arrangement | Stem balance: drums step back while textures lead, or the reverse (±4 dB max, nothing muted) | DRUM FX / TEXTURE FX group volumes |
| Depth | Underwater ↔ surfaced: low-pass on the textures | TEXTURE FX Auto Filter (Dive) |
| Space | Close ↔ vast: continuous reverb and tempo-synced echo, never thrown | Halo send, Dub send (scaled low), Main Space |
| Vocals | The vocal gate | Vocal Presence (CC20) |

Rules:
- **Ceilings** per axis; bass and the dry vocal are never effected; drums keep their groove.
- **Slow sound, fast light.** Sound follows the simulation's slow state (0.5–3 s time constants);
  visuals respond instantly.
- **Closeness gates distance from home.** Axis excursions are scaled by the creature's `closeness`,
  so a flailing visitor gets the plain song and a patient one gets the transformed song. Agitation
  pulls toward home.
- **The song has the last word.** Live cue points named `FX QUIET` start a zone (ending at the next cue
  point) in which every axis except vocals is held at home: the pre-mixed transitions play as authored.
- **Fail safe.** Stale sim data, a closed page or a bridge timeout release everything to home.

## 2. Shared simulation rules

- Emissive light on true black; nothing is drawn as a room, table or frame.
- Everything fades to black at the calibrated hologram **active area**, with a soft top band where
  the Leap is weakest (the picture's top edge is at ~46 cm).
- Small bright regions; contact blooms outward so ~150 ms of tracking lag reads as the medium.
- Never dead: a faint idle glimmer that pulses with Live's beat.
- Upright frame: the picture is the plane the visitor reaches through (`hologramFrame: 'wall'`).

Signal contract (every living simulation publishes the same five, all 0–1):

| Signal | Meaning |
|---|---|
| `presence` | A hand is in the box (tracker presence) |
| `reach` | How far the primary hand has pushed through the picture plane |
| `lift` | Height of the hand on the picture (0 bottom, 1 top) |
| `closeness` | How near the creature(s) are to the hand; slow |
| `agitation` | Turbulence; fast; drives visuals and pulls the sound home |

## 3. The simulations

**Living Water (`tide`)**: an upright sheet of dark water. Wave motion glows like plankton with a
1–2 s afterglow; still water is black. A school of 30–80 luminous eels wanders; a still hand draws them
in after 2–3 s, a splash scatters them to the dim edges, they return after 5–10 s of calm, and patient
visitors win trust faster (habituation).

**Lantern (`lantern`)**: one translucent jellyfish bell with 12–20 physical tentacles. Its bell pulses
on the beat and that pulse is its propulsion. It drifts toward a still hand; tentacles collide with and
drape over the hand; a gentle stroke raises its glow, a poke makes it flinch, repeated fast motion
makes it jet away to a dim corner. Its glow follows the vocal gate.

**Murmuration (`murmuration`)**: 2,000–5,000 motes flocking in the sheet. The hand attracts from a
distance and repels up close; slow hands gather an orbiting halo, long stillness tightens it into a
ring, fast motion tears the ribbons apart. Closeness and agitation are flock statistics.

All three share a mood model (trust/fear with habituation) and the same contract, so the governor and
the Live mapping are built once.

## 4. Input robustness

- Skeleton → control signals; fused scan → visuals; depth blob → presence fallback (bridge, existing).
- Background model learned with the box empty and the beamsplitter in place (existing, uncommitted work).
- Bridge box `--near 0.2 --far 0.5` for the 25–46 cm picture.
- **Teleport guard**: a hand reacquired under the same id after a gap, far from where it was, restarts
  its filters with zero velocity, so tracking glitches never read as splashes.
- Surface is a band, not a plane (`reach` ramps over ±2 cm around it); glows are wider than the
  calibration's RMS error; creatures gather around regions, not points.
- Vocal release over 2–3 s after withdrawal.
- Attendant check: the hologram verify screen at session start.

## 5. Show operation

- Optional **timer rotation** between simulations (`rotate=MINUTES`, `rotation=tide,lantern,murmuration`
  in the sim URL). A change waits until the box has been empty for a few seconds, then crossfades
  through black. The operator decides later whether to use one sim or rotate.
- Live's beat position (already reported by the stutter device) is relayed to the simulations so the
  idle pulse and Lantern's swim follow the music.

## Implementation outline

1. Foundation: wall hologram mapping selected per simulation, active area in `SimContext`, music clock in
   `SimInput`, teleport guard, shared `sims/living` module (contract, membrane geometry, mood, ghost
   framing GLSL).
2. Three simulations, registered, with CPU-side unit tests and the headless render test.
3. Governor (pure TS, unit-tested), the controls page's living mode, bridge `fx` values to OSC 7403 with
   release on timeout, Two Song FX script: arrangement (group volumes) and `FX QUIET` zones, beat relay
   to the simulation page.
4. Timer rotation in the host.
5. Docs: operating guide (`docs/LIVING.md`), Live setup steps that need a person in Live.

Not verifiable here: behaviour inside Live (needs a listening pass), the physical box, and real Leap
performance. Those remain explicit checks for the operator.
