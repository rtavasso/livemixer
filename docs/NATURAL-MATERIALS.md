# Natural materials on the Intel laptop

The three material studies run in the same simulation player in the studio and
the mixer. Existing patches, signal names, input sources and audio routes still
work. New material parameters receive defaults when an older patch is loaded.
Veil's sway measurement now compares each point with its settled position,
so opposing fold movements cannot cancel into an incorrectly silent signal.

| Study | Material and motion | New controls |
| --- | --- | --- |
| Basin | Absorbing ink under clear water, travelling ripples, refracted glaze, window reflections, rounded porcelain rim and stone table | Ripples, bowl glaze |
| Veil | Woven linen with independent fibre colour, translucent folds, soft sheen, layered hems and stitching in daylight | Fabric colour, fibre sheen |
| Prism | Closed optical glass, entry/exit refraction, thickness absorption, polished studio reflections and a stone light table | Glass polish |

Start Vite and open `/sim.html?sim=basin&source=synthetic&quality=medium&overlay=0`
(substitute `veil` or `prism`). Press **H** for the controls. Synthetic input
includes a depth surface; pointer, webcam, skeleton and depth bridge inputs use
the same simulation contracts. Save a performance patch and choose **Play in
mixer** to use the scene's signals in music.

## Rendering budget

Medium targets the MacBook's Intel Iris Plus 655 and 8 GB of shared system memory.
The host bounds the drawing buffer independently of monitor size and DPR:

| Quality | Maximum pixels | Basin flow / dye / waves | Veil points |
| --- | ---: | --- | --- |
| Low | 480,000 | 160² / 320² / 96² | 40 × 60 |
| Medium | 1,024,000 | 256² / 512² / 128² | 52 × 78 |
| High | 2,073,600 | 320² / 640² / 160² | 56 × 84 |

The canvas fills the available space; the browser scales its drawing buffer.
Smaller mixer panels use fewer pixels. Medium at a 1280 × 800 viewport renders
at 1280 × 800 even on a 2× Retina display. High is an explicit quality choice.
This is a fixed ceiling, not adaptive frame-rate scaling or a 60 fps guarantee.
Physics resolution and the fixed 60 Hz clock do not change during a resize.

The wave field adds two RGBA8 textures: 128 KiB together at medium quality.
Cloth gains no constraints or extra pass. Glass replaces its additive face and
edge buffers with analytic intersections in the existing composite pass.
Materials use procedural lighting and textures without downloads or libraries.
The mixer suspends its simulation during library analysis and when its player
is inactive, as before.

## Reproduce measurements

Measured on this MacBook on 2026-09-14, Chrome for Testing 153.0.8010.12 using
ANGLE Metal on Intel Iris Plus 655, medium quality at 1280 × 800. Each sample ran
for 20 seconds after eight seconds of warmup, with one synthetic performer and
a depth surface, in the studio:

| Scene | Average fps | Frame p95 | Frame p99 | CPU step p95 | CPU submit p95 |
| --- | ---: | ---: | ---: | ---: | ---: |
| Basin | 60.0 | 17.6 ms | 17.7 ms | 1.17 ms | 1.93 ms |
| Veil | 60.0 | 17.6 ms | 17.7 ms | 2.30 ms | 0.58 ms |
| Prism | 60.0 | 17.6 ms | 17.7 ms | 0.03 ms | 1.54 ms |

All three had zero dropped simulation time, warnings, or signal-range violations.
CPU columns are percentiles of the host's smoothed CPU timings. Raw reports and
screenshots from this run are in `shots/benchmark-medium/` (local, ignored).
Before the material changes, the same GPU and resolution also reached about
60 fps; the material pass preserved that cadence in these samples.

Fullscreen mixer runs with synthetic music and the audio graph active used a
1405 × 728 drawing buffer (the toolbar occupies some of the screen). Basin and
Prism averaged 60.0 fps, with zero dropped simulation time. After the sway fix,
Veil averaged 59.5 fps, with 17.6 ms frame p95, 3.05 ms CPU step p95, and 6.4 ms
of dropped simulation time over 20 seconds. Its sway output ranged from 0.144
to 0.397 instead of remaining zero. Audio was running with a nonzero output
meter in all three. Those local reports are in `shots/benchmark-mixer/` and
`shots/benchmark-veil-final/`; no long-duration thermal claim is implied.

```sh
PORT=4190 npm run dev
npm run benchmark:sim -- --port 4190 --seconds 20
npm run benchmark:sim -- --port 4190 --quality low --width 1920 --height 1080
npm run benchmark:sim -- --port 4190 --mixer --fullscreen --out shots/mixer
```

The benchmark uses headed Chromium, eight seconds of warmup, then samples
delivered animation-frame intervals with a synthetic performer. It writes
`shots/benchmark/results.json` and screenshots. Reports include the actual GPU
renderer, browser version, drawing-buffer size, average fps, frame interval
percentiles, CPU step/submission time, dropped simulation time and signal ranges.
Run one benchmark at a time; keep its tab visible and avoid other GPU work.
`--headless` is available for correctness checks, but those runs and detected
software renderers are explicitly excluded from hardware evidence.

The overlay's CPU timings are submission timings, not GPU execution timings.
Frame cadence includes presentation, browser scheduling and competing work.
For an installation, also measure the real camera and music library after the
laptop has warmed up. A short synthetic run does not establish thermal endurance
or webcam inference performance.

## Physical models and limits

Basin combines the existing incompressible 2D ink flow with a separate damped
height-field wave equation. Its speed, grid and 60 Hz step obey the 2D CFL bound.
Zero-mean impulses dip the surface and raise a surrounding ring, Neumann walls
reflect waves, and damping settles them. Signed height and velocity use two bytes
each with exact zero and filterable decoding, including on GPUs without floating
render targets. This models a shallow contained surface, not breaking waves,
spray, or a three-dimensional liquid. Floor caustics are bounded curvature/noise
approximations; water colour uses Beer–Lambert absorption.

Veil keeps the deterministic cloth solver and geometric hand/scan contact.
Optical thickness increases with viewing angle and in folded-over hems. A
Charlie-style fibre distribution adds soft sheen to diffuse and transmitted
daylight. Fold overlap uses premultiplied transparency; the solver does not add
cloth self-collision or order-independent transparency.

Prism keeps the spectral CPU beam tracer, including Cauchy dispersion, Fresnel
splitting, Snell refraction and total internal reflection. The camera's material
shader separately intersects the closed solid and follows at most two internal
segments. It uses the middle wavelength's index and a procedural environment.
Twin prisms still exchange spectral beams; camera rays shade the nearest prism
and do not recursively trace another object. Reflection roughness broadens studio
lights; it does not simulate frosted transmission. These are bounded real-time
approximations, not path-traced photorealism.

Material references: [Filament's cloth model](https://google.github.io/filament/Filament.html#materialsystem/clothmodel)
and [GPU Gems: water simulation](https://developer.nvidia.com/gpugems/gpugems/part-i-natural-effects/chapter-1-effective-water-simulation-physical-models).
The implementation uses repo-native GLSL and the existing solver contracts.
