# Living installation

Three creatures for the Pepper's-ghost box, and a governor that lets the visitor reshape the song
without making it unpleasant for the room. Design: [the spec](superpowers/specs/2026-09-27-living-installation-design.md).
Music side: [LIVING-MUSIC.md](LIVING-MUSIC.md).

| Simulation | What the visitor meets |
|---|---|
| **Tide** (`tide`) | An upright sheet of dark water that glows like plankton where it is disturbed, home to a school of luminous eels. A still hand draws them in; a splash scatters them. |
| **Lantern** (`lantern`) | One translucent jellyfish that swims in time with the music, comes to a still hand and drapes its tentacles over it; a poke makes it flinch, fast motion sends it away. |
| **Murmuration** (`murmuration`) | Thousands of motes of light flocking in folding ribbons; a gentle hand gathers an orbiting halo, stillness tightens it into a ring, fast motion tears it apart. With Live's levels relayed it pulses with the music, hand or no hand: each rhythm hit brightens the motes and draws them in for a breath (toward the flock's centre, or the trusted hand's halo), and the melodic parts run a slow shimmer through them (`musicPulse`, `musicShimmer`; 0 = off). Drawing only: the flock, its agitation and its signals never hear the music, so it cannot feed back into itself. |

All three are emissive light on black (black is invisible in the ghost), fade out at the calibrated
active area and over the top of the picture where the Leap is weakest, and share one mood model:
creatures approach a hand that has been still for a couple of seconds, flee agitation, return after
calm, and trust a patient visitor faster. Every one publishes the same signals, so the music mapping
does not change with the simulation:

| Signal | Meaning | Music |
|---|---|---|
| `presence` | A hand is in the box | Vocal gate |
| `reach` | How far the hand has pushed through the picture | Depth (underwater filter on the textures) |
| `lift` | Hand height on the picture | Arrangement (up: textures lead, down: rhythm leads) |
| `closeness` | How near the creatures are to the hand (slow) | Space, and how far the song may move from the original mix |
| `agitation` | Turbulence (fast) | Pulls the song back toward the original mix |

## Hand gestures

Every hand also carries `grip` (0 open … 1 fist) and `palmUp` (1 palm up … −1 palm down, 0 sideways or
unknown); see the palm facing in [SIMULATIONS.md](SIMULATIONS.md). They only shape how creatures behave
once they have chosen to come to the hand: fear still wins, and an open, sideways hand behaves exactly as
before. They do not change the five signals' meaning (closeness moves only because the creatures really do).

| | Fist | Palm up | Palm down |
|---|---|---|---|
| **Tide** | The willing school coils into a tighter ring around the fist and is pulled onto it harder (`fistCoil`, `fistPull`) | The plankton glow wells up brighter and wider where the hand touches the water (`offering`) | The water under the hand calms: rings, wake and splash damped, its light fades faster (`calming`) |
| **Lantern** | It rests higher above the hand with its tentacles drawn in and curled: wary, not fleeing (`fistGap`, `fistCurl`) | An open upturned palm invites it: it comes a little sooner, sits lower on the palm, drapes heavier and glows brighter (`palmSettle`) | It hovers above the hand instead of draping (`hoverGap`) |
| **Murmuration** | The halo shrinks into a small, dense, brighter ball (`gripTighten`) | The halo floats up off the hand (`palmLift`) | The halo sinks below the hand and its orbit slows |

All of it eases in over a few tenths of a second, so tracker flicker never pops. The tunables are in each
simulation's settings panel. Without a Leap, the pointer source fakes them: **Shift** (or the right button)
for a fist, hold **U** / **D** for palm up / down.

## Run the show

1. **Start everything**: `npm run show` (see [SHOW.md](SHOW.md)). That one command starts and
   supervises the page server, the Ableton bridge, the Leap bridge and the two Chrome windows; it also
   covers the Mac setup, logs and what recovers by itself. Keep the box empty for the first seconds so the
   Leap bridge learns the background, including the beamsplitter's reflection. The box is 20-55 cm above
   the controller; the picture spans about 25-46 cm.
   - One creature all night: `LIVEMIXER_SIM=tide`, `lantern` or `murmuration`.
   - Rotate on a timer: `LIVEMIXER_SIM_PARAMS='rotate=20'` (minutes), optionally with
     `&rotation=tide,lantern,murmuration`. A change waits until the box has been empty for four seconds,
     then fades through black; a hand arriving mid-fade cancels it.
   - By hand instead (development): `sh bridge/run-leap.sh`, `npm run dev`, and
     `http://127.0.0.1:4178/sim.html?source=depth&sim=tide&overlay=0`, fullscreen with **F**.
2. **Hologram calibration** (once per setup, and whenever the box has been moved): press **X** (or **H** → *Calibrate hologram…*), size the active area to the visible picture, then touch the nine X's and do the
   pull-back capture. Living simulations read the calibration through the upright *wall* frame (the
   picture plane at sim depth 0.5), so pushing a hand *through* the picture is kept as `reach`; Basin and
   Shallows keep the top-down *floor* frame. Switching simulations switches the frame automatically.
   Calibrate in the show's own simulation window: the calibration is stored per browser profile and
   address, so one made on the dev server (port 4178) does not carry over to the show (port 4179).
3. **Attendant check** at the start of each session: open the calibration's verify step and hold a
   fingertip on the picture; the marker should sit under it. Recalibrate if it is off by more than the
   width of a finger.
4. **Music**: the show starts the bridge and opens the controls page in Living mode; the Live set and its devices are in [LIVING-MUSIC.md](LIVING-MUSIC.md).
   The controls page also relays Live's beat to the simulation page, so the idle glimmer and Lantern's
   swimming follow the music; without it they breathe on their own.

## Tracking noise, by design

- **Skeleton for control, scan for looks.** The music signals come from the tracked skeleton (palm,
  fingertips); the fused depth scan is used only for visual contact; when the tracker loses the hand the
  bridge's depth blob keeps presence alive.
- **Teleport guard.** A hand that reappears under the same id after a gap, far from where it was, restarts
  there with zero velocity for 150 ms, so a tracking glitch never reads as a splash and never scares the
  creatures (tracker settings `teleportDistance`, `teleportGapMs`, `teleportSettleMs`).
- **Bands, not planes.** Touching the picture ramps over about ±2 cm around it; glows are wider than the
  calibration error; creatures gather around the hand, not a point.
- **Slow sound.** The governor follows the simulation's slow state, so a dropout or a jittery frame never
  changes the music audibly; withdrawal releases the vocal over about 2.5 s.

## For developers

- Shared code: `src/sim/sims/living/` (signal contract, picture geometry, mood, ghost framing GLSL).
- `SimulationDefinition.hologramFrame: 'wall'` selects `HOLOGRAM_WALL_MAPPING` for a hologram-calibrated
  source. `SimContext.activeArea` carries the calibrated active area; `SimInput.music` carries Live's
  transport (song position in beats, estimated tempo) relayed as the inbound telemetry message
  `{type: 'music', beat, playing, bpm?, levels?}`; with `levels` (Live's output meters) it also carries
  smoothed `dynamics` (envelope, auto-gained `energy`, rhythm `onset`; see SIMULATIONS.md).
- Rotation: `src/sim/host/rotation.ts` (pure, tested).
- Try without the box: `sim.html?source=pointer&sim=lantern` — hover is in front of the picture, press
  pushes through it.
