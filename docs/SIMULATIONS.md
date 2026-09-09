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
| `source=pointer\|synthetic\|webcam\|depth` | Input source. `replay` is chosen from the overlay with a file. |
| `bridge=ws://127.0.0.1:8765` | Depth bridge URL. |
| `ws=ws://127.0.0.1:9000` | Telemetry WebSocket the page connects out to (the audio process listens). |
| `overlay=0` | Start with the overlay hidden. |
| `quality=low\|medium\|high` · `dpr=1` · `rate=30` | GPU budget, pixel-ratio cap, telemetry rate. |

Settings persist in `localStorage` under `livemixer-sim-settings`; URL parameters override and are then persisted.

## Coordinate spaces

Three frames exist and only one of them is ever seen by a simulation.

1. **Source frame.** Each input source reports positions normalized to `[0, 1]` on every axis in whatever orientation is natural for it: image right/down for cameras, the bridge's bounding box for depth. Nothing else about the source leaks through.
2. **Sim space.** `x` left→right as the viewer sees the display, `y` bottom→top, `z` 0 = withdrawn/far, 1 = pushed in/near. `x` and `y` each span the whole canvas, so a simulation wanting round circles converts with `toUniform(p, aspect)` (height = 1, width = aspect). A hand's `radius` is in sim x units; `uniformRadius(radius, aspect)` converts it.
3. **Physical space.** Metres in front of the camera. The bridge owns this: it is told the box (`--near/--far`, an image ROI) and normalizes into the source frame. The browser never needs intrinsics.

`SpaceMapping` (`src/sim/input/mapping.ts`) converts source → sim: per sim axis, which source axis feeds it, which source interval maps onto `[0, 1]`, and a mirror flag. Sources ship with sensible defaults (cameras mirror x so a person facing the display sees their hand move the right way). **Calibration** refines the interval: hold the hand at the bottom-left and top-right corners of the intended play area (and optionally at the withdrawn/pushed depth extremes) and capture each; the mapping then sends those points to the sim corners. Mappings are saved per source.

## Input pipeline

`InputFrame` → `HandTracker` → `HandState[]` → `detectGestures` → `SimInput`.

- **Sources** (`src/sim/input/*.ts`) implement `InputSource`: `pointer` (mouse/touch; press = push, wheel = depth, Shift = closed hand), `synthetic` (deterministic scripted performer with an occupancy blob), `webcam` (MediaPipe landmarks through the existing local worker; depth from apparent hand size), `depth` (bridge WebSocket client), `replay` (JSONL recorded from any source).
- **Tracker** (`conditioning.ts`): presence hysteresis (`enterMs` before a hand exists, `leaveMs` grace after the last observation), One-Euro filtering of position, EMA velocity, a faster-filtered `push` for tap-like responses, smoothed `presence` and `activity`, occupancy resampled into sim orientation. Deterministic: all time arrives through arguments.
- **Gestures** (`gestures.ts`): `enter`, `leave`, `swipe` (once per fast segment, with direction), `push` (fast z rise), `hold` (still for ~1 s, once), `grab`/`release` (openness hysteresis; only landmark sources supply openness).

`SimInput` also carries `occupancy`, a 64×48 field (row 0 = bottom) of how much of each cell the tracked matter fills. Simulations that want the whole silhouette rather than a point (a curtain, water) upload it as a texture.

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
- **Budget for a 2020 Intel MacBook** (integrated GPU, Safari or Chrome). Prefer RGBA16F targets (`pickFormat`), 256²–512² fluid grids, a few thousand cloth points at most, one or two full-screen passes at native resolution. Use `ctx.quality` to scale resolution. Keep `step` under ~2 ms and `render` under ~6 ms.
- **Signals must be cheap** and numerically stable. GPU readbacks go through a small probe target (e.g. 16×16) read at most once per frame.
- **Handle context loss** by holding no state outside the instance; the host disposes and recreates on restore.
- **Own your GL state.** The host resets nothing between passes or simulations: set blend/viewport at the start of `render`, and leave blending and depth testing disabled when you return. `SimContext.width/height/aspect` are kept current by the host; `RenderFrame` carries the same numbers.
- **Hot loops:** avoid `Math.hypot` and per-call closures (both are an order of magnitude slower in V8); the `core/math.ts` and `core/noise.ts` helpers are already written that way.

GL helpers live in `src/sim/gl/`: `Program` (compile with readable errors, cached uniforms), `Fbo`/`PingPong` (`pickFormat` chooses the best renderable float format), `drawQuad`/`quadProgram`/`blit` for full-screen passes, `GLSL_HEADER` for `#version 300 es`.

## The simulations

All coordinates below are uniform units (canvas height = 1). Every parameter and signal is declared in the simulation's `index.ts` with ranges and descriptions; the overlay and the telemetry schema show them live. Signal ranges are the contract the audio side maps against.

### Afterglow (`trails`)
Pure black. A present hand leaves trails of light that linger and fade; with nobody there the picture returns to true black. GPU accumulation buffer (RGBA16F, half size on `low`) with frame-rate-independent decay, distance-to-segment brush strokes batched from all steps since the last frame, ember sparkles as point sprites drifting on curl noise, quarter-res bloom, ACES tone-map, grain. Hands get slightly offset hues. Params: `lifetime`, `brushSize`, `brightness`, `hue`, `hueDrift` (bounded Perlin wander, so the palette never turns muddy), `saturation`, `sparkle`, `drift`, `bloom`, `grain`. Signals: `glow` (mean luminance from a 16×16 probe), `ink` (stroke energy being laid down now), `hue`, `coverage` (lit fraction), `sparkles` (alive fraction). Cost: two full-res passes plus small ones, ≈2.5 ms GPU estimated at 1440×900.

### Veil (`veil`)
A sheer curtain hanging from a rod above the frame, breathing in a breeze from a dim window behind it. CPU position-based dynamics (40×60 / 52×78 / 56×84 points by quality, 2 substeps) with structural, shear and bend constraints, gathered folds, a curl-noise wind lattice with gusts, and sphere colliders for hands with drag so a sweep pulls fabric along. **z is toward the viewer**: a withdrawn hand hovers in front of the sheet, a pushed hand passes through it (`reach`). Rendered as an indexed mesh with premultiplied blending: coverage rises where folds are seen edge-on, warm transmission from the backlight, fine weave faded by `fwidth`, a post pass for exposure and dither. Params: `wind`, `gustiness`, `stiffness`, `damping`, `drape`, `opacity`, `backlight`, `tint`, `reach`, `weave`. Signals: `sway`, `flutter`, `contact` (share of fabric within a hand's reach), `depth` (−1 pushed away … +1 billowing toward the viewer), `gust`, `tension`. Cost: ≈1.3 ms per step at `medium` and ≈1.5 ms at `high` on the development machine (roughly double on the 2020 MacBook); `medium` is the safe installation setting.

### Basin (`basin`)
A bowl of dark water seen from above holding drops of ink. Stam stable fluids on a 160²/256²/320² grid (dye at twice that) in an analytic circular bowl with no-slip walls: advection, hand forces (water under a hand relaxes toward the hand's velocity; a push adds a radial impulse and an ink bead), vorticity confinement, Jacobi pressure (16/24/32 iterations), dye advection with dissipation, a faint drift so ink keeps moving when nobody is there. One composite pass: water floor with caustics refracted by a fake surface normal, ink with subsurface softness, a window reflection and glints, meniscus and rim, table outside. Drops seed at start, on `enter` (optional) and on pushes. Params: `viscosity`, `vorticity`, `stir`, `ink`, `palette` (indigo, ember, lagoon, sumi, orchid), `fade`, `bowl`, `dropOnEnter`, `light`, `caustics`. Signals from a 16×16 probe read back asynchronously: `energy`, `swirl`, `rotation` (−1 clockwise … +1 counter-clockwise), `ink`, `calm`. Cost: ≈30 small grid passes plus one full-screen composite per frame at `medium`.

### Prism (`prism`)
White light and glass. The hand is the light source: a beam leaves the hand aimed at a slowly spinning prism, so moving around it changes the incidence angle and the spectrum fans out, folds and reflects internally; pushing widens the beam; with nobody there a faint idle beam orbits. CPU ray tracer (`optics.ts`): Cauchy dispersion, Snell, unpolarised Fresnel splitting with a depth-first stack, total internal reflection, 12/16/24 wavelengths per ray drawn from an interleaved spectrum table so the fan is stripe-free, capped at 40 000 segments with an adaptive ray budget that thins the beam uniformly (rays launch in bit-reversed order) rather than clipping one side. Rendering: instanced anti-aliased line quads (core + halo) accumulated additively into RGBA16F so overlapping wavelengths sum back to white, two glow blurs, filmic composite, the prism drawn from a signed-distance field with edges lit by the glow that crosses them. Params: `size`, `spin`, `glass`, `dispersion` (1 = physical crown glass; the default exaggerates because the screen is only a few beam-widths away), `beam`, `rays`, `bounces`, `glow`, `idle`, `twin`. Signals: `spread`, `hue` (of the dominant exit fan), `brightness`, `reflected`, `incidence`, `inside`. Cost: trace ≈1 ms at `medium`, once per rendered frame.

### Presence (`presence`)
The reference simulation: a soft light gathers around a hand and tightens when pushed. Copy it to start something new.

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
