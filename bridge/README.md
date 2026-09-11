# Depth bridge

A small native process that watches a physical box in front of a depth camera and streams whatever is inside it (a hand, an arm, a person) to the browser simulations as compact JSON over a WebSocket. A source that also tracks hands (the Leap Motion Controller) sends the hand skeleton in the same frame as its depth scan, so the browser gets both at once. The browser side (`src/sim/input/depth.ts`) connects to it; the wire format lives in `src/sim/input/protocol.ts` and is the single source of truth.

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

The synthetic source renders a scripted performer (the same figure-eight script as the browser's synthetic source: present for 11 s, gone for 3 s, with occasional pushes towards the far plane) into a 640x480 depth image, so the whole pipeline runs. Add `--synthetic-hands 2` for two blobs (needs OpenCV to see them as two). Each synthetic hand also carries a procedural skeleton lying on its dome (palm at the centre, fingers fanning out, every joint at the rendered depth under it), so the `skeleton` path of the protocol runs without hardware too.

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
python bridge/leap_source.py --dump-images 3 --out test-results/leap            # raw + rectified pair, depth, calibration grids; checks camera order and row alignment
python bridge/stereo_lab.py --input test-results/leap                           # re-match those dumps offline under many settings, with a contact sheet
python bridge/depth_bridge.py --source leap-synthetic --dump 3 --surface 8 6    # the same pipeline on a rendered hand, no hardware
python bridge/test_leap_stereo.py                                               # rectifier, matcher accuracy, box filtering
```

`--near`/`--far` default to `0.1`/`0.45` m for the Leap sources (heights above the device: the controller's illumination gives up at about 45 cm) and `--roi` works as usual. The depth image is the rectified view, `--leap-view W H` (default 480x360) spanning `--leap-fov` degrees horizontally (default 90, so the focal length is `f = 480 / (2 * tan 45°) = 240` px), matched with the parallel three-direction SGBM (`--leap-mode 3way`), and the surface scan defaults to 160x120 for these sources (3 view pixels per cell). The right camera is aligned to the left from the first frames' feature matches (`--leap-align auto`), see *Tuning the stereo* below for why. `leap-synthetic` renders a textured fist and forearm sweeping above the device through a stand-in fisheye camera model, then rectifies and matches exactly like the live source; it runs at ~10-15 fps on a laptop and is what the tests and fixtures use.

### Hand tracking and depth in one stream

The tracking service's own output, the hand skeleton, rides along with the scan. LeapC's tracking events (`LEAP_TRACKING_EVENT`, no extra policy needed beyond the background-frames flag the bridge already requests) are copied into plain records the moment they arrive: per hand the id, chirality, confidence, grab and pinch strength, the palm, the wrist (`arm.next_joint`), the elbow (`arm.prev_joint`), and per finger the five joints (metacarpal base, knuckle, the two inter-phalangeal joints, tip) with the proximal bone's width and the extended flag. A short deque of these (about a quarter second) is kept, and each stereo pair takes the tracking frame nearest its own timestamp (within 50 ms, else the skeleton is considered stale and the frame goes out without one).

The skeleton is then **projected into the depth image** so that it coincides with the scan: the depth image is the rectified view of one camera looking up, so for a device-frame point `p` (millimetres, x along the long axis, y up, z toward the performer) the projection is `q = p - camera_origin` (the reference camera sits at `±baseline/2` along x; `--swap-cameras` makes it the other one), `depth = q.y`, `u = cx + fx·a/depth`, `v = cy + fy·b/depth` where `a`/`b` are the two remaining device axes with signs, then the same `--leap-orient` reorientation as the image. Widths (palm, forearm, fingers; all diameters) become `width·fx/depth` pixels at their own part's depth, so they are in the same perspective units as the scan. The forearm is trimmed to a 70 mm stub past the wrist before projecting. `BoxAnalyzer` normalizes the joints with exactly the ROI and depth range it uses for the pixels (`u/roi_w`, `v/roi_h`, `w = (depth - near)/(far - near)`, widths `/roi_w`); joints are **not** clamped (a small overshoot is allowed by the browser and keeps bones straight), the hand's `pos` is.

Which of LeapC's device axes is image right and which is image down, with which signs, and which camera is the reference, is not documented and could not be checked here (the 5.0-preview service delivers no events to third-party clients). So the convention is a value: `--leap-hand-frame NAME` fixes it, where the names are `u{+|-}{x|z}_v{+|-}{z|x}_ref{+|-}` (which device axis and sign is `u`, which is `v`, and on which side of the device the reference camera sits), sixteen in all. The default `--leap-hand-frame auto` **detects** it: on every frame that has both a tracked hand and depth, every candidate projects the palm, the wrist and the 25 finger joints and scores the fraction that land on a depth pixel holding a measurement within ±30 mm of the joint's own depth. The right convention puts the skeleton on the scanned hand; the others put it beside, mirrored or transposed. Hits accumulate over frames and the winner is locked once at least 5 frames have been scored, it hits at least half its joints and leads the runner-up by 0.15; until then the leading candidate is used provisionally (plausible ones win ties: only `u` along the baseline with the reference camera on the low-`u` side can produce positive disparities, so if the scan works, those four are the real contenders). The lock is logged, the state line in the stall message shows the tally, and `leap_source.py --dump-images` prints the full table:

```sh
python bridge/leap_source.py --synthetic --dump-images 3      # the table shows u+x_v-z_ref- at 1.000, everything else below 0.35
python bridge/depth_bridge.py --source leap --leap-hand-frame u+x_v-z_ref-   # skip detection once you know
```

`leap-synthetic` is the positive control: its scripted fist and forearm carry a skeleton lying on the rendered surfaces (`leap_stereo.hand_skeleton`), expressed in device millimetres under a chosen "true" convention and pushed through the same projector as live hands, and the tests check that auto mode locks on the truth for several different truths.

What the browser receives (`hello.skeleton: true` announces it; plain depth cameras omit the field):

- **When the frame has tracked hands, they are the `hands`:** `id` is the Leap's hand id, `pos` the palm, `conf = max(0.5, confidence)` (Ultraleap under-reports confidence and the browser's tracker drops hands below 0.3), `extent` the bounding box of every joint, `openness = 1 - grab_strength`, `pinch = pinch_strength`, `points` the palm and the five fingertips (`--points 0` drops them), and `skeleton` (below).
- **When it has none, the blobs are reported exactly as for any depth camera** (no `skeleton`, no `openness`/`pinch`), so a Leap with tracking lost still drives the simulations from the scan; `stats.trackedHands` says which it was. A tracked hand whose palm has left the box by more than a quarter of it on any axis is dropped like any pixel outside the box rather than reported stuck to a wall.
- **The skeleton also sharpens the scan itself:** its capsule model is rendered into the depth image before the scan, the voxels, the occupancy and the blobs are computed, filling in the fingers the matcher could not see (*Fusing the skeleton into the scan*, below; `--scan-fuse off` turns it off).

### The 5.0-preview stall, and the fix

The machine this was developed on runs "Leap Motion Service 5.0.0-preview" (the January 2021 Core Services build). With it, every LeapC client behaves the same way: it connects, receives the Connection, Device and Policy events, is granted the images policy (`0x2`) and then `LeapPollConnection` **never returns** again: no tracking, no images, whatever the timeout, allocator, window focus or host language. The service's own visualizer shows frames, so the device is fine; the client path of that build is broken.

The bridge cannot be checked against live images here, so it is written to fail loudly rather than hang: the poll runs on its own daemon thread; if no image arrives within 3 s a warning names this stall and the fix; after 20 s `read()` raises, the server sends a `status` error to the browser and retries with backoff; the process stays responsive (the `hello` still goes out to new clients) and, because a thread stuck inside LeapC keeps the interpreter from exiting normally, the CLI hard-exits when it ends.

**Fix:** install current Ultraleap tracking software from Ultraleap's download page for the original controller, <https://www.ultraleap.com/downloads/leap-controller/> (Windows: *Ultraleap Hyperion* v6.2.0, `tracking-software-windows-6.2.0.exe`, about 600 MB; the "Leap Motion Service 5.0.0-preview" this was built against is the *Gemini Developer Preview* zip on the same page). Uninstall the preview first, keep the *Software Development Kit* component ticked so `LeapC.dll` lands in `C:\Program Files\Ultraleap\LeapSDK`, enable *Allow Images* (and *Allow Background Apps*) in its control panel, and run with `--leapc` pointing at its library, `C:\Program Files\Ultraleap\LeapSDK\lib\x64\LeapC.dll` (that path is searched first anyway, then the old Core Services install, then `$LEAPC_DLL`). The binding uses only calls present in every LeapC since 4.x, reads the `LEAP_CONNECTION_MESSAGE` layout off `msg.size` (16 bytes on 5.0, 20 on Gemini with its `device_id`), takes `LeapRectilinearToPixelEx` when it exists, and rebuilds its rectification maps whenever the images' `matrix_version` changes or the calibration comes back as NaN (which it does until the service has sent it). Two things could still need a first-run check on real images and are one flag each: if the depth image stays empty with a hand over the device, the two cameras are in the other order and `--swap-cameras` fixes it (`leap_source.py --dump-images` tries both orders and says which one puts pixels in the box); and the rectified pair should show the hand on the same rows in both eyes (the PNGs make that obvious).

### What to expect

- **Depth noise.** A 40 mm baseline with 240 px of focal length resolves `Z² / (40 * 240)` mm per pixel of disparity: 4 mm at 200 mm, 9 mm at 300 mm, 17 mm at 400 mm. The matcher works to 1/16 pixel on textured skin, so expect roughly 5-10 mm of depth noise at 30 cm and more at the silhouette, where block matching smears the hand a few pixels wider. On the synthetic scene the median error is about 1 % and the 90th percentile 2-3 % at 200-400 mm.
- **Range.** The IR LEDs light what is near: a hand at 20-40 cm is bright (65-90 grey levels at 28 cm on the controller measured here), the room is 15-50 and the ceiling black. Four rules throw matches away (*Tuning the stereo* below has the numbers): `--leap-min-intensity` (default 16) drops pixels darker than that, `--leap-max-intensity` (250) drops the pure white of a hand held against the LEDs, `--leap-min-lit` (20) drops a match that is too dark for the depth it claims (`20 * (300 mm / Z)²`: a dark wall placed at 25 cm fails, a dim hand at 45 cm passes), and `--leap-min-texture` (0 = off) is there for rooms whose walls are the only flat thing. The box's `--far` does the rest.
- **Rate.** The controller delivers up to ~100 stereo pairs per second; 3-way SGBM on 480x360 takes 13-17 ms on the development desktop (five-direction SGBM on the old 320x240 view took the same 14 ms, on 480x360 42-44 ms), so the bridge takes the newest pair each time it is ready and paces itself to `--fps` (default 30). Cost is proportional to `width * height * disparities`, and the disparity range to `f / near`: `--near 0.15` is a fifth cheaper than the default 0.1.

### Orienting the box

A depth camera on a tripod looks at the performer; the controller looks up from the desk. The depth image the bridge produces is therefore a view from underneath: column `u` runs along the device's long axis (its x axis, the baseline), row `v` along its short axis (device z, toward or away from the performer), and depth is the **height above the device**. `--near 0.1 --far 0.45` mean "between 10 and 45 cm up", `w = 0` is the low plane, and pushing "into the box" means lowering the hand. The browser starts from `DEPTH_MAPPING` (image x mirrored, image y flipped, w = z) like any depth source; do the two-corner calibration, then, with a hand over the device, check which way things move:

- Left/right or forward/back reversed: toggle the corresponding axis `mirror` in the overlay, or recapture the calibration corners.
- Left/right and forward/back exchanged (the device sits turned 90°): use `--leap-orient rot90` (or `rot270`, `rot180`, `flip-h`, `flip-v`, `transpose`) so the bridge rotates the depth image before analysis. Do this in the bridge rather than with an axis swap in the browser: the surface scan is a height field over the image plane and the browser drops it for swapped mappings.
- Pushed should be raising the hand instead: capture the calibration's *withdrawn* and *pushed* depths the other way round (the same trick `LEAP_MAPPING` uses for the skeleton source).

| Flag | Meaning |
| --- | --- |
| `--leapc PATH` | LeapC library. Default: the Ultraleap SDK, then Leap Motion Core Services, then `$LEAPC_DLL`. |
| `--leap-view W H` | Rectified view = depth image size (default 480x360). |
| `--leap-fov DEG` | Horizontal field of view of that view (default 90). Wider sees more of the desk at lower angular resolution; the lenses cover about 138° x 115°. |
| `--leap-min-intensity N` | Ignore IR pixels darker than N (default 16). |
| `--leap-max-intensity N` | Ignore IR pixels at or above N, the saturated white of a hand against the LEDs (default 250; 255 = off). |
| `--leap-min-lit N` | Ignore a match whose 5x5 neighbourhood is darker than `N * (300 mm / depth)²` (default 20; 0 = off). |
| `--leap-min-texture N` | Ignore pixels whose 7x7 neighbourhood spans fewer than N grey levels (default 0 = off; hollows a hand before it clears phantoms). |
| `--leap-uniqueness N` | Percent margin the best disparity must win by (default 15). |
| `--leap-block N` / `--leap-mode M` / `--leap-matcher M` | Block size (5), SGBM path aggregation (`3way`, `sgbm`, `hh`) and matcher (`sgbm`, `bm`). |
| `--leap-align MODE` | Right-camera alignment: `auto` (default, fitted from feature matches in the first frames), `none`, or `PITCH,ROLL[,YAW]` degrees. |
| `--leap-calibration M` | Rectify with `LeapRectilinearToPixel` (`function`, default) or the images' 64x64 distortion lattice (`lattice`). |
| `--swap-cameras` | Exchange the cameras before matching (the skeleton's reference camera follows). |
| `--leap-orient MODE` | Rotate or flip the depth image before analysis (default `none`); the skeleton is reoriented with it. |
| `--leap-hand-frame MODE` | How the hand skeleton maps onto the depth image: `auto` (default, detected against the scan) or a convention name `u±x_v±z_ref±` / `u±z_v±x_ref±`. |

### Tuning the stereo: what the real frames showed

The first frames from a real controller (Hyperion 6.2.0, `leap_source.py --dump-images`, kept in `test-results/leap/`) showed an open hand 27 cm up as one blob with the fingers merged, and patches of near depth in dark parts of the room. `bridge/stereo_lab.py` re-rectifies and re-matches such dumps offline under any number of configurations, times them, scores the hand (valid depth on it, phantom depth around it, whether spread fingers stay apart) and writes a labelled contact sheet (`test-results/leap/stereo_lab.png`); `--verify` checks the calibration grids against the bridge's own rectified views and `--list` names the configurations. What it found, and what the defaults now are:

- **The distortion lattice.** `LEAP_IMAGE.distortion_matrix` is a 64x64 grid of `(x, y)` raw-image coordinates normalized to 0..1 of the width and height; entry `[j, i]` is the pixel hit by the ray with slopes `tx = -4 + 8 i / 63` and `ty = 4 - 8 j / 63`, i.e. the columns run with `+tx` (image right) and the rows are stored bottom-up (`+ty`, image down, is row 0: the original SDK's OpenGL-texture convention). The images' `x/y_scale = 0.125` and `x/y_offset = 0.5` say the same thing (`index = slope * scale + offset`). Rectifying the raw pair through it (`leap_stereo.GridCalibration`, pixel = `x * width - 0.5`) reproduces the bridge's `LeapRectilinearToPixel` views to a quarter pixel in the centre of the sensor, but the two disagree by up to 5 px at the sensor's edges and by 3 raw rows between the cameras (the function is what the service's own calibration says; the lattice looks like an older fit). `--dump-images` therefore also saves `leap_r2p_{left,right}.npy`, the function sampled on the same 64x64 grid, and the lab rectifies exactly like the bridge did.
- **The raw resolution is lowest where the hand is.** From the calibration itself: the controller's lenses put only **2.4 px/deg horizontally and 1.2 rows/deg vertically at the centre of the field**, rising to 4-6 px/deg at 45° off-axis and 8-10 beyond 60° (a wide-angle lens with mild barrel distortion, not the equidistant fisheye the 640-over-138° average of 4.6 px/deg suggests). A hand 25-30 cm above the device sits within ±25° of the axis, where a 15 mm finger is 7 raw px wide and 3.5 raw rows tall, and the gaps between spread fingers 5-6 px by 2.5 rows. So the old 320x240/90° view (2.8 px/deg) was already oversampling it, not throwing resolution away; the 240 raw rows, not the 640 columns, are the limit, and no view size adds information about a hand. What a larger view does is make the matcher's blocks and smoothing finer in angle: 5x5 blocks span 1.8° at f = 160 and 1.2° at f = 240, which is what stops them bridging finger gaps.
- **The pair was not row-aligned.** Feature matches between the rectified eyes sit 1-2 rows apart at f = 160 (2-3 at f = 240), and the offset grows with the column: the right camera's calibration frame is pitched about 0.3-0.4° and rolled about 0.2-0.5° with respect to the left's (the numbers vary with the frames used; the rectified pair from the lattice was off by 6 rows). Block matching a pair misaligned by two rows is most of why the hand was a blob. `leap_stereo.CameraAlignment` rotates the right camera's rays before its calibration is looked up; `--leap-align auto` collects SIFT matches from every third frame until at least 150 from 5 frames are in, fits pitch and roll (yaw shifts disparity by `f * yaw` and cannot be told from depth without a known distance, so it stays 0), logs the fit and rebuilds the maps; a hand or anything textured 20-40 cm up gives enough matches within a second, an empty room does not (it says so and keeps going). `--leap-align 0.35,-0.4` fixes it once you know your unit's numbers, `none` turns it off. Only the right camera is rotated, so the reference view and the skeleton projection are untouched (with `--swap-cameras` the reference is the aligned camera, a fraction of a degree off the device frame, well inside the hand-frame detector's 30 mm).
- **Phantoms are dark, not featureless.** In the frames, phantom near depth had grey levels of 15-50 (p99 52) at claimed depths of 250-450 mm; the hand core was 64-90. Skin at 2-3 px/deg is as smooth as the walls (7x7 range p50 = 9-14 on the hand, 8-11 on phantoms), so every texture threshold that removed phantoms hollowed the hand first (`t8` at 480x360: hand valid 70 % -> 39 %). Brightness does separate them, and the LEDs' inverse-square falloff makes it depth-aware: `--leap-min-lit 20` rejects a match darker than `20 * (300 mm / Z)²` in its 5x5 neighbourhood, which a wall placed at 25 cm fails and a hand at 45 cm (the same grey, at a depth that explains it) passes; it costs nothing on the measured hand at 27 cm or on its simulated 43 cm counterpart, where 32 would already cost half. `--leap-max-intensity 250` removes the saturated white of a hand held against the LEDs (frame 000 of the dump: no texture, so the matcher placed it anywhere). The uniqueness margin went from 10 to 15 %. Together with the alignment these took the 27 cm hand from 7.6 % of the image as phantom and 40 % of the space between the fingers filled to 2.4-3.7 % and 20-26 %.
- **The lab's table** (this desktop, `--repeat 5`, frame 001 = the open hand at 27 cm; "gap" = the fraction of the space between the fingers that reads as near depth, lower is better; fingers = runs of near depth across the finger row vs runs of lit skin):

  | config | matcher ms | hand valid % | phantom % | gap % | fingers |
  | --- | --- | --- | --- | --- | --- |
  | old (320x240, sgbm, no rules, no alignment) | 14 | 80 | 7.6 | 40 | 7/9 blob |
  | old + alignment | 15 | 84 | 5.1 | 34 | blob |
  | 320x240, 3way, rules | 5 | 82 | 3.7 | 26 | 8/9 |
  | **480x360, 3way, rules (default)** | 14 | 70 | 2.4 | 20 | 7/11 |
  | 480x360, sgbm | 42 | 71 | 2.6 | 22 | 7/11 |
  | 480x360, hh | 117 | 69 | 1.6 | 14 | 11/11 |
  | 640x480, 3way | 33 | 60 | 1.2 | 16 | 6/12 |
  | 640x480, sgbm | 89 | 60 | 1.1 | 12 | 6/12 |
  | 480x360, bm 9x9 | 7 | 15 | 0.0 | 1 | sparse |
  | 480x360, texture 8 | 13 | 39 | 1.4 | 17 | hollow |

  Block size 3 or 7 and the median filter change little; `hh` resolves the fingers best but costs 8x; `bm` is fast and nearly empty on skin. 480x360 with the 3-way pass costs what 320x240 five-direction SGBM did and halves the gap fill; 640x480 halves it again for 2.5x the time, over the ~20 ms budget of a 2020 Intel MacBook. The fused skeleton (*Fusing the skeleton into the scan*) fills the finger gaps the matcher still bridges.
- **What the controller cannot do.** At 25-30 cm it resolves a spread hand's fingers horizontally (7 raw px per finger, 5 per gap) but barely vertically (3.5 rows per finger, 2.5 per gap): fingers pointing along the device's long axis stay apart in the scan, fingers pointing across it merge; fingertips are within a row or two of the noise. Depth noise is 5-10 mm at 30 cm, 15-20 mm at 45 cm, and the block matcher widens every silhouette by 2-3 view pixels. Anything within ~20 cm of the LEDs saturates and returns no depth at all (the skeleton model fills it). Dark clothing at 30 cm can read as too dark for its depth and be dropped; raise `--leap-min-lit` in a dark room, lower it (or 0) for dark skin or sleeves.

```sh
python bridge/leap_source.py --dump-images 3 --out test-results/leap     # raw + rectified pairs, depth, lattice and function grids
python bridge/stereo_lab.py --input test-results/leap --verify           # the lattice convention against the dumped views
python bridge/stereo_lab.py --input test-results/leap --configs old 480x360 640x480-3way --repeat 10
```

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
  "stats": { "pixels": 3376, "blobs": 1, "trackedHands": 0, "fusedHands": 0, "scanModelFraction": 0, "fps": 29.8, "processingMs": 6.1, "frameWidth": 640, "frameHeight": 480 } }
```

- `id` is stable while the same blob stays in view: blobs are matched to the previous frame by nearest centroid within `--max-jump` (normalized units) and survive a few missed frames. Ids never repeat in a run.
- `pos` is the centroid in `u`/`v` and the blob's **nearest tenth** in `w` (10th percentile of its depths), so a hand reaching in reads as pushed even though the arm behind it is deeper in the box.
- `extent` is the blob's bounding box; its `w` range uses the 10th/90th percentiles so one stray pixel cannot stretch it.
- `conf` rises from `--min-pixels` and saturates at four times that count.
- `points` are up to `--points` (default 16) evenly sampled pixels of the blob surface.
- `occupancy` is the fraction of in-range pixels per cell, `--occupancy W H` (default 32x24), omitted with `--no-occupancy`.
- `voxels` is the foreground in 3D and `surface` its scanned front face; both are described below.
- `t` is `time.perf_counter()` seconds; the browser estimates the offset itself.

A source that tracks hands (`hello.skeleton: true`) replaces the blob hands with the tracked ones whenever it has any (see *Hand tracking and depth in one stream* for the rules) and attaches a `skeleton` to each. All coordinates are normalized like `pos` (`u` right, `v` down, `w` deep); joints are not clamped; widths are diameters as fractions of the ROI width at that part's depth; `fingers` always has exactly five entries (thumb to pinky) with exactly five joints each (carp, mcp, pip, dip, tip); `elbow`, `palmWidth` and `armWidth` are optional; everything is rounded to four decimals:

```jsonc
{ "id": 1, "pos": [0.5, 0.5, 0.25], "conf": 1, "extent": [[0.4735, 0.437, 0.25], [0.5268, 0.5665, 0.294]],
  "openness": 1, "pinch": 0, "points": [[0.5, 0.5, 0.25], ...five fingertips...],
  "skeleton": { "type": "right", "palm": [0.5, 0.5, 0.25], "wrist": [0.5, 0.5385, 0.2652], "elbow": [0.5, 0.5665, 0.294],
                "palmWidth": 0.075, "armWidth": 0.045,
                "fingers": [{ "joints": [[0.4952, 0.4965, 0.2507], [0.4889, 0.4917, 0.2533], [0.483, 0.4874, 0.2573], [0.478, 0.4836, 0.2628], [0.4735, 0.4803, 0.2673]],
                              "width": 0.014, "extended": true }, ...four more... ] } }
```

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

`--surface W H` (default 64x48, or 160x120 for the Leap sources whose 480x360 depth image has finger-level detail to carry; each side 1..512; `--no-surface` to drop it). This is the depth map of whatever is inside the box, downsampled: for each cell of a `W x H` grid over the ROI, the NEAREST in-range depth among its pixels, or 0 if none of its pixels is in range.

**Layout on the wire:** `W*H` bytes, row-major, row 0 = top of the ROI. A byte is `0` for an empty cell, otherwise `1 + round(254 * w)` with `w` the cell's nearest foreground depth normalized into the box (`1` = the near plane, `255` = the far plane). A scanned point can therefore never be mistaken for "nothing here", and the browser inverts it with `surfaceByteToDepth` (`(byte - 1) / 254`, or null for 0).

The minimum is taken per cell, not the mean, so a fingertip that covers a few pixels of a cell still sets that cell's depth; noise is handled by the morphological opening of the mask, not by averaging. The surface is a height field over the camera's image plane, which is what a "scan" is: the front face of the foreground, background removed.

### Cost

Both fields are pure numpy. Voxelisation is one scan of the mask plus a few gathers per foreground pixel into a `bincount` (the vectorised form of `np.add.at`) over lookup tables cached per frame size; the surface scan is two `minimum.reduceat` block reductions over the masked depth, a fixed cost per frame. On the development machine with a 640x480 frame: voxels at 32x24x16 take ~0.3 ms for a hand (6 500 foreground pixels) and ~7 ms for a whole body (160 000 pixels); the surface at 64x48 takes ~2 ms whatever is in the box. For scale, the 32x24 occupancy grid's integral image costs ~8 ms on the same machine, and the whole `analyze` pass ~14 ms with every field on.

On the wire the defaults add 12 288 bytes of voxels and 3 072 bytes of surface per frame (16 KB and 4 KB as base64), about 0.6 MB/s at 30 fps over the local socket. Shrink `--voxels` before shrinking `--surface`: the surface is the cheaper and more precise description of a hand, the voxels are what fills a volume.

### In the browser

`bridgeFrameToInput` decodes both with the sizes announced in `hello` (`decodeVoxels`, `decodeSurface`) into `InputFrame.voxels` (`VoxelGrid`, source frame, z index 0 = nearest the camera) and `InputFrame.surface` (`DepthSurface`). The tracker then maps them into sim space every frame:

- `mapVoxels` resamples the grid through all three axis maps (mirror, flip, calibration interval) into `input.volume`, a `VolumeField` of `volumeNx x volumeNy x volumeNz` cells (tracker settings, default 48x32x24) with x fastest, then y, then z from the glass. A cell of the sim volume takes the value of the source voxel its centre falls in, so the browser resolution can be higher than the bridge's without inventing detail.
- `mapSurface` resamples the scan through the x/y maps into `input.surface`, a `SurfaceField` of `surfaceWidth x surfaceHeight` cells (default 192x144): per cell a sim-space depth `z` (0 = glass, 1 = back wall, via the z axis map) and a `mask` byte that is 255 where something was scanned. It survives mirroring and calibration intervals but not an axis swap (the surface is a height field over the image plane); with a swapped mapping `input.surface` is null.

Simulations treat `input.volume` and `input.surface` as optional: a skeleton source (Leap) sends capsules instead, and the fallback is always the sphere at `position` with `radius`. Both fields go stale and drop to null when frames stop arriving, like the hands.

## Fusing the skeleton into the scan

**Why.** The controller's stereo pair is 640x240 behind lenses that cover 132°, about 2 px per degree vertically. A finger 25 cm up is 8-10 px wide in the raw image and the block matcher smears it into its neighbours; a hand closer than about 20 cm saturates the IR image (no texture, so no match, so no depth); the dark ceiling behind an open hand produces phantom near matches between the fingers. The scan of a hand is therefore a blob with the fingers missing or merged, exactly the frames in `test-results/leap/` show. The tracking service's hand model, which is what the bridge already receives as the skeleton, knows where every finger is even when the matcher cannot see it. So, when a frame carries tracked hands, the bridge renders their solid into the depth image *before* anything is measured from it, and the scan, the voxels, the occupancy grid, the blobs and `stats.pixels` all see the fused depth. They agree with each other and with the skeleton, which is what "hand tracking and depth in one stream" needs.

**The model** (`bridge/scan_fusion.py`). Per hand, the same capsules the browser builds from a skeleton (`src/sim/input/skeleton.ts`): the four bones of each finger, carp→mcp, mcp→pip, pip→dip, dip→tip, with radius `width/2` times 1.15, 1, 0.9, 0.8 (zero-length bones skipped, as the Leap reports the thumb metacarpal), and the forearm wrist→elbow at `0.85 × armWidth/2`; plus a palm the browser leaves to the metacarpals: three flattened capsules, index-mcp→wrist, pinky-mcp→wrist and index-mcp→pinky-mcp, `0.25 × palmWidth` wide but only `0.15 × palmWidth` thick, so the palm is filled as a slab rather than a ball. Twenty-four capsules per hand, in the image frame of the depth pixels (column, row, millimetres; the widths a source reports are already pixels at each part's depth), so they land exactly where the projected skeleton lands, and the Leap's `--leap-hand-frame` convention matters for them as much as for the skeleton. Each capsule is rasterised as a rounded tube: a pixel at distance `d < r` from the projected bone reads the bone's depth there minus `sqrt(r² − d²)` pixels converted to millimetres at that depth (`depth / f` with the source's focal length, `f = 160 px` for the default Leap view; a source without one, such as the synthetic performer, scales the relief as if the box were isotropic). It is `surfaceFromCapsules` from the browser's synthetic source, in millimetres, and the nearest capsule wins at every pixel, so what the model contributes is the front face the camera would see: a finger joint sits on the bone's axis and its skin is a finger radius nearer.

**Modes** (`--scan-fuse`, default `fill`):

| Mode | Under the model | Outside the model |
| --- | --- | --- |
| `fill` | A measurement that exists and agrees with the model within `--fuse-tolerance` is kept; where the measurement is missing (no match) or disagrees by more (the backdrop seen through a hand, a phantom near match), the model replaces it. | The measurement, untouched: the arm past the elbow stub, objects, anything the tracker does not model. |
| `model` | The model, always. | The measurement. |
| `off` | The measurement. | The measurement (a plain depth camera; the skeleton is still reported). |

Model pixels outside `--near`/`--far` are dropped like any other pixel, so a hand held outside the box adds nothing, and only hands that are reported (palm within the margin of the box) are rendered. `fill` is the default because it keeps the real relief of the hand where the stereo did see it and adds the model only where it did not, so a measured palm stays a measured palm and the phantom-free fingers come from the skeleton; `model` is for a device whose depth is too poor to trust at all under the hand, and gives a hand of perfectly smooth tubes.

**Tolerance** (`--fuse-tolerance MM`, default 40). Two things add up under it: the matcher's noise, 5-15 mm at 30 cm and more at the silhouette (*What to expect*), and the gap between a tube model and a real hand, since the palm point Ultraleap reports is inside the hand, 10-15 mm behind the skin. 40 mm covers both, so a good measurement is never thrown away for the model, while the backdrop (hundreds of millimetres behind), a phantom near match (tens of millimetres in front) or a stretched silhouette are. Lower it (20-30) to let the model win small arguments, which smooths the hand toward the tubes; raise it (100) to keep the measurement wherever the stereo produced anything at all.

**Stats.** Every frame reports `stats.fusedHands`, how many hands were rendered into the depth (0 when the frame had no tracked hands or `--scan-fuse off`), and `stats.scanModelFraction`, the fraction of the frame's foreground pixels (after the morphological opening, so exactly the pixels behind `stats.pixels`) whose depth came from the model. It is the single number that says how much of the scan you are looking at is skeleton rather than measurement. Under `fill` it is the size of the holes the matcher left: a few percent for a well-lit hand at 25 cm, most of the hand when it saturates the image close to the device, 0 when tracking is lost. Under `model` it is the model's share of the foreground, typically 0.6-0.8 (the hand, not the arm).

**Telling model from measurement.** Besides the fraction: run the same scene with `--scan-fuse off` and compare `stats.pixels` and the surface (the difference is the model); `leap_source.py --dump-images` writes the raw measurement as PNGs, no fusion involved; and in the browser overlay model pixels are unmistakable, perfectly smooth rounded tubes at exactly the skeleton's joints, where the measurement is a noisy scanned surface. `--fuse-tolerance 0` is the other extreme for a check: every model pixel then replaces the measurement unless they agree to the millimetre.

**On the synthetic sources.** `--source synthetic` renders a dome whose skeleton lies on it, so under `fill` the dome is kept (it agrees with the model within tolerance) and the model only adds what pokes past the rim, the forearm stub and the fingertips: `scanModelFraction` ≈ 0.06. Blank the depth above the palm, as IR saturation does, and the fingers come back from the model as five separate tubes with the gaps between them (the tests do exactly that). `--source leap-synthetic` runs the fist and forearm through the real matcher, which leaves holes under a tenth to a quarter of the hand's area that the model fills: `scanModelFraction` ≈ 0.1-0.25 under `fill`, ≈ 0.8-0.9 under `model`.

**Cost.** Rendering is pure numpy: capsules of similar footprint are computed as one batch over their bounding boxes and scattered into the canvas with a per-capsule minimum, so two hands (48 capsules) take ≈ 1 ms at 320x240 or 640x240 and ≈ 2 ms at 640x480 on the development machine; the fusion itself, restricted to the model's bounding box, 0.1-0.8 ms. The whole `analyze` pass grows by about 1.7 ms at the Leap's size.

| Flag | Meaning |
| --- | --- |
| `--scan-fuse MODE` | `fill` (default), `model` or `off`, as above. |
| `--fuse-tolerance MM` | Under `fill`, how far a measurement may differ from the model and still be kept (default 40). |

## Fixtures and tests

```sh
python bridge/test_bridge.py                     # or: python -m bridge.test_bridge
python bridge/depth_bridge.py --source synthetic --dump 5 --occupancy 8 6 --voxels 8 6 4 --surface 8 6 > bridge/fixtures/sample_messages.jsonl
npx vitest run tests/sim/bridge-fixture.test.ts  # the fixture through the browser's zod schema
```

`--dump N` prints the `hello` and N frames as JSON lines to stdout instead of serving. The fixture uses small grids (8x6 cells, 4 slabs) to stay readable; with a 640x480 frame every cell is exactly 80x80 pixels, which the layout tests rely on. Its hands are tracked ones with a `skeleton` (the synthetic source's dome skeleton), so the fixture covers the skeleton schema as well; `pos` is the palm, which sits at the dome's centre and nearest depth, exactly where the blob's centroid used to be. It is generated with the default fusion, so its frames carry `fusedHands: 1` and a small `scanModelFraction` (the forearm stub and fingertips the model adds past the dome's rim). `test_bridge.py` also checks the rasteriser against a brute-force reference (tube width and relief, nearest capsule first, clipping at the image edge, the browser's bone factors), the fusion rules pixel by pixel (agreeing, missing, disagreeing, outside the model, the tolerance, near/far), the stats, the flags through `--dump`, that `--scan-fuse off` is the old behaviour, and that both synthetic sources are fused. The Python tests check the shapes by hand and pin the layouts (byte 0 is the top-left cell at the near plane, the last byte the bottom-right cell at the far plane, an empty surface cell is 0 and the near plane is 1); the vitest passes the checked-in fixture through `parseBridgeMessage`, decodes all three fields with `decodeOccupancy`/`decodeVoxels`/`decodeSurface`, and checks that the synthetic hand's voxels peak and its scan is nearest at its centroid and depth. A drift on either side fails a test.

`python bridge/test_leap_stereo.py` also covers the hand-tracking half without hardware: the LeapC tracking struct layouts (`#pragma pack(1)`: `LEAP_HAND` is 1084 bytes, the event 48), a ctypes tracking event copied into hands, the device-to-image projection round-tripping through the rectified view under every convention and orientation, the synthetic skeleton landing on the scan, and auto mode locking on the true convention.

## Adding a camera

Subclass `FrameSource` in `depth_bridge.py`, return `DepthFrame(uint16 millimetres, time.perf_counter())` from `read()` (row 0 = top, column 0 = left), open and close the device in `start()`/`stop()`, and add the class to the `SOURCES` dict so it becomes a `--source` choice. `read()` runs in a worker thread and may block; raise on hardware errors and the server will report and restart. `AzureKinectSource` is a documented stub showing the `pyk4a` and OpenNI2 calls; `leap_source.py` is a complete example of a source in its own module (listed in `LEAP_SOURCES` and imported on demand) that builds depth from a stereo pair.

A source that also tracks hands sets `skeleton = True` and passes a tuple of `TrackedHand` records as the frame's third field: 28 joints in the image's own frame (pixel column, row and millimetres; the layout constants `JOINT_PALM`, `finger_joint(f, j)`, ... in `depth_bridge.py`), seven widths in pixels at each part's depth, and the per-finger extended flags. The analyzer normalizes them with the box; nothing else changes.

The analyzer only ever sees millimetres and a frame size, so no other code changes.
