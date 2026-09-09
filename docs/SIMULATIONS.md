# Installation simulations

`sim.html` is a second application in this repository: a full-screen physics
simulation driven by a hand (or anything else) inside a physical bounding box
watched by a depth camera. The simulation publishes its state so a separate
audio project can turn it into a live mix.

```
depth camera ──► bridge process ──WebSocket──► browser: source ─► mapping ─► tracker ─► gestures
                                                                                   │
                     audio project ◄──telemetry (signals, params, hands)◄── host ◄─┘─► simulation ─► canvas
```

Everything in `src/sim/` is independent from the stem mixer in `src/`. The two
share tooling only.

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

## Input pipeline

`InputFrame` → `HandTracker` → `HandState[]` → `detectGestures` → `SimInput`.

- **Sources** (`src/sim/input/*.ts`) implement `InputSource`: `pointer` (mouse/touch; press = push, wheel = depth, Shift = closed hand), `synthetic` (deterministic scripted performer with an occupancy blob), `webcam` (MediaPipe landmarks through the existing local worker; depth from apparent hand size), `leap` (Leap Motion Controller through the local service's WebSocket API; see below), `depth` (bridge WebSocket client), `replay` (JSONL recorded from any source).
- **Tracker** (`conditioning.ts`): presence hysteresis (`enterMs` before a hand exists, `leaveMs` grace after the last observation), One-Euro filtering of position, EMA velocity, a faster-filtered `push` for tap-like responses, smoothed `presence` and `activity`, occupancy resampled into sim orientation. Deterministic: all time arrives through arguments.
- **Gestures** (`gestures.ts`): `enter`, `leave`, `swipe` (once per fast segment, with direction), `push` (fast z rise), `hold` (still for ~1 s, once), `grab`/`release` (openness hysteresis; only landmark sources supply openness).

`SimInput` also carries `occupancy`, a 64×48 field (row 0 = bottom) of how much of each cell the tracked matter fills. Simulations that want the whole silhouette rather than a point (a curtain, water) upload it as a texture.

## Leap Motion Controller

A Leap Motion Controller (LM-010) is the best-fitting sensor for this scaffold: it reports palm position in millimetres, five fingertips, grab and pinch strength, at over 100 Hz, and it needs no bridge process. The browser connects straight to the Leap Motion / Ultraleap service's JSON WebSocket API at `ws://127.0.0.1:6437/v6.json`.

1. Install the tracking software that supports the LM-010 (V2, Orion 4, or the Gemini 5.0 preview all expose the WebSocket API; later Gemini/Hyperion releases removed it, in which case use `bridge/` with Ultraleap's Python bindings).
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
Pure black. A present hand leaves trails of light where it moves through the volume; with nobody there the picture returns to true black. Strokes are 3D segments: both endpoints are projected through the window camera into a GPU accumulation buffer (RGBA16F, half size on `low`) with frame-rate-independent decay; the brush radius follows the perspective scale and the deposit dims and cools with depth (aerial perspective), so a stroke pushed toward the back wall visibly recedes while a near one is large and warm. Sparkles carry depth (born around the stroke, fogged and shrunk deeper in); a foreshortened pool of light on the floor beneath a fresh stroke gives the depth cue; quarter-res bloom, ACES tone-map, grain. Params: `lifetime`, `brushSize`, `brightness`, `hue`, `hueDrift` (bounded Perlin wander), `saturation`, `sparkle`, `drift`, `bloom`, `grain`, `depthFade`, `floor`. Signals: `glow` (mean luminance from a 16×16 probe), `ink` (stroke energy being laid down now), `hue`, `coverage` (lit fraction), `sparkles` (alive fraction), `depth` (energy-weighted mean depth of recent ink). Cost: two full-res passes plus small ones, ≈2.5 ms GPU estimated at 1440×900.

### Veil (`veil`)
A sheer curtain hanging inside the volume at a plane `plane · depth` from the glass, breathing in a breeze from a dim window on the back wall. CPU position-based dynamics (40×60 / 52×78 / 56×84 points by quality, 2 substeps) with structural, shear and bend constraints, gathered folds, a curl-noise wind lattice with gusts. The hand is a sphere at its 3D position with a radius from its extent, and contact is geometric: in front of the plane it does not touch the sheet, at the plane it presses a pocket into it, deeper than the plane it pulls the fabric through and shows as a soft silhouette against the window. The rod is sized so the sheet fills the view at its depth; the room (floor at y = 0, back wall with the window) is ray-cast in the background pass. Rendered with the shared window camera as an indexed mesh with premultiplied blending: coverage rises where folds are seen edge-on, warm transmission from the backlight, fine weave faded by `fwidth`, a post pass for exposure and dither. Params: `wind`, `gustiness`, `stiffness`, `damping`, `drape`, `opacity`, `backlight`, `tint`, `plane`, `weave`. Signals: `sway`, `flutter`, `contact` (share of fabric within a hand's reach), `depth` (mean sheet displacement along z: −1 toward the viewer … +1 deeper), `gust`, `tension`. Cost: ≈1.3 ms per step at `medium` and ≈1.5 ms at `high` on the development machine (roughly double on the 2020 MacBook); `medium` is the safe installation setting.

### Basin (`basin`)
A bowl of dark water on the floor of the volume, seen from above: the screen is the horizontal plane (x across, depth upward, the glass edge at the bottom), and the hand's height decides whether it is in the water. Stam stable fluids on a 160²/256²/320² grid (dye at twice that) in an analytic circular bowl with no-slip walls: advection, hand forces (water under a submerged hand relaxes toward the hand's horizontal velocity, scaled by how deep it is), vorticity confinement, Jacobi pressure (16/24/32 iterations), dye advection with dissipation, a faint drift so ink keeps moving when nobody is there. A hand above the surface casts a height-coded shadow on the water (large and soft when high, small and crisp when low); a fast downward crossing of the surface plunges a bead of ink with a radial impulse, a slow dip drops a gentle bead (`dropOnEnter`). One composite pass: water floor with caustics, ink with subsurface softness, a window reflection and glints, meniscus ring at the waterline, rim, table outside. Params: `viscosity`, `vorticity`, `stir`, `ink`, `palette` (indigo, ember, lagoon, sumi, orchid), `fade`, `bowl`, `surface` (water level as sim y), `dropOnEnter`, `light`, `caustics`. Signals from a 16×16 probe read back asynchronously: `energy`, `swirl`, `rotation` (−1 clockwise … +1 counter-clockwise), `ink`, `calm`, plus `immersion` (how much of the primary hand is under the surface). Cost: ≈30 small grid passes plus one full-screen composite per frame at `medium`.

### Prism (`prism`)
White light and glass. A vertical glass prism stands in the middle of the volume; light travels in a horizontal plane at the hand's height, from the hand's position in that plane toward the prism, so walking around the prism (including pushing in behind it) changes the incidence angle and the spectrum fans out, folds and reflects internally; raising or lowering the hand raises the sheet of light, above the glass it passes over; an open hand gives a wide beam, a fist a narrow one; with nobody there a faint idle beam orbits at mid height. CPU ray tracer (`optics.ts`, unchanged 2D maths in the x/z plane): Cauchy dispersion, Snell, unpolarised Fresnel splitting with a depth-first stack, total internal reflection, 12/16/24 wavelengths per ray from an interleaved spectrum table, capped at 40 000 segments with an adaptive ray budget that thins the beam uniformly. Rays end on the volume's walls and leave a soft splash of colour there; the beam's footprint glows faintly on the floor. Rendering: the segments are 3D world points projected in the vertex shader with a window camera whose eye is raised (`eyeY` 1.1) so the horizontal light plane is seen from slightly above rather than edge-on; anti-aliased additive line quads into RGBA16F, two glow blurs, the prism as nine projected edges plus faint faces and a silhouette lit by the glow crossing it, a thin floor grid fading with depth and presence, filmic composite. Params: `size`, `height`, `spin`, `glass`, `dispersion`, `beam`, `rays`, `bounces`, `glow`, `floor`, `idle`, `twin`. Signals: `spread`, `hue`, `brightness`, `reflected`, `incidence`, `inside`, `elevation` (height of the light plane). Cost: trace ≈1.2 ms at `medium`, once per rendered frame.

### Presence (`presence`)
The reference simulation: a soft light gathers around a hand and travels with it through the volume (nearer the glass it is large and warm, deeper it is smaller, dimmer and cooler) over a faint perspective floor grid. Copy it to start something new.

## Telemetry (to the audio project)

`TelemetryBus` publishes two message kinds (`src/sim/telemetry/types.ts`):

- `schema` on connect and whenever the simulation changes: the active simulation's `params` and `signals` specs (names, ranges, units, descriptions), the list of simulations, the hand fields and gesture names.
- `frame` at `rate` Hz (default 30): `sim.params`, `sim.signals`, `input.presence`, `input.activity`, `input.hands[]` (position, velocity, speed, radius, openness, pinch, push, age), `input.events[]` since the last frame, `input.stats` from the source (bridge fps, pixel counts…), `perf`. Occupancy can be included (base64, row 0 = bottom) with the overlay toggle.

Inbound: `set-param`, `set-params`, `select-sim`, `get-schema`, `ping`. Transports: `BroadcastChannel('livemixer-sim')` (a second tab), WebSocket (the page connects to a server the audio process runs; reconnects forever), and `window.postMessage` when embedded. `window.livemixerSim.host.bus.subscribe(fn)` works from devtools.

Two ready-made consumers exist to start the audio project from:

- **`telemetry.html`** (same origin, second tab): live signal bars, a smoothed copy of each signal as a mapper might keep it, hands, events, editable parameters that are sent back with `set-param`, and simulation switching. Source: `src/sim/monitor.ts`, deliberately dependency-free.
- **`npm run telemetry:sink [port]`** (`scripts/telemetry-sink.ts`): a WebSocket server with no dependencies that prints the schema and a line per second of signals. Launch it, then open `sim.html?ws=ws://127.0.0.1:9000`. Any WebSocket library in any language works the same way; the page connects out and sends JSON text frames.

The smallest possible consumer in another tab:

```js
const channel = new BroadcastChannel('livemixer-sim');
channel.onmessage = ({ data }) => { if (data.message.type === 'frame') console.log(data.message.sim.signals); };
channel.postMessage({ direction: 'inbound', message: { type: 'get-schema' } });
```

## Depth bridge protocol

Defined once in `src/sim/input/protocol.ts` (zod) and implemented by `bridge/depth_bridge.py`. The bridge is a WebSocket server; on connect it sends `hello` (source name, physical box in metres, fps, occupancy grid size), then `frame` messages: `seq`, `t` (bridge monotonic seconds; the client estimates the clock offset with a sliding minimum), `hands[]` with `pos [u, v, w]` (u right, v down, w deeper), `conf`, `extent`, optional `points`, plus an optional base64 occupancy grid (row 0 = top of the image) and `stats`. See `bridge/README.md`.

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
- `npm run test:browser` (`tests/sim.spec.ts`) — every registered simulation renders with the synthetic performer in headless Chromium without warnings or signal-range violations, and again with `?forceRgba8=1` (the float render-target extensions left unrequested, so every 8-bit fallback shader actually compiles and runs); telemetry frames and schema flow; the monitor tab receives the stream; inbound commands work; the pointer source maps correctly. Headless rendering uses SwiftShader, so it proves correctness, not frame rate.
- `npx tsx scripts/sim-screenshots.ts` — one screenshot per simulation into `shots/` for a quick look without a camera.
