# Installation simulations

`sim.html` is the development studio for full-screen physics simulations driven
by a hand (or anything else) inside a physical bounding box watched by a depth
camera. The mixer mounts the same simulation player and maps its published
signals into live music. Tune a **performance patch** in the studio's overlay,
then choose **Play in mixer**. See [architecture and the patch workflow](ARCHITECTURE.md).

```
depth camera ──► bridge process ──WebSocket──► browser: source ─► mapping ─► tracker ─► gestures
                                                                                   │
                     mixer ◄──signal mappings ◄── rendered output ◄── host ◄────┘─► simulation ─► canvas
```

Simulation implementations in `src/sim/` remain independent of the stem mixer.
`src/integration/` connects the shared player's output to the audio graph.
Diagnostic telemetry remains available to other consumers; in-process mixer
control has its own output snapshot and is independent of telemetry rate.

## Running

```sh
npm run dev            # then open http://127.0.0.1:4178/sim.html
PORT=4190 npm run dev  # a second checkout beside a running server
```

Keys: **H** overlay · **F** fullscreen · **C** capture the next calibration corner · **1–9** switch simulation.

URL parameters fix a configuration for an installation launch:

| Parameter | Meaning |
|---|---|
| `sim=basin` | Simulation id (see the registry). |
| `source=pointer\|synthetic\|webcam\|leap\|depth` | Input source. `replay` is chosen from the overlay with a file. |
| `bridge=ws://127.0.0.1:8765` | Depth bridge URL. |
| `leap=ws://127.0.0.1:6437/v6.json` | Leap Motion service URL. |
| `ws=ws://127.0.0.1:9000` | Telemetry WebSocket the page connects out to (the audio process listens). |
| `overlay=0` | Start with the overlay hidden. |
| `quality=low\|medium\|high` · `dpr=1` · `rate=30` | GPU budget, pixel-ratio cap, telemetry rate. |
| `depth=1` | Volume depth in units of the canvas height. |
| `solid=both\|scan\|skeleton` | Which solid the simulation is handed when the source knows both the depth scan and the hand skeleton (see "Solid hands from a skeleton"). |

Settings persist in `localStorage` under `livemixer-sim-settings`; URL parameters override and are then persisted.

## Coordinate spaces

Three frames exist and only one of them is ever seen by a simulation.

1. **Source frame.** Each input source reports positions normalized to `[0, 1]` on every axis in whatever orientation is natural for it: image right/down for cameras, the bridge's bounding box for depth, a millimetre box for the Leap. Nothing else about the source leaks through.
2. **Sim space, a volume.** `x` left→right as the viewer sees the display, `y` bottom→top, `z` depth into the scene: 0 at the glass (nearest the viewer), 1 at the back wall. Hands are 3D objects in it, with 3D position, velocity and extent.
3. **Physical space.** Metres in front of the camera (or millimetres above the Leap). The source owns the conversion into its frame; the mapping and calibration turn that into the volume.

### The volume and the window camera

In uniform units (canvas height = 1) the volume is `[0, aspect] × [0, 1] × [0, depth]`; `toUniform3(p, aspect, depth)` / `toWorld` convert sim space into it, and `depth` is a host setting (overlay → Diagnostics → *Volume depth*, or `?depth=1.5`), passed to every simulation as `ctx.depth` and `frame.depth`.

The display is the front face of the volume: a window. `windowCamera(aspect, depth, eye)` in `src/sim/core/camera.ts` is the shared perspective camera: it sits `eye` units in front of the glass, centred, looking in, and its frustum passes exactly through the front face. So a point at z = 0 lands where a 2D drawing would, and a point deeper in shrinks toward the centre by `eye / (eye + z)`. It gives a `matrix` for shaders, `project(p)` for CPU-side placement of billboards and lines, and `scale(z)` for sprite sizes. Its optional `eyeY` raises the eye (the front face stays fixed; deeper points slide toward the eye's height), which lets a horizontal plane such as a floor or a sheet of light be seen from slightly above instead of edge-on. `mat4Perspective` / `mat4LookAt` are there for simulations that want a different viewpoint entirely (a bowl on a table is naturally seen from above: the plane is then x and z, and the hand's height y decides whether it touches the water).

The orientation follows the reach: with the Leap between performer and display, moving the hand toward the display moves it deeper into the picture, so the volume behaves like a space behind the glass. Any axis can be mirrored in the overlay's mapping section if an installation wants the opposite reading. A hand's `radius` is in sim x units; `uniformRadius(radius, aspect)` converts it; `push` is still available as a fast-filtered depth for tap-like responses.

`SpaceMapping` (`src/sim/input/mapping.ts`) converts source → sim: per sim axis, which source axis feeds it, which source interval maps onto `[0, 1]`, and a mirror flag. Sources ship with sensible defaults (cameras mirror x so a person facing the display sees their hand move the right way). **Calibration** refines the interval: hold the hand at the bottom-left and top-right corners of the intended play area (and optionally at the withdrawn/pushed depth extremes) and capture each; the mapping then sends those points to the sim corners. Mappings are saved per source.

### The scan: a depth camera's foreground as a surface

With a real depth camera the natural 3D representation is the scan itself: take the depth map, keep only what lies inside the box's depth range (the background falls away), and treat the result as a surface in the volume. The bridge sends it as `surface` (a small depth image of the box: 0 where nothing was seen, otherwise the nearest foreground depth per cell); the tracker maps it through the same calibration as everything else into `SimInput.surface`, a `SurfaceField`: for each cell of the front face, the sim depth z of the scanned front and a mask. It is a shell, not a closed volume, because a camera only sees the front of a hand; simulations treat "at that (x, y), deeper than the scan up to a thickness" as solid, which is all a hand needs to press, occlude, stir and paint.

`src/sim/gl/surface.ts` has the tools: `SurfaceTexture` uploads the field for shaders, `surfaceGlsl` provides `surfaceDepth`/`surfaceMask`/`surfaceNormal` and `surfaceHit` (a ray-march through the shell with the window camera) for rendering and occlusion, and `sampleSurface`, `surfaceDepthAt`, `surfaceNormalAt`, `surfaceContains` do the same on the CPU for cloth, particles and fluids. The synthetic performer emits a scan of its own skeleton, so the scan path runs in tests and screenshots without hardware. The overlay's minimap draws the scan (nearer = brighter) and its top view shows the nearest depth per column.

A scan needs a depth camera. The Leap Motion Controller is a stereo infrared pair with no depth output, and its service does not expose the raw images to the browser; the bridge's `--source leap` computes a scan from the raw stereo pair itself, see "Leap Motion Controller" below.

### Solid hands from a skeleton

When a source knows the skeleton, a hand is still not only a point. Two sources do: the Leap service's JSON API (`leap`) and the depth bridge running `--source leap` (`depth`), which sends the LeapC skeleton alongside its scan. Both reduce their wire format to the one `Skeleton` in `src/sim/input/skeleton.ts` (palm, wrist, a forearm stub, five fingers of five joints with a width each, thumb first) and `skeletonCapsules` turns it into `capsules`: three phalanx capsules per finger, the five metacarpals that make the palm (radius = half the finger width × 1.15, 1, 0.9, 0.8 from the wrist out), and a forearm capsule cut off 70 mm past the wrist at 0.85 × the arm width; zero-length bones (the Leap's thumb metacarpal) are skipped. The tracker forwards them on every `HandState` as `hand.capsules`, riding on the smoothed position so they never jitter against it, and the mapping never clamps them (a forearm leaving the box keeps its direction instead of being crushed against the wall). Sources that only know a position leave `capsules` empty and simulations fall back to a sphere of `radius` at `position`.

**Scan and skeleton together.** With the bridge's Leap source both arrive on every frame, projected into the same box so they coincide: the scan is what the hand *is* (its real silhouette and front surface, background removed) and the skeleton is what the hand is *doing* (fingertips, openness, pinch, a solid where the camera cannot see, e.g. the back of a fist). Simulations use them accordingly: the scan for contact, occlusion and stirring when present, the skeleton for gestures, fingertip effects and as the solid when there is no scan. The host setting `solid` (overlay → Diagnostics → *Solid*, or `?solid=`) chooses what the simulation is handed: `both` (default), `scan` (capsules stripped from the hands, so a simulation behaves exactly as with a plain depth camera), or `skeleton` (`surface` and `volume` withheld, so the capsule hand does the colliding: useful when the stereo depth is noisy or to compare the two). It only changes what the simulation sees; the tracker, the overlay's minimap and telemetry always carry everything.

On the GPU, `packHands` (`src/sim/gl/hand.ts`) turns the hands into world-unit capsule uniforms with one bounding sphere per hand, and `handSdfGlsl` provides `handDistance(p)` (a signed distance field) and `handBoundsHit(ro, rd)` for an early-out, so a shader can ray-march, shadow, or occlude against the solid hand at a cost proportional to the hand, not the screen. `capsuleDistance` does the same on the CPU for cloth and particles. The Presence template shows the pattern: it ray-marches a translucent ghost of the hand and shades the floor grid beneath it.

Depth cameras can also send the foreground as a voxel grid, which the tracker maps into sim space as `input.volume` (`VolumeField`, x fastest, then y, then z from the glass), for simulations that want occupancy rather than a shell. Simulations prefer the scan (`surface`) when present, then capsules, then the sphere.

Keep the physical box proportional to the volume so a solid hand keeps its shape: the Leap default box is 600 × 340 × 240 mm (≈ 1.76 : 1 : 0.7), which matches a 16:9 display with *Volume depth* 0.7. Telemetry hands carry `solid`, the number of capsules.

## Input pipeline

`InputFrame` → `HandTracker` → `HandState[]` → `detectGestures` → `SimInput`.

- **Sources** (`src/sim/input/*.ts`) implement `InputSource`: `pointer` (mouse/touch; press = push, wheel = depth, Shift = closed hand), `synthetic` (deterministic scripted performer with an occupancy blob), `webcam` (MediaPipe landmarks through the existing local worker; depth from apparent hand size), `leap` (Leap Motion Controller through the local service's WebSocket API; see below), `depth` (bridge WebSocket client), `replay` (JSONL recorded from any source).
- **Tracker** (`conditioning.ts`): presence hysteresis (`enterMs` before a hand exists, `leaveMs` grace after the last observation), One-Euro filtering of position, EMA velocity, a faster-filtered `push` for tap-like responses, smoothed `presence` and `activity`, occupancy resampled into sim orientation. Deterministic: all time arrives through arguments.
- **Gestures** (`gestures.ts`): `enter`, `leave`, `swipe` (once per fast segment, with direction), `push` (fast z rise), `hold` (still for ~1 s, once), `grab`/`release` (openness hysteresis; only landmark sources supply openness).

`SimInput` also carries `occupancy`, a 64×48 field (row 0 = bottom) of how much of each cell the tracked matter fills. Simulations that want the whole silhouette rather than a point (a curtain, water) upload it as a texture.

## Leap Motion Controller

A Leap Motion Controller (LM-010) is a pair of infrared cameras with a hand-fitting tracker, not a depth camera. What it can give the browser directly is the tracked skeleton (palm, five fingers with four joints and widths each, wrist, forearm) at over 100 Hz, which the `leap` source turns into a solid capsule hand. The raw stereo images never cross the WebSocket (both protocol versions were probed: tracking JSON only, never a binary frame); they reach native clients through `LeapC.dll`, which exposes the two IR images with their calibration. `bridge/leap_source.py` uses that to compute a depth map by stereo matching and feed the same scan pipeline as a depth camera (see `bridge/README.md`).

What was established on the machine this was built on ("Leap Motion Service 5.0.0-preview"): the LeapC build that ships with it connects, reports the device (40 mm baseline, 132° × 115° field of view, 470 mm range) and grants the image policy, but never delivers a tracking or image event to any client written against it (Python, .NET, with or without an allocator, focus, or the tool sandbox), so the live acquisition could not be verified there. Current Ultraleap tracking software (Hyperion v6.2.0 for Windows, offered on Ultraleap's download page for the original controller, <https://www.ultraleap.com/downloads/leap-controller/>) supports this controller and ships a working LeapC in its *Software Development Kit* component; the bridge targets that layout too and detects which one it is talking to. Those releases dropped the JSON WebSocket API, so after upgrading the browser's `leap` source stops working and the bridge is the way in.

### After the Hyperion upgrade: the bridge delivers tracking and depth together

```sh
python bridge/depth_bridge.py --source leap          # then open sim.html?source=depth
```

With Hyperion (or any Gemini from 5.2 on) the way in is `bridge/depth_bridge.py --source leap` and the browser's `depth` source. The bridge takes both things LeapC offers: the stereo pair, turned into a depth scan (`surface`, voxels, occupancy, blobs, exactly like a depth camera), and the tracked skeleton, which it attaches to each tracked hand as `skeleton` (see "Depth bridge protocol") after projecting it into the same normalized box as the scan, so the two coincide in the volume. The browser builds the capsule hand from it with the same rules as the `leap` source, derives `points` (palm and fingertips) when the bridge sends none, and keeps `openness`/`pinch` so the `grab`/`release` gestures work. When tracking is lost the bridge falls back to a blob hand without a skeleton and the scan carries on, so a hand never vanishes just because the fitter gave up. The overlay's depth-source section shows whether the connected bridge announced skeletons (`hello.skeleton`) and how many tracked hands are solid, and the *Solid* setting (Diagnostics; `?solid=`) picks scan, skeleton or both for the simulation.

**Camera on the desk looking up.** The natural installation puts the controller flat between the performer and the display with the hand above it. Run the bridge with `--frame upright`: it converts every depth pixel and skeleton joint to millimetres with the camera's intrinsics (so lifting the hand no longer slides it toward the centre, as image-normalized coordinates would through the frustum), places them in a metric box (`--box-mm W D` across and toward the display, `--near/--far` as the height range) and emits them already oriented for the volume: height above the device becomes sim y, reaching across the device toward the display becomes sim z, the device's long axis sim x. The scan is rendered as the front-view height field the simulations expect, from the measured underside extruded by the hand's thickness (`--slab-mm`) and the tracked skeleton's capsules seen from the front. The browser needs nothing special: the default depth mapping applies; use the Mapping section's mirror toggles if left/right or reach come out inverted (or `--reach-sign -1` on the bridge), and size the box to the volume: W = aspect × (far − near), D = volume depth × (far − near).

### The `leap` source (older services with the WebSocket API)

The browser connects straight to the Leap Motion / Ultraleap service's JSON WebSocket API at `ws://127.0.0.1:6437/v6.json`.

1. Install the tracking software that supports the LM-010 (V2, Orion 4, or the Gemini 5.0 preview all expose the WebSocket API; Gemini 5.2+ and Hyperion removed it, in which case use the bridge as above).
2. In the Leap Motion control panel (tray icon → Settings → General) enable **Allow Web Apps**. The service then listens on port 6437. The same switch is `websockets_enabled` in the service's `config.json`; keep `websockets_allow_remote` off.
3. Place the device on the desk between the performer and the display with its green light facing the performer: device x is then the performer's right, y is up, z is toward the performer.
4. Open `sim.html?source=leap` (or pick *Leap Motion* in the overlay). The source frame is a box in millimetres from the device centre, default x −160…160, y 100…450, z −120…120; the overlay's status line shows the raw palm position so the box can be set to the intended reach, then two-corner calibration fine-tunes it. `LEAP_MAPPING` turns "toward the display" into a push. `?leap=ws://…` overrides the URL.

Leap hands carry `openness` (1 − grab strength) and `pinch`, so the `grab`/`release` gestures work, and `points` holds the five fingertips plus the palm. The service's per-hand `confidence` rates the pose fit, not detection (the 5.0 preview reports values around 0.01–0.1 for a well-tracked hand), so the source floors it at 0.5 before the tracker's acceptance threshold; the raw value is shown in the status line as `leapConfidence`.

## Writing a simulation

Copy `src/sim/sims/template/` (the *Presence* simulation), rename the id, and register it in `src/sim/host/registry.ts`. That is the whole procedure; the overlay, telemetry schema, URL selection and browser test pick it up.

```ts
export default defineSimulation({
  id: 'ripples', title: 'Ripples', description: '…',
  params:  { strength: { kind: 'number', default: .5, min: 0, max: 1, step: .01, description: '…' } },
  signals: { energy: { min: 0, max: 1, description: 'Total wave energy, normalised.' } },
  stepHz: 60,                       // optional
  create(ctx, params) {             // ctx: gl, canvas, width, height, aspect, dpr, quality, capabilities, warn(); params: initial values
    return {
      step(input, params) {},       // fixed step; input.hands / primary / events / presence / activity / occupancy
      render(frame, params) {},     // once per display frame; draw to the default framebuffer
      signals() { return { energy: 0 }; },
      resize(w, h) {},              // optional
      paramChanged(name, value) {}, // optional; for expensive re-initialisation only
      dispose() {},
    };
  },
});
```

Rules that keep the scaffold trustworthy:

- **Declare everything.** Every knob is a `param` with a range; every output is a `signal` with a range. The host clamps signals and flags violations in the overlay and tests. Ranges are the contract the audio side maps against.
- **Physics in `step`, drawing in `render`.** `step` may run 0–4 times per frame; keep it deterministic given its inputs (use `rng(seed)` from `core/math.ts`, never `Math.random`, for anything that should replay).
- **Respect presence.** Hands can flicker; the tracker already holds them briefly. Read `input.presence` for slow moods and `input.hands` for contact. Fade things out; never snap.
- **Think in the volume.** Convert hands with `toWorld` and place things with the window camera (or your own camera); use z as a real spatial coordinate (a curtain hangs at a plane, water has a surface height, light sits at a depth), not as a button.
- **Budget for a 2020 Intel MacBook** (integrated GPU, Safari or Chrome). Prefer RGBA16F targets (`pickFormat`), 256²–512² fluid grids, a few thousand cloth points at most, one or two full-screen passes at native resolution. Use `ctx.quality` to scale resolution. Keep `step` under ~2 ms and `render` under ~6 ms.
- **Signals must be cheap** and numerically stable. GPU readbacks go through a small probe target (e.g. 16×16) read at most once per frame.
- **Handle context loss** by holding no state outside the instance; the host disposes and recreates on restore.
- **Own your GL state.** The host resets nothing between passes or simulations: set blend/viewport at the start of `render`, and leave blending and depth testing disabled when you return. `SimContext.width/height/aspect` are kept current by the host; `RenderFrame` carries the same numbers.
- **Hot loops:** avoid `Math.hypot` and per-call closures (both are an order of magnitude slower in V8); the `core/math.ts` and `core/noise.ts` helpers are already written that way.

GL helpers live in `src/sim/gl/`: `Program` (compile with readable errors, cached uniforms), `Fbo`/`PingPong` (`pickFormat` chooses the best renderable float format), `drawQuad`/`quadProgram`/`blit` for full-screen passes, `GLSL_HEADER` for `#version 300 es`.

## The simulations

All coordinates below are uniform units (canvas height = 1). Every parameter and signal is declared in the simulation's `index.ts` with ranges and descriptions; the overlay and the telemetry schema show them live. Signal ranges are the contract the audio side maps against.

### Afterglow (`trails`)
Pure black. Whatever is present paints light where it moves through the volume; with nobody there the picture returns to true black. Three fidelities, best available first: with a depth-camera scan, every scanned cell that newly appears or moves in depth stamps light at its 3D position, so a moving hand leaves a trail shaped like its silhouette and a still hand leaves nothing (a noise floor ignores sensor jitter); with a skeleton, every capsule sweeps its own stroke, so spread fingers paint five thin lines and a palm a broad soft one, with the total light normalised so a full hand is not many times brighter than a point; with only a position, a single brush. Strokes are 3D: endpoints are projected through the window camera into a GPU accumulation buffer (RGBA16F, half size on `low`) as instanced additive quads with frame-rate-independent decay; the brush radius follows the perspective scale and the deposit dims and cools with depth, so a stroke pushed toward the back wall recedes. Sparkles are shed preferentially from fingertips or silhouette edges and carry depth; a foreshortened pool of light on the floor beneath a fresh stroke gives the depth cue; a faint rim-lit ghost of the body that is painting (`ghost`) shows the performer what is drawing; quarter-res bloom, ACES tone-map, grain. Params: `lifetime`, `brushSize`, `brightness`, `hue`, `hueDrift` (bounded Perlin wander), `saturation`, `sparkle`, `drift`, `bloom`, `grain`, `depthFade`, `floor`, `ghost`. Signals: `glow` (mean luminance from a 16×16 probe), `ink` (stroke energy being laid down now), `hue`, `coverage` (lit fraction), `sparkles` (alive fraction), `depth` (energy-weighted mean depth of recent ink). Cost: two full-res passes plus instanced strokes and small passes, ≈3 ms GPU estimated at 1440×900.

### Veil (`veil`)
A sheer curtain hanging inside the volume at a plane `plane · depth` from the glass, breathing in a breeze from a dim window on the back wall. CPU position-based dynamics (40×60 / 52×78 / 56×84 points by quality, 2 substeps) with structural, shear and bend constraints, gathered folds, a curl-noise wind lattice with gusts. Contact is geometric against whatever solid is known: with a depth-camera scan, the scanned front becomes a shell 0.08 deep that the fabric cannot enter (points inside leave by the nearer face, tilted by the local slope), so a real hand pushes the sheet ahead of it and the sheet can rest on its back; with a skeleton, every capsule collides on its own, so single fingers poke narrow pockets, a flat palm a wide one, a fist a small one, with friction and drag per capsule; with only a position, a sphere. In front of the plane a solid does not touch the sheet, at the plane it presses into it, deeper than the plane it pulls the fabric through and shows as a soft silhouette against the window (fingers appear before the palm), and it casts a shadow onto the fabric from the off-axis window. The rod is sized so the sheet fills the view at its depth; the room (floor at y = 0, back wall with the window) is ray-cast in the background pass. Rendered with the shared window camera as an indexed mesh with premultiplied blending: coverage rises where folds are seen edge-on, warm transmission from the backlight, fine weave faded by `fwidth`, a post pass for exposure and dither. Params: `wind`, `gustiness`, `stiffness`, `damping`, `drape`, `opacity`, `backlight`, `tint`, `plane`, `weave`. Signals: `sway`, `flutter`, `contact` (share of fabric within a hand's reach), `depth` (mean sheet displacement along z: −1 toward the viewer … +1 deeper), `gust`, `tension`. Cost: ≈1.3 ms per step at `medium` and ≈1.5 ms at `high` on the development machine (roughly double on the 2020 MacBook); `medium` is the safe installation setting.

### Basin (`basin`)
A bowl of dark water on the floor of the volume, seen from above: the screen is the horizontal plane (x across, depth upward, the glass edge at the bottom), and height decides what is in the water. Stam stable fluids on a 160²/256²/320² grid (dye at twice that) in an analytic circular bowl with no-slip walls: advection, forces from whatever is submerged, vorticity confinement, Jacobi pressure (16/24/32 iterations), dye advection with dissipation, a faint drift so ink keeps moving when nobody is there. The solid decides the stirring: with a depth-camera scan, the scanned cells below the water level form the wet footprint and drag the water with the scan's motion; with a skeleton, each capsule crossing the surface contributes its own stadium-shaped footprint (five dipped fingertips make five small stirs, a flat palm one broad push, a fist one round one, with finger motion adding to the palm's), and immersion is the submerged share of the hand's length; with only a position, a disc. A hand above the surface casts a height-coded shadow shaped like the solid (large and soft when high, small and crisp when low) and a lit waterline ring around every part that crosses the surface; a fast downward crossing plunges a bead of ink with a radial impulse, a slow dip drops a gentle bead (`dropOnEnter`). One composite pass: water floor with caustics, ink with subsurface softness, a window reflection and glints, meniscus ring at the waterline, rim, table outside. Params: `viscosity`, `vorticity`, `stir`, `ink`, `palette` (indigo, ember, lagoon, sumi, orchid), `fade`, `bowl`, `surface` (water level as sim y), `dropOnEnter`, `light`, `caustics`. Signals from a 16×16 probe read back asynchronously: `energy`, `swirl`, `rotation` (−1 clockwise … +1 counter-clockwise), `ink`, `calm`, plus `immersion` (how much of the primary hand is under the surface). Cost: ≈30 small grid passes plus one full-screen composite per frame at `medium`.

### Prism (`prism`)
White light and glass. A vertical glass prism stands in the middle of the volume; light travels in a horizontal plane at the hand's height, from the hand's position in that plane toward the prism, so walking around the prism (including pushing in behind it) changes the incidence angle and the spectrum fans out, folds and reflects internally; raising or lowering the hand raises the sheet of light, above the glass it passes over; an open hand gives a wide beam, a fist a narrow one; with nobody there a faint idle beam orbits at mid height. Bodies in the volume occlude the light: the scan's cells at the plane's height (or, without a scan, the exact slices of the skeleton's capsules) stop rays, which splash warmly on the skin, so a second hand held into the fan throws a shadow through the spectrum and fingers slice it; the beam's own hand is the emitter and clears its palm before the first segment. The solids themselves are drawn as dim rim-lit ghosts at their real heights. CPU ray tracer (`optics.ts`, unchanged 2D maths in the x/z plane): Cauchy dispersion, Snell, unpolarised Fresnel splitting with a depth-first stack, total internal reflection, 12/16/24 wavelengths per ray from an interleaved spectrum table, capped at 40 000 segments with an adaptive ray budget that thins the beam uniformly. Rays end on the volume's walls and leave a soft splash of colour there; the beam's footprint glows faintly on the floor. Rendering: the segments are 3D world points projected in the vertex shader with a window camera whose eye is raised (`eyeY` 1.1) so the horizontal light plane is seen from slightly above rather than edge-on; anti-aliased additive line quads into RGBA16F, two glow blurs, the prism as nine projected edges plus faint faces and a silhouette lit by the glow crossing it, a thin floor grid fading with depth and presence, filmic composite. Params: `size`, `height`, `spin`, `glass`, `dispersion`, `beam`, `rays`, `bounces`, `glow`, `floor`, `idle`, `twin`. Signals: `spread`, `hue`, `brightness`, `reflected`, `incidence`, `inside`, `elevation` (height of the light plane), `occluded` (share of beam energy stopped by bodies). Cost: trace ≈1.3–2.3 ms at `medium` with two hands and a scan, once per rendered frame.

### Presence (`presence`)
The reference simulation: a soft light gathers around a hand and travels with it through the volume (nearer the glass it is large and warm, deeper it is smaller, dimmer and cooler) over a faint perspective floor grid. Copy it to start something new.

## Telemetry (external consumers and diagnostics)

`TelemetryBus` publishes two message kinds (`src/sim/telemetry/types.ts`):

- `schema` on connect and whenever the simulation changes: the active simulation's `params` and `signals` specs (names, ranges, units, descriptions), the list of simulations, the hand fields and gesture names.
- `frame` at `rate` Hz (default 30): `sim.params`, `sim.signals`, `input.presence`, `input.activity`, `input.hands[]` (position, velocity, speed, radius, openness, pinch, push, age), `input.events[]` since the last frame, `input.stats` from the source (bridge fps, pixel counts…), `perf`. Occupancy can be included (base64, row 0 = bottom) with the overlay toggle.

Inbound: `set-param`, `set-params`, `select-sim`, `get-schema`, `ping`. Transports: `BroadcastChannel('livemixer-sim')` (a second tab), WebSocket (the page connects to a server the audio process runs; reconnects forever), and `window.postMessage` when embedded. `window.livemixerSim.host.bus.subscribe(fn)` works from devtools.

Two ready-made diagnostic consumers are available:

- **`telemetry.html`** (same origin, second tab): live signal bars, a smoothed copy of each signal as a mapper might keep it, hands, events, editable parameters that are sent back with `set-param`, and simulation switching. Source: `src/sim/monitor.ts`, deliberately dependency-free.
- **`npm run telemetry:sink [port]`** (`scripts/telemetry-sink.ts`): a WebSocket server with no dependencies that prints the schema and a line per second of signals. Launch it, then open `sim.html?ws=ws://127.0.0.1:9000`. Any WebSocket library in any language works the same way; the page connects out and sends JSON text frames.

The smallest possible consumer in another tab:

```js
const channel = new BroadcastChannel('livemixer-sim');
channel.onmessage = ({ data }) => { if (data.message.type === 'frame') console.log(data.message.sim.signals); };
channel.postMessage({ direction: 'inbound', message: { type: 'get-schema' } });
```

## Depth bridge protocol

Defined once in `src/sim/input/protocol.ts` (zod) and implemented by `bridge/depth_bridge.py`. The bridge is a WebSocket server; on connect it sends `hello` (source name, physical box in metres, fps, occupancy/voxel/surface grid sizes, `skeleton: true` when it tracks hands, and `frame: "upright"` when a camera lying on the desk looking up has been re-oriented by the bridge so that v is 1 − height and w is reach toward the display, see below), then `frame` messages: `seq`, `t` (bridge monotonic seconds; the client estimates the clock offset with a sliding minimum), `hands[]` with `pos [u, v, w]` (u right, v down, w deeper), `conf`, `extent`, optional `openness`/`pinch`/`points`, plus optional base64 `occupancy` (row 0 = top of the image), `voxels`, `surface` (the scan) and `stats`. See `bridge/README.md`.

A hand may carry a `skeleton` (bridges that fit a hand model, i.e. `--source leap`; blob hands omit it). It uses the same normalization as `pos`, joints are sent unclamped (they may overshoot `[0, 1]` slightly, and the browser never clamps them either), and widths are DIAMETERS as fractions of the box width at that depth:

```json
{"type": "right", "palm": [u, v, w], "wrist": [u, v, w], "elbow": [u, v, w], "palmWidth": 0.14, "armWidth": 0.09,
 "fingers": [{"joints": [[carp], [mcp], [pip], [dip], [tip]], "width": 0.03, "extended": true}, "… exactly 5, thumb → pinky"]}
```

`elbow` (already trimmed by the bridge to ≈70 mm from the wrist), `palmWidth` and `armWidth` are optional; `type` is `left`, `right` or `unknown`. The schemas stay `.strict()` and the protocol version stays 1: the field is optional, so older bridges validate unchanged. `bridgeFrameToInput` turns the skeleton into `capsules` with `skeletonCapsules` and, when the bridge sends no `points`, derives them (palm, then the five tips) with `skeletonPoints`.

## Operating the installation

1. Start the bridge next to the camera: `python bridge/depth_bridge.py --source realsense --near 0.4 --far 1.2 --roi 0.2 0.1 0.8 0.9` (see `bridge/README.md`; `--source synthetic` needs no hardware).
2. Start the audio side's WebSocket receiver, or `npm run telemetry:sink 9000` to check the stream.
3. Open `sim.html?source=depth&bridge=ws://127.0.0.1:8765&ws=ws://127.0.0.1:9000&sim=basin&quality=medium&dpr=1`.
4. In the overlay's *Mapping & calibration*, hold a hand at the bottom-left and top-right of the play area, capture each (or press **C** twice), then apply. Optionally capture withdrawn/pushed depth extremes. The mapping is remembered per source.
5. Tune parameters in the overlay (they persist), press **F** for fullscreen and **H** to hide the overlay. The cursor hides after 3 s.
6. Recordings: *Record input* captures the raw source frames to JSONL; *Replay recording…* plays them back through the same pipeline, so mappings and simulations can be tuned without a performer.

## Known gaps

- No depth camera has been connected yet: the bridge's RealSense path follows the `pyrealsense2` API but is untested on hardware; the synthetic source exercises the whole pipeline end to end.
- The target machine (2020 Intel MacBook) has not been measured; budgets in this document are design targets. Use the overlay's fps/step/draw readout and lower `quality`/`dpr` if needed.
- Occupancy is used by the tracker and telemetry, but simulations currently react to hand points and radii, not the full silhouette. `SimInput.occupancy` is ready for a simulation that wants it.
- One depth axis is exposed (`push`); orientation-style gestures (tilt) from the mixer's camera adapter are not part of this pipeline by design.

## Tests

- `npm test` — pure logic: stepper, params, mapping and calibration, tracker, gestures, protocol, recorder/replay, telemetry bus, settings, registry validation, plus each simulation's CPU-side maths.
- `npm run test:browser` (`tests/sim.spec.ts`) — every registered simulation renders with the synthetic performer in headless Chromium without warnings or signal-range violations, and again with `?forceRgba8=1` (the float render-target extensions left unrequested, so every 8-bit fallback shader actually compiles and runs); telemetry frames and schema flow; the monitor tab receives the stream; inbound commands work; the pointer source maps correctly; a fake Leap service and a fake depth bridge (skeletons plus a scan, then `?solid=skeleton`) drive the `leap` and `depth` sources end to end. Headless rendering uses SwiftShader, so it proves correctness, not frame rate.
- `npx tsx scripts/sim-screenshots.ts` — one screenshot per simulation into `shots/` for a quick look without a camera.
