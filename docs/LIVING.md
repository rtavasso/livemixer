# Living installation

Three creatures for the Pepper's-ghost box, and a governor that lets the visitor reshape the song
without making it unpleasant for the room. Design: [the spec](superpowers/specs/2026-09-27-living-installation-design.md).
Music side: [LIVING-MUSIC.md](LIVING-MUSIC.md).

| Simulation | What the visitor meets |
|---|---|
| **Tide** (`tide`) | An upright sheet of dark water that glows like plankton where it is disturbed, home to a school of luminous eels. A still hand draws them in; a splash scatters them. |
| **Lantern** (`lantern`) | One translucent jellyfish that swims in time with the music, comes to a still hand and drapes its tentacles over it; a poke makes it flinch, fast motion sends it away. |
| **Murmuration** (`murmuration`) | Thousands of motes of light flocking in folding ribbons; a gentle hand gathers an orbiting halo, stillness tightens it into a ring, fast motion tears it apart. |

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

## Run the show

1. **Leap bridge** (box empty for its first seconds so the background, including the beamsplitter's
   reflection, is learned): `sh bridge/run-leap.sh`. The box is 20-55 cm above the controller; the
   picture spans about 25-46 cm.
   It restarts the Ultraleap service by itself when the controller stops streaming (a known Hyperion
   6.2 stall). On a new machine, allow that once with `sudo sh bridge/install-leap-restart.sh`; see
   *Keeping it running* in [the bridge README](../bridge/README.md).
2. **Vite**: `npm run dev`.
3. **Simulation page**: `http://127.0.0.1:4178/sim.html?source=depth&sim=tide&overlay=0`, fullscreen with **F**.
   - One creature all night: pick `sim=tide`, `lantern` or `murmuration`.
   - Rotate on a timer: add `&rotate=20` (minutes) and optionally `&rotation=tide,lantern,murmuration`.
     A change waits until the box has been empty for four seconds, then fades through black; a hand
     arriving mid-fade cancels it.
4. **Hologram calibration** (once per setup, and whenever the box has been moved): press **X** (or **H** → *Calibrate hologram…*), size the active area to the visible picture, then touch the nine X's and do the
   pull-back capture. Living simulations read the calibration through the upright *wall* frame (the
   picture plane at sim depth 0.5), so pushing a hand *through* the picture is kept as `reach`; Basin and
   Shallows keep the top-down *floor* frame. Switching simulations switches the frame automatically.
5. **Attendant check** at the start of each session: open the calibration's verify step and hold a
   fingertip on the picture; the marker should sit under it. Recalibrate if it is off by more than the
   width of a finger.
6. **Music**: see [LIVING-MUSIC.md](LIVING-MUSIC.md) (bridge, controls page in Living mode, Live set).
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
  `{type: 'music', beat, playing, bpm?}`.
- Rotation: `src/sim/host/rotation.ts` (pure, tested).
- Try without the box: `sim.html?source=pointer&sim=lantern` — hover is in front of the picture, press
  pushes through it.
