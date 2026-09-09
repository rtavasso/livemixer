# Depth bridge

A small native process that watches a physical box in front of a depth camera and streams whatever is inside it (a hand, an arm, a person) to the browser simulations as compact JSON over a WebSocket. The browser side (`src/sim/input/depth.ts`) connects to it; the wire format lives in `src/sim/input/protocol.ts` and is the single source of truth.

`depth_bridge.py` is the reference implementation: one file, numpy + websockets, optional OpenCV and RealSense.

## Install

```sh
pip install -r bridge/requirements.txt          # numpy, websockets
pip install opencv-python                        # optional: separates several blobs (two hands); required for the Leap Motion Controller source
pip install pyrealsense2                         # optional: Intel RealSense cameras
```

Python 3.10 or newer. Without OpenCV every in-range pixel is reported as one blob, which is fine for a single hand or a whole body.

## Run without hardware

```sh
python bridge/depth_bridge.py --source synthetic
```

The synthetic source renders a scripted performer (the same figure-eight script as the browser's synthetic source: present for 11 s, gone for 3 s, with occasional pushes towards the far plane) into a 640x480 depth image, so the whole pipeline runs. Add `--synthetic-hands 2` for two blobs (needs OpenCV to see them as two).

Then open the simulation page pointed at the bridge:

```
sim.html?source=depth&bridge=ws://127.0.0.1:8765
```

The browser reconnects with backoff, so start either side first.

## Run with a RealSense

```sh
python bridge/depth_bridge.py --source realsense --near 0.45 --far 1.1 --roi 0.2 0.1 0.8 0.9
```

Streams Z16 depth at 640x480 @ 30 fps (`--resolution`, `--fps`). `--decimation 2` halves the resolution in the camera SDK, which is cheaper and less noisy; the ROI is in fractions so nothing else changes. Hole filling is off by default (`--hole-filling` to enable) because filled holes invent depth where the sensor saw nothing, which reads as phantom matter inside the box.

If `pyrealsense2` is missing the bridge exits with a message saying so. If the camera drops out at runtime the bridge sends a `status` message with `level: "error"` to every client, then restarts the source with backoff and keeps serving.

## Leap Motion Controller as a depth camera

The original Leap Motion Controller is two infrared cameras 40 mm apart behind very wide lenses, lying on the desk and looking up. Its tracking service normally turns those images into a hand skeleton (that is what the browser's `source=leap` consumes over the service's WebSocket). `--source leap` uses the raw images instead: `bridge/leap_source.py` binds `LeapC.dll` with ctypes (no SDK wrapper), asks for the stereo pair, and `bridge/leap_stereo.py` rectifies it with the device's own calibration (`LeapRectilinearToPixel`), matches it with OpenCV's semi-global block matcher and converts disparity to depth (`Z = 40 mm * f / d`). What comes out is an ordinary `uint16` millimetre depth image of whatever is above the device, so the box, the blobs, the occupancy grid, the voxels and above all the **surface scan** work unchanged.

```sh
pip install opencv-python
python bridge/depth_bridge.py --source leap                                     # box: 10-45 cm above the device
python bridge/depth_bridge.py --source leap --leapc "C:\Program Files\Ultraleap\LeapSDK\lib\x64\LeapC.dll"
python bridge/leap_source.py --dump-images 3 --out test-results/leap            # rectified pair + depth as PNGs, checks camera order
python bridge/depth_bridge.py --source leap-synthetic --dump 3 --surface 8 6    # the same pipeline on a rendered hand, no hardware
python bridge/test_leap_stereo.py                                               # rectifier, matcher accuracy, box filtering
```

`--near`/`--far` default to `0.1`/`0.45` m for the Leap sources (heights above the device: the controller's illumination gives up at about 45 cm) and `--roi` works as usual. The depth image is the rectified view, `--leap-view W H` (default 320x240) spanning `--leap-fov` degrees horizontally (default 90, so the focal length is `f = 320 / (2 * tan 45°) = 160` px). `leap-synthetic` renders a textured fist and forearm sweeping above the device through a stand-in fisheye camera model, then rectifies and matches exactly like the live source; it runs at ~10-15 fps on a laptop and is what the tests and fixtures use.

### The 5.0-preview stall, and the fix

The machine this was developed on runs "Leap Motion Service 5.0.0-preview" (the January 2021 Core Services build). With it, every LeapC client behaves the same way: it connects, receives the Connection, Device and Policy events, is granted the images policy (`0x2`) and then `LeapPollConnection` **never returns** again: no tracking, no images, whatever the timeout, allocator, window focus or host language. The service's own visualizer shows frames, so the device is fine; the client path of that build is broken.

The bridge cannot be checked against live images here, so it is written to fail loudly rather than hang: the poll runs on its own daemon thread; if no image arrives within 3 s a warning names this stall and the fix; after 20 s `read()` raises, the server sends a `status` error to the browser and retries with backoff; the process stays responsive (the `hello` still goes out to new clients) and, because a thread stuck inside LeapC keeps the interpreter from exiting normally, the CLI hard-exits when it ends.

**Fix:** install current Ultraleap tracking software from Ultraleap's download page for the original controller, <https://www.ultraleap.com/downloads/leap-controller/> (Windows: *Ultraleap Hyperion* v6.2.0, `tracking-software-windows-6.2.0.exe`, about 600 MB; the "Leap Motion Service 5.0.0-preview" this was built against is the *Gemini Developer Preview* zip on the same page). Uninstall the preview first, keep the *Software Development Kit* component ticked so `LeapC.dll` lands in `C:\Program Files\Ultraleap\LeapSDK`, enable *Allow Images* (and *Allow Background Apps*) in its control panel, and run with `--leapc` pointing at its library, `C:\Program Files\Ultraleap\LeapSDK\lib\x64\LeapC.dll` (that path is searched first anyway, then the old Core Services install, then `$LEAPC_DLL`). The binding uses only calls present in every LeapC since 4.x, reads the `LEAP_CONNECTION_MESSAGE` layout off `msg.size` (16 bytes on 5.0, 20 on Gemini with its `device_id`), takes `LeapRectilinearToPixelEx` when it exists, and rebuilds its rectification maps whenever the images' `matrix_version` changes or the calibration comes back as NaN (which it does until the service has sent it). Two things could still need a first-run check on real images and are one flag each: if the depth image stays empty with a hand over the device, the two cameras are in the other order and `--swap-cameras` fixes it (`leap_source.py --dump-images` tries both orders and says which one puts pixels in the box); and the rectified pair should show the hand on the same rows in both eyes (the PNGs make that obvious).

### What to expect

- **Depth noise.** A 40 mm baseline with 160 px of focal length resolves `Z² / (40 * 160)` mm per pixel of disparity: 6 mm at 200 mm, 14 mm at 300 mm, 25 mm at 400 mm. The matcher works to 1/16 pixel on textured skin, so expect roughly 5-15 mm of depth noise at 30 cm and more at the silhouette, where block matching smears the hand a few pixels wider. On the synthetic scene the median error is about 1 % and the 90th percentile 2-3 % at 200-400 mm.
- **Range.** The IR LEDs light what is near: a hand at 20-40 cm is bright, the ceiling is black. `--leap-min-intensity` (default 16) throws away pixels darker than that before they can be matched, which is the main defence against phantom matter; the box's `--far` does the rest.
- **Rate.** The controller delivers up to ~100 stereo pairs per second; SGBM on 320x240 takes 15-20 ms on a laptop, so the bridge takes the newest pair each time it is ready and paces itself to `--fps` (default 30). A larger `--leap-view` sharpens the scan but costs roughly proportional time.

### Orienting the box

A depth camera on a tripod looks at the performer; the controller looks up from the desk. The depth image the bridge produces is therefore a view from underneath: column `u` runs along the device's long axis (its x axis, the baseline), row `v` along its short axis (device z, toward or away from the performer), and depth is the **height above the device**. `--near 0.1 --far 0.45` mean "between 10 and 45 cm up", `w = 0` is the low plane, and pushing "into the box" means lowering the hand. The browser starts from `DEPTH_MAPPING` (image x mirrored, image y flipped, w = z) like any depth source; do the two-corner calibration, then, with a hand over the device, check which way things move:

- Left/right or forward/back reversed: toggle the corresponding axis `mirror` in the overlay, or recapture the calibration corners.
- Left/right and forward/back exchanged (the device sits turned 90°): use `--leap-orient rot90` (or `rot270`, `rot180`, `flip-h`, `flip-v`, `transpose`) so the bridge rotates the depth image before analysis. Do this in the bridge rather than with an axis swap in the browser: the surface scan is a height field over the image plane and the browser drops it for swapped mappings.
- Pushed should be raising the hand instead: capture the calibration's *withdrawn* and *pushed* depths the other way round (the same trick `LEAP_MAPPING` uses for the skeleton source).

| Flag | Meaning |
| --- | --- |
| `--leapc PATH` | LeapC library. Default: the Ultraleap SDK, then Leap Motion Core Services, then `$LEAPC_DLL`. |
| `--leap-view W H` | Rectified view = depth image size (default 320x240). |
| `--leap-fov DEG` | Horizontal field of view of that view (default 90). Wider sees more of the desk at lower angular resolution; the lenses cover about 132°. |
| `--leap-min-intensity N` | Ignore IR pixels darker than N (default 16). |
| `--swap-cameras` | Exchange the cameras before matching. |
| `--leap-orient MODE` | Rotate or flip the depth image before analysis (default `none`). |

## The box: ROI, near, far

The bridge has no camera intrinsics and needs none. The box is defined in image terms:

| Flag | Meaning |
| --- | --- |
| `--near M` / `--far M` | Depth range in metres from the camera. Pixels with `near <= depth <= far` are inside the box. `w = (depth - near) / (far - near)`, so `w = 0` is the nearest plane and `w = 1` the farthest. Depth `0` (no measurement) is never inside. |
| `--roi X0 Y0 X1 Y1` | Rectangle of the image, as fractions of width and height (`0 0 1 1` is the full frame). Only pixels inside it count, and every reported `u`/`v` is normalized to the ROI: a hand at the ROI's left edge has `u = 0` wherever the ROI sits in the frame. |
| `--box-x MIN MAX` / `--box-y MIN MAX` | The box's metric extents in the camera's x/y. Purely informational: they go into the `hello` message for humans and telemetry. |

Reported points are `[u, v, w]` in `[0, 1]`: `u` rightwards and `v` downwards in the camera image, `w` deeper into the box. Row 0 of the occupancy grid, the voxel grid and the surface scan is the top of the ROI; slab 0 of the voxel grid is the near plane.

Picking values: stand where the performer will be, run `--dump 30` and look at `stats.pixels` and the hand's `pos`; widen `--far` until the far wall or floor starts to count, then pull it back. The `--roi` is easiest to set with the browser overlay showing the occupancy grid.

## Calibration in the browser

The bridge normalizes to the box it was told about; it does not know where the projection or the performer's comfortable reach is. That second mapping happens in the browser (`src/sim/input/mapping.ts`): the depth source starts from `DEPTH_MAPPING` (mirror x, flip y so image-down becomes sim-up, keep w as z), and the overlay's two-corner calibration captures the hand at the sim's bottom-left and top-right corners (and optionally withdrawn/pushed depths) to fit the source interval to the sim square.

The two layers complement each other:

- **Box config (bridge):** what physically counts as inside. Set it so that nothing but the performer is in range and the ROI covers the reachable area with some margin. Get this right first; calibration cannot recover pixels the bridge threw away.
- **Calibration (browser):** which part of the box maps to the full sim canvas, and which way is up. Re-run it whenever the display or camera moves; the bridge does not need restarting.

Occupancy is resampled through the same mapping (`mapOccupancy`), so a calibrated x/y also aligns the field-based simulations. The voxel grid goes through all three axis maps (`mapVoxels`) and the surface scan through x/y with its depths remapped by the z map (`mapSurface`), so one calibration serves every field.

## What a frame contains

```jsonc
{ "type": "frame", "seq": 12, "t": 1234.567,
  "hands": [{ "id": 1, "pos": [0.51, 0.48, 0.22], "conf": 1,
              "extent": [[0.45, 0.42, 0.22], [0.57, 0.55, 0.31]],
              "points": [[0.5, 0.42, 0.29], ...] }],
  "occupancy": "AAAA...",                       // base64, width*height bytes, row 0 = top
  "voxels": "AAAA...",                          // base64, nx*ny*nz bytes, x fastest, then y (top first), then z (near first)
  "surface": "AAAA...",                         // base64, width*height bytes, row 0 = top; 0 = empty, else 1 + round(254·w)
  "stats": { "pixels": 3376, "blobs": 1, "fps": 29.8, "processingMs": 6.1, "frameWidth": 640, "frameHeight": 480 } }
```

- `id` is stable while the same blob stays in view: blobs are matched to the previous frame by nearest centroid within `--max-jump` (normalized units) and survive a few missed frames. Ids never repeat in a run.
- `pos` is the centroid in `u`/`v` and the blob's **nearest tenth** in `w` (10th percentile of its depths), so a hand reaching in reads as pushed even though the arm behind it is deeper in the box.
- `extent` is the blob's bounding box; its `w` range uses the 10th/90th percentiles so one stray pixel cannot stretch it.
- `conf` rises from `--min-pixels` and saturates at four times that count.
- `points` are up to `--points` (default 16) evenly sampled pixels of the blob surface.
- `occupancy` is the fraction of in-range pixels per cell, `--occupancy W H` (default 32x24), omitted with `--no-occupancy`.
- `voxels` is the foreground in 3D and `surface` its scanned front face; both are described below.
- `t` is `time.perf_counter()` seconds; the browser estimates the offset itself.

`--morph N` runs N rounds of 3x3 morphological opening (pure numpy) to drop speckle; `--max-hands` caps the reported blobs (largest first, 16 at most). The occupancy grid, the voxel grid and the surface scan are all computed from the same opened mask, so they agree with each other and with `stats.pixels`.

## The foreground in 3D: voxels and the surface scan

A depth camera separates foreground from background for free: with `--near`/`--far` set so that the wall and floor are out of range, every in-range pixel *is* the performer. Besides the blobs, the bridge sends that foreground in two dense forms, both over the same ROI and depth range as `pos` so the browser inverts one set of axis maps for everything.

### `voxels`: fill fractions in a 3D grid

`--voxels NX NY NZ` (default 32x24x16, each side 1..128; `--no-voxels` to drop it). Every in-range pixel is binned once: its column into x, its row into y, and its depth `w` into z (`floor(w * NZ)`, clamped, so slab 0 touches the near plane and slab NZ-1 the far plane). A cell's lateral bounds follow the pixel-centre rule `floor((i + 0.5) / pixels * cells)`, the same rule the browser uses to look a cell up from a normalized coordinate, so a blob's `pos` and the voxels holding its pixels agree.

**Layout on the wire:** `nx*ny*nz` bytes, x fastest, then y with the TOP image row first, then z with the NEAREST slab first: byte index `(z * ny + y) * nx + x`. So byte 0 is the top-left cell at the near plane and the last byte is the bottom-right cell at the far plane.

**Normalisation:** a voxel's value is the number of foreground pixels that landed in it divided by the number of ROI pixels that project into its `(x, y)` column (its projected pixel area), scaled to 0..255 and clipped. Consequences worth knowing:

- A surface that fills a column at one depth reads 255 in that slab and 0 elsewhere: a solid hand is a bright slab, not a faint cloud.
- A surface crossing a slab boundary splits between the two slabs and they sum to 255. Pick `NZ` so a slab is thicker than the relief you want to read as solid: with the default 0.8 m range and 16 slabs a slab is 50 mm, thicker than a hand.
- One stray pixel in a column of hundreds reads 0 or 1, so thin noise stays low even before the opening removes it.
- Summed over z, the voxels are the occupancy grid of the same lateral cells (the test suite checks this).

The camera only sees front surfaces, so the grid is a shell: a hand fills the slab of its front face, not the slabs behind it. Simulations that need a solid can extend each column backwards by a thickness of their choosing.

### `surface`: the 3D scan of the foreground

`--surface W H` (default 64x48, each side 1..512; `--no-surface` to drop it). This is the depth map of whatever is inside the box, downsampled: for each cell of a `W x H` grid over the ROI, the NEAREST in-range depth among its pixels, or 0 if none of its pixels is in range.

**Layout on the wire:** `W*H` bytes, row-major, row 0 = top of the ROI. A byte is `0` for an empty cell, otherwise `1 + round(254 * w)` with `w` the cell's nearest foreground depth normalized into the box (`1` = the near plane, `255` = the far plane). A scanned point can therefore never be mistaken for "nothing here", and the browser inverts it with `surfaceByteToDepth` (`(byte - 1) / 254`, or null for 0).

The minimum is taken per cell, not the mean, so a fingertip that covers a few pixels of a cell still sets that cell's depth; noise is handled by the morphological opening of the mask, not by averaging. The surface is a height field over the camera's image plane, which is what a "scan" is: the front face of the foreground, background removed.

### Cost

Both fields are pure numpy. Voxelisation is one scan of the mask plus a few gathers per foreground pixel into a `bincount` (the vectorised form of `np.add.at`) over lookup tables cached per frame size; the surface scan is two `minimum.reduceat` block reductions over the masked depth, a fixed cost per frame. On the development machine with a 640x480 frame: voxels at 32x24x16 take ~0.3 ms for a hand (6 500 foreground pixels) and ~7 ms for a whole body (160 000 pixels); the surface at 64x48 takes ~2 ms whatever is in the box. For scale, the 32x24 occupancy grid's integral image costs ~8 ms on the same machine, and the whole `analyze` pass ~14 ms with every field on.

On the wire the defaults add 12 288 bytes of voxels and 3 072 bytes of surface per frame (16 KB and 4 KB as base64), about 0.6 MB/s at 30 fps over the local socket. Shrink `--voxels` before shrinking `--surface`: the surface is the cheaper and more precise description of a hand, the voxels are what fills a volume.

### In the browser

`bridgeFrameToInput` decodes both with the sizes announced in `hello` (`decodeVoxels`, `decodeSurface`) into `InputFrame.voxels` (`VoxelGrid`, source frame, z index 0 = nearest the camera) and `InputFrame.surface` (`DepthSurface`). The tracker then maps them into sim space every frame:

- `mapVoxels` resamples the grid through all three axis maps (mirror, flip, calibration interval) into `input.volume`, a `VolumeField` of `volumeNx x volumeNy x volumeNz` cells (tracker settings, default 48x32x24) with x fastest, then y, then z from the glass. A cell of the sim volume takes the value of the source voxel its centre falls in, so the browser resolution can be higher than the bridge's without inventing detail.
- `mapSurface` resamples the scan through the x/y maps into `input.surface`, a `SurfaceField` of `surfaceWidth x surfaceHeight` cells (default 96x64): per cell a sim-space depth `z` (0 = glass, 1 = back wall, via the z axis map) and a `mask` byte that is 255 where something was scanned. It survives mirroring and calibration intervals but not an axis swap (the surface is a height field over the image plane); with a swapped mapping `input.surface` is null.

Simulations treat `input.volume` and `input.surface` as optional: a skeleton source (Leap) sends capsules instead, and the fallback is always the sphere at `position` with `radius`. Both fields go stale and drop to null when frames stop arriving, like the hands.

## Fixtures and tests

```sh
python bridge/test_bridge.py                     # or: python -m bridge.test_bridge
python bridge/depth_bridge.py --source synthetic --dump 5 --occupancy 8 6 --voxels 8 6 4 --surface 8 6 > bridge/fixtures/sample_messages.jsonl
npx vitest run tests/sim/bridge-fixture.test.ts  # the fixture through the browser's zod schema
```

`--dump N` prints the `hello` and N frames as JSON lines to stdout instead of serving. The fixture uses small grids (8x6 cells, 4 slabs) to stay readable; with a 640x480 frame every cell is exactly 80x80 pixels, which the layout tests rely on. The Python tests check the shapes by hand and pin the layouts (byte 0 is the top-left cell at the near plane, the last byte the bottom-right cell at the far plane, an empty surface cell is 0 and the near plane is 1); the vitest passes the checked-in fixture through `parseBridgeMessage`, decodes all three fields with `decodeOccupancy`/`decodeVoxels`/`decodeSurface`, and checks that the synthetic hand's voxels peak and its scan is nearest at its centroid and depth. A drift on either side fails a test.

## Adding a camera

Subclass `FrameSource` in `depth_bridge.py`, return `DepthFrame(uint16 millimetres, time.perf_counter())` from `read()` (row 0 = top, column 0 = left), open and close the device in `start()`/`stop()`, and add the class to the `SOURCES` dict so it becomes a `--source` choice. `read()` runs in a worker thread and may block; raise on hardware errors and the server will report and restart. `AzureKinectSource` is a documented stub showing the `pyk4a` and OpenNI2 calls; `leap_source.py` is a complete example of a source in its own module (listed in `LEAP_SOURCES` and imported on demand) that builds depth from a stereo pair.

The analyzer only ever sees millimetres and a frame size, so no other code changes.
