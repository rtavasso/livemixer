# Depth bridge

A small native process that watches a physical box in front of a depth camera and streams whatever is inside it (a hand, an arm, a person) to the browser simulations as compact JSON over a WebSocket. The browser side (`src/sim/input/depth.ts`) connects to it; the wire format lives in `src/sim/input/protocol.ts` and is the single source of truth.

`depth_bridge.py` is the reference implementation: one file, numpy + websockets, optional OpenCV and RealSense.

## Install

```sh
pip install -r bridge/requirements.txt          # numpy, websockets
pip install opencv-python                        # optional: separates several blobs (two hands)
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

## The box: ROI, near, far

The bridge has no camera intrinsics and needs none. The box is defined in image terms:

| Flag | Meaning |
| --- | --- |
| `--near M` / `--far M` | Depth range in metres from the camera. Pixels with `near <= depth <= far` are inside the box. `w = (depth - near) / (far - near)`, so `w = 0` is the nearest plane and `w = 1` the farthest. Depth `0` (no measurement) is never inside. |
| `--roi X0 Y0 X1 Y1` | Rectangle of the image, as fractions of width and height (`0 0 1 1` is the full frame). Only pixels inside it count, and every reported `u`/`v` is normalized to the ROI: a hand at the ROI's left edge has `u = 0` wherever the ROI sits in the frame. |
| `--box-x MIN MAX` / `--box-y MIN MAX` | The box's metric extents in the camera's x/y. Purely informational: they go into the `hello` message for humans and telemetry. |

Reported points are `[u, v, w]` in `[0, 1]`: `u` rightwards and `v` downwards in the camera image, `w` deeper into the box. Row 0 of the occupancy grid is the top of the ROI.

Picking values: stand where the performer will be, run `--dump 30` and look at `stats.pixels` and the hand's `pos`; widen `--far` until the far wall or floor starts to count, then pull it back. The `--roi` is easiest to set with the browser overlay showing the occupancy grid.

## Calibration in the browser

The bridge normalizes to the box it was told about; it does not know where the projection or the performer's comfortable reach is. That second mapping happens in the browser (`src/sim/input/mapping.ts`): the depth source starts from `DEPTH_MAPPING` (mirror x, flip y so image-down becomes sim-up, keep w as z), and the overlay's two-corner calibration captures the hand at the sim's bottom-left and top-right corners (and optionally withdrawn/pushed depths) to fit the source interval to the sim square.

The two layers complement each other:

- **Box config (bridge):** what physically counts as inside. Set it so that nothing but the performer is in range and the ROI covers the reachable area with some margin. Get this right first; calibration cannot recover pixels the bridge threw away.
- **Calibration (browser):** which part of the box maps to the full sim canvas, and which way is up. Re-run it whenever the display or camera moves; the bridge does not need restarting.

Occupancy is resampled through the same mapping (`mapOccupancy`), so a calibrated x/y also aligns the field-based simulations.

## What a frame contains

```jsonc
{ "type": "frame", "seq": 12, "t": 1234.567,
  "hands": [{ "id": 1, "pos": [0.51, 0.48, 0.22], "conf": 1,
              "extent": [[0.45, 0.42, 0.22], [0.57, 0.55, 0.31]],
              "points": [[0.5, 0.42, 0.29], ...] }],
  "occupancy": "AAAA...",                       // base64, width*height bytes, row 0 = top
  "stats": { "pixels": 3376, "blobs": 1, "fps": 29.8, "processingMs": 6.1, "frameWidth": 640, "frameHeight": 480 } }
```

- `id` is stable while the same blob stays in view: blobs are matched to the previous frame by nearest centroid within `--max-jump` (normalized units) and survive a few missed frames. Ids never repeat in a run.
- `pos` is the centroid in `u`/`v` and the blob's **nearest tenth** in `w` (10th percentile of its depths), so a hand reaching in reads as pushed even though the arm behind it is deeper in the box.
- `extent` is the blob's bounding box; its `w` range uses the 10th/90th percentiles so one stray pixel cannot stretch it.
- `conf` rises from `--min-pixels` and saturates at four times that count.
- `points` are up to `--points` (default 16) evenly sampled pixels of the blob surface.
- `occupancy` is the fraction of in-range pixels per cell, `--occupancy W H` (default 32x24), omitted with `--no-occupancy`.
- `t` is `time.perf_counter()` seconds; the browser estimates the offset itself.

`--morph N` runs N rounds of 3x3 morphological opening (pure numpy) to drop speckle; `--max-hands` caps the reported blobs (largest first, 16 at most).

## Fixtures and tests

```sh
python bridge/test_bridge.py                     # or: python -m bridge.test_bridge
python bridge/depth_bridge.py --source synthetic --dump 5 --occupancy 8 6 > bridge/fixtures/sample_messages.jsonl
npx vitest run tests/sim/bridge-fixture.test.ts  # the fixture through the browser's zod schema
```

`--dump N` prints the `hello` and N frames as JSON lines to stdout instead of serving. The Python tests check the shapes by hand; the vitest passes the checked-in fixture through `parseBridgeMessage` and decodes the occupancy, so a drift on either side fails a test.

## Adding a camera

Subclass `FrameSource` in `depth_bridge.py`, return `DepthFrame(uint16 millimetres, time.perf_counter())` from `read()` (row 0 = top, column 0 = left), open and close the device in `start()`/`stop()`, and add the class to the `SOURCES` dict so it becomes a `--source` choice. `read()` runs in a worker thread and may block; raise on hardware errors and the server will report and restart. `AzureKinectSource` is a documented stub showing the `pyk4a` and OpenNI2 calls.

The analyzer only ever sees millimetres and a frame size, so no other code changes.
